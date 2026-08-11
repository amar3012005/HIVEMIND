import { getGrowthOperatingState } from '../growth/operating-loop.js';
import { getLatestGrowthPlan } from '../growth/planner.js';
import { getConnectedCapabilities, getPlatformManagedCapabilities } from './instruction-loop.js';

function identity(value = {}) {
  const company = value && typeof value === 'object' ? value : {};
  const profile = company.profile && typeof company.profile === 'object' ? company.profile : {};
  const name = String(company.company || company.name || profile.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const website = String(company.website || profile.website || '');
  let domain = '';
  try { domain = new URL(website.includes('://') ? website : `https://${website}`).hostname.toLowerCase().replace(/^www\./, ''); } catch { /* unknown */ }
  return { name, domain, onboarded_at: company.onboarded_at || null };
}

function baselineIdentity(payload = {}) {
  const company = payload?.company && typeof payload.company === 'object' ? payload.company : {};
  const name = String(company.name || company.company || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const website = String(company.website || company.website_url || payload?.website?.url || '');
  let domain = '';
  try { domain = new URL(website.includes('://') ? website : `https://${website}`).hostname.toLowerCase().replace(/^www\./, ''); } catch { /* unknown */ }
  return { name, domain };
}

export async function buildHqContext({ prisma, runtime, trigger }) {
  const [growth, planArtifact, pendingWork, pendingApprovals, companyRows, connectedCapabilities] = await Promise.all([
    getGrowthOperatingState({ prisma, orgId: runtime.orgId }),
    getLatestGrowthPlan({ prisma, orgId: runtime.orgId }),
    prisma.hyperWorkOrder.findMany({
      where: { orgId: runtime.orgId, status: { in: ['queued', 'running', 'blocked'] } },
      orderBy: { createdAt: 'asc' }, take: 20,
      select: { id: true, hqCycleId: true, kind: true, status: true, title: true, objective: true, ownerSlug: true, roomId: true, evidenceRefs: true, updatedAt: true },
    }),
    prisma.pendingWrite.findMany({
      where: { orgId: runtime.orgId, status: 'draft' }, orderBy: { createdAt: 'asc' }, take: 20,
      select: { id: true, provider: true, toolGroup: true, toolName: true, preview: true, createdAt: true, expiresAt: true },
    }).catch(() => []),
    prisma.$queryRawUnsafe(
      `SELECT agent_connectors->'_company' AS company
         FROM hivemind.hyper_rooms
        WHERE org_id=$1::uuid AND archived_at IS NULL AND agent_connectors ? '_company'
        ORDER BY (room_tag='general') DESC, updated_at DESC LIMIT 1`, runtime.orgId,
    ).catch(() => []),
    getConnectedCapabilities({ prisma, runtime }),
  ]);
  const company = companyRows[0]?.company || {};
  const canonicalIdentity = identity(company);
  const observedIdentity = baselineIdentity(growth.baseline?.payload || {});
  const baselineCreatedAt = growth.baseline?.createdAt ? new Date(growth.baseline.createdAt) : null;
  const onboardedAt = canonicalIdentity.onboarded_at ? new Date(canonicalIdentity.onboarded_at) : null;
  const identityMatches = !canonicalIdentity.domain || !observedIdentity.domain
    ? (!canonicalIdentity.name || !observedIdentity.name || canonicalIdentity.name === observedIdentity.name)
    : canonicalIdentity.domain === observedIdentity.domain;
  const baselineIsCurrent = !(baselineCreatedAt && onboardedAt) || baselineCreatedAt >= onboardedAt;
  const baselineId = growth.baseline?.id || null;
  const planBaselineId = planArtifact?.payload?.plan?.baseline_ref?.resource_id || planArtifact?.metadata?.baseline_id || null;
  const currentPlan = baselineId && planBaselineId === baselineId ? planArtifact : null;
  return {
    contract: 'hq-context.v1',
    runtime: {
      id: runtime.id, objective: runtime.objective, state: runtime.state,
      authority_policy: runtime.authorityPolicy, active_goal_id: runtime.activeGoalId,
      active_stage_id: runtime.activeStageId, next_wake_at: runtime.nextWakeAt,
    },
    trigger,
    capabilities: {
      connected: [...connectedCapabilities],
      platform_managed: [...getPlatformManagedCapabilities()],
    },
    company,
    growth: {
      active_goal: growth.goals.find((goal) => goal.status === 'ACTIVE') || null,
      active_stage: growth.stage,
      hypotheses: growth.hypotheses.slice(0, 10),
      delegations: growth.delegations.slice(0, 10),
      journal: growth.journal.slice(0, 12),
      next_action: growth.next_action,
    },
    evidence: {
      baseline: growth.baseline ? {
        id: growth.baseline.id,
        created_at: growth.baseline.createdAt,
        scope: growth.baseline.payload?.scope,
        as_of: growth.baseline.payload?.as_of,
        data_gaps: growth.baseline.payload?.data_gaps || [],
        website_pages: growth.baseline.payload?.website?.limitation
          || String(growth.baseline.payload?.website?.provider || '').toLowerCase() === 'fallback'
          ? null
          : Number.isFinite(Number(growth.baseline.payload?.website?.mapped_pages))
            ? Number(growth.baseline.payload.website.mapped_pages)
            : Array.isArray(growth.baseline.payload?.website?.pages)
              ? growth.baseline.payload.website.pages.length : null,
        social_accounts: Array.isArray(growth.baseline.payload?.social_presence?.accounts) ? growth.baseline.payload.social_presence.accounts.length : null,
        recent_posts: Array.isArray(growth.baseline.payload?.social_presence?.recent_posts) ? growth.baseline.payload.social_presence.recent_posts.length : null,
      } : null,
      latest_growth_plan: currentPlan ? { id: currentPlan.id, created_at: currentPlan.createdAt, mode: currentPlan.payload?.mode, constraint: currentPlan.payload?.plan?.constraint, stage: currentPlan.payload?.plan?.stage } : null,
      company_identity: {
        canonical: canonicalIdentity,
        baseline: observedIdentity,
        matches: identityMatches,
        current_onboarding: baselineIsCurrent,
      },
    },
    pending_work: pendingWork,
    pending_approvals: pendingApprovals,
  };
}
