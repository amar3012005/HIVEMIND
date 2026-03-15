import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryEngine } from '../../src/engine.local.js';

test('code ingest stores AST metadata for structural queries', () => {
  const engine = new MemoryEngine();
  const code = `
    class AuthService {
      async validateToken(token) {
        return token.length > 10;
      }
    }
  `;

  const result = engine.ingestCodeMemory({
    content: code,
    filepath: 'core/src/auth/service.js',
    language: 'javascript',
    user_id: '00000000-0000-4000-8000-000000009901',
    org_id: '00000000-0000-4000-8000-000000009902',
    project: 'alpha',
    tags: ['auth']
  });

  assert.ok(result.chunk_count >= 1);

  const hits = engine.searchStructuralImplementation({
    symbol: 'validateToken',
    filepath: 'core/src/auth/service.js',
    user_id: '00000000-0000-4000-8000-000000009901',
    org_id: '00000000-0000-4000-8000-000000009902',
    project: 'alpha'
  });

  assert.ok(hits.length >= 1);
  assert.ok(Array.isArray(hits[0].scope_context));
});
