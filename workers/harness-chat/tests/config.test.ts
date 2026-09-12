import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function config(name: string): { assets: { run_worker_first: string[] } } {
  return JSON.parse(readFileSync(resolve(import.meta.dirname, '..', name), 'utf8'));
}

it('keeps the preview Harness Worker internal to the next.preview service binding', () => {
  const preview = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'wrangler.preview.jsonc'), 'utf8'));
  expect(preview.workers_dev).toBe(false);
  expect(preview.routes).toEqual([]);
});

describe('Harness document routing', () => {
  for (const name of ['wrangler.preview.jsonc', 'wrangler.jsonc']) {
    it(`${name} runs canonical Overview documents through boot injection`, () => {
      const routes = config(name).assets.run_worker_first;
      expect(routes).toContain('/hivemind/app/overview');
      expect(routes).toContain('/hivemind/app/overview/*');
      expect(routes).not.toContain('/hivemind/app/v1/overview');
    });
  }
});
