export function exactMemoryListTotal(total) {
  if (Number.isFinite(total) && total >= 0) {
    return { ok: true, total };
  }

  return {
    ok: false,
    status: 503,
    body: {
      error: 'remote_memory_list_total_unavailable',
      code: 'REMOTE_MEMORY_LIST_TOTAL_UNAVAILABLE',
      message: 'The memory store did not return an exact filtered total.',
      retryable: false,
    },
  };
}
