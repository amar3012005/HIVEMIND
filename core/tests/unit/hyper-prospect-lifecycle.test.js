import assert from 'node:assert/strict';
import test from 'node:test';
import { findProspectingContract, normalizeCandidates, parityMetrics } from '../../src/artifacts/hyper-prospect-lifecycle.js';

test('extracts the latest generalized prospecting contract from a turn', () => {
  const contract = { contract: 'prospecting_contract.v1', request: { requested_count: 2 } };
  assert.deepEqual(findProspectingContract([{ t: 'turn_contract', prospecting_contract: contract }]), contract);
});

test('normalizes, source-bounds, and deduplicates candidates', () => {
  const rows = normalizeCandidates([
    { company_name: 'Acme', url: 'https://acme.example', citations: ['https://source.example'] },
    { name: 'Acme', website: 'https://acme.example', source_urls: ['javascript:bad'] },
    { name: '' },
  ]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].source_urls, ['https://source.example']);
});

test('promotion metrics remain deterministic and evidence based', () => {
  const candidate = normalizeCandidates([{ name: 'Acme', website: 'https://acme.example' }]);
  const metrics = parityMetrics({ legacy: [], candidate, contract: { request: { requested_count: 1 } } });
  assert.equal(metrics.count_parity, true);
  assert.equal(metrics.evidence_coverage, 1);
});
