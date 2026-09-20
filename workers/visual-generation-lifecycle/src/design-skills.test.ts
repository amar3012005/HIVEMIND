import { describe, expect, it } from 'vitest';
import { modelPrompt, validateShotPlan } from './design-skills';

describe('production design contracts', () => {
  it('rejects incomplete, repeated or unskilled shot sets', () => {
    const shot = { purpose: 'Introduce the product', variation: 'Product macro in warm editorial light' };
    expect(() => validateShotPlan({ skill_id: 'social', variants: [shot] }, 3)).toThrow();
    expect(() => validateShotPlan({ skill_id: 'social', variants: [shot, shot] }, 2)).toThrow();
    expect(() => validateShotPlan({ skill_id: 'unknown', variants: [shot] }, 1)).toThrow();
  });
  it('compiles the selected discipline and distinct shot without requiring user prompt mechanics', () => {
    const spec = { skill_id: 'product', communication_objective: 'Show modular construction', audience: 'Installers', subject: 'Verified heat pump', scene: 'Workshop', composition: 'Close crop', camera: 'Macro', lighting: 'Soft side light', materials: 'Brushed steel', palette: 'Brand teal', emotional_tone: 'Precise' };
    const result = modelPrompt(spec, { purpose: 'Demonstrate replaceable components', variation: 'Exploded assembly using the verified geometry' }, true);
    expect(result).toContain('Preserve geometry');
    expect(result).toContain('Exploded assembly');
    expect(result).toContain('Image 0 is the approved key visual');
  });
});
