/**
 * Ported/adapted from document-first-ingestion.js's _createSegments loop.
 * Everything TENANT-SHAPED is removed: no documentId/userId/orgId, no
 * scope/scope_key/project_id/team_id/document_title. Core merges those on
 * at persist time (see HM_EXTRACT_PLAN.md — "merge, not translation").
 *
 * Takes clean text (post stripPageMarkers) + its page marks, and hybridChunks
 * if the caller has them (hm-extract never does — anydoc has no chunk
 * concept — kept as a parameter for shape-parity/testing only), and returns
 * segment objects: segmentIndex, segmentType, content, contentHash, depth,
 * startOffset, endOffset, startPage, endPage, wordCount, metadata
 * {heading, heading_path, page, source}.
 */

import crypto from 'crypto';
import { sanitizeSegmentText } from './chunker.js';
import { chunkTextAtomic } from './atomic-blocks.js';

/**
 * Sanitize the WHOLE document once, before chunking — not per-segment at the
 * end. The original core code only sanitizes each segment's stored content,
 * leaving the document-level markdown/text with raw control/replacement
 * characters still in it. That is invisible there because core never
 * promises the two are byte-aligned. hm-extract's contract explicitly does
 * (HM_EXTRACT_SPEC.md test plan: "content a verbatim substring of markdown"),
 * and it is a real, measured failure otherwise: a genuine 52-page PDF in the
 * eval corpus has a run of � replacement characters from a broken font
 * encoding at one point, and per-segment-only sanitizing made that segment's
 * content NOT a substring of the (still-dirty) returned markdown. Sanitizing
 * once, upstream of chunkText, keeps every offset computed in the same
 * coordinate system as what is returned — the per-segment call below becomes
 * a no-op safety net, not the only line of defense.
 */
export function sanitizeDocument(text) {
  return sanitizeSegmentText(text);
}

function pageAt(pageMarks, off) {
  if (!pageMarks.length || off == null) return null;
  let page = null;
  for (const mk of pageMarks) {
    if (mk.at <= off) page = mk.page;
    else break;
  }
  if (page === null && off < pageMarks[0].at) page = pageMarks[0].page;
  return page;
}

export function buildSegments(cleanText, pageMarks, opts = {}) {
  const targetSize = Number(opts.targetSize || 700);
  const overlapSize = Number(opts.overlapSize ?? 120);

  const rawChunks = (chunkTextAtomic(cleanText, {
    targetSize,
    maxSize: Math.round(targetSize * 1.5),
    minSize: 200,
    overlapSize,
  }) || [])
    .map((c) => (c && c.text ? { text: c.text.trim(), kind: c.kind } : null))
    .filter((c) => c && c.text.length >= 20);

  if (!rawChunks.length) return [];

  const segments = [];
  let cursor = 0;
  const hstack = [];

  rawChunks.forEach(({ text, kind }, idx) => {
    const contentHash = crypto.createHash('sha256').update(text).digest('hex');
    const hm = text.match(/^(#{1,6})\s+(.+)$/m);
    let heading = hm ? hm[2].slice(0, 500) : null;
    let level = hm ? hm[1].length : 0;

    if (!heading) {
      const lines = text.split('\n');
      for (let li = 0; li < Math.min(lines.length, 8); li += 1) {
        const raw = lines[li];
        const line = raw.trim();
        if (!line || line.length > 90 || /[.;,]$/.test(line) || !/\p{L}{3}/u.test(line)) continue;
        const bare = line.replace(/:$/, '').trim();
        if (!bare || !/\p{L}{3}/u.test(bare)) continue;
        const numbered = /\[\d+\]/.test(bare) ? null
          : bare.match(/^(\d+(?:\.\d+){0,3})[.)]?\s+(\p{Lu}[^\n]{2,80})$/u);
        if (numbered && !/^0\./.test(numbered[1])
            && numbered[1].split('.').every((n) => Number(n) > 0 && Number(n) <= 99)) {
          heading = line.slice(0, 500);
          level = numbered[1].split('.').length;
          break;
        }
        const letters = bare.replace(/[^\p{L}]/gu, '');
        if (letters.length >= 6 && letters === letters.toUpperCase() && bare.split(/\s+/).length <= 9) {
          heading = bare.slice(0, 500);
          level = 1;
          break;
        }
        const next = (lines[li + 1] ?? '').trim();
        const isolated = next === '' || li === lines.length - 1;
        if (isolated && bare.length <= 80) {
          const words = bare.split(/\s+/).filter(Boolean);
          const capped = words.filter((w) => /^[\p{Lu}\d]/u.test(w)).length;
          if (words.length >= 1 && words.length <= 12 && capped / words.length >= 0.6
              && /^\p{Lu}/u.test(bare)) {
            heading = bare.slice(0, 500);
            level = 2;
            break;
          }
        }
      }
    }

    if (heading) {
      while (hstack.length && hstack[hstack.length - 1].level >= level) hstack.pop();
      hstack.push({ level, title: heading });
    }
    const headingPath = hstack.map((h) => h.title);

    const anchor = text.slice(0, 60);
    let found = anchor.length >= 12 ? cleanText.indexOf(anchor, cursor) : -1;
    if (found < 0 && anchor.length >= 12) found = cleanText.indexOf(anchor);
    if (found < 0) found = cleanText.indexOf(text.slice(0, 24), cursor);
    const startOffset = found >= 0 ? found : null;
    const endOffset = startOffset != null ? startOffset + text.length : null;
    if (found >= 0) cursor = found + Math.max(1, text.length - 250);
    const startPage = pageAt(pageMarks, startOffset);
    const endPage = pageAt(pageMarks, endOffset);

    const lines2 = text.split('\n').map((l) => l.trim()).filter(Boolean);
    const pipeRows = lines2.filter((l) => l.startsWith('|') && l.endsWith('|')).length;
    // `kind` comes from atomic-blocks.js's own partition — trust it over the
    // pipeRows>=2 / list-density heuristics below. Those heuristics need
    // MULTIPLE rows/items in the same chunk to recognize the pattern, which
    // fails for a single-row-per-chunk table (routine on wide/long-field
    // CSVs) or a single-item-per-chunk list. atomic-blocks.js already knows
    // the span was a table/list before chunking split it, so a chunk of
    // kind 'table'/'list' is ALWAYS that type regardless of row count.
    const segmentType = kind === 'table' ? 'table'
      : kind === 'list' ? 'list'
        : pipeRows >= 2 ? 'table'
          : /^\s*(!\[|<!--\s*image|Figure|Abbildung|Diagram)/i.test(text) ? 'figure'
            : lines2.filter((l) => /^([-*+]|\d+\.)\s/.test(l)).length >= Math.max(2, Math.ceil(lines2.length * 0.6)) ? 'list'
              : (heading && lines2.length <= 2) ? 'heading'
                : 'paragraph';

    segments.push({
      segmentIndex: idx,
      segmentType,
      content: sanitizeSegmentText(text),
      contentHash,
      depth: hstack.length,
      startOffset,
      endOffset,
      startPage,
      endPage,
      wordCount: text.split(/\s+/).length,
      metadata: { heading, heading_path: headingPath, page: startPage, source: 'semantic_chunk' },
    });
  });

  return segments;
}

/**
 * Structural density — a free, tenant-agnostic signal for core's future
 * selective-gating decision (semantic_chunking_plan_2026-08-09.md §6, main
 * repo): "Only run the semantic [embedding-boundary] pass when structural
 * boundary density is low... this one gate is what keeps embedding cost
 * from scaling linearly with corpus size."
 *
 * Deliberately just a number, not a decision. hm-extract computes signal,
 * never spends money: the embedding call itself needs per-org billing
 * attribution (planEnforcer/meterTokens), which requires tenant identity
 * hm-extract does not and should not have — see HM_EXTRACT_PLAN.md's
 * updated §"semantic-boundary placement" for why that step stays in core.
 * This function only tells core how many chars it would have to search per
 * heading if it wants to consider running that pass.
 */
export function computeStructuralDensity(segments, totalChars) {
  const headingCount = segments.filter((s) => s.metadata?.heading).length;
  const atomicCount = segments.filter((s) => s.segmentType === 'table' || s.segmentType === 'list').length;
  return {
    segment_count: segments.length,
    heading_count: headingCount,
    chars_per_heading: headingCount > 0 ? Math.round(totalChars / headingCount) : totalChars,
    atomic_segment_ratio: segments.length ? Number((atomicCount / segments.length).toFixed(3)) : 0,
  };
}
