const ENTERPRISE_PLANS = new Set(['enterprise_onboarding', 'enterprise', 'managed', 'scale']);

export function memoryStorageModeFor(plan, hostingMode) {
  if (hostingMode === 'self_host') return 'byod_amr';
  return ENTERPRISE_PLANS.has(String(plan).toLowerCase()) ? 'hybrid' : 'amr_embedded';
}

export function memoryStorageLabel(mode) {
  return mode === 'amr_embedded' ? '.amr filesystem'
    : mode === 'hybrid_amr_index' ? 'PostgreSQL + Qdrant + .amr index'
      : mode === 'byod_amr' ? 'BYOD .amr filesystem'
        : mode === 'byod_hybrid' ? 'BYOD PostgreSQL + Qdrant'
          : 'PostgreSQL + Qdrant';
}
