/**
 * hm-extract — stateless bytes-in/segments-out document extraction.
 * See .claude/decision-docs/HM_EXTRACT_PLAN.md (main repo) for the full
 * design and why. This file wires: multipart upload -> anydoc -> strip page
 * markers -> semantic chunk -> segment objects -> JSON response.
 *
 * NEVER receives orgId/userId/scope. NEVER persists anything. NEVER logs
 * file bytes or extracted text — only size/format/timing/error code.
 */

import express from 'express';
import multer from 'multer';
import { toMarkdownBytes, formatFromBytes, formatFromExtension } from '@firecrawl/anydoc';
import { stripPageMarkers } from './strip-page-markers.js';
import { buildSegments, sanitizeDocument, computeStructuralDensity } from './segments.js';
import { collapseLetterSpacing } from './collapse-letter-spacing.js';
import { mapConvertError, tooLargeError } from './errors.js';

const PORT = Number(process.env.PORT || 8088);
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 100);
const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024;
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 30_000);
// Admission control (HM_EXTRACT_PLAN.md §2). libuv's thread pool is the real
// concurrency lever for anydoc's Node binding; UV_THREADPOOL_SIZE must be set
// in the container env, not computed here. This cap is the ADMISSION queue
// depth on top of it — beyond it we 429 rather than let requests silently
// queue and degrade every in-flight request's latency together.
const MAX_INFLIGHT = Number(process.env.MAX_INFLIGHT || (Number(process.env.UV_THREADPOOL_SIZE || 4) + 8));
// Memory-budget admission control — the count-based MAX_INFLIGHT alone does
// NOT prevent an OOM: it caps how many requests run concurrently, not how
// much memory they cost. A first version of this gate budgeted on RAW
// upload bytes (200MB) — that undercounted the real cost by ~20x and still
// let a 2GB container OOM: a 74MB CSV upload measures ~1.4-1.6GB peak RSS
// to actually process (buffer + parsed markdown + 94,984 segment objects +
// response serialization all alive at once — see README's "Memory sizing"
// note), so budgeting on the 74MB upload size instead of the ~1.5GB it
// actually costs let 2+ large files process concurrently and exceed any
// real container's memory. MEMORY_BLOWUP_FACTOR converts an upload's raw
// byte count into an ESTIMATED peak-memory cost before comparing against
// the budget. Both numbers are measured, not guessed — tune via env if a
// different anydoc version or workload changes the ratio.
const MEMORY_BLOWUP_FACTOR = Number(process.env.MEMORY_BLOWUP_FACTOR || 20);
// Default assumes at least a 2GB container with ~300MB reserved for
// Node/V8 baseline + the process's own working set outside request
// handling — leaves ~1.2GB of budget. Set MAX_INFLIGHT_MEMORY_BYTES
// explicitly to match your actual container's --memory limit.
const MAX_INFLIGHT_MEMORY_BYTES = Number(process.env.MAX_INFLIGHT_MEMORY_BYTES || (1200 * 1024 * 1024));

/**
 * Stream the /extract response instead of res.json(bigObject).
 *
 * res.json() calls JSON.stringify() on the WHOLE response object first,
 * materializing one contiguous string before a single byte is sent. For a
 * large document that string alone was ~280MB (measured: 70MB/94,984-row
 * CSV) — on top of the buffer, markdown, and segments array already in
 * memory, that pushed container RSS to ~1.6GB and OOM-killed it once under
 * load (see README's "Memory sizing" note). `markdown` and `text` are
 * identical content (see errors.js's contract, HM_EXTRACT_SPEC.md:80-81
 * requires both), so stringify-then-concat was ALSO paying to serialize the
 * same ~83MB string twice into that one buffer.
 *
 * This writes each field as its own chunk directly to the socket. Peak
 * additional memory becomes "one field's JSON.stringify at a time"
 * (~83MB for the biggest single field) instead of "the entire response
 * as one string" (~280MB) — cut the single largest allocation in the
 * request path without changing the wire format at all; a client reading
 * the full response sees byte-identical JSON either way.
 */
function writeExtractResponse(res, {
  engine, format, chars, markdown, text, pageMarks, segments, structuralDensity, timings,
}) {
  res.status(200);
  res.set('Content-Type', 'application/json');
  res.write('{"ok":true');
  res.write(`,"engine":${JSON.stringify(engine)}`);
  res.write(`,"format":${JSON.stringify(format)}`);
  res.write(`,"chars":${chars}`);
  res.write(`,"markdown":${JSON.stringify(markdown)}`);
  res.write(`,"text":${JSON.stringify(text)}`);
  res.write(`,"page_marks":${JSON.stringify(pageMarks)}`);
  res.write(',"segments":[');
  for (let i = 0; i < segments.length; i += 1) {
    if (i > 0) res.write(',');
    res.write(JSON.stringify(segments[i]));
  }
  res.write(']');
  res.write(`,"structural_density":${JSON.stringify(structuralDensity)}`);
  res.write(`,"timings":${JSON.stringify(timings)}`);
  res.end('}');
}

const SUPPORTED_FORMATS = [
  'doc', 'docx', 'docm', 'ppt', 'pps', 'pot', 'pptx', 'pptm', 'ppsx', 'ppsm',
  'xls', 'xlsx', 'xlsm', 'xlsb', 'odt', 'ods', 'odp', 'rtf', 'epub', 'csv', 'pdf',
];

// Formats that are ALREADY plain text/markdown — anydoc's job (bytes -> markdown)
// is a no-op for these, so skip it entirely rather than round-trip through a
// converter that has nothing to convert. Everything downstream (letter-spacing
// repair, sanitize, page-marker strip, atomic chunking, segment build) is
// unchanged — this only replaces the parse step, not the pipeline after it.
const TEXT_PASSTHROUGH_FORMATS = ['md', 'markdown', 'txt'];

let inFlight = 0;
let inFlightMemoryEstimate = 0;
const startedAt = Date.now();

const app = express();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES },
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    version: process.env.npm_package_version || '0.1.0',
    uptime_s: Math.round((Date.now() - startedAt) / 1000),
    in_flight: inFlight,
    max_inflight: MAX_INFLIGHT,
    in_flight_memory_estimate: inFlightMemoryEstimate,
    max_inflight_memory: MAX_INFLIGHT_MEMORY_BYTES,
    memory_blowup_factor: MEMORY_BLOWUP_FACTOR,
  });
});

app.get('/formats', (req, res) => {
  res.json({ formats: SUPPORTED_FORMATS, text_passthrough: TEXT_PASSTHROUGH_FORMATS });
});

app.post('/extract', (req, res, next) => {
  // Admission control BEFORE multer even buffers the body — a request past
  // the cap should never pay for upload bandwidth it will be rejected after.
  if (inFlight >= MAX_INFLIGHT) {
    res.set('Retry-After', '2');
    return res.status(429).json({ ok: false, code: 'busy', detail: `in_flight=${inFlight} max=${MAX_INFLIGHT}` });
  }
  // Memory-budget gate MUST also run here, before multer, not after.
  // multer's memoryStorage buffers the ENTIRE request body into memory as
  // soon as its middleware runs, regardless of what any later gate decides
  // — checking the budget only after upload.single('file') (a first
  // version of this did exactly that) means every concurrent large upload
  // already paid its full memory cost before being told no. Content-Length
  // is a pre-buffer estimate of the upload (multipart adds some
  // boundary/header overhead on top of the real file size) — multiplied by
  // MEMORY_BLOWUP_FACTOR to estimate actual PROCESSING cost, not raw bytes
  // (see that constant's comment for why raw-byte budgeting under-counted
  // by ~20x and still let a 2GB container OOM). Released in `finally` via
  // `req._reservedMemoryEstimate`, on every exit path.
  const estimatedUploadBytes = Number(req.headers['content-length'] || 0);
  const estimatedMemory = estimatedUploadBytes * MEMORY_BLOWUP_FACTOR;
  if (estimatedUploadBytes > 0 && inFlightMemoryEstimate > 0
      && inFlightMemoryEstimate + estimatedMemory > MAX_INFLIGHT_MEMORY_BYTES) {
    res.set('Retry-After', '2');
    return res.status(429).json({
      ok: false, code: 'busy',
      detail: `in_flight_memory_estimate=${inFlightMemoryEstimate} would_add=~${estimatedMemory} max=${MAX_INFLIGHT_MEMORY_BYTES}`,
    });
  }
  if (estimatedUploadBytes > 0) inFlightMemoryEstimate += estimatedMemory;
  req._reservedMemoryEstimate = estimatedMemory; // released in the handler's `finally`, whatever this request's outcome
  next();
}, upload.single('file'), async (req, res) => {
  inFlight += 1;
  const t0 = Date.now();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (!res.headersSent) {
      res.status(504).json({ ok: false, code: 'resource_limit', detail: `parse exceeded ${REQUEST_TIMEOUT_MS}ms` });
    }
  }, REQUEST_TIMEOUT_MS);

  try {
    // NOTE: `inFlight`/`inFlightMemoryEstimate` are decremented in EXACTLY
    // ONE place — the `finally` block at the bottom of this handler. Every
    // early return below just `return`s; it must NEVER also decrement
    // here. A prior version of this file decremented both here AND in
    // `finally`, double-counting every early exit (missing_part /
    // too-large / unsupported) — that is the exact root cause of the
    // negative `in_flight` values seen in production health checks. The
    // memory budget was already reserved (via Content-Length ×
    // MEMORY_BLOWUP_FACTOR) in the pre-multer middleware above and is
    // released below via `req._reservedMemoryEstimate`, on every exit
    // path, unconditionally.
    if (!req.file) {
      clearTimeout(timer);
      return res.status(400).json({ ok: false, code: 'missing_part', detail: 'no file field in multipart body' });
    }
    const filename = String(req.body?.filename || req.file.originalname || 'upload');
    const buf = req.file.buffer;

    if (buf.length > MAX_FILE_BYTES) {
      clearTimeout(timer);
      return res.status(422).json(tooLargeError(buf.length, MAX_FILE_BYTES));
    }

    const targetSize = req.body?.target_size ? Number(req.body.target_size) : undefined;
    const overlap = req.body?.overlap ? Number(req.body.overlap) : undefined;

    const ext = (filename.split('.').pop() || '').toLowerCase();
    const isTextPassthrough = TEXT_PASSTHROUGH_FORMATS.includes(ext);

    // Content-based detection first (PDF header, RTF open group, OLE stream
    // names, ZIP mimetype) — mislabeled extensions still convert correctly.
    // CSV has no content marker (verified empirically: formatFromBytes
    // returns null for a real CSV), so extension is the required fallback,
    // exactly as anydoc's own docs say. This is BYTES in, never a disk path —
    // hm-extract is stateless and must never write the upload to disk.
    // Skipped entirely for text passthrough — there is no anydoc format to
    // detect for something that is already markdown/plain text.
    const detected = isTextPassthrough ? ext : (formatFromBytes(buf) || formatFromExtension(ext) || null);
    if (!detected) {
      clearTimeout(timer);
      return res.status(422).json({
        ok: false, code: 'unsupported',
        detail: `could not detect format from content or filename "${filename}"`,
      });
    }

    const tParseStart = Date.now();
    // Text/markdown bytes decode straight to UTF-8 — no anydoc call. Every
    // other format still goes through anydoc's Rust conversion exactly as
    // before; this branch changes NOTHING about that path.
    const markdown = isTextPassthrough ? buf.toString('utf-8') : await toMarkdownBytes(buf, detected);
    const parseMs = Date.now() - tParseStart;

    if (timedOut) return; // response already sent by the timeout handler

    const tChunkStart = Date.now();
    // ORDER MATTERS: every cleanup that can REMOVE characters must run
    // BEFORE stripPageMarkers computes its position map, or a mark's `at`
    // offset points into text that no longer exists at that length once the
    // later cleanup runs. Caught in testing: sanitizeDocument's replacement-
    // character strip ran AFTER mark computation, so any `�` run
    // preceding a page marker silently shifted every mark after it.
    // collapseLetterSpacing (repairs letter-spaced titles) and
    // sanitizeDocument (strips control/replacement chars — see its own
    // comment for the real 52-page-PDF failure this prevents) both run
    // first; stripPageMarkers computes marks against the FINAL text, so
    // chunk offsets and page marks share one coordinate system with no
    // possibility of drift between them.
    const repaired = collapseLetterSpacing(markdown);
    const sanitized = sanitizeDocument(repaired);
    const { text: cleanText, marks: pageMarks } = stripPageMarkers(sanitized);
    const segments = buildSegments(cleanText, pageMarks, { targetSize, overlapSize: overlap });
    const structuralDensity = computeStructuralDensity(segments, cleanText.length);
    const chunkMs = Date.now() - tChunkStart;

    clearTimeout(timer);
    if (timedOut) return;

    console.log(JSON.stringify({
      route: 'extract', format: detected, size_bytes: buf.length,
      parse_ms: parseMs, chunk_ms: chunkMs, segments: segments.length,
      chars: cleanText.length, chars_per_heading: structuralDensity.chars_per_heading,
      atomic_ratio: structuralDensity.atomic_segment_ratio, ok: true,
    }));

    writeExtractResponse(res, {
      engine: isTextPassthrough ? 'passthrough' : 'anydoc',
      format: detected,
      chars: cleanText.length,
      markdown: cleanText,
      text: cleanText,
      pageMarks,
      segments,
      structuralDensity,
      timings: { parse_ms: parseMs, chunk_ms: chunkMs, total_ms: Date.now() - t0 },
    });
  } catch (err) {
    clearTimeout(timer);
    if (timedOut) { /* already responded */ }
    else {
      const body = mapConvertError(err);
      console.log(JSON.stringify({
        route: 'extract', ok: false, code: body.code, size_bytes: req.file?.buffer?.length || 0,
        ms: Date.now() - t0,
      }));
      res.status(422).json(body);
    }
  } finally {
    inFlight -= 1;
    inFlightMemoryEstimate -= (req._reservedMemoryEstimate || 0);
  }
});

// multer errors (e.g. file too large per its own limits) land here, not in
// the route handler above.
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(422).json(tooLargeError(MAX_FILE_BYTES + 1, MAX_FILE_BYTES));
  }
  console.log(JSON.stringify({ route: 'error_middleware', message: String(err?.message || err).slice(0, 200) }));
  res.status(500).json({ ok: false, code: 'internal', detail: 'unexpected error' });
});

app.listen(PORT, () => {
  console.log(JSON.stringify({ event: 'listening', port: PORT, max_inflight: MAX_INFLIGHT, max_file_mb: MAX_FILE_MB }));
});
