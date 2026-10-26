import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { authenticate } from '../middleware/auth';
import { documentQueue } from '../queues/document.queue';

const router = Router();
const prisma = new PrismaClient();

// Public route - no auth needed
router.get('/health', (req, res) => res.json({ status: 'ok' }));

// Protected route - requires valid access token
router.get('/documents', authenticate, async (req, res) => {
  // req.user is guaranteed to exist here
  const docs = await prisma.document.findMany({
    where: { userId: req.user!.id },
  });
  res.json(docs);
});

//import { Router } from 'express';
//import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import {
  createDocumentSchema,
  listDocumentsSchema,
  documentParamsSchema,
} from '../validators/document.validator';

router.use(authenticate); // All document routes require auth

router.get('/',
  validate(listDocumentsSchema),
  async (req, res) => {
    const docs = await prisma.document.findMany({
      where: { userId: req.user!.id },
    });
    res.json(docs);
  }
);

const createDocument = async (req: import('express').Request, res: import('express').Response) => {
  const doc = await prisma.document.create({
    data: {
      ...req.body,
      userId: req.user!.id,
    },
  });

  res.status(201).json(doc);
};

router.post('/',
  validate(createDocumentSchema),
  createDocument
);

async function getDocument(req: import('express').Request, res: import('express').Response) {
  const documentId = String(req.params.id);
  const doc = await prisma.document.findFirst({
    where: { id: documentId, userId: req.user!.id },
  });

  if (!doc) {
    return res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Document not found' },
    });
  }

  return res.json(doc);
}

async function deleteDocument(req: import('express').Request, res: import('express').Response) {
  const documentId = String(req.params.id);
  const result = await prisma.document.deleteMany({
    where: { id: documentId, userId: req.user!.id },
  });

  if (result.count === 0) {
    return res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Document not found' },
    });
  }

  return res.status(204).send();
}

router.get('/:id',
  validate(documentParamsSchema),
  getDocument
);

router.delete('/:id',
  validate(documentParamsSchema),
  deleteDocument
);

export default router;


router.get('/:id/processing-status',
  authenticate,
  requirePermission('documents:read'),
  async (req, res) => {
    const documentId = String(req.params.id);
    const doc = await prisma.document.findUnique({
      where: { id: documentId },
      select: { id: true, status: true, userId: true },
    });

    if (!doc || doc.userId !== req.user!.id) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Document not found' },
      });
    }

    // Try to find the active job for this document
    const jobs = await documentQueue.getJobs(['active', 'waiting']);
    const activeJob = jobs.find(
      j => j.data.documentId === documentId
    );

    res.json({
      success: true,
      data: {
        status: doc.status,
        error: null,
        progress: activeJob ? await activeJob.progress : null,
      },
    });
  }
);
function requirePermission(arg0: string): import("express-serve-static-core").RequestHandler<import("express-serve-static-core").ParamsDictionary, any, any, import("qs").ParsedQs, Record<string, any>> {
  return (req, res, next) => {
    const permissions = (req.user as { permissions?: string[] } | undefined)?.permissions;

    if (!permissions?.includes(arg0)) {
      return res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Insufficient permissions' },
      });
    }

    next();
  };
}

