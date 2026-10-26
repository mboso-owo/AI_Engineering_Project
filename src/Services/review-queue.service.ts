import { prisma } from '../lib/prisma';
import { config } from '../config';

export const reviewQueueService = {
  async enqueue(data: {
    messageId: string;
    documentId: string;
    question: string;
    generatedAnswer: string;
    confidence: number;
    sources: any;
    reason?: string;
  }) {
    const priority = this.computePriority(data.confidence);
    const slaDeadline = new Date(
      Date.now() + config.hitl.slaMinutes * 60 * 1000
    );

    return prisma.reviewQueue.create({
      data: {
        ...data,
        priority,
        slaDeadline,
      },
    });
  },

  // Claim the next item for review (FIFO within priority)
  async claimNext(reviewerId: string) {
    // Use a transaction to prevent two reviewers
    // from claiming the same item
    return prisma.$transaction(async (tx) => {
      const item = await tx.reviewQueue.findFirst({
        where: { status: 'PENDING' },
        orderBy: [
          { priority: 'desc' },  // URGENT first
          { createdAt: 'asc' },  // oldest first within priority
        ],
      });

      if (!item) return null;

      return tx.reviewQueue.update({
        where: { id: item.id },
        data: {
          status: 'IN_REVIEW',
          reviewedBy: reviewerId,
        },
      });
    });
  },

  async processDecision(
    reviewId: string,
    reviewerId: string,
    decision: {
      action: 'approve' | 'reject';
      editedAnswer?: string;
      reviewerNotes?: string;
    }
  ) {
    const review = await prisma.reviewQueue.update({
      where: { id: reviewId },
      data: {
        status: decision.action === 'approve' ? 'APPROVED' : 'REJECTED',
        reviewedBy: reviewerId,
        editedAnswer: decision.editedAnswer,
        reviewerNotes: decision.reviewerNotes,
        reviewedAt: new Date(),
      },
    });

    // Update the original message with the final answer
    if (decision.action === 'approve') {
      const finalAnswer = decision.editedAnswer || review.generatedAnswer;
      await prisma.message.update({
        where: { id: review.messageId },
        data: {
          content: finalAnswer,
          // Mark it as human-reviewed so we know
          // this answer was validated
          metadata: { humanReviewed: true, reviewId },
        },
      });
    }

    // Store the feedback for future improvement
    await this.storeFeedback(review, decision);

    return review;
  },

  computePriority(confidence: number): string {
    if (confidence < 0.2) return 'URGENT';
    if (confidence < 0.4) return 'HIGH';
    if (confidence < 0.6) return 'NORMAL';
    return 'LOW';
  },

  async storeFeedback(
    review: any,
    decision: { action: string; editedAnswer?: string; reviewerNotes?: string }
  ) {
    // This is the feedback loop. Every human decision
    // becomes a data point you can use to improve the system.
    await prisma.aITrace.create({
      data: {
        traceId: `review_${review.id}`,
        userId: review.reviewedBy,
        operation: 'hitl_review',
        data: {
          reviewId: review.id,
          originalAnswer: review.generatedAnswer,
          editedAnswer: decision.editedAnswer,
          wasEdited: !!decision.editedAnswer,
          action: decision.action,
          confidence: review.confidence,
          question: review.question,
          reviewerNotes: decision.reviewerNotes,
        },
      },
    });
  },
};
