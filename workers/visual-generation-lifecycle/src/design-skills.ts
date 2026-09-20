// Versioned production skills. The art director selects one using the approved
// deliverable, not a prompt keyword classifier. Add new skills here without
// changing Room orchestration or the model transport.
export const DESIGN_SKILLS = {
  social: 'Design one clear message per post. Establish a focal hierarchy legible at phone size, intentional negative space for exact copy, and distinct narrative beats across a carousel. Avoid generic robots/server racks unless explicitly justified by the approved concept.',
  advertising: 'Translate the verified buyer problem and offer into a concrete visual proposition. Show the outcome without fabricated proof. Reserve a clear CTA/copy region. Vary hook and subject per creative while preserving campaign identity.',
  product: 'Use verified product photographs as identity references. Preserve geometry, controls, materials and proportions. Do not invent features or substitute a plausible-looking product. Specify camera, scale, environment and light.',
  editorial: 'Communicate the approved argument through a specific editorial metaphor or observed scene. Choose a deliberate illustration or photographic language. Avoid stock AI symbolism and decorative elements without meaning.',
  infographic: 'Plan an accurate information hierarchy from verified facts. Generate illustration components and reserve exact labels/data for deterministic layout; never hallucinate charts, numerical evidence or text.',
  presentation: 'Compose a slide-supporting visual with strong hierarchy, generous negative space and one conceptual focus. Maintain consistent palette and line/texture language across the deck.',
  website: 'Design for the intended page section and crop behavior. Keep focal subjects away from copy areas. Respect the existing site palette, spacing and visual weight without copying the screenshot as a page mockup.',
  identity: 'Separate a requested NEW logo concept from preservation of an existing logo. Existing identity must use verified original asset pixels. New logo concepts need simple distinctive silhouettes, flat forms and small-size legibility; exact lettering belongs in composition.',
} as const;

export function designSkill(id: unknown) {
  if (typeof id !== 'string' || !(id in DESIGN_SKILLS)) throw new Error('visual_design_skill_required');
  return { id, version: 1, instructions: DESIGN_SKILLS[id as keyof typeof DESIGN_SKILLS] };
}

export function validateShotPlan(value: any, count: number) {
  designSkill(value?.skill_id);
  if (!Array.isArray(value?.variants) || value.variants.length !== count) throw new Error('visual_shot_plan_incomplete');
  const subjects = new Set<string>();
  for (const shot of value.variants) {
    if (![shot?.purpose, shot?.variation].every(v => typeof v === 'string' && v.trim().length >= 12)) throw new Error('visual_shot_brief_incomplete');
    subjects.add(shot.variation.trim().toLowerCase());
  }
  if (subjects.size !== count) throw new Error('visual_shots_must_be_distinct');
}

export function modelPrompt(spec: any, shot: any, hasAnchor: boolean) {
  const skill = designSkill(spec.skill_id);
  const generatedPixelRule = spec.skill_id === 'identity'
    ? 'Only create a new abstract symbol when the approved brief explicitly requests a new identity. Do not imitate or redraw an existing official mark; lettering is composed separately.'
    : 'Create only the background artwork. Keep it free of words, letters, numbers, logos and watermarks; exact approved copy and existing brand marks are composed separately.';
  const visualRequirements = (Array.isArray(spec.required_elements) ? spec.required_elements : [])
    .filter((value: unknown) => typeof value === 'string' && !/logo|word|letter|copy|caption|typography|brand mark/i.test(value))
    .slice(0, 8);
  const visualBrandRules = (Array.isArray(spec.brand_rules) ? spec.brand_rules : [])
    .filter((value: unknown) => typeof value === 'string' && !/logo|word|letter|copy|caption|typography|brand mark/i.test(value))
    .slice(0, 8);
  // FLUX consumes descriptive natural language with actual image inputs. The
  // compiler owns technical instructions; users supply only the intended use.
  return [
    `Design discipline: ${skill.id}. ${skill.instructions}`,
    `Create this deliverable: ${shot.purpose}. ${shot.variation}.`,
    `Approved objective: ${spec.communication_objective}. Audience: ${spec.audience}.`,
    `Scene and subject: ${spec.subject}. ${spec.scene}.`,
    `Art direction: ${spec.composition}. ${spec.camera}. ${spec.lighting}. ${spec.materials}.`,
    `Visual system: ${spec.palette}. ${spec.emotional_tone}.`,
    visualBrandRules.length ? `Verified visual rules: ${visualBrandRules.join('; ')}.` : '',
    visualRequirements.length ? `Required visual subjects: ${visualRequirements.join('; ')}.` : '',
    'Use website screenshots for palette and visual language only. Preserve verified product identity when supplied. Do not reproduce screenshot text or layout.',
    generatedPixelRule,
    hasAnchor ? 'Image 0 is the approved key visual. Match its lighting, palette and materials; express this shot’s distinct message and composition.' : '',
  ].filter(Boolean).join('\n');
}
