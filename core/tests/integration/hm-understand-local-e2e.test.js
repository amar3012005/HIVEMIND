import test from 'node:test';
import assert from 'node:assert/strict';

const serviceUrl = process.env.HM_UNDERSTAND_URL;
const parserUrl = process.env.DOCLING_URL;

const assistedTestText = 'Project Atlas is an internal launch program. '
  + 'The board approved a EUR 12000 budget for Project Atlas on 22 September 2026. '
  + 'The initiative will begin after review. '
  + 'This background paragraph explains the wider operating context without adding a decision or a number. '
  + 'The company stores source documents separately so citations remain available.';

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

test('assisted prompt projection uses local exact evidence and keeps original offsets', {
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
  const projection = projectHmUnderstandWindow({ content: assistedTestText }, result.result);
  assert.ok(projection, 'fixture must meet the conservative assisted-mode gate');
  assert.ok(projection.savingsRatio >= 0.15);
  assert.match(projection.extractionContent, /Project Atlas/);
  assert.match(projection.extractionContent, /EUR 12000/);
  assert.equal(projection.extractionContent.includes('background paragraph'), false);
  assert.ok(projection.sourceChars > projection.extractionChars);
});
