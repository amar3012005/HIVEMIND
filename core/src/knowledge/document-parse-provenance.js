/**
 * Canonical projection of the latest verified parser result onto a document.
 * Replays must replace a stale failed/unparsed label once parsing succeeds.
 */
export function buildDocumentParseProvenance({ parseResult, documentType, documentTypeConfidence }) {
  const success = parseResult?.success === true;
  return {
    wordCount: Number.isFinite(Number(parseResult?.wordCount)) ? Number(parseResult.wordCount) : null,
    parseStatus: success ? 'parsed' : 'failed',
    parseEngine: parseResult?.engine || (success ? 'unknown' : 'unparsed'),
    parseMetadata: {
      ...(parseResult?.metadata || {}),
      document_type: documentType,
      document_type_confidence: documentTypeConfidence,
    },
    structureExtracted: success,
  };
}
