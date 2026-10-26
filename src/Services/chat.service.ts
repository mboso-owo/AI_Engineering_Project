import { computeConfidence } from './confidence.service';
import { reviewQueueService } from './review-queue.service';
import { conversationMemory } from './conversation-memory.service';
import { memoryService } from './memory.service';
import { memoryExtractor } from './memory-extractor.service';


async function askQuestion(
  documentId: string,
  question: string,
  userId: string,
  conversationId?: string
) {
  // 1. Embed the question (unchanged)
  const questionEmbedding = await embedText(question);

  // 2. Retrieve top-5 chunks from pgvector (unchanged)
  const chunks = await retrieveChunks(documentId, questionEmbedding, 5);

  // 3. NEW: Compute confidence before calling the LLM
  const confidence = computeConfidence(chunks, config.hitl.confidenceThreshold);

  // 4. Call the LLM regardless — we need the answer
  //    even if it goes to review (reviewers need to see it)
  const answer = await generateAnswer(question, chunks);

  // 5. Store the message
  const message = await messageRepository.create({
    conversationId,
    documentId,
    role: 'assistant',
    content: answer.text,
    sources: answer.sources,
    confidence: confidence.score,
    promptTokens: answer.usage.promptTokens,
    completionTokens: answer.usage.completionTokens,
    costUsd: answer.usage.costUsd,
  });

  // 6. NEW: Route based on confidence
  if (confidence.shouldEscalate && config.hitl.escalationEnabled) {
    await reviewQueueService.enqueue({
      messageId: message.id,
      documentId,
      question,
      generatedAnswer: answer.text,
      confidence: confidence.score,
      sources: answer.sources,
      reason: confidence.reason,
    });

    return {
      messageId: message.id,
      status: 'under_review',
      message: 'This answer is being reviewed for accuracy. ' +
               'You will be notified when the review is complete.',
      confidence: confidence.score,
      conversationId,
    };
  }

  // 7. High confidence — return directly
  return {
    messageId: message.id,
    question,
    answer: answer.text,
    sources: answer.sources,
    confidence: confidence.score,
    usage: answer.usage,
    conversationId,
  };
}
async function askQuestion(options: {
  question: string;
  documentId: string;
  userId: string;
  conversationId?: string;
}) {
  const { question, documentId, userId } = options;
  const conversationId = options.conversationId || generateId();

  // === STEP 1: Load conversation context ===
  const conversationCtx = await conversationMemory.buildContext(
    conversationId
  );

  // === STEP 2: Retrieve long-term memories ===
  const longTermMemories = await memoryService.retrieve(
    userId,
    question,
    5  // top 5 relevant memories
  );

  // === STEP 3: Retrieve document chunks (existing RAG) ===
  const questionEmbedding = await embedText(question);
  const chunks = await retrieveChunks(
    documentId, questionEmbedding, 5
  );

  // === STEP 4: Compute confidence ===
  const confidence = computeConfidence(chunks);

  // === STEP 5: Assemble the prompt ===
  const prompt = assemblePromptWithMemory({
    question,
    chunks,
    conversationContext: conversationCtx,
    longTermMemories,
  });

  // === STEP 6: Call the LLM ===
  const answer = await callLlm({
    messages: prompt,
    model: 'gpt-4o-mini',
  });

  // === STEP 7: Store the message ===
  const message = await messageRepository.create({
    conversationId,
    documentId,
    role: 'assistant',
    content: answer.content,
    sources: chunks.map(c => c.chunkId),
    confidence: confidence.score,
    promptTokens: answer.usage.promptTokens,
    completionTokens: answer.usage.completionTokens,
    costUsd: answer.usage.costUsd,
  });

  // === STEP 8: Extract new memories (async, non-blocking) ===
  memoryExtractor
    .extractFromInteraction(userId, question, answer.content)
    .catch(err => logger.error({
      event: 'memory:extraction_failed', err: err.message
    }));

  // ... confidence routing, HITL check (from Day 1) ...

  return { messageId: message.id, answer: answer.content, ... };
}
