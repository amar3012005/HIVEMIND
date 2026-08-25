import assert from 'node:assert/strict';
import test from 'node:test';

import { createIngestDiagnosticLogger } from '../../src/knowledge/document-first-ingestion.js';

test('document-first diagnostics stay silent by default and opt in with KB_INGEST_VERBOSE', () => {
  const emitted = [];
  const logger = {
    info: (...args) => emitted.push(['info', ...args]),
    warn: (...args) => emitted.push(['warn', ...args]),
    error: (...args) => emitted.push(['error', ...args]),
  };

  const quiet = createIngestDiagnosticLogger(logger, { verbose: false });
  quiet.info('parser detail');
  quiet.warn('segment detail');
  quiet.error('promotion detail');
  assert.deepEqual(emitted, []);

  const verbose = createIngestDiagnosticLogger(logger, { verbose: true });
  verbose.info('parser detail');
  verbose.warn('segment detail');
  verbose.error('promotion detail');
  assert.deepEqual(emitted, [
    ['info', 'parser detail'],
    ['warn', 'segment detail'],
    ['error', 'promotion detail'],
  ]);
});
