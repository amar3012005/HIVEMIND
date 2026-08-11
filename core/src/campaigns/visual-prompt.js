const ASPECT_RATIOS = new Set(['1:1', '16:9', '9:16', '4:3', '3:4']);

function text(value, fallback = '') {
  return String(value || fallback).trim();
}

function list(value) {
  return (Array.isArray(value) ? value : []).map((item) => text(item)).filter(Boolean).slice(0, 20);
}

export function normalizeCreativeBrief(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const legacyConcept = text(source.concept || source.description || source.direction);
  return {
    required: source.required === true,
    objective: text(source.objective, legacyConcept),
    subject: text(source.subject, legacyConcept),
    composition: text(source.composition, legacyConcept ? 'Clear editorial composition with one focal subject and generous crop-safe space' : ''),
    brand_style: text(source.brand_style, legacyConcept ? 'Credible, contemporary, professional, and restrained' : ''),
    audience: text(source.audience, legacyConcept ? 'The campaign target audience' : ''),
    aspect_ratio: ASPECT_RATIOS.has(text(source.aspect_ratio)) ? text(source.aspect_ratio) : '16:9',
    text_policy: text(source.text_policy, 'no_generated_text'),
    required_elements: list(source.required_elements),
    forbidden_elements: list(source.forbidden_elements),
    unsupported_claims: list(source.unsupported_claims),
    alt_text: text(source.alt_text, legacyConcept),
    generation_prompt: text(source.generation_prompt || source.prompt, legacyConcept),
    rationale: text(source.rationale),
    lighting: text(source.lighting),
    camera: text(source.camera),
    color_direction: text(source.color_direction),
    emotional_tone: text(source.emotional_tone),
    visual_references: list(source.visual_references),
  };
}

export function creativeBriefErrors(value) {
  const brief = normalizeCreativeBrief(value);
  if (!brief.required) return [];
  const errors = [];
  for (const field of ['objective', 'subject', 'composition', 'brand_style', 'audience', 'alt_text']) {
    if (!brief[field]) errors.push(`creative_brief.${field} is required when an image is needed`);
  }
  if (!brief.generation_prompt) errors.push('creative_brief.generation_prompt is required when an image is needed');
  return errors;
}

export function buildCampaignImagePrompt(value, context = {}) {
  const brief = normalizeCreativeBrief(value);
  const required = brief.required_elements.length ? brief.required_elements.join('; ') : 'No additional mandatory objects.';
  const forbidden = [...brief.forbidden_elements, ...brief.unsupported_claims];
  const exclusions = forbidden.length ? forbidden.join('; ') : 'No fabricated logos, interfaces, statistics, awards, customers, or performance claims.';
  const exactPrompt = brief.generation_prompt || [brief.subject, brief.composition, brief.brand_style].filter(Boolean).join('. ');
  return [
    'Create one polished campaign image from this art-direction contract.',
    `Campaign objective: ${brief.objective || text(context.goal, 'Communicate the campaign message clearly')}.`,
    `Audience: ${brief.audience || text(context.audience, 'The campaign target audience')}.`,
    `Primary subject: ${brief.subject || 'A concrete, inspectable representation of the campaign idea'}.`,
    `Composition and camera: ${brief.composition || 'Clear focal subject, purposeful depth, uncluttered layout, professional editorial framing'}.`,
    `Brand and visual language: ${brief.brand_style || text(context.brandStyle, 'Credible, contemporary, restrained, human-led')}.`,
    brief.color_direction ? `Color direction: ${brief.color_direction}.` : null,
    brief.lighting ? `Lighting: ${brief.lighting}.` : null,
    brief.camera ? `Camera, lens, and perspective: ${brief.camera}.` : null,
    brief.emotional_tone ? `Emotional tone: ${brief.emotional_tone}.` : null,
    brief.visual_references.length ? `Visual references to interpret without copying: ${brief.visual_references.join('; ')}.` : null,
    `Detailed generation direction: ${exactPrompt}.`,
    `Required elements: ${required}`,
    `Do not include: ${exclusions}`,
    brief.text_policy === 'no_generated_text'
      ? 'Do not render words, letters, numbers, captions, logos, watermarks, UI labels, or pseudo-text inside the image.'
      : `Text treatment policy: ${brief.text_policy}. Render only explicitly supplied exact copy; never improvise wording.`,
    `Output framing: ${brief.aspect_ratio}; keep important subjects within a central safe area for responsive cropping.`,
    'Make the result specific to the described product and audience, visually coherent, realistic in material and lighting, and immediately usable as a professional campaign creative.',
  ].filter(Boolean).join('\n');
}

export const CAMPAIGN_IMAGE_ASPECT_RATIOS = [...ASPECT_RATIOS];
