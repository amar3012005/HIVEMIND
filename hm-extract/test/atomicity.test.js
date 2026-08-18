/**
 * Regression tests for the atomicity fix (atomic-blocks.js) and the
 * structural_density contract field. These codify manual verifications
 * done during development so they are repeatable, not one-off checks:
 *   - a real 70MB/95,291-row CSV: zero mid-row splits, exact row-count
 *     preservation (measured before this test existed: 138,505 bloated
 *     segments -> 94,984 clean ones, zero data loss)
 *   - legacy binary formats (.doc/.xls/.ppt) from the Apache POI test
 *     corpus — the format-support gap the whole project started from
 *   - structural_density is present and behaves sanely
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.HM_EXTRACT_URL || 'http://localhost:8199';
const EVAL_DIR = process.env.ANYDOC_EVAL_DIR || `${process.env.HOME}/anydoc-eval`;

async function extract(filePath, filename) {
  const buf = fs.readFileSync(filePath);
  const form = new FormData();
  form.append('file', new Blob([buf]), filename);
  form.append('filename', filename);
  const res = await fetch(`${BASE}/extract`, { method: 'POST', body: form });
  return { status: res.status, body: await res.json() };
}

/**
 * Poll /health until the server reports a clean baseline (no in-flight
 * requests, no reserved memory budget) before a test that assumes one.
 *
 * Needed because this file and golden.test.js exercise the SAME live
 * server process's admission-control counters as shared global state.
 * Node's test runner does not guarantee one file's requests have fully
 * drained before another file's tests start firing — measured directly:
 * running both files together produced spurious 429s here (this file's
 * requests rejected by residual load from golden.test.js's own
 * concurrent-upload admission-control test, still draining when these
 * tests started), even with `--test-concurrency=1`. That flag limits
 * concurrency WITHIN a file's tests, not scheduling BETWEEN files sharing
 * one external process — so the fix belongs here, not in how the suite is
 * invoked.
 */
async function waitForIdle(timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const health = await (await fetch(`${BASE}/health`)).json();
    if (health.in_flight === 0 && health.in_flight_memory_estimate === 0) return health;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server did not return to idle within ${timeoutMs}ms — check for a stuck request`);
}

test('constructed table: no chunk ever contains a mid-row line', async () => {
  const header = '| ID | Name | City |\n| --- | --- | --- |';
  const rows = Array.from({ length: 40 }, (_, i) =>
    `| ${i} | Person ${i} with a fairly long name field here | SomeCity${i} |`).join('\n');
  const doc = `Intro prose paragraph before the table.\n\n${header}\n${rows}\n\nOutro prose after the table.`;

  const form = new FormData();
  form.append('file', new Blob([Buffer.from(doc)]), 'synthetic.csv');
  form.append('filename', 'synthetic.csv');
  // csv has no content-based signature (verified empirically against anydoc),
  // extension is required — matches the real /extract contract, not a shortcut.
  const res = await fetch(`${BASE}/extract`, { method: 'POST', body: form });
  const body = await res.json();
  assert.equal(res.status, 200);

  let midRow = 0;
  for (const seg of body.segments) {
    for (const line of seg.content.split('\n')) {
      if (line.startsWith('|') && !line.trimEnd().endsWith('|')) midRow += 1;
    }
  }
  assert.equal(midRow, 0, 'a table row was split mid-line across a chunk boundary');
});

test('real 70MB CSV: exhaustive row integrity (not sampled)', async () => {
  await waitForIdle();
  const csvPath = path.join(EVAL_DIR, 'web-corpus', 'nyc_data.csv');
  if (!fs.existsSync(csvPath)) { console.log('  (skipped: large CSV fixture not present)'); return; }

  const { status, body } = await extract(csvPath, 'nyc_data.csv');
  assert.equal(status, 200);
  assert.ok(body.ok);

  const rawRows = body.markdown.split('\n').filter((l) => l.startsWith('|') && l.trim().endsWith('|'));
  let midRowLines = 0;
  let totalRowLinesInSegments = 0;
  for (const seg of body.segments) {
    if (!seg.content.startsWith('|')) continue;
    for (const line of seg.content.split('\n')) {
      if (!line.trim()) continue;
      totalRowLinesInSegments += 1;
      if (line.startsWith('|') && !line.trimEnd().endsWith('|')) midRowLines += 1;
    }
  }
  console.log(`  raw rows=${rawRows.length} segments=${body.segments.length} row-lines-in-segments=${totalRowLinesInSegments}`);
  assert.equal(midRowLines, 0, 'exhaustive check found a mid-row split');
  assert.equal(totalRowLinesInSegments, rawRows.length, 'row count drifted between raw markdown and segments — data lost or duplicated');
});

const LEGACY_FIXTURES = [
  { file: 'web_sample.doc', expect: 'I am a test document' },
  { file: 'web_sample.xls', expect: null }, // numeric-only sheet; presence of segments is the assertion
  { file: 'web_sample.ppt', expect: 'Title of the first slide' },
];

for (const { file, expect } of LEGACY_FIXTURES) {
  test(`legacy binary format: ${file}`, async () => {
    const p = path.join(EVAL_DIR, 'web-corpus', file);
    if (!fs.existsSync(p)) { console.log(`  (skipped: ${file} fixture not present)`); return; }
    const { status, body } = await extract(p, file);
    assert.equal(status, 200, `expected 200 for legacy format ${file}`);
    assert.ok(body.ok);
    assert.ok(body.segments.length >= 1, `${file} produced zero segments`);
    if (expect) assert.ok(body.markdown.includes(expect), `${file} missing expected content "${expect}"`);
  });
}

test('structural_density: present, and distinguishes heading-dense vs heading-sparse documents', async () => {
  // .md is anydoc's OUTPUT format, not an input format it accepts (Word,
  // PowerPoint, Excel, OpenDocument, RTF, EPUB, CSV, PDF only — verified:
  // a first version of this test used .md and got a correct 422
  // unsupported, which was this test's bug, not the server's). RTF is a
  // real supported input and trivial to hand-construct.
  //
  // RTF's own heading concept does not surface as markdown `#` — verified
  // empirically: `{\rtf1\ansi SECTION ONE\par prose\par}` converts to plain
  // "SECTION ONE\n\nprose", no `#`. segments.js's fallback heading heuristic
  // (an isolated, short, ALL-CAPS or Title-Case line) is exactly what
  // exists for this case, so the test uses ALL-CAPS section markers rather
  // than assuming `#` would appear.
  const rtf = (paragraphs) => `{\\rtf1\\ansi ${paragraphs.join('\\par ')}}`;

  const denseParas = [];
  for (let i = 0; i < 8; i += 1) {
    denseParas.push(`SECTION ${i}`, `Some prose about topic ${i} that goes on for a little while so the paragraph is not trivially short.`);
  }
  const dense = rtf(denseParas);

  // Deliberately made LONGER than the dense document, not shorter — the
  // point being tested is that a document with headings amortizes its
  // length across landmarks (low chars_per_heading), while a heading-less
  // document's ENTIRE length counts as a single unindexed span. Making
  // sparse shorter than dense would let the comparison pass or fail for
  // the wrong reason (relative document length) rather than the actual
  // property (presence of structural landmarks) this test exists to check.
  const sparse = rtf([
    ('One single long flowing paragraph of unstructured prose that never isolates a short capitalised line of its own, '
      + 'repeating similar phrasing several times over so the document has real length without any section markers at all, '
      + 'over and over, several times, at length, without any headings anywhere in this text, on and on, at length again. ').repeat(6),
  ]);

  const results = {};
  for (const [name, content] of [['dense.rtf', dense], ['sparse.rtf', sparse]]) {
    const form = new FormData();
    form.append('file', new Blob([Buffer.from(content)]), name);
    form.append('filename', name);
    const res = await fetch(`${BASE}/extract`, { method: 'POST', body: form });
    const body = await res.json();
    assert.equal(res.status, 200, `${name}: expected 200, got ${res.status}: ${JSON.stringify(body).slice(0, 150)}`);
    assert.ok(body.structural_density, `${name}: structural_density missing from response`);
    assert.ok(typeof body.structural_density.chars_per_heading === 'number');
    results[name] = body.structural_density;
    console.log(`  ${name}: ${JSON.stringify(body.structural_density)}`);
  }

  assert.ok(results['dense.rtf'].heading_count > 0, 'dense.rtf should have detected at least one heading');
  assert.ok(
    results['dense.rtf'].chars_per_heading < results['sparse.rtf'].chars_per_heading,
    'a heading-dense document should have a LOWER chars_per_heading than a heading-sparse one',
  );
});

test('text passthrough: .md/.txt skip anydoc entirely (parse_ms=0, engine=passthrough)', async () => {
  await waitForIdle();
  const md = '# A Title\n\nSome prose under the title.\n\n## A Subsection\n\nMore prose here.\n';
  const form = new FormData();
  form.append('file', new Blob([Buffer.from(md)]), 'note.md');
  form.append('filename', 'note.md');
  const res = await fetch(`${BASE}/extract`, { method: 'POST', body: form });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.engine, 'passthrough', 'md should bypass anydoc, not go through it silently');
  assert.equal(body.format, 'md');
  assert.equal(body.timings.parse_ms, 0, 'passthrough must not spend time in a parse step that never ran');
  assert.ok(body.segments.length >= 1);
  assert.equal(body.segments[0].metadata.heading, 'A Title');
});

test('real README.md through the running service', async () => {
  const p = path.join(process.env.HOME, 'hm-extract', 'README.md');
  if (!fs.existsSync(p)) { console.log('  (skipped: README.md not present)'); return; }
  const { status, body } = await extract(p, 'README.md');
  assert.equal(status, 200);
  assert.equal(body.engine, 'passthrough');
  assert.ok(body.segments.length > 0);
});

test('in_flight never goes negative across early-return error paths (regression)', async () => {
  await waitForIdle();
  // A prior version decremented `inFlight` at each early `return` AND again
  // in the handler's `finally` block — double-decrementing on every
  // missing_part/too-large/unsupported response. Caught in production via
  // `/health` reporting `in_flight: -2`. Fire several of those error paths
  // back-to-back and confirm the counter never drops below 0.
  await fetch(`${BASE}/extract`, { method: 'POST', body: new FormData() }); // missing_part
  const badForm = new FormData();
  badForm.append('file', new Blob([Buffer.from('x')]), 'x.zzz');
  badForm.append('filename', 'x.zzz');
  await fetch(`${BASE}/extract`, { method: 'POST', body: badForm }); // unsupported
  const health = await (await fetch(`${BASE}/health`)).json();
  assert.ok(health.in_flight >= 0, `in_flight went negative: ${health.in_flight}`);
  assert.equal(health.in_flight, 0, 'in_flight should settle back to 0 once both requests finish');
});

test('memory-budget admission control: concurrent large files get 429, a lone large file does not', async () => {
  const health = await waitForIdle();
  const maxMemory = health.max_inflight_memory;
  const blowup = health.memory_blowup_factor;
  const csvPath = path.join(EVAL_DIR, 'web-corpus', 'nyc_data.csv');
  if (!fs.existsSync(csvPath) || !maxMemory || !blowup) {
    console.log('  (skipped: large CSV fixture or memory-budget health fields not present)');
    return;
  }
  const buf = fs.readFileSync(csvPath);
  // Budgeting on ESTIMATED PROCESSING memory (upload bytes x blowup
  // factor), not raw upload bytes — a raw-byte budget under-measured real
  // cost by ~20x and still let a 2GB container OOM (see server.js's
  // MEMORY_BLOWUP_FACTOR comment). With the real measured ratio, one
  // 74MB CSV's estimated cost already approaches or exceeds the default
  // budget on its own, so just 2 concurrent copies is enough to prove the
  // gate — no need to fire a burst large enough to itself become a load
  // test (that was this test's own first version, and it OOM-killed the
  // very container it was trying to protect).
  const copies = Math.max(2, Math.ceil(maxMemory / (buf.length * blowup)) + 1);
  const fire = () => {
    const form = new FormData();
    form.append('file', new Blob([buf]), 'nyc_data.csv');
    form.append('filename', 'nyc_data.csv');
    return fetch(`${BASE}/extract`, { method: 'POST', body: form });
  };
  const responses = await Promise.all(Array.from({ length: copies }, fire));
  const statuses = responses.map((r) => r.status);
  assert.ok(statuses.includes(429), `expected at least one 429 under concurrent large-file load, got: ${statuses}`);
  assert.ok(statuses.includes(200), `expected at least one 200 to still succeed, got: ${statuses}`);
});
