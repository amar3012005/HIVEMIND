import { describe, expect, it } from 'vitest';
import { modelPrompt, validateShotPlan } from './design-skills';
import { parseModelJson } from './model-json';

describe('production design contracts', () => {
  it('retains structured Workers AI JSON instead of silently replacing art direction with a fallback', () => {
    const contract = { skill_id: 'social', variants: [{ purpose: 'Introduce shared memory', variation: 'Interconnected paper archive illustration' }] };
    for (const response of [contract, { response: contract }, { result: { response: contract } }, { response: JSON.stringify(contract) }]) {
      expect(parseModelJson(response)).toEqual(contract);
      expect(() => validateShotPlan(parseModelJson(response), 1)).not.toThrow();
    }
  });
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
  it('keeps governance notes and deterministic branding out of the image-model prompt', () => {
    const spec = { skill_id: 'social', communication_objective: 'Introduce shared memory', audience: 'Operators', subject: 'A connected archive', scene: 'Abstract editorial scene', composition: 'Strong central hierarchy', camera: 'Isometric', lighting: 'Soft', materials: 'Paper and glass', palette: 'Verified site palette', emotional_tone: 'Confident', brand_rules: ['Use official SINGULANCE logo', 'Restrained blue line art'], required_elements: ['SINGULANCE logo', 'Connected archive'], forbidden_elements: ['Data-leakage implications'], unsupported_claims: ['No compliance claims'] };
    const result = modelPrompt(spec, { purpose: 'Introduce persistent memory', variation: 'A luminous archive connected by restrained lines' }, false);
    expect(result).toContain('Connected archive');
    expect(result).toContain('Restrained blue line art');
    expect(result).not.toContain('Data-leakage');
    expect(result).not.toContain('No compliance claims');
    expect(result).not.toContain('Use official SINGULANCE logo');
  });
});
