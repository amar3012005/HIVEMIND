import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { STAGES, type Trigger, validBrandDna, validTrigger, instanceId } from './contract';

type Env = { VISUAL_WORKFLOW: Workflow<Trigger>; VISUAL_TRIGGER_QUEUE: Queue<Trigger>; VISUAL_ARTIFACTS: R2Bucket; FLAGS: Flagship; HIVEMIND_VISUAL_API_URL: string; HIVEMIND_VISUAL_WORKFLOW_SECRET: string; HIVEMIND_VISUAL_INSTANCE_PREFIX?: string; HIVEMIND_VISUAL_LOCAL_FLAG?: string };
type Receipt = { run_id: string; status?: string; artifact?: unknown; [key: string]: unknown };
type Capture = { page?: { url?: string; title?: string; [key: string]: unknown }; screenshot?: string | null };
const enabled = async (env: Env, trigger: Trigger) => {
  // Wrangler's local runtime currently reports Flagship bindings as unsupported.
  // Permit an explicit emulator-only switch so queue/workflow recovery can be
  // tested locally; deployed environments always evaluate Flagship below.
  if (env.HIVEMIND_VISUAL_INSTANCE_PREFIX === 'visual-local' && env.HIVEMIND_VISUAL_LOCAL_FLAG === 'true') return true;
  try { return (await env.FLAGS.getBooleanDetails('visual_intelligence_workflow_v1', false, { targetingKey: trigger.user_id, org_id: trigger.org_id })).value === true; }
  catch { return false; }
};
// Local Wrangler does not expose secret bindings to the Worker runtime. This
// value is intentionally non-secret and is accepted only by the isolated
// `visual-local` emulator; deployed Workers retain their service secret.
const credential = (env: Env) => env.HIVEMIND_VISUAL_INSTANCE_PREFIX === 'visual-local'
  ? 'local-dev-visual-workflow-only'
  : env.HIVEMIND_VISUAL_WORKFLOW_SECRET;
const auth = (request: Request, env: Env) => request.headers.get('authorization') === `Bearer ${credential(env)}`;
async function api(env: Env, path: string, body: unknown): Promise<any> {
  const response = await fetch(`${env.HIVEMIND_VISUAL_API_URL.replace(/\/$/, '')}${path}`, { method: 'POST', headers: { authorization: `Bearer ${credential(env)}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
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
    const { brand_logo: rawLogo, ...page } = row.page;
    let logo_r2_key: string | null = null;
    if (typeof rawLogo === 'string' && rawLogo) { const logo = decodeScreenshot(rawLogo); logo_r2_key = `org/${trigger.org_id}/runs/${runId}/brand/logo.png`; await env.VISUAL_ARTIFACTS.put(logo_r2_key, logo.bytes, { httpMetadata: { contentType: logo.contentType }, customMetadata: { org_id: trigger.org_id, run_id: runId, artifact_type: 'brand_logo' } }); }
    artifacts.push({ r2_key: key, ...(logo_r2_key ? { logo_r2_key } : {}), page_url: page.url, page, captured_at: new Date().toISOString() });
  }
  return api(env, '/internal/visual-intelligence/stage', { run_id: runId, stage: 'store', processing_version: trigger.processing_version, input: { artifacts } });
}
function escapeHtml(value: unknown) { return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character] || character)); }
function cell(label: string, value: unknown) { return String(value ?? '').trim() ? `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>` : ''; }
function bytesAsDataUri(contentType: string, bytes: Uint8Array) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return `data:${contentType};base64,${btoa(binary)}`;
}
async function reportLogo(env: Env, evidence: any[]) {
  const logoKey = evidence.find((entry: any) => typeof entry?.logo_r2_key === 'string')?.logo_r2_key;
  if (!logoKey) return '';
  const logo = await env.VISUAL_ARTIFACTS.get(logoKey);
  if (!logo || (logo.size || 0) > 500 * 1024) return '';
  return bytesAsDataUri(logo.httpMetadata?.contentType || 'image/png', new Uint8Array(await logo.arrayBuffer()));
}
async function renderedReport(env: Env, artifact: any) {
  const analysis = artifact?.analysis || {}; const identity = analysis.identity || {}; const voice = analysis.voice || {};
  const palette = analysis.palette || {}; const typography = analysis.typography || {}; const layout = analysis.layout || {}; const imagery = analysis.imagery || {};
  const brief = artifact?.visual_generation_brief || {}; const evidence = Array.isArray(artifact?.evidence) ? artifact.evidence : [];
  const name = identity.name || 'Brand'; const logo = await reportLogo(env, evidence);
  const swatches = [['Primary', palette.primary], ['Secondary', palette.secondary], ['Accent', palette.accent], ['Background', palette.background]].filter(([, value]) => typeof value === 'string' && value).map(([label, value]) => `<div class="swatch"><i style="background:${escapeHtml(value)}"></i><b>${escapeHtml(label)}</b><small>${escapeHtml(value)}</small></div>`).join('');
  const detailRows = `${cell('Tone', voice.tone)}${cell('Voice', voice.style)}${cell('Heading type', typography.headings)}${cell('Body type', typography.body)}${cell('Interface', layout.structure)}${cell('Navigation', layout.navigation)}`;
  const briefItems = Array.isArray(brief.elements) ? brief.elements.map((item: any) => typeof item === 'string' ? item : `${item?.type || 'element'}: ${item?.content || ''}`).filter(Boolean).map((item: string) => `<li>${escapeHtml(item)}</li>`).join('') : '';
  const evidenceRows = evidence.map((entry: any, index: number) => `<article class="evidence"><span class="number">${String(index + 1).padStart(2, '0')}</span><div><h3>${escapeHtml(entry?.page?.title || entry?.page_url || 'Captured page')}</h3><p>${escapeHtml(entry?.page_url || entry?.page?.url || '')}</p><small>Captured ${escapeHtml(entry?.captured_at || entry?.page?.captured_at || '')} · Screenshot retained</small></div></article>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(name)} — Brand DNA</title><style>:root{--ink:#171717;--paper:#faf9f6;--line:#deddd8;--blue:#2774c7;--muted:#64635f}*{box-sizing:border-box}body{margin:0;background:#ecebe7;color:var(--ink);font:14px/1.55 Arial,Helvetica,sans-serif}.page{max-width:900px;margin:0 auto;background:var(--paper);padding:38px 42px 64px}.mast{display:flex;justify-content:space-between;align-items:end;border:1px solid var(--line);padding:14px 18px}.wordmark{font-size:17px;font-weight:800;letter-spacing:.04em}.sub,.eyebrow{font:700 8px/1.3 ui-monospace,monospace;letter-spacing:.17em;text-transform:uppercase}.sub{color:var(--muted)}.eyebrow{color:var(--blue);margin:25px 0 8px}.hero{display:grid;grid-template-columns:1.15fr .85fr;border:1px solid var(--line);border-top:0;min-height:232px}.hero-main{padding:28px}.brand-mark{width:72px;height:54px;object-fit:contain;object-position:left center;display:block;margin-bottom:16px}.logo-word{font-weight:800;font-size:15px;letter-spacing:.04em;margin-bottom:18px}h1{font-size:36px;line-height:1.03;letter-spacing:-.06em;margin:0 0 12px;max-width:420px}h2{font-size:18px;letter-spacing:-.03em;margin:0 0 12px}h3{font-size:13px;margin:0 0 4px}.hero-aside{border-left:1px solid var(--line);padding:27px 24px;background:#f3f2ef}.hero-aside ul{margin:10px 0 0;padding-left:18px;font-weight:600}.hero-aside li{margin:3px 0}.section{margin-top:24px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.card{border:1px solid var(--line);padding:20px;background:#fff}.palette{display:flex;gap:9px;flex-wrap:wrap}.swatch{width:112px;font-size:10px}.swatch i{display:block;height:56px;border:1px solid #ccc;margin-bottom:6px}.swatch b,.swatch small{display:block}.swatch small{color:var(--muted)}table{border-collapse:collapse;width:100%;font-size:12px}th,td{padding:8px 0;border-bottom:1px solid var(--line);vertical-align:top;text-align:left}th{font-weight:700;width:34%;color:#444}.brief{background:#101010;color:#fff;border:1px solid #101010}.brief .eyebrow{color:#83b6ed;margin-top:0}.brief ul{columns:2;padding-left:17px;margin:10px 0 0}.brief li{margin:4px 0}.evidence{display:flex;gap:14px;border-top:1px solid var(--line);padding:13px 0}.number{font:700 10px ui-monospace,monospace;color:var(--blue)}.evidence p{margin:0;color:var(--muted);word-break:break-word;font-size:11px}.evidence small{color:var(--muted)}.footer{margin-top:30px;padding-top:12px;border-top:1px solid var(--line);font-size:10px;color:var(--muted)}@media(max-width:620px){.page{padding:18px}.hero,.grid{grid-template-columns:1fr}.hero-aside{border-left:0;border-top:1px solid var(--line)}h1{font-size:31px}.brief ul{columns:1}}</style></head><body><main class="page"><header class="mast"><div><div class="wordmark">SINGULANCE</div><div class="sub">HyperAgents Operating System</div></div><div class="sub">Day 2 · Brand DNA Ready</div></header><section class="hero"><div class="hero-main">${logo ? `<img class="brand-mark" src="${logo}" alt="${escapeHtml(name)} logo">` : `<div class="logo-word">${escapeHtml(name)}</div>`}<div class="eyebrow">Verified website profile</div><h1>${escapeHtml(name)}<br>Brand DNA</h1>${identity.tagline ? `<p>${escapeHtml(identity.tagline)}</p>` : ''}</div><aside class="hero-aside"><div class="eyebrow">Visual essence</div><ul>${[voice.tone, voice.style, imagery.style, layout.structure].filter(Boolean).map((value: unknown) => `<li>${escapeHtml(value)}</li>`).join('') || '<li>Derived from captured first-party pages</li>'}</ul></aside></section><section class="section"><div class="eyebrow">Visual system</div><div class="grid"><div class="card"><h2>Color palette</h2><div class="palette">${swatches || '<small>No reliable palette was inferred.</small>'}</div></div><div class="card"><h2>Typography & interface</h2><table>${detailRows || '<tr><td>Not confidently inferred from captured pages.</td></tr>'}</table></div></div></section><section class="section grid"><div class="card"><div class="eyebrow">Photography & composition</div><h2>${escapeHtml(imagery.style || 'Captured visual direction')}</h2>${imagery.content ? `<p>${escapeHtml(imagery.content)}</p>` : '<p>Use the stored screenshots as the evidence reference for art direction.</p>'}</div><div class="card"><div class="eyebrow">Brand voice</div><h2>${escapeHtml(voice.tone || 'Evidence-led')}</h2><p>${escapeHtml(voice.style || 'Apply only the style demonstrated on the captured public pages.')}</p></div></section><section class="section card brief"><div class="eyebrow">Reusable visual-artifact brief</div><h2>${escapeHtml(brief.style || 'Use this verified Brand DNA as the visual reference.')}</h2>${briefItems ? `<ul>${briefItems}</ul>` : '<p>Use the evidence ledger and captured visual system for the next creative brief.</p>'}</section><section class="section"><div class="eyebrow">Evidence ledger</div><h2>What the agents captured</h2>${evidenceRows || '<p>No browser evidence was retained.</p>'}</section><footer class="footer">Generated ${escapeHtml(artifact?.generated_at || '')} · ${escapeHtml(artifact?.version || 'brand-dna-v1')} · Claims are limited to captured first-party website evidence. Revalidate time-sensitive details before publication.</footer></main></body></html>`;
}
async function renderAndStore(env: Env, trigger: Trigger, runId: string, artifact: any) {
  const html = await renderedReport(env, artifact);
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
