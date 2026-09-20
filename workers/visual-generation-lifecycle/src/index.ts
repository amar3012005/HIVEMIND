import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { assetPrefix, dimensionsForAspect, imageContentType, safeProductionSpec, type VisualTrigger, validTrigger, workflowInstanceId } from './contract';

type Env = {
  VISUAL_GENERATION_WORKFLOW: Workflow<VisualTrigger>; VISUAL_GENERATION_QUEUE: Queue<VisualTrigger>; VISUAL_ASSETS: R2Bucket; AI: Ai;
  HIVEMIND_VISUAL_API_URL: string; HIVEMIND_VISUAL_GENERATION_SECRET: string; VISUAL_ART_DIRECTOR_MODEL?: string; VISUAL_CRITIC_MODEL?: string;
  VISUAL_FAST_MODEL?: string; VISUAL_QUALITY_MODEL?: string; AI_GATEWAY_ID?: string;
};
type ContextReceipt = { job: any; request: any; company_context: any; brand_dna: any; website_visual_reference?: { kind?: string; path?: string } | null };
type Generated = { bytes: Uint8Array; contentType: string; model: string; prompt: string };
type StoredGenerated = { r2_key: string; content_type: string; content_hash: string; model: string; prompt_hash: string };

function auth(request: Request, env: Env) { return request.headers.get('authorization') === `Bearer ${env.HIVEMIND_VISUAL_GENERATION_SECRET}`; }
async function core(env: Env, path: string, body: unknown) {
  const response = await fetch(`${env.HIVEMIND_VISUAL_API_URL.replace(/\/$/, '')}${path}`, { method: 'POST', headers: { authorization: `Bearer ${env.HIVEMIND_VISUAL_GENERATION_SECRET}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json().catch(() => ({})) as any;
  if (!response.ok) {
    if ([400, 401, 403, 404, 409, 422].includes(response.status) || result.retryable === false) throw new NonRetryableError(result.error || `visual_core_${response.status}`);
    throw new Error(result.error || `visual_core_${response.status}`);
  }
  return result;
}
async function report(env: Env, trigger: VisualTrigger, eventKey: string, stage: string, progress: number, message: string, data: any = {}) {
  return core(env, '/internal/visual-generation/event', { job_id: trigger.job_id, event_key: eventKey, stage, progress, message, data });
}
function parseJson(value: unknown) {
  const text = typeof value === 'string' ? value : String((value as any)?.response || (value as any)?.result?.response || '');
  const match = text.match(/\{[\s\S]*\}/); if (!match) return {};
  try { return JSON.parse(match[0]); } catch { return {}; }
}
function artDirectionPrompt(context: ContextReceipt) {
  return `You are the SINGULANCE Visual Production Director. Convert the supplied request and verified company evidence into one production-ready JSON art-direction contract. Be specific enough that an image model can execute it without interpretation. Use only verified Brand DNA and company facts; never invent a logo, product, customer, award, statistic, interface, or outcome claim. Prefer a concrete subject, scene, composition, camera/lens, lighting, materials, palette and emotional tone. Generated imagery must contain no words, letters, numbers, watermarks, captions, UI labels, or pseudo-text; exact brand marks and copy are composed later. For a set, define coordinated but meaningfully different variants that all share one visual system. Return JSON only with: communication_objective, audience, subject, scene, composition, camera, lighting, materials, palette, emotional_tone, brand_rules[], required_elements[], forbidden_elements[], unsupported_claims[], text_policy, master_prompt, variants:[{purpose,variation}].\nINPUT:\n${JSON.stringify(context).slice(0, 45_000)}`;
}
function finalPrompt(spec: any, variant: any, useAnchor: boolean) {
  return [
    spec.master_prompt, `Communication objective: ${spec.communication_objective}.`, `Audience: ${spec.audience}.`, `Subject and scene: ${spec.subject}. ${spec.scene}.`,
    `Composition: ${spec.composition}. Camera: ${spec.camera}. Lighting: ${spec.lighting}. Materials: ${spec.materials}.`,
    `Palette and tone: ${spec.palette}. ${spec.emotional_tone}.`, variant?.variation ? `This output variation: ${variant.variation}.` : '',
    spec.required_elements?.length ? `Required elements: ${spec.required_elements.join('; ')}.` : '', spec.brand_rules?.length ? `Brand rules: ${spec.brand_rules.join('; ')}.` : '',
    `Do not include: ${[...(spec.forbidden_elements || []), ...(spec.unsupported_claims || [])].join('; ') || 'fabricated brand marks, statistics, customers, awards, interfaces, or claims'}.`,
    'No words, letters, numbers, logos, captions, watermarks, UI labels, or pseudo-text. Professional campaign art direction, intentional hierarchy, realistic materials and lighting, immediately usable visual quality.',
    useAnchor ? 'Use input image 0 only as the shared art-direction, palette, lighting, and material reference. Preserve the visual system but create a distinct high-resolution composition.' : '',
  ].filter(Boolean).join('\n');
}
async function aiText(env: Env, prompt: string) {
  const model = env.VISUAL_ART_DIRECTOR_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
  const result = await (env.AI as any).run(model, { messages: [{ role: 'system', content: 'Return strict JSON only.' }, { role: 'user', content: prompt }], temperature: 0.2, max_tokens: 2200 }, env.AI_GATEWAY_ID ? { gateway: { id: env.AI_GATEWAY_ID } } : undefined);
  return { model, value: parseJson(result) };
}
async function resultBytes(result: any): Promise<{ bytes: Uint8Array; contentType: string }> {
  if (result instanceof Response) { const bytes = new Uint8Array(await result.arrayBuffer()); return { bytes, contentType: imageContentType(bytes, result.headers.get('content-type') || '') }; }
  if (result instanceof ReadableStream) { const bytes = new Uint8Array(await new Response(result).arrayBuffer()); return { bytes, contentType: imageContentType(bytes) }; }
  const encoded = result?.image || result?.result?.image || result?.data?.[0]?.b64_json;
  if (typeof encoded === 'string') {
    const raw = encoded.includes(',') ? encoded.slice(encoded.indexOf(',') + 1) : encoded; const binary = atob(raw);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0)); return { bytes, contentType: imageContentType(bytes) };
  }
  throw new Error('visual_model_empty_response');
}
async function generate(env: Env, prompt: string, aspect: string, quality: string, references: Generated[] = []): Promise<Generated> {
  const model = quality === 'fast' ? (env.VISUAL_FAST_MODEL || '@cf/black-forest-labs/flux-2-klein-4b') : (env.VISUAL_QUALITY_MODEL || '@cf/black-forest-labs/flux-2-klein-9b');
  const dimensions = dimensionsForAspect(aspect, false); const form = new FormData();
  form.append('prompt', prompt); form.append('width', String(dimensions.width)); form.append('height', String(dimensions.height));
  for (const [index, reference] of references.slice(0, 3).entries()) {
    if (!reference?.bytes.length) continue;
    const extension = reference.contentType === 'image/jpeg' ? 'jpg' : reference.contentType === 'image/webp' ? 'webp' : 'png';
    form.append(`input_image_${index}`, new Blob([new Uint8Array(reference.bytes).buffer as ArrayBuffer], { type: reference.contentType }), `reference-${index}.${extension}`);
  }
  const serialized = new Response(form); const result = await (env.AI as any).run(model, { multipart: { body: serialized.body, contentType: serialized.headers.get('content-type') } }, env.AI_GATEWAY_ID ? { gateway: { id: env.AI_GATEWAY_ID } } : undefined);
  const image = await resultBytes(result); if (!image.bytes.length || image.bytes.length > 15 * 1024 * 1024) throw new Error('visual_model_invalid_image_size');
  return { ...image, model, prompt };
}
function decodeDataImage(value: unknown): Generated | null {
  const match = String(value || '').match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/i);
  if (!match) return null;
  const binary = atob(match[2]);
  return { bytes: Uint8Array.from(binary, (char) => char.charCodeAt(0)), contentType: match[1].toLowerCase(), model: 'captured-first-party-evidence', prompt: '' };
}
function imageDataUrl(image: Generated) {
  let binary = ''; for (let offset = 0; offset < image.bytes.length; offset += 0x8000) binary += String.fromCharCode(...image.bytes.subarray(offset, offset + 0x8000));
  return `data:${image.contentType};base64,${btoa(binary)}`;
}
function composeExactLogo(image: Generated, logo: Generated | null, aspect: string): Generated {
  if (!logo?.bytes.length) return image;
  const dimensions = dimensionsForAspect(aspect, false);
  const logoWidth = Math.round(dimensions.width * 0.16); const padding = Math.round(dimensions.width * 0.045);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${dimensions.width}" height="${dimensions.height}" viewBox="0 0 ${dimensions.width} ${dimensions.height}"><image href="${imageDataUrl(image)}" width="${dimensions.width}" height="${dimensions.height}"/><image href="${imageDataUrl(logo)}" x="${padding}" y="${padding}" width="${logoWidth}" height="${Math.round(dimensions.height * 0.1)}" preserveAspectRatio="xMinYMin meet"/></svg>`;
  return { bytes: new TextEncoder().encode(svg), contentType: 'image/svg+xml', model: `${image.model}+verified-logo-overlay`, prompt: image.prompt };
}
async function brandReferences(env: Env, context: ContextReceipt): Promise<Generated[]> {
  const evidence = Array.isArray(context.brand_dna?.evidence) ? context.brand_dna.evidence : [];
  const references: Generated[] = [];
  for (const row of evidence.slice(0, 3)) {
    const key = String(row?.r2_key || '');
    if (key) {
      const object = await env.VISUAL_ASSETS.get(key).catch(() => null);
      if (object) references.push({ bytes: new Uint8Array(await object.arrayBuffer()), contentType: object.httpMetadata?.contentType || 'image/png', model: 'captured-first-party-evidence', prompt: '' });
    }
    const logo = decodeDataImage(row?.page?.brand_logo);
    if (logo && references.length < 3) references.push(logo);
  }
  return references.slice(0, 3);
}
function officialLogo(context: ContextReceipt): Generated | null {
  const evidence = Array.isArray(context.brand_dna?.evidence) ? context.brand_dna.evidence : [];
  for (const row of evidence) { const logo = decodeDataImage(row?.page?.brand_logo); if (logo) return logo; }
  return null;
}
async function websiteFallbackReference(env: Env, context: ContextReceipt): Promise<Generated | null> {
  const path = String(context.website_visual_reference?.path || '');
  if (!path.startsWith('/internal/visual-generation/reference?')) return null;
  const response = await fetch(`${env.HIVEMIND_VISUAL_API_URL.replace(/\/$/, '')}${path}`, { headers: { authorization: `Bearer ${env.HIVEMIND_VISUAL_GENERATION_SECRET}` } });
  if (!response.ok) return null;
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 5 * 1024 * 1024) return null;
  return { bytes, contentType: imageContentType(bytes, response.headers.get('content-type') || ''), model: 'browser-rendered-homepage', prompt: '' };
}
async function generateAnchor(env: Env, prompt: string, quality: string): Promise<Generated> {
  const model = quality === 'fast' ? (env.VISUAL_FAST_MODEL || '@cf/black-forest-labs/flux-2-klein-4b') : (env.VISUAL_QUALITY_MODEL || '@cf/black-forest-labs/flux-2-klein-9b');
  const form = new FormData(); form.append('prompt', `${prompt}\nCreate a square visual-system anchor: composition, palette, lighting, materials and subject language only. No text or logos.`); form.append('width', '504'); form.append('height', '504');
  const serialized = new Response(form); const result = await (env.AI as any).run(model, { multipart: { body: serialized.body, contentType: serialized.headers.get('content-type') } }, env.AI_GATEWAY_ID ? { gateway: { id: env.AI_GATEWAY_ID } } : undefined);
  const image = await resultBytes(result); return { ...image, model, prompt };
}
async function critique(env: Env, image: Generated, spec: any) {
  const model = env.VISUAL_CRITIC_MODEL || '@cf/meta/llama-3.2-11b-vision-instruct';
  let binary = ''; for (let offset = 0; offset < image.bytes.length; offset += 0x8000) binary += String.fromCharCode(...image.bytes.subarray(offset, offset + 0x8000));
  const dataUri = `data:${image.contentType};base64,${btoa(binary)}`;
  try {
    const result = await (env.AI as any).run(model, {
      messages: [
        { role: 'system', content: 'Return strict JSON only.' },
        { role: 'user', content: `Act as a strict senior visual-design critic. Inspect every visible pixel before deciding. This asset must be rejected if it contains any readable or pseudo-readable word, letter, number, caption, UI label, watermark, brand name, logo, signature, or glyph. Exact official marks are applied only after this check, outside the generated pixels. When uncertain, treat it as present. Return JSON only: {score,needs_revision,contains_visible_text_or_mark,revision_instruction,findings}. Contract: ${JSON.stringify(spec).slice(0, 12_000)}` },
      ],
      image: dataUri,
      max_tokens: 900,
      temperature: 0,
    }, env.AI_GATEWAY_ID ? { gateway: { id: env.AI_GATEWAY_ID } } : undefined);
    const parsed = parseJson(result); const textOrMark = parsed.contains_visible_text_or_mark === true;
    return { model, score: Math.max(0, Math.min(100, Number(parsed.score) || 0)), needs_revision: parsed.needs_revision === true || textOrMark || Number(parsed.score) < 75, contains_visible_text_or_mark: textOrMark, revision_instruction: String(parsed.revision_instruction || '').slice(0, 1200), findings: parsed.findings || [] };
  } catch (error) { return { model, score: null, needs_revision: false, revision_instruction: '', findings: [], warning: error instanceof Error ? error.message : 'critic_unavailable' }; }
}
async function hash(bytes: Uint8Array) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer as ArrayBuffer))].map((value) => value.toString(16).padStart(2, '0')).join(''); }
async function storeGenerated(env: Env, trigger: VisualTrigger, generated: Generated, key: string, role: string): Promise<StoredGenerated> {
  const extension = generated.contentType === 'image/jpeg' ? 'jpg' : generated.contentType === 'image/webp' ? 'webp' : generated.contentType === 'image/svg+xml' ? 'svg' : 'png';
  const resolvedKey = key.replace(/\.(?:png|jpe?g|webp)$/i, `.${extension}`);
  const digest = await hash(generated.bytes);
  await env.VISUAL_ASSETS.put(resolvedKey, generated.bytes, { httpMetadata: { contentType: generated.contentType }, customMetadata: { org_id: trigger.org_id, job_id: trigger.job_id, asset_role: role, content_hash: digest, model: generated.model } });
  return { r2_key: resolvedKey, content_type: generated.contentType, content_hash: digest, model: generated.model, prompt_hash: await hash(new TextEncoder().encode(generated.prompt)) };
}
async function loadGenerated(env: Env, stored: StoredGenerated): Promise<Generated> {
  const object = await env.VISUAL_ASSETS.get(stored.r2_key); if (!object) throw new Error('visual_working_asset_missing');
  return { bytes: new Uint8Array(await object.arrayBuffer()), contentType: stored.content_type, model: stored.model, prompt: '' };
}
async function store(env: Env, trigger: VisualTrigger, generated: Generated, index: number, aspect: string, role = 'output') {
  const stored = await storeGenerated(env, trigger, generated, `${assetPrefix(trigger)}assets/${String(index).padStart(2, '0')}.png`, role);
  return { asset_id: `${trigger.job_id}-${index}`, index, role, ...stored, aspect_ratio: aspect };
}

export class VisualGenerationWorkflow extends WorkflowEntrypoint<Env, VisualTrigger> {
  async run(event: WorkflowEvent<VisualTrigger>, step: WorkflowStep) {
    const trigger = event.payload; if (!validTrigger(trigger)) throw new NonRetryableError('invalid_visual_generation_trigger');
    let failedStage = 'context';
    try {
      const context = await step.do('hydrate-context', { retries: { limit: 8, delay: '10 seconds', backoff: 'exponential' }, timeout: '10 minutes' }, () => core(this.env, '/internal/visual-generation/context', { job_id: trigger.job_id, workflow_instance_id: event.instanceId })) as ContextReceipt;
      failedStage = 'art_direction';
      const direction = await step.do('art-direction', { retries: { limit: 5, delay: '15 seconds', backoff: 'exponential' }, timeout: '10 minutes' }, async () => {
        const generated = await aiText(this.env, artDirectionPrompt(context)); const brandStyle = JSON.stringify(context.brand_dna?.visual_generation_brief || {}).slice(0, 3000);
        return { model: generated.model, production_spec: safeProductionSpec(generated.value, { instruction: context.request.instruction, count: context.request.output.count, brandStyle }) };
      }) as any;
      await step.do('event-art-direction', () => report(this.env, trigger, 'art_direction', 'art_direction', 28, 'Creative direction and brand constraints are ready.', direction));
      const count = Number(context.request.output.count) || 1; const aspects = context.request.output.aspect_ratios || ['1:1'];
      const requestedQuality = context.request.quality || 'quality';
      const quality = context.request.model_policy === 'fast' ? 'fast' : context.request.model_policy === 'quality' ? 'quality' : requestedQuality;
      const evidence = await step.do('load-verified-visual-evidence', { retries: { limit: 3, delay: '10 seconds' }, timeout: '5 minutes' }, async () => {
        const dna = await brandReferences(this.env, context);
        if (dna.length) return dna;
        const homepage = await websiteFallbackReference(this.env, context);
        return homepage ? [homepage] : [];
      });
      const logo = officialLogo(context);
      await step.do('event-evidence', () => report(this.env, trigger, 'visual_evidence', 'context', 20, evidence.length ? 'Verified website visual evidence loaded for art direction.' : 'No verified visual reference was available; generating without inferred brand marks.', { reference_count: evidence.length, source: context.brand_dna?.run_id ? 'brand_dna_first_party_evidence' : (evidence.length ? 'browser_rendered_homepage' : 'none') }));
      let anchor: StoredGenerated | undefined;
      if (count > 1) {
        failedStage = 'generating_anchor';
        anchor = await step.do('generate-style-anchor', { retries: { limit: 6, delay: '20 seconds', backoff: 'exponential' }, timeout: '20 minutes' }, async () => {
          const prompt = `${finalPrompt(direction.production_spec, direction.production_spec.variants[0], false)}\nUse the verified visual references only for palette, material, and composition cues. Never redraw or imitate a logo.`;
          const generated = await generateAnchor(this.env, prompt, quality);
          return storeGenerated(this.env, trigger, generated, `${assetPrefix(trigger)}working/style-anchor.png`, 'style_anchor');
        }) as StoredGenerated;
        await step.do('event-anchor', () => report(this.env, trigger, 'generating_anchor', 'generating_anchor', 42, 'Shared visual-system anchor generated for the image set.', { model: anchor!.model }));
      }
      failedStage = 'generating_master';
      let masterWorking = await step.do('generate-master', { retries: { limit: 6, delay: '20 seconds', backoff: 'exponential' }, timeout: '20 minutes' }, async () => {
        const anchorReference = anchor ? await loadGenerated(this.env, anchor) : null;
        const generated = await generate(this.env, `${finalPrompt(direction.production_spec, direction.production_spec.variants[0], Boolean(anchor))}\nVerified visual evidence is available for style only; no logo reproduction.`, aspects[0], quality, [anchorReference, ...evidence].filter(Boolean) as Generated[]);
        return storeGenerated(this.env, trigger, generated, `${assetPrefix(trigger)}working/master.png`, 'master_working');
      }) as any;
      await step.do('event-master', () => report(this.env, trigger, 'generating_master', 'generating_master', 58, 'Master visual generated.', { model: masterWorking.model }));
      failedStage = 'critiquing';
      let review = await step.do('critique-master', { retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '10 minutes' }, async () => critique(this.env, await loadGenerated(this.env, masterWorking), direction.production_spec)) as any;
      await step.do('event-critique', () => report(this.env, trigger, 'critiquing', 'critiquing', 70, review.needs_revision ? 'Visual critic requested one bounded revision.' : 'Master visual passed the quality review.', review));
      if (review.needs_revision) masterWorking = await step.do('revise-master-once', { retries: { limit: 5, delay: '20 seconds', backoff: 'exponential' }, timeout: '20 minutes' }, async () => {
        const anchorReference = anchor ? await loadGenerated(this.env, anchor) : null;
        const generated = await generate(this.env, `${finalPrompt(direction.production_spec, direction.production_spec.variants[0], Boolean(anchor))}\nSenior critic correction: ${review.revision_instruction || 'Remove every word, letter, number, logo, watermark and pseudo-text while preserving a polished composition.'}`, aspects[0], quality, [anchorReference, ...evidence].filter(Boolean) as Generated[]);
        return storeGenerated(this.env, trigger, generated, `${assetPrefix(trigger)}working/master-revised.png`, 'master_working');
      }) as any;
      if (review.needs_revision) review = await step.do('critique-revised-master', { retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '10 minutes' }, async () => critique(this.env, await loadGenerated(this.env, masterWorking), direction.production_spec)) as any;
      if (review.needs_revision) throw new NonRetryableError(review.contains_visible_text_or_mark ? 'visual_contains_visible_text_or_mark' : 'visual_quality_rejected');
      const master = await step.do('compose-approved-master', async () => {
        const raw = await loadGenerated(this.env, masterWorking);
        return store(this.env, trigger, composeExactLogo(raw, logo, aspects[0]), 0, aspects[0], 'master');
      }) as any;
      const assets = [master] as any[];
      failedStage = 'generating_variants';
      for (let index = 1; index < count; index += 1) {
        const variant = await step.do(`generate-variant-${index}`, { retries: { limit: 6, delay: '20 seconds', backoff: 'exponential' }, timeout: '20 minutes' }, async () => {
          const anchorReference = anchor ? await loadGenerated(this.env, anchor) : null;
          const generated = await generate(this.env, `${finalPrompt(direction.production_spec, direction.production_spec.variants[index], Boolean(anchor))}\nVerified visual evidence is available for style only; no logo reproduction.`, aspects[index % aspects.length], quality, [anchorReference, ...evidence].filter(Boolean) as Generated[]);
          return store(this.env, trigger, composeExactLogo(generated, logo, aspects[index % aspects.length]), index, aspects[index % aspects.length], 'variant');
        }) as any;
        assets.push(variant);
        await step.do(`event-variant-${index}`, () => report(this.env, trigger, `variant_${index}`, 'generating_variants', 70 + Math.round(18 * (index / Math.max(1, count - 1))), `Visual ${index + 1} of ${count} generated.`, { index, model: variant.model }));
      }
      failedStage = 'storing';
      await step.do('event-stored', () => report(this.env, trigger, 'storing', 'storing', 94, 'Validated visual assets stored in tenant-scoped R2.', { asset_count: assets.length }));
      return step.do('complete', { retries: { limit: 8, delay: '10 seconds', backoff: 'exponential' }, timeout: '10 minutes' }, () => core(this.env, '/internal/visual-generation/complete', { job_id: trigger.job_id, production_spec: direction.production_spec, assets }));
    } catch (error) {
      await step.do('record-failure', { retries: { limit: 4, delay: '15 seconds' } }, () => core(this.env, '/internal/visual-generation/fail', { job_id: trigger.job_id, failed_stage: failedStage, failure_code: error instanceof Error ? error.message : 'visual_generation_failed' })).catch(() => null);
      throw error;
    }
  }
}

export default {
  async fetch(request: Request, env: Env) {
    if (!auth(request, env)) return Response.json({ error: 'unauthorized' }, { status: 401 }); const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/start') {
      const trigger = await request.json().catch(() => null); if (!validTrigger(trigger)) return Response.json({ error: 'invalid_trigger' }, { status: 400 });
      await env.VISUAL_GENERATION_QUEUE.send(trigger); return Response.json({ accepted: true, queued: true, job_id: trigger.job_id, instance_id: workflowInstanceId(trigger) }, { status: 202 });
    }
    if (request.method === 'GET' && url.pathname === '/status') { const id = url.searchParams.get('instance_id'); if (!id) return Response.json({ error: 'instance_id_required' }, { status: 400 }); const instance = await env.VISUAL_GENERATION_WORKFLOW.get(id); return Response.json({ instance_id: id, status: await instance.status() }); }
    if (request.method === 'GET' && url.pathname === '/artifact') { const key = url.searchParams.get('key') || ''; if (!key.startsWith('org/') || !key.includes('/visual-generation/')) return Response.json({ error: 'invalid_artifact_key' }, { status: 400 }); const object = await env.VISUAL_ASSETS.get(key); if (!object) return Response.json({ error: 'artifact_not_found' }, { status: 404 }); return new Response(object.body, { headers: { 'content-type': object.httpMetadata?.contentType || 'application/octet-stream', etag: object.httpEtag, 'cache-control': 'private, no-store' } }); }
    return Response.json({ error: 'not_found' }, { status: 404 });
  },
  async queue(batch: MessageBatch<VisualTrigger>, env: Env) {
    for (const message of batch.messages) {
      try {
        if (!validTrigger(message.body)) throw new NonRetryableError('invalid_visual_generation_trigger'); const id = workflowInstanceId(message.body);
        try { await env.VISUAL_GENERATION_WORKFLOW.create({ id, params: message.body, retention: { successRetention: '30 days', errorRetention: '30 days' } }); }
        catch { const instance = await env.VISUAL_GENERATION_WORKFLOW.get(id); const state = await instance.status(); if (state.status === 'errored' || state.status === 'terminated') await instance.restart(); }
        message.ack();
      } catch (error) { if (error instanceof NonRetryableError) message.ack(); else message.retry({ delaySeconds: 30 }); }
    }
  },
} satisfies ExportedHandler<Env, VisualTrigger>;
