
import { Queue, Worker } from 'bullmq';
import { prisma } from '../lib/prisma';
import { config } from '../config';
import { eventEmitter } from '../events';

// Run this job every 5 minutes via a repeatable BullMQ job
export async function checkEscalations() {
  const now = new Date();
  const warningWindow = new Date(
    now.getTime() + 15 * 60 * 1000  // 15 minutes before SLA
  );

  // Find items approaching SLA deadline
  const atRisk = await prisma.reviewQueue.findMany({
    where: {
      status: { in: ['PENDING', 'IN_REVIEW'] },
      slaDeadline: { lte: warningWindow },
      escalatedAt: null,
    },
    orderBy: { slaDeadline: 'asc' },
  });

  for (const item of atRisk) {
    if (item.slaDeadline <= now) {
      // SLA breached — deliver the answer with a disclaimer
      await handleSlaBreach(item);
    } else {
      // Approaching SLA — escalate priority
      await escalateItem(item);
    }
  }
}

async function escalateItem(item: any) {
  await prisma.reviewQueue.update({
    where: { id: item.id },
    data: {
      priority: 'URGENT',
      escalatedAt: new Date(),
    },
  });

  // Notify admins via the event system
  eventEmitter.emit('review:escalated', {
    reviewId: item.id,
    question: item.question,
    confidence: item.confidence,
    slaDeadline: item.slaDeadline,
    waitTimeMinutes: Math.round(
      (Date.now() - item.createdAt.getTime()) / 60000
    ),
  });
}

async function handleSlaBreach(item: any) {
  // Deliver the original answer with a low-confidence disclaimer
  await prisma.message.update({
    where: { id: item.messageId },
    data: {
      content: item.generatedAnswer,
      metadata: {
        humanReviewed: false,
        disclaimer: 'This answer was generated with low confidence ' +
                     'and could not be reviewed in time. ' +
                     'Please verify the information independently.',
        slaBreach: true,
      },
    },
  });

  await prisma.reviewQueue.update({
    where: { id: item.id },
    data: { status: 'ESCALATED' },
  });

  eventEmitter.emit('review:sla_breached', {
    reviewId: item.id,
    waitTimeMinutes: Math.round(
      (Date.now() - item.createdAt.getTime()) / 60000
    ),
  });
}
