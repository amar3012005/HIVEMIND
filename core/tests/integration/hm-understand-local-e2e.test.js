import test from 'node:test';
import assert from 'node:assert/strict';

const serviceUrl = process.env.HM_UNDERSTAND_URL;
const parserUrl = process.env.DOCLING_URL;
const extractUrl = process.env.KB_EXTRACT_URL;

const assistedTestText = 'Project Atlas is an internal launch program. '
  + 'The board approved a EUR 12000 budget for Project Atlas on 22 September 2026. '
  + 'The initiative will begin after review. '
  + 'This background paragraph explains the wider operating context without adding a decision or a number. '
  + 'The company stores source documents separately so citations remain available.';

test('live hm-extract segments persist in Core and reach the hm-understand contract unchanged', {
  skip: !extractUrl && 'set KB_EXTRACT_URL to run the local parser-to-analyzer contract canary',
}, async () => {
  const [{ parseWithHmExtract }, { DocumentFirstIngestionService },
    { HmUnderstandAdapter, hmUnderstandBlocksFromSegments }] = await Promise.all([
    import('../../src/knowledge/enterprise/hm-extract-adapter.js'),
    import('../../src/knowledge/document-first-ingestion.js'),
    import('../../src/knowledge/enterprise/hm-understand-adapter.js'),
  ]);
  const source = 'On 22 September 2026, Rama approved a EUR 12000 budget for Project Atlas.';
  const parsed = await parseWithHmExtract(Buffer.from(String.raw`{\rtf1\ansi ${source}}`), 'contract.rtf', {
    baseUrl: extractUrl,
  });
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  assert.ok(parsed.sourceSegments.length > 0);
  for (const segment of parsed.sourceSegments) {
    assert.equal(parsed.text.slice(segment.startOffset, segment.endOffset), segment.content);
  }

  const evidenceRows = [];
  const ingestion = Object.create(DocumentFirstIngestionService.prototype);
  ingestion.db = { knowledgeSegment: { create: async ({ data }) => {
    const row = { ...data, id: `local-evidence-${evidenceRows.length + 1}` };
    evidenceRows.push(row);
    return row;
  } } };
  ingestion.logger = { warn() {} };
  const persisted = await ingestion._createSegments({
    documentId: 'local-contract-doc', userId: 'local-contract-user', orgId: 'local-contract-org',
    parseResult: { success: true, text: parsed.text, metadata: { hmExtractSegments: parsed.sourceSegments } },
    docScope: { sourceId: 'local-contract-source', scope: 'organization' },
  });
  assert.equal(persisted.length, parsed.sourceSegments.length);
  assert.equal(evidenceRows.length, parsed.sourceSegments.length);
  assert.ok(persisted.every((segment) => parsed.text.slice(segment.startOffset, segment.endOffset) === segment.content));

  let received;
  const analyzer = new HmUnderstandAdapter({
    baseUrl: 'http://hm-understand.contract',
    fetchImpl: async (_url, options) => {
      received = JSON.parse(options.body);
      return new Response(JSON.stringify({ schema_version: '1', complete: true,
        blocks: received.blocks.map((block) => ({ block_id: block.id, mentions: [], candidates: [] })) }),
      { status: 200 });
    },
  });
  const analyzed = await analyzer.analyze({
    source: { id: 'local-contract-doc', revision: 'fixture-v1' },
    blocks: hmUnderstandBlocksFromSegments(persisted),
  });
  assert.equal(analyzed.ok, true);
  assert.deepEqual(received.blocks.map((block) => block.text), persisted.map((segment) => segment.content));
  assert.ok(received.blocks.every((block) => parsed.text.slice(block.source_start, block.source_end) === block.text));
});

function syntheticPdf(text) {
  const escaped = text.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
  const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET\n`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
    + `${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`
    + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(body, 'binary');
}

async function parseWithDocling(url, filename, body, mediaType) {
  const form = new FormData();
  form.append('files', new Blob([body], { type: mediaType }), filename);
  form.append('to_formats', 'md');
  const response = await fetch(`${url.replace(/\/+$/, '')}/v1/convert/file`, { method: 'POST', body: form });
  assert.equal(response.ok, true, `Docling returned HTTP ${response.status} for ${filename}`);
  const result = await response.json();
  assert.equal(result.status, 'success', `Docling did not parse ${filename}`);
  assert.ok(result.document?.md_content, `Docling returned no Markdown for ${filename}`);
  return result.document.md_content;
}

test('local PDF/CSV parsing flows through Core ingestion hook to hm-understand shadow receipt', {
  skip: (!serviceUrl || !parserUrl) && 'set HM_UNDERSTAND_URL and DOCLING_URL to run local parser/Core integration',
}, async () => {
  process.env.DATABASE_URL ||= 'postgresql://hivemind:localtest@127.0.0.1:5432/test?schema=hivemind';
  process.env.MNEME_AGENT_REGISTRY_FILE ||= '/nonexistent';

  const [{ DocumentFirstIngestionService }, { HmUnderstandAdapter, createHmUnderstandShadowAnalyzer }] = await Promise.all([
    import('../../src/knowledge/document-first-ingestion.js'),
    import('../../src/knowledge/enterprise/hm-understand-adapter.js'),
  ]);
  const writes = [];
  const adapter = new HmUnderstandAdapter({ baseUrl: serviceUrl, timeoutMs: 30_000, logger: { warn() {} } });
  const analyzer = createHmUnderstandShadowAnalyzer({
    flagClient: { hmUnderstandModeFor: async () => 'shadow' }, adapter,
    logger: { warn() {} },
  });
  const service = new DocumentFirstIngestionService({
    db: { knowledgeDocument: { updateMany: async (query) => writes.push(query) } },
    smartIngestRouter: null,
    memoryGraphEngine: null,
    doclingAdapter: null,
    embeddingService: null,
    understandAnalyzer: analyzer,
    logger: { info() {}, warn() {} },
  });
  const pdfText = await parseWithDocling(
    parserUrl, 'synthetic.pdf',
    syntheticPdf('Rama approved a 12000 EUR budget for Project Atlas on 22 September 2026.'),
    'application/pdf',
  );
  const csvText = await parseWithDocling(
    parserUrl, 'budget.csv',
    'owner,project,status\nNora Klein,Project Atlas,pending approval\n',
    'text/csv',
  );
  assert.match(pdfText, /Rama/);
  assert.match(csvText, /Nora Klein/);
  const segments = [
    {
      id: 'page-1',
      content: pdfText,
      startPage: 1,
      segmentIndex: 0,
      metadata: { language: 'en', heading_path: ['Decisions'] },
    },
    {
      id: 'sheet-row-7',
      content: csvText,
      segmentIndex: 1,
      metadata: { language: 'en', sheet: 'Budget', row: 7 },
    },
  ];

  const result = await service._runHmUnderstandShadow({
    userId: 'synthetic-user', orgId: 'synthetic-org', documentId: 'synthetic-document',
    sourceRevision: 'fixture-v1', filename: 'synthetic.pdf', segments, parseMetadata: { parser: 'fixture' },
  });

  assert.equal(result?.receipt?.status, 'complete');
  assert.equal(result?.receipt?.totals?.blocks, 2);
  assert.ok(result?.receipt?.totals?.mentions > 0);
  assert.equal(result?.analysis, null);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].where, {
    id: 'synthetic-document', userId: 'synthetic-user', orgId: 'synthetic-org',
  });
  const persisted = JSON.stringify(writes[0].data.parseMetadata.hm_understand_shadow);
  assert.equal(persisted.includes('Rama'), false);
  assert.equal(persisted.includes('Nora Klein'), false);
  assert.equal(persisted.includes('€12,000'), false);
  assert.equal(persisted.includes('accepted_items'), false);
  assert.equal(persisted.includes('refinement_required_blocks'), true);
  assert.equal(persisted.includes('Rama approved'), false);
  assert.equal(persisted.includes('"persisted_content":false'), true);
});

test('local RTF parsing through hm-extract reaches hm-understand with evidence intact', {
  skip: (!serviceUrl || !extractUrl) && 'set HM_UNDERSTAND_URL and KB_EXTRACT_URL for the local parser chain',
}, async () => {
  const [{ parseWithHmExtract }, { DocumentFirstIngestionService },
    { HmUnderstandAdapter, createHmUnderstandShadowAnalyzer },
    { runHmUnderstandShadow }] = await Promise.all([
    import('../../src/knowledge/enterprise/hm-extract-adapter.js'),
    import('../../src/knowledge/document-first-ingestion.js'),
    import('../../src/knowledge/enterprise/hm-understand-adapter.js'),
    import('../../src/knowledge/enterprise/hm-understand-shadow.js'),
  ]);
  const sourceText = 'On 22 September 2026, Rama approved a EUR 12000 budget for Project Atlas.';
  const parsed = await parseWithHmExtract(Buffer.from(String.raw`{\rtf1\ansi ${sourceText}}`), 'synthetic.rtf');
  assert.equal(parsed.ok, true);
  assert.match(parsed.text, /Rama/);
  assert.match(parsed.text, /12000/);
  assert.ok(parsed.sourceSegments?.length > 0, 'hm-extract should return its canonical atomic evidence segments');

  const persisted = [];
  const ingestion = new DocumentFirstIngestionService({
    db: { knowledgeSegment: { create: async ({ data }) => {
      const row = { ...data, id: `rtf-segment-${persisted.length + 1}` };
      persisted.push(row);
      return row;
    } } },
    smartIngestRouter: null, memoryGraphEngine: null, doclingAdapter: null, embeddingService: null,
    logger: { info() {}, warn() {} },
  });
  const coreSegments = await ingestion._createSegments({
    documentId: 'synthetic-rtf', userId: 'synthetic-user', orgId: 'synthetic-org',
    parseResult: { success: true, text: parsed.text, metadata: { hmExtractSegments: parsed.sourceSegments } },
    docScope: { sourceId: 'rtf-source', scope: 'organization' },
  });
  assert.equal(coreSegments.length, parsed.sourceSegments.length);
  assert.ok(coreSegments.every((segment) => Number.isInteger(segment.startOffset)
    && parsed.text.slice(segment.startOffset, segment.endOffset) === segment.content));

  const adapter = new HmUnderstandAdapter({ baseUrl: serviceUrl, timeoutMs: 30_000, logger: { warn() {} } });
  let observed;
  const shadowAnalyzer = createHmUnderstandShadowAnalyzer({
    flagClient: { hmUnderstandModeFor: async () => 'shadow' }, adapter, logger: { warn() {} },
  });
  const analyzer = async (input) => {
    observed = await shadowAnalyzer(input);
    return observed;
  };
  const writes = [];
  const run = await runHmUnderstandShadow({
    analyzer,
    db: { knowledgeDocument: { updateMany: async (query) => writes.push(query) } },
    logger: { info() {}, warn() {} },
    userId: 'synthetic-user', orgId: 'synthetic-org', documentId: 'synthetic-rtf',
    sourceRevision: 'fixture-v1', filename: 'synthetic.rtf',
    segments: coreSegments.map((segment) => ({ ...segment,
      metadata: { ...segment.metadata, language: 'en' } })),
  });

  assert.equal(run.receipt.status, 'complete');
  assert.equal(run.analysis, null, 'shadow mode must not return candidate text to persistence');
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].where, {
    id: 'synthetic-rtf', userId: 'synthetic-user', orgId: 'synthetic-org',
  });
  const block = observed.result.blocks[0];
  assert.ok(block.mentions.some((mention) => mention.text === 'Rama'));
  assert.ok(block.candidates.some((candidate) => candidate.kind === 'decision'));
  for (const mention of block.mentions) {
    const segment = coreSegments.find((item) => item.id === mention.evidence.block_id);
    assert.ok(segment, `missing parsed segment for ${mention.text}: ${mention.evidence.block_id}`);
    assert.equal(segment.content.slice(mention.evidence.start, mention.evidence.end), mention.evidence.quote);
    assert.equal(mention.evidence.source_start, segment.startOffset + mention.evidence.start,
      `global evidence coordinate mismatch for ${mention.text}`);
  }
  assert.equal(JSON.stringify(writes[0].data).includes('Rama'), false);
});

test('unvalidated multilingual model fails closed from assisted prompt projection', {
  skip: !serviceUrl && 'set HM_UNDERSTAND_URL to run the local assisted projection integration',
}, async () => {
  const [{ HmUnderstandAdapter }, { projectHmUnderstandWindow }] = await Promise.all([
    import('../../src/knowledge/enterprise/hm-understand-adapter.js'),
    import('../../src/knowledge/enterprise/hm-understand-assisted.js'),
  ]);
  const result = await new HmUnderstandAdapter({ baseUrl: serviceUrl, timeoutMs: 30_000 })
    .analyze({ source: { id: 'assisted-smoke', revision: 'v1' },
      blocks: [{ id: 'block-1', text: assistedTestText, language: 'en' }] });
  assert.equal(result.ok, true);
  assert.ok(result.result.blocks.some((block) => block.quality?.refinement_required === true),
    'unbenchmarked languages must remain refinement-required');
  const projection = projectHmUnderstandWindow({ content: assistedTestText }, result.result);
  assert.equal(projection, null, 'unvalidated model output must not compact the authoritative prompt');
});

test('real gateway token comparison verifies compact input saves prompt tokens', {
  skip: process.env.HM_UNDERSTAND_REAL_LLM_E2E !== 'true'
    && 'set HM_UNDERSTAND_REAL_LLM_E2E=true to make two synthetic provider calls',
}, async (t) => {
  assert.ok(serviceUrl, 'HM_UNDERSTAND_URL must point to the local analyzer');
  const [{ HmUnderstandAdapter }, { projectHmUnderstandWindow }, { DocumentFirstIngestionService },
    { chatCompletionWithFallback }] = await Promise.all([
    import('../../src/knowledge/enterprise/hm-understand-adapter.js'),
    import('../../src/knowledge/enterprise/hm-understand-assisted.js'),
    import('../../src/knowledge/document-first-ingestion.js'),
    import('../../src/knowledge/enterprise/litellm-client.js'),
  ]);
  const analysis = await new HmUnderstandAdapter({ baseUrl: serviceUrl, timeoutMs: 30_000 })
    .analyze({ source: { id: 'synthetic-token-eval', revision: 'v1' },
      blocks: [{ id: 'block-1', text: assistedTestText, language: 'en' }] });
  assert.equal(analysis.ok, true);
  const projection = projectHmUnderstandWindow({ content: assistedTestText }, analysis.result);
  if (!projection) {
    t.skip('model language is not yet quality-validated for assisted prompt compaction');
    return;
  }

  const service = new DocumentFirstIngestionService({
    db: null, smartIngestRouter: null, memoryGraphEngine: null, doclingAdapter: null, embeddingService: null,
    // Fix one model and bypass model-policy DB lookup; the gateway still follows
    // this local Core environment's configured Cloudflare route.
    llmCompletion: (request) => chatCompletionWithFallback({
      ...request, models: [request.models[0]], honorModelPolicy: false,
    }),
    logger: { info() {}, warn() {} },
  });
  const measure = async (content, extractionContent = null) => {
    const usage = [];
    const claims = await service._extractUnified({
      content, sourceContent: assistedTestText, extractionContent,
      onUsage: (receipt) => usage.push(receipt),
    }, { maxFacts: 3 });
    return { usage, claims };
  };
  const baseline = await measure(assistedTestText);
  const compact = await measure(assistedTestText, projection.extractionContent);
  assert.equal(baseline.usage.length, 1, 'baseline provider must report token usage');
  assert.equal(compact.usage.length, 1, 'compact provider must report token usage');
  assert.equal(compact.usage[0].model, baseline.usage[0].model, 'compare the same served model');
  assert.ok(baseline.usage[0].prompt_tokens > 0);
  assert.ok(compact.usage[0].prompt_tokens < baseline.usage[0].prompt_tokens,
    `compact prompt tokens (${compact.usage[0].prompt_tokens}) must be below baseline (${baseline.usage[0].prompt_tokens})`);
  assert.ok(compact.claims.every((claim) => assistedTestText.includes(claim.source_quote)),
    'all compact-path output evidence must still cite the original source');
  console.log(JSON.stringify({
    model: compact.usage[0].model,
    provider: compact.usage[0].provider,
    baseline_prompt_tokens: baseline.usage[0].prompt_tokens,
    compact_prompt_tokens: compact.usage[0].prompt_tokens,
    observed_prompt_token_savings: baseline.usage[0].prompt_tokens - compact.usage[0].prompt_tokens,
    output_claims: compact.claims.length,
    content: 'synthetic fixture only',
  }));
});
