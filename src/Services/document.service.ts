import { EventEmitter } from 'node:events';
import { PrismaClient } from '@prisma/client';

const appEvents = new EventEmitter();

class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

const prisma = new PrismaClient();

interface ListDocumentsOptions {
  page: number;
  limit: number;
  status?: string;
  search?: string;
  sortBy?: 'createdAt' | 'title' | 'chunkCount';
  sortOrder?: 'asc' | 'desc';
}

export async function listDocuments(
  userId: string,
  options: ListDocumentsOptions
) {
  const {
    page, limit,
    status, search,
    sortBy = 'createdAt',
    sortOrder = 'desc',
  } = options;

  // Build the where clause dynamically
  const where: any = {
    userId,
    deletedAt: null, // Soft delete filter (we'll add this today)
  };

  if (status) {
    where.status = status;
  }

  if (search) {
    where.title = { contains: search, mode: 'insensitive' };
    where.description = { contains: search, mode: 'insensitive' };
  }

  const [documents, total] = await Promise.all([
    prisma.document.findMany({
      where,
      orderBy: { [sortBy]: sortOrder },
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        title: true,
        filename: true,
        status: true,
        chunkCount: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.document.count({ where }),
  ]);

  return {
    data: documents,
    meta: { page, limit, total },
  };
}

export async function deleteDocument(
  documentId: string,
  userId: string
) {
  const doc = await prisma.document.findUnique({
    where: { id: documentId },
  });

  if (!doc || doc.deletedAt) {
    throw new NotFoundError('Document not found');
  }

  // Ownership check
  if (doc.userId !== userId) {
    throw new NotFoundError('Document not found');
  }

  const deletedDoc = await prisma.document.update({
    where: { id: documentId },
    data: {
      deletedAt: new Date(),
      deletedBy: userId,
    },
  });

  appEvents.emit('doc:deleted', {
    deletedBy: userId,
    documentId: doc.id,
  });

  return deletedDoc;
}

import { queueDocumentForProcessing } from '../queues/document.queue';

export async function createDocument(data: {
  title: string;
  content: string;
  userId: string;
}) {
  // Create the document with pending status
  const doc = await prisma.document.create({
    data: {
      userId: data.userId,
      title: data.title,
      filename: data.title.toLowerCase().replace(/\s+/g, '-'),
      content: data.content,
      status: 'pending',
    },
  });

  // Queue for background processing
  const jobId = await queueDocumentForProcessing(doc.id, data.userId);

  appEvents.emit('doc:created', {
    userId: data.userId,
    documentId: doc.id,
    title: data.title,
  });

  // Return 202 Accepted (not 201 Created)
  // The document exists but isn't ready yet
  return { document: doc, jobId };
}
