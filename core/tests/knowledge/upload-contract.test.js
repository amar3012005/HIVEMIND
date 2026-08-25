import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyKnowledgeFile,
  safeUploadFilename,
  sanitizeKnowledgeJson,
  validateKnowledgeFile,
  withKnowledgeUploadQuotaDetails,
} from '../../src/knowledge/upload-contract.js';

test('normalizes hostile filenames and enforces media-specific limits', () => {
  assert.equal(safeUploadFilename('../../secret\u0000.pdf'), 'secret.pdf');
  assert.equal(validateKnowledgeFile({ filename: 'empty.pdf', contentType: 'application/pdf', bytes: 0 }).code, 'FILE_EMPTY');
  assert.equal(validateKnowledgeFile({ filename: 'large.png', contentType: 'image/png', bytes: 21 * 1024 * 1024 }).code, 'FILE_TOO_LARGE');
});

test('rejects extension and MIME mismatch', () => {
  assert.equal(classifyKnowledgeFile('photo.png', 'application/pdf').code, 'MIME_EXTENSION_MISMATCH');
  assert.equal(classifyKnowledgeFile('payload.exe', 'application/octet-stream').code, 'UNSUPPORTED_FILE_TYPE');
});

test('rejects spoofed binary signatures', () => {
  const result = validateKnowledgeFile({
    filename: 'invoice.pdf', contentType: 'application/pdf', bytes: 64, buffer: Buffer.alloc(64, 1),
  });
  assert.equal(result.code, 'FILE_SIGNATURE_MISMATCH');
});

test('admits only the hm-extract formats proven through the upload contract', () => {
  const zip = Buffer.concat([Buffer.from('504b0304', 'hex'), Buffer.alloc(60)]);
  const ole = Buffer.concat([Buffer.from('d0cf11e0a1b11ae1', 'hex'), Buffer.alloc(56)]);
  const rtf = Buffer.from('{\\rtf1\\ansi This is a valid document body that exceeds the minimum.}');

  for (const ext of ['docm', 'odt', 'epub']) {
    assert.equal(validateKnowledgeFile({ filename: `sample.${ext}`, bytes: zip.length, buffer: zip }).ok, true);
  }
  assert.equal(validateKnowledgeFile({ filename: 'sample.doc', bytes: ole.length, buffer: ole }).ok, true);
  assert.equal(validateKnowledgeFile({ filename: 'sample.rtf', bytes: rtf.length, buffer: rtf }).ok, true);

  for (const ext of ['ppt', 'pptm', 'ppsx', 'ppsm', 'xls', 'ods', 'odp']) {
    assert.equal(classifyKnowledgeFile(`sample.${ext}`).code, 'UNSUPPORTED_FILE_TYPE');
  }
});

test('rejects spoofed hm-extract document signatures', () => {
  const fake = Buffer.alloc(64, 1);
  for (const ext of ['doc', 'docm', 'odt', 'rtf', 'epub']) {
    assert.equal(validateKnowledgeFile({ filename: `sample.${ext}`, bytes: fake.length, buffer: fake }).code, 'FILE_SIGNATURE_MISMATCH');
  }
});

test('recursively removes JSONB control characters before a job is persisted or queued', () => {
  const cyclic = { value: 'one\u0000two' };
  cyclic.self = cyclic;
  const sanitized = sanitizeKnowledgeJson({
    'source\u0000id': 'doc\u0000-1',
    nested: { citation: 'line\u001fitem', binary: Buffer.from('a\u0000b') },
    list: ['x\u0000y', undefined, Infinity],
    cyclic,
  });

  assert.deepEqual(sanitized, {
    sourceid: 'doc-1',
    nested: { citation: 'lineitem', binary: 'ab' },
    list: ['xy', null, null],
    cyclic: { value: 'onetwo', self: '[Circular]' },
  });
});

test('quota details add context without changing the enforced limit fields', () => {
  const body = withKnowledgeUploadQuotaDetails({ plan: 'free', limit: 100, current: 100, remaining: 0 }, {
    metric: 'kbPages', estimatedPages: 3, ingestMode: 'both',
  });
  assert.deepEqual(body, {
    plan: 'free', limit: 100, current: 100, remaining: 0,
    metric: 'kbPages', current_usage: 100, remaining_capacity: 0,
    estimated_pages: 3, ingest_mode: 'both',
  });
});
