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
 * The legacy chunkText API remains unchanged. This module is a structural
 * pass that partitions prose/tables/lists, then uses the offset-aware
 * chunker for prose and source-line boundaries for tables/lists:
 * partition the document into (prose | table | list) spans, chunk each
 * span with the strategy suited to it, concatenate the resulting chunk
 * ranges in order. Original source offsets travel with each chunk, so
 * downstream evidence locators do not need to rediscover offsets by text.
 *
 * Does NOT need caching, embeddings, or any LLM call — purely structural,
 * so it stays inside a stateless, dependency-light service.
 */

import { chunkTextWithOffsets } from './chunker.js';

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
 * chunk after the first. Repeating source rows would fabricate evidence
 * ranges; consumers can use the original source offsets to inspect nearby
 * header context when needed.
 */
function chunkAtomicLines(rows, targetSize, maxSize) {
  const chunks = [];
  let current = [];
  let currentLen = 0;

  const flush = () => {
    if (current.length) chunks.push({ startOffset: current[0].startOffset, endOffset: current[current.length - 1].endOffset });
    current = [];
    currentLen = 0;
  };

  for (const row of rows) {
    if (currentLen + row.text.length > maxSize && current.length) {
      flush();
    }
    current.push(row);
    currentLen += row.text.length + 1;
    if (currentLen >= targetSize && currentLen > maxSize * 0.6) {
      // soft target reached at a safe size — still only cut BETWEEN rows
      flush();
    }
  }
  flush();
  return chunks;
}

/** Obtain non-empty source lines with exact offsets. */
function sourceLines(text, startOffset, endOffset) {
  const lines = [];
  let cursor = startOffset;
  for (const line of text.slice(startOffset, endOffset).split('\n')) {
    if (line.length) lines.push({ text: line, startOffset: cursor, endOffset: cursor + line.length });
    cursor += line.length + 1;
  }
  return lines;
}

/**
 * Atomicity-aware replacement for a single `chunkText(cleanText, opts)`
 * call. Returns `{ text, index, startOffset, endOffset, kind }` entries;
 * offsets refer to the original source text, not a synthesized chunk.
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
      const rows = sourceLines(text, span.startOffset, span.endOffset);
      const chunks = chunkAtomicLines(rows, targetSize, maxSize);
      for (const range of chunks) {
        const content = text.slice(range.startOffset, range.endOffset);
        if (content.trim().length >= Math.min(minSize, 20)) outChunks.push({ ...range, text: content, kind: 'table' });
      }
    } else if (span.kind === 'list') {
      const items = sourceLines(text, span.startOffset, span.endOffset);
      const chunks = chunkAtomicLines(items, targetSize, maxSize);
      for (const range of chunks) {
        const content = text.slice(range.startOffset, range.endOffset);
        if (content.trim().length >= Math.min(minSize, 20)) outChunks.push({ ...range, text: content, kind: 'list' });
      }
    } else {
      // Keep the legacy chunkText API unchanged; hm-extract uses its source-aware counterpart.
      if (spanText.trim().length < minSize) {
        const content = spanText.trim();
        if (content.length > 0) {
          const leading = spanText.indexOf(content);
          outChunks.push({ text: content, startOffset: span.startOffset + leading,
            endOffset: span.startOffset + leading + content.length, kind: 'prose' });
        }
        continue;
      }
      const proseChunks = chunkTextWithOffsets(spanText, { targetSize, maxSize, minSize, overlapSize }) || [];
      for (const c of proseChunks) if (c.text && c.text.trim()) outChunks.push({
        text: c.text,
        startOffset: span.startOffset + c.start,
        endOffset: span.startOffset + c.end,
        kind: 'prose',
      });
    }
  }

  return outChunks.map((c, index) => ({ ...c, index }));
}
