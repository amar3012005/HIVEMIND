// Bound the actual embedding transport, not a detached Promise.race. The
// shared signal stops provider fallback too; await transport settlement before
// returning so this expensive prepass cannot outlive the admitted request.
export async function boundedRecallEmbedding(client, query, { signal = null, timeoutMs = 1500, tenantId, onOutcome = null } = {}) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(signal.reason);
  if (signal?.aborted) throw signal.reason || new Error('Recall cancelled');
  else signal?.addEventListener('abort', abortFromParent, { once: true });
  let deadlineHit = false;
  const timer = setTimeout(() => {
    deadlineHit = true;
    controller.abort(new Error('Recall embedding deadline exceeded'));
  }, timeoutMs);
  try {
    const vector = await client.generateEmbedding(query, {
      workload: 'interactive', tenantId, signal: controller.signal, timeoutMs,
    });
    // generateEmbedding reports provider errors as null, so a null after the deadline is a timeout.
    onOutcome?.(Array.isArray(vector) && vector.length ? 'ok' : (deadlineHit ? 'timeout' : 'unavailable'));
    return vector;
  } catch (error) {
    onOutcome?.(deadlineHit ? 'timeout' : 'unavailable');
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abortFromParent);
  }
}


// In-flight coalescing must not lend another request an unbounded operation
// with a different cancellation owner. Completed deterministic caches remain
// reusable; only pending request-owned work is separated.
const cancellationOwners = new WeakMap();
let nextCancellationOwner = 0;
export function embeddingCancellationOwnerKey(signal) {
  if (!signal) return 'shared';
  if (!cancellationOwners.has(signal)) cancellationOwners.set(signal, ++nextCancellationOwner);
  return String(cancellationOwners.get(signal));
}
