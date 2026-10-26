import { prisma } from '../lib/prisma';
import { embedText } from '../services/embedding.service';
import { logger } from '../lib/logger';

export const memoryService = {
  async store(data: {
    userId: string;
    type: MemoryType;
    content: string;
    source?: string;
    importance?: number;
    ttlDays?: number;
  }) {
    // Generate embedding for semantic retrieval
    const embedding = await embedText(data.content);

    // Check for duplicate or near-duplicate memories
    const existing = await this.findSimilar(
      data.userId,
      embedding,
      0.95  // very high threshold = near-duplicate
    );

    if (existing.length > 0) {
      // Update the existing memory instead of creating a duplicate
      return prisma.memory.update({
        where: { id: existing[0].id },
        data: {
          content: data.content,
          importance: Math.max(
            existing[0].importance,
            data.importance || 0.5
          ),
          updatedAt: new Date(),
        },
      });
    }

    const expiresAt = data.ttlDays
      ? new Date(Date.now() + data.ttlDays * 86400000)
      : null;

    // Store with vector embedding via raw SQL
    // (Prisma does not natively support pgvector inserts)
    const memory = await prisma.$queryRaw`
      INSERT INTO "Memory" (
        id, "userId", type, content, embedding,
        source, importance, "expiresAt", "createdAt", "updatedAt"
      ) VALUES (
        ${generateId()}, ${data.userId}, ${data.type},
        ${data.content}, ${embedding}::vector,
        ${data.source || null}, ${data.importance || 0.5},
        ${expiresAt}, NOW(), NOW()
      ) RETURNING id, content, type, importance
    `;

    logger.info({
      event: 'memory:stored',
      userId: data.userId,
      type: data.type,
      content: data.content.substring(0, 100),
    });

    return memory;
  },

  async retrieve(userId: string, query: string, limit = 5) {
    const queryEmbedding = await embedText(query);

    // Semantic search across this user's memories
    const memories = await prisma.$queryRaw`
      SELECT id, type, content, importance, "accessCount",
        1 - (embedding <=> ${queryEmbedding}::vector) AS similarity
      FROM "Memory"
      WHERE "userId" = ${userId}
        AND ("expiresAt" IS NULL OR "expiresAt" > NOW())
      ORDER BY
        importance DESC,
        similarity DESC
      LIMIT ${limit}
    `;

    // Update access tracking
    const ids = (memories as any[]).map(m => m.id);
    if (ids.length > 0) {
      await prisma.memory.updateMany({
        where: { id: { in: ids } },
        data: {
          accessCount: { increment: 1 },
          lastAccessedAt: new Date(),
        },
      });
    }

    return memories as Array<{
      id: string;
      type: string;
      content: string;
      importance: number;
      similarity: number;
    }>;
  },

  async findSimilar(userId: string, embedding: number[], threshold: number) {
    return prisma.$queryRaw`
      SELECT id, content, importance,
        1 - (embedding <=> ${embedding}::vector) AS similarity
      FROM "Memory"
      WHERE "userId" = ${userId}
        AND 1 - (embedding <=> ${embedding}::vector) > ${threshold}
      ORDER BY similarity DESC
      LIMIT 3
    `;
  },
};
