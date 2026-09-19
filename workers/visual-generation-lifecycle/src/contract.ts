export const CONTRACT_VERSION = 'visual.production.v1';
export type VisualTrigger = { job_id: string; org_id: string; user_id: string; processing_version: number; requested_at: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validTrigger(value: unknown): value is VisualTrigger {
  const trigger = value as VisualTrigger;
  return Boolean(trigger && UUID.test(String(trigger.job_id)) && UUID.test(String(trigger.org_id)) && UUID.test(String(trigger.user_id))
    && Number.isInteger(trigger.processing_version) && trigger.processing_version > 0 && Number.isFinite(Date.parse(trigger.requested_at)));
}

export function workflowInstanceId(trigger: VisualTrigger) { return `visual-generation-${trigger.job_id}-v${trigger.processing_version}`; }

export function dimensionsForAspect(aspect: string, anchor = false) {
  if (anchor) return { width: 512, height: 512 };
  const map: Record<string, { width: number; height: number }> = {
    '1:1': { width: 1024, height: 1024 }, '16:9': { width: 1344, height: 768 }, '9:16': { width: 768, height: 1344 },
    '4:3': { width: 1152, height: 896 }, '3:4': { width: 896, height: 1152 }, '4:5': { width: 896, height: 1120 },
  };
  return map[aspect] || map['1:1'];
}

export function safeProductionSpec(value: any, fallback: any) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const text = (field: string, defaultValue = '') => String(source[field] || defaultValue).trim().slice(0, 3000);
  const list = (field: string, max = 12) => (Array.isArray(source[field]) ? source[field] : []).map((item: unknown) => String(item).trim().slice(0, 500)).filter(Boolean).slice(0, max);
  const variants = (Array.isArray(source.variants) ? source.variants : []).slice(0, fallback.count).map((row: any, index: number) => ({
    index, purpose: String(row?.purpose || `Visual ${index + 1}`).slice(0, 300), variation: String(row?.variation || `A distinct composition for output ${index + 1}`).slice(0, 1200),
  }));
  while (variants.length < fallback.count) variants.push({ index: variants.length, purpose: `Visual ${variants.length + 1}`, variation: `Distinct composition ${variants.length + 1} while preserving the shared art direction.` });
  return {
    contract_version: CONTRACT_VERSION, communication_objective: text('communication_objective', fallback.instruction), audience: text('audience', 'The intended audience'),
    subject: text('subject', fallback.instruction), scene: text('scene', fallback.instruction), composition: text('composition', 'Clear editorial composition with one strong focal subject'),
    camera: text('camera', 'Purposeful professional perspective'), lighting: text('lighting', 'Natural, intentional, dimensional lighting'),
    materials: text('materials', 'Believable premium materials and textures'), palette: text('palette', fallback.brandStyle || 'Restrained brand-aligned palette'),
    emotional_tone: text('emotional_tone', 'Confident, specific, human, and credible'), brand_rules: list('brand_rules'), required_elements: list('required_elements'),
    forbidden_elements: list('forbidden_elements'), unsupported_claims: list('unsupported_claims'), text_policy: text('text_policy', 'no_generated_text'),
    master_prompt: text('master_prompt', fallback.instruction), variants,
  };
}

export function assetPrefix(trigger: VisualTrigger) { return `org/${trigger.org_id}/visual-generation/${trigger.job_id}/`; }
