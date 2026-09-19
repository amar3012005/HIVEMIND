import { describe, expect, it } from 'vitest';
import { assetPrefix, dimensionsForAspect, safeProductionSpec, validTrigger, workflowInstanceId } from '../src/contract';

const trigger = { job_id: '11111111-1111-4111-8111-111111111111', org_id: '22222222-2222-4222-8222-222222222222', user_id: '33333333-3333-4333-8333-333333333333', processing_version: 1, requested_at: '2026-09-19T00:00:00.000Z' };
describe('visual generation workflow contract', () => {
  it('uses a deterministic, tenant-scoped workflow identity', () => { expect(validTrigger(trigger)).toBe(true); expect(workflowInstanceId(trigger)).toBe('visual-generation-11111111-1111-4111-8111-111111111111-v1'); expect(assetPrefix(trigger)).toContain('org/22222222-2222-4222-8222-222222222222/visual-generation/11111111'); });
  it('rejects malformed queue messages', () => { expect(validTrigger({ ...trigger, org_id: 'other' })).toBe(false); expect(validTrigger({ ...trigger, processing_version: 0 })).toBe(false); });
  it('normalizes a complete production spec and coordinated variants', () => { const spec = safeProductionSpec({ subject: 'A real product', variants: [{ variation: 'Close crop' }] }, { instruction: 'Show the product', count: 3, brandStyle: 'blue' }); expect(spec.contract_version).toBe('visual.production.v1'); expect(spec.variants).toHaveLength(3); expect(spec.text_policy).toBe('no_generated_text'); });
  it('maps supported aspect ratios to high-resolution outputs', () => { expect(dimensionsForAspect('16:9')).toEqual({ width: 1344, height: 768 }); expect(dimensionsForAspect('9:16')).toEqual({ width: 768, height: 1344 }); expect(dimensionsForAspect('1:1', true)).toEqual({ width: 512, height: 512 }); });
});
