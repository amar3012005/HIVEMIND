import crypto from 'crypto';

export const ONBOARDING_WEB_SOURCE = 'hyperagents-onboarding-web';

function text(value, max = 20_000) {
  return String(value || '').replace(/\u0000/g, '').trim().slice(0, max);
}

function safePage(page) {
  const url = text(page?.url, 2_000);
  const content = text(page?.content || page?.text, 20_000);
  if (!url || !content) return null;
  return {
    url,
    title: text(page?.title, 300) || url,
    description: text(page?.description, 1_000),
    content,
    links: [...new Set((Array.isArray(page?.links) ? page.links : [])
      .map((link) => text(link, 2_000)).filter(Boolean))].slice(0, 300),
    purpose: text(page?.purpose, 80) || 'company',
    provider: text(page?.provider, 80) || 'direct',
  };
}

export function onboardingWebArtifactPayload(page, { companyName = '', capturedAt = new Date().toISOString() } = {}) {
  const normalized = safePage(page);
  if (!normalized) return null;
  return {
    contract: 'hivemind.onboarding-web-artifact.v1',
    company_name: text(companyName, 180),
    captured_at: capturedAt,
    ...normalized,
  };
}

export async function persistOnboardingWebArtifacts({ prisma, orgId, userId, companyName, pages }) {
  const results = [];
  for (const page of (Array.isArray(pages) ? pages : []).slice(0, 12)) {
    const payload = onboardingWebArtifactPayload(page, { companyName });
    if (!payload) continue;
    const canonical = JSON.stringify(payload);
    const checksum = crypto.createHash('sha256').update(canonical).digest('hex');
    let artifact = await prisma.sourceArtifact.findFirst({
      where: { userId, orgId, checksum, sourcePlatform: ONBOARDING_WEB_SOURCE },
      select: { id: true, createdAt: true },
    });
    if (!artifact) {
      artifact = await prisma.sourceArtifact.create({
        data: {
          userId,
          orgId,
          artifactType: 'web_crawl',
          sourcePlatform: ONBOARDING_WEB_SOURCE,
          sourceId: payload.url,
          sourceUrl: payload.url,
          contentType: 'text/markdown; charset=utf-8',
          sizeBytes: Buffer.byteLength(payload.content, 'utf8'),
          checksum,
          storageLocation: 'inline:source_artifacts.payload',
          payload,
          metadata: {
            contract: payload.contract,
            company_name: payload.company_name,
            purpose: payload.purpose,
            provider: payload.provider,
          },
        },
        select: { id: true, createdAt: true },
      });
    }
    results.push({
      id: artifact.id,
      title: payload.title,
      url: payload.url,
      purpose: payload.purpose,
      provider: payload.provider,
      captured_at: payload.captured_at,
      content_chars: payload.content.length,
      link_count: payload.links.length,
      preview_url: `/v1/hyper/company/web-artifacts/${artifact.id}/preview`,
    });
  }
  return results;
}

export async function readOnboardingWebArtifact({ prisma, artifactId, orgId }) {
  return prisma.sourceArtifact.findFirst({
    where: { id: artifactId, orgId, sourcePlatform: ONBOARDING_WEB_SOURCE },
    select: { id: true, sourceUrl: true, contentType: true, payload: true, metadata: true, createdAt: true },
  });
}

export function renderOnboardingWebArtifactPreview(artifact) {
  const payload = artifact?.payload && typeof artifact.payload === 'object' ? artifact.payload : {};
  const escape = (value) => String(value || '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
  const links = (Array.isArray(payload.links) ? payload.links : []).slice(0, 100)
    .map((link) => `<li><a href="${escape(link)}" target="_blank" rel="noreferrer">${escape(link)}</a></li>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(payload.title || 'Website crawl')}</title><style>body{margin:0;background:#f7f6f2;color:#171717;font:14px/1.65 ui-monospace,SFMono-Regular,Menlo,monospace}.shell{max-width:1040px;margin:0 auto;padding:40px 28px 80px}.eyebrow{color:#1677ff;font-size:11px;letter-spacing:.14em;text-transform:uppercase}h1{font:600 32px/1.15 system-ui,sans-serif;margin:10px 0}.meta{color:#737373;margin-bottom:28px}.source{display:inline-block;color:#1677ff;overflow-wrap:anywhere}.panel{background:#fff;border:1px solid #ddd9d1;border-radius:12px;padding:24px;box-shadow:0 8px 30px rgba(0,0,0,.04)}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;margin:0}.links{margin-top:28px}li{margin:6px 0}a{color:#155fc5}</style></head><body><main class="shell"><div class="eyebrow">HIVEMIND · ONBOARDING WEB ARTIFACT</div><h1>${escape(payload.title || payload.url)}</h1><div class="meta">Captured ${escape(payload.captured_at)} · ${escape(payload.provider)} · ${escape(payload.purpose)}<br><a class="source" href="${escape(payload.url)}" target="_blank" rel="noreferrer">${escape(payload.url)}</a></div><section class="panel"><pre>${escape(payload.content)}</pre></section>${links ? `<section class="links"><div class="eyebrow">LINKS OBSERVED</div><ul>${links}</ul></section>` : ''}</main></body></html>`;
}
