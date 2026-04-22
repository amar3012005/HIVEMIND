import test from 'node:test';
import assert from 'node:assert/strict';
import {
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
