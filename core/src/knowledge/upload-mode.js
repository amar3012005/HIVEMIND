export function shouldRequireQueuedKbUploads() {
  // Ingestion durability is a product invariant, not an environment feature.
  // Cloudflare Workflow may be selected as the primary orchestrator, but the
  // upload must always cross a durable queue boundary (local BullMQ fallback)
  // before any parser or model work begins.
  return true;
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
