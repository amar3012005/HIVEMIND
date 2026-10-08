/** Never discard deletion coordinates while durable source stores are unreconciled. */
export async function requireReconciledSourceErasure(prisma, userId) {
  const [documents, sources, ingestJobs] = await Promise.all([
    prisma.knowledgeDocument.count({ where: { userId } }),
    prisma.sourceArtifact.count({ where: { userId } }),
    prisma.knowledgeIngestJob.count({ where: { userId } }),
  ]);
  if (documents || sources || ingestJobs) {
    throw Object.assign(new Error('Account erasure requires durable source-store reconciliation before completion'), {
      code: 'SOURCE_ERASURE_RECONCILIATION_REQUIRED', status: 409,
    });
  }
}
