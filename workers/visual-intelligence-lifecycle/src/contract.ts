export const MODES = ['public', 'user_takeover'] as const;
export const DELIVERABLES = ['brand_dna_v1', 'visual_artifact_brief_v1', 'ui_audit_v1'] as const;
export const STAGES = ['admit', 'discover', 'capture', 'store', 'extract', 'verify', 'publish', 'notify'] as const;
export type Mode = typeof MODES[number];
export type Deliverable = typeof DELIVERABLES[number];
export type Trigger = { job_id: string; org_id: string; user_id: string; urls: string[]; mode: Mode; deliverable: Deliverable; processing_version: number; requested_at: string; room_id?: string; lifecycle_day?: 2; browser_session?: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validTrigger(value: unknown): value is Trigger {
  const p = value as Trigger;
  return !!p && UUID.test(String(p.job_id)) && UUID.test(String(p.org_id)) && UUID.test(String(p.user_id))
    && Array.isArray(p.urls) && p.urls.length > 0 && p.urls.length <= 12 && p.urls.every((url) => /^https:\/\//i.test(url))
    && MODES.includes(p.mode) && (p.mode !== 'user_takeover' || /^[A-Za-z0-9_-]{1,40}$/.test(String(p.browser_session || '')))
    && DELIVERABLES.includes(p.deliverable) && Number.isInteger(p.processing_version) && p.processing_version > 0
    && Number.isFinite(Date.parse(p.requested_at));
}
export function instanceId(p: Trigger) { return `visual-${p.job_id}-v${p.processing_version}`; }
export function validBrandDna(value: unknown): boolean {
  const a = value as Record<string, unknown>;
  return !!a && a.artifact_type === 'brand_dna' && typeof a.version === 'string' && Array.isArray(a.evidence)
    && a.evidence.length > 0 && typeof a.visual_generation_brief === 'object' && a.visual_generation_brief !== null;
}
