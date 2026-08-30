import { describe, expect, it } from 'vitest';
import { CORE_STAGE_NAMES, coreStagePath, type ProjectionParams } from '../src/contract';
import { signCoreRequest } from '../src/security';
// Core is JavaScript; this import deliberately exercises the real shared verifier.
// @ts-expect-error no declaration file is published for this internal module
import { verifyCanonicalProjectionSignature } from '../../../core/src/memory/canonical-knowledge.js';

const params: ProjectionParams = {
  memory_id: '74fb72fc-08da-41cc-8c56-598eae67bfee',
  org_id: '22222222-2222-4222-8222-222222222222',
  processing_version: 1,
  required_projection: 'write',
};

describe('Worker to Core canonical projection contract', () => {
  it('uses the versioned route for every checkpointed stage', () => {
    expect(CORE_STAGE_NAMES.map((stage) => coreStagePath(params.memory_id, stage))).toEqual([
      `/internal/canonical-projection/v1/memories/${params.memory_id}/stages/load`,
      `/internal/canonical-projection/v1/memories/${params.memory_id}/stages/reconstruct`,
      `/internal/canonical-projection/v1/memories/${params.memory_id}/stages/resolve`,
      `/internal/canonical-projection/v1/memories/${params.memory_id}/stages/normalize`,
      `/internal/canonical-projection/v1/memories/${params.memory_id}/stages/persist`,
      `/internal/canonical-projection/v1/memories/${params.memory_id}/stages/reconcile`,
      `/internal/canonical-projection/v1/memories/${params.memory_id}/stages/complete`,
      `/internal/canonical-projection/v1/memories/${params.memory_id}/stages/failed`,
    ]);
  });

  it('produces a signature accepted by the real Core verifier over the exact identifier envelope', async () => {
    const pathname = coreStagePath(params.memory_id, 'persist');
    const timestamp = '1788114180000';
    const signed = await signCoreRequest('test-secret', pathname, params, timestamp, 'contract-nonce');
    expect(JSON.parse(signed.body)).toEqual(params);
    expect(verifyCanonicalProjectionSignature({
      headers: signed.headers,
      pathname,
      rawBody: signed.body,
      secret: 'test-secret',
      now: Number(timestamp),
    })).toEqual({ ok: true, nonce: 'contract-nonce' });
  });
});
