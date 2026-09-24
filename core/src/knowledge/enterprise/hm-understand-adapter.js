const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Typed Core-to-hm-understand client. It sends text and parser locators only;
 * authentication, tenant authorization, canonical resolution, and writes remain
 * in Core. Callers must pass only blocks already authorized for their job.
 */
export class HmUnderstandAdapter {
  constructor({ baseUrl = process.env.HM_UNDERSTAND_URL || '', fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS, logger = console } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.fetch = fetchImpl;
    this.timeoutMs = Math.max(1_000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
    this.logger = logger;
  }

  configured() { return Boolean(this.baseUrl && typeof this.fetch === 'function'); }

  async analyze({ source, blocks, entityTypes, includeCandidates = true } = {}) {
    if (!this.baseUrl || typeof this.fetch !== 'function') {
      return { ok: false, code: 'HM_UNDERSTAND_UNAVAILABLE', retryable: true };
    }
    if (!Array.isArray(blocks) || blocks.length === 0) {
      return { ok: false, code: 'HM_UNDERSTAND_EMPTY_INPUT', retryable: false };
    }
    const batches = [];
    let batch = [];
    let batchChars = 0;
    for (const block of blocks) {
      const chars = String(block?.text || '').length;
      if (chars > 100_000) return { ok: false, code: 'HM_UNDERSTAND_BLOCK_TOO_LARGE', retryable: false };
      if (batch.length && (batch.length >= 100 || batchChars + chars > 1_000_000)) {
        batches.push(batch); batch = []; batchChars = 0;
      }
      batch.push(block); batchChars += chars;
    }
    if (batch.length) batches.push(batch);

    const results = [];
    for (const current of batches) {
      const controller = new AbortController();
      let timeoutExpired = false;
      let timer;
      try {
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => {
            timeoutExpired = true;
            controller.abort();
            const error = new Error('hm-understand request exceeded its timeout');
            error.code = 'HM_UNDERSTAND_TIMEOUT';
            reject(error);
          }, this.timeoutMs);
        });
        const request = (async () => {
          const response = await this.fetch(`${this.baseUrl}/v1/analyze`, {
            method: 'POST',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify({
              schema_version: '1', source, blocks: current, entity_types: entityTypes, include_candidates: includeCandidates,
            }),
            signal: controller.signal,
          });
          const body = await response.json().catch(() => null);
          return { response, body };
        })();
        const { response, body } = await Promise.race([request, timeout]);
        if (!response.ok || !body || body.schema_version !== '1' || !Array.isArray(body.blocks)) {
          return { ok: false, code: 'HM_UNDERSTAND_BAD_RESPONSE', retryable: response.status >= 500 };
        }
        results.push(body);
      } catch (error) {
        this.logger?.warn?.(`[hm-understand] analysis request failed: ${error?.message || 'unknown error'}`);
        return { ok: false,
          code: timeoutExpired || error?.name === 'AbortError' || error?.code === 'HM_UNDERSTAND_TIMEOUT'
            ? 'HM_UNDERSTAND_TIMEOUT' : 'HM_UNDERSTAND_REQUEST_FAILED',
          retryable: true };
      } finally {
        clearTimeout(timer);
      }
    }
    const first = results[0];
    const modelVersions = Object.assign({}, ...results.map((item) => item.model_versions || {}));
    return { ok: true, result: {
      ...first,
      complete: results.every((item) => item.complete === true),
      blocks: results.flatMap((item) => item.blocks),
      model_versions: modelVersions,
      totals: results.reduce((sum, item) => ({
        blocks: sum.blocks + Number(item.totals?.blocks || 0),
        mentions: sum.mentions + Number(item.totals?.mentions || 0),
        candidates: sum.candidates + Number(item.totals?.candidates || 0),
        processing_ms: sum.processing_ms + Number(item.totals?.processing_ms || 0),
      }), { blocks: 0, mentions: 0, candidates: 0, processing_ms: 0 }),
    } };
  }
}

export function hmUnderstandBlocksFromSegments(segments = []) {
  return segments.filter((segment) => typeof segment?.content === 'string' && segment.content.trim())
    .map((segment, index) => ({
      id: String(segment.id || `segment-${index + 1}`),
      text: segment.content,
      source_start: Number.isInteger(segment.startOffset) ? segment.startOffset : null,
      source_end: Number.isInteger(segment.endOffset) ? segment.endOffset : null,
      locator: {
        page: Number.isInteger(segment.startPage) ? segment.startPage : null,
        heading_path: Array.isArray(segment.metadata?.heading_path) ? segment.metadata.heading_path : [],
        sheet: typeof segment.metadata?.sheet === 'string' ? segment.metadata.sheet : null,
        row: Number.isInteger(segment.metadata?.row) ? segment.metadata.row : null,
        cell: typeof segment.metadata?.cell === 'string' ? segment.metadata.cell : null,
      },
      language: segment.metadata?.language || null,
      metadata: {
        segment_type: segment.segmentType || null,
        segment_index: Number.isInteger(segment.segmentIndex) ? segment.segmentIndex : index,
      },
    }));
}

/** Persist only bounded, non-content metrics for a shadow run. */
export function hmUnderstandShadowReceipt(result, { sourceRevision = null } = {}) {
  if (!result?.ok || !result.result) return {
    status: 'unavailable', source_revision: sourceRevision,
    code: result?.code || 'HM_UNDERSTAND_UNAVAILABLE',
  };
  const analysis = result.result;
  const labels = {};
  const candidateKinds = {};
  const refinementReasons = {};
  let refinementBlocks = 0;
  const languages = {};
  for (const block of analysis.blocks || []) {
    const language = String(block.language?.primary || 'und').slice(0, 16);
    languages[language] = (languages[language] || 0) + 1;
    for (const mention of block.mentions || []) {
      const label = String(mention.label || 'unknown').slice(0, 48);
      labels[label] = (labels[label] || 0) + 1;
    }
    for (const candidate of block.candidates || []) {
      const kind = String(candidate.kind || 'unknown').slice(0, 32);
      candidateKinds[kind] = (candidateKinds[kind] || 0) + 1;
    }
    if (block.quality?.refinement_required === true) refinementBlocks += 1;
    for (const reason of Array.isArray(block.quality?.refinement_reasons) ? block.quality.refinement_reasons : []) {
      const boundedReason = String(reason || 'unknown').slice(0, 48);
      refinementReasons[boundedReason] = (refinementReasons[boundedReason] || 0) + 1;
    }
  }
  return {
    status: analysis.complete === true ? 'complete' : 'partial',
    source_revision: sourceRevision,
    content_hash: analysis.content_hash || null,
    pipeline_version: analysis.pipeline_version || null,
    model_versions: analysis.model_versions || {},
    totals: analysis.totals || {},
    language_blocks: languages,
    entity_label_counts: labels,
    candidate_kind_counts: candidateKinds,
    refinement_required_blocks: refinementBlocks,
    refinement_reason_counts: refinementReasons,
    refinement: analysis.refinement_receipt && typeof analysis.refinement_receipt === 'object'
      ? {
        status: String(analysis.refinement_receipt.status || 'unknown').slice(0, 24),
        selected_blocks: Math.max(0, Number(analysis.refinement_receipt.selected_blocks) || 0),
        accepted_items: Math.max(0, Number(analysis.refinement_receipt.accepted_items) || 0),
        rejected_items: Math.max(0, Number(analysis.refinement_receipt.rejected_items) || 0),
        truncated_blocks: Math.max(0, Number(analysis.refinement_receipt.truncated_blocks) || 0),
      }
      : null,
    persisted_content: false,
  };
}

/** Build the Core analysis hook with the dedicated tenant-scoped hm_understand_v1 Flagship decision. */
export function createHmUnderstandShadowAnalyzer({ flagClient, adapter, logger = console } = {}) {
  return async ({ userId, orgId, documentId, sourceRevision, filename, segments } = {}) => {
    if (!flagClient?.hmUnderstandModeFor || !adapter || !orgId || !userId) return { enabled: false, mode: 'off' };
    let mode = 'off';
    try {
      mode = await flagClient.hmUnderstandModeFor({ orgId, userId });
    } catch (error) {
      logger?.warn?.(`[hm-understand] Flagship evaluation failed closed: ${error?.message || 'unknown error'}`);
      return { enabled: false, mode: 'off' };
    }
    if (!['shadow', 'assisted'].includes(mode)) return { enabled: false, mode: 'off' };
    if (!adapter.configured?.()) return { enabled: true, mode, ok: false, code: 'HM_UNDERSTAND_UNAVAILABLE' };
    const blocks = hmUnderstandBlocksFromSegments(segments || []);
    if (!blocks.length) return { enabled: true, mode, ok: false, code: 'HM_UNDERSTAND_EMPTY_INPUT' };
    const result = await adapter.analyze({
      source: { id: documentId, revision: sourceRevision, content_hash: sourceRevision,
        occurred_at: null, timezone: null },
      blocks,
    });
    return { ...result, enabled: true, mode };
  };
}
