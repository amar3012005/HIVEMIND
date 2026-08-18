/**
 * Table/list ATOMICITY — new in hm-extract, not a port. Fixes a real gap
 * measured on a real 70MB/95,291-row CSV: a table row was split across a
 * chunk boundary and survived only because the overlap-carry mechanism
 * duplicated its tail into the next chunk, not because the boundary
 * respected the row. This is exactly the gap
 * semantic_chunking_plan_2026-08-09.md (main repo, §3, "Atomicity") flags as
 * unbuilt: "Tables, list groups, and code blocks must never split... a
 * 7-row compatibility matrix landing inside one segment reached the
 * extractor as pipe-delimited text and came back with 3 rows dropped."
 *
 * Deliberately NOT built by modifying chunker.js's ported chunkText — that
 * function is a verbatim port and stays that way so prose chunking is
 * byte-identical to core's current behavior. This module is a PRE-PASS:
 * partition the document into (prose | table | list) spans, chunk each
 * span with the strategy suited to it, concatenate the resulting chunk
 * TEXTS in order. Everything downstream (heading detection, offset
 * anchoring, page lookup, segment_type classification in segments.js)
 * is unchanged — it already operates on a list of chunk texts, not on
 * how those texts were produced.
 *
 * Does NOT need caching, embeddings, or any LLM call — purely structural,
 * so it stays inside a stateless, dependency-light service.
 */

import { chunkText } from './chunker.js';

const TABLE_ROW_RE = /^\|.*\|\s*$/;
const LIST_ITEM_RE = /^\s*([-*+]|\d+\.)\s+\S/;

/**
 * Partition text into contiguous spans of one kind: 'table', 'list', 'prose'.
 * A table/list span requires >= 2 consecutive matching lines — a single
 * stray line that happens to start/end with '|' (rare, but real markdown
 * can contain a lone pipe in prose) is not enough to call it a table.
 */
function partition(text) {
  const lines = text.split('\n');
  const spans = [];
  let i = 0;
  let cursor = 0; // char offset of the start of lines[i]

  const lineStarts = [];
  {
    let off = 0;
    for (const l of lines) { lineStarts.push(off); off += l.length + 1; }
  }

  while (i < lines.length) {
    const isTableLine = TABLE_ROW_RE.test(lines[i]);
    const isListLine = LIST_ITEM_RE.test(lines[i]);

    if (isTableLine || isListLine) {
      const kind = isTableLine ? 'table' : 'list';
      const test = kind === 'table' ? TABLE_ROW_RE : LIST_ITEM_RE;
      let j = i;
      while (j < lines.length && test.test(lines[j])) j += 1;
      const runLength = j - i;
      if (runLength >= 2) {
        const startOff = lineStarts[i];
        const endOff = j < lines.length ? lineStarts[j] : text.length;
        spans.push({ kind, startLine: i, endLine: j, startOffset: startOff, endOffset: endOff });
        i = j;
        continue;
      }
    }
    // Not the start of a qualifying run: extend or start a 'prose' span.
    if (spans.length && spans[spans.length - 1].kind === 'prose') {
      spans[spans.length - 1].endLine = i + 1;
      spans[spans.length - 1].endOffset = i + 1 < lines.length ? lineStarts[i + 1] : text.length;
    } else {
      spans.push({
        kind: 'prose',
        startLine: i,
        endLine: i + 1,
        startOffset: lineStarts[i],
        endOffset: i + 1 < lines.length ? lineStarts[i + 1] : text.length,
      });
    }
    i += 1;
  }
  return spans;
}

/**
 * Chunk a table span by WHOLE ROWS only, never mid-row.
 *
 * Deliberately does NOT repeat the header/separator row at the top of every
 * chunk after the first. A first version did, for readability — but every
 * segment's offset is found by locating its own text as a literal,
 * forward-only substring of the source (see document-first-ingestion.js's
 * anchor scheme, ported into segments.js). The header text exists exactly
 * ONCE in the real document; repeating it made a later chunk's prefix
 * resolve back to that single earlier occurrence, which is BEFORE the
 * scanning cursor, and the invariant test caught it immediately: "offset
 * went backwards unexpectedly". Correctness of citations/paging outranks
 * a table fragment being self-describing — the header context loss on a
 * mid-table fragment is accepted as a known limitation, not solved here.
 */
function chunkTableRows(rowLines, targetSize, maxSize) {
  const chunks = [];
  let current = [];
  let currentLen = 0;

  const flush = () => {
    if (current.length) chunks.push(current.join('\n'));
    current = [];
    currentLen = 0;
  };

  for (const row of rowLines) {
    if (currentLen + row.length > maxSize && current.length) {
      flush();
    }
    current.push(row);
    currentLen += row.length + 1;
    if (currentLen >= targetSize && currentLen > maxSize * 0.6) {
      // soft target reached at a safe size — still only cut BETWEEN rows
      flush();
    }
  }
  flush();
  return chunks;
}

/**
 * Chunk a list span by WHOLE ITEMS only, never mid-item.
 */
function chunkListItems(itemLines, targetSize, maxSize) {
  const chunks = [];
  let current = [];
  let currentLen = 0;
  for (const item of itemLines) {
    if (currentLen + item.length > maxSize && current.length) {
      chunks.push(current.join('\n'));
      current = [];
      currentLen = 0;
    }
    current.push(item);
    currentLen += item.length + 1;
    if (currentLen >= targetSize) {
      chunks.push(current.join('\n'));
      current = [];
      currentLen = 0;
    }
  }
  if (current.length) chunks.push(current.join('\n'));
  return chunks;
}

/**
 * Atomicity-aware replacement for a single `chunkText(cleanText, opts)`
 * call. Returns the same shape chunkText returns — an array of
 * `{ text, index }` — so segments.js needs no change beyond calling this
 * instead of chunkText directly.
 */
export function chunkTextAtomic(text, opts = {}) {
  const targetSize = opts.targetSize ?? 700;
  const maxSize = opts.maxSize ?? Math.round(targetSize * 1.5);
  const minSize = opts.minSize ?? 200;
  const overlapSize = opts.overlapSize ?? 120;

  const spans = partition(text);
  // { text, kind } pairs, not bare strings — kind carries the span's TRUE
  // type through to segments.js. Without this, a chunk holding exactly one
  // table row (routine on wide/long-field CSVs, where a single row can
  // already exceed targetSize) fails segments.js's own `pipeRows >= 2`
  // table-detection heuristic and gets mislabeled 'paragraph'. Measured on
  // the real 70MB/94,984-segment NYC CSV: 94,675 of 94,984 rows landed
  // one-row-per-chunk and were ALL misclassified before this fix
  // (atomic_segment_ratio read 0.003 instead of ~1.0) — content was intact
  // and findable, but the segmentType metadata was wrong for almost the
  // entire corpus. partition() already knows the span's kind; re-deriving
  // it from chunk text alone throws that information away for no reason.
  const outChunks = [];

  for (const span of spans) {
    const spanText = text.slice(span.startOffset, span.endOffset);
    if (span.kind === 'table') {
      const rowLines = spanText.split('\n').filter((l) => l.length > 0);
      const chunks = chunkTableRows(rowLines, targetSize, maxSize);
      for (const c of chunks) if (c.trim().length >= Math.min(minSize, 20)) outChunks.push({ text: c, kind: 'table' });
    } else if (span.kind === 'list') {
      const itemLines = spanText.split('\n').filter((l) => l.length > 0);
      const chunks = chunkListItems(itemLines, targetSize, maxSize);
      for (const c of chunks) if (c.trim().length >= Math.min(minSize, 20)) outChunks.push({ text: c, kind: 'list' });
    } else {
      // Prose: the UNCHANGED verbatim chunker, exactly as core runs it.
      if (spanText.trim().length < minSize) {
        if (spanText.trim().length > 0) outChunks.push({ text: spanText.trim(), kind: 'prose' });
        continue;
      }
      const proseChunks = chunkText(spanText, { targetSize, maxSize, minSize, overlapSize }) || [];
      for (const c of proseChunks) if (c.text && c.text.trim()) outChunks.push({ text: c.text.trim(), kind: 'prose' });
    }
  }

  return outChunks.map((c, index) => ({ text: c.text, index, kind: c.kind }));
}
