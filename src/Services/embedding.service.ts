import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { cacheGet, cacheSet, CACHE_TTL } from '../lib/cache';
import crypto from 'crypto';

const EMBEDDING_MODEL = 'text-embedding-3-small';

interface EmbeddingResponse {
  data: Array<{
    index: number;
    embedding: number[];
  }>;
  usage?: {
    total_tokens: number;
  };
}

async function requestEmbeddings(input: string | string[]): Promise<EmbeddingResponse> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required to generate embeddings');
  }

  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ input, model: EMBEDDING_MODEL }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    throw new Error(
      `OpenAI embedding request failed (${response.status}): ${await response.text()}`,
    );
  }

  return await response.json() as EmbeddingResponse;
}

export async function generateEmbedding(
  text: string
): Promise<number[]> {
  const startTime = Date.now();

  const response = await requestEmbeddings(text);

  const embedding = response.data[0]?.embedding;
  if (!embedding) {
    throw new Error('OpenAI returned no embedding for the input text');
  }
  const duration = Date.now() - startTime;

  logger.info('Embedding generated', {
    model: EMBEDDING_MODEL,
    inputLength: text.length,
    dimensions: embedding.length,
    durationMs: duration,
    tokensUsed: response.usage?.total_tokens,
  });

  return embedding;
}
export async function generateEmbeddings(
  texts: string[]
): Promise<number[][]> {
  if (texts.length === 0) return [];

  // OpenAI supports up to 2048 inputs per request
  const BATCH_SIZE = 100; // Stay well under the limit
  const allEmbeddings: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);

    const response = await requestEmbeddings(batch);

    // Sort by index to maintain order
    const sorted = response.data.sort((a, b) => a.index - b.index);
    if (sorted.length !== batch.length) {
      throw new Error(
        `OpenAI returned ${sorted.length} embeddings for ${batch.length} inputs`,
      );
    }

    for (const item of sorted) {
      allEmbeddings.push(item.embedding);
    }

    logger.info('Embedding batch processed', {
      batchIndex: Math.floor(i / BATCH_SIZE),
      batchSize: batch.length,
      totalTexts: texts.length,
      tokensUsed: response.usage?.total_tokens,
    });
  }

  return allEmbeddings;
}

export async function storeChunkEmbedding(
  chunkId: string,
  embedding: number[]
): Promise<void> {
  const vectorStr = `[${embedding.join(',')}]`;

  await prisma.$executeRaw`
    UPDATE "Chunk"
    SET embedding = ${vectorStr}::vector
    WHERE id = ${chunkId}
  `;
}

export async function storeChunkEmbeddingsBatch(
  chunks: { id: string; embedding: number[] }[]
): Promise<void> {
  // Use a transaction for atomicity
  await prisma.$transaction(
    chunks.map(chunk => {
      const vectorStr = `[${chunk.embedding.join(',')}]`;
      return prisma.$executeRaw`
        UPDATE "Chunk"
        SET embedding = ${vectorStr}::vector
        WHERE id = ${chunk.id}
      `;
    })
  );
}

function contentHash(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export async function generateEmbeddingCached(
  text: string
): Promise<number[]> {
  const hash = contentHash(text);
  const cacheKey = `embed:${hash}`;

  // Check cache
  const cached = await cacheGet<number[]>(cacheKey);
  if (cached) {
    logger.debug('Embedding cache hit', { hash: hash.substring(0, 12) });
    return cached;
  }

  // Cache miss — generate
  const embedding = await generateEmbedding(text);

  // Cache for 7 days (embeddings don't change for the same input)
  await cacheSet(cacheKey, embedding, CACHE_TTL.EMBEDDING);

  logger.debug('Embedding cached', { hash: hash.substring(0, 12) });
  return embedding;
}

export async function generateEmbeddingsBatchCached(
  texts: string[]
): Promise<{
  embeddings: number[][];
  cacheHits: number;
  cacheMisses: number;
}> {
  const results: (number[] | null)[] = new Array(texts.length).fill(null);
  const uncached: { index: number; text: string }[] = [];

  // 1. Check cache for each text
  for (let i = 0; i < texts.length; i++) {
    const hash = contentHash(texts[i]);
    const cached = await cacheGet<number[]>(`embed:${hash}`);
    if (cached) {
      results[i] = cached;
    } else {
      uncached.push({ index: i, text: texts[i] });
    }
  }

  logger.info('Embedding batch cache check', {
    total: texts.length,
    cacheHits: texts.length - uncached.length,
    cacheMisses: uncached.length,
  });

  if (texts.length === 0) {
    return { embeddings: [], cacheHits: 0, cacheMisses: 0 };
  }

  // 2. Generate embeddings only for uncached texts
  if (uncached.length > 0) {
    const newEmbeddings = await generateEmbeddings(
      uncached.map(u => u.text)
    );



    // 3. Cache the new embeddings and fill in results
    for (let i = 0; i < uncached.length; i++) {
      const hash = contentHash(uncached[i].text);
      await cacheSet(`embed:${hash}`, newEmbeddings[i], CACHE_TTL.EMBEDDING);
      results[uncached[i].index] = newEmbeddings[i];
    }
  }

  if (results.some(embedding => embedding === null)) {
    throw new Error('Failed to generate embeddings for all input texts');
  }

  return {
    embeddings: results as number[][],
    cacheHits: texts.length - uncached.length,
    cacheMisses: uncached.length,
  };
}
