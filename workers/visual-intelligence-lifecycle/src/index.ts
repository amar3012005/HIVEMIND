import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { STAGES, type Trigger, validBrandDna, validTrigger, instanceId } from './contract';

type Env = { VISUAL_WORKFLOW: Workflow<Trigger>; VISUAL_TRIGGER_QUEUE: Queue<Trigger>; VISUAL_ARTIFACTS: R2Bucket; FLAGS: Flagship; HIVEMIND_VISUAL_API_URL: string; HIVEMIND_VISUAL_WORKFLOW_SECRET: string; HIVEMIND_VISUAL_INSTANCE_PREFIX?: string };
type Receipt = { run_id: string; status?: string; artifact?: unknown; [key: string]: unknown };
type Capture = { page?: { url?: string; title?: string; [key: string]: unknown }; screenshot?: string | null };
const enabled = async (env: Env, trigger: Trigger) => {
  try { return (await env.FLAGS.getBooleanDetails('visual_intelligence_workflow_v1', false, { targetingKey: trigger.user_id, org_id: trigger.org_id })).value === true; }
  catch { return false; }
};
const auth = (request: Request, env: Env) => request.headers.get('authorization') === `Bearer ${env.HIVEMIND_VISUAL_WORKFLOW_SECRET}`;
async function api(env: Env, path: string, body: unknown): Promise<any> {
  const response = await fetch(`${env.HIVEMIND_VISUAL_API_URL.replace(/\/$/, '')}${path}`, { method: 'POST', headers: { authorization: `Bearer ${env.HIVEMIND_VISUAL_WORKFLOW_SECRET}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const payload = await response.json().catch(() => ({})) as Receipt & { error?: string; retryable?: boolean };
  if (!response.ok) { if ([400, 401, 403, 404, 409, 422].includes(response.status) || payload.retryable === false) throw new NonRetryableError(payload.error || `visual_api_${response.status}`); throw new Error(payload.error || `visual_api_${response.status}`); }
  return payload;
}
function decodeScreenshot(value: string) { const match = value.match(/^data:([^;]+);base64,(.+)$/); if (!match) throw new NonRetryableError('invalid_capture_screenshot'); return { contentType: match[1], bytes: Uint8Array.from(atob(match[2]), (c) => c.charCodeAt(0)) }; }
async function captureAndStore(env: Env, trigger: Trigger, runId: string) {
  const captured = await api(env, '/internal/visual-intelligence/stage', { run_id: runId, stage: 'capture', processing_version: trigger.processing_version });
  const rows: Capture[] = Array.isArray(captured.capture_payload) ? captured.capture_payload : [];
  if (!rows.length) throw new Error('visual_capture_payload_empty');
  const artifacts = [] as Array<Record<string, unknown>>;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]; if (!row?.page?.url || !row.screenshot) throw new NonRetryableError('visual_capture_evidence_missing');
    const image = decodeScreenshot(row.screenshot); const key = `org/${trigger.org_id}/runs/${runId}/screenshots/${index}.jpg`;
    await env.VISUAL_ARTIFACTS.put(key, image.bytes, { httpMetadata: { contentType: image.contentType }, customMetadata: { org_id: trigger.org_id, run_id: runId, captured_url: row.page.url } });
    artifacts.push({ r2_key: key, page_url: row.page.url, page: row.page, captured_at: new Date().toISOString() });
  }
  return api(env, '/internal/visual-intelligence/stage', { run_id: runId, stage: 'store', processing_version: trigger.processing_version, input: { artifacts } });
}
function escapeHtml(value: unknown) { return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character] || character)); }
function cell(label: string, value: unknown) { return `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`; }
function renderedReport(artifact: any) {
  const analysis = artifact?.analysis || {}; const identity = analysis.identity || {}; const voice = analysis.voice || {};
  const palette = analysis.palette || {}; const typography = analysis.typography || {}; const layout = analysis.layout || {};
  const imagery = analysis.imagery || {}; const accessibility = analysis.accessibility || {}; const brief = artifact?.visual_generation_brief || {};
  const evidence = Array.isArray(artifact?.evidence) ? artifact.evidence : [];
  const evidenceRows = evidence.map((entry: any, index: number) => `<section class="evidence"><h3>Evidence ${index + 1}: ${escapeHtml(entry?.page?.title || entry?.page_url || 'Captured page')}</h3><table>${cell('Source', entry?.page_url || entry?.page?.url || '')}${cell('Captured', entry?.captured_at || entry?.page?.captured_at || '')}${cell('Canonical', entry?.page?.seo?.canonical || '')}${cell('Screenshot', entry?.r2_key || '')}</table></section>`).join('');
  const swatches = [['Primary', palette.primary], ['Secondary', palette.secondary], ['Accent', palette.accent], ['Background', palette.background]].filter(([, value]) => typeof value === 'string').map(([label, value]) => `<span class="swatch" style="background:${escapeHtml(value)}"><b>${escapeHtml(label)}</b><small>${escapeHtml(value)}</small></span>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(identity.name || 'Brand')} — Brand DNA</title><style>*{box-sizing:border-box}body{margin:0;background:#f5f5f7;color:#1d1d1f;font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.page{max-width:1120px;margin:auto;padding:54px 48px 76px;background:#fff}.eyebrow{color:#6e6e73;font-size:12px;font-weight:700;letter-spacing:.13em;text-transform:uppercase}.hero{margin:18px 0 38px;padding:44px;border-radius:24px;color:#fff;background:linear-gradient(135deg,#0b1020,#426c9a)}h1{font-size:48px;line-height:1.05;margin:12px 0}h2{font-size:28px;margin:42px 0 14px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}.card,.evidence{border:1px solid #d2d2d7;border-radius:16px;padding:22px}.brief{padding:24px;border-radius:16px;background:#f5f5f7}table{width:100%;border-collapse:collapse}th,td{border-bottom:1px solid #e8e8ed;padding:11px 8px;text-align:left;vertical-align:top}th{width:34%;font-weight:650}.swatches{display:flex;gap:12px;flex-wrap:wrap}.swatch{display:flex;width:120px;height:74px;border-radius:12px;border:1px solid #d2d2d7;flex-direction:column;justify-content:end;padding:8px;text-shadow:0 1px 2px #0008;color:#fff}.swatch small{font-size:11px}.evidence{margin:14px 0}.footer{margin-top:42px;border-top:1px solid #d2d2d7;padding-top:16px;color:#6e6e73;font-size:13px}@media(max-width:700px){.page{padding:28px 18px}.grid{grid-template-columns:1fr}h1{font-size:36px}}</style></head><body><main class="page"><div class="eyebrow">Visual Intelligence · Verified Brand DNA</div><section class="hero"><div class="eyebrow" style="color:#d8eaff">First-party browser evidence</div><h1>${escapeHtml(identity.name || 'Brand')} Brand DNA</h1><p>${escapeHtml(identity.tagline || '')}</p><p class="eyebrow" style="color:#d8eaff">Generated ${escapeHtml(artifact?.generated_at || '')}</p></section><h2>Identity & voice</h2><div class="grid"><section class="card"><table>${cell('Name', identity.name || '')}${cell('Tagline', identity.tagline || '')}${cell('Tone', voice.tone || '')}${cell('Style', voice.style || '')}</table></section><section class="card"><table>${cell('Heading type', typography.headings || '')}${cell('Body type', typography.body || '')}${cell('Layout', layout.structure || '')}${cell('Spacing', layout.spacing || '')}${cell('Navigation', layout.navigation || '')}</table></section></div><h2>Visual system</h2><section class="card"><div class="swatches">${swatches}</div><p><b>Imagery:</b> ${escapeHtml(imagery.style || '')} ${escapeHtml(imagery.content || '')}</p><p><b>Accessibility:</b> ${escapeHtml(accessibility.alt_text || '')} ${escapeHtml(accessibility.contrast || '')} ${escapeHtml(accessibility.keyboard_navigation || '')}</p></section><h2>Reusable visual-generation brief</h2><section class="brief"><table>${cell('Style', brief.style || '')}${cell('Elements', Array.isArray(brief.elements) ? brief.elements.map((item: any) => `${item?.type || 'element'}: ${item?.content || ''}`).join(' · ') : '')}</table></section><h2>Evidence ledger</h2>${evidenceRows}<footer class="footer">Artifact ${escapeHtml(artifact?.version || '')}. Time-sensitive copy remains cited evidence and must be revalidated before reuse.</footer></main></body></html>`;
}
async function renderAndStore(env: Env, trigger: Trigger, runId: string, artifact: any) {
  const html = renderedReport(artifact);
  const key = `org/${trigger.org_id}/runs/${runId}/reports/brand-dna.html`;
  await env.VISUAL_ARTIFACTS.put(key, html, { httpMetadata: { contentType: 'text/html; charset=utf-8' }, customMetadata: { org_id: trigger.org_id, run_id: runId, artifact_type: 'brand_dna' } });
  return api(env, '/internal/visual-intelligence/stage', { run_id: runId, stage: 'render', processing_version: trigger.processing_version, input: { report: { r2_key: key, content_type: 'text/html; charset=utf-8', version: artifact?.version || null } } });
}
export class VisualIntelligenceWorkflow extends WorkflowEntrypoint<Env, Trigger> {
  async run(event: WorkflowEvent<Trigger>, step: WorkflowStep) {
    const trigger = event.payload;
    if (!validTrigger(trigger) || !await enabled(this.env, trigger)) throw new NonRetryableError('visual_feature_disabled_or_invalid_trigger');
    let receipt: Receipt | undefined;
    let stage = 'admit';
    try {
      for (stage of STAGES) {
        receipt = await step.do(stage, { retries: { limit: 6, delay: '15 seconds', backoff: 'exponential' }, timeout: '15 minutes' }, () => stage === 'capture'
          ? captureAndStore(this.env, trigger, String(receipt?.run_id || ''))
          : stage === 'render'
            ? renderAndStore(this.env, trigger, String(receipt?.run_id || ''), receipt?.artifact)
            : api(this.env, stage === 'admit' ? '/internal/visual-intelligence/admit' : '/internal/visual-intelligence/stage', stage === 'admit' ? { ...trigger, workflow_instance_id: event.instanceId } : { run_id: receipt?.run_id, stage, processing_version: trigger.processing_version })) as Receipt;
        if (stage === 'publish' && !validBrandDna(receipt.artifact)) throw new NonRetryableError('invalid_brand_dna_artifact');
        if (receipt.status === 'failed' || receipt.status === 'cancelled') throw new NonRetryableError(`visual_run_${receipt.status}`);
      }
      return receipt;
    } catch (error) {
      if (receipt?.run_id) await step.do('record-failure', { retries: { limit: 3, delay: '20 seconds' } }, () => api(this.env, '/internal/visual-intelligence/fail', { run_id: receipt!.run_id, failed_stage: stage, failure_code: error instanceof Error ? error.message : 'workflow_failure' }));
      throw error;
    }
  }
}
export default {
  async fetch(request: Request, env: Env) {
    if (!auth(request, env)) return Response.json({ error: 'unauthorized' }, { status: 401 });
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/start') { const trigger = await request.json().catch(() => null); if (!validTrigger(trigger)) return Response.json({ error: 'invalid_trigger' }, { status: 400 }); await env.VISUAL_TRIGGER_QUEUE.send(trigger); return Response.json({ ok: true, queued: true, job_id: trigger.job_id }, { status: 202 }); }
    if (request.method === 'GET' && url.pathname === '/artifact') {
      const key = url.searchParams.get('key') || ''; if (!key.startsWith('org/')) return Response.json({ error: 'invalid_artifact_key' }, { status: 400 });
      const object = await env.VISUAL_ARTIFACTS.get(key); if (!object) return Response.json({ error: 'artifact_not_found' }, { status: 404 });
      return new Response(object.body, { headers: { 'content-type': object.httpMetadata?.contentType || 'application/octet-stream', 'cache-control': 'private, no-store' } });
    }
    if (request.method === 'GET' && url.pathname === '/status') { const id = url.searchParams.get('instance_id'); if (!id) return Response.json({ error: 'instance_id_required' }, { status: 400 }); const instance = await env.VISUAL_WORKFLOW.get(id); return Response.json({ instance_id: id, status: await instance.status() }); }
    return Response.json({ error: 'not_found' }, { status: 404 });
  },
  async queue(batch: MessageBatch<Trigger>, env: Env) { for (const message of batch.messages) { try { if (!validTrigger(message.body) || !await enabled(env, message.body)) throw new NonRetryableError('visual_feature_disabled_or_invalid_trigger'); const id = instanceId(message.body); try { await env.VISUAL_WORKFLOW.create({ id, params: message.body, retention: { successRetention: '30 days', errorRetention: '30 days' } }); } catch { const instance = await env.VISUAL_WORKFLOW.get(id); const state = await instance.status(); if (state.status === 'errored' || state.status === 'terminated') await instance.restart(); } message.ack(); } catch (error) { if (error instanceof NonRetryableError) message.ack(); else message.retry(); } } },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil((async () => {
      const eligible = await api(env, '/internal/visual-intelligence/day2/eligible', { limit: 25 });
      let queued = 0;
      for (const candidate of Array.isArray(eligible?.candidates) ? eligible.candidates : []) {
        // Evaluate before Core claims the complimentary Day-2 episode. This
        // keeps a flag-off tenant on the old path with no stuck queued state.
        const gateProbe = { job_id: '00000000-0000-4000-8000-000000000000', org_id: candidate?.org_id, user_id: candidate?.user_id, urls: [candidate?.url], mode: 'public', deliverable: 'brand_dna_v1', processing_version: 1, requested_at: new Date().toISOString() } as Trigger;
        if (!validTrigger(gateProbe) || !await enabled(env, gateProbe)) continue;
        const prepared = await api(env, '/internal/visual-intelligence/day2/prepare', candidate);
        if (prepared?.ok) queued += 1;
      }
      console.log(JSON.stringify({ event: 'visual_day2_reconciliation_complete', queued }));
    })());
  },
} satisfies ExportedHandler<Env, Trigger>;
