import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDocumentPayloads,
  chunkPdfPages,
  formatPdfTable,
  mergePdfPageContent,
  normalizeExtractedText,
} from '../../src/knowledge/document-chunker.js';

test('normalizeExtractedText trims and normalizes line breaks', () => {
  const input = 'Line 1\r\nLine 2\r\r\n\n\nLine 3  \n';
  const output = normalizeExtractedText(input);

  assert.equal(output, 'Line 1\nLine 2\n\nLine 3');
});

test('formatPdfTable converts rows into readable pipe-separated text', () => {
  const table = [
    ['Item', 'Qty', 'Amount'],
    ['Widget A', '2', '$10'],
    ['Widget B', '', '$15'],
  ];

  const output = formatPdfTable(table);

  assert.ok(output.startsWith('Table 1'));
  assert.ok(output.includes('Item | Qty | Amount'));
  assert.ok(output.includes('Widget A | 2 | $10'));
  assert.ok(output.includes('Widget B | $15'));
});

test('mergePdfPageContent keeps page text and appends tables', () => {
  const output = mergePdfPageContent(
    'Executive summary line one.\nLine two.',
    [[['Field', 'Value'], ['Status', 'Paid']]]
  );

  assert.ok(output.includes('Executive summary line one.'));
  assert.ok(output.includes('Tables'));
  assert.ok(output.includes('Field | Value'));
  assert.ok(output.includes('Status | Paid'));
});

test('chunkPdfPages preserves page metadata on each chunk', () => {
  const pages = [
    {
      page_number: 1,
      page_label: 'i',
      content: Array.from({ length: 220 }, () => 'alpha beta gamma delta').join(' '),
      table_count: 2,
    },
    {
      page_number: 2,
      page_label: 'ii',
      content: 'Short page content.',
      table_count: 0,
    },
  ];

  const chunks = chunkPdfPages(pages);

  assert.ok(chunks.length >= 2, `Expected multiple chunks, got ${chunks.length}`);
  assert.equal(chunks[0].page_number, 1);
  assert.equal(chunks[0].page_label, 'i');
  assert.equal(chunks.at(-1).page_number, 2);
});

test('buildDocumentPayloads falls back for sparse PDFs when extracted text is unavailable', () => {
  const result = buildDocumentPayloads(
    {
      text: '',
      metadata: {
        title: 'Scanned Policy',
        pages: 2,
        ocr_fallback_pages: 0,
      },
      pages: [
        { page_number: 1, content: '', table_count: 0 },
        { page_number: 2, content: '', table_count: 0 },
      ],
    },
    'application/pdf',
    'scanned.pdf',
    { user_id: 'user-1', org_id: 'org-1' }
  );

  assert.match(result.summary.content, /Direct text extraction was unavailable/i);
  assert.equal(result.summary.metadata.parse_warning, 'pdf_text_unavailable');
  assert.ok(result.chunks.length >= 1);
  assert.equal(result.chunks[0].metadata.parse_warning, 'pdf_text_unavailable');
  assert.ok(result.summary.tags.includes('knowledge-base'));
});

test('buildDocumentPayloads still rejects empty non-PDF documents', () => {
  assert.throws(
    () => buildDocumentPayloads(
      { text: '', metadata: {}, pages: [] },
      'text/plain',
      'empty.txt',
      {}
    ),
    /Document appears to be empty or could not be parsed/
  );
});
