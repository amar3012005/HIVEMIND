export function resolveDistillActions(actions, candidates, neighborsPerCand) {
  const byIndex = new Map();
  for (const raw of Array.isArray(actions) ? actions : []) {
    const index = Number(raw?.index);
    if (!Number.isInteger(index) || index < 0 || index >= candidates.length || byIndex.has(index)) continue;
    const action = ['save', 'update', 'skip'].includes(raw?.action) ? raw.action : 'skip';
    const allowedTargets = new Set((neighborsPerCand[index] || []).map((memory) => memory.id));
    const target = typeof raw?.target_memory_id === 'string' ? raw.target_memory_id : null;
    if (action === 'update' && (!target || !allowedTargets.has(target))) {
      byIndex.set(index, { index, action: 'skip', target_memory_id: null, reason: 'invalid update target' });
      continue;
    }
    byIndex.set(index, {
      index,
      action,
      target_memory_id: action === 'update' ? target : null,
      reason: typeof raw?.reason === 'string' ? raw.reason.slice(0, 500) : '',
    });
  }
  for (let index = 0; index < candidates.length; index++) {
    if (!byIndex.has(index)) {
      byIndex.set(index, { index, action: 'skip', target_memory_id: null, reason: 'no valid distillation decision' });
    }
  }
  return byIndex;
}
