export async function getReviewMetrics(period: string = '24h') {
  const since = computeSinceDate(period);

  const [total, pending, approved, rejected, escalated] = await Promise.all([
    prisma.reviewQueue.count({ where: { createdAt: { gte: since } } }),
    prisma.reviewQueue.count({ where: { status: 'PENDING' } }),
    prisma.reviewQueue.count({ where: { status: 'APPROVED', reviewedAt: { gte: since } } }),
    prisma.reviewQueue.count({ where: { status: 'REJECTED', reviewedAt: { gte: since } } }),
    prisma.reviewQueue.count({ where: { status: 'ESCALATED', escalatedAt: { gte: since } } }),
  ]);

  // Average turnaround time (created to reviewed)
  const reviewed = await prisma.reviewQueue.findMany({
    where: {
      reviewedAt: { not: null, gte: since },
    },
    select: { createdAt: true, reviewedAt: true },
  });

  const avgTurnaroundMs = reviewed.length > 0
    ? reviewed.reduce((sum, r) =>
        sum + (r.reviewedAt!.getTime() - r.createdAt.getTime()), 0
      ) / reviewed.length
    : 0;

  // Approval rate — how often do reviewers agree with the AI?
  const approvalRate = (approved + rejected) > 0
    ? approved / (approved + rejected)
    : 0;

  // Edit rate — how often do reviewers change the answer?
  const edited = await prisma.reviewQueue.count({
    where: {
      status: 'APPROVED',
      editedAnswer: { not: null },
      reviewedAt: { gte: since },
    },
  });
  const editRate = approved > 0 ? edited / approved : 0;

  // SLA compliance
  const slaBreaches = await prisma.reviewQueue.count({
    where: {
      status: 'ESCALATED',
      createdAt: { gte: since },
    },
  });
  const slaCompliance = total > 0 ? 1 - (slaBreaches / total) : 1;

  return {
    period,
    queue: { total, pending, approved, rejected, escalated },
    turnaround: {
      avgMinutes: Math.round(avgTurnaroundMs / 60000),
    },
    rates: {
      approvalRate: Math.round(approvalRate * 100),
      editRate: Math.round(editRate * 100),
      slaCompliance: Math.round(slaCompliance * 100),
      escalationRate: total > 0
        ? Math.round((escalated / total) * 100)
        : 0,
    },
  };
}
