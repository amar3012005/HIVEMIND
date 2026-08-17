export async function settleEvidenceLaneWithin(promise, timeoutMs, fallback = null) {
  let timer = null;
  const guarded = Promise.resolve(promise).catch(() => fallback);
  try {
    return await Promise.race([
      guarded,
      new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
