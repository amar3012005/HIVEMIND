/** Read-only Day-0 evidence for a tenant-authenticated native Runtime. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { ONBOARDING_WEB_SOURCE, readOnboardingWebArtifact } from '../onboarding/web-artifacts.js';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const bounded = (value, max = 12000) => typeof value === 'string' ? value.slice(0, max) : null;
export async function readRuntimeOnboarding({ prisma, claims, sourceId, dataDir = process.env.HIVEMIND_DATA_DIR || '/app/data' }) {
  const member = await prisma.userOrganization.findUnique({ where: { userId_orgId: { userId: claims.sub, orgId: claims.org_id } }, select: { isActive: true } });
  if (!member?.isActive) return { status: 403, body: { error: 'organization_membership_required' } };
  if (!UUID.test(claims.org_id)) return { status: 403, body: { error: 'invalid_organization' } };
  if (sourceId === 'homepage-screenshot') {
    const root = path.join(dataDir, 'hyper-screenshots');
    let bytes;
    let visualPath = path.join(root, `${claims.org_id}.jpg`);
    let visualType = 'homepage_screenshot';
    try { bytes = await fs.readFile(visualPath); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      visualPath = path.join(root, `${claims.org_id}.image`);
      visualType = 'official_website_visual';
      try { bytes = await fs.readFile(visualPath); } catch (fallback) { if (fallback.code !== 'ENOENT') throw fallback; }
    }
    if (!bytes) return { status: 404, body: { error: 'retained_screenshot_unavailable' } };
    if (bytes.length > 1400 * 1024) return { status: 413, body: { error: 'retained_screenshot_too_large' } };
    return { status: 200, body: { ok: true, source_id: sourceId, media_type: bytes[0] === 0x89 && bytes[1] === 0x50 ? 'image/png' : bytes.toString('ascii', 0, 4) === 'RIFF' ? 'image/webp' : 'image/jpeg', base64: bytes.toString('base64'), title: visualType === 'homepage_screenshot' ? 'Day-0 homepage capture' : 'Day-0 retained official website visual', visual_type: visualType, captured_at: (await fs.stat(visualPath)).mtime.toISOString() } };
  }
  if (sourceId) {
    if (!UUID.test(sourceId)) return { status: 400, body: { error: 'invalid_source_id' } };
    const artifact = await readOnboardingWebArtifact({ prisma, orgId: claims.org_id, artifactId: sourceId });
    if (!artifact) return { status: 404, body: { error: 'onboarding_source_unavailable' } };
    const payload = artifact.payload || {};
    return { status: 200, body: { ok: true, source_id: artifact.id, source_url: artifact.sourceUrl, title: bounded(payload.title, 300), captured_at: payload.captured_at || artifact.createdAt, content: bounded(payload.content, 20000), provider: bounded(payload.provider, 100), purpose: bounded(payload.purpose, 100) } };
  }
  const rows = await prisma.$queryRawUnsafe(`SELECT "agent_connectors"->'_company' AS company FROM "hivemind"."hyper_rooms" WHERE org_id = $1::uuid AND archived_at IS NULL AND "agent_connectors" ? '_company' ORDER BY created_at DESC LIMIT 1`, claims.org_id);
  let company = rows[0]?.company;
  if (typeof company === 'string') company = JSON.parse(company);
  if (!company) return { status: 404, body: { error: 'company_onboarding_unavailable' } };
  const profile = company.profile && typeof company.profile === 'object' ? company.profile : {};
  const facts = {};
  for (const key of ['company', 'name', 'website', 'location', 'mission', 'positioning', 'icp', 'industry', 'business_model', 'offer', 'what_it_does', 'onboarded_at', 'company_context']) {
    const value = bounded(company[key] ?? profile[key]);
    if (value) facts[key] = value;
  }
  const artifacts = await prisma.sourceArtifact.findMany({ where: { orgId: claims.org_id, sourcePlatform: ONBOARDING_WEB_SOURCE }, select: { id: true, sourceUrl: true, createdAt: true, metadata: true }, orderBy: { createdAt: 'desc' }, take: 12 });
  let screenshotAvailable = false;
  let visualType = 'homepage_screenshot';
  try { await fs.access(path.join(dataDir, 'hyper-screenshots', `${claims.org_id}.jpg`)); screenshotAvailable = true; }
  catch {
    try { await fs.access(path.join(dataDir, 'hyper-screenshots', `${claims.org_id}.image`)); screenshotAvailable = true; visualType = 'official_website_visual'; } catch { /* unavailable is explicit */ }
  }
  return { status: 200, body: { ok: true, contract: 'hivemind.runtime-onboarding.v1', facts, sources: artifacts.map(item => ({ id: item.id, source_url: item.sourceUrl, captured_at: item.createdAt, kind: 'webpage' })), screenshot: { id: 'homepage-screenshot', available: screenshotAvailable, kind: 'image', visual_type: visualType } } };
}
