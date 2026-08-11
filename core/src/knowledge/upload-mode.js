export function shouldRequireQueuedKbUploads() {
  return process.env.NODE_ENV === 'production'
    || process.env.HIVEMIND_REQUIRE_QUEUED_KB_UPLOADS === 'true';
}

export function decideKbUploadPath({ queueEnabled, queueError = null, asyncRequested = false } = {}) {
  const requireQueue = shouldRequireQueuedKbUploads();
  if (queueEnabled) {
    return { mode: 'queue', requireQueue };
  }
  if (requireQueue) {
    return {
      mode: 'reject',
      requireQueue,
      statusCode: 503,
      error: 'queue_unavailable',
      message: queueError || 'Knowledge uploads require the durable KB queue in this environment.',
    };
  }
  if (asyncRequested) {
    return { mode: 'async_inline', requireQueue };
  }
  return { mode: 'sync_inline', requireQueue };
}
