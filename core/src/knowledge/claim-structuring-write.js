function isMissingRecordError(error) {
  return error?.code === 'P2025'
    || /record (?:to update )?not found|required but not found/i.test(String(error?.message || ''));
}

/** Apply post-commit claim enrichment only while its memory remains live. */
export async function applyClaimPatchIfLive(store, memoryId, patch) {
  if (!store?.getMemory || !store?.updateMemory || !memoryId || !patch) return false;
  const current = await store.getMemory(memoryId);
  if (!current) return false;
  try {
    await store.updateMemory(memoryId, patch);
    return true;
  } catch (error) {
    // Close the check/update race: deletion is authoritative, not a queue error.
    if (isMissingRecordError(error)) return false;
    throw error;
  }
}
