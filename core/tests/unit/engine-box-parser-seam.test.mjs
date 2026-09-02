import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('Engine Box parser seam permits hm-extract without requiring hosted Docling', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const source = await fs.readFile(path.join(root, 'src/knowledge/document-first-ingestion.js'), 'utf8');
  assert.match(source, /this\.doclingAdapter && \(process\.env\.DOCLING_URL \|\| process\.env\.KB_EXTRACT_URL\)/);
  assert.doesNotMatch(source, /this\.doclingAdapter && process\.env\.DOCLING_URL\) \{/);
});
