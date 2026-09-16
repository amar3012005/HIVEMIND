/**
 * Normalize provider responses to the narrow evidence contract used by rooms.
 * A provider answer is never evidence: only public URL-backed result rows may
 * cross this boundary.
 */
export function normalizeUrlBackedSearchResults(candidateRows, { limit = 6 } = {}) {
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 6, 10));
  const seen = new Set();
  const rows = Array.isArray(candidateRows) ? candidateRows : [];
  const results = [];
  for (let index = 0; index < rows.length && results.length < boundedLimit; index += 1) {
    const candidate = rows[index];
    const row = candidate && typeof candidate === 'object' ? candidate : { url: candidate };
    const nested = row.source && typeof row.source === 'object' ? row.source : {};
    const url = String(row.url || row.link || row.source_url || row.sourceUrl || nested.url || nested.link || '').trim();
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    results.push({
      title: String(row.title || row.name || nested.title || `Source ${index + 1}`).slice(0, 500),
      url: url.slice(0, 2048),
      snippet: String(row.snippet || row.text || row.description || row.content || nested.snippet || nested.text || '').trim().slice(0, 3000),
      score: Number.isFinite(Number(row.score ?? row.relevance_score ?? nested.score))
        ? Number(row.score ?? row.relevance_score ?? nested.score) : null,
    });
  }
  return results;
}

export function mergeExtractedContent(results, extractedRows) {
  const contentByUrl = new Map((Array.isArray(extractedRows) ? extractedRows : []).map((row) => [
    String(row?.url || row?.id || '').trim(),
    String(row?.text || row?.content || '').trim().slice(0, 3000),
  ]));
  return results.map((row) => ({ ...row, snippet: row.snippet || contentByUrl.get(row.url) || '' }));
}

export function providerCandidateRows(data) {
  if (!data || typeof data !== 'object') return [];
  const nested = data.data && typeof data.data === 'object' ? data.data : {};
  for (const candidate of [data.citations, data.sources, data.results, nested.citations, nested.sources, nested.results]) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}
