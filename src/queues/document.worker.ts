import { Worker, Job } from 'bullmq';
import { redisConnection } from './connection';
import { prisma } from '../lib/prisma';
import { errorToLogObject, logger } from '../lib/logger';
import { appEvents } from '../lib/events';
import {
  extractText,
  detectFormat,
  type SupportedFormat,
} from '../lib/documentExtractor';
import { chunkDocument } from '../lib/chunker';
import {
  generateEmbeddingsBatchCached,
  storeChunkEmbeddingsBatch,
} from '../Services/embedding.service';
import {
  activeQueueJobs,
  chunksPerDocument,
  documentsProcessed,
  embeddingCacheHitRate,
  ingestionDuration,
} from '../lib/metrics';

const worker = new Worker(
  'document-processing',
  async (job: Job) => {
    const { documentId, userId, correlationId } = job.data;
    const startTime = Date.now();
    const logCorrelationId = correlationId ?? job.id;
    const queueName = 'document-processing';
    let format: SupportedFormat | undefined;
    let chunkCount = 0;

    activeQueueJobs.inc({ queue: queueName });
    logger.info('Document processing started', {
      correlationId: logCorrelationId,
      documentId,
      userId,
      attempt: job.attemptsMade + 1,
    });

    try {
      const doc = await prisma.document.findUniqueOrThrow({
        where: { id: documentId },
      });
      await prisma.document.update({
        where: { id: documentId },
        data: { status: 'processing', error: null },
      });
      await job.updateProgress(5);

      const documentFormat = detectFormat(doc.filename);
      format = documentFormat;
      const { text, pageCount } = await extractText(doc.content, documentFormat);
      if (!text.trim()) {
        throw new Error('No extractable text found in document');
      }
      await job.updateProgress(15);

      logger.info('Document text extracted', {
        correlationId: logCorrelationId,
        documentId,
        format,
        textLength: text.length,
        pageCount,
      });

      const chunks = chunkDocument(text, {
        maxTokens: 500,
        overlapTokens: 50,
        minChunkTokens: 1,
      });
      if (chunks.length === 0) {
        throw new Error('Document produced no processable chunks');
      }
      chunkCount = chunks.length;
      await job.updateProgress(30);

      logger.info('Document chunked', {
        correlationId: logCorrelationId,
        documentId,
        chunkCount: chunks.length,
        avgTokens: Math.round(
          chunks.reduce((sum, chunk) => sum + chunk.tokenEstimate, 0) /
            chunks.length,
        ),
      });

      await prisma.$transaction(async (tx) => {
        await tx.chunk.deleteMany({ where: { documentId } });
        await tx.chunk.createMany({
          data: chunks.map(chunk => ({
            documentId,
            index: chunk.index,
            content: chunk.text,
            tokenCount: chunk.tokenEstimate,
          })),
        });
      });
      await job.updateProgress(50);

      const embeddingResult = await generateEmbeddingsBatchCached(
        chunks.map(chunk => chunk.text),
      );
      const { embeddings } = embeddingResult;
      if (embeddings.length !== chunks.length) {
        throw new Error(
          `Expected ${chunks.length} embeddings, received ${embeddings.length}`,
        );
      }
      await job.updateProgress(85);

      const storedChunks = await prisma.chunk.findMany({
        where: { documentId },
        orderBy: { index: 'asc' },
        select: { id: true },
      });
      if (storedChunks.length !== embeddings.length) {
        throw new Error(
          `Expected ${embeddings.length} stored chunks, found ${storedChunks.length}`,
        );
      }

      await storeChunkEmbeddingsBatch(
        storedChunks.map((chunk, index) => ({
          id: chunk.id,
          embedding: embeddings[index],
        })),
      );
      await job.updateProgress(95);

      embeddingCacheHitRate.set(
        embeddingResult.cacheHits / chunks.length * 100,
      );
      await prisma.document.update({
        where: { id: documentId },
        data: {
          status: 'ready',
          chunkCount: chunks.length,
        },
      });
      await job.updateProgress(100);

      const durationMs = Date.now() - startTime;
      documentsProcessed.inc({ status: 'success' });
      ingestionDuration.observe(
        { format: documentFormat },
        (Date.now() - startTime) / 1000,
      );
      chunksPerDocument.observe(chunks.length);

      appEvents.emit('doc:processed', {
        documentId,
        userId,
        correlationId: logCorrelationId,
        chunkCount: chunks.length,
        durationMs,
        format,
        pageCount,
      });

      logger.info('Document processing complete', {
        correlationId: logCorrelationId,
        documentId,
        chunkCount: chunks.length,
        durationMs,
      });

      return { success: true, chunks: chunks.length, durationMs };
    } catch (error) {
      if (job.attemptsMade >= (job.opts.attempts ?? 3) - 1) {
        const durationSeconds = (Date.now() - startTime) / 1000;
        documentsProcessed.inc({ status: 'failed' });
        ingestionDuration.observe({ format: format ?? 'unknown' }, durationSeconds);
        if (chunkCount > 0) {
          chunksPerDocument.observe(chunkCount);
        }

        try {
          await prisma.document.update({
            where: { id: documentId },
            data: {
              status: 'failed',
              error: error instanceof Error ? error.message : String(error),
            },
          });
        } catch (updateError) {
          logger.error('Failed to mark document processing as failed', {
            correlationId: logCorrelationId,
            documentId,
            error: errorToLogObject(updateError),
          });
        }
      }

      logger.error('Document processing failed', {
        correlationId: logCorrelationId,
        documentId,
        error: errorToLogObject(error),
        attempt: job.attemptsMade + 1,
      });
      throw error;
    } finally {
      activeQueueJobs.dec({ queue: queueName });
    }
  },
  {
    connection: redisConnection,
    concurrency: 3,
  }
);

// Event listeners for logging
worker.on('completed', (job) => {
  logger.info('Document processing job completed', {
    jobId: job.id,
    chunks: job.returnvalue?.chunks,
  });
});

worker.on('failed', (job, error) => {
  logger.error('Document processing job failed', {
    jobId: job?.id,
    attempt: job?.attemptsMade,
    error: errorToLogObject(error),
  });
});

worker.on('error', (error) => {
  logger.error('Document worker error', { error: errorToLogObject(error) });
});

export { worker };

import { deadLetterQueue } from './dead-letter.queue';

worker.on('failed', async (job, error) => {
  if (!job) return;

  // Check if all attempts exhausted
  if (job.attemptsMade >= (job.opts.attempts ?? 3)) {
    logger.error('Document processing job permanently failed; moving to DLQ', {
      jobId: job.id,
    });

    await deadLetterQueue.add('failed-document', {
      originalJobId: job.id,
      originalQueue: 'document-processing',
      data: job.data,
      error: error.message,
      failedAt: new Date().toISOString(),
      attempts: job.attemptsMade,
    });
  }
});
