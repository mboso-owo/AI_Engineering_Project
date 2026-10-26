import { prisma } from '../lib/prisma';
import { semanticSearch } from './search.service';
import { assembleContext, generateRAGResponse } from './rag.service';

// The generated Prisma client currently omits the Conversation delegate type.
const conversationModel = (prisma as unknown as Record<string, any>).conversation;

interface ConversationListMessage {
  content: string;
  role: string;
  createdAt: Date;
}

interface ConversationListRecord {
  id: string;
  title: string;
  _count: { messages: number };
  messages: ConversationListMessage[];
  updatedAt: Date;
}

interface ConversationListItem {
  id: string;
  title: string;
  messageCount: number;
  lastMessage: ConversationListMessage | null;
  updatedAt: Date;
}

class NotFoundError extends Error {
  readonly statusCode = 404;

  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export async function listConversations(
  userId: string,
  options: { page: number; limit: number },
) {
  const { page, limit } = options;

  const [conversations, total] = await Promise.all([
    conversationModel.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            content: true,
            role: true,
            createdAt: true,
          },
        },
        _count: {
          select: { messages: true },
        },
      },
    }),
    conversationModel.count({ where: { userId } }),
  ]);

  return {
    data: conversations.map((conversation: ConversationListRecord): ConversationListItem => ({
      id: conversation.id,
      title: conversation.title,
      messageCount: conversation._count.messages,
      lastMessage: conversation.messages[0] ?? null,
      updatedAt: conversation.updatedAt,
    })),
    meta: { page, limit, total },
  };
}

export async function sendMessage(data: {
  conversationId: string;
  userId: string;
  content: string;
  documentId?: string;
  correlationId: string;
}) {
  const conversation = await conversationModel.findFirst({
    where: {
      id: data.conversationId,
      userId: data.userId,
    },
    select: { id: true },
  });
  if (!conversation) {
    throw new NotFoundError('Conversation not found');
  }

  if (data.documentId) {
    const document = await prisma.document.findFirst({
      where: {
        id: data.documentId,
        userId: data.userId,
        deletedAt: null,
      },
      select: { id: true },
    });
    if (!document) {
      throw new NotFoundError('Document not found');
    }
  }

  const userMessage = await prisma.$transaction(async tx => {
    const message = await (tx as unknown as Record<string, any>).message.create({
      data: {
        conversationId: data.conversationId,
        documentId: data.documentId,
        role: 'user',
        content: data.content,
      },
    });

    await (tx as unknown as Record<string, any>).conversation.update({
      where: { id: data.conversationId },
      data: { updatedAt: new Date() },
    });

    return message;
  });

  const history = await (prisma as unknown as Record<string, any>).message.findMany({
    where: { conversationId: data.conversationId },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: { role: true, content: true },
  });
  const conversationHistory = history.reverse();

  const searchResults = await semanticSearch({
    query: data.content,
    userId: data.userId,
    documentId: data.documentId,
    correlationId: data.correlationId,
  });
  const context = assembleContext(searchResults);
  const ragResponse = await generateRAGResponse({
    question: data.content,
    context,
    conversationHistory,
    userId: data.userId,
    conversationId: data.conversationId,
    correlationId: data.correlationId,
  });

  const assistantMessage = await prisma.$transaction(async tx => {
    const message = await (tx as unknown as Record<string, any>).message.create({
      data: {
        conversationId: data.conversationId,
        documentId: data.documentId,
        role: 'assistant',
        content: ragResponse.answer,
        promptTokens: ragResponse.tokensUsed.prompt,
        completionTokens: ragResponse.tokensUsed.completion,
        costUsd: ragResponse.costUsd,
        metadata: JSON.stringify({
          model: ragResponse.model,
          citations: ragResponse.citations,
          contextChunks: context.chunks.length,
        }),
      },
    });

    await (tx as unknown as Record<string, any>).conversation.update({
      where: { id: data.conversationId },
      data: { updatedAt: new Date() },
    });

    return message;
  });

  return {
    userMessage,
    assistantMessage: {
      ...assistantMessage,
      citations: ragResponse.citations,
    },
  };
}
