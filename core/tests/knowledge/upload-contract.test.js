import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyKnowledgeFile, safeUploadFilename, validateKnowledgeFile } from '../../src/knowledge/upload-contract.js';

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
