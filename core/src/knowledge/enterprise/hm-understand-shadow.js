import { hmUnderstandShadowReceipt } from './hm-understand-adapter.js';

/**
 * Run a feature-gated analysis and persist only bounded metrics against the
 * already-authorized document row. Raw analysis is returned only in process for
 * the explicitly targeted assisted mode; it is never stored in parse metadata.
 */
export async function runHmUnderstandShadow({
  analyzer, db, isRemoteOrg = () => false, logger = console,
  userId, orgId, documentId, sourceRevision, filename, segments, parseMetadata = {},
} = {}) {
  if (typeof analyzer !== 'function' || !userId || !orgId || !documentId || isRemoteOrg(orgId)) return null;
  try {
    const analysis = await analyzer({ userId, orgId, documentId, sourceRevision, filename, segments });
    if (analysis?.enabled !== true) return null;
    const receipt = hmUnderstandShadowReceipt(analysis, { sourceRevision });
    if (db?.knowledgeDocument?.updateMany) {
      await db.knowledgeDocument.updateMany({
        where: { id: documentId, userId, orgId },
        data: { parseMetadata: { ...parseMetadata, hm_understand_shadow: receipt } },
      });
    }
    logger.info?.(`[hm-understand] ${analysis.mode || 'shadow'} ${String(documentId).slice(0, 8)}: `
      + `status=${receipt.status} blocks=${receipt.totals?.blocks || 0} `
      + `mentions=${receipt.totals?.mentions || 0} candidates=${receipt.totals?.candidates || 0}`);
    return {
      receipt,
      // Content-bearing analysis stays ephemeral and is exposed only to the
      // caller that needs it for the same ingestion. Shadow is metrics-only.
      analysis: analysis.mode === 'assisted' && analysis.ok === true ? analysis.result : null,
    };
  } catch (error) {
    logger.warn?.(`[hm-understand] shadow analysis degraded for ${String(documentId).slice(0, 8)}: ${error.message}`);
    return { receipt: { status: 'degraded', source_revision: sourceRevision }, analysis: null };
  }
}
