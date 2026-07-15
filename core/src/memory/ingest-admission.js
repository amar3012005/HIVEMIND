export function createIngestAdmission({ concurrency = 6, maxQueue = 48 } = {}) {
  const limit = Math.max(1, Number(concurrency) || 1);
  const queueLimit = Math.max(0, Number(maxQueue) || 0);
  const waiters = [];
  let active = 0;

  function acquire() {
    if (active < limit) {
      active += 1;
      return Promise.resolve();
    }
    if (waiters.length >= queueLimit) {
      const error = new Error('ingest queue is full');
      error.code = 'INGEST_QUEUE_FULL';
      return Promise.reject(error);
    }
    return new Promise((resolve) => { waiters.push(resolve); });
  }

  function release() {
    const next = waiters.shift();
    if (next) next();
    else active = Math.max(0, active - 1);
  }

  return {
    acquire,
    release,
    canAccept: () => active < limit || waiters.length < queueLimit,
    stats: () => ({ active, waiting: waiters.length, concurrency: limit, maxQueue: queueLimit }),
  };
}
