/** Check remote completion before reporting an erasure stage as completed. */
export async function checkedVectorDelete(fetchImpl, url, options) {
  const response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(15000) });
  // An absent collection is already erased. All other failures require retry.
  if (response.status === 404) return;
  if (!response.ok) throw Object.assign(new Error('Vector erasure is incomplete; retry required'), { code: 'VECTOR_ERASURE_INCOMPLETE' });
  const body = await response.json();
  if (body.status !== 'ok' || (body.result?.status && body.result.status !== 'completed')) {
    throw Object.assign(new Error('Vector erasure completion was not confirmed'), { code: 'VECTOR_ERASURE_INCOMPLETE' });
  }
}
