export async function recordRuntimeMetric(prisma, {
  orgId, runId = null, stageId = null, metric, value, unit = 'ms', source, metadata = {},
} = {}) {
  if (!prisma || !orgId || !metric || !source || !Number.isFinite(Number(value))) return null;
  return prisma.runtimePerformanceMetric?.create({
    data: {
      orgId,
      runId: runId || null,
      stageId: stageId ? String(stageId).slice(0, 120) : null,
      metric: String(metric).slice(0, 120),
      value: Number(value),
      unit: String(unit).slice(0, 24),
      source: String(source).slice(0, 120),
      metadata: metadata && typeof metadata === 'object' ? metadata : {},
    },
  }).catch(() => null);
}
