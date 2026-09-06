import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { getPrismaClient } from './db/prisma.js';
import {
  createPersistedApiKey,
  listPersistedApiKeys,
  revokePersistedApiKey
} from './auth/api-keys.js';
import { buildAllClientDescriptors, buildClientDescriptor } from './control-plane/descriptors.js';
import { ControlPlaneSessionStore, buildSessionCookie, verifySessionCookie } from './control-plane/session-store.js';
import {
  createPersonalInvitationLink,
  createSignupAdmission,
  invitationCodeMatches,
  verifyPersonalInvitationLink,
  verifySignupAdmission,
} from './control-plane/signup-admission.js';
import { parseOrigins, resolveTierCore } from './control-plane/tier-routing.js';
import { ZitadelOidcClient } from './control-plane/zitadel.js';
import { createZitadelEmailIdentity } from './control-plane/zitadel-email-identity.js';
import { createEmailIdentityService, EMAIL_AUTH_PUBLIC_RESPONSE, normalizeEmail, resolveEmailIdentityMode, safeReturnTo } from './auth/email-identity-service.js';
import { verifyEmailTurnstile as verifyEmailTurnstileResponse } from './auth/email-turnstile.js';
import { ConnectorStore } from './connectors/framework/connector-store.js';
import * as composioService from './connectors/composio/composio-service.js';
import { CONNECTOR_CATALOG as COMPOSIO_CONNECTOR_CATALOG } from './connectors/catalog.js';
import { provisionForPlan } from './vector/container-router.js';
import { SEAM_SCHEMA_VERSION, buildWorkRoomExecutionIdentity } from './contracts/hyper-seams.js';
import { memoryStorageLabel, memoryStorageModeFor } from './storage/memory-storage-policy.js';
import { registerEmbeddedAmrOrg, unregisterEmbeddedAmrOrg } from './storage/amr-registry.js';
import { PLANS } from './billing/plans.js';
import { createCatalogPlanVersion, listCatalogPlanHistory, listCatalogPlans } from './billing/plan-catalog-service.js';
import {
  activateOffer,
  buildReferralOffer,
  buildStandardOffer,
  claimReferralOffer,
  getEffectivePlan,
  normalizeLimitOverrides,
  normalizeReferralCampaignInput,
  normalizeReferralCode,
  publicReferralCampaign,
  redeemReferral,
} from './billing/entitlements.js';
import {
  amendEntitlementGrant,
  createPromotion,
  findPromotionForCode,
  grantPromotionToOrganization,
  listPromotions,
  normalizePromotionCode,
  redeemPromotion,
} from './billing/promotion-service.js';
import {
  createPartnerReferralCampaign,
  getPartnerReferralCampaign,
  listPartnerReferralCampaigns,
  markPartnerReferralDelivery,
  redeemPartnerReferral,
  resolvePartnerReferral,
} from './billing/partner-referral-service.js';
import { partnerReferralsEnabled } from './billing/partner-referral-feature.js';
import {
  activateEnterpriseRunway,
  createEnterpriseInvitation,
  extendEnterpriseInvitation,
  findEnterpriseInvitationAdmission,
  getEnterpriseInvitationPreview,
  markEnterpriseInvitationDelivery,
  publicEnterpriseInvitation,
  redeemEnterpriseInvitation,
  revokeEnterpriseInvitation,
  rotateEnterpriseInvitationSecrets,
  normalizeEnterpriseInvitationInput,
  updateEnterpriseInvitationMaxInvites,
} from './billing/enterprise-invitation-service.js';
import {
  publicAccessApplication,
  reviewAccessApplication,
  submitAccessApplication,
} from './billing/access-application-service.js';
import { computeRunwayQuote, buildRunwayOffer, normalizeRunwayConfig } from './billing/runway-pricing.js';
import { isValidEnterpriseAccessCode, normalizeEnterpriseAccessCode } from './billing/access-codes.js';
import { PlanEnforcer, planLimitBody } from './billing/plan-enforcer.js';
import { UsageTracker } from './billing/usage-tracker.js';
import { UsageService } from './billing/usage-service.js';
import { CreditService } from './billing/credit-service.js';
import { DOMAIN_ROOM_DEFINITIONS, ensureDomainRooms } from './employees/domain-rooms.js';
import {
  installConsoleCapture,
  getRecentLogs,
  getLogSummary,
} from './admin/live-log-store.js';
import { ROLES, effectiveRoles, hasPermission, assertPermission, canUsePrivilegedAgent } from './auth/permissions.js';
import { handleHermesRoutes } from './hermes/control-routes.js';
import { attachSsoContext, resolveSsoConfig } from './auth/sso-resolver.js';
import { handleScimRequest } from './scim/scim-router.js';
import { configureSystemEmailNotificationSink, renderTemplate, sendRenderedSystemEmail, sendSystemEmail, sendSystemEmailBatch, sendTeamInvitationEmails, queueEmailDelivery } from './email/email-service.js';
import { knowledgeWorkflowEnabled } from './knowledge/cloudflare-ingest-client.js';
import { queueMeetingFinalization } from './knowledge/meeting-finalization-worker.js';
import { addRealtimeParticipant, createRealtimeMeeting, refreshRealtimeParticipant } from './operating-room/realtimekit-client.js';
import { compactRoomContext, normalizeRoomText, roomProjection, wakeIntent } from './operating-room/room-contract.js';
import { renderPartnerReferralInvitation } from './email/templates/partner-referral-invitation.js';
import { renderHumationAvatarSvg } from './email/humation-avatar.js';
import { createSignupWelcomeDispatcher, welcomeProfileForWorkspace } from './email/signup-welcome-dispatcher.js';
import { ADMIN_EMAIL_SENDER_DOMAINS, ADMIN_EMAIL_TEMPLATES, normalizeAdminEmailMessage, renderAdminComposerMessage } from './email/admin-email-studio.js';
import { groqFetch } from './llm/groq-fallback.js';
import { discoverCompanyPages, discoverHttpLinks, fallbackDomainHires, selectCompanyResearchPages } from './onboarding/company-discovery.js';
import { buildCompanyOperatingContext, captureWebsiteScreenshot, captureWebsiteScreenshotWithPlaywright, extractCompanyContacts, firstPartyResearchDigest, isFirstPartyUrl, mergeCompanyResearchPages, normalizeCompanyProfile, researchCompanyWebsite, searchCompanyMarket, verifiedSocialProfiles } from './onboarding/company-research.js';
import { listGrowthBaselines, runGrowthBaseline } from './growth/baseline.js';
import { commitGrowthPlan, createGrowthGoal, getGrowthOperatingState } from './growth/operating-loop.js';
import { getLatestGrowthPlan, listGrowthPlans, runGrowthPlan } from './growth/planner.js';
import { createHqRuntimeRouteHandler } from './hq-runtime/routes.js';
import { previewApprovalToken, consumeApprovalToken } from './hq-runtime/approval-links.js';
import { activateHqAfterOnboarding, appendHqEvent, FIRST_LIFE_OBJECTIVE, resetHqForCompanyReplacement, scheduleHqWake } from './hq-runtime/repository.js';
import { startHqScheduler } from './hq-runtime/scheduler.js';
import { runtimeTransportStats } from './runtime-transport/client.js';
import { internalFetch } from './internal/internal-fetch.js';
import {
  getRuntimeRole,
  shouldRunRecurringMaintenanceJobs,
  shouldStartHttpServer,
} from './runtime/runtime-role.js';
import {
  handleHyperTurnStreamRoute,
  handleInternalHyperTurnEventRoute,
} from './routes/hyper-rooms.js';
import { readHyperArtifact } from './artifacts/hyper-artifacts.js';
import { getInternalApiKey, hasInternalApiKey, requireAdminSecret, requireSecret, requireSessionSecret } from './security/internal-auth.js';
import { createOutreachModule } from './outreach/campaigns.js';
import { validateDomain } from './web/web-policy.js';
import { getActiveOrganizationMembership, isOrganizationAdmin, requireSameOrganizationMember } from './workspace/access-policy.js';
import { resolveTenantAccess } from './auth/tenant-access.js';
import { createWorkspaceNotification } from './workspace/notifications.js';
import { createEmailNotificationSink } from './workspace/email-notification-projection.js';
import { resolveInvitationBaseUrl, resolvePublicAppUrl, resolvePublicFrontendBaseUrl } from './public-frontend-url.js';
import {
  deliverDayOneFirstMove,
  isAuthorizedDayOneRequest,
  isDayOneWorkflowEnabled,
  listEligibleDayOneCompanies,
  notifyDayOneWorkflowCompletion,
  prepareDayOneFirstMove,
  scheduleDayOneWorkflow,
} from './lifecycle/day1-first-move.js';
import { startDayZeroOnboardingReport } from './lifecycle/day0-onboarding-report.js';
import { DAY_ZERO_REPORT_VERSION } from './email/templates/day0-company-onboarding.js';
import {
  ACTIVATION_STAGES,
  activationReminderCopy,
  advanceActivationForEmail,
  claimActivationReminder,
  evaluateActivationReminder,
  isActivationLifecycleEnabled,
  isAuthorizedActivationLifecycleRequest,
  recordActivationReminder,
  releaseActivationReminderClaim,
  scheduleActivationWorkflow,
  startInvitationActivation,
} from './lifecycle/activation-lifecycle.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Welcome-email idempotency: send at most once per login session (not per page
// render). Keyed by sessionId; cleared naturally on process restart.
const _welcomedSessions = new Set();
const PROJECT_ROOT = path.join(__dirname, '..');

async function memoryBoxBrokerRequest(route, body) {
  const base = String(process.env.BYOD_BROKER_URL || 'http://byod-broker:8790').replace(/\/$/, '');
  const response = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(process.env.BYOD_BROKER_INTERNAL_TOKEN ? { 'x-hivemind-internal-token': process.env.BYOD_BROKER_INTERNAL_TOKEN } : {}),
    },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(5000),
  });
  const payload = await response.json().catch(() => ({ error: 'Memory Box broker returned an invalid response' }));
  return { status: response.status, payload };
}

function loadLocalEnv(envPath) {
  if (!fs.existsSync(envPath)) {
    return;
  }

  const lines = fs.readFileSync(envPath, 'utf-8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadLocalEnv(path.join(PROJECT_ROOT, '.env'));

// Import log capture for control plane
const { captureLogs: captureControlPlaneLogs, getLogBuffer: getControlPlaneLogBuffer } = await import('./log-streamer.js');
installConsoleCapture('control-plane');
captureControlPlaneLogs('hm-control');

const defaultAllowedOrigins = (process.env.HIVEMIND_CONTROL_PLANE_ALLOWED_ORIGINS
  || process.env.HIVEMIND_ALLOWED_ORIGINS
  || 'https://hivemind.davinciai.eu,https://www.davinciai.eu,https://davinciai.eu')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean)
  .concat([
    // Dedicated commercial control surface. This is explicit rather than a
    // wildcard so normal tenant CORS policy cannot expand by accident.
    'https://admin.hivemind.singulancelabs.com',
    'https://singulancelabs.com',
    'https://www.singulancelabs.com',
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:5000',
    'http://localhost:5001',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:3001',
    'http://127.0.0.1:5000',
    'http://127.0.0.1:5001'
  ]);

// Public navigation is a product decision, not a CORS side effect. Never infer
// invitation/auth links from the first allowed origin, and retire the legacy
// davinciai frontend even if an old production environment still supplies it.
const defaultFrontendBaseUrl = resolvePublicFrontendBaseUrl();

const CONFIG = {
  port: Number(process.env.CONTROL_PLANE_PORT || process.env.PORT || 3010),
  publicBaseUrl: process.env.HIVEMIND_CONTROL_PLANE_PUBLIC_URL || `http://localhost:${process.env.CONTROL_PLANE_PORT || process.env.PORT || 3010}`,
  // INTERNAL — used for server-to-server fetches (control-plane → hm-core).
  // Defaults to docker hostname.
  coreApiBaseUrl: process.env.HIVEMIND_CORE_API_BASE_URL
    || process.env.HIVEMIND_API_URL
    || 'https://core.hivemind.davinciai.eu:8050',
  // PUBLIC — handed to the browser via /v1/bootstrap. Browser cannot reach
  // docker-internal hostnames; this MUST be a publicly resolvable HTTPS URL.
  corePublicBaseUrl: process.env.HIVEMIND_CORE_API_PUBLIC_URL
    || process.env.HIVEMIND_CORE_PUBLIC_URL
    || 'https://core.hivemind.davinciai.eu:8050',
  tierRoutingOrigins: parseOrigins(process.env.HIVEMIND_TIER_ROUTING_ORIGINS),
  b2bCoreApiBaseUrl: process.env.HIVEMIND_B2B_CORE_API_BASE_URL || '',
  b2bCorePublicBaseUrl: process.env.HIVEMIND_B2B_CORE_API_PUBLIC_URL || '',
  b2cCoreApiBaseUrl: process.env.HIVEMIND_B2C_CORE_API_BASE_URL || '',
  b2cCorePublicBaseUrl: process.env.HIVEMIND_B2C_CORE_API_PUBLIC_URL || '',
  // INTERNAL — Deepgram TARA service. The outbound call bridge posts to its
  // allowlisted Telnyx dial endpoint; the legacy tara-aaas service is not used.
  taraDeepgramBaseUrl: process.env.HIVEMIND_TARA_DEEPGRAM_URL || 'http://tara-deepgram:8091',
  taraGrokBaseUrl: process.env.HIVEMIND_TARA_GROK_URL || 'http://tara-grok:8092',
  sessionCookieName: process.env.HIVEMIND_CONTROL_PLANE_SESSION_COOKIE || 'hm_cp_session',
  sessionSecret: requireSessionSecret('HIVEMIND_CONTROL_PLANE_SESSION_SECRET', ['SESSION_SECRET']),
  sessionTtlSeconds: Number(process.env.HIVEMIND_CONTROL_PLANE_SESSION_TTL_SECONDS || 60 * 60 * 24 * 7),
  authStateTtlSeconds: Number(process.env.HIVEMIND_CONTROL_PLANE_AUTH_STATE_TTL_SECONDS || 600),
  redisUrl: process.env.HIVEMIND_CONTROL_PLANE_REDIS_URL || process.env.REDIS_URL || null,
  redisHost: process.env.REDIS_HOST || null,
  redisPort: Number(process.env.REDIS_PORT || 6379),
  redisPassword: process.env.REDIS_PASSWORD || null,
  zitadelIssuerUrl: process.env.ZITADEL_ISSUER_URL || process.env.HIVEMIND_ZITADEL_ISSUER_URL || null,
  zitadelClientId: process.env.ZITADEL_CLIENT_ID || null,
  zitadelClientSecret: process.env.ZITADEL_CLIENT_SECRET || null,
  zitadelRedirectUri: process.env.ZITADEL_REDIRECT_URI || null,
  postLoginRedirect: process.env.HIVEMIND_CONTROL_PLANE_POST_LOGIN_REDIRECT || `${defaultFrontendBaseUrl}/hivemind/login`,
  allowedOrigins: defaultAllowedOrigins
};

const prisma = getPrismaClient();
const emailIdentity = createEmailIdentityService({ prisma, publicBaseUrl: defaultFrontendBaseUrl });
const emailPostLoginRedirect = `${defaultFrontendBaseUrl.replace(/\/$/, '')}/hivemind/app/overview?auth=callback`;
const emailAllowedOrigins = [new URL(defaultFrontendBaseUrl).origin];
configureSystemEmailNotificationSink(createEmailNotificationSink(prisma));
const { configureAiGovernance, listModelGovernance, listModelPrices, normalizeModelPolicyInput, platformCreditAccountDetail, platformCreditIntelligence, replaceModelPrice, upsertModelPolicy } = await import('./llm/ai-governance.js');
configureAiGovernance(prisma);
const signupWelcome = createSignupWelcomeDispatcher({ prisma, sendEmail: sendSystemEmail });
async function taraProviderFor(orgId) {
  const runtime = await prisma.taraRuntimeConfig.findUnique({ where: { orgId }, select: { defaultProvider: true, revision: true, grokConfig: true } }).catch(() => null);
  const provider = runtime?.defaultProvider === 'grok' ? 'grok' : 'deepgram';
  return { provider, revision: runtime?.revision || 1, config: runtime?.grokConfig || {}, baseUrl: provider === 'grok' ? CONFIG.taraGrokBaseUrl : CONFIG.taraDeepgramBaseUrl };
}
const controlUsageTracker = new UsageTracker(prisma);
const planEnforcer = new PlanEnforcer(
  prisma,
  { getOrgPlan: async (orgId) => (await getEffectivePlan(prisma, orgId)).plan },
  controlUsageTracker,
);
const controlUsageService = new UsageService({ prisma, planEnforcer, usageTracker: controlUsageTracker });
planEnforcer.setUsageService(controlUsageService);
const controlCreditService = new CreditService({
  prisma,
  planStore: { getOrgPlan: async (orgId) => (await getEffectivePlan(prisma, orgId)).plan },
  usageService: controlUsageService,
});
planEnforcer.setCreditService(controlCreditService);

// One accounting boundary for every executed HyperAgent turn. Turn creation has
// several legitimate entry points (manual chat, task kickoff, HQ routing,
// resume, and scheduled runtime), but every execution reports a seal event to
// Control. The turn id is therefore the canonical idempotency key for both the
// credit ledger and the established Usage-page projection.
async function meterHyperAgentTurn(turnId) {
  if (!turnId) return { metered: false, reason: 'missing_turn_id' };
  const turn = await prisma.hyperTurn.findUnique({
    where: { id: turnId },
    select: { room: { select: { orgId: true, userId: true } } },
  });
  const orgId = turn?.room?.orgId;
  const userId = turn?.room?.userId;
  if (!orgId) return { metered: false, reason: 'turn_not_found' };

  // The execution already happened, so the established Usage projection must
  // reflect it even if the account exhausted its credit allowance while an
  // autonomous kickoff was running. The next admission is then blocked by the
  // updated projection instead of silently losing this run.
  await controlUsageService.record({
    orgId,
    userId,
    type: 'hyperAgentRuns',
    quantity: 1,
    source: 'hyperagents',
    idempotencyKey: `hyperagent-run:${turnId}`,
    metadata: { turn_id: turnId },
  });

  const creditKey = `hyperagent:turn:${turnId}`;
  const credit = await controlCreditService.reserve({
    orgId,
    userId,
    service: 'hyperagent_turn',
    units: 1,
    source: 'hyperagents',
    idempotencyKey: creditKey,
    metadata: { turn_id: turnId },
  });
  if (!credit.admitted) return { metered: true, creditSettled: false, reason: 'credits_exhausted', check: credit.check };
  await controlCreditService.settle({ orgId, idempotencyKey: creditKey });
  return { metered: true, creditSettled: true, duplicate: Boolean(credit.duplicate) };
}

function dummyCheckoutAllowed(orgId) {
  if (process.env.BILLING_DUMMY_CHECKOUT_ENABLED !== 'true') return false;
  if (process.env.NODE_ENV !== 'production') return true;
  const allowed = new Set(String(process.env.BILLING_DUMMY_ALLOWED_ORGS || '')
    .split(',').map((value) => value.trim()).filter(Boolean));
  return allowed.has(orgId);
}

async function provisionPaidManagedOrg(orgId, planId) {
  if (planId !== 'enterprise' || !orgId) return { provisioned: false, reason: 'not-managed-enterprise' };
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { hostingMode: true },
  });
  if (!org || org.hostingMode === 'self_host') return { provisioned: false, reason: 'self-hosted' };
  let [memories, documents] = await Promise.all([
    prisma.memory.count({ where: { orgId } }),
    prisma.knowledgeDocument.count({ where: { orgId } }).catch(() => 0),
  ]);
  const { agentFor, remoteStats } = await import('./vector/mneme/remote-backend.js');
  if (agentFor(orgId)?.url === 'local:') {
    const sourceStats = await remoteStats(orgId, {});
    if (!sourceStats) return { provisioned: false, reason: 'storage-verification-failed' };
    memories = Math.max(memories, Number(sourceStats.memory_count ?? sourceStats.memories) || 0);
  }
  if (memories > 0 || documents > 0) {
    console.warn('[managed-provision] migration required before cutover', { orgId, memories, documents });
    return { provisioned: false, reason: 'migration-required', memories, documents };
  }
  const { provisionManagedAgent } = await import('./selfhost/managed-provisioner.js');
  const result = await provisionManagedAgent({ orgId });
  if (result.provisioned && result.registered) {
    await prisma.organization.update({
      where: { id: orgId },
      data: { memoryStorageMode: 'hybrid_amr_index' },
    });
  }
  return result;
}

class PlanCapacityError extends Error {
  constructor(resource, plan, limit, current) {
    super(`${resource} limit reached (${plan.name} plan: ${limit.toLocaleString()})`);
    this.code = 'PLAN_LIMIT';
    this.resource = resource;
    this.plan = plan.id;
    this.limit = limit;
    this.current = current;
  }
}

function teamSeatCapacityError(plan, limit, current) {
  const error = new PlanCapacityError('Seat', plan, limit, current);
  // All self-serve plans currently have one seat. Do not send someone through
  // a chain of one-seat upgrades when the requested action is team invitation.
  error.suggestedPlan = plan.id === 'enterprise' ? null : 'enterprise';
  return error;
}

async function createHyperRoom(data) {
  // Room count is no longer a billable capacity. HyperAgent work is governed
  // by the canonical monthly credit ledger when turns execute, so creating a
  // durable room must not consume or be blocked by a legacy plan allowance.
  return prisma.hyperRoom.create({ data });
}

// ── HQ dispatcher (P4) ─────────────────────────────────────────────────────
// A work request typed in the HQ room is classified, routed to (or auto-creates)
// the right kind room, and RUNS THERE — HQ stays a control room, not a work log.
// Mirrors the sidecar keyword classifier (hyper/skills.resolve_room_kind) so no
// round-trip is needed. Off-switch: HQ_DISPATCH=off.
const _HQ_KIND_KEYWORDS = [
  ['outreach', ['outreach', 'cold email', 'prospect', 'lead gen', 'leads', 'sales call', 'book meeting', 'reach out', 'sales sheet', 'campaign']],
  ['research', ['competitor', 'market research', 'landscape', 'icp', 'market size', 'segment', 'industry trend', 'analyze market', 'research']],
  ['content', ['content', 'blog', 'social', 'post', 'newsletter', 'seo', 'copy', 'article', 'brand']],
  ['strategy', ['strategy', 'roadmap', 'prioriti', 'decision', 'invest', 'pivot', 'pricing', 'business model', 'go-to-market', 'gtm']],
];
const _HQ_KIND_LABEL = { outreach: 'Outreach', research: 'Research', content: 'Content', strategy: 'Strategy' };

function classifyHqKind(message) {
  const hay = String(message || '').toLowerCase();
  for (const [kind, words] of _HQ_KIND_KEYWORDS) {
    if (words.some((w) => hay.includes(w))) return kind;
  }
  return null;
}
// A short greeting/status stays in HQ (direct answer). A work verb OR a
// substantive question (already classified to a kind) routes to that kind's room.
function isHqWorkRequest(message) {
  const m = String(message || '').trim();
  if (m.length < 12) return false;
  if (/\b(find|design|create|build|write|draft|prepare|research|analyze|generate|plan|make|produce|reach out|send|compose|map|identify)\b/i.test(m)) return true;
  // A classified question ("should we…", "is it worth…", "how do we…") is work
  // for that desk — route it. (classifyHqKind already gated to a real topic.)
  if (m.length >= 20 && (/\?/.test(m) || /\b(should|could|would|is it worth|do we|how do we|what if|which)\b/i.test(m))) return true;
  return false;
}

async function findOrCreateKindRoom(session, hqRoom, kind, message) {
  const orgId = session.orgId;
  // Reuse the newest non-archived room already tagged for this kind.
  const existing = await prisma.$queryRawUnsafe(
    `SELECT id, participant_ids FROM "hivemind"."hyper_rooms"
      WHERE org_id = $1::uuid AND archived_at IS NULL
        AND agent_connectors->>'_kind' = $2 ORDER BY updated_at DESC LIMIT 1`,
    orgId, kind,
  ).catch(() => []);
  if (existing?.[0]?.id) return { id: existing[0].id, participantIds: existing[0].participant_ids || [], created: false };
  // Else create one, seeded with the HQ room's team (or the org's employees).
  let participantIds = Array.isArray(hqRoom.participantIds) ? hqRoom.participantIds.slice(0, 5) : [];
  if (!participantIds.length) {
    const emps = await prisma.digitalEmployee.findMany({ where: { orgId }, select: { id: true }, take: 5 });
    participantIds = emps.map((e) => e.id);
  }
  const name = `${_HQ_KIND_LABEL[kind] || 'Work'} desk`;
  const room = await createHyperRoom({
    orgId, userId: session.userId, name, template: 'auto',
    participantIds, goal: `${_HQ_KIND_LABEL[kind]} work routed from HQ`,
    agentConnectors: { _kind: kind }, roomMode: 'runtime',
    permanentLeadId: participantIds.slice().sort()[0] || null,
  });
  return { id: room.id, participantIds, created: true };
}

async function claimInviteSeatWithinPlan({ inviteId, orgId, userId, role, roles, invitedAt }) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', `plan:seats:${orgId}`);
    const freshInvite = await tx.orgInvite.findUnique({ where: { id: inviteId }, select: { usedAt: true } });
    if (!freshInvite || freshInvite.usedAt) {
      const error = new Error('Invite already used');
      error.code = 'INVITE_USED';
      throw error;
    }
    const existing = await tx.userOrganization.findUnique({ where: { userId_orgId: { userId, orgId } } });
    if (!existing?.isActive) {
      const { plan } = await getEffectivePlan(tx, orgId);
      const limit = plan.limits?.maxUsers ?? -1;
      if (limit > 0) {
        const current = await tx.userOrganization.count({ where: { orgId, isActive: true } });
        if (current >= limit) throw teamSeatCapacityError(plan, limit, current);
      }
    }
    const membership = await tx.userOrganization.upsert({
      where: { userId_orgId: { userId, orgId } },
      update: { role, roles, joinedAt: new Date(), isActive: true, deactivatedAt: null },
      create: { userId, orgId, role, roles, invitedAt, joinedAt: new Date(), isActive: true },
    });
    await tx.orgInvite.update({ where: { id: inviteId }, data: { usedAt: new Date(), usedBy: userId } });
    return membership;
  });
}

async function createMembershipWithinPlan(data) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', `plan:seats:${data.orgId}`);
    const existing = await tx.userOrganization.findUnique({ where: { userId_orgId: { userId: data.userId, orgId: data.orgId } } });
    if (existing?.isActive) return existing;
    const { plan } = await getEffectivePlan(tx, data.orgId);
    const limit = plan.limits?.maxUsers ?? -1;
    if (limit > 0) {
      const current = await tx.userOrganization.count({ where: { orgId: data.orgId, isActive: true } });
      if (current >= limit) throw teamSeatCapacityError(plan, limit, current);
    }
    return tx.userOrganization.upsert({
      where: { userId_orgId: { userId: data.userId, orgId: data.orgId } },
      update: { ...data, isActive: true, deactivatedAt: null },
      create: { ...data, isActive: true },
    });
  });
}

// Pending invitations reserve a seat as well as accepted memberships. Without
// that reservation a one-seat workspace could issue unlimited invitations and
// only reject people after they had accepted an email. The advisory lock makes
// concurrent browser tabs and bulk requests observe one capacity boundary.
async function assertInviteCapacityWithinPlan({ orgId, additionalSeats = 1, now = new Date() }) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', `plan:seats:${orgId}`);
    const { plan } = await getEffectivePlan(tx, orgId);
    const limit = plan.limits?.maxUsers ?? -1;
    if (limit <= 0) return { plan, limit, current: 0 };
    const [activeMembers, pendingInvites] = await Promise.all([
      tx.userOrganization.count({ where: { orgId, isActive: true } }),
      tx.orgInvite.count({ where: { orgId, usedAt: null, revokedAt: null, expiresAt: { gt: now } } }),
    ]);
    const current = activeMembers + pendingInvites;
    if (current + additionalSeats > limit) throw teamSeatCapacityError(plan, limit, current);
    return { plan, limit, current };
  });
}

async function createOrgInviteWithinPlan(data, now = new Date()) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', `plan:seats:${data.orgId}`);
    const { plan } = await getEffectivePlan(tx, data.orgId);
    const limit = plan.limits?.maxUsers ?? -1;
    if (limit > 0) {
      const [activeMembers, pendingInvites] = await Promise.all([
        tx.userOrganization.count({ where: { orgId: data.orgId, isActive: true } }),
        tx.orgInvite.count({ where: { orgId: data.orgId, usedAt: null, revokedAt: null, expiresAt: { gt: now } } }),
      ]);
      const current = activeMembers + pendingInvites;
      if (current >= limit) throw teamSeatCapacityError(plan, limit, current);
    }
    return tx.orgInvite.create({ data });
  });
}

async function upsertConnectorWithinPlan(orgId, connectorInput) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', `plan:connectors:${orgId}`);
    const existing = await tx.platformIntegration.findUnique({
      where: { userId_platformType: { userId: connectorInput.userId, platformType: connectorInput.provider } },
      select: { isActive: true },
    });
    if (!existing?.isActive) {
      const { plan } = await getEffectivePlan(tx, orgId);
      const limit = plan.limits?.maxConnectors ?? -1;
      if (limit > 0) {
        const current = await tx.platformIntegration.count({
          where: { user: { organizations: { some: { orgId, isActive: true } } }, isActive: true },
        });
        if (current >= limit) throw new PlanCapacityError('Connector', plan, limit, current);
      }
    }
    return new ConnectorStore(tx).upsertConnector(connectorInput);
  });
}

// Map the internal resource label + plan id to the FE plan-limit contract so the global
// <PlanLimitModal> (shared/planLimit.js) fires instead of the caller seeing a raw 402.
const _PLAN_LIMIT_RESOURCE_KEY = {
  'user': 'users',
  'seat': 'users',
  'Seat': 'users',
  'connector': 'connectors',
  'project': 'projects',
};
const _PLAN_LIMIT_NEXT = { free: 'pro', pro: 'scale', scale: 'enterprise', enterprise_onboarding: 'enterprise', enterprise: null };

function capacityErrorResponse(res, error) {
  const planId = error.plan;
  return jsonResponse(res, {
    error: error.message,
    // FE contract (shared/planLimit.js isPlanLimitError): the machine code MUST be
    // 'plan_limit_exceeded' for the upgrade modal to surface. `reason` keeps the internal
    // code ('PLAN_LIMIT') for backend routing/debug. Was previously emitting the internal
    // code here → the FE never recognised it → the user got a silent console 402.
    code: 'plan_limit_exceeded',
    reason: error.code,
    message: error.message,
    resource: _PLAN_LIMIT_RESOURCE_KEY[error.resource] || error.resource,
    plan: planId,
    limit: error.limit,
    current: error.current,
    suggested_plan: error.suggestedPlan ?? (Object.prototype.hasOwnProperty.call(_PLAN_LIMIT_NEXT, planId) ? _PLAN_LIMIT_NEXT[planId] : null),
    upgrade_url: '/hivemind/app/billing',
  }, 402);
}

// ── Outbound value-action ledger (closed loop) ───────────────────────────
// One row per action that ACTUALLY left the platform (approved email send /
// outbound call). Written on SUCCESS only, fire-and-forget — the send response
// must never fail because the ledger insert did. Raw SQL (not the Prisma model)
// so a deployed client generated before the outbound_actions migration still
// works. Reply-matcher/call-end later fills `outcome` by (org_id, thread_id).
async function recordOutboundAction({ orgId, userId, roomId, approvalId, channel, recipient, subject, messageId, threadId, meta }) {
  try {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "hivemind"."outbound_actions"
         (org_id, user_id, room_id, approval_id, channel, recipient, subject, message_id, thread_id, status, meta)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, 'sent', $10::jsonb)`,
      orgId, userId || null, roomId || null,
      approvalId ? String(approvalId).slice(0, 80) : null,
      String(channel).slice(0, 20),
      recipient ? String(recipient).slice(0, 320) : null,
      subject ? String(subject).slice(0, 500) : null,
      messageId ? String(messageId).slice(0, 160) : null,
      threadId ? String(threadId).slice(0, 160) : null,
      meta ? JSON.stringify(meta) : null,
    );
  } catch (e) { console.warn('[outbound-ledger] insert failed:', e.message); }
  // Value-action metering — same success-only trigger as the ledger row (this
  // helper is only ever called AFTER a successful send/dial; approval emission
  // and denies never reach here). Fire-and-forget: metering must never break
  // the send response.
  try {
    const { UsageTracker } = await import('./billing/usage-tracker.js');
    const t = new UsageTracker(prisma);
    if (channel === 'email') {
      t.recordEmailSend(orgId).catch(() => {});
      t.recordDaily(orgId, 'emailSends').catch(() => {});
    } else if (channel === 'call') {
      t.recordTara(orgId).catch(() => {});
      t.recordDaily(orgId, 'tara').catch(() => {});
    }
  } catch (e) { console.warn('[outbound-ledger] metering failed:', e.message); }
}

// ── HQ control-room activity feed ─────────────────────────────────────────
// On a sealed COMPLETE turn in a NON-HQ room, write one templated "report" into
// the org's HQ room feed — as if the room's lead agent reported its activity to
// the owner. Templated (no LLM) from the turn's own events + room metadata.
// Idempotent on turn_id. Best-effort — the caller guards; this never throws.
async function recordHqActivity(prisma, turnId, event) {
  if ((event?.status || 'complete') !== 'complete') return;
  const turn = await prisma.hyperTurn.findUnique({
    where: { id: turnId }, select: { roomId: true, userMessage: true, lines: true },
  });
  if (!turn) return;
  const room = await prisma.hyperRoom.findUnique({
    where: { id: turn.roomId },
    select: { orgId: true, name: true, goal: true, agentConnectors: true },
  });
  if (!room) return;
  // Skip the HQ room itself — it doesn't report to itself.
  const isHq = room.agentConnectors && typeof room.agentConnectors === 'object'
    && Object.prototype.hasOwnProperty.call(room.agentConnectors, '_company');
  if (isHq) return;
  // Resolve the org's HQ room (the one carrying _company state).
  const hqRows = await prisma.$queryRawUnsafe(
    `SELECT id FROM "hivemind"."hyper_rooms"
      WHERE "agent_connectors" ? '_company' AND archived_at IS NULL AND org_id = $1::uuid
      ORDER BY created_at DESC LIMIT 1`,
    room.orgId,
  ).catch(() => []);
  const hqRoomId = hqRows?.[0]?.id;
  if (!hqRoomId || hqRoomId === turn.roomId) return; // no HQ, or this IS the HQ

  const lines = Array.isArray(turn.lines) ? turn.lines : [];
  const line = (t) => lines.filter((l) => l && l.t === t);
  // Lead agent = the seal's author, else the first line/react agent, else team.
  const leadEv = [...lines].reverse().find((l) => l && (l.t === 'line' || l.t === 'react') && (l.agent || l.name));
  const agentName = event.agent || leadEv?.agent || leadEv?.name || null;
  const agentRole = leadEv?.role || leadEv?.lane || null;

  // Outcome digest from the turn's events — what actually happened.
  const bits = [];
  const prospects = line('prospects');
  if (prospects.length) {
    const rows = prospects.flatMap((p) => p.prospects || []);
    const withEmail = rows.filter((r) => r && r.email).length;
    if (rows.length) bits.push(`${rows.length} prospects found${withEmail ? `, ${withEmail} email-verified` : ''}`);
  }
  const finalReport = line('final_report').slice(-1)[0];
  if (finalReport) bits.push('report sealed');
  const approvals = line('approval_request');
  if (approvals.length) bits.push(`${approvals.length} action${approvals.length > 1 ? 's' : ''} awaiting approval`);
  const skillUsed = line('skill_used');
  if (skillUsed.length) bits.push(`${skillUsed.length} skill${skillUsed.length > 1 ? 's' : ''} used`);
  const tok = Number(event.cost_tokens || 0);

  const roomName = room.name || 'a room';
  const task = (room.goal || turn.userMessage || '').trim().replace(/\s+/g, ' ').slice(0, 160);
  const who = agentName ? `${agentName}${agentRole ? ` · ${agentRole}` : ''}` : `The ${roomName} team`;
  const headline = task
    ? `${who} reporting from “${roomName}”: finished “${task}”`
    : `${who} reporting from “${roomName}”: run complete`;
  // Summary = the outcome digest line + the FULL run report (the sealed
  // final_report/synthesis body), so the HQ bubble can show everything that
  // happened in the run — not just a one-liner.
  const digest = bits.length ? bits.join(' · ') : 'Run complete.';
  const reportBody = String(
    finalReport?.body || finalReport?.text || finalReport?.report || finalReport?.content
    || [...lines].reverse().find((l) => l && l.t === 'line'
        && String(l.content || l.text || '').length > 200)?.content
    || [...lines].reverse().find((l) => l && l.t === 'line'
        && String(l.text || '').length > 200)?.text
    || '',
  ).trim();
  const summary = reportBody ? `${digest}\n\n${reportBody}` : digest;

  await prisma.$executeRawUnsafe(
    `INSERT INTO "hivemind"."hq_activity"
       (org_id, hq_room_id, source_room_id, source_room_name, turn_id, agent_name, agent_role, headline, summary, status)
     VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5::uuid,$6,$7,$8,$9,'complete')
     ON CONFLICT (turn_id) DO NOTHING`,
    room.orgId, hqRoomId, turn.roomId, roomName.slice(0, 200), turnId,
    agentName ? String(agentName).slice(0, 120) : null,
    agentRole ? String(agentRole).slice(0, 120) : null,
    headline.slice(0, 400), summary.slice(0, 12000),
  );
}

// ── Hyper-room stuck-turn sweeper ─────────────────────────────────────────
// The room-turn kick to the employees sidecar is fire-and-forget and can be
// dropped (the sidecar holds the connection open for the whole synchronous
// turn). This sweeper re-kicks any turn still 'live' with 0 lines for ~2 ticks
// (~30s), at most ONCE, so a dropped kick self-heals instead of leaving the FE
// spinning forever. Real in-flight turns emit a line within seconds, so they
// drop out of the watch set before the re-kick threshold.
//
// Diagnostic (2026-08-14): this gate's own boot log ('sweeper active (15s)')
// was never observed in a live production boot, despite prisma and the role
// check both confirmed truthy at runtime. Logging the decision unconditionally
// (not just the enabled branch) so a future boot proves definitively whether
// this line is even reached, and with what values.
console.log('[hyper-sweeper] gate check', {
  prisma_truthy: Boolean(prisma), role: getRuntimeRole(),
  should_run: shouldRunRecurringMaintenanceJobs(),
});
if (prisma && shouldRunRecurringMaintenanceJobs()) {
  const _sweepSeen = new Map();   // turnId -> consecutive empty-tick count
  const _sweepKicked = new Set(); // turnId -> already re-kicked once
  const SWEEP_MS = 15_000;
  const _hyperSidecar = () => process.env.EMPLOYEES_SIDECAR_URL || process.env.HIVEMIND_EMPLOYEES_URL || 'http://hm-employees:8060';
  let _sweepTimer = null;
  _sweepTimer = setInterval(async () => {
    try {
      const live = await prisma.hyperTurn.findMany({
        where: { status: 'live' },
        select: { id: true, roomId: true, userMessage: true, lines: true },
        take: 50,
      });
      const liveIds = new Set(live.map((t) => t.id));
      for (const k of [..._sweepSeen.keys()]) if (!liveIds.has(k)) { _sweepSeen.delete(k); _sweepKicked.delete(k); }
      for (const t of live) {
        const empty = !Array.isArray(t.lines) || t.lines.length === 0;
        if (!empty) { _sweepSeen.delete(t.id); continue; }
        const ticks = (_sweepSeen.get(t.id) || 0) + 1;
        _sweepSeen.set(t.id, ticks);
        if (ticks < 2 || _sweepKicked.has(t.id)) continue;
        const room = await prisma.hyperRoom.findUnique({
          where: { id: t.roomId },
          select: { userId: true, orgId: true, participantIds: true },
        });
        if (!room) continue;
        // projectId via raw SQL — the deployed Prisma client predates the column,
        // so `select: { projectId: true }` throws "Unknown field projectId" and the
        // catch below swallowed it, killing the re-kick. A turn whose kick dropped
        // then stayed status=live with empty lines forever (FE spins, nothing renders).
        let _sweepProjectId = null;
        let _sweepGoal = '';
        let _sweepRoomTag = 'general';
        let _sweepRoomMode = 'work';
        try {
          const _pr = await prisma.$queryRawUnsafe('SELECT project_id, goal, room_tag, room_mode FROM "hivemind"."hyper_rooms" WHERE id = $1::uuid', t.roomId);
          _sweepProjectId = _pr?.[0]?.project_id || null;
          _sweepGoal = _pr?.[0]?.goal || '';
          _sweepRoomTag = _pr?.[0]?.room_tag || 'general';
          _sweepRoomMode = _pr?.[0]?.room_mode || 'work';
        } catch { /* org-wide re-kick is acceptable for recovery */ }
        _sweepKicked.add(t.id);
        console.warn('[hyper-sweeper] re-kicking stuck turn', t.id);
        internalFetch(`${_hyperSidecar()}/internal/hyper/room-turn`, {
          service: 'hm-employees',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: {
            room_id: t.roomId, turn_id: t.id, user_id: room.userId, org_id: room.orgId,
            user_message: t.userMessage || '(continue)', participant_ids: room.participantIds || [], project_id: _sweepProjectId,
            room_goal: _sweepGoal,
            room_mode: _sweepRoomMode,
            task_tag: `ROOM_${String(_sweepRoomTag).toUpperCase()}`,
            callback_url: `${process.env.CONTROL_PLANE_INTERNAL_URL || 'http://hm-control:3000'}/internal/hyper/turn-event`,
          },
        }).catch((err) => console.warn('[hyper-sweeper] re-kick failed:', err.message));
      }
      const { reconcileHyperTurnEventOutbox, reconcileStrandedWorkRoomTurns, failDeadTurns } = await import('./employees/hyper-rooms.js');
      await reconcileHyperTurnEventOutbox(prisma);
      await reconcileStrandedWorkRoomTurns(prisma);
      await failDeadTurns(prisma);
    } catch (err) {
      // On a deployment where the HyperAgents tables were never migrated
      // (e.g. a self-host/managed box that doesn't run rooms), the query
      // throws "table ... does not exist" every 15s and floods the logs.
      // Self-disable instead of spamming — there is nothing to sweep.
      const msg = err?.message || '';
      if (/does not exist|Unknown (arg|field)|column .* does not exist/i.test(msg)) {
        if (_sweepTimer) clearInterval(_sweepTimer);
        console.warn('[hyper-sweeper] disabled — HyperAgents schema absent on this DB:', msg.split('\n')[0]);
        return;
      }
      console.warn('[hyper-sweeper] tick failed:', msg);
    }
  }, SWEEP_MS);
  console.log('[hyper-sweeper] stuck-turn re-kick sweeper active (15s)');
}

const sessionStore = new ControlPlaneSessionStore(CONFIG);

// HyperAgents onboarding jobs — one Polsia-style company-genesis pipeline per
// org, in-memory (FE polls /v1/hyper/onboarding/status; refresh re-attaches).
const _hyperOnboardJobs = new Map();

// Homepage screenshots live on the shared data volume (out of Postgres — the
// base64 was bloating the room jsonb + every dashboard read). Served lazily by
// GET /v1/hyper/company/screenshot.
const HYPER_SHOT_DIR = path.join(process.env.HIVEMIND_DATA_DIR || '/app/data', 'hyper-screenshots');
try { fs.mkdirSync(HYPER_SHOT_DIR, { recursive: true }); } catch { /* best-effort */ }

const HYPER_VISUAL_MAX_BYTES = 5 * 1024 * 1024;

function companyVisualPaths(orgId) {
  return {
    screenshot: path.join(HYPER_SHOT_DIR, `${orgId}.jpg`),
    official: path.join(HYPER_SHOT_DIR, `${orgId}.image`),
    metadata: path.join(HYPER_SHOT_DIR, `${orgId}.image.json`),
  };
}

function removeCompanyVisual(orgId) {
  const paths = companyVisualPaths(orgId);
  for (const fp of Object.values(paths)) {
    try { fs.rmSync(fp, { force: true }); } catch { /* best-effort */ }
  }
}

function removeCompanyCampaignAssets(orgId) {
  const root = path.resolve(process.env.HIVEMIND_DATA_DIR || '/app/data', 'campaign-assets');
  const tenantDir = path.resolve(root, String(orgId || ''));
  if (!orgId || !tenantDir.startsWith(`${root}${path.sep}`)) return;
  try { fs.rmSync(tenantDir, { recursive: true, force: true }); } catch { /* best-effort after durable rows are cleared */ }
}

async function clearHyperCompanyContext({ orgId, userId }) {
  if (!orgId || !userId) throw new Error('organization and user are required for company reset');

  // Core owns canonical memory deletion because it must purge relational rows,
  // source documents, and Qdrant points together. Fail closed: onboarding must
  // never continue with a mixture of the previous and replacement company.
  const memoryResponse = await fetch(`${CONFIG.coreApiBaseUrl}/api/memories/delete-all?all_users=true`, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': getInternalApiKey(),
      'x-hm-user-id': userId,
      'x-hm-org-id': orgId,
    },
  });
  const memoryResult = await memoryResponse.json().catch(() => ({}));
  if (!memoryResponse.ok) {
    throw new Error(memoryResult.message || memoryResult.error || `company memory reset failed (${memoryResponse.status})`);
  }

  const resetAt = new Date();
  const roomRows = await prisma.hyperRoom.findMany({ where: { orgId }, select: { id: true } });
  const roomIds = roomRows.map((row) => row.id);
  await prisma.$transaction(async (tx) => {
    // Company replacement retires the previous operating surface. Provider
    // credentials and immutable outbound/audit ledgers remain intact, while
    // local drafts, lead books, Room work, and generated company artifacts go.
    await tx.campaign.deleteMany({ where: { orgId } });
    await tx.outreachCampaign.deleteMany({ where: { orgId } });
    await tx.audienceContact.deleteMany({ where: { orgId } });
    await tx.xAdsCampaign.deleteMany({ where: { orgId, xCampaignId: null } });
    if (roomIds.length) {
      const workOrders = await tx.hyperWorkOrder.findMany({
        where: { orgId, roomId: { in: roomIds } }, select: { id: true },
      });
      if (workOrders.length) {
        await tx.hyperWorkResult.deleteMany({ where: { workOrderId: { in: workOrders.map((row) => row.id) } } });
      }
      await tx.hyperWorkOrder.deleteMany({ where: { orgId, roomId: { in: roomIds } } });
      await tx.hyperTurn.deleteMany({ where: { roomId: { in: roomIds } } });
    }
    await tx.$executeRawUnsafe(
      `UPDATE "hivemind"."hyper_rooms"
          SET archived_at = COALESCE(archived_at, now()),
              agent_connectors = agent_connectors - '_company',
              room_journal = '[]'::jsonb,
              summary_memory_id = NULL
        WHERE org_id = $1::uuid`,
      orgId,
    );
    await tx.digitalEmployee.updateMany({
      where: { orgId, archivedAt: null },
      data: { archivedAt: resetAt, status: 'paused' },
    });
    await tx.userProfile.updateMany({
      where: {
        orgId,
        deletedAt: null,
        OR: [{ key: 'company' }, { key: { startsWith: 'company:' } }],
      },
      data: { deletedAt: resetAt },
    });
  }, { timeout: 15000, maxWait: 8000 });

  const hqReset = await resetHqForCompanyReplacement({ prisma, orgId });

  try {
    const { getSharedProfileStore } = await import('./memory/profile-store.js');
    getSharedProfileStore(prisma)?.invalidateOrg(orgId);
  } catch { /* cache expires naturally if the store is unavailable */ }
  removeCompanyVisual(orgId);
  removeCompanyCampaignAssets(orgId);

  const [activeRooms, activeEmployees, oldTurns, oldWorkOrders, campaigns, outreachCampaigns, audienceContacts, xAdsDrafts, companyProfiles] = await Promise.all([
    prisma.hyperRoom.count({ where: { orgId, archivedAt: null } }),
    prisma.digitalEmployee.count({ where: { orgId, archivedAt: null } }),
    roomIds.length ? prisma.hyperTurn.count({ where: { roomId: { in: roomIds } } }) : 0,
    roomIds.length ? prisma.hyperWorkOrder.count({ where: { orgId, roomId: { in: roomIds } } }) : 0,
    prisma.campaign.count({ where: { orgId } }),
    prisma.outreachCampaign.count({ where: { orgId } }),
    prisma.audienceContact.count({ where: { orgId } }),
    prisma.xAdsCampaign.count({ where: { orgId, xCampaignId: null } }),
    prisma.userProfile.count({ where: { orgId, deletedAt: null, OR: [{ key: 'company' }, { key: { startsWith: 'company:' } }] } }),
  ]);
  const verification = {
    activeRooms, activeEmployees, oldTurns, oldWorkOrders, campaigns,
    outreachCampaigns, audienceContacts, xAdsDrafts, companyProfiles,
    hq: hqReset?.resetVerification || {},
  };
  const nonZero = Object.entries(verification)
    .filter(([key, value]) => key !== 'hq' && value !== 0);
  if (nonZero.length || Object.values(verification.hq).some((count) => count !== 0)) {
    throw new Error(`company_reset_verification_failed:${JSON.stringify(verification)}`);
  }
  return { memory: memoryResult, verification };
}

function decodeHtmlAttribute(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .trim();
}

function tagAttributes(tag) {
  const attrs = {};
  const re = /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  for (const match of String(tag || '').matchAll(re)) {
    attrs[match[1].toLowerCase()] = decodeHtmlAttribute(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attrs;
}

function websiteVisualCandidates(html, pageUrl) {
  if (!html) return [];
  const candidates = [];
  const add = (raw) => {
    if (!raw || /^data:/i.test(raw)) return;
    try { candidates.push(new URL(raw, pageUrl).href); } catch { /* malformed asset */ }
  };
  for (const tag of String(html).match(/<meta\b[^>]*>/gi) || []) {
    const attrs = tagAttributes(tag);
    const key = String(attrs.property || attrs.name || '').toLowerCase();
    if (['og:image', 'og:image:secure_url', 'twitter:image', 'twitter:image:src'].includes(key)) add(attrs.content);
  }
  for (const tag of String(html).match(/<link\b[^>]*>/gi) || []) {
    const attrs = tagAttributes(tag);
    const rel = String(attrs.rel || '').toLowerCase();
    if (/\b(?:apple-touch-icon|icon)\b/.test(rel)) add(attrs.href);
  }
  for (const match of String(html).matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const root = JSON.parse(match[1]);
      const queue = Array.isArray(root) ? [...root] : [root];
      while (queue.length) {
        const item = queue.shift();
        if (!item || typeof item !== 'object') continue;
        const logo = item.logo;
        if (typeof logo === 'string') add(logo);
        else if (logo && typeof logo === 'object') add(logo.url || logo.contentUrl);
        if (Array.isArray(item['@graph'])) queue.push(...item['@graph']);
      }
    } catch { /* malformed structured data */ }
  }
  return [...new Set(candidates)];
}

function verifiedImageType(buffer, declaredType) {
  const type = String(declaredType || '').split(';')[0].trim().toLowerCase();
  if (type === 'image/jpeg' && buffer[0] === 0xff && buffer[1] === 0xd8) return type;
  if (type === 'image/png' && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return type;
  if (type === 'image/webp' && buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return type;
  return null;
}

async function fetchWebsiteImage(candidate) {
  let current = candidate;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    if (!validateDomain(current).allowed) return null;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 10000);
    try {
      const response = await fetch(current, {
        signal: ac.signal,
        redirect: 'manual',
        headers: { 'User-Agent': 'HIVEMIND-Onboarding/1.0', 'Accept': 'image/avif,image/webp,image/png,image/jpeg' },
      });
      if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
        current = new URL(response.headers.get('location'), current).href;
        continue;
      }
      if (!response.ok) return null;
      const length = Number(response.headers.get('content-length') || 0);
      if (length > HYPER_VISUAL_MAX_BYTES || !response.body) return null;
      const chunks = [];
      let total = 0;
      for await (const chunk of response.body) {
        total += chunk.length;
        if (total > HYPER_VISUAL_MAX_BYTES) {
          await response.body.cancel();
          return null;
        }
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks, total);
      const contentType = verifiedImageType(buffer, response.headers.get('content-type'));
      return contentType ? { buffer, contentType, sourceUrl: current } : null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

async function storeOfficialWebsiteVisual({ html, pageUrl, orgId }) {
  const paths = companyVisualPaths(orgId);
  for (const candidate of websiteVisualCandidates(html, pageUrl).slice(0, 8)) {
    try {
      const image = await fetchWebsiteImage(candidate);
      if (!image) continue;
      fs.writeFileSync(paths.official, image.buffer);
      fs.writeFileSync(paths.metadata, JSON.stringify({ contentType: image.contentType, sourceUrl: image.sourceUrl }));
      try { fs.rmSync(paths.screenshot, { force: true }); } catch { /* best-effort */ }
      return `/v1/hyper/company/screenshot?v=${Date.now()}`;
    } catch (error) {
      console.warn('[hyper-onboarding] official website image skipped:', error.message);
    }
  }
  return null;
}

async function storeFirecrawlWebsiteVisual({ screenshot, orgId }) {
  if (!screenshot) return null;
  try {
    let image = null;
    const dataMatch = String(screenshot).match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/i);
    if (dataMatch) {
      const buffer = Buffer.from(dataMatch[2], 'base64');
      const contentType = buffer.length <= HYPER_VISUAL_MAX_BYTES ? verifiedImageType(buffer, dataMatch[1]) : null;
      if (contentType) image = { buffer, contentType, sourceUrl: 'firecrawl-screenshot' };
    } else if (/^https:\/\//i.test(String(screenshot))) {
      image = await fetchWebsiteImage(String(screenshot));
    }
    if (!image) return null;
    const paths = companyVisualPaths(orgId);
    fs.writeFileSync(paths.official, image.buffer);
    fs.writeFileSync(paths.metadata, JSON.stringify({ contentType: image.contentType, sourceUrl: image.sourceUrl }));
    try { fs.rmSync(paths.screenshot, { force: true }); } catch { /* best-effort */ }
    return `/v1/hyper/company/screenshot?v=${Date.now()}`;
  } catch (error) {
    console.warn('[hyper-onboarding] Firecrawl screenshot skipped:', error.message);
    return null;
  }
}

// ── HyperAgents nightly operating cycle (Polsia's "works while you sleep") ──
// Once a day (HYPER_CYCLE_HOUR_UTC) every onboarded org gets ONE todo task
// picked up and executed in its workroom, then the owner gets a morning
// summary email. HARD-GUARDED: flag default-OFF + per-org daily token cap —
// autonomous spend without a cap is Polsia's admitted, margin-killing mistake.
const HYPER_CYCLE_ENABLED = String(process.env.HYPER_CYCLE_ENABLED || 'false').toLowerCase() === 'true';
// Room dispatch is independent from outbound email. Keep task execution on while
// generic "AI team started" delivery remains explicitly opt-in.
const HYPER_CYCLE_START_EMAIL_ENABLED = String(process.env.HYPER_CYCLE_START_EMAIL_ENABLED || 'false').toLowerCase() === 'true';
const HYPER_CYCLE_HOUR_UTC = parseInt(process.env.HYPER_CYCLE_HOUR_UTC || '5', 10); // 05 UTC ≈ 07:00 DE
const HYPER_DAILY_TOKEN_CAP = parseInt(process.env.HYPER_DAILY_TOKEN_CAP || '200000', 10);
if (prisma && HYPER_CYCLE_ENABLED && shouldRunRecurringMaintenanceJobs()) {
  const runNightlyCycle = async () => {
    const today = new Date().toISOString().slice(0, 10);
    const hqRuntimeAvailable = await prisma.$queryRawUnsafe(
      `SELECT to_regclass('hivemind.hq_runtimes') IS NOT NULL AS available`,
    ).then((rows) => Boolean(rows?.[0]?.available)).catch(() => false);
    const rows = await prisma.$queryRawUnsafe(
      `SELECT DISTINCT ON (r.org_id) r.id, r.org_id, r.user_id, r."agent_connectors"->'_company' AS company
         FROM "hivemind"."hyper_rooms" r
        WHERE r."agent_connectors" ? '_company' AND r.archived_at IS NULL
          ${hqRuntimeAvailable ? `AND NOT EXISTS (
            SELECT 1 FROM hivemind.hq_runtimes runtime
            WHERE runtime.org_id=r.org_id AND runtime.state<>'INACTIVE'
          )` : ''}
        ORDER BY r.org_id, r.created_at DESC`,
    ).catch(() => []);
    for (const hq of rows || []) {
      try {
        const state = typeof hq.company === 'string' ? JSON.parse(hq.company) : hq.company;
        if (!state || state.last_cycle_date === today) continue;
        const persist = async () => prisma.$executeRawUnsafe(
          'UPDATE "hivemind"."hyper_rooms" SET "agent_connectors" = "agent_connectors" || $1::jsonb WHERE "id" = $2::uuid',
          JSON.stringify({ _company: state }), hq.id,
        );
        // Budget governor: org's token spend across ALL hyper turns today.
        const spentRows = await prisma.$queryRawUnsafe(
          `SELECT COALESCE(SUM(t.cost_tokens), 0)::int AS spent
             FROM "hivemind"."hyper_turns" t JOIN "hivemind"."hyper_rooms" r ON r.id = t.room_id
            WHERE r.org_id = $1::uuid AND t.started_at >= date_trunc('day', now())`,
          hq.org_id,
        ).catch(() => [{ spent: 0 }]);
        const spent = Number(spentRows?.[0]?.spent || 0);
        if (spent >= HYPER_DAILY_TOKEN_CAP) {
          console.warn(`[hyper-cycle] org ${hq.org_id} over daily token cap (${spent}/${HYPER_DAILY_TOKEN_CAP}) — skipped`);
          state.last_cycle_date = today; await persist(); continue;
        }
        const task = (state.tasks || []).find((x) => x.status === 'todo');
        state.last_cycle_date = today;
        if (!task) { await persist(); continue; }
        // Room: reuse the task's room or provision one (same shape as tasks/open).
        let roomId = task.room_id;
        if (!roomId && task.room_tag) {
          const domainRows = await prisma.$queryRawUnsafe(
            `SELECT id
               FROM "hivemind"."hyper_rooms"
              WHERE org_id = $1::uuid
                AND room_tag = $2
                AND archived_at IS NULL
                AND agent_connectors->>'_domain_home' = 'true'
              ORDER BY created_at ASC LIMIT 1`,
            hq.org_id,
            String(task.room_tag),
          ).catch(() => []);
          roomId = domainRows?.[0]?.id || null;
        }
        if (!roomId) {
          const participantIds = (state.team || []).map((x) => x.id).filter(Boolean).slice(0, 5);
          const taskRoom = await createHyperRoom({
              userId: hq.user_id, orgId: hq.org_id,
              name: task.title.slice(0, 120), participantIds,
              template: 'auto', permanentLeadId: participantIds.slice().sort()[0] || null,
              roomMode: 'runtime',
          });
          roomId = taskRoom.id;
          const goal = `${task.title}\n${task.detail || ''}\nCompany: ${state.company} — ${state.mission || ''}`.slice(0, 2000);
          await prisma.$executeRawUnsafe('UPDATE "hivemind"."hyper_rooms" SET "goal" = $1 WHERE "id" = $2::uuid', goal, roomId).catch(() => {});
        }
        const kickoff = [
          `You are the ${state.company} team. Execute this task now.`,
          `TASK [${task.tag}]: ${task.title}`,
          task.detail ? `SCOPE: ${task.detail}` : '',
          state.mission ? `COMPANY CONTEXT: ${state.company} — ${state.mission}` : '',
          'DELIVER: (1) concrete findings grounded in company memory and live web research where needed, (2) 3-5 actionable recommendations specific to this company (no generic advice), (3) an owner and immediate next step per recommendation. Finish with a crisp summary the founder can act on today.',
        ].filter(Boolean).join('\n');
        // Turn row (idempotent per day+task) + fire-and-forget sidecar kick —
        // the same contract as POST /turns; the sweeper is the recovery net.
        const turn = await prisma.$transaction(async (tx) => {
          const key = `cycle-${today}-${task.id}`.slice(0, 64);
          const existing = await tx.hyperTurn.findUnique({ where: { idempotencyKey: key } });
          if (existing) return existing;
          const last = await tx.hyperTurn.findFirst({ where: { roomId }, orderBy: { seq: 'desc' }, select: { seq: true } });
          return tx.hyperTurn.create({
            data: { roomId, seq: (last?.seq ?? 0) + 1, userMessage: kickoff, status: 'live', idempotencyKey: key, lines: [] },
          });
        });
        const roomRow = await prisma.hyperRoom.findUnique({ where: { id: roomId }, select: { participantIds: true, goal: true, projectId: true } });
        dispatchHyperRoomTurn({
          room_id: roomId, turn_id: turn.id, user_id: hq.user_id, org_id: hq.org_id,
          user_message: kickoff, participant_ids: roomRow?.participantIds || [],
          project_id: roomRow?.projectId || null, room_goal: roomRow?.goal || '',
          room_mode: 'runtime',
          task_tag: `ROOM_${String(task.room_tag || task.tag || 'general').toUpperCase()}`,
          callback_url: `${process.env.CONTROL_PLANE_INTERNAL_URL || 'http://hm-control:3000'}/internal/hyper/turn-event`,
        }).catch((e) => console.warn('[hyper-cycle] sidecar kick failed:', e.message));
        task.status = 'active'; task.room_id = roomId;
        await persist();
        console.log(`[hyper-cycle] org ${hq.org_id}: kicked "${task.title}" (spent today ${spent} tok)`);
        // Room execution is always independent from this optional generic start
        // email. Lifecycle emails are emitted by the typed Day-0/1/2 workflows.
        if (HYPER_CYCLE_START_EMAIL_ENABLED) {
          try {
            const owner = await prisma.user.findUnique({ where: { id: hq.user_id }, select: { email: true, displayName: true } });
            if (owner?.email && !owner.email.endsWith('@local.hivemind.dev')) {
              const doneCount = (state.tasks || []).filter((x) => x.status === 'done').length;
              const todoCount = (state.tasks || []).filter((x) => x.status === 'todo').length;
              const { sendSystemEmail } = await import('./email/email-service.js');
              sendSystemEmail({
                templateId: 'announcement',
                to: owner.email,
                vars: {
                  name: (owner.displayName || owner.email).split(' ')[0],
                  subject: `${state.company}: your AI team started "${task.title}"`,
                  heading: 'Your AI team is on it',
                  preheader: `Overnight cycle for ${state.company}`,
                  body: `While you were away, your HyperAgents team picked up the next task for ${state.company}:\n\n"${task.title}" — ${task.detail || ''}\n\nProgress: ${doneCount} done · ${todoCount} still queued.\nOpen the room to review the deliverable and steer the next step.`,
                  cta: 'Open your workspace',
                  appUrl: 'https://singulancelabs.com/hivemind/app/employees',
                  year: String(new Date().getFullYear()),
                },
              }).catch((e) => console.warn('[hyper-cycle] summary email failed:', e.message));
            }
          } catch { /* email best-effort */ }
        }
      } catch (e) {
        console.warn('[hyper-cycle] org tick failed:', e.message);
      }
    }
  };
  setInterval(() => {
    if (new Date().getUTCHours() !== HYPER_CYCLE_HOUR_UTC) return;
    runNightlyCycle().catch((e) => console.warn('[hyper-cycle] run failed:', e.message));
  }, 55 * 60 * 1000);
  console.log(`[hyper-cycle] nightly operating cycle armed (hour=${HYPER_CYCLE_HOUR_UTC} UTC, cap=${HYPER_DAILY_TOKEN_CAP} tok/org/day, start-email=${HYPER_CYCLE_START_EMAIL_ENABLED ? 'enabled' : 'disabled'})`);
}

let hqScheduler = null;
if (prisma && shouldRunRecurringMaintenanceJobs()) {
  startHqScheduler({ prisma })
    .then((scheduler) => { hqScheduler = scheduler; })
    .catch((error) => console.warn('[hq-runtime] scheduler unavailable:', error.message));
}

// Chromium is heavy; cap concurrent captures so parallel onboardings can't
// thrash the single hm-playwright browser. A tiny FIFO semaphore.
const HYPER_SIDECAR_BASE_URL = process.env.EMPLOYEES_SIDECAR_URL || process.env.HIVEMIND_EMPLOYEES_URL || 'http://hm-employees:8060';

// Outreach campaign runner (batch email/call over Places prospects) — lazy
// singleton so `recordOutboundAction` and the session helpers below are bound;
// the drain interval starts on first construction.
let _outreachModule = null;
function outreachModule() {
  if (!_outreachModule) {
    _outreachModule = createOutreachModule({
      prisma, CONFIG, getInternalApiKey, jsonResponse, parseBody,
      requireSession, recordOutboundAction, sidecarBaseUrl: HYPER_SIDECAR_BASE_URL, taraProviderFor,
      onRuntimeCallResult: async ({ orgId, runId, target, result }) => {
        const run = await prisma.runtimePlaybookRun.findFirst({ where: { id: runId, orgId } }).catch(() => null);
        const trigger = run?.trigger && typeof run.trigger === 'object' ? run.trigger : {};
        if (!run || !trigger.runtime_id || !trigger.runtime_epoch) return;
        const correlationRef = String(result?.session_id || target?.resultRef?.sessionId || '');
        const eventType = String(target?.resultRef?.callStatus || '') === 'failed' ? 'call.failed' : 'call.completed';
        await scheduleHqWake({
          prisma,
          runtimeId: trigger.runtime_id,
          orgId,
          runtimeEpoch: trigger.runtime_epoch,
          idempotencyKey: `runtime-tara-result:${run.id}:${target.id}:${target.resultRef?.callId || correlationRef || eventType}`,
          triggerType: 'runtime_playbook_event',
          dueAt: new Date(),
          payload: {
            run_id: run.id,
            event: {
              id: `tara-result:${run.id}:${target.id}:${target.resultRef?.callId || correlationRef || eventType}`,
              type: eventType,
              data: {
                correlation_ref: correlationRef,
                campaign_ref: target.campaignId,
                target_ref: target.id,
                lead_ref: target.leadId || null,
                call_id: target.resultRef?.callId || null,
                transcript_ref: target.resultRef?.callId ? `tara-call:${target.resultRef.callId}` : null,
                insight_id: result?.insight?.id || null,
                call_status: target.resultRef?.callStatus || null,
                outcome: target.resultRef?.callOutcome || null,
                duration_ms: target.resultRef?.durationMs || 0,
                turn_count: target.resultRef?.turnCount || 0,
                summary: target.resultRef?.summary || null,
                sentiment: target.resultRef?.sentiment || null,
                tara_learnings: target.resultRef?.taraLearnings || [],
                next_step: target.resultRef?.nextStep || null,
              },
            },
          },
        });
      },
    });
    _outreachModule.startDrain();
  }
  return _outreachModule;
}

function dispatchHyperRoomTurn(body) {
  // P1 seam contract: stamp the negotiated schema_version if the caller didn't (the
  // sidecar treats it as an optional hint, never a gate). Non-destructive — an already
  // stamped or unusual body passes through untouched, so no existing caller breaks.
  let payload = (body && typeof body === 'object' && body.schema_version === undefined)
    ? { ...body, schema_version: SEAM_SCHEMA_VERSION }
    : body;
  if (payload?.room_mode === 'work' && !payload.execution_identity) {
    payload = { ...payload, execution_identity: buildWorkRoomExecutionIdentity(payload) };
  }
  return internalFetch(`${HYPER_SIDECAR_BASE_URL}/internal/hyper/room-turn`, {
    service: 'hm-employees',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
  });
}

// A Room's execution boundary is durable data, not an inference from its title
// or domain tag. Human-facing Work Rooms keep a neutral Director; Company Rooms
// are invoked by Runtime/playbooks as specialist operators.
function roomExecutionMode(room) {
  if (room?.roomMode === 'work' || room?.room_mode === 'work') return 'work';
  if (room?.roomMode === 'runtime' || room?.room_mode === 'runtime') return 'runtime';
  return room?.agentConnectors?._domain_home === true ? 'runtime' : 'work';
}

function roomExecutionTag(room) {
  if (roomExecutionMode(room) === 'work') return 'WORK';
  if (room?.agentConnectors?._domain_home === true
    && String(room.roomTag || room.room_tag || 'general') === 'general') return 'HQ';
  return `ROOM_${String(room?.roomTag || room?.room_tag || 'general').toUpperCase()}`;
}

function requestsGrowthStage(message) {
  return /\b(growth (operating )?plan|growth stage|next growth|baseline.*plan|plan.*baseline|current (position|status).*growth)\b/i.test(String(message || ''));
}

const connectorStore = prisma ? new ConnectorStore(prisma) : null;
const ADMIN_SECRET = requireAdminSecret();
// Keep the platform-console passcode separate from HIVEMIND_ADMIN_SECRET.
// The latter also authenticates internal administrative paths and must remain
// high-entropy; a human-entered console code must never silently replace it.
const PLATFORM_ADMIN_PASSCODE = requireSecret('HIVEMIND_PLATFORM_ADMIN_PASSCODE', [], {
  allowDevFallback: true,
  devFallback: '126301',
});
const PLATFORM_ADMIN_COOKIE = 'hm_platform_admin';
const PLATFORM_ADMIN_TTL_SECONDS = 15 * 60;
const PLATFORM_ACTIVE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
// Workspace invitations are deliberately short-lived: the email is an
// authentication-bearing join link, so delivery and expiry must agree.
const WORKSPACE_INVITATION_TTL_MS = 24 * 60 * 60 * 1000;
const PLATFORM_UNLOCK_MAX_ATTEMPTS = 5;
const PLATFORM_UNLOCK_WINDOW_MS = 15 * 60 * 1000;
const platformUnlockAttempts = new Map();
const PROMOTION_ATTEMPT_MAX = 20;
const PROMOTION_ATTEMPT_WINDOW_MS = 60 * 60 * 1000;
const promotionAttempts = new Map();
const SIGNUP_ADMISSION_TTL_SECONDS = 15 * 60;
const SIGNUP_ADMISSION_ATTEMPT_MAX = 10;
const SIGNUP_ADMISSION_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const signupAdmissionAttempts = new Map();
const PERSONAL_SIGNUP_INVITATION_CODE = String(process.env.PERSONAL_INVITATION_CODE || '').trim();
const SIGNUP_ADMISSION_SECRET = process.env.HIVEMIND_SIGNUP_ADMISSION_SECRET || CONFIG.sessionSecret || ADMIN_SECRET;
// Runtime beta waitlist — public, unauthenticated form (marketing site), so it
// gets its own modest per-IP throttle rather than reusing the auth attempt
// limiters above (this endpoint never grants access, it only queues an email).
const RUNTIME_WAITLIST_ATTEMPT_MAX = 5;
const RUNTIME_WAITLIST_ATTEMPT_WINDOW_MS = 60 * 60 * 1000;
const runtimeWaitlistAttempts = new Map();

const { WhatsAppLifecycleManager } = await import('./connectors/providers/whatsapp/manager.js');

async function callCoreChatAsUser({ userId, orgId, message, history = [] }) {
  const response = await internalFetch(`${CONFIG.coreApiBaseUrl}/api/chat`, {
    service: 'hm-core',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: { message, history },
    userId: userId || '',
    orgId: orgId || '',
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Core chat failed with ${response.status}`);
  }
  return payload;
}

async function waitForWhatsAppHandshake(bridge, timeoutMs = 15000) {
  if (bridge.isReady()) {
    return { paired: true, phoneNumber: bridge.getPhoneNumber(), qr: null };
  }

  const startupError = typeof bridge.getLastError === 'function' ? bridge.getLastError() : null;
  if (startupError) {
    throw new Error(startupError.message || 'WhatsApp pairing failed');
  }

  const qr = bridge.getQrCode();
  if (qr) {
    return { paired: false, phoneNumber: null, qr };
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve({ paired: false, phoneNumber: null, status: 'generating' });
    }, timeoutMs);

    const onQr = (code) => {
      cleanup();
      resolve({ paired: false, phoneNumber: null, qr: code });
    };
    const onReady = (info) => {
      cleanup();
      resolve({ paired: true, phoneNumber: info?.phoneNumber || bridge.getPhoneNumber(), qr: null });
    };
    const onError = (err) => {
      cleanup();
      reject(new Error(err?.message || 'WhatsApp pairing failed'));
    };

    const cleanup = () => {
      clearTimeout(timer);
      bridge.off('qr', onQr);
      bridge.off('ready', onReady);
      bridge.off('error', onError);
    };

    bridge.once('qr', onQr);
    bridge.once('ready', onReady);
    bridge.once('error', onError);
  });
}

const whatsappManager = new WhatsAppLifecycleManager(process.env.HIVEMIND_WHATSAPP_SESSIONS_DIR, {
  onInboundMessage: async ({ userId, history, event }) => {
    const orgMembership = prisma
      ? await prisma.organizationMember.findFirst({
        where: { userId, status: 'active' },
        select: { organizationId: true },
        orderBy: { createdAt: 'asc' },
      }).catch(() => null)
      : null;

    const chatResult = await callCoreChatAsUser({
      userId,
      orgId: orgMembership?.organizationId || null,
      message: event.text,
      history,
    });

    return { response: chatResult.response || '' };
  },
});

// Provider registry — add new providers here
const PROVIDER_REGISTRY = {
  gmail: {
    oauthModule: './connectors/providers/gmail/oauth.js',
    adapterModule: './connectors/providers/gmail/adapter.js',
    adapterClass: 'GmailAdapter',
    label: 'Gmail',
    scopes: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/userinfo.email'],
  },
  slack: {
    oauthModule: './connectors/providers/slack/oauth.js',
    adapterModule: './connectors/providers/slack/adapter.js',
    adapterClass: 'SlackAdapter',
    label: 'Slack',
    scopes: ['channels:history', 'channels:read', 'groups:history', 'groups:read', 'im:history', 'mpim:history', 'users:read', 'team:read'],
  },
  github: {
    oauthModule: './connectors/providers/github/oauth.js',
    adapterModule: './connectors/providers/github/adapter.js',
    adapterClass: 'GitHubAdapter',
    label: 'GitHub',
    scopes: ['repo', 'read:user'],
  },
  notion: {
    oauthModule: './connectors/providers/notion/oauth.js',
    adapterModule: './connectors/providers/notion/adapter.js',
    adapterClass: 'NotionAdapter',
    label: 'Notion',
    scopes: [],
  },
  gdrive: {
    oauthModule: './connectors/providers/gdrive/oauth.js',
    adapterModule: './connectors/providers/gdrive/adapter.js',
    adapterClass: 'GDriveAdapter',
    label: 'Google Drive',
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  },
  atlassian: {
    oauthModule: './connectors/providers/atlassian/oauth.js',
    adapterModule: './connectors/providers/atlassian/adapter.js',
    adapterClass: 'AtlassianAdapter',
    label: 'Atlassian (Jira + Confluence)',
    scopes: [
      'read:jira-work', 'read:jira-user',
      'read:confluence-content.summary', 'read:confluence-content.all',
      'read:confluence-space.summary', 'read:confluence-user',
      'offline_access',
    ],
  },
  linear: {
    oauthModule: './connectors/providers/linear/oauth.js',
    adapterModule: './connectors/providers/linear/adapter.js',
    adapterClass: 'LinearAdapter',
    label: 'Linear',
    scopes: ['read', 'issues:read', 'projects:read'],
  },
  microsoft: {
    oauthModule: './connectors/providers/microsoft/oauth.js',
    adapterModule: './connectors/providers/microsoft/adapter.js',
    adapterClass: 'MicrosoftAdapter',
    label: 'Microsoft (Outlook + Calendar)',
    scopes: ['offline_access', 'User.Read', 'Mail.Read', 'Calendars.Read', 'Chat.Read', 'ChannelMessage.Read.All'],
  },
  salesforce: {
    oauthModule: './connectors/providers/salesforce/oauth.js',
    adapterModule: './connectors/providers/salesforce/adapter.js',
    adapterClass: 'SalesforceAdapter',
    label: 'Salesforce',
    scopes: ['api', 'refresh_token', 'offline_access', 'chatter_api'],
  },
};

function buildWhatsAppConnectorStatus(status) {
  const paired = Boolean(status?.paired);
  return {
    provider: 'whatsapp',
    label: 'WhatsApp',
    status: paired ? 'connected' : 'available',
    account_ref: status?.phoneNumber || null,
    target_scope: 'personal',
    last_sync_at: null,
    last_error: status?.error || null,
    is_active: paired,
    scopes: ['chat'],
    created_at: null,
    configured: true,
    disabled_reason: null,
    qr_setup: true,
    paired,
    phone_number: status?.phoneNumber || null,
    mode: status?.mode || 'bot',
    allowed_users: Array.isArray(status?.allowedUsers) ? status.allowedUsers : [],
  };
}

async function getProviderRuntimeConfig(providerConfig) {
  if (!providerConfig?.oauthModule) {
    return null;
  }

  try {
    const oauthModule = await import(providerConfig.oauthModule);
    if (typeof oauthModule.getOAuthConfig === 'function') {
      return oauthModule.getOAuthConfig();
    }
  } catch {
    return null;
  }

  return null;
}

function evaluateProviderConfiguration(providerId, oauthConfig) {
  if (!oauthConfig) {
    return {
      configured: false,
      disabledReason: 'OAuth module unavailable',
    };
  }

  const clientId = String(oauthConfig.clientId || '').trim();
  const clientSecret = String(oauthConfig.clientSecret || '').trim();
  const requiresSecret = providerId !== 'notion' ? true : true;

  if (!clientId) {
    return {
      configured: false,
      disabledReason: 'Missing client ID',
    };
  }

  if (requiresSecret && !clientSecret) {
    return {
      configured: false,
      disabledReason: 'Missing client secret',
    };
  }

  return {
    configured: true,
    disabledReason: null,
  };
}

function getConnectorCallbackUrl(provider) {
  return `${CONFIG.publicBaseUrl}/v1/connectors/${provider}/callback`;
}

function isAdminAuthorized(req, url) {
  return req.headers['x-admin-secret'] === ADMIN_SECRET || url.searchParams.get('admin_secret') === ADMIN_SECRET;
}

function secretsMatch(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function signupAdmissionFromRequest(url) {
  const ticket = url.searchParams.get('signup_ticket');
  if (!ticket) return null;
  const verify = (accountType) => verifySignupAdmission({ ticket, accountType, secret: SIGNUP_ADMISSION_SECRET });
  return verify('personal') || verify('enterprise');
}

function emailSignupAdmission(ticket) {
  if (!ticket) return null;
  const verify = (accountType) => verifySignupAdmission({ ticket, accountType, secret: SIGNUP_ADMISSION_SECRET });
  return verify('personal') || verify('enterprise');
}

function emailRequestFingerprint(req) {
  return String(req.headers['cf-connecting-ip'] || req.socket?.remoteAddress || '').trim().slice(0, 128) || null;
}

function emailDeliveryConfigured() {
  if (process.env.HIVEMIND_LOCAL_MODE === 'true') return true;
  return Boolean(String(process.env.AUTH_EMAIL_QUEUE_URL || '').trim() && String(process.env.AUTH_EMAIL_QUEUE_SECRET || '').trim());
}

// A workspace invite is also an account-provisioning admission for its named
// recipient.  It is intentionally verified twice: once before we put its
// opaque token in the short-lived OAuth state, and again after OAuth returns
// with a verified email.  The invitation is not consumed here; the existing
// POST /v1/join/:token path remains the only membership-mutating operation.
async function workspaceInviteAdmissionFromRequest(url) {
  const token = String(url.searchParams.get('workspace_invite') || '').trim();
  if (!token || !prisma) return null;
  const invite = await prisma.orgInvite.findUnique({
    where: { token },
    select: { token: true, email: true, usedAt: true, revokedAt: true, expiresAt: true },
  }).catch(() => null);
  if (!invite || !invite.email || invite.usedAt || invite.revokedAt || invite.expiresAt.getTime() <= Date.now()) return null;
  return { token: invite.token, email: invite.email ? String(invite.email).toLowerCase() : null };
}

async function workspaceInviteMatchesAuthenticatedEmail(token, email) {
  if (!token || !email || !prisma) return false;
  const invite = await prisma.orgInvite.findUnique({
    where: { token },
    select: { email: true, usedAt: true, revokedAt: true, expiresAt: true },
  }).catch(() => null);
  if (!invite || invite.usedAt || invite.revokedAt || invite.expiresAt.getTime() <= Date.now()) return false;
  return Boolean(invite.email) && String(invite.email).toLowerCase() === String(email).toLowerCase();
}

async function verifyEmailTurnstile(token, req) {
  const remoteIp = String(req.headers['cf-connecting-ip'] || req.socket?.remoteAddress || '');
  return verifyEmailTurnstileResponse({ token, remoteIp });
}

async function dispatchAuthEmailOutbox(outboxId) {
  const claimed = await emailIdentity.claimOutbox(outboxId).catch(() => null);
  if (!claimed) return;
  const { email, otp, fragmentUrl } = claimed.payload;
  const rendered = {
    subject: 'Your SINGULANCE sign-in code',
    text: `Your one-time sign-in code is ${otp}. It expires in 10 minutes.\n\nYou can also continue securely here: ${fragmentUrl}\n\nOpening the link alone does not sign you in.`,
    html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#111"><p style="font-size:12px;letter-spacing:.15em;color:#117dff">SINGULANCE · SECURE SIGN IN</p><h1 style="font-size:24px">Your sign-in code</h1><p style="font-size:34px;font-weight:700;letter-spacing:.3em">${otp}</p><p>This code expires in 10 minutes and can be used once.</p><p><a href="${fragmentUrl}" style="display:inline-block;background:#117dff;color:#fff;padding:12px 18px;border-radius:6px;text-decoration:none">Continue securely</a></p><p style="font-size:12px;color:#666">Opening this link does not sign you in automatically. Confirm in the browser to finish.</p></div>`,
  };
  const delivery = await sendRenderedSystemEmail({ to: email, rendered, templateId: 'email_identity_sign_in' });
  await emailIdentity.settleOutbox(outboxId, { ok: delivery.ok, status: delivery.status, messageId: delivery.messageId, code: delivery.error });
  if (!delivery.ok) throw new Error('Auth email delivery failed');
}

async function enqueueAuthEmailOutbox(outboxId) {
  const queueUrl = String(process.env.AUTH_EMAIL_QUEUE_URL || '');
  const secret = String(process.env.AUTH_EMAIL_QUEUE_SECRET || '');
  if (!queueUrl || !secret) {
    if (process.env.HIVEMIND_LOCAL_MODE === 'true') return dispatchAuthEmailOutbox(outboxId);
    throw new Error('Auth email queue is not configured');
  }
  const response = await fetch(`${queueUrl.replace(/\/$/, '')}/enqueue`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-auth-email-secret': secret },
    body: JSON.stringify({ outbox_id: outboxId, environment: process.env.HIVEMIND_LOCAL_MODE === 'true' ? 'local' : 'production', processing_version: 1 }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`Auth email Queue admission failed (${response.status})`);
}

async function effectiveEmailIdentityMode() {
  const flagUrl = String(process.env.AUTH_EMAIL_FLAG_URL || '');
  const secret = String(process.env.AUTH_EMAIL_QUEUE_SECRET || '');
  if (!flagUrl) return resolveEmailIdentityMode();
  if (!secret) return 'off';
  try {
    const response = await fetch(`${flagUrl.replace(/\/$/, '')}/mode`, {
      headers: { 'x-auth-email-secret': secret }, signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return 'off';
    const payload = await response.json();
    return ['off', 'shadow', 'primary', 'email_only'].includes(payload.mode) ? payload.mode : 'off';
  } catch { return 'off'; }
}

async function platformUserExists({ sub, email }) {
  if (!prisma) return false;
  const user = await prisma.user.findFirst({
    where: { OR: [{ zitadelUserId: sub }, ...(email ? [{ email }] : [])] },
    select: { id: true },
  });
  return Boolean(user);
}

function normalizePlatformOperator(value) {
  const operator = String(value || '').trim().replace(/\s+/g, ' ');
  return /^[A-Za-z0-9 .,'_-]{2,80}$/.test(operator) ? operator : null;
}

function makePlatformAdminCookie(operator) {
  const expiresAt = Math.floor(Date.now() / 1000) + PLATFORM_ADMIN_TTL_SECONDS;
  const operatorToken = Buffer.from(operator).toString('base64url');
  const signature = crypto.createHmac('sha256', ADMIN_SECRET).update(`platform:${expiresAt}:${operatorToken}`).digest('base64url');
  return `${PLATFORM_ADMIN_COOKIE}=${expiresAt}.${operatorToken}.${signature}; HttpOnly; Path=/; SameSite=Strict; Secure; Max-Age=${PLATFORM_ADMIN_TTL_SECONDS}`;
}

function getPlatformAdminSession(req) {
  const raw = parseCookies(req)[PLATFORM_ADMIN_COOKIE] || '';
  const [expiresAt, operatorToken, signature] = raw.split('.');
  if (!expiresAt || !operatorToken || !signature || Number(expiresAt) <= Math.floor(Date.now() / 1000)) return null;
  const expected = crypto.createHmac('sha256', ADMIN_SECRET).update(`platform:${expiresAt}:${operatorToken}`).digest('base64url');
  if (!secretsMatch(signature, expected)) return null;
  const operator = normalizePlatformOperator(Buffer.from(operatorToken, 'base64url').toString('utf8'));
  if (!operator) return null;
  // audit_logs.session_id is a UUID column.  The platform-admin cookie is not
  // a database session, but we still need a stable, non-sensitive correlation
  // id for its short lifetime.  Derive an RFC-4122-shaped value from the
  // signed cookie rather than passing a raw hash into Prisma's UUID field.
  const digest = crypto.createHash('sha256').update(raw).digest('hex');
  const sessionId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
  return { operator, expiresAt: Number(expiresAt), sessionId };
}

function hasPlatformAdminCookie(req) {
  return Boolean(getPlatformAdminSession(req));
}

function platformUnlockClient(req) {
  const forwarded = req.headers['x-forwarded-for'];
  return typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : req.socket?.remoteAddress || 'unknown';
}

function platformUnlockLimited(req) {
  const attempt = platformUnlockAttempts.get(platformUnlockClient(req));
  return attempt && attempt.startedAt + PLATFORM_UNLOCK_WINDOW_MS > Date.now() && attempt.count >= PLATFORM_UNLOCK_MAX_ATTEMPTS;
}

function recordPlatformUnlockFailure(req) {
  const client = platformUnlockClient(req);
  const now = Date.now();
  const attempt = platformUnlockAttempts.get(client);
  platformUnlockAttempts.set(client, attempt && attempt.startedAt + PLATFORM_UNLOCK_WINDOW_MS > now
    ? { ...attempt, count: attempt.count + 1 }
    : { startedAt: now, count: 1 });
}

function promotionAttemptKey(req) {
  return platformUnlockClient(req);
}

function promotionAttemptLimited(req) {
  const attempt = promotionAttempts.get(promotionAttemptKey(req));
  return Boolean(attempt && attempt.startedAt + PROMOTION_ATTEMPT_WINDOW_MS > Date.now() && attempt.count >= PROMOTION_ATTEMPT_MAX);
}

function recordPromotionAttempt(req, accepted) {
  const key = promotionAttemptKey(req);
  if (accepted) return promotionAttempts.delete(key);
  const now = Date.now(); const previous = promotionAttempts.get(key);
  promotionAttempts.set(key, previous && previous.startedAt + PROMOTION_ATTEMPT_WINDOW_MS > now
    ? { ...previous, count: previous.count + 1 }
    : { startedAt: now, count: 1 });
}

function signupAdmissionLimited(req) {
  const attempt = signupAdmissionAttempts.get(platformUnlockClient(req));
  return Boolean(attempt && attempt.startedAt + SIGNUP_ADMISSION_ATTEMPT_WINDOW_MS > Date.now()
    && attempt.count >= SIGNUP_ADMISSION_ATTEMPT_MAX);
}

function recordSignupAdmissionAttempt(req, accepted) {
  const key = platformUnlockClient(req);
  if (accepted) return signupAdmissionAttempts.delete(key);
  const now = Date.now(); const previous = signupAdmissionAttempts.get(key);
  signupAdmissionAttempts.set(key, previous && previous.startedAt + SIGNUP_ADMISSION_ATTEMPT_WINDOW_MS > now
    ? { ...previous, count: previous.count + 1 }
    : { startedAt: now, count: 1 });
}

function runtimeWaitlistLimited(req) {
  const attempt = runtimeWaitlistAttempts.get(platformUnlockClient(req));
  return Boolean(attempt && attempt.startedAt + RUNTIME_WAITLIST_ATTEMPT_WINDOW_MS > Date.now()
    && attempt.count >= RUNTIME_WAITLIST_ATTEMPT_MAX);
}

function recordRuntimeWaitlistAttempt(req) {
  const key = platformUnlockClient(req);
  const now = Date.now(); const previous = runtimeWaitlistAttempts.get(key);
  runtimeWaitlistAttempts.set(key, previous && previous.startedAt + RUNTIME_WAITLIST_ATTEMPT_WINDOW_MS > now
    ? { ...previous, count: previous.count + 1 }
    : { startedAt: now, count: 1 });
}

function classifyPlatformUser(user) {
  const plans = (user.organizations || []).map((membership) => membership.org?.plan || 'free');
  const b2b = plans.some((plan) => ['scale', 'enterprise_onboarding', 'enterprise', 'managed'].includes(String(plan).toLowerCase()));
  const lastActiveAt = user.lastActiveAt || null;
  const active = lastActiveAt && Date.now() - new Date(lastActiveAt).getTime() <= PLATFORM_ACTIVE_WINDOW_MS;
  return { tier: b2b ? 'b2b' : 'b2c', active: Boolean(active), plans: [...new Set(plans)] };
}

async function enrichPlatformUsers(records) {
  const enriched = new Array(records.length);
  let next = 0;
  // Platform counts are an admin convenience, not a hot path. Bound the
  // per-organization queries so opening this page cannot saturate Postgres or
  // an AMR agent for a large tenant list.
  const workers = Array.from({ length: Math.min(8, records.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= records.length) return;
      const user = records[index];
      const memberships = user.organizations.filter((membership) => membership.isActive && membership.org);
      let memoryCount = 0;
      let countAvailable = true;
      for (const membership of memberships) {
        try { memoryCount += await platformCoreMemoryCount(membership.org.id, user.id); }
        catch { countAvailable = false; }
      }
      const storageModes = [...new Set(memberships.map((membership) => membership.org.memoryStorageMode || memoryStorageModeFor(membership.org.plan, membership.org.hostingMode)))];
      enriched[index] = {
        ...user,
        ...classifyPlatformUser(user),
        organization_count: memberships.length,
        user_type: memberships.some((membership) => ['enterprise', 'managed', 'scale'].includes(String(membership.org.plan).toLowerCase())) ? 'enterprise' : 'personal',
        memory_storage_modes: storageModes,
        filesystem: storageModes.some((mode) => mode === 'amr_embedded' || mode === 'byod_amr') ? '.amr' : 'hybrid',
        memory_count: countAvailable ? memoryCount : null,
      };
    }
  });
  await Promise.all(workers);
  return enriched;
}

function lifecycleEpisode(day, label, state, fallbackStatus = null) {
  const status = String(state?.status || fallbackStatus || '').trim().toLowerCase();
  if (!status) return null;
  return {
    day,
    label,
    status,
    occurred_at: state?.sent_at || state?.completed_at || state?.started_at || state?.claimed_at || state?.delivery_claimed_at || null,
  };
}

function platformLifecycleSummary(company, organization) {
  const awakenedAt = company?.onboarded_at || null;
  const awakenedAtMs = Date.parse(awakenedAt || '');
  const daysSinceAwakening = Number.isFinite(awakenedAtMs)
    ? Math.max(0, Math.floor((Date.now() - awakenedAtMs) / 86_400_000))
    : null;
  const episodes = [
    lifecycleEpisode(0, 'Day 0 · Awakening', company?.day0_report_email, awakenedAt ? 'awakened' : null),
    lifecycleEpisode(1, 'Day 1 · First move', company?.day1_first_move),
    lifecycleEpisode(2, 'Day 2 · Brand DNA', company?.day2_brand_dna),
  ].filter(Boolean);
  const counts = episodes.reduce((summary, episode) => {
    summary.total += 1;
    if (episode.status === 'sent' || episode.status === 'completed') summary.completed += 1;
    else if (episode.status === 'failed') summary.failed += 1;
    else summary.in_progress += 1;
    return summary;
  }, { total: 0, completed: 0, in_progress: 0, failed: 0 });
  return {
    organization_id: organization.id,
    organization_name: organization.name || 'Unnamed organization',
    awakened_at: awakenedAt,
    days_since_awakening: daysSinceAwakening,
    reached_day: episodes.length ? Math.max(...episodes.map((episode) => episode.day)) : null,
    lifecycle_counts: counts,
    episodes,
  };
}

async function getPlatformUserLifecycle(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      displayName: true,
      organizations: {
        where: { isActive: true },
        select: { org: { select: { id: true, name: true } } },
      },
    },
  });
  if (!user) return null;
  const organizations = user.organizations.map((membership) => membership.org).filter(Boolean);
  if (!organizations.length) {
    return { user: { id: user.id, email: user.email, display_name: user.displayName || null }, organizations: [], totals: { organizations: 0, awakened: 0, lifecycle_count: 0, completed: 0, in_progress: 0, failed: 0 } };
  }
  // An HQ room is the lifecycle authority.  Query only this selected user's
  // active organizations, rather than adding a costly lifecycle N+1 query to
  // the platform-wide list endpoint.
  const orgIds = organizations.map((organization) => organization.id);
  const rooms = await prisma.$queryRawUnsafe(
    `SELECT DISTINCT ON (org_id) org_id, "agent_connectors"->'_company' AS company
       FROM "hivemind"."hyper_rooms"
      WHERE user_id = $1::uuid
        AND org_id = ANY($2::uuid[])
        AND archived_at IS NULL
        AND "agent_connectors" ? '_company'
      ORDER BY org_id, created_at DESC`,
    user.id,
    orgIds,
  );
  const companyByOrg = new Map((rooms || []).map((room) => [String(room.org_id), typeof room.company === 'string' ? JSON.parse(room.company) : room.company]));
  const lifecycleOrganizations = organizations.map((organization) => platformLifecycleSummary(companyByOrg.get(organization.id) || null, organization));
  const totals = lifecycleOrganizations.reduce((summary, organization) => {
    summary.organizations += 1;
    if (organization.awakened_at) summary.awakened += 1;
    summary.lifecycle_count += organization.lifecycle_counts.total;
    summary.completed += organization.lifecycle_counts.completed;
    summary.in_progress += organization.lifecycle_counts.in_progress;
    summary.failed += organization.lifecycle_counts.failed;
    return summary;
  }, { organizations: 0, awakened: 0, lifecycle_count: 0, completed: 0, in_progress: 0, failed: 0 });
  return {
    user: { id: user.id, email: user.email, display_name: user.displayName || null },
    organizations: lifecycleOrganizations,
    totals,
  };
}

async function platformCoreMemoryCount(orgId, userId) {
  const response = await fetch(`${CONFIG.coreApiBaseUrl}/api/profile`, {
    headers: {
      Authorization: `Bearer ${process.env.HIVEMIND_MASTER_API_KEY || ''}`,
      'X-HM-User-Id': userId,
      'X-HM-Org-Id': orgId,
    },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`core profile returned ${response.status}`);
  const payload = await response.json();
  const count = Number(payload?.profile?.memory_count);
  if (!Number.isFinite(count)) throw new Error('core profile count unavailable');
  return count;
}

function buildAdminServiceSnapshot() {
  return {
    service: 'control-plane',
    observed_at: new Date().toISOString(),
    health: {
      ok: true,
      service: 'hivemind-control-plane',
      core_api_base_url: CONFIG.coreApiBaseUrl,
    },
    runtime: {
      pid: process.pid,
      uptime_seconds: Math.round(process.uptime()),
      rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      heap_used_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      node_env: process.env.NODE_ENV || 'development',
    },
    summary: getLogSummary('control-plane'),
    logs: getRecentLogs({ service: 'control-plane', limit: 150 }),
  };
}

function encodeConnectorState(payload) {
  const issuedAt = Date.now();
  const body = Buffer.from(JSON.stringify({ ...payload, issuedAt }), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', CONFIG.sessionSecret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function decodeConnectorState(stateToken) {
  if (!stateToken || !stateToken.includes('.')) {
    return null;
  }

  const [body, signature] = stateToken.split('.');
  if (!body || !signature) {
    return null;
  }

  const expected = crypto.createHmac('sha256', CONFIG.sessionSecret).update(body).digest('base64url');
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (signatureBuffer.length !== expectedBuffer.length) {
    return null;
  }
  if (!crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload || typeof payload !== 'object') {
      return null;
    }
    const issuedAt = Number(payload.issuedAt || 0);
    if (!issuedAt || Number.isNaN(issuedAt)) {
      return null;
    }
    if (Date.now() - issuedAt > CONFIG.authStateTtlSeconds * 1000) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

const zitadelClient = (CONFIG.zitadelIssuerUrl && CONFIG.zitadelClientId && CONFIG.zitadelClientSecret && CONFIG.zitadelRedirectUri)
  ? new ZitadelOidcClient({
      issuerUrl: CONFIG.zitadelIssuerUrl,
      clientId: CONFIG.zitadelClientId,
      clientSecret: CONFIG.zitadelClientSecret,
      redirectUri: CONFIG.zitadelRedirectUri
    })
  : null;
const USE_SECURE_CROSS_SITE_COOKIE = CONFIG.publicBaseUrl.startsWith('https://');

function jsonResponse(res, body, status = 200, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...headers
  });
  res.end(JSON.stringify(body));
}

function bytesToMiB(value) {
  return Math.round(Number(value || 0) / 1024 / 1024);
}

function capacityState(percent, warningAt = 70, criticalAt = 85) {
  if (!Number.isFinite(percent)) return 'unknown';
  if (percent >= criticalAt) return 'critical';
  if (percent >= warningAt) return 'warning';
  return 'healthy';
}

async function getPlatformCapacityMetrics() {
  const observedAt = new Date().toISOString();
  let filesystem = { state: 'unknown', source: 'control-plane runtime filesystem' };
  try {
    // Docker overlayfs reports the backing volume capacity. This deliberately
    // avoids mounting the Docker socket or host root into an application pod.
    const stat = fs.statfsSync(process.env.PLATFORM_METRICS_PATH || '/');
    const totalBytes = Number(stat.blocks) * Number(stat.bsize);
    const freeBytes = Number(stat.bavail) * Number(stat.bsize);
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    const usedPercent = totalBytes ? Math.round((usedBytes / totalBytes) * 1000) / 10 : null;
    filesystem = {
      source: 'control-plane runtime filesystem',
      total_mib: bytesToMiB(totalBytes),
      used_mib: bytesToMiB(usedBytes),
      free_mib: bytesToMiB(freeBytes),
      used_percent: usedPercent,
      state: capacityState(usedPercent),
    };
  } catch (error) {
    filesystem.error = 'Filesystem capacity unavailable';
  }

  let postgres = { state: 'unknown' };
  if (prisma?.$queryRawUnsafe) {
    try {
      const rows = await prisma.$queryRawUnsafe('SELECT pg_database_size(current_database()) AS bytes');
      const bytes = Number(rows?.[0]?.bytes || 0);
      postgres = { database_mib: bytesToMiB(bytes), state: 'healthy' };
    } catch {
      postgres.error = 'Database capacity unavailable';
    }
  }

  let core = { state: 'unknown' };
  try {
    const response = await fetch(`${CONFIG.coreApiBaseUrl}/admin/api/observability`, {
      headers: { 'X-Admin-Secret': ADMIN_SECRET },
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error(`core returned ${response.status}`);
    const snapshot = await response.json();
    core = {
      state: snapshot?.core?.health?.ok ? 'healthy' : 'warning',
      rss_mib: Number(snapshot?.core?.runtime?.rss_mb) || 0,
      heap_used_mib: Number(snapshot?.core?.runtime?.heap_used_mb) || 0,
      uptime_seconds: Number(snapshot?.core?.runtime?.uptime_seconds) || 0,
    };
  } catch {
    core = { state: 'unknown', error: 'Core runtime metrics unavailable' };
  }

  const load = os.loadavg();
  const recommendations = [];
  if (filesystem.state === 'critical') recommendations.push('Expand storage immediately: runtime disk usage is at or above 85%.');
  else if (filesystem.state === 'warning') recommendations.push('Plan a storage expansion soon: runtime disk usage is at or above 70%.');
  if (core.state !== 'healthy') recommendations.push('Investigate core availability before increasing traffic or running migrations.');
  if (!recommendations.length) recommendations.push('Capacity is within the current operating thresholds. Review trends before scaling.');

  return {
    observed_at: observedAt,
    filesystem,
    postgres,
    core,
    load_average: { one_minute: load[0], five_minutes: load[1], fifteen_minutes: load[2] },
    recommendations,
  };
}

function redirect(res, location, cookies = []) {
  const headers = {
    Location: location
  };
  if (cookies.length) {
    headers['Set-Cookie'] = cookies;
  }
  res.writeHead(302, headers);
  res.end();
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  return header.split(';').reduce((acc, entry) => {
    const [rawKey, ...rest] = entry.trim().split('=');
    if (!rawKey) return acc;
    acc[rawKey] = decodeURIComponent(rest.join('='));
    return acc;
  }, {});
}

function writeJsonAtomically(filename, value) {
  const temporary = `${filename}.tmp-${process.pid}-${crypto.randomUUID()}`;
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temporary, filename);
}

async function parseBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  if (!chunks.length) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

/** Same as parseBody but returns the raw Buffer + parsed JSON. Stripe webhook
 *  signature verification requires the exact raw bytes. */
async function parseBodyWithRaw(req, maxBytes = Infinity) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error('Campaign image upload is too large');
      error.status = 413;
      error.code = 'campaign_asset_too_large';
      throw error;
    }
    chunks.push(chunk);
  }
  const raw = chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0);
  let parsed = {};
  try { parsed = raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch { /* keep parsed={} */ }
  return { raw, parsed };
}

// Cookie domain: parent of every hivemind.davinciai.eu subdomain so the
// session is visible to:
//   • hivemind.davinciai.eu     (FE / Vercel — /oauth/authorize lives here)
//   • api.hivemind.davinciai.eu (control plane — sets the cookie)
//   • core.hivemind.davinciai.eu (core API)
// One sign-in propagates to every surface — dashboard, MCP, ChatGPT
// connector, Claude custom connector — without per-host re-auth.
const SESSION_COOKIE_DOMAIN = process.env.HIVEMIND_SESSION_COOKIE_DOMAIN
  || (CONFIG.publicBaseUrl.includes('hivemind.davinciai.eu')
    ? '.hivemind.davinciai.eu'
    : null);

function _cookieDomainAttr() {
  return SESSION_COOKIE_DOMAIN ? `; Domain=${SESSION_COOKIE_DOMAIN}` : '';
}

function makeSessionCookie(sessionId) {
  const value = buildSessionCookie(CONFIG.sessionSecret, sessionId);
  // SameSite=None; Secure required for cross-site cookie auth
  return `${CONFIG.sessionCookieName}=${encodeURIComponent(value)}; HttpOnly; Path=/; SameSite=None; Secure${_cookieDomainAttr()}; Max-Age=${CONFIG.sessionTtlSeconds}`;
}

function clearSessionCookie() {
  return `${CONFIG.sessionCookieName}=; HttpOnly; Path=/; SameSite=None; Secure${_cookieDomainAttr()}; Max-Age=0`;
}

function applyCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (!origin) {
    return;
  }

  if (CONFIG.allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }

  // The platform model-policy editor persists changes with PUT.  Keep this
  // list aligned with the routes we expose so browsers do not reject the
  // authenticated cross-origin preflight before it reaches the handler.
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  // Idempotency-Key is used by durable mutation clients, including workspace
  // invitation creation. Leaving it out makes browsers reject the preflight
  // before the server can provide exactly-once semantics.
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Cache-Control, Idempotency-Key');
}

function sanitizeSlug(input) {
  return `${input || 'workspace'}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || `workspace-${crypto.randomUUID().slice(0, 8)}`;
}

async function getCurrentSession(req) {
  const cookies = parseCookies(req);
  const rawCookie = cookies[CONFIG.sessionCookieName];
  // Verify either cookie or Bearer token (for cross-origin sync)
  let sessionId = verifySessionCookie(CONFIG.sessionSecret, rawCookie);
  
  if (!sessionId) {
    const authHeader = req.headers['authorization'];
    if (authHeader?.startsWith('Bearer ')) {
      sessionId = authHeader.substring(7).trim();
    }
  }

  if (!sessionId) {
    return null;
  }
  const session = await sessionStore.getSession(sessionId);
  return session ? { sessionId, session } : null;
}

async function requireSession(req, res) {
  const current = await getCurrentSession(req);
  if (!current) {
    jsonResponse(res, { error: 'Unauthorized' }, 401);
    return null;
  }
  return current;
}

async function getOrgMembership(userId, orgId) {
  if (!prisma || !isCanonicalUuid(userId) || !isCanonicalUuid(orgId)) return null;
  return prisma.userOrganization.findUnique({
    where: { userId_orgId: { userId, orgId } },
    include: {
      org: true,
      user: {
        select: {
          id: true,
          email: true,
          displayName: true,
          avatarUrl: true,
          lastActiveAt: true,
        },
      },
    },
  });
}

function isCanonicalUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function canManageOrg(role) {
  return role === 'owner' || role === 'admin';
}

async function requireOrgAdmin(req, res, userId, orgId) {
  const membership = await getActiveOrganizationMembership(prisma, { userId, orgId });
  if (!membership) {
    jsonResponse(res, { error: 'Resource not found' }, 404);
    return null;
  }
  // Prefer new roles[] array; fall back to legacy single role column
  const roles = effectiveRoles(membership);
  const allowed = isOrganizationAdmin(membership) || canManageOrg(membership.role);
  if (!allowed) {
    jsonResponse(res, { error: 'Resource not found' }, 404);
    return null;
  }
  // Attach effective roles to the membership object for callers that need it
  membership._roles = roles;
  return membership;
}

async function requirePrivilegedAgentAccess(req, res, current, projectId = null) {
  const membership = await getOrgMembership(current.session.userId, current.session.orgId);
  if (!membership?.isActive) {
    jsonResponse(res, { error: 'Organization membership not found' }, 404);
    return null;
  }
  let projectRole = null;
  const projectMembership = await prisma.projectMember.findFirst({
    where: {
      ...(projectId ? { projectId } : {}),
      userId: current.session.userId,
      role: 'owner',
      project: { orgId: current.session.orgId, archivedAt: null },
    },
    select: { role: true },
  });
  projectRole = projectMembership?.role || null;
  const roles = effectiveRoles(membership);
  if (!canUsePrivilegedAgent(roles, projectRole)) {
    jsonResponse(res, {
      error: 'Forbidden',
      code: 'PRIVILEGED_AGENT_ROLE_REQUIRED',
      required: ['org_owner', 'org_admin', 'team_lead', 'project_owner'],
    }, 403);
    return null;
  }
  return { membership, roles, projectRole };
}

async function validateInviteScopes(orgId, teamIds, projectIds) {
  const uniqueTeamIds = [...new Set(teamIds || [])];
  const uniqueProjectIds = [...new Set(projectIds || [])];
  const [teams, projects] = await Promise.all([
    uniqueTeamIds.length
      ? prisma.team.findMany({ where: { id: { in: uniqueTeamIds }, orgId, archivedAt: null }, select: { id: true } })
      : [],
    uniqueProjectIds.length
      ? prisma.project.findMany({ where: { id: { in: uniqueProjectIds }, orgId, archivedAt: null }, select: { id: true } })
      : [],
  ]);
  if (teams.length !== uniqueTeamIds.length || projects.length !== uniqueProjectIds.length) {
    const error = new Error('Invite contains a team or project outside this organization');
    error.status = 400;
    throw error;
  }
  return { teamIds: uniqueTeamIds, projectIds: uniqueProjectIds };
}

async function resolveCurrentOrg(userId, preferredOrgId = null) {
  if (!isCanonicalUuid(userId)) return { org: null, role: null };
  if (preferredOrgId && isCanonicalUuid(preferredOrgId)) {
    const preferred = await prisma?.userOrganization.findUnique({
      where: { userId_orgId: { userId, orgId: preferredOrgId } },
      include: { org: true },
    });
    if (preferred?.isActive) {
      return { org: preferred.org, role: preferred.role || 'member' };
    }
  }
  const membership = await prisma?.userOrganization.findFirst({
    where: { userId, isActive: true },
    include: { org: true },
    orderBy: [{ joinedAt: 'desc' }, { invitedAt: 'desc' }]
  });
  if (!membership) return { org: null, role: null };
  return { org: membership.org, role: membership.role || 'member' };
}

async function upsertUserFromZitadel(userInfo) {
  if (!prisma) {
    throw new Error('Database unavailable');
  }

  const normalizedEmail = normalizeEmail(userInfo.email);
  const linkedIdentity = await prisma.userIdentity.findUnique({
    where: { provider_providerSubject: { provider: 'zitadel', providerSubject: userInfo.sub } },
    include: { user: true },
  });
  let existing = linkedIdentity?.user || await prisma.user.findUnique({ where: { zitadelUserId: userInfo.sub } });

  // Fallback: find by email (handles re-auth or manual user creation)
  if (!existing && normalizedEmail) {
    existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  }

  if (existing) {
    // SCIM and other identities are additive. Never replace the canonical
    // compatibility subject merely because the verified address is shared.
    const wasScimSeed = typeof existing.zitadelUserId === 'string' && existing.zitadelUserId.startsWith('scim:');
    const updated = await prisma.$transaction(async (tx) => {
      const user = await tx.user.update({ where: { id: existing.id }, data: {
        email: normalizedEmail || existing.email, displayName: userInfo.name || existing.displayName,
        avatarUrl: userInfo.picture || existing.avatarUrl, locale: userInfo.locale || existing.locale, lastActiveAt: new Date(),
      } });
      await tx.userIdentity.upsert({
        where: { provider_providerSubject: { provider: 'zitadel', providerSubject: userInfo.sub } },
        update: { userId: user.id, normalizedEmail, verifiedAt: userInfo.email_verified === false ? null : new Date() },
        create: { userId: user.id, provider: 'zitadel', providerSubject: userInfo.sub, normalizedEmail, verifiedAt: userInfo.email_verified === false ? null : new Date(), isPrimary: existing.zitadelUserId === userInfo.sub },
      });
      return user;
    });
    if (wasScimSeed) {
      try {
        const auditLoggerInst = await _getAuditLogger();
        auditLoggerInst?.log({
          userId: updated.id,
          eventType: 'sso.scim_binding_completed',
          eventCategory: 'provisioning',
          action: 'update',
          resourceType: 'user',
          oldValue: { zitadelUserId: existing.zitadelUserId },
          newValue: { linkedProvider: 'zitadel' },
          metadata: { source: 'sso_login', additive_identity: true },
        }).catch(() => {});
      } catch { /* audit best-effort */ }
    }
    return updated;
  }

  const created = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({ data: {
      zitadelUserId: userInfo.sub, email: normalizedEmail, displayName: userInfo.name,
      avatarUrl: userInfo.picture, locale: userInfo.locale || 'en', lastActiveAt: new Date(),
    } });
    await tx.userIdentity.create({ data: {
      userId: user.id, provider: 'zitadel', providerSubject: userInfo.sub,
      normalizedEmail, verifiedAt: userInfo.email_verified === false ? null : new Date(), isPrimary: true,
    } });
    return user;
  });
  // A user identity alone does not have a trustworthy personal/enterprise
  // profile. Deliver the welcome only once its workspace is activated.
  return created;
}

function resolveCoreTarget(req, org = null) {
  return resolveTierCore({
    origin: req?.headers?.origin || '',
    routingOrigins: CONFIG.tierRoutingOrigins,
    plan: org?.plan,
    defaultInternalUrl: CONFIG.coreApiBaseUrl,
    defaultPublicUrl: CONFIG.corePublicBaseUrl,
    b2bInternalUrl: CONFIG.b2bCoreApiBaseUrl,
    b2bPublicUrl: CONFIG.b2bCorePublicBaseUrl,
    b2cInternalUrl: CONFIG.b2cCoreApiBaseUrl,
    b2cPublicUrl: CONFIG.b2cCorePublicBaseUrl,
  });
}

async function invalidateCorePlanCache(orgId) {
  if (!orgId) return;
  const response = await fetch(`${CONFIG.coreApiBaseUrl}/api/billing/plan/refresh`, {
    method: 'POST',
    headers: {
      'X-API-Key': process.env.HIVEMIND_MASTER_API_KEY || process.env.API_MASTER_KEY || '',
      'X-HM-Org-Id': orgId,
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`core plan refresh failed (${response.status})`);
}

async function syncPersonalStripeSubscription({ org, subscription, plansMod }) {
  if (!org) return null;
  if (!subscription?.id || !subscription.customer) return null;
  if (subscription.metadata?.hivemind_org_id
    && subscription.metadata.hivemind_org_id !== org.id) return null;

  const billingMod = await import('./billing/stripe.js');
  const planId = plansMod.planIdForStripePrice(billingMod.getSubscriptionPriceId(subscription));
  const plan = planId ? plansMod.PLANS[planId] : null;
  if (!plan || planId === 'free' || plan.commercial?.audience === 'enterprise') return null;
  if (!billingMod.isEntitledSubscriptionStatus(subscription.status)) return null;

  const now = new Date();
  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.organization.update({
      where: { id: org.id },
      data: {
        plan: planId,
        stripeCustomerId: String(subscription.customer),
        stripeSubscriptionId: subscription.id,
        subscriptionStatus: subscription.status,
        currentPeriodEnd: subscription.current_period_end
          ? new Date(subscription.current_period_end * 1000)
          : null,
        trialEndsAt: subscription.trial_end ? new Date(subscription.trial_end * 1000) : null,
      },
    });
    const activeStripeEntitlement = await tx.organizationEntitlement.findFirst({
      where: {
        orgId: org.id,
        source: 'stripe',
        phase: 'subscription',
        planId,
        effectiveUntil: null,
      },
      select: { id: true },
    });
    if (!activeStripeEntitlement) {
      await tx.organizationEntitlement.updateMany({
        where: { orgId: org.id, effectiveUntil: null },
        data: { effectiveUntil: now },
      });
      await tx.organizationEntitlement.create({
        data: {
          orgId: org.id,
          source: 'stripe',
          phase: 'subscription',
          planId,
          limits: {},
          effectiveFrom: now,
        },
      });
    }
    return result;
  });
  await invalidateCorePlanCache(updated.id);
  return updated;
}

async function getCoreHealth(coreApiBaseUrl = CONFIG.coreApiBaseUrl) {
  try {
    const healthResponse = await fetch(`${coreApiBaseUrl}/health`);
    return {
      ok: healthResponse.ok,
      status: healthResponse.status
    };
  } catch {
    return {
      ok: false,
      status: null
    };
  }
}

async function buildAnonymousBootstrapPayload(req) {
  const core = resolveCoreTarget(req);
  return {
    authenticated: false,
    user: null,
    organization: null,
    onboarding: null,
    connectivity: {
      // Browser-facing: must be publicly resolvable, not the docker hostname.
      core_api_base_url: core.publicUrl,
      core_health: await getCoreHealth(core.internalUrl)
    },
    client_support: ['claude', 'antigravity', 'vscode', 'remote-mcp', 'notebooklm'],
    session_api_key: null,
  };
}

async function buildBootstrapPayload(user, req, preferredOrgId = null) {
  const { org, role } = await resolveCurrentOrg(user.id, preferredOrgId);
  const effectivePlan = org ? (await getEffectivePlan(prisma, org.id)).plan : null;
  const apiKeys = await listPersistedApiKeys(prisma, user.id, org?.id || null);
  const core = resolveCoreTarget(req, org);
  const coreHealth = await getCoreHealth(core.internalUrl);

  return {
    authenticated: true,
    user: {
      id: user.id,
      email: user.email,
      display_name: user.displayName,
      zitadel_user_id: user.zitadelUserId,
      role: role || 'admin',  // admin | developer | viewer
    },
    organization: org ? {
      id: org.id,
      name: org.name,
      slug: org.slug,
      plan: effectivePlan?.id || org.plan || 'free',
      plan_name: effectivePlan?.name || org.plan || 'Free',
      hosting_mode: org.hostingMode || 'managed',
      memory_storage_mode: org.memoryStorageMode || memoryStorageModeFor(org.plan, org.hostingMode),
      memory_storage_label: memoryStorageLabel(org.memoryStorageMode || memoryStorageModeFor(org.plan, org.hostingMode)),
    } : null,
    onboarding: {
      needs_org_setup: !org,
      has_api_key: apiKeys.length > 0,
      needs_first_source: apiKeys.length > 0 && !org,
    },
    connectivity: {
      // Browser-facing: must be publicly resolvable, not the docker hostname.
      core_api_base_url: core.publicUrl,
      core_health: coreHealth
    },
    client_support: ['claude', 'antigravity', 'vscode', 'remote-mcp', 'notebooklm'],
    // Session key: frontend uses this to call core API without manual key setup.
    // Auto-creates one if user has an org but no keys yet.
    session_api_key: org ? await getOrCreateSessionKey(user.id, org.id) : null,
  };
}

/**
 * Per-tenant Qdrant cleanup on account deletion.
 *  - Fully-deleted ENTERPRISE org (sole owner gone) → DROP its org_<id> collection.
 *  - Surviving enterprise org the user was a member of → delete the user's points
 *    by user_id (org keeps its data).
 *  - Personal/free data → delete the user's points from the shared HIVEMIND_PERSONAL.
 * @param {string} userId
 * @param {Array<{orgId:string, plan:string}>} userOrgs  memberships captured BEFORE deletion
 * @param {string[]} orgIdsToDelete  orgs being fully removed (sole owner)
 */
async function purgeUserVectors(userId, userOrgs = [], orgIdsToDelete = []) {
  try {
    const qdrantUrl = process.env.QDRANT_URL || process.env.QDRANT_CLOUD_URL;
    const qdrantKey = process.env.QDRANT_API_KEY || '';
    if (!qdrantUrl || !userId) {
      console.warn('[account-delete] ⚠ Qdrant purge skipped — no URL or userId:', { qdrantUrl: !!qdrantUrl, userId: !!userId });
      return;
    }
    const { PERSONAL_COLLECTION, orgContainerName, isEnterprisePlan } = await import('./vector/container-router.js');
    const qhdr = { 'Content-Type': 'application/json', ...(qdrantKey ? { 'api-key': qdrantKey } : {}) };
    const delSet = new Set(orgIdsToDelete || []);

    const toDrop = new Set();              // whole collections to remove
    const toScrub = new Set([PERSONAL_COLLECTION]); // delete this user's points only
    for (const { orgId, plan } of userOrgs) {
      if (!isEnterprisePlan(plan)) continue;            // free → data lives in personal pool
      if (delSet.has(orgId)) toDrop.add(orgContainerName(orgId));
      else toScrub.add(orgContainerName(orgId));        // org survives → scrub user
    }

    for (const coll of toDrop) {
      const r = await fetch(`${qdrantUrl}/collections/${coll}`, { method: 'DELETE', headers: qhdr });
      console.log('[account-delete] dropped collection', coll, r.status);
    }
    for (const coll of toScrub) {
      const r = await fetch(`${qdrantUrl}/collections/${coll}/points/delete`, {
        method: 'POST', headers: qhdr,
        body: JSON.stringify({ filter: { must: [{ key: 'user_id', match: { value: userId } }] }, wait: true }),
      });
      console.log('[account-delete] scrubbed user from', coll, r.status);
    }
  } catch (error) {
    console.warn('[account-delete] ⚠ Qdrant purge failed:', error.message);
  }
}

/**
 * Perform cascading account deletion with optional progress callback.
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string[]} opts.orgIdsToDelete
 * @param {(pct: number, step: string) => void} [opts.onProgress] - Called with 0-100 and step label
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function performAccountDeletion({ userId, orgIdsToDelete = [], onProgress }) {
  const t0 = Date.now();
  // 5000 was hitting the 30s Postgres socket timeout for users with large
  // memory corpora because each batch fires 7 dependent deleteMany calls
  // sequentially against indexed FK columns. 800 keeps each batch under ~5s
  // even when the user has 20k+ memories, and parallelising the dependent
  // tables (they don't touch each other) recovers the throughput.
  const BATCH_SIZE = 800;
  let memoryUserTriggersDisabled = false;
  const emit = (pct, step) => {
    console.log(`[account-delete] [${pct}%] ${step}`);
    if (onProgress) onProgress(pct, step);
  };

  emit(0, 'Starting deletion...');
  try {
    // Capture org memberships (with plan) BEFORE we delete userOrganization rows —
    // needed by purgeUserVectors to know which Qdrant containers to drop/scrub.
    const userOrgs = (await prisma.userOrganization.findMany({
      where: { userId },
      select: { orgId: true, org: { select: { plan: true } } },
    })).map((m) => ({ orgId: m.orgId, plan: m.org?.plan }));

    const memoryIds = (
      await prisma.memory.findMany({
        where: { userId },
        select: { id: true },
      })
    ).map((memory) => memory.id);
    emit(5, `Found ${memoryIds.length} memories`);

    if (memoryIds.length) {
      const totalBatches = Math.ceil(memoryIds.length / BATCH_SIZE);
      // Memory deletion is 5% - 70% of progress
      const memoryProgressRange = 65; // 5% to 70%
      await prisma.$executeRawUnsafe('ALTER TABLE "memories" DISABLE TRIGGER USER');
      memoryUserTriggersDisabled = true;
      for (let i = 0; i < memoryIds.length; i += BATCH_SIZE) {
        const batch = memoryIds.slice(i, i + BATCH_SIZE);
        const batchNum = Math.floor(i / BATCH_SIZE) + 1;
        const batchPct = Math.round(5 + (batchNum / totalBatches) * memoryProgressRange);

        // Dependent tables — none of these touch each other, so run them
        // concurrently. Cuts batch wall time from sum to max.
        await Promise.all([
          // Audit records are append-only by database policy. They are not a
          // foreign-key dependency, so preserve them as the immutable record
          // of the erased resource rather than trying to rewrite resource_id.
          prisma.sourceMetadata.deleteMany({ where: { memoryId: { in: batch } } }),
          prisma.codeMemoryMetadata.deleteMany({ where: { memoryId: { in: batch } } }),
          prisma.vectorEmbedding.deleteMany({ where: { memoryId: { in: batch } } }),
          prisma.memoryVersion.deleteMany({ where: { memoryId: { in: batch } } }),
          prisma.relationship.deleteMany({
            where: { OR: [{ fromId: { in: batch } }, { toId: { in: batch } }] },
          }),
          prisma.derivationJob.deleteMany({
            where: { OR: [{ sourceMemoryId: { in: batch } }, { targetMemoryId: { in: batch } }] },
          }),
        ]);
        // memories last — FKs from the parallel deletes must be gone first
        await prisma.memory.deleteMany({ where: { id: { in: batch } } });

        emit(batchPct, `Deleted memory batch ${batchNum}/${totalBatches} (${batch.length} memories)`);
      }
      await prisma.$executeRawUnsafe('ALTER TABLE "memories" ENABLE TRIGGER USER');
      memoryUserTriggersDisabled = false;
    } else {
      emit(70, 'No memories to delete');
    }

    await prisma.platformIntegration.deleteMany({ where: { userId } });
    emit(75, 'Deleted integrations');

    await prisma.apiKey.deleteMany({ where: { userId } });
    emit(78, 'Deleted API keys');

    await prisma.dataExportRequest.deleteMany({ where: { userId } });
    await prisma.syncLog.deleteMany({ where: { userId } });
    emit(80, 'Deleted export requests & sync logs');

    await prisma.session.deleteMany({ where: { userId } });
    emit(83, 'Deleted sessions');

    await prisma.userOrganization.deleteMany({ where: { userId } });
    emit(85, 'Deleted org memberships');

    // `audit_logs` is append-only (the DB rejects UPDATE and DELETE). There is
    // no FK from it to users, so deleting the user below is valid while the
    // immutable audit trail remains available for compliance retention.
    emit(88, 'Preserved immutable audit logs');

    // Delete or detach createdBy FK rows that block user delete.
    // createdBy is NOT NULL on DigitalEmployee + Team + Project +
    // PendingMcpInstall, so we can't null them. For DigitalEmployees +
    // PendingMcpInstalls we hard-delete; for Team/Project we delete only
    // when the user is the sole member (otherwise reassign to first
    // remaining admin).
    try {
      await prisma.digitalEmployee.deleteMany({ where: { createdBy: userId } });
    } catch (err) { console.warn(`[account-delete] ⚠ DigitalEmployee delete: ${err.message}`); }
    try {
      await prisma.pendingMcpInstall.deleteMany({ where: { createdBy: userId } });
    } catch { /* noop */ }
    // Project / Team — keep but reassign createdBy to any remaining admin in
    // same org; if no remaining member, hard-delete.
    const reassignCreatedBy = async (model, scopeKey) => {
      try {
        const rows = await prisma[model].findMany({
          where: { createdBy: userId },
          select: { id: true, orgId: true },
        });
        for (const row of rows) {
          const replacement = await prisma.userOrganization.findFirst({
            where: { orgId: row.orgId, userId: { not: userId } },
            select: { userId: true },
          });
          if (replacement) {
            await prisma[model].update({ where: { id: row.id }, data: { createdBy: replacement.userId } });
          } else {
            await prisma[model].delete({ where: { id: row.id } }).catch(() => {});
          }
        }
      } catch (err) {
        console.warn(`[account-delete] ⚠ reassign ${model}: ${err.message}`);
      }
    };
    await reassignCreatedBy('team');
    await reassignCreatedBy('project');
    emit(89, 'Detached created_by references');

    await prisma.user.delete({ where: { id: userId } });
    emit(90, 'Deleted user record');

    await purgeUserVectors(userId, userOrgs, orgIdsToDelete);
    emit(95, 'Purged vector embeddings');

    if (Array.isArray(orgIdsToDelete) && orgIdsToDelete.length) {
      try {
        await prisma.organization.deleteMany({
          where: { id: { in: orgIdsToDelete } },
        });
      } catch (error) {
        console.warn('[account-delete] ⚠ Orphan org cleanup skipped:', error.message);
      }
      // Self-host: drop the agent registry entries so a deleted org never leaves a stale route in
      // byod-agents.json (core reads this to route memory ops). The customer's OWN data (.amr + their
      // Postgres on their box) is untouched — we don't control it; deletion only severs the central link.
      try {
        const fs = await import('node:fs');
        const regFile = process.env.MNEME_AGENT_REGISTRY_FILE || '/app/data/byod-agents.json';
        let reg = {};
        try { reg = JSON.parse(fs.readFileSync(regFile, 'utf8')); } catch { reg = null; }
        if (reg && typeof reg === 'object') {
          // GDPR erasure (Phase 7): purge the agent's data BEFORE severing its registry route (the
          // route is needed to reach the agent). Best-effort + recorded; self-host physical destruction
          // is the customer's per the DPA. Do it before deleting the reg entry.
          const { remotePurge } = await import('./vector/mneme/remote-backend.js');
          for (const oid of orgIdsToDelete) {
            if (reg[oid]?.url) {
              try {
                const r = await remotePurge(oid);
                emit(96, r ? `Purged self-host agent for org ${oid} (deleted=${r.deleted ?? '?'})` : `Agent purge unreachable for org ${oid} — erasure acknowledged, customer-controlled`);
              } catch (e) { console.warn(`[account-delete] agent purge failed org=${oid}: ${e.message}`); }
            }
          }
          let changed = false;
          for (const oid of orgIdsToDelete) { if (oid in reg) { delete reg[oid]; changed = true; } }
          if (changed) fs.writeFileSync(regFile, JSON.stringify(reg), 'utf8');
        }
      } catch (error) {
        console.warn('[account-delete] ⚠ self-host registry cleanup skipped:', error.message);
      }
    }

    emit(100, 'Account deleted');
    console.log('[account-delete] ✅ Finished in', Date.now() - t0, 'ms for userId:', userId);
    return { ok: true };
  } catch (error) {
    if (memoryUserTriggersDisabled) {
      try {
        await prisma.$executeRawUnsafe('ALTER TABLE "memories" ENABLE TRIGGER USER');
      } catch (triggerError) {
        console.error('[account-delete] Failed to re-enable memories user triggers:', triggerError.message);
      }
    }
    console.error('[account-delete] ✗ FAILED at', Date.now() - t0, 'ms:', error.message);
    console.error('[account-delete] Stack:', error.stack);
    return { ok: false, error: error.message };
  }
}

async function validateAccountDeletion(userId) {
  console.log('[account-delete] Validating deletion for userId:', userId);
  const ownerMemberships = await prisma.userOrganization.findMany({
    where: { userId, role: 'owner' },
    include: { org: true },
  });
  console.log('[account-delete] Owner memberships found:', ownerMemberships.length,
    ownerMemberships.map(m => ({ orgId: m.orgId, orgName: m.org?.name })));

  const orgIdsToDelete = [];

  for (const membership of ownerMemberships) {
    const otherOwners = await prisma.userOrganization.count({
      where: {
        orgId: membership.orgId,
        role: 'owner',
        userId: { not: userId },
      },
    });

    const otherMembers = await prisma.userOrganization.count({
      where: {
        orgId: membership.orgId,
        userId: { not: userId },
      },
    });

    console.log('[account-delete] Org', membership.org?.name, '(', membership.orgId, '): otherOwners=', otherOwners, 'otherMembers=', otherMembers);

    if (otherOwners === 0 && otherMembers > 0) {
      // GDPR right-to-erasure: don't block account deletion when the user is
      // the sole owner of an org with other members. Promote the longest-
      // tenured other member to owner so the org keeps a responsible admin,
      // then continue with the deletion. If promotion fails (no eligible
      // candidate, DB error), fall back to the legacy 409 guard so we never
      // orphan a multi-member org silently.
      // UserOrganization has no createdAt — use joinedAt (falls back to
      // invitedAt for never-joined invites). Prefer existing admins first
      // (string ordering: 'admin' < 'member'), then longest-tenured member.
      let heir = null;
      try {
        heir = await prisma.userOrganization.findFirst({
          where: { orgId: membership.orgId, userId: { not: userId } },
          orderBy: [
            { role: 'asc' },
            { joinedAt: { sort: 'asc', nulls: 'last' } },
            { invitedAt: 'asc' },
          ],
          select: { userId: true, role: true },
        });
      } catch (heirErr) {
        console.error('[account-delete] ✗ Heir lookup failed:', heirErr.message);
      }
      if (!heir) {
        console.warn('[account-delete] ✗ BLOCKED — sole owner with members but no heir found:', membership.org?.name);
        return {
          ok: false,
          status: 409,
          error: 'Transfer ownership or remove other members before deleting this account.',
          org: { id: membership.org.id, name: membership.org.name, slug: membership.org.slug },
        };
      }
      try {
        await prisma.userOrganization.update({
          where: { userId_orgId: { userId: heir.userId, orgId: membership.orgId } },
          data: { role: 'owner' },
        });
        console.log('[account-delete] ✓ Auto-promoted', heir.userId, 'to owner of', membership.org?.name, '(prior role:', heir.role, ')');
      } catch (promoteErr) {
        console.error('[account-delete] ✗ Promote-to-owner failed:', promoteErr.message);
        return {
          ok: false,
          status: 409,
          error: 'Could not transfer ownership automatically. Please demote yourself or promote another owner from the Members page.',
          org: { id: membership.org.id, name: membership.org.name, slug: membership.org.slug },
        };
      }
      // Org now has a new owner — leave it intact, don't add to orgIdsToDelete.
      continue;
    }

    if (otherOwners === 0 && otherMembers === 0) {
      orgIdsToDelete.push(membership.orgId);
    }
  }

  console.log('[account-delete] ✓ Validation passed. Orgs to delete:', orgIdsToDelete);
  return { ok: true, orgIdsToDelete };
}

/**
 * Get or create a session API key for the frontend.
 * Reuses existing 'auto-session' key if available, creates one if not.
 * Returns the raw key string.
 */
async function getOrCreateSessionKey(userId, orgId) {
  try {
    // Only reuse an auto-session key if it is scoped to the active org.
    const existing = await prisma.apiKey.findFirst({
      where: {
        userId,
        orgId,
        name: 'auto-session',
        revokedAt: null,
      },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) {
      try {
        const meta = JSON.parse(existing.description || '{}');
        if (meta.rawKey) return meta.rawKey;
      } catch {}
    }

    // Revoke stale auto-session keys for other orgs so bootstrap can rotate cleanly.
    await prisma.apiKey.updateMany({
      where: {
        userId,
        name: 'auto-session',
        revokedAt: null,
        OR: [
          { orgId: null },
          { orgId: { not: orgId } },
        ],
      },
      data: { revokedAt: new Date() },
    }).catch(() => {});

    // Also revoke malformed duplicates for the same org that no longer expose a raw key.
    await prisma.apiKey.updateMany({
      where: {
        userId,
        orgId,
        name: 'auto-session',
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    }).catch(() => {});

    if (existing) {
      try {
        const meta = JSON.parse(existing.description || '{}');
        if (meta.rawKey) {
          await prisma.apiKey.update({
            where: { id: existing.id },
            data: { revokedAt: null },
          }).catch(() => {});
          return meta.rawKey;
        }
      } catch {}
    }

    // Create a new session key
    const result = await createPersistedApiKey(prisma, {
      userId,
      orgId,
      name: 'auto-session',
      scopes: ['memory', 'search', 'web_search', 'web_crawl', 'mcp', 'admin', 'coding'],
    });

    // Store raw key in description for future bootstrap calls
    if (result.record?.id && result.rawKey) {
      await prisma.apiKey.update({
        where: { id: result.record.id },
        data: { description: JSON.stringify({ rawKey: result.rawKey, auto: true }) },
      }).catch(() => {});
    }

    return result.rawKey || null;
  } catch (err) {
    console.warn('[bootstrap] Failed to get/create session key:', err.message);
    return null;
  }
}

/**
 * Generic proxy: forward an authenticated frontend request to the core API.
 * Authenticates with the master API key and injects user/org context headers.
 */
async function proxyToCore(req, res, { session, method, path, body, query, rawBody }) {
  try {
    const coreUrl = new URL(path, CONFIG.coreApiBaseUrl);
    if (query) coreUrl.search = query;

    const headers = {
      // Core is replaced in-place during canonical releases. Do not reuse a
      // pooled socket that may still point at the retired container.
      Connection: 'close',
      // A proxy retry must preserve one commercial/request identity. Core uses
      // this value for its chat credit reservation idempotency contract.
      'X-Idempotency-Key': String(
        req.headers['x-idempotency-key'] || req.headers['x-request-id'] || crypto.randomUUID(),
      ).slice(0, 180),
    };

    // Forward content-type for POST/multipart
    if (req.headers['content-type']) {
      headers['Content-Type'] = req.headers['content-type'];
    }

    // Timeout: knowledge upload/ingest runs the full synchronous Phase1
    // pipeline (Docling parse + chunk + per-segment embed + promote), which on
    // large multi-MB PDFs takes 150s+ — the 90s default was aborting those and
    // surfacing as a 502 while core kept processing. Give ingest routes 300s;
    // everything else keeps the snappy 90s. (Proper fix is async upload + poll;
    // tracked separately.) Upload is POST so it is never retried below, and the
    // pipeline is checksum-idempotent regardless.
    const isSlowIngest = /\/knowledge\/(upload|document|ingest)/i.test(path) || /\/ingest(\/|$)/i.test(path);
    const isNativeChat = method === 'POST' && /^\/api\/chat(?:\?|$)/i.test(path) && !rawBody;
    const coreResp = await internalFetch(coreUrl.toString(), {
      service: 'hm-core',
      method,
      headers,
      body: rawBody ? rawBody : body,
      rawBody: Boolean(rawBody),
      userId: session.userId || '',
      orgId: session.orgId || '',
      timeoutMs: isSlowIngest ? 300_000 : 90_000,
      // Retry only errors that prove the TCP connection was never established.
      // Never retry a timeout/reset after Core may have started a model call.
      retryOnConnectFailure: isNativeChat,
    });
    const contentType = coreResp.headers.get('content-type') || 'application/json';

    // SSE streaming: pipe through without buffering
    if (contentType.includes('text/event-stream') && coreResp.body) {
      res.writeHead(coreResp.status, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const reader = coreResp.body.getReader();
      const pump = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) { res.end(); return; }
            res.write(value);
          }
        } catch { res.end(); }
      };
      req.on('close', () => { try { reader.cancel(); } catch {} });
      return pump();
    }

    if (!contentType.includes('json') && !contentType.startsWith('text/')) {
      const respBody = Buffer.from(await coreResp.arrayBuffer());
      const headers = { 'Content-Type': contentType, 'Content-Length': respBody.length };
      const cacheControl = coreResp.headers.get('cache-control'); const etag = coreResp.headers.get('etag');
      if (cacheControl) headers['Cache-Control'] = cacheControl;
      if (etag) headers.ETag = etag;
      res.writeHead(coreResp.status, headers); res.end(respBody); return;
    }
    const respBody = await coreResp.text();
    res.writeHead(coreResp.status, { 'Content-Type': contentType });
    res.end(respBody);
  } catch (err) {
    const causeCode = err?.cause?.code || err?.code || null;
    // Core restarts create a short expected connect-refused window. The caller
    // still receives an explicit retryable 503, but routine health/read polls
    // must not flood production logs during that bounded deployment window.
    if (causeCode !== 'ECONNREFUSED' || process.env.PROXY_VERBOSE === '1') {
      console.error('[proxy] Error forwarding to core:', err.message, causeCode ? `cause=${causeCode}` : '');
    }
    jsonResponse(res, {
      error: 'core_temporarily_unavailable',
      message: 'HIVEMIND is briefly unavailable. Please retry this request.',
      retry_after_seconds: 2,
    }, 503);
  }
}

async function proxyKnowledgeWorkflowToCore(req, res, pathname) {
  const enabled = knowledgeWorkflowEnabled();
  const expected = process.env.KNOWLEDGE_INGEST_WORKFLOW_SECRET || '';
  const actual = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!enabled || !secretsMatch(actual, expected)) {
    return jsonResponse(res, { error: 'Unauthorized' }, 401);
  }
  if (req.method !== 'POST') return jsonResponse(res, { error: 'method_not_allowed' }, 405);
  const body = await parseBody(req);
  try {
    const coreResp = await fetch(new URL(pathname, CONFIG.coreApiBaseUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${expected}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
    const responseBody = await coreResp.text();
    res.writeHead(coreResp.status, { 'Content-Type': coreResp.headers.get('content-type') || 'application/json' });
    return res.end(responseBody);
  } catch (error) {
    return jsonResponse(res, {
      error: 'core_temporarily_unavailable',
      message: 'The ingestion core is temporarily unavailable.',
    }, 503);
  }
}

async function proxyCanonicalProjectionToCore(req, res, pathname) {
  if (req.method !== 'POST') return jsonResponse(res, { error: 'method_not_allowed' }, 405);
  const allowedHeaders = [
    'content-type', 'x-hivemind-timestamp', 'x-hivemind-nonce',
    'x-hivemind-content-sha256', 'x-hivemind-signature',
  ];
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) return jsonResponse(res, { error: 'payload_too_large' }, 413);
    chunks.push(chunk);
  }
  const rawBody = Buffer.concat(chunks);
  const headers = Object.fromEntries(allowedHeaders
    .filter((name) => req.headers[name])
    .map((name) => [name, req.headers[name]]));
  try {
    const coreResp = await fetch(new URL(pathname, CONFIG.coreApiBaseUrl), {
      method: 'POST', headers, body: rawBody, signal: AbortSignal.timeout(90_000),
    });
    const responseBody = await coreResp.text();
    res.writeHead(coreResp.status, { 'Content-Type': coreResp.headers.get('content-type') || 'application/json' });
    return res.end(responseBody);
  } catch {
    return jsonResponse(res, {
      error: 'core_temporarily_unavailable',
      message: 'The canonical projection core is temporarily unavailable.',
    }, 503);
  }
}

const server = http.createServer(async (req, res) => {
  applyCorsHeaders(req, res);

  // Shared route helpers must be initialized before any route can call them.
  const _getTeamStore = async () => {
    if (!prisma) return null;
    if (!_getTeamStore._cache) {
      const mod = await import('./teams/team-store.js');
      _getTeamStore._cache = {
        store: new mod.TeamStore(prisma),
        assertTeamPermission: mod.assertTeamPermission,
        assertProjectPermission: mod.assertProjectPermission,
      };
    }
    return _getTeamStore._cache;
  };

  const _getAuditLogger = async () => {
    if (!prisma) return null;
    if (!_getAuditLogger._cache) {
      const mod = await import('./audit/audit-logger.js');
      _getAuditLogger._cache = new mod.AuditLogger(prisma);
    }
    return _getAuditLogger._cache;
  };

  async function audit(entry) {
    const a = await _getAuditLogger();
    if (!a) return;
    a.log(entry).catch(err => console.warn('[audit] log failed:', err.message));
  }

  // An invitation is durable before delivery begins. Do not keep the browser
  // request open while an external mail provider retries: Caddy can time out
  // the request, making a valid invite look like a failed one. Completion is
  // reconciled against the invite row and recorded in the append-only audit.
  function queueWorkspaceInvitationDelivery({ invite, orgId, actorId, adminEmail, vars, expiresAt = null, requestMeta = {} }) {
    queueEmailDelivery(() => sendTeamInvitationEmails({
      memberEmail: invite.email,
      adminEmail,
      vars,
    }), {
      context: { kind: 'workspace_invitation' },
      onSettled: async (result) => {
      const member = result?.member || { ok: false, error: 'delivery_failed' };
      if (member.ok) {
        await prisma.orgInvite.update({
          where: { id: invite.id },
          data: {
            ...(expiresAt ? { expiresAt } : {}),
            lastSentAt: new Date(),
            sendCount: { increment: 1 },
          },
        });
        // The invitation delivery receipt is the only point at which the
        // reminder clock may begin. A failed/unsent invitation never creates
        // an activation lifecycle.
        const activation = await startInvitationActivation({
          prisma,
          invite,
          metadata: { company_name: vars?.orgName || vars?.companyName || null, invitation_kind: requestMeta?.kind || 'workspace' },
        });
        if (activation && !activation.skipped) {
          scheduleActivationWorkflow({ activation }).catch((error) => console.warn('[activation-lifecycle] invitation scheduling failed:', error.message));
        }
      }
      await audit({
        organizationId: orgId,
        userId: actorId,
        eventType: member.ok ? 'invite.email_delivered' : 'invite.email_failed',
        eventCategory: 'auth',
        action: member.ok ? 'deliver' : 'fail',
        resourceType: 'org_invite',
        resourceId: invite.id,
        newValue: {
          provider: member.provider || null,
          ...(member.ok ? { delivery_status: member.deliveryStatus || 'accepted' } : { failure: member.error || 'delivery_failed' }),
        },
        ...requestMeta,
      });
      },
    });
  }

  async function dispatchEnterpriseInvitation({ invitation, token, code = null }) {
    const base = resolveInvitationBaseUrl();
    const activationUrl = `${base}/hivemind/invite?enterprise_invite=${encodeURIComponent(token)}`;
    const selfHosted = invitation.hostingMode === 'self_host';
    const storageLabels = {
      hybrid: 'Managed hybrid company brain',
      amr_embedded: 'Embedded .amr company brain',
      byod_amr: 'Self-hosted BYOD agent company brain',
    };
    const delivery = await sendSystemEmail({
      templateId: 'enterprise_invitation',
      to: invitation.recipientEmail,
      // Sender identity is configured server-side; the browser never supplies it.
      from: process.env.CLOUDFLARE_EMAIL_FROM || process.env.SYSTEM_EMAIL_FROM || 'Singulance <welcome@admin.singulancelabs.com>',
      vars: {
        companyName: invitation.companyName,
        workspaceName: invitation.workspaceName || invitation.companyName,
        recipientEmail: invitation.recipientEmail,
        hostingLabel: selfHosted ? 'Self-hosted' : 'Managed',
        hostingExplanation: selfHosted
          ? 'Your organization operates the memory infrastructure; your deployment is provisioned through the secure setup flow.'
          : 'Singulance hosts and operates your workspace on managed EU infrastructure.',
        invitationUrl: activationUrl,
        accessCode: code || 'Use the secure activation link above.',
        expiresOn: invitation.invitationExpiresAt.toLocaleDateString('en-GB', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' }),
        onboardingDays: invitation.onboardingDays || 14,
        onboardingAllowance: Number(invitation.onboardingLimits?.monthlyCredits) === -1
          ? 'unlimited shared workspace credits during onboarding'
          : `${Number(invitation.onboardingLimits?.monthlyCredits || 0).toLocaleString('en-US')} shared workspace credits per month`,
        storageLabel: storageLabels[invitation.storageMode] || 'Company brain infrastructure',
        welcomeMessage: invitation.welcomeMessage || 'Your HIVEMIND AI Operating System is ready to activate.',
        supportEmail: process.env.SYSTEM_EMAIL_SUPPORT || 'support@singulancelabs.com',
        privacyUrl: process.env.HIVEMIND_PRIVACY_URL || 'https://singulancelabs.com/privacy',
        termsUrl: process.env.HIVEMIND_TERMS_URL || 'https://singulancelabs.com/terms',
      },
    });
    const recorded = await markEnterpriseInvitationDelivery({
      prisma, invitationId: invitation.id, delivered: delivery.ok, error: delivery.error || null,
    });
    return { delivery, invitation: recorded, activationUrl };
  }

  function invitationTemplateVars({ kind, application, invitation = null, invitationUrl, accessCode = null }) {
    const expiresAt = invitation?.invitationExpiresAt || new Date(Date.now() + 14 * 86400000);
    const common = {
      name: application?.name || application?.email?.split('@')[0] || 'there',
      recipientEmail: invitation?.recipientEmail || application?.email,
      invitationUrl,
      expiresOn: expiresAt.toLocaleDateString('en-GB', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' }),
      supportEmail: process.env.SYSTEM_EMAIL_SUPPORT || 'support@singulancelabs.com',
      privacyUrl: process.env.HIVEMIND_PRIVACY_URL || 'https://singulancelabs.com/privacy',
      termsUrl: process.env.HIVEMIND_TERMS_URL || 'https://singulancelabs.com/terms',
    };
    if (kind === 'personal') return common;
    const selfHosted = invitation.hostingMode === 'self_host';
    return {
      ...common,
      companyName: invitation.companyName,
      workspaceName: invitation.workspaceName || invitation.companyName,
      hostingLabel: selfHosted ? 'Self-hosted' : 'Managed',
      hostingExplanation: selfHosted
        ? 'Your organization operates the memory infrastructure; your deployment is provisioned through the secure setup flow.'
        : 'Singulance hosts and operates your workspace on managed EU infrastructure.',
      storageLabel: ({ hybrid: 'Managed hybrid company brain', amr_embedded: 'Embedded .amr company brain', byod_amr: 'Self-hosted BYOD agent company brain' })[invitation.storageMode] || 'Company brain infrastructure',
      accessCode: accessCode || `Code ending ${invitation.accessCodeHint}`,
      onboardingDays: invitation.onboardingDays || 14,
      onboardingAllowance: Number(invitation.onboardingLimits?.monthlyCredits) === -1
        ? 'unlimited shared workspace credits during onboarding'
        : `${Number(invitation.onboardingLimits?.monthlyCredits || 0).toLocaleString('en-US')} shared workspace credits per month`,
      welcomeMessage: invitation.welcomeMessage || 'Your HIVEMIND AI Operating System is ready to activate.',
    };
  }

  function _reqMeta(req) {
    const fwd = req.headers?.['x-forwarded-for'];
    const ip = typeof fwd === 'string' ? fwd.split(',')[0].trim() : null;
    return {
      ipAddress: ip || req.socket?.remoteAddress || null,
      userAgent: req.headers?.['user-agent'] || null,
      platformType: 'webapp',
    };
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // A lifecycle worker may reissue exactly one newer Day-0 renderer for an
  // existing owner. This is not a browser API: it requires the same service
  // token used by the durable lifecycle worker, preserves the original
  // receipt, and refuses a second v3 send.
  if (pathname === '/internal/lifecycle/day0/reissue') {
    if (!isAuthorizedDayOneRequest(req)) return jsonResponse(res, { error: 'Unauthorized' }, 401);
    if (req.method !== 'POST') return jsonResponse(res, { error: 'Method not allowed' }, 405);
    const body = await parseBody(req).catch(() => ({}));
    const orgId = String(body.org_id || '');
    const hqRoomId = String(body.hq_room_id || '');
    if (!/^[0-9a-f-]{36}$/i.test(orgId) || !/^[0-9a-f-]{36}$/i.test(hqRoomId)) {
      return jsonResponse(res, { error: 'org_id and hq_room_id are required' }, 400);
    }
    try {
      const started = await startDayZeroOnboardingReport({ prisma, orgId, hqRoomId, allowVersionedReissue: true });
      if (!started.accepted) return jsonResponse(res, started);
      return jsonResponse(res, await started.completion);
    } catch (error) {
      console.warn('[hyper-company] day-0 report reissue failed:', error.message);
      return jsonResponse(res, { error: 'day0_report_delivery_failed', retryable: true }, 502);
    }
  }

  // Activation reminders use Cloudflare Workflows only as the durable clock.
  // PostgreSQL remains authoritative: every delivery is revalidated here so
  // a delayed workflow can never remind a user who has already progressed.
  if (pathname.startsWith('/internal/lifecycle/activation/')) {
    if (!isAuthorizedActivationLifecycleRequest(req)) return jsonResponse(res, { error: 'Unauthorized' }, 401);
    if (!isActivationLifecycleEnabled()) return jsonResponse(res, { error: 'activation_feature_disabled', retryable: false }, 403);
    if (req.method !== 'POST') return jsonResponse(res, { error: 'Method not allowed' }, 405);
    const body = await parseBody(req).catch(() => ({}));
    const activationId = String(body.activation_id || '');
    const generation = Number(body.generation);
    if (!/^[0-9a-f-]{36}$/i.test(activationId) || !Number.isInteger(generation)) {
      return jsonResponse(res, { error: 'activation_id and generation are required', retryable: false }, 400);
    }
    try {
      const evaluation = await evaluateActivationReminder({ prisma, activationId, generation });
      if (pathname === '/internal/lifecycle/activation/evaluate') {
        return jsonResponse(res, { status: evaluation.status });
      }
      if (pathname !== '/internal/lifecycle/activation/deliver') return jsonResponse(res, { error: 'Not found' }, 404);
      if (evaluation.status !== 'due') return jsonResponse(res, { status: evaluation.status });
      const lifecycle = await claimActivationReminder({ prisma, activationId, generation });
      if (!lifecycle) return jsonResponse(res, { status: 'in_flight_or_stale' });
      if (!lifecycle?.email) {
        await releaseActivationReminderClaim({ prisma, activationId, generation });
        return jsonResponse(res, { error: 'activation_recipient_unavailable', retryable: false }, 422);
      }
      const copy = activationReminderCopy(lifecycle.stage, lifecycle.metadata?.company_name || 'your company');
      const appUrl = `${String(process.env.APP_URL || 'https://next.singulancelabs.com').replace(/\/$/, '')}${copy.href}`;
      const delivery = await sendSystemEmail({
        templateId: 'announcement',
        to: lifecycle.email,
        vars: { name: 'there', subject: copy.subject, preheader: copy.subject, heading: copy.heading, body: copy.body, appUrl },
        notification: lifecycle.org_id && lifecycle.user_id ? {
          orgId: lifecycle.org_id,
          userId: lifecycle.user_id,
          type: copy.type,
          title: copy.subject,
          body: copy.body,
          resourceType: 'activation_lifecycle',
          resourceId: lifecycle.id,
          href: copy.href,
          data: { stage: lifecycle.stage, activation_id: lifecycle.id, generation: lifecycle.generation },
        } : undefined,
      });
      if (!delivery.ok) {
        await releaseActivationReminderClaim({ prisma, activationId, generation });
        return jsonResponse(res, { error: delivery.error || 'activation_delivery_failed', retryable: delivery.retryable !== false }, 502);
      }
      const updated = await recordActivationReminder({ prisma, activationId, generation, delivery: { provider: delivery.provider || null, message_id: delivery.messageId || null } });
      if (updated?.next_reminder_at) {
        await scheduleActivationWorkflow({ activation: updated }).catch((error) => console.warn('[activation-lifecycle] reschedule failed:', error.message));
      }
      return jsonResponse(res, { status: 'delivered', next_reminder_at: updated?.next_reminder_at || null });
    } catch (error) {
      console.warn('[activation-lifecycle] worker request failed:', error.message);
      return jsonResponse(res, { error: 'activation_delivery_failed', retryable: true }, 502);
    }
  }

  // Cloudflare Workflows is the durable clock for Day 1. These endpoints are
  // deliberately service-token-only; browser sessions and generic API keys
  // cannot start complimentary autonomous work or deliver lifecycle mail.
  if (pathname.startsWith('/internal/lifecycle/day1/')) {
    if (!isAuthorizedDayOneRequest(req)) return jsonResponse(res, { error: 'Unauthorized' }, 401);
    if (!isDayOneWorkflowEnabled()) return jsonResponse(res, { error: 'day1_feature_disabled', retryable: false }, 403);
    if (req.method !== 'POST') return jsonResponse(res, { error: 'Method not allowed' }, 405);
    const body = await parseBody(req).catch(() => ({}));
    if (pathname === '/internal/lifecycle/day1/eligible') {
      const companies = await listEligibleDayOneCompanies({ prisma, limit: body.limit });
      return jsonResponse(res, { companies });
    }
    const orgId = String(body.org_id || '');
    const hqRoomId = String(body.hq_room_id || '');
    if (!/^[0-9a-f-]{36}$/i.test(orgId) || !/^[0-9a-f-]{36}$/i.test(hqRoomId)) {
      return jsonResponse(res, { error: 'org_id and hq_room_id are required' }, 400);
    }
    try {
      if (pathname === '/internal/lifecycle/day1/prepare') {
        const result = await prepareDayOneFirstMove({
          prisma, orgId, hqRoomId,
          workflowInstanceId: String(body.workflow_instance_id || ''),
          dispatchTurn: dispatchHyperRoomTurn,
        });
        return jsonResponse(res, result, result.status === 'sent' ? 200 : 202);
      }
      if (pathname === '/internal/lifecycle/day1/deliver') {
        return jsonResponse(res, await deliverDayOneFirstMove({ prisma, orgId, hqRoomId }));
      }
      return jsonResponse(res, { error: 'Not found' }, 404);
    } catch (error) {
      const retryable = ['day1_turn_not_ready', 'day1_turn_not_complete', 'day1_delivery_in_progress'].includes(error.message);
      return jsonResponse(res, { error: error.message, retryable }, retryable ? 409 : 422);
    }
  }

  // Attach SSO context early (subdomain-based org routing; no-op on non-subdomain hosts)
  if (prisma) await attachSsoContext(req, prisma);

  const handleHqRuntimeRoute = createHqRuntimeRouteHandler({
    prisma, requireSession, requirePrivilegedAgentAccess, parseBody, jsonResponse,
    wakeScheduler: () => hqScheduler?.wake?.(),
    runtimePlaybooks: () => hqScheduler?.runtimePlaybooks || null,
  });
  if (await handleHqRuntimeRoute(req, res, url)) return;

  // One-click approval links embedded in HQ Runtime's persona emails
  // (2026-08-17) — public, token-gated, no session required, same
  // established pattern as OrgInvite's /v1/join/:token preview+decline
  // just below. GET is a read-only PREVIEW (a security scanner or email
  // client prefetching this link must never approve anything); only the
  // explicit POST /approve performs the actual, single-use grant.
  const approvalPreviewMatch = pathname.match(/^\/v1\/hq\/approvals\/([^/]+)$/);
  if (approvalPreviewMatch && req.method === 'GET') {
    const preview = await previewApprovalToken({ prisma, token: approvalPreviewMatch[1] });
    return jsonResponse(res, preview);
  }
  const approvalActionMatch = pathname.match(/^\/v1\/hq\/approvals\/([^/]+)\/approve$/);
  if (approvalActionMatch && req.method === 'POST') {
    const result = await consumeApprovalToken({
      prisma, token: approvalActionMatch[1],
      runtimePlaybooks: () => hqScheduler?.runtimePlaybooks || null,
      wakeScheduler: () => hqScheduler?.wake?.(),
    });
    return jsonResponse(res, result, result.ok ? 200 : (result.status === 'not_found' ? 404 : 409));
  }

  // Public waitlist intake is pre-tenant, deliberately data-minimal, rate
  // limited, and always returns the same accepted shape to avoid account
  // discovery. Re-submission refreshes the existing application.
  if (pathname === '/auth/access-applications' && req.method === 'POST') {
    if (signupAdmissionLimited(req)) return jsonResponse(res, { accepted: true }, 202);
    if (!prisma) return jsonResponse(res, { error: 'Service unavailable' }, 503);
    try {
      await submitAccessApplication(prisma, await parseBody(req));
      return jsonResponse(res, { accepted: true }, 202);
    } catch (error) {
      return jsonResponse(res, { error: error.message }, 400);
    }
  }

  if (pathname === '/admin/api/platform/unlock' && req.method === 'POST') {
    if (platformUnlockLimited(req)) return jsonResponse(res, { error: 'Too many attempts. Try again later.' }, 429);
    const body = await parseBody(req).catch(() => ({}));
    // Platform Admin is a single operator console. Do not take an arbitrary
    // display name from the browser: it was not identity proof and made the
    // compact/mobile unlock unnecessarily two-step.
    const operator = 'platform_admin';
    if (!secretsMatch(body?.passcode, PLATFORM_ADMIN_PASSCODE)) {
      recordPlatformUnlockFailure(req);
      return jsonResponse(res, { error: 'Unauthorized' }, 401);
    }
    platformUnlockAttempts.delete(platformUnlockClient(req));
    return jsonResponse(res, { ok: true, expires_in_seconds: PLATFORM_ADMIN_TTL_SECONDS }, 200, {
      'Set-Cookie': makePlatformAdminCookie(operator),
    });
  }

  if (pathname === '/admin/api/platform/users' && req.method === 'GET') {
    if (!hasPlatformAdminCookie(req)) return jsonResponse(res, { error: 'Unauthorized' }, 401);
    if (!prisma) return jsonResponse(res, { error: 'Database unavailable' }, 503);
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') || 100)));
    const query = String(url.searchParams.get('q') || '').trim();
    const where = {
      deletedAt: null,
      ...(query ? { OR: [{ email: { contains: query, mode: 'insensitive' } }, { displayName: { contains: query, mode: 'insensitive' } }] } : {}),
    };
    const [total, records] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        orderBy: [{ lastActiveAt: 'desc' }, { createdAt: 'desc' }],
        take: limit,
        select: {
          id: true, email: true, displayName: true, createdAt: true, lastActiveAt: true,
          organizations: { select: { isActive: true, org: { select: { id: true, name: true, plan: true, hostingMode: true, memoryStorageMode: true } } } },
        },
      }),
    ]);
    const users = await enrichPlatformUsers(records);
    const summary = users.reduce((acc, user) => {
      acc[user.tier] += 1;
      if (user.active) acc.active += 1; else acc.sleeping += 1;
      return acc;
    }, { b2b: 0, b2c: 0, active: 0, sleeping: 0 });
    return jsonResponse(res, { total, returned: users.length, summary, users });
  }

  const platformUserLifecycleMatch = pathname.match(/^\/admin\/api\/platform\/users\/([0-9a-f-]{36})\/lifecycle$/i);
  if (platformUserLifecycleMatch && req.method === 'GET') {
    if (!hasPlatformAdminCookie(req)) return jsonResponse(res, { error: 'Unauthorized' }, 401);
    if (!prisma) return jsonResponse(res, { error: 'Database unavailable' }, 503);
    try {
      const lifecycle = await getPlatformUserLifecycle(platformUserLifecycleMatch[1]);
      if (!lifecycle) return jsonResponse(res, { error: 'User not found' }, 404);
      return jsonResponse(res, { lifecycle, generated_at: new Date().toISOString() });
    } catch (error) {
      console.warn('[platform-admin] lifecycle read failed:', error.message);
      return jsonResponse(res, { error: 'Lifecycle data unavailable' }, 503);
    }
  }

  if (pathname === '/admin/api/platform/metrics' && req.method === 'GET') {
    if (!hasPlatformAdminCookie(req)) return jsonResponse(res, { error: 'Unauthorized' }, 401);
    return jsonResponse(res, await getPlatformCapacityMetrics());
  }

  if (pathname === '/admin/api/platform/models' && (req.method === 'GET' || req.method === 'PUT')) {
    const operator = getPlatformAdminSession(req);
    if (!operator) return jsonResponse(res, { error: 'Unauthorized' }, 401);
    if (!prisma) return jsonResponse(res, { error: 'Database unavailable' }, 503);
    if (req.method === 'GET') return jsonResponse(res, { policies: await listModelGovernance(), prices: await listModelPrices() });
    try {
      const body = await parseBody(req).catch(() => ({}));
      const input = normalizeModelPolicyInput(body);
      const policy = await upsertModelPolicy({ ...input, operator: operator.operator });
      await audit({ eventType: 'platform.model_policy_updated', eventCategory: 'ai_governance', action: 'update',
        // A policy use case is a natural key (for example, `chat_planner`),
        // while AuditLog.resource_id is explicitly UUID-typed.  Preserve the
        // key in immutable metadata instead of writing an invalid UUID.
        resourceType: 'ai_model_policy', resourceId: null,
        metadata: { operator: operator.operator, policy_use_case: policy.use_case, primary_model: policy.primary_model, secondary_model: policy.secondary_model, revision: policy.revision },
        ..._reqMeta(req), sessionId: operator.sessionId, actorType: 'platform_admin' });
      return jsonResponse(res, { policy });
    } catch (error) { return jsonResponse(res, { error: error.message }, 400); }
  }

  if (pathname === '/admin/api/platform/model-prices' && req.method === 'PUT') {
    const operator = getPlatformAdminSession(req);
    if (!operator) return jsonResponse(res, { error: 'Unauthorized' }, 401);
    if (!prisma) return jsonResponse(res, { error: 'Database unavailable' }, 503);
    try {
      const body = await parseBody(req).catch(() => ({}));
      const price = await replaceModelPrice({ model: body.model, provider: body.provider || '*',
        inputMicros: body.input_micros_per_million, outputMicros: body.output_micros_per_million,
        cacheMicros: body.cache_read_micros_per_million, operator: operator.operator });
      await audit({ eventType: 'platform.model_price_updated', eventCategory: 'ai_governance', action: 'update',
        resourceType: 'ai_model_price', resourceId: price.id,
        metadata: { operator: operator.operator, model: price.model, provider: price.provider },
        ..._reqMeta(req), sessionId: operator.sessionId, actorType: 'platform_admin' });
      return jsonResponse(res, { price });
    } catch (error) { return jsonResponse(res, { error: error.message }, 400); }
  }

  if (pathname === '/admin/api/platform/ai-costs' && req.method === 'GET') {
    if (!getPlatformAdminSession(req)) return jsonResponse(res, { error: 'Unauthorized' }, 401);
    if (!prisma) return jsonResponse(res, { error: 'Database unavailable' }, 503);
    try {
      const intelligence = await platformCreditIntelligence({
        query: url.searchParams.get('q') || '', limit: url.searchParams.get('limit') || 200,
        period: url.searchParams.get('period') || 'month',
      });
      return jsonResponse(res, intelligence);
    } catch (error) { return jsonResponse(res, { error: error.message }, 500); }
  }

  const aiCostDetailMatch = pathname.match(/^\/admin\/api\/platform\/ai-costs\/([0-9a-f-]+)$/i);
  if (aiCostDetailMatch && req.method === 'GET') {
    if (!getPlatformAdminSession(req)) return jsonResponse(res, { error: 'Unauthorized' }, 401);
    if (!prisma) return jsonResponse(res, { error: 'Database unavailable' }, 503);
    try {
      return jsonResponse(res, await platformCreditAccountDetail(aiCostDetailMatch[1], { period: url.searchParams.get('period') || 'month' }));
    } catch (error) { return jsonResponse(res, { error: error.message }, error.message === 'Billing account not found' ? 404 : 400); }
  }

  if (pathname === '/admin/api/platform/logs' && req.method === 'GET') {
    if (!hasPlatformAdminCookie(req)) return jsonResponse(res, { error: 'Unauthorized' }, 401);
    const controlPlane = getControlPlaneLogBuffer('hm-control').slice(-200)
      .map((entry) => `[${entry.timestamp}] [${entry.type.toUpperCase()}] ${entry.line}`);
    let core = [];
    try {
      const response = await fetch(`${CONFIG.coreApiBaseUrl}/admin/api/observability`, {
        headers: { 'X-Admin-Secret': ADMIN_SECRET },
      });
      if (!response.ok) throw new Error(`Core observability returned ${response.status}`);
      const snapshot = await response.json();
      core = (snapshot.core?.logs || []).map((entry) =>
        `[${entry.timestamp}] [${String(entry.level || 'info').toUpperCase()}] ${entry.message || entry.line || ''}`);
    } catch (error) {
      core = [`[${new Date().toISOString()}] [WARN] Core logs unavailable: ${error.message}`];
    }
    // hm-employees (Python/FastAPI sidecar) — same X-Admin-Token master-key
    // auth already used for /admin/reload; ring buffer added in log_buffer.py.
    let employees = [];
    try {
      const response = await fetch(`${HYPER_SIDECAR_BASE_URL}/admin/api/logs`, {
        headers: { 'X-Admin-Token': process.env.HIVEMIND_MASTER_API_KEY || '' },
      });
      if (!response.ok) throw new Error(`Employees logs returned ${response.status}`);
      const snapshot = await response.json();
      employees = (snapshot.logs || []).map((entry) =>
        `[${entry.timestamp}] [${String(entry.type || 'info').toUpperCase()}] ${entry.line || ''}`);
    } catch (error) {
      // Log aggregation is an optional read surface. A missing Employees log
      // endpoint must not manufacture a fresh warning on every dashboard poll.
      // Runtime health owns component availability; the log feed stays empty.
      employees = [];
    }
    const mixed = [
      ...core.map((line) => ({ line, source: 'core' })),
      ...controlPlane.map((line) => ({ line, source: 'control' })),
      ...employees.map((line) => ({ line, source: 'employees' })),
    ]
      .sort((a, b) => b.line.localeCompare(a.line))
      .slice(0, 250)
      .map(({ line }) => line);
    const all = [...core, ...controlPlane, ...employees].sort((a, b) => b.localeCompare(a));
    const runtimePattern = /\[(?:hq-runtime|runtime-playbooks)\]|runtime[_ -]playbook|playbook[_ -](?:run|checkpoint|result)|hq[_ -](?:cycle|schedule|wake)|WAITING_(?:AUTHORITY|EVENT)|NEEDS_INTERVENTION/i;
    const hyperAgentsPattern = /\[(?:hyper-engine|single|template)\]|hyper[_ -](?:room|turn|agent)|\/internal\/hyper\/turn-event|room-phase\.v\d+|runtime-stage-result/i;
    const runtime = all.filter((line) => runtimePattern.test(line)).slice(0, 250);
    const hyperagents = all.filter((line) => hyperAgentsPattern.test(line)).slice(0, 250);
    return jsonResponse(res, {
      observed_at: new Date().toISOString(),
      logs: { mixed, runtime, hyperagents, core, control: controlPlane, employees },
    });
  }

  if (pathname === '/admin/api/platform/plans' && (req.method === 'GET' || req.method === 'POST')) {
    const operator = getPlatformAdminSession(req);
    if (!operator) return jsonResponse(res, { error: 'Unauthorized' }, 401);
    if (!prisma) return jsonResponse(res, { error: 'Database unavailable' }, 503);
    if (req.method === 'GET') {
      const planId = url.searchParams.get('plan_id');
      return jsonResponse(res, {
        plans: await listCatalogPlans(prisma),
        history: planId ? await listCatalogPlanHistory(prisma, planId) : [],
      });
    }
    try {
      const body = await parseBody(req).catch(() => ({}));
      const plan = await createCatalogPlanVersion({ prisma, planId: body.plan_id, limits: body.limits,
        action: body.action, operator: operator.operator, requestId: req.headers['x-request-id'] || null });
      await audit({ eventType: 'commercial.plan_catalog_version_created', eventCategory: 'billing', action: 'update', resourceType: 'plan_catalog', resourceId: plan.id,
        metadata: { operator: operator.operator, session_id: operator.sessionId, plan_id: plan.id, version: plan.catalogVersion?.version, change: plan.catalogVersion?.action },
        ..._reqMeta(req), sessionId: operator.sessionId, actorType: 'platform_admin' });
      return jsonResponse(res, { plan }, 201);
    } catch (error) {
      return jsonResponse(res, { error: error.message }, 400);
    }
  }

  // Manual transactional email is deliberately narrow: platform admins can
  // render/send approved welcome templates to one recipient at a time. Real
  // enterprise invitations keep using their secure invitation lifecycle.
  if (pathname === '/admin/api/platform/email/templates' && req.method === 'GET') {
    if (!getPlatformAdminSession(req)) return jsonResponse(res, { error: 'Unauthorized' }, 401);
    return jsonResponse(res, { templates: [{ id: 'custom', label: 'Custom message' }, ...Object.entries(ADMIN_EMAIL_TEMPLATES).map(([id, label]) => ({ id, label }))], sender_domains: ADMIN_EMAIL_SENDER_DOMAINS });
  }
  if (pathname === '/admin/api/platform/email/preview' && req.method === 'POST') {
    if (!getPlatformAdminSession(req)) return jsonResponse(res, { error: 'Unauthorized' }, 401);
    try {
      const message = normalizeAdminEmailMessage(await parseBody(req).catch(() => ({})), {
        appUrl: resolvePublicAppUrl(),
      });
      const templateRendered = message.templateId === 'custom' ? null : renderTemplate(message.templateId, message.vars);
      const rendered = message.templateId === 'custom'
        ? renderAdminComposerMessage(message)
        : (message.visual ? templateRendered : renderAdminComposerMessage({ ...message, subject: templateRendered.subject, body: templateRendered.text, visual: false }));
      return jsonResponse(res, { template_id: message.templateId, from: message.from, recipients: message.recipients, subject: rendered.subject, text: rendered.text, html: rendered.html, visual: message.visual });
    } catch (error) {
      return jsonResponse(res, { error: error.message }, 400);
    }
  }
  if (pathname === '/admin/api/platform/email/send' && req.method === 'POST') {
    const operator = getPlatformAdminSession(req);
    if (!operator) return jsonResponse(res, { error: 'Unauthorized' }, 401);
    try {
      const message = normalizeAdminEmailMessage(await parseBody(req).catch(() => ({})), {
        appUrl: resolvePublicAppUrl(),
      });
      const templateRendered = message.templateId === 'custom' ? null : renderTemplate(message.templateId, message.vars);
      const rendered = message.templateId === 'custom'
        ? renderAdminComposerMessage(message)
        : (message.visual ? templateRendered : renderAdminComposerMessage({ ...message, subject: templateRendered.subject, body: templateRendered.text, visual: false }));
      const results = [];
      for (let index = 0; index < message.recipients.length; index += 1) {
        const to = message.recipients[index];
        // Deliberately sequential: avoids burst delivery and keeps receipts attributable.
        // eslint-disable-next-line no-await-in-loop
        const delivery = await sendRenderedSystemEmail({ to, from: message.from, rendered, templateId: message.templateId === 'custom' ? 'admin_custom' : message.templateId });
        results.push({ to, ...delivery });
      }
      const sent = results.filter((result) => result.ok).length;
      const failed = results.length - sent;
      const delivery = results[0] || { ok: false, error: 'no_recipient' };
      await audit({
        eventType: failed === 0 ? 'commercial.admin_email_sent' : 'commercial.admin_email_delivery_failed',
        eventCategory: 'billing', action: 'create', resourceType: 'system_email', resourceId: crypto.randomUUID(),
        metadata: { operator: operator.operator, session_id: operator.sessionId, template_id: message.templateId, sender_domain: message.fromAddress.split('@')[1], recipient_count: results.length, sent, failed, provider: delivery.provider || null, delivery_status: delivery.deliveryStatus || null, safe_error: failed ? 'partial_or_total_failure' : null },
        ..._reqMeta(req), sessionId: operator.sessionId, actorType: 'platform_admin',
      });
      return jsonResponse(res, { ok: failed === 0, total: results.length, sent, failed, provider: delivery.provider || null, delivery_status: failed ? 'partial_or_failed' : (delivery.deliveryStatus || 'accepted'), results: results.map(({ to, ok, provider, deliveryStatus, error }) => ({ to, ok, provider, delivery_status: deliveryStatus, error })) }, failed === 0 ? 200 : (sent ? 207 : 502));
    } catch (error) {
      return jsonResponse(res, { error: error.message }, 400);
    }
  }

  // ─── Platform Commercial: canonical promotions and pilot grants ───────────
  // This namespace is deliberately separate from tenant billing routes. It is
  // protected by the short-lived platform passkey session and every mutation is
  // append-only audited with the named operator embedded in signed session data.
  if (pathname === '/admin/api/platform/promotions' && (req.method === 'GET' || req.method === 'POST')) {
    const operator = getPlatformAdminSession(req);
    if (!operator) return jsonResponse(res, { error: 'Unauthorized' }, 401);
    if (!prisma) return jsonResponse(res, { error: 'Database unavailable' }, 503);
    if (req.method === 'GET') return jsonResponse(res, { promotions: await listPromotions(prisma) });
    try {
      const body = await parseBody(req).catch(() => ({}));
      // Stripe-backed offers remain drafts until Stripe has accepted the server-
      // generated code. That prevents an active offer which cannot be redeemed.
      const wantsStripeDiscount = String(body.billing_mode || '').toLowerCase() === 'stripe_discount';
      const created = await createPromotion({ prisma, input: { ...body, status: wantsStripeDiscount ? 'draft' : body.status } });
      if (wantsStripeDiscount) {
        try {
          const billingMod = await import('./billing/stripe.js');
          const stripeTerms = await billingMod.createManagedPromotionCode({
            code: created.plaintextCode,
            name: created.promotion.internal_name,
            terms: created.promotion.version.commercial_terms,
          });
          const commercialTerms = {
            ...created.promotion.version.commercial_terms,
            stripe_coupon_id: stripeTerms.couponId,
            stripe_promotion_code_id: stripeTerms.promotionCodeId,
          };
          await prisma.$transaction(async (tx) => {
            await tx.promotionVersion.update({ where: { id: created.promotion.version.id }, data: { commercialTerms } });
            await tx.promotion.update({ where: { id: created.promotion.id }, data: { status: 'active' } });
          });
          created.promotion.status = 'active';
          created.promotion.version.commercial_terms = commercialTerms;
        } catch (stripeError) {
          await audit({ eventType: 'commercial.promotion_stripe_setup_failed', eventCategory: 'billing', action: 'update', resourceType: 'promotion', resourceId: created.promotion.id,
            metadata: { operator: operator.operator, session_id: operator.sessionId, safe_error: stripeError.message.slice(0, 240) }, ..._reqMeta(req), sessionId: operator.sessionId, actorType: 'platform_admin' });
          return jsonResponse(res, { error: 'Stripe promotion setup failed; the offer remains a draft.' }, 502);
        }
      }
      await audit({
        eventType: 'commercial.promotion_created', eventCategory: 'billing', action: 'create',
        resourceType: 'promotion', resourceId: created.promotion.id,
        metadata: { operator: operator.operator, session_id: operator.sessionId, promotion: created.promotion },
        ..._reqMeta(req), sessionId: operator.sessionId, actorType: 'platform_admin',
      });
      return jsonResponse(res, { promotion: created.promotion, ...(created.plaintextCode ? { code: created.plaintextCode } : {}) }, 201);
    } catch (error) {
      return jsonResponse(res, { error: error.message }, 400);
    }
  }

  const adminPromotionRevoke = pathname.match(/^\/admin\/api\/platform\/promotions\/([0-9a-f-]{36})\/revoke$/i);
  if (adminPromotionRevoke && req.method === 'POST') {
    const operator = getPlatformAdminSession(req);
    if (!operator) return jsonResponse(res, { error: 'Unauthorized' }, 401);
    const promotion = await prisma?.promotion.updateMany({ where: { id: adminPromotionRevoke[1], status: { in: ['draft', 'active'] } }, data: { status: 'revoked' } });
    if (!promotion?.count) return jsonResponse(res, { error: 'Not found' }, 404);
    await audit({ eventType: 'commercial.promotion_revoked', eventCategory: 'billing', action: 'update', resourceType: 'promotion', resourceId: adminPromotionRevoke[1],
      metadata: { operator: operator.operator, session_id: operator.sessionId }, ..._reqMeta(req), sessionId: operator.sessionId, actorType: 'platform_admin' });
    return jsonResponse(res, { ok: true });
  }

  // ─── Platform Commercial: named, reusable partner referrals ─────────────
  // One human-readable campaign in Admin, one opaque share URL in public, and
  // one canonical Promotion underneath. Creating never sends email; Send is an
  // explicit, audited operator action after preview.
  if (pathname === '/admin/api/platform/partner-referrals' && (req.method === 'GET' || req.method === 'POST')) {
    const operator = getPlatformAdminSession(req);
    if (!operator) return jsonResponse(res, { error: 'Unauthorized' }, 401);
    if (!prisma) return jsonResponse(res, { error: 'Database unavailable' }, 503);
    const enabled = await partnerReferralsEnabled();
    const baseUrl = resolveInvitationBaseUrl();
    if (req.method === 'GET') return jsonResponse(res, {
      enabled,
      campaigns: enabled ? await listPartnerReferralCampaigns({ prisma, baseUrl }) : [],
    });
    if (!enabled) return jsonResponse(res, { error: 'Partner referrals are not enabled', code: 'feature_disabled' }, 404);
    try {
      const body = await parseBody(req).catch(() => ({}));
      const created = await createPartnerReferralCampaign({ prisma, input: body, baseUrl });
      await audit({ eventType: 'commercial.partner_referral_created', eventCategory: 'billing', action: 'create', resourceType: 'partner_referral', resourceId: created.campaign.campaign_id,
        metadata: { operator: operator.operator, session_id: operator.sessionId, referrer: created.campaign.referrer_email_hint, offer: created.campaign.offer }, ..._reqMeta(req), sessionId: operator.sessionId, actorType: 'platform_admin' });
      return jsonResponse(res, { campaign: created.campaign }, 201);
    } catch (error) {
      return jsonResponse(res, { error: error.message }, 400);
    }
  }

  const adminPartnerReferralAction = pathname.match(/^\/admin\/api\/platform\/partner-referrals\/([0-9a-f-]{36})\/(preview|send|revoke)$/i);
  if (adminPartnerReferralAction && req.method === 'POST') {
    const operator = getPlatformAdminSession(req);
    if (!operator) return jsonResponse(res, { error: 'Unauthorized' }, 401);
    if (!prisma) return jsonResponse(res, { error: 'Database unavailable' }, 503);
    if (!(await partnerReferralsEnabled())) return jsonResponse(res, { error: 'Partner referrals are not enabled', code: 'feature_disabled' }, 404);
    const [, campaignId, action] = adminPartnerReferralAction;
    const found = await getPartnerReferralCampaign({ prisma, campaignId, baseUrl: resolveInvitationBaseUrl() });
    if (!found) return jsonResponse(res, { error: 'Not found' }, 404);
    if (action === 'revoke') {
      await prisma.promotion.update({ where: { id: found.row.promotionId }, data: { status: 'revoked' } });
      await audit({ eventType: 'commercial.partner_referral_revoked', eventCategory: 'billing', action: 'update', resourceType: 'partner_referral', resourceId: campaignId,
        metadata: { operator: operator.operator, session_id: operator.sessionId }, ..._reqMeta(req), sessionId: operator.sessionId, actorType: 'platform_admin' });
      return jsonResponse(res, { ok: true });
    }
    const rendered = renderPartnerReferralInvitation({ referrerName: found.row.referrerDisplayName, invitationUrl: found.campaign.invitation_url,
      offer: found.campaign.offer, welcomeMessage: found.row.welcomeMessage, language: found.campaign.language });
    if (action === 'preview') return jsonResponse(res, { rendered, campaign: found.campaign });
    if (found.campaign.status !== 'active') return jsonResponse(res, { error: 'Invitation is not active' }, 409);
    const delivery = await sendRenderedSystemEmail({ to: found.row.referrerEmail,
      from: process.env.CLOUDFLARE_EMAIL_FROM || process.env.SYSTEM_EMAIL_FROM || 'Singulance <welcome@admin.singulancelabs.com>', rendered, templateId: 'partner_referral_invitation' });
    await markPartnerReferralDelivery({ prisma, campaignId, delivery });
    await audit({ eventType: delivery.ok ? 'commercial.partner_referral_sent' : 'commercial.partner_referral_delivery_failed', eventCategory: 'billing', action: 'create', resourceType: 'partner_referral', resourceId: campaignId,
      metadata: { operator: operator.operator, session_id: operator.sessionId, recipient: found.row.referrerEmailHint, provider: delivery.provider || null }, ..._reqMeta(req), sessionId: operator.sessionId, actorType: 'platform_admin' });
    return jsonResponse(res, { ok: delivery.ok, delivery_status: delivery.deliveryStatus || (delivery.ok ? 'accepted' : 'failed'), error: delivery.error }, delivery.ok ? 200 : 502);
  }

  // ─── Platform Commercial: B2B enterprise invitations ───────────────────
  // Invitations are deliberately distinct from reusable promotions/referrals:
  // one invited owner, one eventual organization, one onboarding grant.
  if (pathname === '/admin/api/platform/invitations' && (req.method === 'GET' || req.method === 'POST')) {
    const operator = getPlatformAdminSession(req);
    if (!operator) return jsonResponse(res, { error: 'Unauthorized' }, 401);
    if (!prisma) return jsonResponse(res, { error: 'Database unavailable' }, 503);
    if (req.method === 'GET') {
      const invitations = await prisma.enterpriseInvitation.findMany({ orderBy: { createdAt: 'desc' }, take: 500 });
      const orgIds = invitations.map((row) => row.orgId).filter(Boolean);
      const grants = orgIds.length ? await prisma.entitlementGrant.findMany({ where: { orgId: { in: orgIds } }, orderBy: { startsAt: 'desc' } }) : [];
      const latestGrant = new Map();
      for (const grant of grants) if (!latestGrant.has(grant.orgId)) latestGrant.set(grant.orgId, grant);
      return jsonResponse(res, { invitations: invitations.map((row) => ({
        ...publicEnterpriseInvitation(row),
        entitlement: row.orgId && latestGrant.get(row.orgId) ? {
          grant_id: latestGrant.get(row.orgId).id, source: latestGrant.get(row.orgId).source,
          status: latestGrant.get(row.orgId).status, ends_at: latestGrant.get(row.orgId).endsAt,
        } : null,
      })) });
    }
    try {
      const body = await parseBody(req).catch(() => ({}));
      const created = await createEnterpriseInvitation({ prisma, input: body });
      await audit({ eventType: 'commercial.enterprise_invitation_created', eventCategory: 'billing', action: 'create',
        resourceType: 'enterprise_invitation', resourceId: created.invitation.id,
        metadata: { operator: operator.operator, session_id: operator.sessionId, account_type: created.invitation.account_type, delivery_status: 'not_sent' },
        ..._reqMeta(req), sessionId: operator.sessionId, actorType: 'platform_admin' });
      // Creation never sends mail. Operators must inspect the server-rendered
      // preview and explicitly confirm the `send` action. Ignore legacy
      // `send_email` payloads so an old frontend cannot bypass that review.
      // The first explicit Send rotates both credentials. Do not expose a
      // draft recovery code that will be invalid by the time mail is sent.
      return jsonResponse(res, { invitation: created.invitation }, 201);
    } catch (error) {
      return jsonResponse(res, { error: error.message }, 400);
    }
  }

  if (pathname === '/admin/api/platform/personal-invitation-link' && req.method === 'POST') {
    const operator = getPlatformAdminSession(req);
    if (!operator) return jsonResponse(res, { error: 'Unauthorized' }, 401);
    const body = await parseBody(req).catch(() => ({}));
    if (!invitationCodeMatches(String(body.invitation_code || ''), PERSONAL_SIGNUP_INVITATION_CODE)) {
      return jsonResponse(res, { error: 'Invitation is unavailable', code: 'invitation_unavailable' }, 403);
    }
    const validityDays = Math.min(90, Math.max(1, Number(body.validity_days || 14)));
    const token = createPersonalInvitationLink({
      configuredCode: PERSONAL_SIGNUP_INVITATION_CODE,
      secret: SIGNUP_ADMISSION_SECRET,
      ttlSeconds: validityDays * 24 * 60 * 60,
    });
    if (!token) return jsonResponse(res, { error: 'Invitation is unavailable', code: 'invitation_unavailable' }, 503);
    const base = resolveInvitationBaseUrl();
    const invitationUrl = `${base}/hivemind/invite?personal_invite=${encodeURIComponent(token)}`;
    await audit({ eventType: 'commercial.personal_invitation_link_created', eventCategory: 'billing', action: 'create',
      resourceType: 'personal_invitation_link', metadata: { operator: operator.operator, session_id: operator.sessionId, validity_days: validityDays },
      ..._reqMeta(req), sessionId: operator.sessionId, actorType: 'platform_admin' });
    return jsonResponse(res, { invitation_url: invitationUrl, expires_in_days: validityDays }, 201);
  }

  if (pathname === '/admin/api/platform/access-applications' && req.method === 'GET') {
    if (!getPlatformAdminSession(req)) return jsonResponse(res, { error: 'Unauthorized' }, 401);
    if (!prisma) return jsonResponse(res, { error: 'Database unavailable' }, 503);
    const accountType = url.searchParams.get('account_type');
    const status = url.searchParams.get('status');
    const where = {
      ...(accountType && ['personal', 'enterprise'].includes(accountType) ? { accountType } : {}),
      ...(status && ['pending', 'approved', 'discarded', 'invited', 'converted'].includes(status) ? { status } : {}),
    };
    const rows = await prisma.accessApplication.findMany({ where, orderBy: { createdAt: 'desc' }, take: 500 });
    return jsonResponse(res, { applications: rows.map(publicAccessApplication) });
  }

  const accessApplicationAction = pathname.match(/^\/admin\/api\/platform\/access-applications\/([0-9a-f-]{36})\/(approve|discard|preview|send)$/i);
  if (accessApplicationAction && req.method === 'POST') {
    const operator = getPlatformAdminSession(req);
    if (!operator) return jsonResponse(res, { error: 'Unauthorized' }, 401);
    if (!prisma) return jsonResponse(res, { error: 'Database unavailable' }, 503);
    const [, applicationId, action] = accessApplicationAction;
    const body = await parseBody(req).catch(() => ({}));
    try {
      let application = await prisma.accessApplication.findUnique({ where: { id: applicationId } });
      if (!application) return jsonResponse(res, { error: 'Not found' }, 404);
      if (action === 'discard') {
        application = await reviewAccessApplication(prisma, { id: applicationId, status: 'discarded', operator: operator.operator, note: body.note });
        await audit({ eventType: 'commercial.access_application_discarded', eventCategory: 'billing', action: 'update', resourceType: 'access_application', resourceId: applicationId,
          metadata: { operator: operator.operator, session_id: operator.sessionId, account_type: application.accountType }, ..._reqMeta(req), sessionId: operator.sessionId, actorType: 'platform_admin' });
        return jsonResponse(res, { application: publicAccessApplication(application) });
      }
      if (action === 'approve') {
        application = await reviewAccessApplication(prisma, { id: applicationId, status: 'approved', operator: operator.operator, note: body.note });
        if (application.accountType === 'enterprise' && !application.enterpriseInvitationId) {
          const normalized = normalizeEnterpriseInvitationInput({
            company_name: body.company_name || application.companyName || `${application.name}'s company`,
            workspace_name: body.workspace_name || body.company_name || application.companyName,
            recipient_email: application.email,
            account_type: body.account_type || 'enterprise_managed',
            storage_mode: body.storage_mode || 'hybrid',
            onboarding_days: body.onboarding_days || 14,
            invitation_expires_at: body.invitation_expires_at,
            welcome_message: body.welcome_message || application.message,
            private_notes: body.private_notes,
          });
          const created = await createEnterpriseInvitation({ prisma, input: normalized });
          application = await prisma.accessApplication.update({ where: { id: applicationId }, data: { enterpriseInvitationId: created.invitation.id, invitationType: 'enterprise' } });
        } else if (application.accountType === 'personal') {
          application = await prisma.accessApplication.update({ where: { id: applicationId }, data: { invitationType: 'personal' } });
        }
        await audit({ eventType: 'commercial.access_application_approved', eventCategory: 'billing', action: 'update', resourceType: 'access_application', resourceId: applicationId,
          metadata: { operator: operator.operator, session_id: operator.sessionId, account_type: application.accountType, enterprise_invitation_id: application.enterpriseInvitationId }, ..._reqMeta(req), sessionId: operator.sessionId, actorType: 'platform_admin' });
        return jsonResponse(res, { application: publicAccessApplication(application) });
      }

      if (!['approved', 'invited'].includes(application.status)) throw new Error('Application must be approved first');
      const base = resolveInvitationBaseUrl();
      if (application.accountType === 'personal') {
        const previewUrl = `${base}/hivemind/invite?personal_invite=generated-when-sent`;
        if (action === 'preview') {
          const rendered = renderTemplate('personal_invitation', invitationTemplateVars({ kind: 'personal', application, invitationUrl: previewUrl }));
          return jsonResponse(res, { from: 'welcome@admin.singulancelabs.com', to: application.email, ...rendered });
        }
        const token = createPersonalInvitationLink({ configuredCode: PERSONAL_SIGNUP_INVITATION_CODE, secret: SIGNUP_ADMISSION_SECRET, ttlSeconds: 14 * 86400 });
        if (!token) throw new Error('Invitation service is unavailable');
        const invitationUrl = `${base}/hivemind/invite?personal_invite=${encodeURIComponent(token)}`;
        const delivery = await sendSystemEmail({ templateId: 'personal_invitation', to: application.email,
          from: process.env.CLOUDFLARE_EMAIL_FROM || process.env.SYSTEM_EMAIL_FROM || 'Singulance <welcome@admin.singulancelabs.com>',
          vars: invitationTemplateVars({ kind: 'personal', application, invitationUrl }) });
        if (!delivery.ok) return jsonResponse(res, { error: delivery.error || 'Email delivery failed' }, 502);
        application = await prisma.accessApplication.update({ where: { id: applicationId }, data: { status: 'invited', invitationSentAt: new Date() } });
        await audit({ eventType: 'commercial.personal_invitation_sent', eventCategory: 'billing', action: 'create', resourceType: 'access_application', resourceId: applicationId,
          metadata: { operator: operator.operator, session_id: operator.sessionId, provider: delivery.provider || null }, ..._reqMeta(req), sessionId: operator.sessionId, actorType: 'platform_admin' });
        return jsonResponse(res, { application: publicAccessApplication(application), delivery: { ok: true, provider: delivery.provider || null } });
      }

      const invitation = await prisma.enterpriseInvitation.findUnique({ where: { id: application.enterpriseInvitationId } });
      if (!invitation) throw new Error('Invitation is unavailable');
      if (action === 'preview') {
        const rendered = renderTemplate('enterprise_invitation', invitationTemplateVars({
          kind: 'enterprise', application, invitation,
          invitationUrl: `${base}/hivemind/invite?enterprise_invite=generated-when-sent`,
          accessCode: 'Generated securely when sent',
        }));
        return jsonResponse(res, { from: 'welcome@admin.singulancelabs.com', to: application.email, ...rendered });
      }
      const rotated = await rotateEnterpriseInvitationSecrets({ prisma, invitationId: invitation.id, rotateCode: true, rotateLink: true });
      const raw = await prisma.enterpriseInvitation.findUnique({ where: { id: invitation.id } });
      const sent = await dispatchEnterpriseInvitation({ invitation: raw, token: rotated.plaintextToken, code: rotated.plaintextCode });
      if (!sent.delivery.ok) return jsonResponse(res, { error: sent.delivery.error || 'Email delivery failed' }, 502);
      application = await prisma.accessApplication.update({ where: { id: applicationId }, data: { status: 'invited', invitationSentAt: new Date() } });
      await audit({ eventType: 'commercial.enterprise_waitlist_invitation_sent', eventCategory: 'billing', action: 'create', resourceType: 'access_application', resourceId: applicationId,
        metadata: { operator: operator.operator, session_id: operator.sessionId, enterprise_invitation_id: invitation.id, provider: sent.delivery.provider || null }, ..._reqMeta(req), sessionId: operator.sessionId, actorType: 'platform_admin' });
      return jsonResponse(res, { application: publicAccessApplication(application), delivery: { ok: true, provider: sent.delivery.provider || null } });
    } catch (error) {
      return jsonResponse(res, { error: error.message }, /unavailable|not found/i.test(error.message) ? 404 : 400);
    }
  }

  const adminInvitationDetail = pathname.match(/^\/admin\/api\/platform\/invitations\/([0-9a-f-]{36})$/i);
  if (adminInvitationDetail && req.method === 'GET') {
    const operator = getPlatformAdminSession(req);
    if (!operator) return jsonResponse(res, { error: 'Unauthorized' }, 401);
    const invitation = await prisma?.enterpriseInvitation.findUnique({ where: { id: adminInvitationDetail[1] } });
    if (!invitation) return jsonResponse(res, { error: 'Not found' }, 404);
    const [auditRows, grants] = await Promise.all([
      prisma.auditLog.findMany({ where: { resourceType: 'enterprise_invitation', resourceId: invitation.id }, orderBy: { createdAt: 'desc' }, take: 100 }),
      invitation.orgId ? prisma.entitlementGrant.findMany({ where: { orgId: invitation.orgId }, orderBy: { startsAt: 'desc' }, take: 20 }) : [],
    ]);
    return jsonResponse(res, { invitation: publicEnterpriseInvitation(invitation), audit: auditRows, entitlement_grants: grants });
  }

  const adminInvitationAction = pathname.match(/^\/admin\/api\/platform\/invitations\/([0-9a-f-]{36})\/(preview|send|resend|revoke|extend|rotate-code|code-copied|update-max-invites)$/i);
  if (adminInvitationAction && req.method === 'POST') {
    const operator = getPlatformAdminSession(req);
    if (!operator) return jsonResponse(res, { error: 'Unauthorized' }, 401);
    if (!prisma) return jsonResponse(res, { error: 'Database unavailable' }, 503);
    const [, invitationId, action] = adminInvitationAction;
    const body = await parseBody(req).catch(() => ({}));
    try {
      if (action === 'preview') {
        const invitation = await prisma.enterpriseInvitation.findUnique({ where: { id: invitationId } });
        if (!invitation) return jsonResponse(res, { error: 'Not found' }, 404);
        const base = resolveInvitationBaseUrl();
        const rendered = renderTemplate('enterprise_invitation', invitationTemplateVars({
          kind: 'enterprise',
          application: null,
          invitation,
          invitationUrl: `${base}/hivemind/invite?enterprise_invite=generated-when-sent`,
          accessCode: 'Generated securely when sent',
        }));
        await audit({ eventType: 'commercial.enterprise_invitation_previewed', eventCategory: 'billing', action: 'read',
          resourceType: 'enterprise_invitation', resourceId: invitation.id,
          metadata: { operator: operator.operator, session_id: operator.sessionId },
          ..._reqMeta(req), sessionId: operator.sessionId, actorType: 'platform_admin' });
        return jsonResponse(res, {
          from: 'welcome@admin.singulancelabs.com',
          to: invitation.recipientEmail,
          invitation: publicEnterpriseInvitation(invitation),
          ...rendered,
        });
      }
      if (action === 'revoke') {
        await revokeEnterpriseInvitation({ prisma, invitationId });
        await audit({ eventType: 'commercial.enterprise_invitation_revoked', eventCategory: 'billing', action: 'update', resourceType: 'enterprise_invitation', resourceId: invitationId,
          metadata: { operator: operator.operator, session_id: operator.sessionId }, ..._reqMeta(req), sessionId: operator.sessionId, actorType: 'platform_admin' });
        return jsonResponse(res, { ok: true });
      }
      if (action === 'extend') {
        const updated = await extendEnterpriseInvitation({ prisma, invitationId, expiresAt: body.invitation_expires_at || body.expires_at });
        await audit({ eventType: 'commercial.enterprise_invitation_extended', eventCategory: 'billing', action: 'update', resourceType: 'enterprise_invitation', resourceId: invitationId,
          metadata: { operator: operator.operator, session_id: operator.sessionId, invitation_expires_at: updated.invitationExpiresAt }, ..._reqMeta(req), sessionId: operator.sessionId, actorType: 'platform_admin' });
        return jsonResponse(res, { invitation: publicEnterpriseInvitation(updated) });
      }
      if (action === 'update-max-invites') {
        const updated = await updateEnterpriseInvitationMaxInvites({
          prisma,
          invitationId,
          maxInvites: body.max_invites,
          monthlyCredits: body.monthly_credits,
        });
        await audit({ eventType: 'commercial.enterprise_invitation_max_invites_updated', eventCategory: 'billing', action: 'update', resourceType: 'enterprise_invitation', resourceId: invitationId,
          metadata: { operator: operator.operator, session_id: operator.sessionId, max_invites: updated.invitation.max_invites, max_users: updated.invitation.max_users, monthly_credits: updated.invitation.onboarding_monthly_credits, applied_to_active_tenant: updated.appliedToActiveTenant, entitlement_version: updated.entitlementVersion?.version || null },
          ..._reqMeta(req), sessionId: operator.sessionId, actorType: 'platform_admin' });
        return jsonResponse(res, { invitation: updated.invitation, applied_to_active_tenant: updated.appliedToActiveTenant, entitlement_version: updated.entitlementVersion?.version || null });
      }
      if (action === 'code-copied') {
        await audit({ eventType: 'commercial.enterprise_invitation_code_copied', eventCategory: 'billing', action: 'read', resourceType: 'enterprise_invitation', resourceId: invitationId,
          metadata: { operator: operator.operator, session_id: operator.sessionId }, ..._reqMeta(req), sessionId: operator.sessionId, actorType: 'platform_admin' });
        return jsonResponse(res, { ok: true });
      }
      const rotateCode = action === 'send' || action === 'rotate-code';
      const rotated = await rotateEnterpriseInvitationSecrets({ prisma, invitationId, rotateCode, rotateLink: action !== 'rotate-code' });
      if (action === 'rotate-code') {
        await audit({ eventType: 'commercial.enterprise_invitation_code_rotated', eventCategory: 'billing', action: 'update', resourceType: 'enterprise_invitation', resourceId: invitationId,
          metadata: { operator: operator.operator, session_id: operator.sessionId }, ..._reqMeta(req), sessionId: operator.sessionId, actorType: 'platform_admin' });
        return jsonResponse(res, { invitation: rotated.invitation, code: rotated.plaintextCode });
      }
      if (!['send', 'resend'].includes(action)) throw new Error('Unsupported invitation action');
      const raw = await prisma.enterpriseInvitation.findUnique({ where: { id: invitationId } });
      const sent = await dispatchEnterpriseInvitation({ invitation: raw, token: rotated.plaintextToken, code: action === 'send' ? rotated.plaintextCode : null });
      const sentEvent = action === 'resend' ? 'commercial.enterprise_invitation_resent' : 'commercial.enterprise_invitation_sent';
      await audit({ eventType: sent.delivery.ok ? sentEvent : 'commercial.enterprise_invitation_delivery_failed', eventCategory: 'billing', action: 'update', resourceType: 'enterprise_invitation', resourceId: invitationId,
        metadata: { operator: operator.operator, session_id: operator.sessionId, safe_error: sent.delivery.error || null }, ..._reqMeta(req), sessionId: operator.sessionId, actorType: 'platform_admin' });
      if (!sent.delivery.ok) return jsonResponse(res, { error: sent.delivery.error || 'Email delivery failed', invitation: sent.invitation }, 502);
      return jsonResponse(res, { invitation: sent.invitation, activation_url: sent.activationUrl, ...(action === 'send' ? { code: rotated.plaintextCode } : {}), email_dispatch: sent.delivery });
    } catch (error) {
      return jsonResponse(res, { error: error.message }, /unavailable|not found/i.test(error.message) ? 404 : 400);
    }
  }

  // ─── Platform Commercial: two-phase referral campaigns ────────────────────
  // A single admin-generated code configures BOTH phases of an enterprise
  // signup: onboarding (custom duration, default 14 days) and runway
  // (recurring, monthly by default), plus an optional percentage-off or
  // fixed-amount-off discount. Distinct from Promotion: this is the model the
  // signup page's "Partner referral code" field already redeems against
  // (see claimReferralOffer/activateOffer in billing/entitlements.js).
  if (pathname === '/admin/api/platform/referral-campaigns' && (req.method === 'GET' || req.method === 'POST')) {
    const operator = getPlatformAdminSession(req);
    if (!operator) return jsonResponse(res, { error: 'Unauthorized' }, 401);
    if (!prisma) return jsonResponse(res, { error: 'Database unavailable' }, 503);
    if (req.method === 'GET') {
      const campaigns = await prisma.referralCampaign.findMany({ orderBy: { createdAt: 'desc' }, take: 250 });
      return jsonResponse(res, { referral_campaigns: campaigns.map(publicReferralCampaign) });
    }
    try {
      const body = await parseBody(req).catch(() => ({}));
      const normalized = normalizeReferralCampaignInput(body);
      const campaign = await prisma.referralCampaign.create({
        data: {
          code: normalized.code,
          name: normalized.name,
          active: normalized.active,
          maxRedemptions: normalized.maxRedemptions,
          startsAt: normalized.startsAt,
          endsAt: normalized.endsAt,
          onboardingDays: normalized.onboardingDays,
          onboardingPlan: normalized.onboardingPlan,
          onboardingLimits: normalized.onboardingLimits,
          runwayPlan: normalized.runwayPlan,
          runwayLimits: normalized.runwayLimits,
          runwayIntervalMonths: normalized.runwayIntervalMonths,
          discountKind: normalized.discountKind,
          discountPercent: normalized.discountPercent,
          discountAmountCents: normalized.discountAmountCents,
          discountCurrency: normalized.discountCurrency,
        },
      });
      await audit({
        eventType: 'commercial.referral_campaign_created', eventCategory: 'billing', action: 'create',
        resourceType: 'referral_campaign', resourceId: campaign.id,
        metadata: { operator: operator.operator, session_id: operator.sessionId, code: campaign.code, name: campaign.name },
        ..._reqMeta(req), sessionId: operator.sessionId, actorType: 'platform_admin',
      });
      return jsonResponse(res, { referral_campaign: publicReferralCampaign(campaign) }, 201);
    } catch (error) {
      if (error?.code === 'P2002') return jsonResponse(res, { error: 'That code is already in use' }, 409);
      return jsonResponse(res, { error: error.message }, 400);
    }
  }

  const adminReferralCampaignRevoke = pathname.match(/^\/admin\/api\/platform\/referral-campaigns\/([0-9a-f-]{36})\/revoke$/i);
  if (adminReferralCampaignRevoke && req.method === 'POST') {
    const operator = getPlatformAdminSession(req);
    if (!operator) return jsonResponse(res, { error: 'Unauthorized' }, 401);
    if (!prisma) return jsonResponse(res, { error: 'Database unavailable' }, 503);
    const result = await prisma.referralCampaign.updateMany({ where: { id: adminReferralCampaignRevoke[1], active: true }, data: { active: false } });
    if (!result?.count) return jsonResponse(res, { error: 'Not found' }, 404);
    await audit({ eventType: 'commercial.referral_campaign_revoked', eventCategory: 'billing', action: 'update', resourceType: 'referral_campaign', resourceId: adminReferralCampaignRevoke[1],
      metadata: { operator: operator.operator, session_id: operator.sessionId }, ..._reqMeta(req), sessionId: operator.sessionId, actorType: 'platform_admin' });
    return jsonResponse(res, { ok: true });
  }

  if (pathname === '/admin/api/platform/pilots' && req.method === 'GET') {
    const operator = getPlatformAdminSession(req);
    if (!operator) return jsonResponse(res, { error: 'Unauthorized' }, 401);
    if (!prisma) return jsonResponse(res, { error: 'Database unavailable' }, 503);
    const grants = await prisma.entitlementGrant.findMany({ orderBy: { startsAt: 'desc' }, take: 500 });
    const orgIds = [...new Set(grants.map((grant) => grant.orgId))];
    const grantIds = grants.map((grant) => grant.id);
    const [orgs, versions] = await Promise.all([
      orgIds.length ? prisma.organization.findMany({ where: { id: { in: orgIds } }, select: { id: true, name: true, plan: true, accountType: true, hostingMode: true, memoryStorageMode: true } }) : [],
      grantIds.length ? prisma.entitlementVersion.findMany({ where: { grantId: { in: grantIds } }, orderBy: { version: 'desc' } }) : [],
    ]);
    const byOrg = new Map(orgs.map((org) => [org.id, org]));
    return jsonResponse(res, { pilots: grants.map((grant) => {
      const version = versions.find((row) => row.grantId === grant.id);
      const expired = grant.endsAt && grant.endsAt <= new Date();
      return { grant_id: grant.id, organization: byOrg.get(grant.orgId) || null, status: expired && grant.fallbackAction === 'manual_review' ? 'manual_review' : grant.status,
        starts_at: grant.startsAt, ends_at: grant.endsAt, fallback_action: grant.fallbackAction,
        version: version ? { plan: version.planId, limits: version.limits, account_type: version.accountType, storage_mode: version.storageMode, number: version.version } : null };
    }) });
  }

  if (pathname === '/admin/api/platform/organizations' && req.method === 'GET') {
    const operator = getPlatformAdminSession(req);
    if (!operator) return jsonResponse(res, { error: 'Unauthorized' }, 401);
    if (!prisma) return jsonResponse(res, { error: 'Database unavailable' }, 503);
    const organizations = await prisma.organization.findMany({
      orderBy: { createdAt: 'desc' }, take: 500,
      select: { id: true, name: true, plan: true, accountType: true, hostingMode: true, memoryStorageMode: true, createdAt: true },
    });
    return jsonResponse(res, { organizations });
  }

  if (pathname === '/admin/api/platform/pilots/grant' && req.method === 'POST') {
    const operator = getPlatformAdminSession(req);
    if (!operator) return jsonResponse(res, { error: 'Unauthorized' }, 401);
    if (!prisma) return jsonResponse(res, { error: 'Database unavailable' }, 503);
    try {
      const body = await parseBody(req).catch(() => ({}));
      const result = await grantPromotionToOrganization({ prisma, promotionId: body.promotion_id, orgId: body.organization_id, requestId: req.headers['x-request-id'] || null });
      await audit({ organizationId: result.grant.orgId, eventType: 'commercial.pilot_granted', eventCategory: 'billing', action: 'create', resourceType: 'entitlement_grant', resourceId: result.grant.id,
        metadata: { operator: operator.operator, session_id: operator.sessionId, promotion_id: result.promotion.id }, ..._reqMeta(req), sessionId: operator.sessionId, actorType: 'platform_admin' });
      return jsonResponse(res, { grant: result.grant, version: result.entitlementVersion, redemption: result.redemption }, 201);
    } catch (error) {
      return jsonResponse(res, { error: error.message }, /unavailable|not found/i.test(error.message) ? 404 : 409);
    }
  }

  const adminPilotAmend = pathname.match(/^\/admin\/api\/platform\/pilots\/([0-9a-f-]{36})\/entitlement$/i);
  if (adminPilotAmend && req.method === 'POST') {
    const operator = getPlatformAdminSession(req);
    if (!operator) return jsonResponse(res, { error: 'Unauthorized' }, 401);
    try {
      const body = await parseBody(req).catch(() => ({}));
      const result = await amendEntitlementGrant({ prisma, grantId: adminPilotAmend[1], patch: body });
      await audit({ organizationId: result.grant.orgId, eventType: 'commercial.entitlement_amended', eventCategory: 'billing', action: 'update', resourceType: 'entitlement_grant', resourceId: result.grant.id,
        metadata: { operator: operator.operator, session_id: operator.sessionId, transition_reason: result.version.transitionReason }, ..._reqMeta(req), sessionId: operator.sessionId, actorType: 'platform_admin' });
      return jsonResponse(res, { grant: result.grant, version: result.version });
    } catch (error) {
      return jsonResponse(res, { error: error.message }, /not found/i.test(error.message) ? 404 : 400);
    }
  }

  if (pathname === '/admin/api/platform/redemptions' && req.method === 'GET') {
    const operator = getPlatformAdminSession(req);
    if (!operator) return jsonResponse(res, { error: 'Unauthorized' }, 401);
    if (!prisma) return jsonResponse(res, { error: 'Database unavailable' }, 503);
    const redemptions = await prisma.promotionRedemption.findMany({ orderBy: { redeemedAt: 'desc' }, take: 500 });
    const [promotionIds, orgIds, userIds] = [
      [...new Set(redemptions.map((row) => row.promotionId))], [...new Set(redemptions.map((row) => row.orgId))], [...new Set(redemptions.map((row) => row.redeemedByUserId))],
    ];
    const [promotions, organizations, users] = await Promise.all([
      promotionIds.length ? prisma.promotion.findMany({ where: { id: { in: promotionIds } }, select: { id: true, internalName: true, codeHint: true } }) : [],
      orgIds.length ? prisma.organization.findMany({ where: { id: { in: orgIds } }, select: { id: true, name: true } }) : [],
      userIds.length ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true } }) : [],
    ]);
    const byId = (rows) => new Map(rows.map((row) => [row.id, row]));
    const promotionById = byId(promotions); const orgById = byId(organizations); const userById = byId(users);
    return jsonResponse(res, { redemptions: redemptions.map((row) => ({ id: row.id, redeemed_at: row.redeemedAt, code_hint: row.codeHint,
      promotion: promotionById.get(row.promotionId) || null, organization: orgById.get(row.orgId) || null,
      redeemed_by: userById.get(row.redeemedByUserId)?.email || 'Unknown', grant_id: row.entitlementGrantId, terms: row.termsSnapshot })) });
  }

  if (pathname === '/admin/api/logs' && req.method === 'GET') {
    if (!isAdminAuthorized(req, url)) {
      return jsonResponse(res, { error: 'Unauthorized' }, 401);
    }
    return jsonResponse(res, buildAdminServiceSnapshot());
  }

  if (pathname === '/health') {
    const runtimeSchedulerExpected = Boolean(prisma && shouldRunRecurringMaintenanceJobs());
    const runtimeSchedulerReady = !runtimeSchedulerExpected || Boolean(hqScheduler?.runtimePlaybooks);
    return jsonResponse(res, {
      ok: runtimeSchedulerReady,
      service: 'hivemind-control-plane',
      core_api_base_url: CONFIG.coreApiBaseUrl,
      hq_runtime: {
        scheduler_expected: runtimeSchedulerExpected,
        scheduler_ready: Boolean(hqScheduler),
        playbooks_ready: Boolean(hqScheduler?.runtimePlaybooks),
        transport: runtimeTransportStats(),
      },
    }, runtimeSchedulerReady ? 200 : 503);
  }

  // ─── Self-host (BYOD) enrollment ─────────────────────────────
  if ((pathname === '/v1/selfhost/bootstrap' || pathname === '/v1/selfhost/canary-bootstrap') && req.method === 'POST') {
    const releaseChannel = pathname === '/v1/selfhost/canary-bootstrap' ? 'canary' : 'stable';
    const current = await requireSession(req, res);
    if (!current) return;
    const orgId = current.session.orgId;
    if (!orgId) return jsonResponse(res, { error: 'No active organization' }, 409);
    const membership = await requireOrgAdmin(req, res, current.session.userId, orgId);
    if (!membership) return;
    const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { hostingMode: true } }).catch(() => null);
    if (org?.hostingMode !== 'self_host') return jsonResponse(res, { error: 'Memory Box enrollment is available only for self-hosted organizations' }, 409);
    const canaryAllowlist = new Set(String(process.env.MEMORY_BOX_CANARY_ORG_ALLOWLIST || '').split(',').map((value) => value.trim()).filter(Boolean));
    const canaryEligible = process.env.MEMORY_BOX_CANARY_ENROLLMENT_ENABLED === 'true' && canaryAllowlist.has(orgId);
    if (releaseChannel === 'canary' && !canaryEligible) {
      return jsonResponse(res, { error: 'Memory Box canary enrollment is not enabled for this organization' }, 403);
    }
    try {
      const readiness = await memoryBoxBrokerRequest('/v1/selfhost/readiness', { orgId, channel: releaseChannel });
      if (readiness.status !== 200 || readiness.payload?.ready !== true) {
        return jsonResponse(res, { error: 'Automatic Memory Box setup is not currently available',
          code: 'memory_box_automatic_setup_unavailable', readiness: readiness.payload || null,
          ...(releaseChannel === 'stable' && canaryEligible ? { canary_eligible: true } : {}) }, 503);
      }
    } catch (error) {
      return jsonResponse(res, { error: 'Automatic Memory Box setup is not currently available',
        code: 'memory_box_automatic_setup_unavailable',
        ...(releaseChannel === 'stable' && canaryEligible ? { canary_eligible: true } : {}) }, 503);
    }
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
    const issued = await createPersistedApiKey(prisma, {
      userId: current.session.userId, orgId, keyKind: 'service', createdByUserId: current.session.userId,
      name: `Memory Box ${releaseChannel} enrollment`, description: `Single-use organization-bound Memory Box ${releaseChannel} enrollment credential`,
      scopes: ['selfhost:bootstrap'], expiresAt, rateLimitPerMinute: 12,
      createdByIp: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || null,
      userAgent: String(req.headers['user-agent'] || '').slice(0, 512) || null,
    });
    return jsonResponse(res, { enrollment_token: issued.rawKey, expires_at: expiresAt.toISOString(), org_id: orgId, channel: releaseChannel }, 201);
  }

  // Stable facade; the dedicated broker is the sole lifecycle writer.
  if ((pathname === '/v1/selfhost/enroll' || pathname === '/v1/selfhost/register' || pathname === '/v1/selfhost/report') && req.method === 'POST') {
    const body = await parseBody(req).catch(() => null);
    if (!body) return jsonResponse(res, { error: 'Invalid JSON body' }, 400);
    try {
      const result = await memoryBoxBrokerRequest(pathname, body);
      return jsonResponse(res, result.payload, result.status);
    } catch (error) {
      return jsonResponse(res, { error: 'Memory Box broker unavailable', detail: error.message }, 503);
    }
  }

  // Rotate a self-hosted agent bearer token without an immediate outage. Core
  // tries the new token first and accepts the old token only during this short
  // grace period, giving the customer time to update and restart their Box.
  if (pathname === '/v1/selfhost/rotate-agent-token' && req.method === 'POST') {
    const current = await requireSession(req, res); if (!current) return;
    const orgId = current.session.orgId;
    if (!orgId) return jsonResponse(res, { error: 'No active organization' }, 409);
    const membership = await requireOrgAdmin(req, res, current.session.userId, orgId); if (!membership) return;
    try {
      const result = await memoryBoxBrokerRequest(pathname, { orgId });
      return jsonResponse(res, result.payload, result.status);
    } catch (error) {
      return jsonResponse(res, { error: 'Memory Box broker unavailable', detail: error.message }, 503);
    }
  }
  if (pathname === '/v1/selfhost/disenroll' && req.method === 'POST') {
    const current = await requireSession(req, res); if (!current) return;
    const orgId = current.session.orgId;
    if (!orgId) return jsonResponse(res, { error: 'No active organization' }, 409);
    const membership = await requireOrgAdmin(req, res, current.session.userId, orgId); if (!membership) return;
    try {
      const result = await memoryBoxBrokerRequest('/v1/byod/disenroll', { orgId });
      return jsonResponse(res, result.payload, result.status);
    } catch (error) {
      return jsonResponse(res, { error: 'Memory Box broker unavailable', detail: error.message }, 503);
    }
  }
  // Self-host connection status — the FE polls this during onboarding to show "waiting → connected".
  // POST { apiKey } (key in body, never the URL). Resolves org → reads the shared registry → reports
  // whether an agent is registered and (best-effort) reachable.
  if (pathname === '/v1/selfhost/status' && req.method === 'POST') {
    const body = await parseBody(req).catch(() => null);
    const apiKey = (body?.apiKey || '').toString();
    const boxToken = (body?.boxToken || '').toString();
    // Resolve org by API key (onboarding poll) OR by session (Settings, no raw key on hand).
    let statusOrgId = null;
    if (boxToken) {
      const credentialHash = crypto.createHash('sha256').update(boxToken).digest('hex');
      const rec = await prisma.memoryBoxConnection.findFirst({ where: { credentialHash, revokedAt: null }, select: { orgId: true } }).catch(() => null);
      if (!rec?.orgId) return jsonResponse(res, { error: 'invalid Memory Box credential' }, 401);
      statusOrgId = rec.orgId;
    } else if (apiKey) {
      const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
      const rec = await prisma.apiKey.findFirst({ where: { keyHash, revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }, select: { orgId: true } }).catch(() => null);
      if (!rec?.orgId) return jsonResponse(res, { error: 'invalid api key' }, 401);
      statusOrgId = rec.orgId;
    } else {
      const current = await requireSession(req, res);
      if (!current) return; // requireSession already responded
      // Prefer the session's ACTIVE org — findFirst(owner) returns an
      // arbitrary org for multi-org owners and reports the wrong agent.
      statusOrgId = current.session.orgId || null;
      if (!statusOrgId) {
        const m = await prisma.userOrganization.findFirst({
          where: { userId: current.session.userId, role: 'owner' },
          select: { orgId: true },
        }).catch(() => null);
        statusOrgId = m?.orgId || null;
      }
      if (!statusOrgId) return jsonResponse(res, { registered: false, reachable: false });
    }
    try {
      const result = await memoryBoxBrokerRequest('/v1/selfhost/status', boxToken ? { boxToken } : { orgId: statusOrgId });
      if (result.status >= 500) throw new Error(result.payload?.error || 'Memory Box broker unavailable');
      return jsonResponse(res, result.payload, result.status);
    } catch (error) {
      const last = await prisma.memoryBoxConnection.findUnique({ where: { orgId: statusOrgId }, select: {
        orgId: true, boxId: true, transport: true, endpoint: true, state: true, desiredRelease: true,
        observedRelease: true, protocolVersion: true, schemaVersion: true, capabilities: true,
        lastHeartbeatAt: true, lastReachableAt: true, consecutiveFailures: true, registeredAt: true, revokedAt: true,
      } }).catch(() => null);
      if (last && !last.revokedAt) return jsonResponse(res, { registered: true, reachable: null, stale: true,
        orgId: last.orgId, boxId: last.boxId, transport: last.transport, endpoint: last.endpoint, state: last.state,
        desiredRelease: last.desiredRelease, observedRelease: last.observedRelease, protocolVersion: last.protocolVersion,
        schemaVersion: last.schemaVersion, capabilities: last.capabilities, lastHeartbeatAt: last.lastHeartbeatAt,
        lastReachableAt: last.lastReachableAt, consecutiveFailures: last.consecutiveFailures, registeredAt: last.registeredAt,
        warning: 'Memory Box broker unavailable; showing last known state' }, 200);
      return jsonResponse(res, { registered: false, reachable: null, stale: true, state: 'UNAVAILABLE', error: 'Memory Box broker unavailable' }, 503);
    }
  }

  // ─── Unified email-first authentication ───────────────────────
  if (pathname.startsWith('/internal/auth-email/outbox/') && pathname.endsWith('/deliver') && req.method === 'POST') {
    if (!process.env.AUTH_EMAIL_QUEUE_SECRET || !secretsMatch(req.headers['x-auth-email-secret'], process.env.AUTH_EMAIL_QUEUE_SECRET)) return jsonResponse(res, { error: 'Unauthorized' }, 401);
    const outboxId = pathname.split('/')[4];
    await dispatchAuthEmailOutbox(outboxId);
    return jsonResponse(res, { ok: true });
  }
  if (pathname === '/auth/email/config' && req.method === 'GET') {
    const mode = await effectiveEmailIdentityMode();
    return jsonResponse(res, {
      mode,
      enabled: mode === 'primary' || mode === 'email_only',
      email_only: mode === 'email_only',
      turnstile_site_key: process.env.TURNSTILE_EMAIL_AUTH_SITE_KEY || null,
      default_redirect_to: emailPostLoginRedirect,
    });
  }

  if (pathname === '/auth/email/start' && req.method === 'POST') {
    const mode = await effectiveEmailIdentityMode();
    if (mode !== 'primary' && mode !== 'email_only') return jsonResponse(res, { error: 'Not found' }, 404);
    const startedAt = Date.now();
    try {
      const body = await parseBody(req);
      const turnstileOk = await verifyEmailTurnstile(body?.turnstile_token, req);
      const returnTo = safeReturnTo(body?.return_to, emailPostLoginRedirect, emailAllowedOrigins);
      const intent = body?.intent === 'register' ? 'register' : 'login';
      const email = normalizeEmail(body?.email);
      const signupTicket = intent === 'register' ? String(body?.signup_ticket || '').trim() : null;
      const admission = intent === 'register' ? emailSignupAdmission(signupTicket) : null;
      const existingUser = email ? await prisma.user.findUnique({ where: { email }, select: { id: true, deletedAt: true } }) : null;
      let started = { accepted: false };
      // Never send a code that can create an account without the same signed
      // admission Google uses. Generic responses preserve account privacy.
      const admitted = intent === 'login'
        ? Boolean(existingUser && !existingUser.deletedAt)
        : Boolean(admission);
      if (turnstileOk && admitted && emailDeliveryConfigured()) started = await emailIdentity.start({
        email, intent, returnTo, mode, signupTicket: admission ? signupTicket : null,
        requestFingerprint: emailRequestFingerprint(req),
        environment: process.env.HIVEMIND_LOCAL_MODE === 'true' ? 'local' : 'production',
      });
      if (started.outboxId) setImmediate(() => enqueueAuthEmailOutbox(started.outboxId).catch((error) => console.error('[email-auth] delivery dispatch failed', { outboxId: started.outboxId, error: error.message })));
      const elapsed = Date.now() - startedAt;
      if (elapsed < 180) await new Promise((resolve) => setTimeout(resolve, 180 - elapsed));
      return jsonResponse(res, { ...EMAIL_AUTH_PUBLIC_RESPONSE, challenge_id: started.challengeId || crypto.randomUUID() }, 202);
    } catch (error) {
      console.error('[email-auth] start failed', { error: error.message });
      return jsonResponse(res, { ...EMAIL_AUTH_PUBLIC_RESPONSE, challenge_id: crypto.randomUUID() }, 202);
    }
  }

  if (pathname === '/auth/email/resend' && req.method === 'POST') {
    const mode = await effectiveEmailIdentityMode();
    if (mode !== 'primary' && mode !== 'email_only') return jsonResponse(res, { error: 'Not found' }, 404);
    const body = await parseBody(req).catch(() => ({}));
    const turnstileOk = await verifyEmailTurnstile(body?.turnstile_token, req).catch(() => false);
    const result = turnstileOk && isCanonicalUuid(String(body?.challenge_id || ''))
      ? await emailIdentity.resend(String(body.challenge_id)).catch(() => ({ ok: false })) : { ok: false };
    if (result.outboxId) setImmediate(() => enqueueAuthEmailOutbox(result.outboxId).catch(() => {}));
    return jsonResponse(res, { ok: true, resend_after_seconds: 30, message: 'If the challenge is active, a new code is on its way.' }, 202);
  }

  if (pathname === '/auth/email/verify' && req.method === 'POST') {
    const mode = await effectiveEmailIdentityMode();
    if (mode !== 'primary' && mode !== 'email_only') return jsonResponse(res, { error: 'Not found' }, 404);
    try {
      const body = await parseBody(req);
      if (!isCanonicalUuid(String(body?.challenge_id || ''))) throw new Error('invalid');
      const verified = await emailIdentity.verify({ challengeId: String(body.challenge_id), code: body?.code, linkToken: body?.link_token });
      if (!verified.ok) return jsonResponse(res, { ok: false, error: 'The code or link is invalid or has expired.' }, 401);
      let user = await prisma.user.findUnique({ where: { email: verified.email } });
      if (user?.deletedAt) return jsonResponse(res, { ok: false, error: 'This account is unavailable.' }, 403);
      if (!user) {
        const admission = verified.challenge.intent === 'register'
          ? emailSignupAdmission(emailIdentity.signupTicket(verified.challenge))
          : null;
        if (!admission) return jsonResponse(res, { ok: false, error: 'This code cannot create an account. Start again from your invitation.' }, 403);
        const provisioned = await createZitadelEmailIdentity(verified.email);
        user = await upsertUserFromZitadel({ sub: provisioned.userId, email: verified.email, email_verified: true, name: provisioned.displayName, locale: 'en' });
      } else {
        await prisma.userIdentity.upsert({
          where: { provider_providerSubject: { provider: 'email', providerSubject: verified.email } },
          update: { userId: user.id, normalizedEmail: verified.email, verifiedAt: new Date() },
          create: { userId: user.id, provider: 'email', providerSubject: verified.email, normalizedEmail: verified.email, verifiedAt: new Date(), isPrimary: false },
        });
        user = await prisma.user.update({ where: { id: user.id }, data: { lastActiveAt: new Date() } });
      }
      const membership = await resolveCurrentOrg(user.id);
      if (!await emailIdentity.consume(String(body.challenge_id), user.id)) return jsonResponse(res, { ok: false, error: 'The code or link has already been used.' }, 401);
      const sessionId = await sessionStore.createSession({ userId: user.id, email: user.email, orgId: membership.org?.id || null });
      // A newly authenticated person without an organization has reached the
      // next activation stage. Generation invalidates any queued invite mail.
      if (!membership.org) {
        const activations = await advanceActivationForEmail({
          prisma, email: user.email, userId: user.id,
          stage: ACTIVATION_STAGES.SIGNED_IN_PENDING_COMPANY,
          reason: 'authenticated_without_company',
        });
        for (const activation of activations) {
          scheduleActivationWorkflow({ activation }).catch((error) => console.warn('[activation-lifecycle] signup scheduling failed:', error.message));
        }
      }
      const redirectTo = safeReturnTo(verified.challenge.returnTo, emailPostLoginRedirect, emailAllowedOrigins);
      return jsonResponse(res, { ok: true, redirect_to: redirectTo, needs_onboarding: !membership.org }, 200, { 'Set-Cookie': makeSessionCookie(sessionId) });
    } catch (error) {
      console.error('[email-auth] verification failed', { error: error.message });
      return jsonResponse(res, { ok: false, error: 'The code or link is invalid or has expired.' }, 401);
    }
  }

  // Deprecated preview-only bypass retained behind its old kill switch for
  // rollback. New preview and production clients use /auth/email/* above.
  // ─── Local preview email sign-in ──────────────────────────────
  if (pathname === '/auth/local-preview/request' && req.method === 'POST') {
    if (process.env.HIVEMIND_LOCAL_MODE !== 'true' || process.env.HIVEMIND_LOCAL_AUTH_BYPASS !== 'true') {
      return jsonResponse(res, { error: 'Not found' }, 404);
    }
    try {
      const body = await parseBody(req);
      const email = String(body?.email || '').trim().toLowerCase();
      const allowlist = new Set(String(process.env.HIVEMIND_LOCAL_PREVIEW_EMAIL_ALLOWLIST || '').split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean));
      if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) || !allowlist.has(email)) {
        return jsonResponse(res, { ok: true, message: 'If this address is approved for preview, a sign-in link is on its way.' }, 202);
      }
      let returnTo = CONFIG.postLoginRedirect;
      try {
        const candidate = new URL(String(body?.return_to || ''));
        const approved = new URL(CONFIG.postLoginRedirect);
        if (candidate.origin === approved.origin && candidate.pathname.startsWith('/hivemind/')) returnTo = candidate.toString();
      } catch {}
      const state = await sessionStore.createAuthState({ kind: 'local_preview_email', email, returnTo });
      const baseUrl = (process.env.HIVEMIND_CONTROL_PLANE_PUBLIC_URL || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`).replace(/\/$/, '');
      const loginUrl = `${baseUrl}/auth/local-preview/verify?state=${encodeURIComponent(state)}`;
      const delivery = await sendRenderedSystemEmail({ templateId: 'local_preview_sign_in', to: email, rendered: {
        subject: 'Your Singulance local preview sign-in link',
        text: `Open this one-time sign-in link to continue to local preview:\n\n${loginUrl}\n\nThis link expires shortly.`,
        html: `<p>Open this one-time link to continue to local preview.</p><p><a href="${loginUrl}">Sign in to local preview</a></p><p>This link expires shortly.</p>`,
      } });
      if (!delivery.ok) return jsonResponse(res, { error: 'Preview email delivery is unavailable.' }, 503);
      return jsonResponse(res, { ok: true, message: 'Check your email for a one-time sign-in link.' }, 202);
    } catch {
      return jsonResponse(res, { error: 'Unable to start preview sign-in' }, 500);
    }
  }

  if (pathname === '/auth/local-preview/verify' && req.method === 'GET') {
    if (process.env.HIVEMIND_LOCAL_MODE !== 'true' || process.env.HIVEMIND_LOCAL_AUTH_BYPASS !== 'true') return jsonResponse(res, { error: 'Not found' }, 404);
    try {
      const authState = await sessionStore.consumeAuthState(url.searchParams.get('state') || '');
      if (!authState || authState.kind !== 'local_preview_email' || !authState.email) return jsonResponse(res, { error: 'This preview sign-in link is invalid or has expired.' }, 400);
      const user = await upsertUserFromZitadel({
        sub: `local-preview:${authState.email}`,
        email: authState.email,
        name: authState.email.split('@')[0] || 'Local Preview',
        locale: 'en',
      });
      // Always pin preview sessions to a dedicated local organization. Reusing
      // the user's first historical membership could select a stale/inactive
      // organization and made the HyperAgent onboarding permission checks fail.
      const org = await prisma.organization.upsert({
        where: { zitadelOrgId: 'local-preview-org' },
        update: { name: 'Local Preview', slug: 'local-preview', plan: 'scale', hostingMode: 'managed' },
        create: {
          zitadelOrgId: 'local-preview-org',
          name: 'Local Preview',
          slug: 'local-preview',
          plan: 'scale',
          hostingMode: 'managed',
        },
      });
      await prisma.userOrganization.upsert({
        where: { userId_orgId: { userId: user.id, orgId: org.id } },
        update: { isActive: true, role: 'owner', roles: ['org_owner'], joinedAt: new Date() },
        create: { userId: user.id, orgId: org.id, role: 'owner', roles: ['org_owner'], isActive: true, joinedAt: new Date() },
      });
      const sessionId = await sessionStore.createSession({ userId: user.id, email: user.email, orgId: org.id });
      return redirect(res, authState.returnTo || CONFIG.postLoginRedirect, [makeSessionCookie(sessionId)]);
    } catch (error) {
      return jsonResponse(res, { error: error.message }, 500);
    }
  }

  // ─── Direct Google OAuth (bypasses Zitadel) ──────────────────
  if (pathname === '/auth/google' && req.method === 'GET') {
    const returnTo = url.searchParams.get('return_to') || CONFIG.postLoginRedirect;
    console.log(`[google-auth] Login initiated, returnTo: ${returnTo}`);
    const googleClientId = process.env.GOOGLE_CLIENT_ID;
    if (!googleClientId) {
      return jsonResponse(res, { error: 'Google OAuth not configured' }, 503);
    }
    const returnToValue = url.searchParams.get('return_to') || CONFIG.postLoginRedirect;
    const admission = signupAdmissionFromRequest(url);
    const workspaceInvite = await workspaceInviteAdmissionFromRequest(url);
    if (url.searchParams.get('signup_ticket') && !admission) return jsonResponse(res, { error: 'Invitation is unavailable' }, 403);
    if (url.searchParams.get('workspace_invite') && !workspaceInvite) return jsonResponse(res, { error: 'Workspace invitation is unavailable' }, 403);
    const state = await sessionStore.createAuthState({
      returnTo: returnToValue,
      provider: 'google',
      signupAdmission: admission,
      workspaceInviteToken: workspaceInvite?.token || null,
    });
    // Encode return_to in the state itself as a fallback (base64 suffix after UUID)
    // Format: <stateId>.<base64_return_to> — Google passes this back unchanged
    const encodedReturnTo = Buffer.from(returnToValue).toString('base64url');
    const compositeState = `${state}.${encodedReturnTo}`;
    // Pin the redirect URI from env so it matches the value registered in
    // Google Cloud Console. Falls back to derived cpBase only when the
    // env override is absent. Dynamic Host-header derivation breaks when
    // multiple hostnames front the same service (api.* vs core.*).
    const cpBase = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
    const googleRedirectUri = process.env.HIVEMIND_GOOGLE_REDIRECT_URI
      || `${cpBase}/auth/google/callback`;
    const googleParams = new URLSearchParams({
      client_id: googleClientId,
      redirect_uri: googleRedirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      access_type: 'offline',
      prompt: 'consent',
      state: compositeState,
    });
    return redirect(res, `https://accounts.google.com/o/oauth2/v2/auth?${googleParams}`);
  }

  if (pathname === '/auth/google/callback' && req.method === 'GET') {
    console.log('[google-auth] Callback received from Google');
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');

    console.log(`[google-auth] Callback params - code: ${code ? 'present' : 'missing'}, state: ${state ? 'present' : 'missing'}, error: ${error || 'none'}`);

    if (error) {
      console.log(`[google-auth] OAuth error: ${error}`);
      return redirect(res, `${CONFIG.postLoginRedirect}?auth_error=${encodeURIComponent(error)}`);
    }
    if (!code || !state) {
      console.log(`[google-auth] Missing code or state parameter`);
      return jsonResponse(res, { error: 'Missing code or state' }, 400);
    }

    // State format: <stateId>.<base64_return_to> or just <stateId>
    const stateParts = state.split('.');
    const stateId = stateParts[0];
    const encodedFallbackReturnTo = stateParts[1] || null;

    let authState = await sessionStore.consumeAuthState(stateId);
    console.log(`[google-auth] Auth state consumed - returnTo: ${authState?.returnTo}, provider: ${authState?.provider}`);
    if (!authState) {
      // Fallback: decode return_to from the state parameter itself
      let fallbackReturnTo = CONFIG.postLoginRedirect;
      if (encodedFallbackReturnTo) {
        try {
          fallbackReturnTo = Buffer.from(encodedFallbackReturnTo, 'base64url').toString('utf8');
          console.log(`[google-auth] Recovered returnTo from state param: ${fallbackReturnTo}`);
        } catch {}
      }
      console.warn(`[google-auth] Auth state lost, using fallback returnTo: ${fallbackReturnTo}`);
      authState = { returnTo: fallbackReturnTo, provider: 'google' };
    }

    try {
      // Exchange code for tokens — redirect_uri MUST exactly match the one
      // sent in the initial /auth/google authorize step (Google strict check).
      const cpBase = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
      const googleRedirectUri = process.env.HIVEMIND_GOOGLE_REDIRECT_URI
        || `${cpBase}/auth/google/callback`;
      const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: process.env.GOOGLE_CLIENT_ID,
          client_secret: process.env.GOOGLE_CLIENT_SECRET,
          redirect_uri: googleRedirectUri,
          grant_type: 'authorization_code',
        }),
      });

      if (!tokenResp.ok) {
        const errText = await tokenResp.text();
        console.log(`[google-auth] Token exchange failed: ${tokenResp.status} - ${errText}`);
        throw new Error(`Google token exchange failed: ${errText}`);
      }

      const tokens = await tokenResp.json();
      console.log(`[google-auth] Token exchange successful - access_token: ${tokens.access_token ? 'present' : 'missing'}`);

      // Get user info
      console.log(`[google-auth] Fetching user info from Google...`);
      const userInfoResp = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      const userInfo = await userInfoResp.json();
      console.log(`[google-auth] User info retrieved - email: ${userInfo.email}, id: ${userInfo.id}`);

      // Upsert user — use Google sub as zitadel user id (with prefix to avoid collision)
      console.log(`[google-auth] Upserting user...`);
      const googleSub = `google:${userInfo.id}`;
      const existingPlatformUser = await platformUserExists({ sub: googleSub, email: userInfo.email });
      const workspaceInviteAccepted = authState.workspaceInviteToken
        ? await workspaceInviteMatchesAuthenticatedEmail(authState.workspaceInviteToken, userInfo.email)
        : false;
      if (!existingPlatformUser && !authState.signupAdmission && !workspaceInviteAccepted) {
        return redirect(res, `${defaultFrontendBaseUrl}/hivemind/login?create=1&onboarding_error=invitation_required`);
      }
      const user = await upsertUserFromZitadel({
        sub: googleSub,
        zitadelUserId: userInfo.sub,
        email: userInfo.email,
        name: userInfo.name,
        picture: userInfo.picture,
        locale: userInfo.locale,
      });
      console.log(`[google-auth] User upserted - id: ${user.id}, email: ${user.email}`);

      const { org } = await resolveCurrentOrg(user.id);
      console.log(`[google-auth] Organization resolved - orgId: ${org?.id || 'none'}`);

      const sessionId = await sessionStore.createSession({
        userId: user.id,
        email: user.email,
        orgId: org?.id || null,
      });
      if (!org) {
        const activations = await advanceActivationForEmail({
          prisma, email: user.email, userId: user.id,
          stage: ACTIVATION_STAGES.SIGNED_IN_PENDING_COMPANY, reason: 'authenticated_without_company',
        });
        for (const activation of activations) scheduleActivationWorkflow({ activation }).catch((error) => console.warn('[activation-lifecycle] google signup scheduling failed:', error.message));
      }
      console.log('[google-auth] Session created');

      let finalRedirect = authState.returnTo || CONFIG.postLoginRedirect;
      console.log(`[google-auth] Preparing redirect - initial finalRedirect: ${finalRedirect}`);

      // Cross-origin handshake support for external tools (MiroFish, VS Code, etc.)
      const isExternalTool = finalRedirect.includes('localhost') || finalRedirect.includes('?hivemind_auth=callback');
      console.log(`[google-auth] External tool check - includes localhost: ${finalRedirect.includes('localhost')}, includes hivemind_auth: ${finalRedirect.includes('?hivemind_auth=callback')}, isExternalTool: ${isExternalTool}`);

      if (isExternalTool) {
        console.log(`[google-auth] External tool callback detected, appending token`);
        const separator = finalRedirect.includes('?') ? '&' : '?';
        finalRedirect += `${separator}token=${sessionId}`;
        console.log(`[google-auth] Token appended - separator: '${separator}', new finalRedirect: ${finalRedirect}`);
      } else {
        console.log(`[google-auth] Not an external tool callback, no token appended`);
      }

      console.log(`[google-auth] Final redirect prepared: ${finalRedirect}`);
      return redirect(res, finalRedirect, [makeSessionCookie(sessionId)]);
    } catch (err) {
      console.error('[google-auth] Callback failed:', err.message);
      return redirect(res, `${CONFIG.postLoginRedirect}?auth_error=${encodeURIComponent(err.message)}`);
    }
  }

  // ─── CLI browser-auth handshake ─────────────────────────────
  // GET /auth/cli/start?callback=<localhost-url>&state=<rand>
  //
  // Used by @hivemind/cli to swap user-paste-key for a one-click
  // browser login (same UX as `gh auth login --web` / `vercel login`):
  //
  //   1. CLI starts http://127.0.0.1:<rand-port>/callback listener
  //   2. CLI opens browser to /auth/cli/start?callback=...&state=...
  //   3. If user not logged in: bounce through /auth/login?return_to=...
  //   4. After auth, mint (or reuse) the auto-session API key and
  //      302 to the callback with ?state=<echo>&token=<key>&user_email=...
  //   5. CLI extracts token, kills server, writes config
  //
  // Security:
  //   - Callback MUST be a 127.0.0.1 / localhost URL. Anything else is
  //     rejected so the token can never leak to an external host.
  //   - State echoed back so the CLI listener can CSRF-check the
  //     incoming request.
  //   - Same revocable API key the FE uses — revoked from the same
  //     keys UI if the user wants.
  if (pathname === '/auth/cli/start' && req.method === 'GET') {
    const callback = url.searchParams.get('callback') || '';
    const state = url.searchParams.get('state') || '';
    if (!callback || !state) {
      return jsonResponse(res, { error: 'callback and state required' }, 400);
    }
    // Loopback-only or Chrome extension chromiumapp.org redirect.
    // Both are safe targets the OS/browser routes back to the originating
    // process — token cannot leak to a remote host.
    let parsedCb;
    try { parsedCb = new URL(callback); } catch { return jsonResponse(res, { error: 'invalid callback URL' }, 400); }
    const cbHost = parsedCb.hostname;
    const isLoopback = cbHost === '127.0.0.1' || cbHost === 'localhost' || cbHost === '::1';
    const isChromeExt = cbHost.endsWith('.chromiumapp.org') && parsedCb.protocol === 'https:';
    if (!isLoopback && !isChromeExt) {
      return jsonResponse(res, { error: 'callback must be 127.0.0.1/localhost or *.chromiumapp.org — refusing to redirect token to remote host' }, 400);
    }

    const current = await getCurrentSession(req);
    if (!current) {
      // Not logged in — send user to HIVEMIND-branded LoginPage instead of
      // straight to Zitadel. Login.jsx handles 'cli_return_to' URL param and
      // uses it as the OAuth returnTo, bringing the browser back here with
      // a session cookie set.
      //
      // Build the self URL from the incoming request rather than
      // CONFIG.corePublicBaseUrl — that points at the core MCP host
      // (core.hivemind.davinciai.eu:8050), not the control plane
      // (api.hivemind.davinciai.eu:8040). Using the request headers means
      // we always come back to whichever host actually answered the call.
      const proto = (req.headers['x-forwarded-proto'] || 'https').toString().split(',')[0].trim();
      const host = (req.headers['x-forwarded-host'] || req.headers.host || '').toString();
      const selfFull = `${proto}://${host}${req.url}`;
      const feLoginUrl = `${defaultFrontendBaseUrl}/hivemind/login?cli_return_to=${encodeURIComponent(selfFull)}`;
      return redirect(res, feLoginUrl);
    }

    const userId = current.session.userId;
    const { org } = await resolveCurrentOrg(userId);
    if (!org) {
      // Edge case: legit user with no org yet — finish onboarding first,
      // then come back. We pass the same URL via return_to.
      const selfPath = req.url;
      return redirect(res, `${CONFIG.postLoginRedirect || '/'}?cli_pending=1&return_to=${encodeURIComponent(selfPath)}`);
    }

    const apiKey = await getOrCreateSessionKey(userId, org.id);
    if (!apiKey) {
      return jsonResponse(res, { error: 'failed to mint API key' }, 500);
    }

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } }).catch(() => null);

    // Instead of 302-ing straight to the localhost callback (token-in-URL),
    // park the token under a short-lived one-shot exchange code and bounce
    // the user to a HIVEMIND-branded confirmation page. The page shows
    // "Verified as <email>" and a Continue button that POSTs to
    // /auth/cli/exchange to redeem the code — only then does the localhost
    // callback fire. Token never appears in any URL the user sees, and the
    // exchange code is single-use + 60s TTL.
    // Chrome extension flow — skip the cli-verified frontend page entirely.
    // chrome.identity.launchWebAuthFlow catches the chromiumapp.org redirect
    // BEFORE the page renders, so we can 302 directly to the callback with
    // the token. User sees the auth tab flash for a split second, then it
    // closes and the side panel renders the "Verified as X" card inline.
    if (isChromeExt) {
      const cbUrl = new URL(callback);
      cbUrl.searchParams.set('state', state);
      cbUrl.searchParams.set('token', apiKey);
      cbUrl.searchParams.set('user_email', user?.email || '');
      cbUrl.searchParams.set('user_id', userId);
      cbUrl.searchParams.set('org_id', org.id);
      return redirect(res, cbUrl.toString());
    }

    // CLI / loopback flow — keep the branded confirmation page so the
    // token never appears in any URL the user sees in their normal browser.
    const exchangeCode = await sessionStore.createAuthState({
      kind: 'cli_exchange',
      token: apiKey,
      callback,
      state,
      userId,
      userEmail: user?.email || null,
      orgId: org.id,
      expiresAt: Date.now() + 60_000,
    });

    const feVerifiedUrl = `${defaultFrontendBaseUrl}/hivemind/cli-verified?code=${encodeURIComponent(exchangeCode)}&email=${encodeURIComponent(user?.email || '')}`;
    return redirect(res, feVerifiedUrl);
  }

  // ─── CLI exchange: redeem one-shot code for the actual token ─────────
  // POST /auth/cli/exchange { code }
  //
  // Returns { callback, state, token, user_email, user_id, org_id } so the
  // FE confirmation page can window.location to the localhost callback with
  // the real token, without ever having it in the FE's URL bar.
  // Single-use — once consumed the code is invalidated.
  if (pathname === '/auth/cli/exchange' && req.method === 'POST') {
    const reqBody = await parseBody(req).catch(() => null);
    const code = (reqBody?.code || '').toString();
    if (!code) {
      return jsonResponse(res, { error: 'code required' }, 400);
    }
    const stored = await sessionStore.consumeAuthState(code);
    if (!stored || stored.kind !== 'cli_exchange') {
      return jsonResponse(res, { error: 'invalid or expired code' }, 400);
    }
    if (stored.expiresAt && Date.now() > stored.expiresAt) {
      return jsonResponse(res, { error: 'code expired' }, 400);
    }
    return jsonResponse(res, {
      callback: stored.callback,
      state: stored.state,
      token: stored.token,
      user_email: stored.userEmail,
      user_id: stored.userId,
      org_id: stored.orgId,
    });
  }

  // ─── Zitadel SSO Login ──────────────────────────────────────
  // idp_hint=microsoft|apple|google routes through the matching ZITADEL
  // federated IdP (env ZITADEL_IDP_MICROSOFT_ID / _APPLE_ID / _GOOGLE_ID).
  // Without the env id the hint still passes through as idp_hint, so ZITADEL
  // shows its own chooser rather than erroring — buttons stay safe to ship
  // before the IdPs are registered in the ZITADEL console.
  const applyIdpHint = (opts, hint) => {
    const h = (hint || '').trim().toLowerCase();
    if (!h) return;
    const envId = process.env[`ZITADEL_IDP_${h.toUpperCase()}_ID`];
    if (envId) opts.idpId = envId;
    else opts.idpHint = h;
  };
  if (pathname === '/auth/enterprise-invitations/preview' && req.method === 'GET') {
    if (signupAdmissionLimited(req)) return jsonResponse(res, { error: 'Invitation is unavailable', code: 'invitation_unavailable' }, 429);
    const preview = await getEnterpriseInvitationPreview({ prisma, token: url.searchParams.get('token') }).catch(() => null);
    recordSignupAdmissionAttempt(req, Boolean(preview));
    if (!preview) return jsonResponse(res, { error: 'Invitation is unavailable', code: 'invitation_unavailable' }, 404);
    return jsonResponse(res, { invitation: preview });
  }

  if (pathname === '/auth/personal-invitations/preview' && req.method === 'GET') {
    if (signupAdmissionLimited(req)) return jsonResponse(res, { error: 'Invitation is unavailable', code: 'invitation_unavailable' }, 429);
    const admission = verifyPersonalInvitationLink({
      token: url.searchParams.get('token'),
      configuredCode: PERSONAL_SIGNUP_INVITATION_CODE,
      secret: SIGNUP_ADMISSION_SECRET,
    });
    recordSignupAdmissionAttempt(req, Boolean(admission));
    if (!admission) return jsonResponse(res, { error: 'Invitation is unavailable', code: 'invitation_unavailable' }, 404);
    return jsonResponse(res, { invitation: { account_type: 'personal', invitation_expires_at: new Date(admission.expiresAt * 1000).toISOString() } });
  }

  // ─── Runtime beta waitlist — public, unauthenticated ───────────────
  // Fire-and-forget confirmation email only; there is no durable store for
  // this list yet (see decision-docs if one gets added — a queryable
  // waitlist would need its own Prisma model + migration, which is a real
  // schema decision, not something to slip in silently here).
  if (pathname === '/auth/runtime-waitlist' && req.method === 'POST') {
    if (runtimeWaitlistLimited(req)) {
      return jsonResponse(res, { error: 'Too many requests, try again later.', code: 'rate_limited' }, 429);
    }
    recordRuntimeWaitlistAttempt(req);
    const body = await parseBody(req).catch(() => ({}));
    const email = String(body.email || '').trim().toLowerCase();
    const name = String(body.name || '').trim().slice(0, 120);
    const useCase = String(body.use_case || body.useCase || '').trim().slice(0, 600);
    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!EMAIL_RE.test(email)) {
      return jsonResponse(res, { error: 'A valid email address is required.', code: 'invalid_email' }, 400);
    }
    const delivery = await sendSystemEmail({
      templateId: 'runtime_waitlist_confirmation',
      to: email,
      from: process.env.CLOUDFLARE_EMAIL_FROM || process.env.SYSTEM_EMAIL_FROM || 'Singulance <welcome@admin.singulancelabs.com>',
      vars: {
        email,
        nameSuffix: name ? `, ${name}` : '',
        useCase: useCase || 'Not specified yet — no worries, tell us when your seat opens up.',
      },
    });
    // Never expose provider/delivery detail to the caller — a slow or
    // misconfigured mail provider must not read as "the waitlist failed."
    if (!delivery.ok && !delivery.skipped) {
      console.warn('[runtime-waitlist] confirmation email failed:', delivery.error);
    }
    return jsonResponse(res, { ok: true });
  }

  if (pathname === '/v1/referral-invitations/preview' && req.method === 'GET') {
    if (!(await partnerReferralsEnabled())) return jsonResponse(res, { error: 'Invitation is unavailable', code: 'invitation_unavailable' }, 404);
    if (!prisma) return jsonResponse(res, { error: 'Invitation service unavailable' }, 503);
    const token = url.searchParams.get('token');
    const resolved = await resolvePartnerReferral({ prisma, token, recordVisit: url.searchParams.get('record_visit') === '1' }).catch(() => null);
    if (!resolved) return jsonResponse(res, { error: 'Invitation is unavailable', code: 'invitation_unavailable' }, 404);
    return jsonResponse(res, { invitation: resolved.preview });
  }

  if (pathname === '/auth/signup-admission' && req.method === 'POST') {
    if (signupAdmissionLimited(req)) {
      return jsonResponse(res, { error: 'Invitation is unavailable', code: 'invitation_unavailable' }, 429);
    }
    const body = await parseBody(req);
    let accountType = String(body.account_type || '').trim().toLowerCase();
    const partnerReferralToken = String(body.referral_token || '').trim();
    const partnerReferral = partnerReferralToken && (await partnerReferralsEnabled())
      ? await resolvePartnerReferral({ prisma, token: partnerReferralToken }).catch(() => null)
      : null;
    if (partnerReferralToken && !partnerReferral) {
      recordSignupAdmissionAttempt(req, false);
      return jsonResponse(res, { error: 'Invitation is unavailable', code: 'invitation_unavailable' }, 403);
    }
    if (partnerReferral) accountType = partnerReferral.promotion.version.accountType === 'personal' ? 'personal' : 'enterprise';
    const code = String(body.invitation_code || body.enterprise_access_code || '').trim();
    const personalAdmission = accountType === 'personal'
      ? verifyPersonalInvitationLink({
        token: body.personal_invitation_token || null,
        configuredCode: PERSONAL_SIGNUP_INVITATION_CODE,
        secret: SIGNUP_ADMISSION_SECRET,
      })
      : null;
    const enterpriseAdmission = accountType === 'enterprise'
      ? await findEnterpriseInvitationAdmission({ prisma, code, token: body.enterprise_invitation_token || null }).catch(() => null)
      : null;
    // The environment allowlist is legacy-only. New B2B workspaces receive an
    // invitation bound to one recipient and one commercial profile.
    const accepted = Boolean(partnerReferral) || (accountType === 'personal'
      ? Boolean(personalAdmission) || invitationCodeMatches(code, PERSONAL_SIGNUP_INVITATION_CODE)
      : Boolean(enterpriseAdmission) || (accountType === 'enterprise' && isValidEnterpriseAccessCode(normalizeEnterpriseAccessCode(code))));
    recordSignupAdmissionAttempt(req, accepted);
    if (!accepted) return jsonResponse(res, { error: 'Invitation is unavailable', code: 'invitation_unavailable' }, 403);
    return jsonResponse(res, {
      signup_ticket: createSignupAdmission({ accountType, secret: SIGNUP_ADMISSION_SECRET, enterpriseInvitation: enterpriseAdmission,
        partnerReferral: partnerReferral ? { id: partnerReferral.row.id, version: partnerReferral.row.shareTokenVersion } : null, ttlSeconds: SIGNUP_ADMISSION_TTL_SECONDS }),
      expires_in_seconds: SIGNUP_ADMISSION_TTL_SECONDS,
      ...(enterpriseAdmission ? { invitation: enterpriseAdmission.preview } : {}),
      ...(partnerReferral ? { referral: partnerReferral.preview } : {}),
    });
  }

  if (pathname === '/auth/login' && req.method === 'GET') {
    if (!zitadelClient) {
      return jsonResponse(res, { error: 'ZITADEL not configured' }, 503);
    }
    const admission = signupAdmissionFromRequest(url);
    const workspaceInvite = await workspaceInviteAdmissionFromRequest(url);
    if (url.searchParams.get('signup_ticket') && !admission) return jsonResponse(res, { error: 'Invitation is unavailable' }, 403);
    if (url.searchParams.get('workspace_invite') && !workspaceInvite) return jsonResponse(res, { error: 'Workspace invitation is unavailable' }, 403);
    const state = await sessionStore.createAuthState({
      returnTo: url.searchParams.get('return_to') || CONFIG.postLoginRedirect,
      signupAdmission: admission,
      workspaceInviteToken: workspaceInvite?.token || null,
    });
    const authorizeOptions = {};
    if (url.searchParams.get('login_hint')) {
      authorizeOptions.loginHint = url.searchParams.get('login_hint');
    }
    applyIdpHint(authorizeOptions, url.searchParams.get('idp_hint'));
    return redirect(res, zitadelClient.buildAuthorizeUrl(state, authorizeOptions));
  }

  // ─── Zitadel Registration (prompt=create) ────────────────────
  if (pathname === '/auth/register' && req.method === 'GET') {
    if (!zitadelClient) {
      return jsonResponse(res, { error: 'ZITADEL not configured' }, 503);
    }
    const admission = signupAdmissionFromRequest(url);
    if (!admission) return jsonResponse(res, { error: 'Invitation is unavailable' }, 403);
    const state = await sessionStore.createAuthState({
      returnTo: url.searchParams.get('return_to') || CONFIG.postLoginRedirect,
      signupAdmission: admission,
    });
    const authorizeOptions = { prompt: 'create' };
    if (url.searchParams.get('login_hint')) {
      authorizeOptions.loginHint = url.searchParams.get('login_hint');
    }
    applyIdpHint(authorizeOptions, url.searchParams.get('idp_hint'));
    return redirect(res, zitadelClient.buildAuthorizeUrl(state, authorizeOptions));
  }

  if (pathname === '/auth/callback' && req.method === 'GET') {
    if (!zitadelClient) {
      return jsonResponse(res, { error: 'ZITADEL not configured' }, 503);
    }

    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !state) {
      return jsonResponse(res, { error: 'Missing code or state' }, 400);
    }

    const authState = await sessionStore.consumeAuthState(state);
    if (!authState) {
      return jsonResponse(res, { error: 'Invalid login state' }, 400);
    }

    try {
      const { userInfo } = await zitadelClient.exchangeAndResolveUser(code);
      const existingPlatformUser = await platformUserExists({ sub: userInfo.sub, email: userInfo.email });
      const workspaceInviteAccepted = authState.workspaceInviteToken
        ? await workspaceInviteMatchesAuthenticatedEmail(authState.workspaceInviteToken, userInfo.email)
        : false;
      if (!existingPlatformUser && !authState.signupAdmission && !workspaceInviteAccepted) {
        return redirect(res, `${defaultFrontendBaseUrl}/hivemind/login?create=1&onboarding_error=invitation_required`);
      }
      const user = await upsertUserFromZitadel(userInfo);
      const { org } = await resolveCurrentOrg(user.id);

      // JIT Provisioning: if org resolved and OrgSsoConfig has jitProvisioning=true,
      // auto-create UserOrganization if not already a member.
      if (org?.id && prisma) {
        try {
          const ssoConf = await prisma.orgSsoConfig.findUnique({
            where: { orgId: org.id },
            select: { jitProvisioning: true, defaultRole: true, defaultTeamId: true, enabled: true },
          });
          if (ssoConf?.enabled && ssoConf.jitProvisioning) {
            const existingMembership = await prisma.userOrganization.findUnique({
              where: { userId_orgId: { userId: user.id, orgId: org.id } },
            });
            if (!existingMembership) {
              const role = ssoConf.defaultRole || 'member';
              await createMembershipWithinPlan({ userId: user.id, orgId: org.id, role, joinedAt: new Date() });
              if (ssoConf.defaultTeamId) {
                await prisma.teamMember.upsert({
                  where: { teamId_userId: { teamId: ssoConf.defaultTeamId, userId: user.id } },
                  create: { teamId: ssoConf.defaultTeamId, userId: user.id, role: 'member' },
                  update: {},
                }).catch(() => {});
              }
              // Audit JIT provisioning event
              const auditLoggerInst = await _getAuditLogger();
              auditLoggerInst?.log({
                userId: user.id,
                organizationId: org.id,
                eventType: 'sso.jit_provisioned',
                eventCategory: 'provisioning',
                action: 'create',
                resourceType: 'user_organization',
                newValue: { role, default_team_id: ssoConf.defaultTeamId },
                metadata: { sso_provider: 'oidc' },
              }).catch(() => {});
            }
          }
        } catch (jitErr) {
          // JIT errors must not block login
          console.warn('[auth/callback] JIT provisioning error:', jitErr.message);
        }
      }

      const sessionId = await sessionStore.createSession({
        userId: user.id,
        email: user.email,
        orgId: org?.id || null
      });
      if (!org) {
        const activations = await advanceActivationForEmail({
          prisma, email: user.email, userId: user.id,
          stage: ACTIVATION_STAGES.SIGNED_IN_PENDING_COMPANY, reason: 'authenticated_without_company',
        });
        for (const activation of activations) scheduleActivationWorkflow({ activation }).catch((error) => console.warn('[activation-lifecycle] oauth signup scheduling failed:', error.message));
      }

      let finalRedirect = authState.returnTo || CONFIG.postLoginRedirect;
      // Cross-origin handshake support for external tools (MiroFish, VS Code, etc.)
      if (finalRedirect.includes('localhost') || finalRedirect.includes('?hivemind_auth=callback')) {
          const separator = finalRedirect.includes('?') ? '&' : '?';
          finalRedirect += `${separator}token=${sessionId}`;
      }

      return redirect(res, finalRedirect, [makeSessionCookie(sessionId)]);
    } catch (error) {
      return jsonResponse(res, { error: error.message }, 500);
    }
  }

  if (pathname === '/auth/logout' && req.method === 'POST') {
    const current = await getCurrentSession(req);
    if (current) {
      await sessionStore.destroySession(current.sessionId);
    }
    return jsonResponse(res, { success: true }, 200, {
      'Set-Cookie': clearSessionCookie()
    });
  }

  // ─── /auth/cli — OAuth loopback for CLI tools (Claude Code plugin etc.) ──
  // Flow:
  //   1. CLI calls /auth/cli?callback=http://localhost:NNNN/callback&client=claude_code
  //   2. If session is missing, kick off Zitadel SSO with returnTo back to /auth/cli
  //   3. On authenticated session, mint an API key with scopes [memory:read, memory:write, mcp, coding]
  //      and 302 to <callback>?apikey=hm_...&user_id=...&org_id=...
  //
  // Loopback safety: callback MUST be http://localhost:* or http://127.0.0.1:* to prevent open-redirect abuse.
  if (pathname === '/auth/cli' && req.method === 'GET') {
    const callback = url.searchParams.get('callback') || '';
    const client = url.searchParams.get('client') || 'cli';

    let cbUrl;
    try {
      cbUrl = new URL(callback);
    } catch {
      return jsonResponse(res, { error: 'invalid callback' }, 400);
    }
    // Allowed callback origins:
    //   - http(s)://localhost:NNNN | 127.0.0.1 | ::1   (CLI loopback)
    //   - https://<allowed-frontend-origin>            (browser-driven 1-click flow)
    // Frontend origins are read from HIVEMIND_ALLOWED_ORIGINS env (comma-separated).
    const isLoopback =
      (cbUrl.protocol === 'http:' || cbUrl.protocol === 'https:') &&
      (cbUrl.hostname === 'localhost' ||
        cbUrl.hostname === '127.0.0.1' ||
        cbUrl.hostname === '::1');
    const allowedFrontendOrigins = (process.env.HIVEMIND_ALLOWED_ORIGINS || '')
      .split(',')
      .map(o => o.trim())
      .filter(Boolean);
    const cbOrigin = `${cbUrl.protocol}//${cbUrl.host}`;
    const isAllowedFrontend =
      cbUrl.protocol === 'https:' && allowedFrontendOrigins.includes(cbOrigin);
    if (!isLoopback && !isAllowedFrontend) {
      return jsonResponse(
        res,
        {
          error: 'callback must be http(s)://localhost:NNNN, 127.0.0.1, or an allowed frontend origin',
          allowed_frontend_origins: allowedFrontendOrigins,
        },
        400
      );
    }

    const current = await getCurrentSession(req);
    if (!current) {
      // No session — start Zitadel SSO with returnTo pointing back here so the
      // post-auth redirect re-enters this branch with a session cookie.
      if (!zitadelClient) {
        return jsonResponse(res, { error: 'ZITADEL not configured' }, 503);
      }
      const cpBase =
        process.env.HIVEMIND_CONTROL_PLANE_URL ||
        `https://api.hivemind.davinciai.eu:8040`;
      const selfReturnTo = `${cpBase}/auth/cli?callback=${encodeURIComponent(
        callback
      )}&client=${encodeURIComponent(client)}`;
      const state = await sessionStore.createAuthState({
        returnTo: selfReturnTo,
      });
      return redirect(res, zitadelClient.buildAuthorizeUrl(state, {}));
    }

    // Authenticated — mint an API key for this client.
    try {
      const userId = current.session.userId;
      const orgId = current.session.orgId || null;
      if (!prisma) {
        return jsonResponse(res, { error: 'persistence offline' }, 503);
      }
      const userAgent = req.headers['user-agent'] || '';
      const ip =
        req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
        req.socket.remoteAddress ||
        null;
      const { rawKey } = await createPersistedApiKey(prisma, {
        userId,
        orgId,
        name: `cli:${client}`,
        description: `Issued via /auth/cli for ${client} on ${new Date().toISOString()}`,
        scopes: ['memory:read', 'memory:write', 'mcp', 'coding', 'web_search', 'web_crawl'],
        expiresAt: null,
        rateLimitPerMinute: 120,
        createdByIp: ip,
        userAgent,
      });

      const params = new URLSearchParams({
        apikey: rawKey,
        user_id: userId,
        ...(orgId ? { org_id: orgId } : {}),
        client,
      });
      const sep = cbUrl.search ? '&' : '?';
      const target = `${callback}${sep}${params.toString()}`;
      return redirect(res, target);
    } catch (err) {
      console.error('[auth/cli] failed:', err.message);
      const params = new URLSearchParams({ error: err.message });
      const sep = cbUrl.search ? '&' : '?';
      return redirect(res, `${callback}${sep}${params.toString()}`);
    }
  }

  if (pathname === '/v1/bootstrap' && req.method === 'GET') {
    const current = await getCurrentSession(req);
    if (!current) {
      return jsonResponse(res, await buildAnonymousBootstrapPayload(req));
    }
    const user = await prisma?.user.findUnique({ where: { id: current.session.userId } });
    if (!user) {
      return jsonResponse(res, await buildAnonymousBootstrapPayload(req));
    }
    return jsonResponse(res, await buildBootstrapPayload(user, req, current.session.orgId));
  }

  // Welcome email — fired by the frontend once the user lands on Overview after
  // a successful login. Recipient is ALWAYS the session user (never client-
  // supplied), so this can't be abused to send mail to arbitrary addresses.
  // Idempotent per login session; fire-and-forget — never blocks or fails login.
  if (pathname === '/v1/notifications/welcome' && req.method === 'POST') {
    const current = await requireSession(req, res);
    if (!current) return;
    if (_welcomedSessions.has(current.sessionId)) {
      return jsonResponse(res, { ok: true, deduped: true });
    }
    _welcomedSessions.add(current.sessionId);
    const user = await prisma?.user.findUnique({ where: { id: current.session.userId } });
    if (!user?.email) {
      return jsonResponse(res, { ok: false, error: 'no_user_email' });
    }
    const firstName = (user.displayName || user.email.split('@')[0] || 'there').split(' ')[0];
    const membership = await prisma.userOrganization.findFirst({
      where: { userId: user.id, orgId: current.session.orgId || undefined, isActive: true },
      select: { org: { select: { id: true, name: true, accountType: true, hostingMode: true, trialEndsAt: true } } },
    }).catch(() => null);
    const workspace = membership?.org || null;
    // First-ever login retries workspace activation delivery if its asynchronous
    // send was interrupted. The durable receipt prevents duplicate delivery.
    const ageMs = user.createdAt ? Date.now() - new Date(user.createdAt).getTime() : Infinity;
    const isNewAccount = ageMs < 15 * 60 * 1000;
    if (isNewAccount) {
      if (!workspace) {
        // Do not send a generic email before onboarding has selected the
        // workspace profile. Organization creation will dispatch the correct
        // personal or enterprise welcome.
        return jsonResponse(res, { ok: true, pending_workspace_activation: true, template: null });
      }
      const delivery = await signupWelcome.deliver(user, { source: 'overview_recovery', workspace });
      return jsonResponse(res, {
        ok: Boolean(delivery.ok),
        template: delivery.template,
        deduped: Boolean(delivery.deduped),
        delivery_status: delivery.deliveryStatus || null,
      }, delivery.ok ? 200 : 202);
    }
    const templateId = workspace
      ? welcomeProfileForWorkspace(workspace, { returning: true }).templateId
      : 'welcome_login';
    // Don't await the send — return immediately so login UX is never delayed.
    sendSystemEmail({
      templateId,
      to: user.email,
      vars: {
        name: firstName,
        email: user.email,
        orgName: workspace?.name || '',
        accountType: workspace?.accountType || 'personal',
        hostingMode: workspace?.hostingMode || 'managed',
        onboardingEndsAt: workspace?.trialEndsAt ? workspace.trialEndsAt.toISOString().slice(0, 10) : '',
      },
    }).catch((err) => console.error(JSON.stringify({ svc: 'email', level: 'error', event: 'welcome_dispatch_failed', error: err.message })));
    return jsonResponse(res, { ok: true, template: templateId });
  }

  // Admin broadcast — send a templated notification to ALL platform users
  // (real emails only; placeholder @local.hivemind.dev accounts excluded).
  // Admin/owner-gated. dryRun is the DEFAULT — a live send requires explicit
  // { dryRun: false }. Sender is the single SYSTEM_EMAIL connection; recipients
  // are resolved server-side. Throttled to respect Gmail quota.
  if (pathname === '/v1/notifications/broadcast' && req.method === 'POST') {
    const current = await requireSession(req, res);
    if (!current) return;
    const admin = await requireOrgAdmin(req, res, current.session.userId, current.session.orgId);
    if (!admin) return;
    const body = (await parseBody(req)) || {};
    const { subject, heading, body: msgBody, templateId, dryRun = true } = body;
    if (!templateId && (!subject || !msgBody)) {
      return jsonResponse(res, { error: 'subject_and_body_required' }, 400);
    }
    const users = await prisma.user.findMany({
      where: { email: { not: null }, NOT: { email: { endsWith: '@local.hivemind.dev' } } },
      select: { email: true, displayName: true },
    });
    const seen = new Set();
    const recipients = [];
    for (const u of users) {
      const e = (u.email || '').trim().toLowerCase();
      if (!e || seen.has(e)) continue;
      seen.add(e);
      recipients.push({
        email: u.email,
        name: (u.displayName || u.email.split('@')[0] || 'there').split(' ')[0],
      });
    }
    if (dryRun) {
      return jsonResponse(res, {
        ok: true,
        dryRun: true,
        recipientCount: recipients.length,
        sample: recipients.slice(0, 8).map((r) => r.email),
        note: 'No emails sent. Re-POST with { "dryRun": false } to send for real.',
      });
    }
    const tpl = templateId || 'announcement';
    const result = await sendSystemEmailBatch(recipients, {
      templateId: tpl,
      perMessageDelayMs: 700,
      varsFor: (r) => ({
        name: r.name,
        email: r.email,
        subject,
        heading: heading || subject,
        body: msgBody,
        preheader: String(msgBody || '').replace(/\s+/g, ' ').slice(0, 90),
      }),
    });
    console.log(JSON.stringify({
      svc: 'email', level: 'info', event: 'broadcast_done',
      actor: current.session.userId, template: tpl,
      total: result.total, sent: result.sent, failed: result.failed, skipped: result.skipped,
    }));
    return jsonResponse(res, { ok: true, dryRun: false, ...result });
  }

  if (pathname === '/v1/orgs' && req.method === 'POST') {
    const current = await requireSession(req, res);
    if (!current) return;
    const body = await parseBody(req);
    if (!body.name) {
      return jsonResponse(res, { error: 'name is required' }, 400);
    }
    // Plans are commercial state. A browser cannot self-assign a paid plan;
    // referrals and Stripe webhooks create time-bound entitlements server-side.
    // EXCEPTION: a valid enterprise ACCESS CODE unlocks the standard 14-day
    // enterprise onboarding → runway terms (seeded below via activateOffer). The
    // code is an allow-list (see billing/access-codes.js), never "any non-empty
    // string" — that would let anyone self-provision a paid enterprise workspace.
    const requestedPlanInput = typeof body.plan === 'string' ? body.plan.trim().toLowerCase() : 'free';
    const referralToken = String(body.referralToken || body.referral_token || '').trim();
    const signupUser = referralToken
      ? await prisma.user.findUnique({ where: { id: current.session.userId }, select: { email: true } }).catch(() => null)
      : null;
    const partnerReferral = referralToken && (await partnerReferralsEnabled())
      ? await resolvePartnerReferral({ prisma, token: referralToken, email: signupUser?.email || '', orgId: null }).catch(() => null)
      : null;
    if (referralToken && !partnerReferral) return jsonResponse(res, { error: 'referral invitation unavailable', code: 'invitation_unavailable' }, 403);
    const admissionAccountType = partnerReferral
      ? (partnerReferral.promotion.version.accountType === 'personal' ? 'personal' : 'enterprise')
      : (requestedPlanInput === 'enterprise' ? 'enterprise' : 'personal');
    const signupAdmission = verifySignupAdmission({
      ticket: body.signup_ticket,
      accountType: admissionAccountType,
      secret: SIGNUP_ADMISSION_SECRET,
    });
    if (partnerReferral && signupAdmission?.partnerReferral?.id !== partnerReferral.row.id) {
      return jsonResponse(res, { error: 'referral invitation unavailable', code: 'invitation_unavailable' }, 403);
    }
    const enterpriseInvitationAdmission = requestedPlanInput === 'enterprise'
      ? signupAdmission?.enterpriseInvitation || null : null;
    const existingMembershipCount = await prisma.userOrganization.count({ where: { userId: current.session.userId, isActive: true } });
    if (!isAdminAuthorized(req, url) && existingMembershipCount === 0 && !signupAdmission) {
      return jsonResponse(res, { error: 'Invitation is unavailable', code: 'invitation_required' }, 403);
    }
    const enterpriseAccessCode = normalizeEnterpriseAccessCode(body.enterprise_access_code);
    let enterpriseViaAccessCode = false;
    let enterpriseInvitationProfile = null;
    let requestedPlan;
    if (isAdminAuthorized(req, url)) {
      requestedPlan = requestedPlanInput;
    } else if (requestedPlanInput === 'enterprise') {
      if (enterpriseInvitationAdmission) {
        const invitation = await prisma.enterpriseInvitation.findUnique({ where: { id: enterpriseInvitationAdmission.id } }).catch(() => null);
        if (!invitation) return jsonResponse(res, { error: 'invitation unavailable', code: 'invalid_enterprise_code' }, 403);
        enterpriseInvitationProfile = invitation;
        requestedPlan = 'enterprise';
      } else if (!isValidEnterpriseAccessCode(enterpriseAccessCode)) {
        // FE maps a 403 here → onboarding_error=invalid_enterprise_code.
        return jsonResponse(res, { error: 'invalid or inactive enterprise access code', code: 'invalid_enterprise_code' }, 403);
      } else {
        requestedPlan = 'enterprise';
        enterpriseViaAccessCode = true;
      }
    } else {
      requestedPlan = 'free';
    }
    if (!PLANS[requestedPlan]) {
      return jsonResponse(res, { error: 'invalid plan', valid: Object.keys(PLANS) }, 400);
    }
    const referralCode = normalizeReferralCode(body.referralCode || body.referral_code);
    if (enterpriseInvitationAdmission && (referralCode || referralToken)) {
      return jsonResponse(res, { error: 'an enterprise invitation cannot be combined with a referral invitation' }, 400);
    }
    if (referralCode && referralToken) {
      return jsonResponse(res, { error: 'choose one referral invitation' }, 400);
    }
    let referralCampaign = null;
    let signupPromotion = partnerReferral?.promotion || null;
    if (referralCode) {
      const codeSignupUser = await prisma.user.findUnique({ where: { id: current.session.userId }, select: { email: true } }).catch(() => null);
      signupPromotion = await findPromotionForCode({ prisma, code: referralCode, email: codeSignupUser?.email || '', orgId: null }).catch(() => null);
      referralCampaign = signupPromotion ? null : await prisma.referralCampaign.findUnique({ where: { code: referralCode } }).catch(() => null);
      const now = new Date();
      if (!signupPromotion && (!referralCampaign || !referralCampaign.active || (referralCampaign.startsAt && referralCampaign.startsAt > now)
        || (referralCampaign.endsAt && referralCampaign.endsAt <= now)
        || (referralCampaign.maxRedemptions != null && referralCampaign.redemptionCount >= referralCampaign.maxRedemptions))) {
        return jsonResponse(res, { error: 'promotion unavailable' }, 400);
      }
    }
    const referralOffer = referralCampaign ? buildReferralOffer(referralCampaign) : null;
    const provisionPlan = signupPromotion?.version.basePlan || requestedPlan;

    const slugBase = sanitizeSlug(body.slug || body.name);
    const existing = await prisma.organization.findUnique({ where: { slug: slugBase } });
    const slug = existing ? `${slugBase}-${crypto.randomUUID().slice(0, 6)}` : slugBase;
    // Persist the user's hosting choice from onboarding (managed = we host; self_host = their agent box).
    let hostingMode = (body.deployment === 'selfhost' || body.deployment === 'self_hosted' || body.hosting_mode === 'self_host')
      ? 'self_host' : 'managed';
    let memoryStorageMode = memoryStorageModeFor(provisionPlan, hostingMode);
    let accountType = provisionPlan === 'enterprise' ? (hostingMode === 'self_host' ? 'enterprise_self_hosted' : 'enterprise_managed') : 'personal';
    if (enterpriseInvitationProfile) {
      hostingMode = enterpriseInvitationProfile.hostingMode;
      memoryStorageMode = enterpriseInvitationProfile.storageMode;
      accountType = enterpriseInvitationProfile.accountType;
    } else if (signupPromotion) {
      hostingMode = signupPromotion.version.hostingMode;
      memoryStorageMode = signupPromotion.version.storageMode;
      accountType = signupPromotion.version.accountType;
    }
    const orgId = crypto.randomUUID();
    const regFile = process.env.MNEME_AGENT_REGISTRY_FILE || '/app/data/byod-agents.json';
    const needsEmbeddedAmr = hostingMode === 'managed' && memoryStorageMode === 'amr_embedded';
    if (needsEmbeddedAmr) {
      try {
        registerEmbeddedAmrOrg(orgId, regFile);
      } catch (error) {
        console.error('[org-create] .amr-central reservation failed', { orgId, error: error.message });
        return jsonResponse(res, { error: 'Personal memory storage is temporarily unavailable.' }, 503);
      }
    }
    let org;
    let enterpriseInvitationRedemption = null;
    try {
      const created = await prisma.$transaction(async (tx) => {
        const newOrg = await tx.organization.create({
          data: {
            id: orgId,
            zitadelOrgId: `cp-org-${crypto.randomUUID()}`,
            name: body.name,
            slug,
            // The promotion was verified before this transaction and is
            // redeemed atomically below, so provisional org metadata must not
            // momentarily describe a free workspace as a paid pilot.
            plan: provisionPlan,
            hostingMode,
            memoryStorageMode,
            accountType,
          },
        });
        await tx.userOrganization.create({
          data: {
            userId: current.session.userId,
            orgId: newOrg.id,
            role: 'owner',
            roles: ['org_owner'],
            joinedAt: new Date(),
          },
        });
        // Enterprise access code → seed the standard 14-day onboarding → runway
        // entitlement atomically with org creation. activateOffer writes the
        // onboarding + runway phase rows, keeps plan='enterprise', sets
        // subscriptionStatus='active' and trialEndsAt = now + 14d (full access
        // during onboarding, then the self-serve Runway estimator takes over).
        if (enterpriseViaAccessCode) {
          await activateOffer({ tx, orgId: newOrg.id, offer: buildStandardOffer('enterprise'), source: 'enterprise_access_code' });
        }
        let enterpriseInvitation = null;
        if (enterpriseInvitationAdmission) {
          const signupUser = await tx.user.findUnique({ where: { id: current.session.userId }, select: { email: true } });
          enterpriseInvitation = await redeemEnterpriseInvitation({
            tx,
            invitationId: enterpriseInvitationAdmission.id,
            method: enterpriseInvitationAdmission.method,
            version: enterpriseInvitationAdmission.version,
            userId: current.session.userId,
            userEmail: signupUser?.email || '',
            orgId: newOrg.id,
          });
        }
        let promotion = null;
        if (signupPromotion) {
          const promotionUser = await tx.user.findUnique({ where: { id: current.session.userId }, select: { email: true } });
          promotion = referralToken
            ? await redeemPartnerReferral({ prisma, tx, token: referralToken, orgId: newOrg.id, userId: current.session.userId, email: promotionUser?.email || '', requestId: req.headers['x-request-id'] || null })
            : await redeemPromotion({ prisma, tx, orgId: newOrg.id, userId: current.session.userId, email: promotionUser?.email || '', code: referralCode,
              requestId: req.headers['x-request-id'] || null, applyProfile: true });
        }
        return { org: newOrg, promotion, enterpriseInvitation };
      });
      org = created.org;
      signupPromotion = created.promotion || signupPromotion;
      enterpriseInvitationRedemption = created.enterpriseInvitation || null;
    } catch (error) {
      if (needsEmbeddedAmr) {
        try { unregisterEmbeddedAmrOrg(orgId, regFile); }
        catch (cleanupError) {
          console.error('[org-create] .amr-central reservation cleanup failed', { orgId, error: cleanupError.message });
        }
      }
      return jsonResponse(res, { error: error.message }, 409);
    }

    if (needsEmbeddedAmr) console.log(`[org-create] .amr-central registered for new personal org ${org.id}`);

    if (enterpriseInvitationRedemption) {
      await audit({ organizationId: org.id, userId: current.session.userId, eventType: 'commercial.enterprise_invitation_redeemed', eventCategory: 'billing', action: 'create',
        resourceType: 'enterprise_invitation', resourceId: enterpriseInvitationRedemption.invitation.id,
        metadata: { onboarding_ends_at: enterpriseInvitationRedemption.onboardingEndsAt, account_type: enterpriseInvitationRedemption.invitation.account_type },
        ..._reqMeta(req) });
    }

    // Deliver one profile-specific welcome only after the workspace exists.
    // The durable receipt is scoped to this user and organization, so an OAuth
    // callback retry or a browser refresh cannot create a duplicate email.
    prisma.user.findUnique({ where: { id: current.session.userId }, select: { id: true, email: true, displayName: true } })
      .then((workspaceOwner) => signupWelcome.deliver(workspaceOwner, {
        source: 'workspace_activation',
        workspace: {
          id: org.id,
          name: org.name,
          accountType,
          hostingMode,
          onboardingEndsAt: enterpriseInvitationRedemption?.onboardingEndsAt || null,
        },
      }))
      .then((delivery) => {
        if (!delivery.ok) console.error(JSON.stringify({ svc: 'email', level: 'error', event: 'workspace_welcome_failed', orgId: org.id, error: delivery.error }));
      })
      .catch((error) => console.error(JSON.stringify({ svc: 'email', level: 'error', event: 'workspace_welcome_failed', orgId: org.id, error: error.message })));

    // Route the org to its Qdrant home by PLAN:
    //   enterprise (paid)  → own collection org_<id> (provisioned now, fire-and-forget)
    //   free (personal)    → shared HIVEMIND_PERSONAL pool (no collection created)
    //   self-host          → NO central collection (data lives on the customer's agent) — skip.
    // Persist the decision on the org row so the hot path resolves without a plan
    // lookup. Signup must never block/fail on the vector store.
    if (hostingMode !== 'self_host') {
      provisionForPlan(org.id, provisionPlan)
        .then((vectorContainer) =>
          prisma.organization.update({ where: { id: org.id }, data: { vectorContainer } })
        )
        .catch((err) =>
          console.error('[org-create] vector container provisioning failed', { orgId: org.id, plan: requestedPlan, error: err?.message })
        );
    }

    // Managed-enterprise data plane (flag-gated, dormant unless MANAGED_AGENT_PROVISION=true):
    // for paid/managed enterprise plans, also spin up the org's OWN .amr agent
    // (agent + Postgres + Qdrant) in our cloud and register it — so managed
    // enterprise uses the SAME data plane as self-host (Model B). Fire-and-forget;
    // the provisioner never throws and never blocks/fails org creation.
    if (provisionPlan === 'enterprise' || provisionPlan === 'managed') {
      import('./selfhost/managed-provisioner.js')
        .then((m) => m.provisionManagedAgent({ orgId: org.id }))
        .then((r) => console.log('[org-create] managed agent provision', { orgId: org.id, ...r }))
        .catch((err) =>
          console.error('[org-create] managed agent provisioning failed', { orgId: org.id, error: err?.message })
        );
    }

    await sessionStore.destroySession(current.sessionId);
    const sessionId = await sessionStore.createSession({
      ...current.session,
      orgId: org.id
    });
    const activations = await advanceActivationForEmail({
      prisma, email: current.session.email, userId: current.session.userId, orgId: org.id,
      stage: ACTIVATION_STAGES.ONBOARDING_IN_PROGRESS, reason: 'organization_created',
    });
    for (const activation of activations) scheduleActivationWorkflow({ activation }).catch((error) => console.warn('[activation-lifecycle] onboarding scheduling failed:', error.message));

    return jsonResponse(res, {
      success: true,
      organization: {
        id: org.id,
        name: org.name,
        slug: org.slug,
        plan: enterpriseInvitationRedemption
          ? 'enterprise_onboarding'
          : (signupPromotion?.promotion?.version?.base_plan || org.plan || provisionPlan),
        plan_name: enterpriseInvitationRedemption
          ? 'Enterprise Onboarding'
          : null,
        hosting_mode: org.hostingMode || hostingMode,
        memory_storage_mode: org.memoryStorageMode || memoryStorageModeFor(provisionPlan, hostingMode),
        memory_storage_label: memoryStorageLabel(org.memoryStorageMode || memoryStorageModeFor(provisionPlan, hostingMode)),
        referral: referralOffer ? { code: referralOffer.code, phase: 'pending_payment', offer: referralOffer } : null,
        promotion: signupPromotion?.termsSnapshot || null,
        enterprise_onboarding: enterpriseInvitationRedemption ? {
          active: true,
          plan: 'enterprise_onboarding',
          plan_name: 'Enterprise Onboarding',
          ends_at: enterpriseInvitationRedemption.onboardingEndsAt,
          account_type: enterpriseInvitationRedemption.invitation.account_type,
          hosting_mode: enterpriseInvitationRedemption.invitation.hosting_mode,
        } : null,
      }
    }, 201, {
      'Set-Cookie': makeSessionCookie(sessionId)
    });
  }

  // Workspace identity is a durable, organization-scoped profile. It is kept
  // out of UserProfile on purpose: chat, ingestion and agent tools can read it
  // through Core context, but only an owner/admin can change it here.
  const organizationProfileMatch = pathname.match(/^\/v1\/orgs\/([0-9a-f-]{36})\/profile$/);
  if (organizationProfileMatch) {
    if (!prisma) return jsonResponse(res, { error: 'Database unavailable' }, 503);
    const current = await requireSession(req, res);
    if (!current) return;
    const orgId = organizationProfileMatch[1];
    const membership = await getActiveOrganizationMembership(prisma, {
      userId: current.session.userId,
      orgId,
    });
    if (!membership) return jsonResponse(res, { error: 'Resource not found' }, 404);

    const organization = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { id: true, name: true, slug: true, plan: true, dataResidencyRegion: true },
    });
    if (!organization) return jsonResponse(res, { error: 'Resource not found' }, 404);

    const serialize = (facts) => ({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      plan: organization.plan || 'free',
      hosting_mode: 'managed',
      data_residency_region: organization.dataResidencyRegion || 'eu-central',
      company_profile: Object.fromEntries(facts.map((fact) => [fact.key.replace(/^company\./, ''), fact.value])),
      facts: facts.map(({ id, key, value, category, version, updatedAt }) => ({ id, key, value, category, version, updated_at: updatedAt })),
    });

    if (req.method === 'GET') {
      const facts = await prisma.organizationProfile.findMany({
        where: { orgId, deletedAt: null },
        orderBy: [{ category: 'asc' }, { key: 'asc' }],
      });
      return jsonResponse(res, {
        organization: serialize(facts),
        can_edit: isOrganizationAdmin(membership) || canManageOrg(membership.role),
      });
    }

    if (req.method === 'PATCH') {
      const admin = await requireOrgAdmin(req, res, current.session.userId, orgId);
      if (!admin) return;
      const body = (await parseBody(req)) || {};
      const companyProfile = body.company_profile;
      if (!companyProfile || typeof companyProfile !== 'object' || Array.isArray(companyProfile)) {
        return jsonResponse(res, { error: 'company_profile object is required' }, 400);
      }
      const allowedKeys = new Set(['website', 'industry', 'description', 'audience', 'mission']);
      const entries = Object.entries(companyProfile)
        .filter(([key]) => allowedKeys.has(key))
        .map(([key, value]) => [key, typeof value === 'string' ? value.trim() : '']);
      if (!entries.length) return jsonResponse(res, { error: 'No supported organization profile fields provided' }, 400);
      if (entries.some(([, value]) => value.length > 4000)) {
        return jsonResponse(res, { error: 'Organization profile values must be at most 4000 characters' }, 400);
      }

      const changed = await prisma.$transaction(async (tx) => {
        const results = [];
        for (const [key, value] of entries) {
          const canonicalKey = `company.${key}`;
          const existing = await tx.organizationProfile.findUnique({
            where: { orgId_key: { orgId, key: canonicalKey } },
          });
          if (!value) {
            if (existing && !existing.deletedAt) {
              await tx.organizationProfile.update({
                where: { id: existing.id },
                data: { deletedAt: new Date(), version: { increment: 1 }, updatedByUserId: current.session.userId },
              });
              results.push({ key: canonicalKey, action: 'deleted', previousValue: existing.value });
            }
            continue;
          }
          const row = await tx.organizationProfile.upsert({
            where: { orgId_key: { orgId, key: canonicalKey } },
            update: {
              value,
              category: 'identity',
              version: { increment: 1 },
              updatedByUserId: current.session.userId,
              deletedAt: null,
            },
            create: {
              orgId,
              key: canonicalKey,
              value,
              category: 'identity',
              updatedByUserId: current.session.userId,
            },
          });
          results.push({ key: canonicalKey, action: existing ? 'updated' : 'created', previousValue: existing?.value || null, row });
        }
        return results;
      });
      await audit({
        userId: current.session.userId,
        organizationId: orgId,
        eventType: 'organization_profile.updated',
        eventCategory: 'data_modification',
        action: 'update',
        resourceType: 'organization_profile',
        metadata: { changed: changed.map(({ key, action }) => ({ key, action })) },
        oldValue: Object.fromEntries(changed.filter((item) => item.previousValue !== null).map((item) => [item.key, item.previousValue])),
        newValue: Object.fromEntries(changed.filter((item) => item.row).map((item) => [item.key, item.row.value])),
        ipAddress: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null,
        userAgent: req.headers['user-agent'] || null,
      });
      const facts = await prisma.organizationProfile.findMany({
        where: { orgId, deletedAt: null },
        orderBy: [{ category: 'asc' }, { key: 'asc' }],
      });
      return jsonResponse(res, { organization: serialize(facts), changed: changed.map(({ key, action }) => ({ key, action })) });
    }

    return jsonResponse(res, { error: 'Method not allowed' }, 405);
  }

  // POST /v1/orgs/:orgId/invites/bulk — invite MULTIPLE people in one go.
  // Body: { emails: string[], role?: string }. Per email: create an orgInvite
  // + send the branded `team_invite` system email ("{{orgName}} is on
  // HIVEMIND, your admin has invited you") via the same email pipeline as
  // the login welcome mails. Returns a per-email result array.
  const inviteBulkMatch = pathname.match(/^\/v1\/orgs\/([^/]+)\/invites\/bulk$/);
  if (inviteBulkMatch && req.method === 'POST') {
    const current = await requireSession(req, res);
    if (!current) return;
    const orgId = inviteBulkMatch[1];
    const membership = await requireOrgAdmin(req, res, current.session.userId, orgId);
    if (!membership) return;

    try {
      await assertInviteCapacityWithinPlan({ orgId });
    } catch (error) {
      if (error instanceof PlanCapacityError) return capacityErrorResponse(res, error);
      throw error;
    }

    const body = await parseBody(req);
    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const rawEmails = Array.isArray(body.emails) ? body.emails : [];
    const emails = Array.from(new Set(
      rawEmails.map((e) => String(e || '').trim().toLowerCase()).filter((e) => EMAIL_RE.test(e)),
    )).slice(0, 50); // sanity cap per batch
    if (emails.length === 0) {
      return jsonResponse(res, { error: 'no_valid_emails', message: 'Provide at least one valid email address.' }, 400);
    }
    const bulkRole = typeof body.role === 'string' && ['member', 'viewer', 'admin'].includes(body.role.trim().toLowerCase())
      ? body.role.trim().toLowerCase()
      : 'member';
    const bulkRoles = bulkRole === 'admin' ? ['org_admin'] : [bulkRole];
    // Optional project scoping — invitees auto-join these projects on accept
    // (project-scoped member invites become guests of just those projects).
    const requestedProjectIds = Array.isArray(body.project_ids)
      ? body.project_ids.filter((id) => typeof id === 'string' && id.length > 0).slice(0, 10)
      : [];
    let bulkProjectIds;
    try {
      ({ projectIds: bulkProjectIds } = await validateInviteScopes(orgId, [], requestedProjectIds));
    } catch (error) {
      return jsonResponse(res, { error: error.message }, error.status || 400);
    }

    const FRONTEND_BASE = resolvePublicFrontendBaseUrl();
    const inviter = await prisma.user.findUnique({
      where: { id: current.session.userId },
      select: { email: true, displayName: true },
    }).catch(() => null);
    const inviterName = inviter?.displayName || inviter?.email || 'your admin';
    const orgName = membership.org.name || 'your team';
    const expiresAt = new Date(Date.now() + WORKSPACE_INVITATION_TTL_MS);
    const expiresOn = expiresAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    const results = [];
    for (const email of emails) {
      try {
        // Skip people already in the org — the invite would be a no-op.
        const existingUser = await prisma.user.findFirst({
          where: { email: { equals: email, mode: 'insensitive' } }, select: { id: true },
        }).catch(() => null);
        if (existingUser) {
          const already = await prisma.userOrganization.findUnique({
            where: { userId_orgId: { userId: existingUser.id, orgId } }, select: { userId: true },
          }).catch(() => null);
          if (already) {
            results.push({ email, status: 'already_member' });
            continue;
          }
        }
        const token = crypto.randomBytes(24).toString('hex');
        const invite = await createOrgInviteWithinPlan({
          orgId, email, role: bulkRole, roles: bulkRoles,
          teamIds: [], projectIds: bulkProjectIds, token, expiresAt,
          createdBy: current.session.userId,
          // Delivery is accounted for only after the recipient provider has
          // accepted the message. A created invite is not necessarily sent.
          sendCount: 0,
        });
        const joinUrl = `${FRONTEND_BASE}/hivemind/join/${membership.org.slug}/${invite.token}`;
        queueWorkspaceInvitationDelivery({
          invite,
          orgId,
          actorId: current.session.userId,
          adminEmail: inviter?.email,
          vars: { orgName, inviterName, joinUrl, expiresOn },
          requestMeta: _reqMeta(req),
        });
        results.push({ email, status: 'invited', invite_id: invite.id, join_url: joinUrl, email_dispatch: { attempted: true, pending: true } });
        audit({
          organizationId: orgId, userId: current.session.userId,
          eventType: 'org.invite_created', eventCategory: 'org', action: 'create',
          resourceType: 'org_invite', resourceId: invite.id,
          newValue: { email, role: bulkRole, bulk: true },
          ..._reqMeta(req),
        });
      } catch (rowErr) {
        results.push({ email, status: 'failed', error: rowErr.message });
      }
    }
    const created = results.filter((r) => r.status === 'invited').length;
    const queued = results.filter((r) => r.email_dispatch?.pending).length;
    return jsonResponse(res, { ok: true, total: emails.length, invited: created, email_queued: queued, results }, 201);
  }

  const inviteCollectionMatch = pathname.match(/^\/v1\/orgs\/([^/]+)\/invites$/);
  if (inviteCollectionMatch && req.method === 'POST') {
    const current = await requireSession(req, res);
    if (!current) return;
    const orgId = inviteCollectionMatch[1];
    const membership = await requireOrgAdmin(req, res, current.session.userId, orgId);
    if (!membership) return;

    const body = await parseBody(req);
    // Support both legacy `role` and new `roles[]`
    let inviteRoles = [];
    if (Array.isArray(body.roles) && body.roles.length > 0) {
      const invalid = body.roles.filter(r => !ROLES.has(r));
      if (invalid.length > 0) {
        return jsonResponse(res, { error: `Invalid roles: ${invalid.join(', ')}` }, 400);
      }
      inviteRoles = body.roles;
    } else {
      const legacyRole = typeof body.role === 'string' && body.role.trim() ? body.role.trim().toLowerCase() : 'member';
      if (!['member', 'viewer', 'developer', 'admin', 'org_admin', 'team_lead', 'compliance_admin'].includes(legacyRole)) {
        return jsonResponse(res, { error: 'invalid role' }, 400);
      }
      // Map legacy to new role name if needed
      const legacyMap = { admin: 'org_admin', owner: 'org_owner', developer: 'member' };
      inviteRoles = [legacyMap[legacyRole] || legacyRole];
    }

    if (inviteRoles.includes('org_owner') && !membership._roles.includes('org_owner')) {
      return jsonResponse(res, { error: 'Only an organization owner can invite another owner' }, 403);
    }

    // team_ids / project_ids — optional arrays of UUIDs to auto-join on accept.
    const requestedTeamIds = Array.isArray(body.team_ids) ? body.team_ids.filter(id => typeof id === 'string') : [];
    const requestedProjectIds = Array.isArray(body.project_ids) ? body.project_ids.filter(id => typeof id === 'string') : [];
    let teamIds; let projectIds;
    try {
      ({ teamIds, projectIds } = await validateInviteScopes(orgId, requestedTeamIds, requestedProjectIds));
    } catch (error) {
      return jsonResponse(res, { error: error.message }, error.status || 400);
    }

    const token = crypto.randomBytes(24).toString('hex');
    const legacyRoleReverse = inviteRoles.includes('org_owner') ? 'owner'
      : inviteRoles.includes('org_admin') ? 'admin'
      : inviteRoles[0] || 'member';

    const inviteEmail = typeof body.email === 'string' && body.email.trim() ? body.email.trim().toLowerCase() : null;
    const expiresAt   = new Date(Date.now() + WORKSPACE_INVITATION_TTL_MS);
    const idempotencyKey = typeof req.headers['idempotency-key'] === 'string'
      ? req.headers['idempotency-key'].trim().slice(0, 200)
      : null;
    let invite = idempotencyKey
      ? await prisma.orgInvite.findFirst({ where: { orgId, createdBy: current.session.userId, idempotencyKey } })
      : null;
    let reusedInvite = Boolean(invite);
    if (!invite) {
      try {
        invite = await createOrgInviteWithinPlan({
          orgId,
          email: inviteEmail,
          role: legacyRoleReverse,
          roles: inviteRoles,
          teamIds,
          projectIds,
          token,
          expiresAt,
          createdBy: current.session.userId,
          idempotencyKey,
          // Do not make the list claim delivery before the provider confirms it.
          sendCount: 0,
        });
      } catch (err) {
        if (err instanceof PlanCapacityError) return capacityErrorResponse(res, err);
        // Parallel clicks with the same idempotency key race at the database
        // boundary. Resolve the winner instead of returning a false failure.
        if (idempotencyKey && err?.code === 'P2002') {
          invite = await prisma.orgInvite.findFirst({ where: { orgId, createdBy: current.session.userId, idempotencyKey } });
          reusedInvite = Boolean(invite);
        }
        if (!invite) throw err;
      }
    }

    // Build the FE-facing join URL. Use HIVEMIND_FRONTEND_URL when set so the
    // recipient lands on the React app, not the control-plane API host.
    const FRONTEND_BASE = resolvePublicFrontendBaseUrl();
    const joinUrl = `${FRONTEND_BASE}/hivemind/join/${membership.org.slug}/${invite.token}`;

    // Queue Cloudflare delivery after the durable invitation exists. The admin
    // gets an immediate, idempotent response; the result is reconciled into
    // last_sent_at/send_count once the provider accepts the recipient mail.
    let emailReport = { attempted: false, pending: false };
    if (inviteEmail && !reusedInvite) {
      const inviter = await prisma.user.findUnique({
        where: { id: current.session.userId },
        select: { email: true, displayName: true },
      }).catch(() => null);
      queueWorkspaceInvitationDelivery({
        invite,
        orgId,
        actorId: current.session.userId,
        adminEmail: inviter?.email,
        vars: {
          orgName: membership.org.name || 'your team',
          inviterName: inviter?.displayName || inviter?.email || 'your admin',
          joinUrl,
          expiresOn: expiresAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
        },
        requestMeta: _reqMeta(req),
      });
      emailReport = { attempted: true, pending: true };
    }

    // Invitee status — tell the admin UP FRONT how this person will join:
    //   already_member        → they're in this org already (invite is a no-op)
    //   external_existing_user→ they belong to OTHER org(s); a project-scoped
    //                           invite makes them a GUEST here (only those
    //                           projects, no org-wide memories)
    //   new_user              → fresh signup on accept
    let inviteeStatus = 'new_user';
    let inviteeJoinsAs = projectIds.length > 0 && legacyRoleReverse === 'member' ? 'guest' : legacyRoleReverse;
    if (inviteEmail) {
      try {
        const existingUser = await prisma.user.findFirst({
          where: { email: { equals: inviteEmail, mode: 'insensitive' } },
          select: { id: true },
        });
        if (existingUser) {
          const memberships = await prisma.userOrganization.findMany({
            where: { userId: existingUser.id, isActive: true },
            select: { orgId: true },
          });
          if (memberships.some((m) => m.orgId === orgId)) inviteeStatus = 'already_member';
          else if (memberships.length > 0) inviteeStatus = 'external_existing_user';
          else inviteeStatus = 'existing_user_no_org';
        }
      } catch { /* best-effort — default new_user */ }
    }

    if (!reusedInvite) {
      audit({
        organizationId: orgId,
        userId: current.session.userId,
        eventType: 'invite.created',
        eventCategory: 'auth',
        action: 'create',
        resourceType: 'org_invite',
        resourceId: invite.id,
        newValue: { email: invite.email, roles: invite.roles, team_ids: invite.teamIds, project_ids: invite.projectIds },
        ..._reqMeta(req),
      });
      await createWorkspaceNotification(prisma, {
        orgId, userId: current.session.userId, type: 'invite.created',
        title: `Invitation created${inviteEmail ? ` for ${inviteEmail}` : ''}`,
        body: 'The invitation is pending acceptance.', resourceType: 'org_invite', resourceId: invite.id,
        dedupeKey: `invite-created:${invite.id}`,
      }).catch(() => null);
    }
    return jsonResponse(res, {
      success: true,
      idempotent_replay: reusedInvite,
      invite: {
        id: invite.id,
        email: invite.email,
        role: invite.role,
        roles: invite.roles,
        team_ids: invite.teamIds,
        project_ids: invite.projectIds,
        token: invite.token,
        expires_at: invite.expiresAt,
        created_at: invite.createdAt,
        join_url: joinUrl,
        email_dispatch: emailReport,
        invitee_status: inviteeStatus,
        joins_as: inviteeJoinsAs,
      },
    }, 201);
  }

  if (inviteCollectionMatch && req.method === 'GET') {
    const current = await requireSession(req, res);
    if (!current) return;
    const orgId = inviteCollectionMatch[1];
    const membership = await requireOrgAdmin(req, res, current.session.userId, orgId);
    if (!membership) return;

    // Query: ?status=all|pending|accepted|expired|revoked  (default all)
    //        &project_id=<uuid>  (filter to invites that grant this project)
    const status = (url.searchParams.get('status') || 'all').toLowerCase();
    const projectFilter = url.searchParams.get('project_id');
    const now = new Date();
    const where = { orgId };
    if (status === 'pending') {
      where.usedAt = null;
      where.revokedAt = null;
      where.expiresAt = { gt: now };
    } else if (status === 'accepted') {
      where.usedAt = { not: null };
    } else if (status === 'expired') {
      where.usedAt = null;
      where.revokedAt = null;
      where.expiresAt = { lte: now };
    } else if (status === 'revoked') {
      where.revokedAt = { not: null };
    }
    if (projectFilter) where.projectIds = { has: projectFilter };

    const rows = await prisma.orgInvite.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    const projectIdSet = new Set();
    const teamIdSet    = new Set();
    const userIdSet    = new Set();
    for (const inv of rows) {
      (inv.projectIds || []).forEach(id => projectIdSet.add(id));
      (inv.teamIds    || []).forEach(id => teamIdSet.add(id));
      if (inv.createdBy) userIdSet.add(inv.createdBy);
      if (inv.usedBy)    userIdSet.add(inv.usedBy);
    }
    const [projRows, teamRows, userRows] = await Promise.all([
      projectIdSet.size
        ? prisma.project.findMany({ where: { id: { in: [...projectIdSet] } }, select: { id: true, name: true, slug: true } })
        : Promise.resolve([]),
      teamIdSet.size
        ? prisma.team.findMany({ where: { id: { in: [...teamIdSet] } }, select: { id: true, name: true } }).catch(() => [])
        : Promise.resolve([]),
      userIdSet.size
        ? prisma.user.findMany({ where: { id: { in: [...userIdSet] } }, select: { id: true, email: true, displayName: true } }).catch(() => [])
        : Promise.resolve([]),
    ]);
    const projById = Object.fromEntries(projRows.map(p => [p.id, p]));
    const teamById = Object.fromEntries(teamRows.map(t => [t.id, t]));
    const userById = Object.fromEntries(userRows.map(u => [u.id, u]));

    const FRONTEND_BASE = resolvePublicFrontendBaseUrl();

    return jsonResponse(res, {
      invites: rows.map((invite) => {
        let derivedStatus = 'pending';
        if (invite.usedAt) derivedStatus = 'accepted';
        else if (invite.revokedAt) derivedStatus = 'revoked';
        else if (invite.expiresAt && invite.expiresAt < now) derivedStatus = 'expired';

        const fullUrl = `${FRONTEND_BASE}/hivemind/join/${membership.org.slug}/${invite.token}`;
        return {
          id: invite.id,
          email: invite.email,
          role: invite.role,
          roles: invite.roles,
          token: invite.token,
          status: derivedStatus,
          expires_at: invite.expiresAt,
          created_at: invite.createdAt,
          used_at: invite.usedAt,
          revoked_at: invite.revokedAt,
          last_sent_at: invite.lastSentAt,
          send_count: invite.sendCount,
          team_ids: invite.teamIds,
          project_ids: invite.projectIds,
          projects: (invite.projectIds || []).map(id => projById[id]).filter(Boolean),
          teams:    (invite.teamIds    || []).map(id => teamById[id]).filter(Boolean),
          inviter:  invite.createdBy ? userById[invite.createdBy] || null : null,
          accepted_by: invite.usedBy ? userById[invite.usedBy] || null : null,
          join_url: fullUrl,
        };
      }),
    });
  }

  const inviteDetailMatch = pathname.match(/^\/v1\/orgs\/([^/]+)\/invites\/([^/]+)$/);
  if (inviteDetailMatch && req.method === 'DELETE') {
    const current = await requireSession(req, res);
    if (!current) return;
    const orgId = inviteDetailMatch[1];
    const inviteId = inviteDetailMatch[2];
    const membership = await requireOrgAdmin(req, res, current.session.userId, orgId);
    if (!membership) return;

    const invite = await prisma.orgInvite.findFirst({ where: { id: inviteId, orgId } });
    if (!invite)           return jsonResponse(res, { error: 'Invite not found' }, 404);
    if (invite.usedAt)     return jsonResponse(res, { error: 'Invite already accepted — cannot revoke' }, 409);

    // Soft-revoke so the row stays for audit + status list.
    const updated = await prisma.orgInvite.update({
      where: { id: inviteId },
      data: { revokedAt: new Date(), revokedBy: current.session.userId },
    });

    return jsonResponse(res, { success: true, invite_id: inviteId, invite: updated });
  }

  // POST /v1/orgs/:orgId/invites/:id/resend — re-send email + bump expiry.
  const inviteResendMatch = pathname.match(/^\/v1\/orgs\/([^/]+)\/invites\/([^/]+)\/resend$/);
  if (inviteResendMatch && req.method === 'POST') {
    const current = await requireSession(req, res);
    if (!current) return;
    const orgId = inviteResendMatch[1];
    const inviteId = inviteResendMatch[2];
    const membership = await requireOrgAdmin(req, res, current.session.userId, orgId);
    if (!membership) return;

    const invite = await prisma.orgInvite.findFirst({ where: { id: inviteId, orgId } });
    if (!invite)        return jsonResponse(res, { error: 'Invite not found' }, 404);
    if (invite.usedAt)  return jsonResponse(res, { error: 'Invite already accepted' }, 409);
    if (invite.revokedAt) return jsonResponse(res, { error: 'Invite was revoked' }, 409);
    if (!invite.email)  return jsonResponse(res, { error: 'Link-only invite — no email to resend. Share the link instead.' }, 400);

    const newExpiresAt = new Date(Math.max(
      invite.expiresAt?.getTime?.() || 0,
      Date.now() + WORKSPACE_INVITATION_TTL_MS,
    ));

    const FRONTEND_BASE = resolvePublicFrontendBaseUrl();
    const joinUrl = `${FRONTEND_BASE}/hivemind/join/${membership.org.slug}/${invite.token}`;

    const inviter = await prisma.user.findUnique({
      where: { id: current.session.userId },
      select: { email: true, displayName: true },
    });
    queueWorkspaceInvitationDelivery({
      invite,
      orgId,
      actorId: current.session.userId,
      adminEmail: inviter?.email,
      expiresAt: newExpiresAt,
      vars: {
        orgName: membership.org.name || 'your team',
        inviterName: inviter?.displayName || inviter?.email || 'your admin',
        joinUrl,
        expiresOn: newExpiresAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      },
      requestMeta: _reqMeta(req),
    });
    const dispatch = { attempted: true, pending: true };

    return jsonResponse(res, {
      success: true,
      invite: {
        id: invite.id,
        email: invite.email,
        expires_at: invite.expiresAt,
        last_sent_at: invite.lastSentAt,
        send_count: invite.sendCount,
        join_url: joinUrl,
      },
      email_dispatch: dispatch,
    });
  }

  const joinMatch = pathname.match(/^\/v1\/join\/([^/]+)$/);

  // GET /v1/join/:token — preview invite (does NOT accept). Used by the
  // consent screen so the recipient sees org + project metadata before
  // clicking Accept.
  if (joinMatch && req.method === 'GET') {
    const token = joinMatch[1];
    const invite = await prisma.orgInvite.findUnique({
      where: { token },
      include: { org: true },
    });
    if (!invite) return jsonResponse(res, { error: 'Invite not found' }, 404);

    const now = new Date();
    let status = 'pending';
    if (invite.usedAt) status = 'accepted';
    else if (invite.revokedAt) status = 'revoked';
    else if (invite.expiresAt < now) status = 'expired';

    let projectIds = Array.isArray(invite.projectIds) ? invite.projectIds : [];
    let validatedTeamIds = Array.isArray(invite.teamIds) ? invite.teamIds : [];
    try {
      ({ teamIds: validatedTeamIds, projectIds } = await validateInviteScopes(
        invite.orgId,
        validatedTeamIds,
        projectIds,
      ));
    } catch {
      return jsonResponse(res, { error: 'Invite scope is no longer valid' }, 410);
    }
    const teamIds = validatedTeamIds;

    const [projects, teams, inviter] = await Promise.all([
      projectIds.length
        ? prisma.project.findMany({
            where: { id: { in: projectIds }, orgId: invite.orgId },
            select: { id: true, name: true, slug: true, description: true },
          }).catch(() => [])
        : Promise.resolve([]),
      teamIds.length
        ? prisma.team.findMany({
            where: { id: { in: teamIds }, orgId: invite.orgId },
            select: { id: true, name: true },
          }).catch(() => [])
        : Promise.resolve([]),
      invite.createdBy
        ? prisma.user.findUnique({
            where: { id: invite.createdBy },
            select: { email: true, displayName: true },
          }).catch(() => null)
        : Promise.resolve(null),
    ]);

    return jsonResponse(res, {
      token,
      status,
      email: invite.email,
      role: invite.role,
      roles: invite.roles,
      expires_at: invite.expiresAt,
      organization: invite.org ? {
        id: invite.org.id,
        name: invite.org.name,
        slug: invite.org.slug,
      } : null,
      projects,
      teams,
      inviter,
    });
  }

  // POST /v1/join/:token/decline — recipient declines an invite (soft-revoke).
  const declineMatch = pathname.match(/^\/v1\/join\/([^/]+)\/decline$/);
  if (declineMatch && req.method === 'POST') {
    const token = declineMatch[1];
    const invite = await prisma.orgInvite.findUnique({ where: { token } });
    if (!invite)          return jsonResponse(res, { error: 'Invite not found' }, 404);
    if (invite.usedAt)    return jsonResponse(res, { error: 'Invite already accepted' }, 409);
    if (invite.revokedAt) return jsonResponse(res, { success: true, already_declined: true });

    await prisma.orgInvite.update({
      where: { id: invite.id },
      data: { revokedAt: new Date() },
    });
    return jsonResponse(res, { success: true });
  }

  if (joinMatch && req.method === 'POST') {
    const current = await requireSession(req, res);
    if (!current) return;
    const token = joinMatch[1];

    const invite = await prisma.orgInvite.findUnique({
      where: { token },
      include: { org: true },
    });

    if (!invite) {
      return jsonResponse(res, { error: 'Invite not found' }, 404);
    }
    // Already-used invite: treat re-visit by the SAME user (or any user
    // already in the org) as success, not a 404 — they're already in.
    if (invite.usedAt) {
      const existing = await prisma.userOrganization.findFirst({
        where: { userId: current.session.userId, orgId: invite.orgId, isActive: true },
      });
      if (existing) {
        return jsonResponse(res, {
          success: true,
          already_member: true,
          organization: invite.org ? { id: invite.org.id, name: invite.org.name, slug: invite.org.slug } : null,
          roles: existing.roles,
        });
      }
      return jsonResponse(res, { error: 'Invite already used' }, 410);
    }
    if (invite.expiresAt.getTime() < Date.now()) {
      return jsonResponse(res, { error: 'Invite expired' }, 410);
    }
    if (invite.email && invite.email !== (current.session.email || '').toLowerCase()) {
      return jsonResponse(res, { error: 'Invite email does not match current account' }, 403);
    }

    // Hierarchy semantics: an invite scoped to specific PROJECT(s) with the
    // default 'member' role makes the invitee an org GUEST — they belong to
    // those projects only, never the whole org (no org-wide memories, no other
    // projects, no default-team flood). Explicit elevated roles (admin/owner)
    // on the invite are honored as before.
    let projectIds = Array.isArray(invite.projectIds) ? invite.projectIds : [];
    let validatedTeamIds = Array.isArray(invite.teamIds) ? invite.teamIds : [];
    try {
      ({ teamIds: validatedTeamIds, projectIds } = await validateInviteScopes(
        invite.orgId,
        validatedTeamIds,
        projectIds,
      ));
    } catch {
      return jsonResponse(res, { error: 'Invite scope is no longer valid' }, 410);
    }
    const isProjectScopedInvite = projectIds.length > 0
      && (!invite.role || invite.role === 'member' || invite.role === 'guest');
    const effectiveRole = isProjectScopedInvite ? 'guest' : (invite.role || 'member');
    const inviteRoles = isProjectScopedInvite
      ? ['guest']
      : (Array.isArray(invite.roles) && invite.roles.length > 0 ? invite.roles : [effectiveRole]);

    try {
      await claimInviteSeatWithinPlan({
        inviteId: invite.id,
        orgId: invite.orgId,
        userId: current.session.userId,
        role: effectiveRole,
        roles: inviteRoles,
        invitedAt: invite.createdAt,
      });
    } catch (error) {
      if (error?.code === 'PLAN_LIMIT') return capacityErrorResponse(res, error);
      if (error?.code === 'INVITE_USED') return jsonResponse(res, { error: error.message }, 410);
      throw error;
    }

    // Auto-add to invited teams — never for guests (team membership grants
    // visibility of every team project, which defeats project scoping).
    const teamIds = isProjectScopedInvite ? [] : validatedTeamIds;
    if (teamIds.length > 0) {
      for (const teamId of teamIds) {
        await prisma.teamMember.upsert({
          where: { teamId_userId: { teamId, userId: current.session.userId } },
          update: {},
          create: { teamId, userId: current.session.userId, role: 'member', addedById: invite.createdBy },
        }).catch(() => null); // silently skip if team doesn't exist
      }
    }

    // Auto-add to invited projects (project_ids was previously silently dropped here)
    if (projectIds.length > 0) {
      for (const projectId of projectIds) {
        // ProjectMember has composite PK (projectId, userId) — no `id` column.
        // 'contributor' is the valid PROJECT_ROLES grant ('member' is not a
        // project role and broke role-gated checks downstream).
        await prisma.projectMember.upsert({
          where: { projectId_userId: { projectId, userId: current.session.userId } },
          update: {},
          create: {
            projectId,
            userId: current.session.userId,
            role: 'contributor',
            addedById: invite.createdBy,
          },
        }).catch(() => null);
      }
    }

    audit({
      organizationId: invite.orgId,
      userId: current.session.userId,
      eventType: 'invite.accepted',
      eventCategory: 'auth',
      action: 'create',
      resourceType: 'user',
      resourceId: current.session.userId,
      newValue: { roles: inviteRoles, team_ids: teamIds },
      ..._reqMeta(req),
    });
    await createWorkspaceNotification(prisma, {
      orgId: invite.orgId,
      userId: current.session.userId,
      type: 'invite.accepted',
      title: `Welcome to ${invite.org?.name || 'the workspace'}`,
      body: isProjectScopedInvite ? 'Your project access is ready.' : 'Your workspace access is ready.',
      resourceType: 'org_invite', resourceId: invite.id,
      dedupeKey: `invite-accepted:${invite.id}`,
    }).catch(() => null);

    await sessionStore.destroySession(current.sessionId);
    const sessionId = await sessionStore.createSession({
      ...current.session,
      orgId: invite.orgId,
    });

    return jsonResponse(res, {
      success: true,
      organization: {
        id: invite.org.id,
        name: invite.org.name,
        slug: invite.org.slug,
        plan: invite.org.plan || 'free',
      },
    }, 200, {
      'Set-Cookie': makeSessionCookie(sessionId),
    });
  }

  const membersMatch = pathname.match(/^\/v1\/orgs\/([^/]+)\/members$/);
  if (membersMatch && req.method === 'GET') {
    const current = await requireSession(req, res);
    if (!current) return;
    const orgId = membersMatch[1];
    const membership = await getOrgMembership(current.session.userId, orgId);
    if (!membership) {
      return jsonResponse(res, { error: 'Organization membership not found' }, 404);
    }
    // Require user:read permission to list members (org_admin, compliance_admin, team_lead)
    const callerRoles = effectiveRoles(membership);
    if (!hasPermission(callerRoles, 'user', 'read')) {
      return jsonResponse(res, { error: 'Forbidden' }, 403);
    }

    const members = await prisma.userOrganization.findMany({
      where: { orgId },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            displayName: true,
            avatarUrl: true,
            lastActiveAt: true,
          },
        },
      },
      orderBy: [
        { role: 'asc' },
        { joinedAt: 'asc' },
      ],
    });

    // Multi-org awareness: mark members who ALSO belong to other organizations
    // (typical for project guests invited from a partner org). Boolean + count
    // only — foreign org names are never leaked to this org's admins.
    const memberIds = members.map((m) => m.userId);
    const externalCounts = memberIds.length
      ? await prisma.userOrganization.groupBy({
          by: ['userId'],
          where: { userId: { in: memberIds }, isActive: true, NOT: { orgId } },
          _count: { _all: true },
        }).catch(() => [])
      : [];
    const externalById = Object.fromEntries(externalCounts.map((r) => [r.userId, r._count._all]));

    return jsonResponse(res, {
      members: members.map((entry) => ({
        user_id: entry.userId,
        role: entry.role,
        roles: entry.roles && entry.roles.length ? entry.roles : effectiveRoles(entry),
        is_active: entry.isActive ?? true,
        deactivated_at: entry.deactivatedAt ?? null,
        invited_at: entry.invitedAt,
        joined_at: entry.joinedAt,
        email: entry.user?.email || null,
        display_name: entry.user?.displayName || null,
        avatar_url: entry.user?.avatarUrl || null,
        last_active_at: entry.user?.lastActiveAt || null,
        is_external: (externalById[entry.userId] || 0) > 0,
        other_org_count: externalById[entry.userId] || 0,
      })),
    });
  }

  const projectsMatch = pathname.match(/^\/v1\/orgs\/([^/]+)\/projects$/);
  if (projectsMatch && req.method === 'GET') {
    const current = await requireSession(req, res);
    if (!current) return;
    const orgId = projectsMatch[1];
    const membership = await getOrgMembership(current.session.userId, orgId);
    if (!membership) {
      return jsonResponse(res, { error: 'Organization membership not found' }, 404);
    }
    // Role + policy aware: was an unfiltered findMany that listed EVERY org
    // project to ANY member — including guests and other members' private
    // projects. Now routes through the same visibility engine as /v1/projects.
    const ts2 = await _getTeamStore();
    if (!ts2) return jsonResponse(res, { error: 'Database unavailable' }, 503);
    let projects = await ts2.store.listProjectsForUser({
      userId: current.session.userId,
      orgId,
      orgRole: membership.role || null,
    });
    // TARA-MEMORY is a reserved, system-managed project (call transcripts live
    // there, surfaced only on the TARA Memory page) — hide it from the
    // Workspace Admin projects list.
    projects = projects.filter((p) => p.slug !== 'tara-memory' && p.name !== 'TARA-MEMORY');

    // The card "N memories" must reconcile with the Memories page + graph.
    // project._count.memories is the RAW join (also counts superseded/deleted/
    // governance rows). Recount with the canonical visible filter. NOTE:
    // distilled KB facts (extracted-fact) ARE first-class memories now and are
    // COUNTED everywhere — only genuine noise stays hidden.
    const HIDDEN_TAGS = ['internal-audit', 'governance', 'reflection'];
    const visibleCounts = prisma
      ? await Promise.all(projects.map((p) => prisma.memory.count({
          where: {
            orgId,
            isLatest: true,
            deletedAt: null,
            OR: [
              { projectId: p.id },
              { memoryProjects: { some: { projectId: p.id } } },
            ],
            AND: [
              { OR: [
                { cognitiveLayerRole: { in: ['canonical', 'bridge', 'principle'] } },
                { NOT: { tags: { hasSome: HIDDEN_TAGS } } },
              ] },
            ],
          },
        }).catch(() => null)))
      : projects.map(() => null);

    return jsonResponse(res, {
      projects: projects.map((project, i) => ({
        id: project.id,
        org_id: project.orgId,
        name: project.name,
        slug: project.slug,
        description: project.description,
        policy: project.policy,
        member_count: project._count?.members ?? 0,
        memory_count: visibleCounts[i] ?? project._count?.memories ?? 0,
        memory_count_raw: project._count?.memories ?? 0, // raw join incl KB children (debug/insight)
        created_by: project.createdBy,
        created_at: project.createdAt,
        updated_at: project.updatedAt,
      })),
    });
  }

  if (projectsMatch && req.method === 'POST') {
    const current = await requireSession(req, res);
    if (!current) return;
    const orgId = projectsMatch[1];
    const membership = await requireOrgAdmin(req, res, current.session.userId, orgId);
    if (!membership) return;
    const { plan: effectivePlan } = await getEffectivePlan(prisma, orgId);
    const projectLimit = effectivePlan.limits?.maxProjects ?? -1;
    const existingProjectCount = await prisma.project.count({ where: { orgId, archivedAt: null } });
    if (projectLimit !== -1 && existingProjectCount >= projectLimit) {
      return jsonResponse(res, { error: `Project limit reached (${effectivePlan.name}: ${projectLimit})`, code: 'plan_limit_exceeded', reason: 'PLAN_LIMIT', message: `Project limit reached (${effectivePlan.name}: ${projectLimit})`, resource: 'projects', plan: effectivePlan.id, limit: projectLimit, current: existingProjectCount, suggested_plan: (_PLAN_LIMIT_NEXT[effectivePlan.id] ?? null), upgrade_url: '/hivemind/app/billing' }, 402);
    }

    const body = await parseBody(req);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) {
      return jsonResponse(res, { error: 'name is required' }, 400);
    }
    const description = typeof body.description === 'string' ? body.description.trim() : '';
    if (!description) {
      return jsonResponse(res, { error: 'description is required — every project needs a short description' }, 400);
    }
    const slugBase = sanitizeSlug(body.slug || name);
    const existing = await prisma.project.findFirst({ where: { orgId, slug: slugBase } });
    const slug = existing ? `${slugBase}-${crypto.randomUUID().slice(0, 6)}` : slugBase;

    const project = await prisma.project.create({
      data: {
        orgId,
        name,
        slug,
        description,
        createdBy: current.session.userId,
      },
    });
    // Creator becomes a member; policy persisted via raw SQL (column postdates
    // the deployed Prisma client). Default 'private' — creator decides access.
    const projPolicy = ['private', 'team_inherited', 'org_visible'].includes(body.policy) ? body.policy : 'private';
    await prisma.projectMember.upsert({
      where: { projectId_userId: { projectId: project.id, userId: current.session.userId } },
      update: {},
      create: { projectId: project.id, userId: current.session.userId, role: 'owner', addedById: current.session.userId },
    }).catch(() => {});
    await prisma.$executeRawUnsafe(
      `UPDATE hivemind.projects SET policy = $1 WHERE id = $2::uuid`,
      projPolicy, project.id,
    ).catch(() => {});

    return jsonResponse(res, {
      success: true,
      project: {
        id: project.id,
        org_id: project.orgId,
        name: project.name,
        slug: project.slug,
        description: project.description,
        policy: projPolicy,
        created_by: project.createdBy,
        created_at: project.createdAt,
        updated_at: project.updatedAt,
      },
    }, 201);
  }

  const memberDetailMatch = pathname.match(/^\/v1\/orgs\/([^/]+)\/members\/([^/]+)$/);
  if (memberDetailMatch && req.method === 'PATCH') {
    // Legacy: PATCH /v1/orgs/:id/members/:userId — update single role (kept for compat)
    const current = await requireSession(req, res);
    if (!current) return;
    const orgId = memberDetailMatch[1];
    const targetUserId = memberDetailMatch[2];
    const membership = await requireOrgAdmin(req, res, current.session.userId, orgId);
    if (!membership) return;

    const body = await parseBody(req);
    const role = typeof body.role === 'string' ? body.role.trim().toLowerCase() : '';
    if (!['member', 'viewer', 'developer', 'admin'].includes(role)) {
      return jsonResponse(res, { error: 'invalid role' }, 400);
    }

    const targetMembership = await getOrgMembership(targetUserId, orgId);
    if (!targetMembership) {
      return jsonResponse(res, { error: 'Member not found' }, 404);
    }
    if (effectiveRoles(targetMembership).includes('org_owner')) {
      return jsonResponse(res, { error: 'Owner role cannot be changed here' }, 400);
    }

    const canonicalRole = role === 'admin' ? 'org_admin'
      : role === 'developer' ? 'member'
      : role;
    const updated = await prisma.userOrganization.update({
      where: { userId_orgId: { userId: targetUserId, orgId } },
      data: { role, roles: [canonicalRole] },
    });

    return jsonResponse(res, { success: true, member: { user_id: updated.userId, role: updated.role } });
  }

  // ─── RBAC: member role management (P0-4) ─────────────────────────────────

  // PATCH /v1/orgs/:id/members/:userId/roles — set roles[] (multi-role RBAC)
  const memberRolesMatch = pathname.match(/^\/v1\/orgs\/([^/]+)\/members\/([^/]+)\/roles$/);
  if (memberRolesMatch && req.method === 'PATCH') {
    const current = await requireSession(req, res);
    if (!current) return;
    const orgId = memberRolesMatch[1];
    const targetUserId = memberRolesMatch[2];
    const callerMembership = await requireOrgAdmin(req, res, current.session.userId, orgId);
    if (!callerMembership) return;

    const body = await parseBody(req);
    const newRoles = Array.isArray(body.roles) ? body.roles : [];

    // Validate: all entries must be known roles
    const invalidRoles = newRoles.filter(r => !ROLES.has(r));
    if (newRoles.length === 0 || invalidRoles.length > 0) {
      return jsonResponse(res, {
        error: `Invalid roles: ${invalidRoles.join(', ') || 'roles[] must be non-empty'}. Allowed: ${[...ROLES].join(', ')}`,
      }, 400);
    }

    const targetMembership = await getOrgMembership(targetUserId, orgId);
    if (!targetMembership) {
      return jsonResponse(res, { error: 'Member not found' }, 404);
    }

    // Last org_owner protection: block demotion if this would drop owner count to 0
    if (!newRoles.includes('org_owner')) {
      const targetCurrentRoles = effectiveRoles(targetMembership);
      if (targetCurrentRoles.includes('org_owner')) {
        const ownerCount = await prisma.userOrganization.count({
          where: {
            orgId,
            roles: { has: 'org_owner' },
          },
        });
        const legacyOwnerCount = ownerCount === 0
          ? await prisma.userOrganization.count({ where: { orgId, role: 'owner' } })
          : 0;
        const totalOwners = ownerCount + legacyOwnerCount;
        if (totalOwners <= 1) {
          return jsonResponse(res, { error: 'Cannot remove the last org_owner' }, 400);
        }
      }
    }

    // Prevent self-demotion below org_owner if caller is the only owner
    if (targetUserId === current.session.userId && !newRoles.includes('org_owner')) {
      const callerRoles = effectiveRoles(callerMembership);
      if (callerRoles.includes('org_owner')) {
        const ownerCount = await prisma.userOrganization.count({
          where: { orgId, roles: { has: 'org_owner' } },
        });
        if (ownerCount <= 1) {
          return jsonResponse(res, { error: 'Cannot self-demote: you are the last org_owner' }, 400);
        }
      }
    }

    const oldRoles = effectiveRoles(targetMembership);
    const updated = await prisma.userOrganization.update({
      where: { userId_orgId: { userId: targetUserId, orgId } },
      data: { roles: newRoles },
    });

    audit({
      organizationId: orgId,
      userId: current.session.userId,
      eventType: 'rbac.role_changed',
      eventCategory: 'data_modification',
      action: 'update',
      resourceType: 'user',
      resourceId: targetUserId,
      oldValue: { roles: oldRoles },
      newValue: { roles: newRoles },
      ..._reqMeta(req),
    });

    return jsonResponse(res, {
      success: true,
      member: { user_id: updated.userId, roles: updated.roles },
    });
  }

  // POST /v1/orgs/:id/members/:userId/deactivate
  const memberDeactivateMatch = pathname.match(/^\/v1\/orgs\/([^/]+)\/members\/([^/]+)\/deactivate$/);
  if (memberDeactivateMatch && req.method === 'POST') {
    const current = await requireSession(req, res);
    if (!current) return;
    const orgId = memberDeactivateMatch[1];
    const targetUserId = memberDeactivateMatch[2];
    const callerMembership = await requireOrgAdmin(req, res, current.session.userId, orgId);
    if (!callerMembership) return;

    if (targetUserId === current.session.userId) {
      return jsonResponse(res, { error: 'Cannot deactivate yourself' }, 400);
    }

    const targetMembership = await getOrgMembership(targetUserId, orgId);
    if (!targetMembership) {
      return jsonResponse(res, { error: 'Member not found' }, 404);
    }

    const now = new Date();
    await prisma.userOrganization.update({
      where: { userId_orgId: { userId: targetUserId, orgId } },
      data: { isActive: false, deactivatedAt: now },
    });

    // Revoke API keys for this user
    await prisma.apiKey.updateMany({
      where: { userId: targetUserId, revokedAt: null },
      data: { revokedAt: now },
    });

    // Delete sessions for this user
    await prisma.session.deleteMany({ where: { userId: targetUserId } }).catch(() => null);

    audit({
      organizationId: orgId,
      userId: current.session.userId,
      eventType: 'user.deactivated',
      eventCategory: 'data_modification',
      action: 'update',
      resourceType: 'user',
      resourceId: targetUserId,
      newValue: { is_active: false, deactivated_at: now.toISOString() },
      ..._reqMeta(req),
    });

    return jsonResponse(res, { success: true, user_id: targetUserId, deactivated_at: now.toISOString() });
  }

  // POST /v1/orgs/:id/members/:userId/reactivate
  const memberReactivateMatch = pathname.match(/^\/v1\/orgs\/([^/]+)\/members\/([^/]+)\/reactivate$/);
  if (memberReactivateMatch && req.method === 'POST') {
    const current = await requireSession(req, res);
    if (!current) return;
    const orgId = memberReactivateMatch[1];
    const targetUserId = memberReactivateMatch[2];
    const callerMembership = await requireOrgAdmin(req, res, current.session.userId, orgId);
    if (!callerMembership) return;

    const targetMembership = await getOrgMembership(targetUserId, orgId);
    if (!targetMembership) {
      return jsonResponse(res, { error: 'Member not found' }, 404);
    }

    await prisma.userOrganization.update({
      where: { userId_orgId: { userId: targetUserId, orgId } },
      data: { isActive: true, deactivatedAt: null },
    });

    audit({
      organizationId: orgId,
      userId: current.session.userId,
      eventType: 'user.reactivated',
      eventCategory: 'data_modification',
      action: 'update',
      resourceType: 'user',
      resourceId: targetUserId,
      newValue: { is_active: true },
      ..._reqMeta(req),
    });

    return jsonResponse(res, { success: true, user_id: targetUserId });
  }

  const projectDetailMatch = pathname.match(/^\/v1\/orgs\/([^/]+)\/projects\/([^/]+)$/);
  if (projectDetailMatch && req.method === 'PATCH') {
    const current = await requireSession(req, res);
    if (!current) return;
    const orgId = projectDetailMatch[1];
    const projectId = projectDetailMatch[2];
    const membership = await requireOrgAdmin(req, res, current.session.userId, orgId);
    if (!membership) return;
    if (membership.org?.plan !== 'enterprise') {
      return jsonResponse(res, { error: 'Projects require an enterprise workspace' }, 403);
    }

    const body = await parseBody(req);
    const updateData = {};
    if (typeof body.name === 'string' && body.name.trim()) {
      updateData.name = body.name.trim();
    }
    if (typeof body.description === 'string') {
      updateData.description = body.description.trim() || null;
    }
    if (typeof body.slug === 'string' && body.slug.trim()) {
      const slugBase = sanitizeSlug(body.slug);
      const conflict = await prisma.project.findFirst({
        where: {
          orgId,
          slug: slugBase,
          id: { not: projectId },
        },
      });
      updateData.slug = conflict ? `${slugBase}-${crypto.randomUUID().slice(0, 6)}` : slugBase;
    }

    if (!Object.keys(updateData).length) {
      return jsonResponse(res, { error: 'No valid fields to update' }, 400);
    }

    const existingProject = await prisma.project.findFirst({
      where: { id: projectId, orgId },
    });
    if (!existingProject) {
      return jsonResponse(res, { error: 'Project not found' }, 404);
    }

    const project = await prisma.project.update({
      where: { id: projectId },
      data: updateData,
    });

    return jsonResponse(res, {
      success: true,
      project: {
        id: project.id,
        org_id: project.orgId,
        name: project.name,
        slug: project.slug,
        description: project.description,
        created_by: project.createdBy,
        created_at: project.createdAt,
        updated_at: project.updatedAt,
      },
    });
  }

  if (memberDetailMatch && req.method === 'DELETE') {
    const current = await requireSession(req, res);
    if (!current) return;
    const orgId = memberDetailMatch[1];
    const targetUserId = memberDetailMatch[2];
    const membership = await requireOrgAdmin(req, res, current.session.userId, orgId);
    if (!membership) return;

    const targetMembership = await getOrgMembership(targetUserId, orgId);
    if (!targetMembership) {
      return jsonResponse(res, { error: 'Member not found' }, 404);
    }
    if (targetMembership.role === 'owner') {
      return jsonResponse(res, { error: 'Owner cannot be removed' }, 400);
    }

    await prisma.userOrganization.delete({
      where: { userId_orgId: { userId: targetUserId, orgId } },
    });

    return jsonResponse(res, { success: true, user_id: targetUserId });
  }

  if (projectDetailMatch && req.method === 'DELETE') {
    const current = await requireSession(req, res);
    if (!current) return;
    const orgId = projectDetailMatch[1];
    const projectId = projectDetailMatch[2];
    const membership = await requireOrgAdmin(req, res, current.session.userId, orgId);
    if (!membership) return;
    if (membership.org?.plan !== 'enterprise') {
      return jsonResponse(res, { error: 'Projects require an enterprise workspace' }, 403);
    }

    const deleted = await prisma.project.deleteMany({
      where: { id: projectId, orgId },
    });

    if (!deleted.count) {
      return jsonResponse(res, { error: 'Project not found' }, 404);
    }

    return jsonResponse(res, { success: true, project_id: projectId });
  }

  if (pathname === '/v1/api-keys' && req.method === 'GET') {
    const current = await requireSession(req, res);
    if (!current) return;

    const orgId = current.session.orgId || null;
    const membership = orgId ? await getActiveOrganizationMembership(prisma, { userId: current.session.userId, orgId }) : null;
    const includeServiceKeys = Boolean(membership && (isOrganizationAdmin(membership) || canManageOrg(membership.role)));
    const keys = await listPersistedApiKeys(prisma, current.session.userId, orgId, { includeServiceKeys });
    return jsonResponse(res, {
      keys: keys.map(key => ({
        id: key.id,
        name: key.name,
        key_kind: key.keyKind || 'personal',
        key_prefix: key.keyPrefix,
        scopes: key.scopes,
        expires_at: key.expiresAt,
        last_used_at: key.lastUsedAt,
        created_at: key.createdAt
      }))
    });
  }

  if (pathname === '/v1/api-keys' && req.method === 'POST') {
    const current = await requireSession(req, res);
    if (!current) return;
    const body = await parseBody(req);

    const requestedKind = body.key_kind === 'service' ? 'service' : 'personal';
    const orgId = current.session.orgId || null;
    if (requestedKind === 'service') {
      if (!orgId) return jsonResponse(res, { error: 'Organization service keys require an active organization' }, 400);
      const membership = await requireOrgAdmin(req, res, current.session.userId, orgId);
      if (!membership) return;
    }
    const requestedScopes = Array.isArray(body.scopes) ? body.scopes : ['memory:read'];
    const { rawKey, record } = await createPersistedApiKey(prisma, {
      userId: current.session.userId,
      orgId,
      keyKind: requestedKind,
      createdByUserId: current.session.userId,
      name: body.name || 'Primary API Key',
      description: body.description || null,
      scopes: requestedScopes,
      expiresAt: body.expires_at ? new Date(body.expires_at) : null,
      rateLimitPerMinute: body.rate_limit_per_minute || 60,
      createdByIp: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || null,
      userAgent: req.headers['user-agent'] || null
    });

    return jsonResponse(res, {
      success: true,
      api_key: rawKey,
      key: {
        id: record.id,
        name: record.name,
        key_kind: record.keyKind,
        key_prefix: record.keyPrefix,
        scopes: record.scopes,
        created_at: record.createdAt
      },
      descriptors: buildAllClientDescriptors({
        coreApiBaseUrl: CONFIG.coreApiBaseUrl,
        userId: current.session.userId,
        apiKey: rawKey
      })
    }, 201);
  }

  if ((pathname === '/v1/account' && req.method === 'DELETE') || (pathname === '/v1/account/delete' && req.method === 'POST')) {
    console.log('[account-delete] ▶ Request received:', req.method, pathname);
    const current = await requireSession(req, res);
    if (!current) {
      console.warn('[account-delete] ✗ No valid session — requireSession rejected');
      return;
    }
    console.log('[account-delete] Session validated');

    if (!prisma) {
      console.error('[account-delete] ✗ Database unavailable (prisma is null)');
      return jsonResponse(res, { error: 'Database unavailable' }, 503);
    }

    const body = await parseBody(req);
    console.log('[account-delete] Body received:', JSON.stringify({ confirm: body.confirm, keys: Object.keys(body) }));
    if ((body.confirm || '').trim().toUpperCase() !== 'DELETE') {
      console.warn('[account-delete] ✗ Confirmation mismatch — got:', JSON.stringify(body.confirm));
      return jsonResponse(res, { error: 'Confirmation text must be DELETE' }, 400);
    }

    const user = await prisma.user.findUnique({
      where: { id: current.session.userId },
      select: { id: true, email: true },
    });
    if (!user) {
      console.warn('[account-delete] ✗ User not found in DB for userId:', current.session.userId);
      await sessionStore.destroySession(current.sessionId);
      return jsonResponse(res, { success: true }, 200, {
        'Set-Cookie': clearSessionCookie(),
      });
    }
    console.log('[account-delete] ✓ User found:', user.email, '(id:', user.id, ')');

    const deletionCheck = await validateAccountDeletion(user.id);
    console.log('[account-delete] Validation result:', JSON.stringify(deletionCheck));
    if (!deletionCheck.ok) {
      console.warn('[account-delete] ✗ Validation failed:', JSON.stringify(deletionCheck));
      return jsonResponse(res, deletionCheck, deletionCheck.status || 409);
    }

    console.log('[account-delete] ✓ Validation passed — starting deletion');

    // Check if client wants SSE streaming (Accept: text/event-stream)
    const wantsSSE = (req.headers.accept || '').includes('text/event-stream') || body.stream === true;

    if (wantsSSE) {
      // SSE streaming delete with progress
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Set-Cookie': clearSessionCookie(),
      });

      const sendEvent = (data) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      const result = await performAccountDeletion({
        userId: user.id,
        orgIdsToDelete: deletionCheck.orgIdsToDelete || [],
        onProgress: (pct, step) => {
          sendEvent({ progress: pct, step, userId: user.id });
        },
      });

      if (result.ok) {
        await sessionStore.destroySession(current.sessionId);
        sendEvent({ progress: 100, step: 'Account deleted', done: true, success: true });
      } else {
        sendEvent({ progress: -1, step: result.error, done: true, success: false, error: result.error });
      }
      res.end();
      return;
    }

    // Non-streaming: wait for completion, return final result
    const result = await performAccountDeletion({
      userId: user.id,
      orgIdsToDelete: deletionCheck.orgIdsToDelete || [],
    });

    if (!result.ok) {
      return jsonResponse(res, { error: result.error, status: 'failed' }, 500, {
      });
    }

    await sessionStore.destroySession(current.sessionId);

    return jsonResponse(res, {
      success: true,
      status: 'completed',
      deleted_user_id: user.id,
      deleted_email: user.email,
      deleted_org_ids: deletionCheck.orgIdsToDelete || [],
    }, 200, {
      'Set-Cookie': clearSessionCookie(),
    });
  }

  const revokeMatch = pathname.match(/^\/v1\/api-keys\/([^/]+)\/revoke$/);
  if (revokeMatch && req.method === 'POST') {
    const current = await requireSession(req, res);
    if (!current) return;
    const orgId = current.session.orgId || null;
    const membership = orgId ? await getActiveOrganizationMembership(prisma, { userId: current.session.userId, orgId }) : null;
    const allowServiceKey = Boolean(membership && (isOrganizationAdmin(membership) || canManageOrg(membership.role)));
    const revoked = await revokePersistedApiKey(prisma, revokeMatch[1], current.session.userId, { orgId, allowServiceKey });
    if (!revoked) {
      return jsonResponse(res, { error: 'API key not found' }, 404);
    }
    return jsonResponse(res, { success: true, key_id: revoked.id, revoked_at: revoked.revokedAt });
  }

  if (pathname === '/v1/clients/descriptors' && req.method === 'GET') {
    const current = await requireSession(req, res);
    if (!current) return;
    return jsonResponse(res, {
      core_api_base_url: CONFIG.coreApiBaseUrl,
      descriptors: buildAllClientDescriptors({
        coreApiBaseUrl: CONFIG.coreApiBaseUrl,
        userId: current.session.userId,
        apiKey: null
      })
    });
  }

  const descriptorMatch = pathname.match(/^\/v1\/clients\/descriptors\/([^/]+)$/);
  if (descriptorMatch && req.method === 'GET') {
    const current = await requireSession(req, res);
    if (!current) return;
    try {
      return jsonResponse(res, buildClientDescriptor(descriptorMatch[1], {
        coreApiBaseUrl: CONFIG.coreApiBaseUrl,
        userId: current.session.userId,
        apiKey: null
      }));
    } catch (error) {
      return jsonResponse(res, { error: error.message }, 400);
    }
  }

  // ─── Connector OAuth Routes ──────────────────────────────────────

  // GET /v1/connectors — list all connectors for current user
  if (pathname === '/v1/connectors' && req.method === 'GET') {
    const current = await requireSession(req, res);
    if (!current) return;
    if (!connectorStore) return jsonResponse(res, { error: 'Database unavailable' }, 503);

    const connectors = await connectorStore.listConnectors(current.session.userId);

    // Merge with provider registry to show available + connected
    const result = await Promise.all(Object.entries(PROVIDER_REGISTRY).map(async ([providerId, meta]) => {
      const connector = connectors.find(c => c.provider === providerId);
      const oauthConfig = await getProviderRuntimeConfig(meta);
      const availability = evaluateProviderConfiguration(providerId, oauthConfig);
      const status = connector
        ? connector.status
        : availability.configured
          ? 'disconnected'
          : 'not_configured';
      return {
        provider: providerId,
        label: meta.label,
        status,
        account_ref: connector?.account_ref || null,
        target_scope: connector?.target_scope || 'personal',
        last_sync_at: connector?.last_sync_at || null,
        last_error: connector?.last_error || null,
        is_active: connector?.is_active || false,
        scopes: connector?.scopes || meta.scopes,
        created_at: connector?.created_at || null,
        configured: availability.configured,
        disabled_reason: availability.disabledReason,
      };
    }));

    // Overlay nango_connections so Nango-finalized OAuth shows as connected
    const connectorDebug = process.env.CONNECTOR_OVERLAY_VERBOSE === '1';
    if (connectorDebug) console.log(`[v1/connectors] overlay start userId=${current.session.userId} orgId=${current.session.orgId}`);
    try {
      if (prisma?.nangoConnection) {
        const NANGO_TO_REGISTRY = {
          slack: 'slack',
          notion: 'notion',
          github: 'github',
          linear: 'linear',
          jira: 'atlassian',
          confluence: 'confluence',
          'google-mail': 'gmail',
          'google-drive': 'google-drive',
          'google-calendar': 'google-calendar',
        };
        const orgId = current.session.orgId || current.session.org_id;
        const where = { userId: current.session.userId, status: 'active' };
        if (orgId) where.orgId = orgId;
        const nangoRows = await prisma.nangoConnection.findMany({
          where,
          select: { providerKey: true, connectionId: true, connectedAt: true },
        });
        if (connectorDebug) console.log(`[v1/connectors] overlay where=${JSON.stringify(where)} rows=${nangoRows.length} keys=${nangoRows.map(r => r.providerKey).join(',')}`);
        const overlayByProvider = {};
        for (const row of nangoRows) {
          const regId = NANGO_TO_REGISTRY[row.providerKey] || row.providerKey;
          overlayByProvider[regId] = row;
        }
        let promoted = 0;
        for (const entry of result) {
          const nangoRow = overlayByProvider[entry.provider];
          if (nangoRow && entry.status !== 'connected') {
            entry.status = 'connected';
            entry.is_active = true;
            entry.account_ref = entry.account_ref || nangoRow.connectionId;
            entry.created_at = entry.created_at || nangoRow.connectedAt;
            entry.source = 'nango';
            promoted++;
          }
        }
        // Providers with an active Nango connection but NO PROVIDER_REGISTRY
        // entry (google-docs, google-gemini, …) used to vanish here — the row
        // existed, the loop above had no entry to promote, and the FE card
        // stayed on "Connect" forever even after a successful OAuth. Append
        // synthetic connected entries so the FE (which matches on
        // entry.provider === card.id|nangoProvider) always sees them.
        const knownProviders = new Set(result.map((e) => e.provider));
        for (const [regId, row] of Object.entries(overlayByProvider)) {
          if (knownProviders.has(regId)) continue;
          result.push({
            provider: regId,
            label: regId,
            status: 'connected',
            is_active: true,
            account_ref: row.connectionId,
            created_at: row.connectedAt,
            source: 'nango',
          });
          promoted++;
        }
        if (connectorDebug) console.log(`[v1/connectors] overlay promoted=${promoted} providers=${Object.keys(overlayByProvider).join(',')}`);
      }
    } catch (nangoErr) {
      console.warn('[v1/connectors] nango overlay failed:', nangoErr.message);
    }

    // Overlay Composio-backed LIVE connectors (org-scoped — Composio's
    // user_id is the org id, matching the Nango overlay's org-level
    // convention above). Same status vocabulary the FE merge already
    // understands: connected / needs_reauth / error / available.
    if (composioService.isComposioConfigured()) {
      try {
        const orgId = current.session.orgId || current.session.org_id;
        if (orgId) {
          const composioEntries = COMPOSIO_CONNECTOR_CATALOG.filter((c) => c.provider === 'composio');
          const accounts = await composioService.listConnectedAccounts(orgId);
          const knownProviders = new Set(result.map((e) => e.provider));
          for (const entry of composioEntries) {
            const rows = accounts.filter((a) => a.toolkit === (entry.composioToolkit || entry.id));
            const active = rows.find((r) => r.status === 'ACTIVE');
            const dead = rows.find((r) => r.status === 'EXPIRED' || r.status === 'FAILED');
            const status = active ? 'connected' : dead ? 'needs_reauth' : 'available';
            const overlay = {
              provider: entry.id,
              label: entry.name,
              status,
              account_ref: active?.id || dead?.id || null,
              last_sync_at: null,
              last_error: null,
              is_active: Boolean(active),
              created_at: (active || dead)?.createdAt || null,
              source: 'composio',
            };
            if (knownProviders.has(entry.id)) {
              const idx = result.findIndex((e) => e.provider === entry.id);
              result[idx] = { ...result[idx], ...overlay };
            } else {
              result.push(overlay);
              knownProviders.add(entry.id);
            }
          }
        }
      } catch (composioErr) {
        console.warn('[v1/connectors] composio overlay failed:', composioErr.message);
      }
    }

    const whatsappStatus = await whatsappManager.getStatus(current.session.userId).catch((err) => ({
      paired: false,
      phoneNumber: null,
      error: err.message,
    }));
    result.push(buildWhatsAppConnectorStatus(whatsappStatus));

    return jsonResponse(res, { connectors: result });
  }

  // POST /v1/connectors/composio/:toolkit/connect — start a Composio
  // managed-auth OAuth flow for one toolkit, org-scoped. Redirect-out flow
  // (Composio hosts the OAuth consent page; not embeddable) — mirrors how
  // the existing Nango Connect button already opens a hosted popup/page
  // rather than an in-app form.
  const composioConnectMatch = pathname.match(/^\/v1\/connectors\/composio\/([a-z0-9_-]+)\/connect$/i);
  if (composioConnectMatch && req.method === 'POST') {
    const current = await requireSession(req, res);
    if (!current) return;
    if (!composioService.isComposioConfigured()) {
      return jsonResponse(res, { error: 'Composio is not configured on this deployment' }, 503);
    }
    const toolkitSlug = composioConnectMatch[1].toLowerCase();
    // Slack/Slackbot must go through HIVEMIND's native OAuth (/v1/connectors/
    // slack/start) — Composio's connected_accounts API masks the real Slack
    // token (returns literal "xoxe..." placeholders), which breaks the
    // @mention response pipeline with invalid_auth. Block it here so this
    // dead-end can't be reached from the generic toolkit browser again.
    if (toolkitSlug === 'slack' || toolkitSlug === 'slackbot') {
      return jsonResponse(res, {
        error: 'Slack connects natively — use the Slack tile on the main Connectors page instead of Composio.',
      }, 400);
    }
    const orgId = current.session.orgId || current.session.org_id;
    if (!orgId) return jsonResponse(res, { error: 'No active organization for this session' }, 400);
    try {
      const body = await parseBody(req).catch(() => ({}));
      const callbackUrl = typeof body.callback_url === 'string' && body.callback_url
        ? body.callback_url
        : `${req.headers.origin || ''}/hivemind/app/connectors?composio_connected=${encodeURIComponent(toolkitSlug)}`;
      // When the FE already knows the toolkit's metadata (browse-the-full-
      // catalog grid — every card carries its own toolkits.list() result),
      // it passes it along so a toolkit with no ops-curated auth config yet
      // gets one auto-provisioned instead of 400ing.
      const link = await composioService.createConnectLink(toolkitSlug, orgId, {
        callbackUrl,
        toolkitMeta: body.toolkit_meta && typeof body.toolkit_meta === 'object' ? {
          composioManagedAuthSchemes: Array.isArray(body.toolkit_meta.composio_managed_auth_schemes) ? body.toolkit_meta.composio_managed_auth_schemes : [],
          noAuth: Boolean(body.toolkit_meta.no_auth),
        } : undefined,
      });
      await audit({
        organizationId: orgId, userId: current.session.userId,
        eventType: 'connector.composio_connect_started', eventCategory: 'connectors', action: 'create',
        resourceType: 'composio_connected_account', resourceId: link.connectedAccountId,
        metadata: { toolkit: toolkitSlug }, ..._reqMeta(req),
      });
      return jsonResponse(res, {
        redirect_url: link.redirectUrl,
        connected_account_id: link.connectedAccountId,
        expires_at: link.expiresAt,
      });
    } catch (err) {
      return jsonResponse(res, { error: err.message }, err.status === 404 ? 404 : 400);
    }
  }

  // POST /v1/connectors/composio/:toolkit/connect-api-key — connect a
  // plain-API-key toolkit (SerpApi, Firecrawl, ...). No redirect: the
  // caller already has the key, it's forwarded straight to Composio and
  // never logged/persisted here.
  const composioApiKeyMatch = pathname.match(/^\/v1\/connectors\/composio\/([a-z0-9_-]+)\/connect-api-key$/i);
  if (composioApiKeyMatch && req.method === 'POST') {
    const current = await requireSession(req, res);
    if (!current) return;
    if (!composioService.isComposioConfigured()) {
      return jsonResponse(res, { error: 'Composio is not configured on this deployment' }, 503);
    }
    const toolkitSlug = composioApiKeyMatch[1].toLowerCase();
    const orgId = current.session.orgId || current.session.org_id;
    if (!orgId) return jsonResponse(res, { error: 'No active organization for this session' }, 400);
    try {
      const body = await parseBody(req).catch(() => ({}));
      const apiKey = typeof body.api_key === 'string' ? body.api_key.trim() : '';
      if (!apiKey) return jsonResponse(res, { error: 'api_key is required' }, 400);
      const result = await composioService.createApiKeyConnection(orgId, toolkitSlug, apiKey);
      await audit({
        organizationId: orgId, userId: current.session.userId,
        eventType: 'connector.composio_connect_started', eventCategory: 'connectors', action: 'create',
        resourceType: 'composio_connected_account', resourceId: result.id,
        metadata: { toolkit: toolkitSlug, auth_scheme: 'API_KEY' }, ..._reqMeta(req),
      });
      return jsonResponse(res, { connected_account_id: result.id, status: result.status });
    } catch (err) {
      return jsonResponse(res, { error: err.message }, 400);
    }
  }

  // POST /v1/connectors/composio/:toolkit/disconnect — tear down a Composio
  // connected account for one toolkit, org-scoped. Generic counterpart to
  // /connect — the toolkit browser lets you connect any of ~1,100 toolkits,
  // so disconnect has to work for any of them too, not just the ops-curated
  // catalog entries the older /v1/connectors/:provider/disconnect route covers.
  const composioDisconnectMatch = pathname.match(/^\/v1\/connectors\/composio\/([a-z0-9_-]+)\/disconnect$/i);
  if (composioDisconnectMatch && req.method === 'POST') {
    const current = await requireSession(req, res);
    if (!current) return;
    if (!composioService.isComposioConfigured()) {
      return jsonResponse(res, { error: 'Composio is not configured on this deployment' }, 503);
    }
    const toolkitSlug = composioDisconnectMatch[1].toLowerCase();
    const orgId = current.session.orgId || current.session.org_id;
    if (!orgId) return jsonResponse(res, { error: 'No active organization for this session' }, 400);
    try {
      const removed = await composioService.disconnectToolkit(orgId, toolkitSlug);
      await audit({
        organizationId: orgId, userId: current.session.userId,
        eventType: 'connector.composio_disconnected', eventCategory: 'connectors', action: 'delete',
        resourceType: 'composio_connected_account', resourceId: toolkitSlug,
        metadata: { toolkit: toolkitSlug, removed }, ..._reqMeta(req),
      });
      return jsonResponse(res, { ok: true, removed });
    } catch (err) {
      return jsonResponse(res, { error: err.message }, 400);
    }
  }

  // GET /v1/connectors/composio/toolkits?search=&cursor= — browse Composio's
  // full toolkit catalog (~1,100 toolkits). Thin proxy so the frontend never
  // sees COMPOSIO_API_KEY.
  if (pathname === '/v1/connectors/composio/toolkits' && req.method === 'GET') {
    const current = await requireSession(req, res);
    if (!current) return;
    if (!composioService.isComposioConfigured()) {
      return jsonResponse(res, { error: 'Composio is not configured on this deployment' }, 503);
    }
    try {
      const orgId = current.session.orgId || current.session.org_id;
      const wantsCatalog = url.searchParams.get('catalog') === 'all';
      const search = url.searchParams.get('search') || '';
      const pagePromise = wantsCatalog
        ? composioService.listAllToolkits({ search })
        : composioService.listToolkits({
          search,
          cursor: url.searchParams.get('cursor') || null,
          limit: Math.min(Number(url.searchParams.get('limit')) || 40, 100),
        });
      const [page, accounts] = await Promise.all([
        pagePromise,
        orgId ? composioService.listConnectedAccounts(orgId).catch(() => []) : Promise.resolve([]),
      ]);
      // Real per-org connection state, not something the FE has to remember
      // client-side across reloads — the "connected" flag here reflects
      // whichever of THIS page's toolkits the org actually has an ACTIVE
      // connected account for, so the frontend can sort them to the top.
      const connectedToolkits = new Set(accounts.filter((a) => a.status === 'ACTIVE').map((a) => a.toolkit));
      // Slack is native-only (see /connect guard above) — its "connected"
      // state lives in PlatformIntegration, not Composio's connected_accounts,
      // so the card would otherwise always read as disconnected even when
      // the real bot is live.
      if (prisma) {
        try {
          const nativeSlack = await prisma.platformIntegration.findFirst({
            where: { userId: current.session.userId, platformType: 'slack', isActive: true },
            select: { id: true },
          });
          if (nativeSlack) connectedToolkits.add('slack');
        } catch { /* best-effort overlay */ }
      }
      const toolkits = page.items.map((tk) => ({ ...tk, connected: connectedToolkits.has(tk.slug) }));
      return jsonResponse(res, {
        toolkits,
        next_cursor: page.nextCursor,
        total_items: page.totalItems,
      });
    } catch (err) {
      return jsonResponse(res, { error: err.message }, 502);
    }
  }

  // GET /v1/connectors/composio/toolkits/:slug/tools — full tool list for
  // one toolkit (name + description per action), for the "what does this
  // connector actually let the agent do" detail popup on the browse grid.
  const composioToolkitToolsMatch = pathname.match(/^\/v1\/connectors\/composio\/toolkits\/([a-z0-9_-]+)\/tools$/i);
  if (composioToolkitToolsMatch && req.method === 'GET') {
    const current = await requireSession(req, res);
    if (!current) return;
    if (!composioService.isComposioConfigured()) {
      return jsonResponse(res, { error: 'Composio is not configured on this deployment' }, 503);
    }
    const toolkitSlug = composioToolkitToolsMatch[1].toLowerCase();
    try {
      const tools = await composioService.getToolkitTools(toolkitSlug);
      // Strip the toolkit's own prefix (e.g. "LINKEDIN_") off its tool slugs
      // for a readable name — "GET_MY_INFO" not the raw "LINKEDIN_GET_MY_INFO".
      const prefixRe = new RegExp(`^${toolkitSlug}_`, 'i');
      return jsonResponse(res, {
        toolkit: toolkitSlug,
        tools: tools.map((t) => {
          const rawSlug = t._composio?.slug || t.function?.name || '';
          return {
            slug: rawSlug,
            name: rawSlug.replace(prefixRe, '').replace(/_/g, ' ').trim() || rawSlug,
            description: t.function?.description || '',
          };
        }),
      });
    } catch (err) {
      return jsonResponse(res, { error: err.message }, 502);
    }
  }

  const whatsappQrRoute = pathname === '/api/connectors/whatsapp/qr' || pathname === '/v1/connectors/whatsapp/qr';
  if (whatsappQrRoute && req.method === 'POST') {
    const current = await requireSession(req, res);
    if (!current) return;

    try {
      const payload = await parseBody(req);
      const bridge = await whatsappManager.startPairing(current.session.userId, {
        mode: payload?.mode,
        allowedUsers: payload?.allowedUsers,
        pairedPhoneNumber: payload?.pairedPhoneNumber,
      });
      const handshake = await waitForWhatsAppHandshake(bridge);
      return jsonResponse(res, handshake);
    } catch (err) {
      return jsonResponse(res, { error: err.message }, 500);
    }
  }

  const whatsappStatusRoute = pathname === '/api/connectors/whatsapp/status' || pathname === '/v1/connectors/whatsapp/status';
  if (whatsappStatusRoute && req.method === 'GET') {
    const current = await requireSession(req, res);
    if (!current) return;

    try {
      const status = await whatsappManager.getStatus(current.session.userId);
      return jsonResponse(res, status);
    } catch (err) {
      return jsonResponse(res, { error: err.message }, 500);
    }
  }

  const whatsappDisconnectRoute = pathname === '/api/connectors/whatsapp/disconnect' || pathname === '/v1/connectors/whatsapp/disconnect';
  if (whatsappDisconnectRoute && req.method === 'POST') {
    const current = await requireSession(req, res);
    if (!current) return;

    try {
      await whatsappManager.disconnect(current.session.userId);
      return jsonResponse(res, { success: true, provider: 'whatsapp' });
    } catch (err) {
      return jsonResponse(res, { error: err.message }, 500);
    }
  }

  // POST /v1/connectors/:provider/start — begin OAuth flow
  const connectorStartMatch = pathname.match(/^\/v1\/connectors\/([a-z_-]+)\/start$/);
  if (connectorStartMatch && req.method === 'POST') {
    const current = await requireSession(req, res);
    if (!current) return;

    // Org-scope connectors require connector:manage; personal connectors are open
    const connectorStartBody = await parseBody(req);
    if (connectorStartBody.target_scope === 'organization') {
      const connMem = await getOrgMembership(current.session.userId, current.session.orgId);
      if (connMem) {
        try {
          const auditLogger = await _getAuditLogger();
          assertPermission(req, { resource: 'connector', action: 'manage' }, {
            userRoles: effectiveRoles(connMem),
            orgId: current.session.orgId,
            userId: current.session.userId,
            auditLogger,
          });
        } catch (permErr) {
          return jsonResponse(res, { error: permErr.error || 'Forbidden' }, permErr.status || 403);
        }
      }
    }

    const provider = connectorStartMatch[1];
    const providerConfig = PROVIDER_REGISTRY[provider];
    if (!providerConfig) {
      return jsonResponse(res, { error: `Unknown provider: ${provider}` }, 400);
    }

    try {
      const oauthModule = await import(providerConfig.oauthModule);
      const availability = evaluateProviderConfiguration(
        provider,
        typeof oauthModule.getOAuthConfig === 'function' ? oauthModule.getOAuthConfig() : null
      );

      if (!availability.configured) {
        return jsonResponse(res, {
          error: `${provider} connector is not configured`,
          message: availability.disabledReason,
        }, 503);
      }

      const { buildAuthUrl } = oauthModule;
      // connectorStartBody was already read for the permission check above
      const body = connectorStartBody;
      const returnTo = body.return_to || '/hivemind/app/connectors';
      const rawScope = body.target_scope;
      const rawTeamId = body.team_id || null;

      // Validate and normalise target_scope.
      // 'organization' → requires org_admin or org_owner.
      // 'team'         → requires team_lead on the specified team_id.
      // 'personal'     → no extra permission needed.
      let targetScope = 'personal';
      let resolvedTeamId = null;

      if (rawScope === 'organization') {
        const membership = await getOrgMembership(current.session.userId, current.session.orgId);
        if (!membership || !canManageOrg(membership.role)) {
          return jsonResponse(res, { error: 'Only org admins can set org-scope connectors' }, 403);
        }
        targetScope = 'organization';
      } else if (rawScope === 'team') {
        if (!rawTeamId) {
          return jsonResponse(res, { error: 'team_id is required when target_scope is "team"' }, 400);
        }
        if (!prisma) return jsonResponse(res, { error: 'Database unavailable' }, 503);
        // Inline team store import — _getTeamStore is const-scoped later in the handler
        const tsModTeam = await import('./teams/team-store.js');
        const orgMembership = await getOrgMembership(current.session.userId, current.session.orgId);
        const orgRole = orgMembership?.role || 'member';
        try {
          await tsModTeam.assertTeamPermission(prisma, {
            teamId: rawTeamId,
            userId: current.session.userId,
            orgRole,
            level: 'lead',
          });
        } catch {
          return jsonResponse(res, { error: 'Only team leads can set team-scope connectors' }, 403);
        }
        targetScope = 'team';
        resolvedTeamId = rawTeamId;
      }

      // Audit-log connector scope selection (fire-and-forget)
      if (prisma && (targetScope === 'organization' || targetScope === 'team')) {
        const auditMod = await import('./audit/audit-logger.js');
        const al = new auditMod.AuditLogger(prisma);
        const fwdHdr = req.headers?.['x-forwarded-for'];
        al.log({
          organizationId: current.session.orgId,
          userId: current.session.userId,
          eventType: 'connector.scope_changed',
          eventCategory: 'connector',
          action: 'start_oauth',
          resourceType: 'connector',
          newValue: { provider, target_scope: targetScope, team_id: resolvedTeamId },
          ipAddress: typeof fwdHdr === 'string' ? fwdHdr.split(',')[0].trim() : (req.socket?.remoteAddress || null),
          userAgent: req.headers?.['user-agent'] || null,
          platformType: 'webapp',
        }).catch(err => console.warn('[audit] connector start log failed:', err.message));
      }

      // Create CSRF-safe stateless state bound to user/org
      const stateId = encodeConnectorState({
        userId: current.session.userId,
        orgId: current.session.orgId,
        provider,
        returnTo,
        targetScope,
        teamId: resolvedTeamId,
      });

      const authUrl = buildAuthUrl({
        redirectUri: getConnectorCallbackUrl(provider),
        state: stateId,
      });

      return jsonResponse(res, { auth_url: authUrl });
    } catch (error) {
      return jsonResponse(res, { error: error.message }, 500);
    }
  }

  // GET /v1/connectors/:provider/callback — OAuth callback
  const connectorCallbackMatch = pathname.match(/^\/v1\/connectors\/([a-z_-]+)\/callback$/);
  if (connectorCallbackMatch && req.method === 'GET') {
    const provider = connectorCallbackMatch[1];
    const providerConfig = PROVIDER_REGISTRY[provider];
    if (!providerConfig) {
      return jsonResponse(res, { error: `Unknown provider: ${provider}` }, 400);
    }

    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');

    if (error) {
      return redirect(res, `/hivemind/app/connectors?connector_error=${encodeURIComponent(error)}`);
    }

    if (!code || !state) {
      return jsonResponse(res, { error: 'Missing code or state' }, 400);
    }

    // Verify CSRF state
    const authState = decodeConnectorState(state);
    if (!authState || authState.provider !== provider) {
      return redirect(res, `/hivemind/app/connectors?connector_error=invalid_state`);
    }

    try {
      const { exchangeCode } = await import(providerConfig.oauthModule);
      const tokens = await exchangeCode({
        code,
        redirectUri: getConnectorCallbackUrl(provider),
      });

      // For providers that issue both bot and user tokens (Slack), merge the
      // granted scopes from both sides and stash the user-token in metadata
      // so the bridge can use it for user-only API calls (e.g. search.messages).
      const grantedBotScopes = (tokens.bot_scope || '').split(/[,\s]+/).filter(Boolean);
      const grantedUserScopes = (tokens.user_scope || '').split(/[,\s]+/).filter(Boolean);
      const mergedScopes = grantedBotScopes.length || grantedUserScopes.length
        ? Array.from(new Set([...grantedBotScopes, ...grantedUserScopes]))
        : (providerConfig.scopes || []);

      const providerMetadata = {};
      if (tokens.user_access_token) providerMetadata.user_access_token = tokens.user_access_token;
      if (tokens.user_scope) providerMetadata.user_scope = tokens.user_scope;
      if (tokens.bot_scope) providerMetadata.bot_scope = tokens.bot_scope;
      if (tokens.team_id) providerMetadata.team_id = tokens.team_id;
      if (tokens.team) providerMetadata.team = tokens.team;
      if (tokens.authed_user_id) providerMetadata.authed_user_id = tokens.authed_user_id;
      // Generic merge: providers like Atlassian, Salesforce, Microsoft
      // return discovery fields (cloud_id, instance_url, tenant_id, ...)
      // that the adapter needs at fetch time. exchangeCode can populate
      // tokens.provider_metadata with any shape they want.
      if (tokens.provider_metadata && typeof tokens.provider_metadata === 'object') {
        Object.assign(providerMetadata, tokens.provider_metadata);
      }

      // Store encrypted tokens
      await upsertConnectorWithinPlan(authState.orgId, {
        userId: authState.userId,
        provider,
        targetScope: authState.targetScope || 'personal',
        teamId: authState.teamId || null,
        accountRef: tokens.email || tokens.account_ref || null,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        tokenExpiresAt: tokens.expires_in
          ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
          : null,
        scopes: mergedScopes,
        metadata: providerMetadata,
      });

      // Enqueue initial sync (fire-and-forget background)
      setImmediate(async () => {
        try {
          const apiKey = process.env.HIVEMIND_MASTER_API_KEY;
          if (!apiKey) {
            console.error(`[connector] HIVEMIND_MASTER_API_KEY is not configured; initial sync skipped for ${provider}:${authState.userId}`);
            return;
          }
          const syncResponse = await fetch(`${CONFIG.coreApiBaseUrl}/api/connectors/sync`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-API-Key': apiKey,
            },
            body: JSON.stringify({
              provider,
              user_id: authState.userId,
              org_id: authState.orgId,
              target_scope: authState.targetScope || 'personal',
              team_id: authState.teamId || null,
              incremental: false,
            }),
          });
          console.log(`[connector] Initial sync enqueued for ${provider}:${authState.userId} → ${syncResponse.status}`);
        } catch (syncError) {
          console.error(`[connector] Initial sync failed for ${provider}:`, syncError.message);
        }
      });

      // Resolve returnTo to an absolute frontend URL. authState.returnTo may
      // already be absolute (set by the connectors page). If it's a bare path
      // we prepend the frontend base — otherwise the redirect lands on the
      // control-plane host (api.hivemind.davinciai.eu:8040) which serves
      // {"error":"Not found"} for /hivemind/* paths.
      const rawReturnTo = authState.returnTo || '/hivemind/app/connectors';
      const isAbsolute = /^https?:\/\//i.test(rawReturnTo);
      const returnTo = isAbsolute ? rawReturnTo : `${defaultFrontendBaseUrl}${rawReturnTo}`;
      const sep = returnTo.includes('?') ? '&' : '?';
      return redirect(res, `${returnTo}${sep}connector_success=${provider}`);
    } catch (tokenError) {
      console.error(`[connector] OAuth exchange failed for ${provider}:`, tokenError.message);
      return redirect(res, `${defaultFrontendBaseUrl}/hivemind/app/connectors?connector_error=${encodeURIComponent(tokenError.message)}`);
    }
  }

  // GET /v1/connectors/:provider/status — detailed connector status
  const connectorStatusMatch = pathname.match(/^\/v1\/connectors\/([a-z_-]+)\/status$/);
  if (connectorStatusMatch && req.method === 'GET') {
    const current = await requireSession(req, res);
    if (!current) return;
    if (!connectorStore) return jsonResponse(res, { error: 'Database unavailable' }, 503);

    const connector = await connectorStore.getConnector(current.session.userId, connectorStatusMatch[1]);
    if (!connector) {
      return jsonResponse(res, { provider: connectorStatusMatch[1], status: 'disconnected' });
    }
    return jsonResponse(res, connector);
  }

  // POST /v1/connectors/:provider/disconnect
  const connectorDisconnectMatch = pathname.match(/^\/v1\/connectors\/([a-z_-]+)\/disconnect$/);
  if (connectorDisconnectMatch && req.method === 'POST') {
    const current = await requireSession(req, res);
    if (!current) return;
    const providerId = connectorDisconnectMatch[1];

    // Composio-backed connector — org-scoped, not the legacy userId-scoped
    // connectorStore path below.
    const composioEntry = COMPOSIO_CONNECTOR_CATALOG.find((c) => c.provider === 'composio' && c.id === providerId);
    if (composioEntry) {
      const orgId = current.session.orgId || current.session.org_id;
      if (!orgId) return jsonResponse(res, { error: 'No active organization for this session' }, 400);
      try {
        const removed = await composioService.disconnectToolkit(orgId, composioEntry.composioToolkit || composioEntry.id);
        return jsonResponse(res, { success: removed > 0, provider: providerId });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    if (!connectorStore) return jsonResponse(res, { error: 'Database unavailable' }, 503);
    const success = await connectorStore.disconnect(current.session.userId, providerId);
    return jsonResponse(res, { success, provider: providerId });
  }

  // POST /v1/connectors/:provider/resync — trigger manual resync
  const connectorResyncMatch = pathname.match(/^\/v1\/connectors\/([a-z_-]+)\/resync$/);
  if (connectorResyncMatch && req.method === 'POST') {
    const current = await requireSession(req, res);
    if (!current) return;

    const provider = connectorResyncMatch[1];
    const apiKey = process.env.HIVEMIND_MASTER_API_KEY;
    if (!apiKey) {
      return jsonResponse(res, { error: 'HIVEMIND_MASTER_API_KEY is not configured' }, 503);
    }
    const body = await parseBody(req);

    // 1. Legacy connector store path (gmail/google-* via legacy oauth_tokens)
    const connector = await connectorStore?.getConnector(current.session.userId, provider);
    if (connector && connector.status !== 'disconnected') {
      try {
        await fetch(`${CONFIG.coreApiBaseUrl}/api/connectors/sync`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
          body: JSON.stringify({
            provider,
            user_id: current.session.userId,
            org_id: current.session.orgId,
            target_scope: connector.target_scope || 'personal',
            incremental: body.incremental !== false,
          }),
        });
        return jsonResponse(res, { success: true, message: 'Sync enqueued (legacy)' });
      } catch (error) {
        return jsonResponse(res, { error: error.message }, 500);
      }
    }

    // 2. Nango path — find MCP ingestion endpoint for this provider
    try {
      const REGISTRY_TO_NANGO = {
        slack: 'slack', notion: 'notion', github: 'github', linear: 'linear',
        atlassian: 'jira', jira: 'jira', confluence: 'confluence',
        gmail: 'google-mail', 'google-mail': 'google-mail',
        'google-drive': 'google-drive', 'google-calendar': 'google-calendar',
      };
      const nangoKey = REGISTRY_TO_NANGO[provider] || provider;
      const nangoRow = await prisma?.nangoConnection?.findFirst({
        where: { userId: current.session.userId, providerKey: nangoKey, status: 'active' },
      });
      if (!nangoRow) {
        return jsonResponse(res, { error: 'Connector not connected' }, 400);
      }

      // P1 #1.7 — try evidence-first resync via adapter.fetchBulk BEFORE legacy MCP
      try {
        const evidenceResp = await fetch(`${CONFIG.coreApiBaseUrl}/api/connectors/evidence-resync`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
          body: JSON.stringify({
            provider_key: nangoKey,
            user_id: current.session.userId,
            org_id: current.session.orgId,
            limit: body.limit || 50,
            scope: body.scope || {},
            cursor: body.cursor || null,
          }),
        });
        if (evidenceResp.ok) {
          const evidenceData = await evidenceResp.json().catch(() => ({}));
          if (evidenceData.processed > 0) {
            return jsonResponse(res, {
              success: true,
              message: `Evidence resync complete (${evidenceData.processed} records)`,
              ...evidenceData,
            });
          }
        }
      } catch (evidenceErr) {
        console.warn(`[resync] evidence path failed for ${provider}: ${evidenceErr.message}`);
      }

      // Fallback: legacy MCP ingest endpoint
      const ingestionByProvider = {
        notion: 'notion-ingestion',
        'google-mail': 'gmail-ingestion',
        gmail: 'gmail-ingestion',
        'google-drive': 'google-drive-ingestion',
        confluence: 'confluence-ingestion',
      };
      const endpointName = ingestionByProvider[nangoKey] || ingestionByProvider[provider];
      if (!endpointName) {
        return jsonResponse(res, {
          error: `No ingestion endpoint configured for ${provider} — live-only connector`,
        }, 400);
      }

      const r = await fetch(`${CONFIG.coreApiBaseUrl}/api/connectors/mcp/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
        body: JSON.stringify({
          name: endpointName,
          user_id: current.session.userId,
          org_id: current.session.orgId,
          limit: body.limit || 100,
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        return jsonResponse(res, { error: data.error || 'MCP ingest failed', ...data }, r.status);
      }
      return jsonResponse(res, { success: true, message: 'Sync enqueued (Nango)', ...data });
    } catch (error) {
      return jsonResponse(res, { error: error.message }, 500);
    }
  }

  // SCIM 2.0 — Users + Groups CRUD. Bearer token verified per-request
  // against OrgSsoConfig.scimTokenHash. See core/src/scim/scim-routes.js.
  if (pathname.startsWith('/scim/v2/')) {
    const { handleScimRequest } = await import('./scim/scim-routes.js');
    try {
      return await handleScimRequest({ prisma, req, res, pathname, url });
    } catch (err) {
      console.error('[scim] handler crashed:', err);
      res.writeHead(500, { 'Content-Type': 'application/scim+json' });
      res.end(JSON.stringify({
        schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
        status: '500', detail: err.message || 'Internal SCIM error',
      }));
      return;
    }
  }

  // Workspace state is one authoritative quota snapshot for the admin UI.
  if (pathname === '/v1/workspace/summary' && req.method === 'GET') {
    const current = await requireSession(req, res);
    if (!current) return;
    const membership = await requireOrgAdmin(req, res, current.session.userId, current.session.orgId);
    if (!membership) return;
    try {
      const orgId = current.session.orgId;
      const now = new Date();
      const [{ plan }, seats, projects, teams, pendingInvites] = await Promise.all([
        getEffectivePlan(prisma, orgId),
        prisma.userOrganization.count({ where: { orgId, isActive: true } }),
        prisma.project.count({ where: { orgId, archivedAt: null } }),
        prisma.team.count({ where: { orgId, archivedAt: null } }),
        prisma.orgInvite.count({ where: { orgId, usedAt: null, revokedAt: null, expiresAt: { gt: now } } }),
      ]);
      const limit = (key, used) => {
        const max = plan.limits?.[key] ?? -1;
        return { used, limit: max, remaining: max < 0 ? null : Math.max(0, max - used), warning: max > 0 && used / max >= 0.8 };
      };
      return jsonResponse(res, {
        plan: { id: plan.id, name: plan.name, period_end: membership.org?.currentPeriodEnd || null },
        seats: limit('maxUsers', seats),
        projects: limit('maxProjects', projects),
        teams: { used: teams },
        invitations: { pending: pendingInvites },
      });
    } catch (err) {
      return jsonResponse(res, { error: 'Workspace summary unavailable' }, 503);
    }
  }

  if (pathname === '/v1/workspace/notifications' && req.method === 'GET') {
    const current = await requireSession(req, res);
    if (!current) return;
    if (!await getActiveOrganizationMembership(prisma, { orgId: current.session.orgId, userId: current.session.userId })) {
      return jsonResponse(res, { error: 'Resource not found' }, 404);
    }
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') || 20)));
    const unreadOnly = url.searchParams.get('unread') === 'true';
    try {
      // This endpoint powers the "Your workspace lifecycle" panel, not a
      // generic activity feed. Only explicitly typed lifecycle events belong
      // here; generic emails and operational updates stay out of the panel.
      const lifecycleWhere = { orgId: current.session.orgId, userId: current.session.userId, type: { startsWith: 'lifecycle.' } };
      const where = { ...lifecycleWhere, ...(unreadOnly ? { readAt: null } : {}) };
      const [items, unread] = await Promise.all([
        prisma.workspaceNotification.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit }),
        prisma.workspaceNotification.count({ where: { ...lifecycleWhere, readAt: null } }),
      ]);
      return jsonResponse(res, { items, unread });
    } catch {
      return jsonResponse(res, { error: 'Notifications unavailable' }, 503);
    }
  }

  const notificationReadMatch = pathname.match(/^\/v1\/workspace\/notifications\/([0-9a-f-]{36})\/read$/);
  if (notificationReadMatch && req.method === 'POST') {
    const current = await requireSession(req, res);
    if (!current) return;
    if (!await getActiveOrganizationMembership(prisma, { orgId: current.session.orgId, userId: current.session.userId })) {
      return jsonResponse(res, { error: 'Resource not found' }, 404);
    }
    const result = await prisma.workspaceNotification.updateMany({
      where: { id: notificationReadMatch[1], orgId: current.session.orgId, userId: current.session.userId, readAt: null },
      data: { readAt: new Date() },
    }).catch(() => ({ count: 0 }));
    return jsonResponse(res, { success: true, updated: result.count });
  }

  // GET /v1/teams — list teams current user belongs to in current org
  if (pathname === '/v1/teams' && req.method === 'GET') {
    const current = await requireSession(req, res);
    if (!current) return;
    const ts = await _getTeamStore();
    if (!ts) return jsonResponse(res, { error: 'Database unavailable' }, 503);
    try {
      let teams = await ts.store.listTeamsForUser({
        userId: current.session.userId,
        orgId: current.session.orgId,
      });
      // Bug fix: if user is an org member but has no team yet, lazy-create
      // (or join) the org's Default Team so they can immediately create
      // projects. Treats all org members as the implicit default team.
      // GUESTS excluded: handing them the default team exposed every team
      // project of the org they were invited into (cross-org leak).
      if (!teams.length) {
        const orgMem = await getOrgMembership(current.session.userId, current.session.orgId);
        if (orgMem?.isActive !== false && orgMem && orgMem.role !== 'guest') {
          try {
            const def = await ts.store.ensureDefaultTeam({
              orgId: current.session.orgId,
              userId: current.session.userId,
            });
            if (def) teams = [def];
          } catch (defErr) {
            // Log but don't fail the call — user still sees empty list,
            // can still trigger /v1/teams POST manually.
            console.warn('[teams] ensureDefaultTeam failed:', defErr.message);
          }
        }
      }
      return jsonResponse(res, { teams });
    } catch (err) {
      return jsonResponse(res, { error: err.message }, 500);
    }
  }

  // POST /v1/teams — create team (org_admin or team_lead)
  if (pathname === '/v1/teams' && req.method === 'POST') {
    const current = await requireSession(req, res);
    if (!current) return;
    const callerMem = await getOrgMembership(current.session.userId, current.session.orgId);
    if (!callerMem) return jsonResponse(res, { error: 'Organization membership not found' }, 404);
    const callerRoles = effectiveRoles(callerMem);
    try {
      const auditLogger = await _getAuditLogger();
      assertPermission(req, { resource: 'team', action: 'manage' }, {
        userRoles: callerRoles,
        orgId: current.session.orgId,
        userId: current.session.userId,
        auditLogger,
      });
    } catch (permErr) {
      return jsonResponse(res, { error: permErr.error || 'Forbidden' }, permErr.status || 403);
    }
    // keep `admin` as alias for backward compat with the block below
    const admin = callerMem;
    const ts = await _getTeamStore();
    if (!ts) return jsonResponse(res, { error: 'Database unavailable' }, 503);
    const body = await parseBody(req);
    if (!body.name || typeof body.name !== 'string') {
      return jsonResponse(res, { error: 'name is required' }, 400);
    }
    try {
      const team = await ts.store.createTeam({
        orgId: current.session.orgId,
        name: body.name.trim(),
        description: body.description || null,
        createdBy: current.session.userId,
      });
      audit({
        organizationId: current.session.orgId,
        userId: current.session.userId,
        eventType: 'team.created',
        eventCategory: 'team',
        action: 'create',
        resourceType: 'team',
        resourceId: team.id,
        newValue: { name: team.name, slug: team.slug },
        ..._reqMeta(req),
      });
      return jsonResponse(res, { team }, 201);
    } catch (err) {
      return jsonResponse(res, { error: err.message }, 500);
    }
  }

  // Routes scoped to a single team
  const teamIdMatch = pathname.match(/^\/v1\/teams\/([0-9a-f-]{36})(?:\/(.+))?$/);
  if (teamIdMatch) {
    const current = await requireSession(req, res);
    if (!current) return;
    const ts = await _getTeamStore();
    if (!ts) return jsonResponse(res, { error: 'Database unavailable' }, 503);
    const teamId = teamIdMatch[1];
    const sub = teamIdMatch[2] || null;
    const orgId = current.session.orgId;
    const userId = current.session.userId;
    const membership = await getOrgMembership(userId, orgId);
    const orgRole = membership?.role;

    // Sanity: team must belong to current org
    const team = await prisma.team.findFirst({ where: { id: teamId, orgId } });
    if (!team) return jsonResponse(res, { error: 'Team not found' }, 404);

    // GET /v1/teams/:id
    if (!sub && req.method === 'GET') {
      try {
        await ts.assertTeamPermission(prisma, { teamId, userId, orgRole, level: 'member' });
        return jsonResponse(res, await ts.store.getTeam({ teamId, orgId }));
      } catch (err) {
        return jsonResponse(res, { error: err.message }, err.status || 500);
      }
    }
    // PATCH /v1/teams/:id
    if (!sub && req.method === 'PATCH') {
      try {
        await ts.assertTeamPermission(prisma, { teamId, userId, orgRole, level: 'lead' });
        const body = await parseBody(req);
        const updated = await ts.store.updateTeam({ teamId, orgId, data: body });
        audit({
          organizationId: orgId, userId,
          eventType: 'team.updated', eventCategory: 'team', action: 'update',
          resourceType: 'team', resourceId: teamId,
          oldValue: { name: team.name, description: team.description },
          newValue: { name: updated.name, description: updated.description },
          ..._reqMeta(req),
        });
        return jsonResponse(res, { team: updated });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, err.status || 500);
      }
    }
    // DELETE /v1/teams/:id  (archive)
    if (!sub && req.method === 'DELETE') {
      try {
        await ts.assertTeamPermission(prisma, { teamId, userId, orgRole, level: 'admin' });
        const archived = await ts.store.archiveTeam({ teamId, orgId });
        audit({
          organizationId: orgId, userId,
          eventType: 'team.archived', eventCategory: 'team', action: 'delete',
          resourceType: 'team', resourceId: teamId,
          oldValue: { name: team.name },
          ..._reqMeta(req),
        });
        return jsonResponse(res, { team: archived });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, err.status || 400);
      }
    }
    // GET /v1/teams/:id/members
    if (sub === 'members' && req.method === 'GET') {
      try {
        await ts.assertTeamPermission(prisma, { teamId, userId, orgRole, level: 'member' });
        return jsonResponse(res, { members: await ts.store.listTeamMembers({ teamId }) });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, err.status || 500);
      }
    }
    // POST /v1/teams/:id/members
    if (sub === 'members' && req.method === 'POST') {
      try {
        await ts.assertTeamPermission(prisma, { teamId, userId, orgRole, level: 'lead' });
        const body = await parseBody(req);
        if (!body.user_id) return jsonResponse(res, { error: 'user_id required' }, 400);
        await requireSameOrganizationMember(prisma, { orgId, userId: body.user_id });
        const m = await ts.store.addTeamMember({
          teamId,
          userId: body.user_id,
          role: body.role || 'member',
          addedById: userId,
        });
        audit({
          organizationId: orgId, userId,
          eventType: 'team.member_added', eventCategory: 'team', action: 'create',
          resourceType: 'team_member', resourceId: teamId,
          newValue: { team_id: teamId, user_id: body.user_id, role: body.role || 'member' },
          ..._reqMeta(req),
        });
        await createWorkspaceNotification(prisma, {
          orgId, userId: body.user_id, type: 'team.member_added',
          title: `Added to ${team.name}`,
          body: 'You can now access this team and its shared work.',
          resourceType: 'team', resourceId: teamId,
          dedupeKey: `team-member:${teamId}:${body.user_id}`,
        }).catch(() => null);
        return jsonResponse(res, { member: m }, 201);
      } catch (err) {
        return jsonResponse(res, { error: err.message }, err.status || 500);
      }
    }
    // DELETE /v1/teams/:id/members/:userId
    const memberDelMatch = sub && sub.match(/^members\/([0-9a-f-]{36})$/);
    if (memberDelMatch && req.method === 'DELETE') {
      try {
        await ts.assertTeamPermission(prisma, { teamId, userId, orgRole, level: 'lead' });
        await ts.store.removeTeamMember({ teamId, userId: memberDelMatch[1] });
        audit({
          organizationId: orgId, userId,
          eventType: 'team.member_removed', eventCategory: 'team', action: 'delete',
          resourceType: 'team_member', resourceId: teamId,
          oldValue: { team_id: teamId, user_id: memberDelMatch[1] },
          ..._reqMeta(req),
        });
        return jsonResponse(res, { success: true });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, err.status || 400);
      }
    }
    // GET /v1/teams/:id/projects
    if (sub === 'projects' && req.method === 'GET') {
      try {
        await ts.assertTeamPermission(prisma, { teamId, userId, orgRole, level: 'member' });
        // orgRole flows through so guests (project-scoped invitees) only ever
        // get their explicit projects — even via the team-scoped listing.
        const projects = await ts.store.listProjectsForUser({ userId, orgId, teamId, orgRole });
        return jsonResponse(res, { projects });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, err.status || 500);
      }
    }
    // POST /v1/teams/:id/projects
    if (sub === 'projects' && req.method === 'POST') {
      try {
        await ts.assertTeamPermission(prisma, { teamId, userId, orgRole, level: 'member' });
        const { plan: effectivePlan } = await getEffectivePlan(prisma, orgId);
        const projectLimit = effectivePlan.limits?.maxProjects ?? -1;
        const existingProjectCount = await prisma.project.count({ where: { orgId, archivedAt: null } });
        if (projectLimit !== -1 && existingProjectCount >= projectLimit) {
          return jsonResponse(res, { error: `Project limit reached (${effectivePlan.name}: ${projectLimit})`, code: 'plan_limit_exceeded', reason: 'PLAN_LIMIT', message: `Project limit reached (${effectivePlan.name}: ${projectLimit})`, resource: 'projects', plan: effectivePlan.id, limit: projectLimit, current: existingProjectCount, suggested_plan: (_PLAN_LIMIT_NEXT[effectivePlan.id] ?? null), upgrade_url: '/hivemind/app/billing' }, 402);
        }
        const body = await parseBody(req);
        if (!body.name) return jsonResponse(res, { error: 'name required' }, 400);
        if (!body.description || !String(body.description).trim()) {
          return jsonResponse(res, { error: 'description is required — every project needs a short description' }, 400);
        }
        const p = await ts.store.createProject({
          orgId,
          teamId,
          name: body.name.trim(),
          description: String(body.description).trim(),
          policy: typeof body.policy === 'string' ? body.policy : null,
          createdBy: userId,
        });
        audit({
          organizationId: orgId, userId,
          eventType: 'project.created', eventCategory: 'project', action: 'create',
          resourceType: 'project', resourceId: p.id,
          newValue: { name: p.name, slug: p.slug, team_id: teamId },
          ..._reqMeta(req),
        });
        return jsonResponse(res, { project: p }, 201);
      } catch (err) {
        return jsonResponse(res, { error: err.message }, err.status || 500);
      }
    }
    // Fall through — unmatched team sub-route
    return jsonResponse(res, { error: 'Not found' }, 404);
  }

  // ─── Projects ─────────────────────────────────────────────
  // GET /v1/projects — list projects in current org for current user
  if (pathname === '/v1/projects' && req.method === 'GET') {
    const current = await requireSession(req, res);
    if (!current) return;
    const ts = await _getTeamStore();
    if (!ts) return jsonResponse(res, { error: 'Database unavailable' }, 503);
    try {
      // Hierarchy visibility: pass org role so owners/admins list ALL projects.
      const membership = await getOrgMembership(current.session.userId, current.session.orgId);
      const projects = await ts.store.listProjectsForUser({
        userId: current.session.userId,
        orgId: current.session.orgId,
        orgRole: membership?.role || null,
      });
      return jsonResponse(res, { projects });
    } catch (err) {
      return jsonResponse(res, { error: err.message }, 500);
    }
  }

  // Routes scoped to a single project
  const projectIdMatch = pathname.match(/^\/v1\/projects\/([0-9a-f-]{36})(?:\/(.+))?$/);
  if (projectIdMatch) {
    const current = await requireSession(req, res);
    if (!current) return;
    const ts = await _getTeamStore();
    if (!ts) return jsonResponse(res, { error: 'Database unavailable' }, 503);
    const projectId = projectIdMatch[1];
    const sub = projectIdMatch[2] || null;
    const orgId = current.session.orgId;
    const userId = current.session.userId;
    const membership = await getOrgMembership(userId, orgId);
    const orgRole = membership?.role;

    const project = await prisma.project.findFirst({ where: { id: projectId, orgId } });
    if (!project) return jsonResponse(res, { error: 'Project not found' }, 404);

    // GET /v1/projects/:id
    if (!sub && req.method === 'GET') {
      try {
        await ts.assertProjectPermission(prisma, { projectId, orgId, userId, orgRole, level: 'member' });
        return jsonResponse(res, await ts.store.getProject({ projectId, orgId }));
      } catch (err) {
        return jsonResponse(res, { error: err.message }, err.status || 500);
      }
    }
    // PATCH /v1/projects/:id
    if (!sub && req.method === 'PATCH') {
      try {
        await ts.assertProjectPermission(prisma, { projectId, orgId, userId, orgRole, level: 'owner' });
        const body = await parseBody(req);
        const updated = await ts.store.updateProject({ projectId, data: body });
        return jsonResponse(res, { project: updated });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, err.status || 500);
      }
    }
    // DELETE /v1/projects/:id (archive)
    if (!sub && req.method === 'DELETE') {
      try {
        await ts.assertProjectPermission(prisma, { projectId, orgId, userId, orgRole, level: 'owner' });
        await ts.store.archiveProject({ projectId });
        return jsonResponse(res, { success: true });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, err.status || 500);
      }
    }
    // GET /v1/projects/:id/members
    if (sub === 'members' && req.method === 'GET') {
      try {
        await ts.assertProjectPermission(prisma, { projectId, orgId, userId, orgRole, level: 'member' });
        const proj = await ts.store.getProject({ projectId, orgId });
        const rows = proj?.members || [];
        // Enrich with the member's ORG role + external flag so the UI can show
        // "Guest · external" distinctly from full org members.
        const ids = rows.map((m) => m.userId || m.user_id).filter(Boolean);
        const orgRows = ids.length
          ? await prisma.userOrganization.findMany({
              where: { userId: { in: ids }, orgId },
              select: { userId: true, role: true },
            }).catch(() => [])
          : [];
        const extRows = ids.length
          ? await prisma.userOrganization.groupBy({
              by: ['userId'],
              where: { userId: { in: ids }, isActive: true, NOT: { orgId } },
              _count: { _all: true },
            }).catch(() => [])
          : [];
        const orgRoleById = Object.fromEntries(orgRows.map((r) => [r.userId, r.role]));
        const extById = Object.fromEntries(extRows.map((r) => [r.userId, r._count._all]));
        return jsonResponse(res, {
          members: rows.map((m) => {
            const uid = m.userId || m.user_id;
            return { ...m, org_role: orgRoleById[uid] || null, is_external: (extById[uid] || 0) > 0 };
          }),
        });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, err.status || 500);
      }
    }
    // GET /v1/projects/:id/activity — recent memories + per-contributor
    // activity + project audit events. Member-gated (any project member sees
    // their project's activity; no org-admin requirement).
    if (sub === 'activity' && req.method === 'GET') {
      try {
        await ts.assertProjectPermission(prisma, { projectId, orgId, userId, orgRole, level: 'member' });
        const memWhere = {
          orgId, deletedAt: null,
          OR: [{ projectId }, { memoryProjects: { some: { projectId } } }],
        };
        const [recent, byUser, audits, totalMem] = await Promise.all([
          prisma.memory.findMany({ where: memWhere, select: { id: true, title: true, userId: true, createdAt: true, memoryType: true }, orderBy: { createdAt: 'desc' }, take: 15 }),
          prisma.memory.groupBy({ by: ['userId'], where: memWhere, _count: { _all: true }, _max: { createdAt: true } }),
          // resourceId is @db.Uuid — Prisma rejects string filters like
          // startsWith on it ("Unknown argument"), which silently killed this
          // whole activity feed. project_member rows store the plain project
          // uuid anyway, so exact match covers both types.
          prisma.auditLog.findMany({ where: { organizationId: orgId, resourceType: { in: ['project', 'project_member'] }, resourceId: projectId }, select: { eventType: true, action: true, userId: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 15 }).catch(() => []),
          prisma.memory.count({ where: memWhere }),
        ]);
        const uids = Array.from(new Set([...recent.map(m => m.userId), ...byUser.map(u => u.userId), ...audits.map(a => a.userId)].filter(Boolean)));
        const users = uids.length ? await prisma.user.findMany({ where: { id: { in: uids } }, select: { id: true, email: true, displayName: true } }) : [];
        const uMap = Object.fromEntries(users.map(u => [u.id, u]));
        const nameOf = (id) => uMap[id]?.displayName || uMap[id]?.email || (id ? `${id.slice(0, 8)}…` : 'system');
        return jsonResponse(res, {
          total_memories: totalMem,
          contributors: byUser
            .map(u => ({ user_id: u.userId, name: nameOf(u.userId), memory_count: u._count._all, last_activity: u._max.createdAt }))
            .sort((a, b) => new Date(b.last_activity) - new Date(a.last_activity)),
          recent_memories: recent.map(m => ({ id: m.id, title: m.title, by: nameOf(m.userId), type: m.memoryType, at: m.createdAt })),
          audit: audits.map(a => ({ event: a.eventType || a.action, by: nameOf(a.userId), at: a.createdAt })),
        });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, err.status || 500);
      }
    }
    // GET /v1/projects/:id/export — full project memory export (data
    // governance / enterprise offboarding). Project-owner or org-admin gated.
    if (sub === 'export' && req.method === 'GET') {
      try {
        await ts.assertProjectPermission(prisma, { projectId, orgId, userId, orgRole, level: 'owner' });
        const memories = await prisma.memory.findMany({
          where: {
            orgId, deletedAt: null,
            OR: [{ projectId }, { memoryProjects: { some: { projectId } } }],
          },
          select: {
            id: true, title: true, content: true, memoryType: true, tags: true,
            scope: true, userId: true, createdAt: true, updatedAt: true, isLatest: true,
          },
          orderBy: { createdAt: 'asc' },
          take: 5000,
        });
        audit({
          organizationId: orgId,
          userId,
          eventType: 'project.exported',
          eventCategory: 'data',
          action: 'read',
          resourceType: 'project',
          resourceId: projectId,
          newValue: { memory_count: memories.length },
          ..._reqMeta(req),
        });
        return jsonResponse(res, {
          project_id: projectId,
          project_name: project.name,
          exported_at: new Date().toISOString(),
          memory_count: memories.length,
          memories,
        });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, err.status || 500);
      }
    }
    // POST /v1/projects/:id/members
    const PROJECT_ROLES = ['owner', 'contributor', 'viewer'];
    if (sub === 'members' && req.method === 'POST') {
      try {
        // Any project member can bring in teammates (one-tap add / invite);
        // role changes + removals stay owner/admin-gated below.
        await ts.assertProjectPermission(prisma, { projectId, orgId, userId, orgRole, level: 'member' });
        const body = await parseBody(req);
        if (!body.user_id) return jsonResponse(res, { error: 'user_id required' }, 400);
        const role = body.role || 'contributor';
        if (!PROJECT_ROLES.includes(role)) {
          return jsonResponse(res, { error: `role must be one of ${PROJECT_ROLES.join('|')}` }, 400);
        }
        await requireSameOrganizationMember(prisma, { orgId, userId: body.user_id });
        const m = await ts.store.addProjectMember({
          projectId,
          userId: body.user_id,
          role,
          addedById: userId,
        });
        audit({
          organizationId: orgId,
          userId,
          eventType: 'project.member_added',
          eventCategory: 'auth',
          action: 'create',
          resourceType: 'project_member',
          resourceId: projectId,
          newValue: { role, member_user_id: body.user_id },
          ..._reqMeta(req),
        });
        await createWorkspaceNotification(prisma, {
          orgId, userId: body.user_id, type: 'project.member_added',
          title: `Added to ${project.name}`,
          body: 'You can now access this project and its shared memories.',
          resourceType: 'project', resourceId: projectId,
          dedupeKey: `project-member:${projectId}:${body.user_id}`,
        }).catch(() => null);
        return jsonResponse(res, { member: m }, 201);
      } catch (err) {
        return jsonResponse(res, { error: err.message }, err.status || 500);
      }
    }
    // PATCH /v1/projects/:id/members/:userId — change project-member role.
    const projMemberPatch = sub && sub.match(/^members\/([0-9a-f-]{36})$/);
    if (projMemberPatch && req.method === 'PATCH') {
      try {
        await ts.assertProjectPermission(prisma, { projectId, orgId, userId, orgRole, level: 'owner' });
        const targetUserId = projMemberPatch[1];
        const body = await parseBody(req);
        if (!body.role || !PROJECT_ROLES.includes(body.role)) {
          return jsonResponse(res, { error: `role must be one of ${PROJECT_ROLES.join('|')}` }, 400);
        }
        const updated = await prisma.projectMember.update({
          where: { projectId_userId: { projectId, userId: targetUserId } },
          data: { role: body.role },
        });
        audit({
          organizationId: orgId,
          userId,
          eventType: 'project.member_role_changed',
          eventCategory: 'auth',
          action: 'update',
          resourceType: 'project_member',
          resourceId: projectId,
          newValue: { role: body.role, member_user_id: targetUserId },
          ..._reqMeta(req),
        });
        return jsonResponse(res, { member: updated });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, err.status || 500);
      }
    }
    // DELETE /v1/projects/:id/members/:userId
    const projMemberDel = sub && sub.match(/^members\/([0-9a-f-]{36})$/);
    if (projMemberDel && req.method === 'DELETE') {
      try {
        await ts.assertProjectPermission(prisma, { projectId, orgId, userId, orgRole, level: 'owner' });
        await ts.store.removeProjectMember({ projectId, userId: projMemberDel[1] });
        audit({
          organizationId: orgId,
          userId,
          eventType: 'project.member_removed',
          eventCategory: 'auth',
          action: 'delete',
          resourceType: 'project_member',
          resourceId: projectId,
          newValue: { member_user_id: projMemberDel[1] },
          ..._reqMeta(req),
        });
        return jsonResponse(res, { success: true });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, err.status || 500);
      }
    }

    return jsonResponse(res, { error: 'Not found' }, 404);
  }

  // PATCH /v1/memories/:id/scope — change memory scope + team + projects
  const memoryScopeMatch = pathname.match(/^\/v1\/memories\/([0-9a-f-]{36})\/scope$/);
  if (memoryScopeMatch && req.method === 'PATCH') {
    const current = await requireSession(req, res);
    if (!current) return;
    const ts = await _getTeamStore();
    if (!ts) return jsonResponse(res, { error: 'Database unavailable' }, 503);
    const memoryId = memoryScopeMatch[1];
    const body = await parseBody(req);
    const userId = current.session.userId;
    const orgId = current.session.orgId;

    // Verify caller owns the memory or is org admin
    const memory = await prisma.memory.findFirst({ where: { id: memoryId } });
    if (!memory) return jsonResponse(res, { error: 'Memory not found' }, 404);
    const membership = await getOrgMembership(userId, orgId);
    const isOrgAdmin = membership?.role === 'owner' || membership?.role === 'admin';
    if (memory.userId !== userId && !isOrgAdmin) {
      return jsonResponse(res, { error: 'Forbidden' }, 403);
    }

    const VALID_SCOPES = new Set(['personal', 'project', 'team', 'organization']);
    const data = {};
    if (body.scope) {
      if (!VALID_SCOPES.has(body.scope)) {
        return jsonResponse(res, { error: 'Invalid scope' }, 400);
      }
      data.scope = body.scope;
    }
    if ('primary_team_id' in body) {
      data.primaryTeamId = body.primary_team_id || null;
    }
    if (Object.keys(data).length > 0) {
      await prisma.memory.update({ where: { id: memoryId }, data });
    }
    if (Array.isArray(body.project_ids)) {
      await ts.store.setMemoryProjects({
        memoryId,
        projectIds: body.project_ids,
        addedById: userId,
      });
    }
    const updated = await prisma.memory.findUnique({
      where: { id: memoryId },
      include: { memoryProjects: { include: { project: true } } },
    });
    audit({
      organizationId: orgId, userId,
      eventType: 'memory.scope_changed', eventCategory: 'memory', action: 'update',
      resourceType: 'memory', resourceId: memoryId,
      oldValue: { scope: memory.scope, primary_team_id: memory.primaryTeamId },
      newValue: { scope: updated.scope, primary_team_id: updated.primaryTeamId,
                   project_ids: (updated.memoryProjects || []).map(mp => mp.projectId) },
      ..._reqMeta(req),
    });
    return jsonResponse(res, { memory: updated });
  }

  // ─── End Teams & Projects ─────────────────────────────────

  // ─── Audit + DSR (Compliance) ────────────────────────────
  // GET /v1/audit/logs — org_admin or compliance_admin
  if (pathname === '/v1/audit/logs' && req.method === 'GET') {
    const current = await requireSession(req, res);
    if (!current) return;
    const callerMem = await getOrgMembership(current.session.userId, current.session.orgId);
    if (!callerMem) return jsonResponse(res, { error: 'Organization membership not found' }, 404);
    try {
      const auditLogger = await _getAuditLogger();
      assertPermission(req, { resource: 'audit', action: 'read' }, {
        userRoles: effectiveRoles(callerMem),
        orgId: current.session.orgId,
        userId: current.session.userId,
        auditLogger,
      });
    } catch (permErr) {
      return jsonResponse(res, { error: permErr.error || 'Forbidden' }, permErr.status || 403);
    }
    const audit = await _getAuditLogger();
    if (!audit) return jsonResponse(res, { error: 'Audit unavailable' }, 503);
    try {
      const result = await audit.query({
        organizationId: current.session.orgId,
        userId: url.searchParams.get('user_id') || undefined,
        eventCategory: url.searchParams.get('category') || undefined,
        action: url.searchParams.get('action') || undefined,
        resourceType: url.searchParams.get('resource_type') || undefined,
        from: url.searchParams.get('from') || undefined,
        to: url.searchParams.get('to') || undefined,
        limit: parseInt(url.searchParams.get('limit') || '50', 10),
        offset: parseInt(url.searchParams.get('offset') || '0', 10),
      });
      return jsonResponse(res, result);
    } catch (err) {
      return jsonResponse(res, { error: err.message }, 500);
    }
  }

  // GET /v1/audit/export.csv — streaming CSV (org_admin or compliance_admin)
  if (pathname === '/v1/audit/export.csv' && req.method === 'GET') {
    const current = await requireSession(req, res);
    if (!current) return;
    const callerMem2 = await getOrgMembership(current.session.userId, current.session.orgId);
    if (!callerMem2) return jsonResponse(res, { error: 'Organization membership not found' }, 404);
    try {
      const auditLogger = await _getAuditLogger();
      assertPermission(req, { resource: 'audit', action: 'export' }, {
        userRoles: effectiveRoles(callerMem2),
        orgId: current.session.orgId,
        userId: current.session.userId,
        auditLogger,
      });
    } catch (permErr) {
      return jsonResponse(res, { error: permErr.error || 'Forbidden' }, permErr.status || 403);
    }
    const orgId = current.session.orgId;
    const filters = {
      organizationId: orgId,
      userId: url.searchParams.get('user_id') || undefined,
      action: url.searchParams.get('action') || undefined,
      eventType: url.searchParams.get('event_type') || undefined,
      from: url.searchParams.get('from') ? new Date(url.searchParams.get('from')) : undefined,
      to: url.searchParams.get('to') ? new Date(url.searchParams.get('to')) : undefined,
    };
    const safeDate = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="audit-${orgId}-${safeDate}.csv"`);
    res.writeHead(200);
    res.write([
      'id', 'created_at', 'org_id', 'user_id', 'actor_type', 'event_type',
      'event_category', 'action', 'resource_type', 'resource_id',
      'ip_address', 'user_agent', 'metadata_json', 'request_id'
    ].join(',') + '\n');

    const esc = v => {
      if (v == null) return '';
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };

    let cursor = null;
    const where = {
      organizationId: orgId,
      userId: filters.userId,
      action: filters.action,
      eventType: filters.eventType,
      createdAt: (filters.from || filters.to)
        ? { gte: filters.from, lte: filters.to }
        : undefined,
    };
    try {
      while (true) {
        const batch = await prisma.auditLog.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: 500,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        });
        if (batch.length === 0) break;
        for (const r of batch) {
          res.write([
            r.id,
            r.createdAt?.toISOString?.() || '',
            r.organizationId || '',
            r.userId || '',
            r.actorType || '',
            r.eventType || '',
            r.eventCategory || '',
            r.action || '',
            r.resourceType || '',
            r.resourceId || '',
            r.ipAddress || '',
            esc(r.userAgent || ''),
            esc(r.metadata || {}),
            r.requestId || '',
          ].map(esc).join(',') + '\n');
        }
        if (batch.length < 500) break;
        cursor = batch[batch.length - 1].id;
      }
    } catch (err) {
      console.error('[audit-export] failed:', err.message);
    }
    res.end();
    return;
  }

  // ── DSR: data export for a user (GDPR right to portability) ──
  // GET /v1/dsr/user/:userId/export — JSON dump of memories + audit
  const dsrExportMatch = pathname.match(/^\/v1\/dsr\/user\/([0-9a-f-]{36})\/export$/);
  if (dsrExportMatch && req.method === 'GET') {
    const current = await requireSession(req, res);
    if (!current) return;
    const targetUserId = dsrExportMatch[1];
    const isSelf = targetUserId === current.session.userId;
    const orgId = current.session.orgId;
    if (!isSelf) {
      const admin = await requireOrgAdmin(req, res, current.session.userId, orgId);
      if (!admin) return;
    }
    try {
      const [memories, auditRows] = await Promise.all([
        prisma.memory.findMany({
          where: { userId: targetUserId, deletedAt: null },
          orderBy: { createdAt: 'asc' },
          take: 10000,
        }),
        prisma.auditLog.findMany({
          where: { userId: targetUserId },
          orderBy: { createdAt: 'asc' },
          take: 5000,
        }),
      ]);
      audit({
        organizationId: orgId, userId: current.session.userId,
        eventType: 'dsr.export', eventCategory: 'compliance', action: 'export',
        resourceType: 'user', resourceId: targetUserId,
        metadata: { target_user_id: targetUserId, memories_count: memories.length },
        ..._reqMeta(req),
      });
      return jsonResponse(res, {
        user_id: targetUserId,
        exported_at: new Date().toISOString(),
        memories,
        audit_logs: auditRows,
      });
    } catch (err) {
      return jsonResponse(res, { error: err.message }, 500);
    }
  }

  // POST /v1/dsr/user/:userId/erasure — soft-delete user memories
  const dsrErasureMatch = pathname.match(/^\/v1\/dsr\/user\/([0-9a-f-]{36})\/erasure$/);
  if (dsrErasureMatch && req.method === 'POST') {
    const current = await requireSession(req, res);
    if (!current) return;
    const targetUserId = dsrErasureMatch[1];
    const orgId = current.session.orgId;
    const admin = await requireOrgAdmin(req, res, current.session.userId, orgId);
    if (!admin) return;
    try {
      const result = await prisma.memory.updateMany({
        where: { userId: targetUserId, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      audit({
        organizationId: orgId, userId: current.session.userId,
        eventType: 'dsr.erasure', eventCategory: 'compliance', action: 'delete',
        resourceType: 'user', resourceId: targetUserId,
        metadata: { target_user_id: targetUserId, memories_soft_deleted: result.count },
        ..._reqMeta(req),
      });
      return jsonResponse(res, {
        target_user_id: targetUserId,
        memories_soft_deleted: result.count,
        retention_days: 30,
        note: 'Soft-deleted; permanent purge after 30 days via retention cron.',
      });
    } catch (err) {
      return jsonResponse(res, { error: err.message }, 500);
    }
  }
  // ─── End Audit + DSR ─────────────────────────────────────

  // ─── Digital Employees ───────────────────────────────────
  // ─── Operating Rooms ─────────────────────────────────────
  // Reuses HyperRoom as the durable room envelope. RealtimeKit owns only the
  // live media session; authenticated HIVEMIND identity and transcript state
  // remain tenant-scoped in Postgres.
  if (pathname.startsWith('/v1/operating-rooms') && process.env.OPERATING_ROOMS_V1 !== 'true') {
    return jsonResponse(res, { error: 'not_found' }, 404);
  }
  if (pathname === '/v1/operating-rooms' && req.method === 'GET') {
    const current = await requireSession(req, res);
    if (!current) return;
    try {
      const rooms = await prisma.hyperRoom.findMany({
        where: { orgId: current.session.orgId, roomMode: 'operating', archivedAt: null },
        orderBy: { updatedAt: 'desc' },
        take: 50,
      });
      return jsonResponse(res, { rooms: rooms.map(roomProjection) });
    } catch (error) {
      return jsonResponse(res, { error: 'operating_room_list_failed', message: error.message }, 500);
    }
  }

  if (pathname === '/v1/operating-rooms' && req.method === 'POST') {
    const current = await requireSession(req, res);
    if (!current) return;
    const membership = await getOrgMembership(current.session.userId, current.session.orgId);
    if (!membership?.isActive) return jsonResponse(res, { error: 'organization_membership_required' }, 403);
    const body = await parseBody(req);
    const name = normalizeRoomText(body.name || 'Company Operating Room', 120);
    const goal = normalizeRoomText(body.goal || 'Understand the company and coordinate the next best actions.', 1200);
    try {
      const meeting = await createRealtimeMeeting({ title: name });
      const room = await prisma.hyperRoom.create({
        data: {
          userId: current.session.userId,
          orgId: current.session.orgId,
          name,
          goal,
          template: 'facilitated_voice',
          roomTag: 'general',
          roomMode: 'operating',
          roomPlaybook: {
            schema_version: 1,
            status: 'open',
            media_provider: 'cloudflare-realtimekit',
            meeting_id: meeting.id,
            participants: [],
            transcript: [],
          },
        },
      });
      return jsonResponse(res, { room: roomProjection(room) }, 201);
    } catch (error) {
      return jsonResponse(res, { error: error.code || 'operating_room_create_failed', message: error.message }, error.status || 500);
    }
  }

  const operatingRoomMatch = pathname.match(/^\/v1\/operating-rooms\/([0-9a-f-]{36})(?:\/(join|transcript|close))?$/i);
  if (operatingRoomMatch) {
    const current = await requireSession(req, res);
    if (!current) return;
    const room = await prisma.hyperRoom.findFirst({
      where: { id: operatingRoomMatch[1], orgId: current.session.orgId, roomMode: 'operating', archivedAt: null },
    });
    if (!room) return jsonResponse(res, { error: 'operating_room_not_found' }, 404);
    const membership = await getOrgMembership(current.session.userId, current.session.orgId);
    if (!membership?.isActive) return jsonResponse(res, { error: 'organization_membership_required' }, 403);
    const action = operatingRoomMatch[2];
    const state = room.roomPlaybook && typeof room.roomPlaybook === 'object' ? room.roomPlaybook : {};

    if (!action && req.method === 'GET') return jsonResponse(res, { room: roomProjection(room) });

    if (action === 'join' && req.method === 'POST') {
      if (!state.meeting_id) return jsonResponse(res, { error: 'operating_room_media_unavailable' }, 503);
      try {
        const verifiedName = normalizeRoomText(membership.user?.displayName || membership.user?.email?.split('@')[0] || 'Member', 120);
        const existingParticipant = await prisma.operatingRoomParticipant.findUnique({
          where: { roomId_userId: { roomId: room.id, userId: current.session.userId } },
        });
        let participant;
        if (existingParticipant?.realtimeParticipantId) {
          participant = await refreshRealtimeParticipant({ meetingId: state.meeting_id, participantId: existingParticipant.realtimeParticipantId });
        } else {
          participant = await addRealtimeParticipant({
            meetingId: state.meeting_id,
            userId: current.session.userId,
            name: verifiedName,
            isHost: membership.role === 'owner' || membership.role === 'admin',
          });
        }
        const identity = { user_id: current.session.userId, name: verifiedName, role: membership.role || 'member' };
        await prisma.operatingRoomParticipant.upsert({
          where: { roomId_userId: { roomId: room.id, userId: identity.user_id } },
          create: {
            roomId: room.id,
            orgId: room.orgId,
            userId: identity.user_id,
            name: identity.name,
            role: identity.role,
            realtimeParticipantId: participant.id || null,
          },
          update: { name: identity.name, role: identity.role, realtimeParticipantId: participant.id || undefined },
        });
        const durableRoster = await prisma.operatingRoomParticipant.findMany({
          where: { roomId: room.id, orgId: room.orgId },
          orderBy: [{ joinedAt: 'asc' }, { userId: 'asc' }],
        });
        const participants = durableRoster.map((entry) => ({ user_id: entry.userId, name: entry.name, role: entry.role }));
        await prisma.hyperRoom.update({
          where: { id: room.id },
          data: { roomPlaybook: { ...state, participants, status: 'live' } },
        });
        return jsonResponse(res, {
          room: { ...roomProjection(room), status: 'live', participants },
          participant: identity,
          auth_token: participant.token || participant.auth_token,
          room_name: state.meeting_id,
        });
      } catch (error) {
        return jsonResponse(res, { error: error.code || 'operating_room_join_failed', message: error.message }, error.status || 500);
      }
    }

    if (action === 'transcript' && req.method === 'POST') {
      const body = await parseBody(req);
      const text = normalizeRoomText(body.text, 4000);
      if (!text) return jsonResponse(res, { error: 'transcript_text_required' }, 400);
      const wake = wakeIntent(text);
      const durableSpeaker = await prisma.operatingRoomParticipant.findUnique({
        where: { roomId_userId: { roomId: room.id, userId: current.session.userId } },
      });
      const verified = durableSpeaker ? {
        user_id: durableSpeaker.userId,
        name: durableSpeaker.name,
        role: durableSpeaker.role,
      } : {
        user_id: current.session.userId,
        name: normalizeRoomText(membership.user?.displayName || 'Member', 120),
        role: membership.role || 'member',
      };
      const persisted = await prisma.operatingRoomEvent.create({
        data: {
          roomId: room.id,
          orgId: room.orgId,
          speakerUserId: verified.user_id,
          speakerName: verified.name,
          speakerRole: verified.role,
          text,
          addressed: wake.addressed,
        },
      });
      const [durableRoster, recentDesc] = await Promise.all([
        prisma.operatingRoomParticipant.findMany({ where: { roomId: room.id, orgId: room.orgId }, orderBy: [{ joinedAt: 'asc' }, { userId: 'asc' }] }),
        prisma.operatingRoomEvent.findMany({ where: { roomId: room.id, orgId: room.orgId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 10 }),
      ]);
      const roster = durableRoster.map((entry) => ({ user_id: entry.userId, name: entry.name, role: entry.role }));
      const transcript = recentDesc.reverse().map((entry) => ({ speaker_name: entry.speakerName, speaker_role: entry.speakerRole, text: entry.text, at: entry.createdAt }));
      await prisma.hyperRoom.update({ where: { id: room.id }, data: { roomPlaybook: { ...state, participants: roster, status: 'live' } } });
      const turn = { id: persisted.id, speaker_user_id: verified.user_id, speaker_name: verified.name, speaker_role: verified.role, text, at: persisted.createdAt };
      return jsonResponse(res, {
        accepted: true,
        turn,
        addressed_to_hivemind: wake.addressed,
        query: wake.query,
        context: wake.addressed ? compactRoomContext({ room, roster, transcript, speaker: verified }) : undefined,
      });
    }

    if (action === 'close' && req.method === 'POST') {
      const admin = await requireOrgAdmin(req, res, current.session.userId, current.session.orgId);
      if (!admin) return;
      const [transcriptRows, participantRows] = await Promise.all([
        prisma.operatingRoomEvent.findMany({ where: { roomId: room.id, orgId: room.orgId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
        prisma.operatingRoomParticipant.findMany({ where: { roomId: room.id, orgId: room.orgId }, orderBy: [{ joinedAt: 'asc' }, { userId: 'asc' }] }),
      ]);
      const transcript = transcriptRows.map((entry) => ({
        speaker_user_id: entry.speakerUserId,
        speaker_name: entry.speakerName,
        speaker_role: entry.speakerRole,
        text: entry.text,
        at: entry.createdAt,
      }));
      if (!transcript.length) return jsonResponse(res, { error: 'operating_room_transcript_empty' }, 409);
      const transcriptText = transcript.map((turn) => `${turn.speaker_name}: ${turn.text}`).join('\n');
      const speakers = transcript.map((turn) => ({
        speaker: turn.speaker_name,
        speaker_user_id: turn.speaker_user_id,
        role: turn.speaker_role,
        text: turn.text,
        at: turn.at,
      }));
      await prisma.$transaction([
        prisma.meetingSession.upsert({
          where: { id: room.id },
          create: {
            id: room.id,
            orgId: room.orgId,
            userId: room.userId,
            status: 'recording',
            consentRecorded: true,
            expectedSegments: 1,
          },
          update: { consentRecorded: true, expectedSegments: 1 },
        }),
        prisma.meetingSegment.upsert({
          where: { sessionId_idx: { sessionId: room.id, idx: 0 } },
          create: {
            sessionId: room.id,
            orgId: room.orgId,
            userId: room.userId,
            idx: 0,
            text: transcriptText,
            speakers,
            status: 'transcribed',
          },
          update: { text: transcriptText, speakers, status: 'transcribed' },
        }),
      ]);
      await queueMeetingFinalization(prisma, {
        sessionId: room.id,
        orgId: room.orgId,
        userId: room.userId,
        expectedSegments: 1,
        payload: {
          title: room.name,
          notes: room.goal || '',
          participants: participantRows.map((entry) => ({ user_id: entry.userId, name: entry.name, role: entry.role })),
          speaker_count: participantRows.length,
          scope: 'organization',
          operating_room_id: room.id,
        },
      });
      const updated = await prisma.hyperRoom.update({
        where: { id: room.id },
        data: { roomPlaybook: { ...state, status: 'finalizing', meeting_session_id: room.id, closed_at: new Date().toISOString() }, archivedAt: new Date() },
      });
      return jsonResponse(res, { room: roomProjection(updated) });
    }

    return jsonResponse(res, { error: 'method_not_allowed' }, 405);
  }

  // Lazy-init EmployeeStore + audit logger
  const _getEmployeeStore = async () => {
    if (!prisma) return null;
    if (!_getEmployeeStore._cache) {
      const mod = await import('./employees/store.js');
      _getEmployeeStore._cache = new mod.EmployeeStore(prisma);
    }
    return _getEmployeeStore._cache;
  };

  // Fire-and-forget POST to hm-employees:8060/admin/reload so the sidecar
  // refetches the bootstrap snapshot immediately rather than waiting 30s
  // for the next reconcile tick. Best-effort: never blocks the response.
  function _notifyEmployeesReload() {
    const url = process.env.HIVEMIND_EMPLOYEES_URL || 'http://hm-employees:8060';
    const masterKey = process.env.HIVEMIND_MASTER_API_KEY || '';
    setImmediate(async () => {
      try {
        const resp = await fetch(`${url}/admin/reload`, {
          method: 'POST',
          headers: { 'X-Admin-Token': masterKey },
          // 3s timeout — sidecar may not be running yet in dev
          signal: AbortSignal.timeout(3000),
        });
        if (!resp.ok) {
          console.warn('[employees.reload] sidecar returned', resp.status);
        }
      } catch (err) {
        // Silent in dev (sidecar not running); log in prod
        if (process.env.NODE_ENV === 'production') {
          console.warn('[employees.reload] failed:', err.message);
        }
      }
    });
  }

  // GET /v1/employees — list employees the caller can see in current org
  if (pathname === '/v1/employees' && req.method === 'GET') {
    const current = await requireSession(req, res);
    if (!current) return;
    const store = await _getEmployeeStore();
    if (!store) return jsonResponse(res, { error: 'Database unavailable' }, 503);
    try {
      const ts = await _getTeamStore();
      const teamIds = ts
        ? await ts.store.accessibleTeamIds({
            userId: current.session.userId,
            orgId: current.session.orgId,
          })
        : [];
      const membership = await getOrgMembership(current.session.userId, current.session.orgId);
      const isOrgAdmin = membership?.role === 'owner' || membership?.role === 'admin';
      const employees = isOrgAdmin
        ? await store.listForOrg({ orgId: current.session.orgId })
        : await store.listForUserScope({
            userId: current.session.userId,
            orgId: current.session.orgId,
            teamIds,
          });
      const { enrichEmployeesWithHyperState } = await import('./employees/hyper-state.js');
      const enrichedEmployees = await enrichEmployeesWithHyperState(employees);
      return jsonResponse(res, { employees: enrichedEmployees });
    } catch (err) {
      return jsonResponse(res, { error: err.message }, 500);
    }
  }

  // ─── OAuth client registry (CRUD for org-admins) ─────────────
  // Backs the same prisma.metaParameter['oauth_client_registry'] row that
  // core/src/server.js reads. Used to register ChatGPT's callback URL,
  // Claude Desktop, CLI, browser-extension custom clients, etc.
  if (pathname === '/v1/oauth/clients' && req.method === 'GET') {
    const current = await requireSession(req, res);
    if (!current) return;
    const admin = await requireOrgAdmin(req, res, current.session.userId, current.session.orgId);
    if (!admin) return;
    try {
      const row = await prisma.metaParameter.findUnique({ where: { key: 'oauth_client_registry' } });
      const clients = Array.isArray(row?.value) ? row.value : [];
      return jsonResponse(res, {
        clients: clients.map((c) => ({
          client_id: c.client_id,
          client_name: c.client_name || c.client_id,
          redirect_uris: c.redirect_uris || [],
          allowed_scopes: c.allowed_scopes || [],
          is_public: c.is_public !== false,
          status: c.status || 'active',
          created_at: c.created_at || null,
          created_by: c.created_by || null,
        })),
      });
    } catch (err) {
      return jsonResponse(res, { error: err.message }, 500);
    }
  }

  if (pathname === '/v1/oauth/clients' && req.method === 'POST') {
    const current = await requireSession(req, res);
    if (!current) return;
    const admin = await requireOrgAdmin(req, res, current.session.userId, current.session.orgId);
    if (!admin) return;
    const body = await parseBody(req);
    const clientName = String(body?.client_name || '').trim();
    const redirectUris = Array.isArray(body?.redirect_uris)
      ? body.redirect_uris.map((u) => String(u || '').trim()).filter(Boolean)
      : [];
    if (!clientName) return jsonResponse(res, { error: 'client_name is required' }, 400);
    if (redirectUris.length === 0) return jsonResponse(res, { error: 'at least one redirect_uri is required' }, 400);
    // Sanity-check URIs
    for (const uri of redirectUris) {
      try {
        const u = new URL(uri);
        if (!/^https?:$/.test(u.protocol)) {
          return jsonResponse(res, { error: `redirect_uri must be http(s): ${uri}` }, 400);
        }
      } catch {
        return jsonResponse(res, { error: `invalid redirect_uri: ${uri}` }, 400);
      }
    }
    const allowedScopesRaw = Array.isArray(body?.allowed_scopes) && body.allowed_scopes.length
      ? body.allowed_scopes
      : ['memory:read', 'memory:write', 'web:search'];
    const allowedScopes = allowedScopesRaw.map((s) => String(s).trim()).filter(Boolean);

    try {
      const crypto = await import('node:crypto');
      const clientId = 'hmc_' + crypto.randomBytes(12).toString('hex');
      // Confidential client (default) → mint client_secret for ChatGPT GPT
      // Actions OAuth (which requires Client Secret). Public flag set true
      // only when caller explicitly opts out (e.g. CLI / extension PKCE).
      const confidential = body?.confidential !== false;
      const clientSecret = confidential ? ('hms_' + crypto.randomBytes(24).toString('hex')) : null;
      const clientSecretHash = clientSecret
        ? crypto.createHash('sha256').update(clientSecret).digest('hex')
        : null;
      const newClient = {
        client_id: clientId,
        client_name: clientName,
        redirect_uris: redirectUris,
        allowed_scopes: allowedScopes,
        is_public: !confidential,
        client_secret_hash: clientSecretHash,
        status: 'active',
        created_at: new Date().toISOString(),
        created_by: current.session.userId,
        org_id: current.session.orgId,
      };
      // Read-modify-write the registry row.
      const row = await prisma.metaParameter.findUnique({ where: { key: 'oauth_client_registry' } });
      const existing = Array.isArray(row?.value) ? row.value : [];
      const next = [...existing, newClient];
      await prisma.metaParameter.upsert({
        where: { key: 'oauth_client_registry' },
        update: { value: next },
        create: { key: 'oauth_client_registry', value: next },
      });
      // Best-effort cache bust on core — fire-and-forget HEAD to nudge it
      // (cache TTL is 60s anyway, so this is just to make UI feel instant).
      try {
        await fetch(`${CONFIG.coreApiBaseUrl}/.well-known/oauth-protected-resource`, {
          method: 'GET',
          headers: { 'X-Cache-Bust': '1' },
        });
      } catch {}
      audit({
        organizationId: current.session.orgId,
        userId: current.session.userId,
        eventType: 'oauth.client_registered',
        eventCategory: 'oauth',
        action: 'create',
        resourceType: 'oauth_client',
        resourceId: clientId,
        newValue: { client_name: clientName, redirect_uris: redirectUris, allowed_scopes: allowedScopes, confidential },
        ..._reqMeta(req),
      });
      // Strip the hash from the response; include the raw secret ONCE so
      // the operator can paste it into ChatGPT before it disappears.
      const { client_secret_hash, ...safeClient } = newClient;
      return jsonResponse(res, {
        client: safeClient,
        client_secret: clientSecret,        // one-time — never returned again
        secret_warning: clientSecret
          ? 'Copy this client_secret now. It will not be shown again. HIVEMIND only stores a SHA-256 hash.'
          : null,
      }, 201);
    } catch (err) {
      return jsonResponse(res, { error: err.message }, 500);
    }
  }

  // DELETE /v1/oauth/clients/:client_id
  const oauthDeleteMatch = pathname.match(/^\/v1\/oauth\/clients\/([a-zA-Z0-9_-]+)$/);
  if (oauthDeleteMatch && req.method === 'DELETE') {
    const current = await requireSession(req, res);
    if (!current) return;
    const admin = await requireOrgAdmin(req, res, current.session.userId, current.session.orgId);
    if (!admin) return;
    const clientId = oauthDeleteMatch[1];
    try {
      const row = await prisma.metaParameter.findUnique({ where: { key: 'oauth_client_registry' } });
      const existing = Array.isArray(row?.value) ? row.value : [];
      const target = existing.find((c) => c.client_id === clientId);
      if (!target) return jsonResponse(res, { error: 'client not found' }, 404);
      // Only allow deleting clients created by this org (or any if owner is master).
      if (target.org_id && target.org_id !== current.session.orgId) {
        return jsonResponse(res, { error: 'forbidden — client belongs to another org' }, 403);
      }
      const next = existing.filter((c) => c.client_id !== clientId);
      await prisma.metaParameter.update({
        where: { key: 'oauth_client_registry' },
        data: { value: next },
      });
      audit({
        organizationId: current.session.orgId,
        userId: current.session.userId,
        eventType: 'oauth.client_revoked',
        eventCategory: 'oauth',
        action: 'delete',
        resourceType: 'oauth_client',
        resourceId: clientId,
        oldValue: { client_name: target.client_name },
        ..._reqMeta(req),
      });
      return jsonResponse(res, { success: true });
    } catch (err) {
      return jsonResponse(res, { error: err.message }, 500);
    }
  }

  // POST /v1/employees/optimize-persona — LLM expands a short brief into a
  // full persona system-prompt so the create-employee UI can stay one-step.
  // Inputs: brief (required), name, age, gender, role, team, experience_years
  // Output: { persona: "<system prompt>" }
  if (pathname === '/v1/employees/optimize-persona' && req.method === 'POST') {
    const current = await requireSession(req, res);
    if (!current) return;
    const body = await parseBody(req);
    const brief = (body.brief || '').trim();
    if (!brief) return jsonResponse(res, { error: 'brief is required' }, 400);
    const name = (body.name || '').trim() || 'the employee';
    const role = (body.role || '').trim() || 'generalist';
    const team = (body.team || '').trim();
    const age = body.age || null;
    const gender = (body.gender || '').trim();
    const exp = body.experience_years ?? 0;

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) return jsonResponse(res, { error: 'GROQ_API_KEY not configured' }, 503);

    // Org-ground the persona (best-effort): pull the company's own business context from HIVEMIND so a
    // marketplace profession is tuned to THIS org (not a generic role) — the "closest profession" edge.
    // Triggered by ground_org (the marketplace hire flow sets it). Never blocks persona generation.
    let orgContext = '';
    if (body.ground_org) {
      try {
        const rr = await fetch(`${CONFIG.coreApiBaseUrl}/api/recall`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-API-Key': getInternalApiKey() },
          body: JSON.stringify({ query_context: 'company business, industry, products, market, brand, strategy', org_id: current.session.orgId, user_id: current.session.userId, max_memories: 6 }),
        });
        if (rr.ok) {
          const rd = await rr.json().catch(() => ({}));
          const mems = rd.memories || rd.results || rd.context || [];
          const facts = (Array.isArray(mems) ? mems : []).map((m) => (m.content || m.summary || m.text || '')).filter(Boolean).slice(0, 6);
          if (facts.length) orgContext = facts.join(' | ').slice(0, 1200);
        }
      } catch { /* best-effort — fall back to a non-org-grounded persona */ }
    }

    const sys = `You write concise, human-sounding system prompts for AI digital employees. Output ONLY the persona system-prompt as plain text — no preamble, no markdown, no headers. 3-6 sentences. Address the employee in second person ("You are ..."). Include: role, communication style, what they prioritise, and one tasteful quirk. Reflect the requested age/gender/experience subtly through voice, not biography.${orgContext ? ' If COMPANY CONTEXT is provided, GROUND the persona in that company\'s real domain, market, and products — make this a specialist for THIS company, not a generic role (do not invent facts beyond the context).' : ''}`;
    const user = `Brief: ${brief}
Name: ${name}
Role: ${role}${team ? `\nTeam: ${team}` : ''}${age ? `\nAge: ${age}` : ''}${gender ? `\nGender: ${gender}` : ''}
Experience years: ${exp}${orgContext ? `\n\nCOMPANY CONTEXT (tune the persona to this company):\n${orgContext}` : ''}

Write the persona now.`;

    try {
      const r = await groqFetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
          temperature: 0.6,
          max_tokens: 400,
        }),
      });
      if (!r.ok) {
        const errBody = await r.text().catch(() => '');
        return jsonResponse(res, { error: `Groq error: ${r.status} ${errBody.slice(0, 200)}` }, 502);
      }
      const data = await r.json();
      const persona = (data.choices?.[0]?.message?.content || '').trim();
      if (!persona) return jsonResponse(res, { error: 'empty persona' }, 502);
      return jsonResponse(res, { persona });
    } catch (err) {
      return jsonResponse(res, { error: err.message }, 500);
    }
  }

  // POST /v1/marketplace/rank-professions — rank a field's professions by relevance to THIS org.
  // Recalls the company's business → LLM ranks + gives a short why-fits each. Best-effort: on any
  // failure (no key, no org context, bad JSON) it returns the input order with no why_fits. Powers
  // the marketplace "closest professions" view. Validates titles (never invents a profession).
  if (pathname === '/v1/marketplace/rank-professions' && req.method === 'POST') {
    const current = await requireSession(req, res);
    if (!current) return;
    const body = await parseBody(req);
    const field = (body.field || '').trim();
    const profs = Array.isArray(body.professions) ? body.professions.filter((p) => p && p.title).slice(0, 12) : [];
    const passthrough = () => jsonResponse(res, { ranked: profs.map((p) => ({ title: p.title })), org_grounded: false });
    if (!field || !profs.length) return passthrough();
    const apiKey = process.env.GROQ_API_KEY;
    let orgContext = '';
    try {
      const rr = await fetch(`${CONFIG.coreApiBaseUrl}/api/recall`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': getInternalApiKey() },
        body: JSON.stringify({ query_context: `company business, industry, ${field} needs, products, market`, org_id: current.session.orgId, user_id: current.session.userId, max_memories: 6 }),
      });
      if (rr.ok) {
        const rd = await rr.json().catch(() => ({}));
        const mems = rd.memories || rd.results || rd.context || [];
        orgContext = (Array.isArray(mems) ? mems : []).map((m) => (m.content || m.summary || m.text || '')).filter(Boolean).slice(0, 6).join(' | ').slice(0, 1200);
      }
    } catch { /* best-effort */ }
    if (!orgContext || !apiKey) return passthrough();
    const sys = `You rank professions by relevance to a SPECIFIC company. Output ONLY JSON: {"ranked":[{"title":"<exact input title>","why_fits":"<=8 words tying it to THIS company>"}]}. Include EVERY input title exactly once, ordered most→least relevant to the company. why_fits must reference the company's real domain — no generic filler.`;
    const user = `COMPANY CONTEXT:\n${orgContext}\n\nFIELD: ${field}\nPROFESSIONS:\n${profs.map((p) => `- ${p.title}: ${p.blurb || ''}`).join('\n')}\n\nRank now.`;
    try {
      const r = await groqFetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], temperature: 0.3, max_tokens: 600, response_format: { type: 'json_object' } }),
      });
      if (r.ok) {
        const d = await r.json();
        const parsed = JSON.parse(d.choices?.[0]?.message?.content || '{}');
        const ranked = Array.isArray(parsed.ranked) ? parsed.ranked : [];
        const known = new Set(profs.map((p) => p.title));
        const seen = new Set();
        const out = [];
        for (const x of ranked) {
          if (x && known.has(x.title) && !seen.has(x.title)) { out.push({ title: x.title, why_fits: String(x.why_fits || '').slice(0, 90) }); seen.add(x.title); }
        }
        for (const p of profs) if (!seen.has(p.title)) out.push({ title: p.title });  // append any the LLM dropped
        return jsonResponse(res, { ranked: out, org_grounded: true });
      }
    } catch { /* fall through to passthrough */ }
    return passthrough();
  }

  // POST /v1/employees — create (org_admin only)
  if (pathname === '/v1/employees' && req.method === 'POST') {
    const current = await requireSession(req, res);
    if (!current) return;
    const admin = await requireOrgAdmin(req, res, current.session.userId, current.session.orgId);
    if (!admin) return;
    const store = await _getEmployeeStore();
    if (!store) return jsonResponse(res, { error: 'Database unavailable' }, 503);
    const body = await parseBody(req);
    if (!body.name || !body.persona) {
      return jsonResponse(res, { error: 'name and persona are required' }, 400);
    }
    try {
      const emp = await store.create({
        orgId: current.session.orgId,
        teamId: body.team_id || null,
        name: body.name,
        persona: body.persona,
        model: body.model,
        llmProvider: body.llm_provider,
        scope: body.scope,
        slackTeamId: body.slack_team_id,
        slackChannelsAllowed: body.slack_channels_allowed,
        tools: body.tools,
        policyRules: body.policy_rules,
        replicas: body.replicas,
        maxReplicas: body.max_replicas,
        avatarUrl: body.avatar_url,
        slackDisplayName: body.slack_display_name,
        slackAvatarEmoji: body.slack_avatar_emoji,
        roleArchetype: body.role_archetype,
        peerReviewTargets: body.peer_review_targets,
        createdBy: current.session.userId,
      });

      // Mint scoped API key + encrypt + persist so Python sidecar can
      // bootstrap without per-employee env vars.
      try {
        const crypto = await import('node:crypto');
        const raw = 'hmk_emp_' + crypto.randomBytes(24).toString('hex');
        const keyHash = crypto.createHash('sha256').update(raw).digest('hex');
        const apiKey = await prisma.apiKey.create({
          data: {
            userId: current.session.userId,
            orgId: current.session.orgId,
            name: `${emp.name} (employee)`,
            keyHash,
            keyPrefix: raw.slice(0, 12),
            scopes: ['memory:read', 'memory:write', 'mcp', 'slack:act'],
            isActive: true,
          },
        });
        const { encryptToken } = await import('./connectors/framework/connector-store.js');
        const encrypted = encryptToken(raw);
        await store.setScopedApiKey({ id: emp.id, apiKeyId: apiKey.id, encryptedKey: encrypted });
      } catch (mintErr) {
        console.warn('[employees.create] scoped key mint failed:', mintErr.message);
      }

      // Fire-and-forget hot-reload to the sidecar (skip in dev when host
      // can't reach the docker network)
      _notifyEmployeesReload();

      audit({
        organizationId: current.session.orgId,
        userId: current.session.userId,
        eventType: 'employee.created',
        eventCategory: 'employee',
        action: 'create',
        resourceType: 'digital_employee',
        resourceId: emp.id,
        newValue: { name: emp.name, slug: emp.slug, scope: emp.scope, model: emp.model },
        ..._reqMeta(req),
      });
      const { enrichEmployeeWithHyperState } = await import('./employees/hyper-state.js');
      const enriched = await enrichEmployeeWithHyperState(emp);
      return jsonResponse(res, { employee: enriched }, 201);
    } catch (err) {
      return jsonResponse(res, { error: err.message }, 500);
    }
  }

  // GET /v1/employees/bootstrap — internal-only; master-key authed.
  // Returns running employees with their decrypted API keys + decrypted
  // Slack bot tokens so the Python sidecar can wire each Assistant + each
  // workspace WS at boot. App-level tokens (xapp-) remain admin-managed
  // via env (SLACK_APP_TOKEN_<team_id>) since Slack issues them per-app,
  // not per-OAuth-grant.
  if (pathname === '/internal/hyper/prospects' && req.method === 'GET') {
    const callerKey = (req.headers['authorization'] || '').replace('Bearer ', '').trim()
      || String(req.headers['x-api-key'] || req.headers['x-hivemind-master-key'] || '').trim();
    const expected = process.env.HIVEMIND_MASTER_API_KEY;
    if (!expected || callerKey !== expected) return jsonResponse(res, { error: 'master key required' }, 403);
    if (!prisma) return jsonResponse(res, { error: 'Database unavailable' }, 503);
    const orgId = String(url.searchParams.get('org_id') || '');
    const userId = String(url.searchParams.get('user_id') || '');
    const query = String(url.searchParams.get('query') || '').trim().toLowerCase().slice(0, 240);
    const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || 50), 100));
    if (!/^[0-9a-f-]{36}$/i.test(orgId) || !/^[0-9a-f-]{36}$/i.test(userId)) {
      return jsonResponse(res, { error: 'org_id and user_id are required' }, 400);
    }
    try {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT t.id, t.company, t.email, t.phone, t.website, t.address, t.state,
                t.input_context, t.updated_at, c.id AS campaign_id
           FROM hivemind.outreach_targets t
           JOIN hivemind.outreach_campaigns c ON c.id=t.campaign_id
          WHERE c.org_id=$1::uuid AND c.user_id=$2::uuid
            AND ($3='' OR lower(concat_ws(' ', t.company, t.email, t.website, t.address,
                                           t.input_context::text)) LIKE '%' || $3 || '%')
          ORDER BY t.updated_at DESC LIMIT $4`, orgId, userId, query, limit,
      );
      const records = rows.map((row) => ({
        memory_id: row.id, company: row.company, email: row.email, phone: row.phone,
        website: row.website, address: row.address, state: row.state,
        source_url: row.input_context?.source_url || row.website || null,
        fit_reason: row.input_context?.fit_rationale || null,
        distinctive_signal: row.input_context?.distinctive_signal || null,
        outreach_angle: row.input_context?.outreach_angle || null,
        note: row.input_context?.notes || null, campaign_id: row.campaign_id,
        updated_at: row.updated_at,
      }));
      return jsonResponse(res, { status: 'completed', count: records.length, records });
    } catch (err) {
      return jsonResponse(res, { error: err.message }, 500);
    }
  }

  if (pathname === '/internal/hyper/prospects/bulk' && req.method === 'POST') {
    const callerKey = (req.headers['authorization'] || '').replace('Bearer ', '').trim()
      || String(req.headers['x-api-key'] || req.headers['x-hivemind-master-key'] || '').trim();
    const expected = process.env.HIVEMIND_MASTER_API_KEY;
    if (!expected || callerKey !== expected) {
      return jsonResponse(res, { error: 'master key required' }, 403);
    }
    if (!prisma) return jsonResponse(res, { error: 'Database unavailable' }, 503);
    // DISABLED BY DEFAULT — prospects are CRM records, not memories. This is the
    // THIRD writer of the same rows: agentscope_tools was guarded in 3ab5356db and
    // hivemind_client immediately after, but guarding two of three doors is
    // guarding none — 115 prospect memories reappeared within hours of a 119-row
    // cleanup, newest at 19:48, while the first guard sat live in the image.
    //
    // Every intelligence step is switched off on these writes (smartIngest false,
    // skipProcessing, skip_relationship_classification, skip_contradiction_detection,
    // defer_entity_linking) so they were never processed as memories: 0% anchored to
    // evidence, using the memory table as a lead store, and competing with real
    // memories in semantic recall. Observed live in /chat — "Prospect: Hannover Re"
    // was cited as a source for a question about Solvis heat-pump documentation.
    //
    const body = await parseBody(req).catch(() => ({}));
    const orgId = String(body?.org_id || '');
    const userId = String(body?.user_id || '');
    const turnId = /^[0-9a-f-]{36}$/i.test(String(body?.turn_id || '')) ? String(body.turn_id) : null;
    const records = Array.isArray(body?.prospects) ? body.prospects.slice(0, 50) : [];
    if (!/^[0-9a-f-]{36}$/i.test(orgId) || !/^[0-9a-f-]{36}$/i.test(userId) || !records.length) {
      return jsonResponse(res, { error: 'org_id, user_id and prospects are required' }, 400);
    }
    const normalized = records.map((row) => {
      const company = String(row?.company || '').trim().slice(0, 300);
      const slug = company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
      const value = (key, limit = 1000) => String(row?.[key] || '').trim().slice(0, limit);
      const phone = value('phone', 120); const email = value('email', 320);
      const website = value('website', 1000); const address = value('address', 1000);
      const fitReason = value('fit_reason'); const signal = value('distinctive_signal');
      const angle = value('outreach_angle'); const note = value('note', 1600);
      const lines = [`PROSPECT: ${company}`];
      if (phone) lines.push(`PHONE: ${phone}`);
      if (email) lines.push(`EMAIL: ${email}`);
      if (website) lines.push(`WEBSITE: ${website}`);
      if (address) lines.push(`ADDRESS: ${address}`);
      if (fitReason) lines.push(`FIT_REASON: ${fitReason}`);
      if (signal) lines.push(`DISTINCTIVE_SIGNAL: ${signal}`);
      if (angle) lines.push(`OUTREACH_ANGLE: ${angle}`);
      lines.push(`NOTE: ${note || 'Verified prospect retained by Room Intelligence.'}`);
      return { company, slug, content: lines.join('\n'), phone, email, website, address,
        fitReason, signal, angle, source: value('source', 120) || 'room-intelligence' };
    }).filter((row) => row.company && row.slug && row.fitReason && row.angle);
    // A Places response can contain aliases for the same organization. Collapse
    // them before concurrent writes so one request cannot race itself.
    const clean = [...new Map(normalized.map((row) => [row.slug, row])).values()];
    if (!clean.length) return jsonResponse(res, { error: 'no complete qualified prospects' }, 400);
    // Prospects belong to the tenant CRM surface. Keep the legacy memory writer
    // available only behind its explicit compatibility flag, while the normal
    // path persists Room discoveries in the same outreach target store rendered
    // by Your Leads.
    if (String(process.env.HYPER_PROSPECTS_TO_MEMORY || '').toLowerCase() !== 'true') {
      if (!turnId) return jsonResponse(res, { error: 'turn_id is required for CRM lead persistence' }, 400);
      try {
        const turn = await prisma.hyperTurn.findFirst({
          where: { id: turnId }, select: { roomId: true },
        });
        const room = turn?.roomId ? await prisma.hyperRoom.findFirst({
          where: { id: turn.roomId, orgId, userId, archivedAt: null }, select: { id: true },
        }) : null;
        if (!room) return jsonResponse(res, { error: 'tenant Room not found for lead persistence' }, 404);
        let campaign = await prisma.outreachCampaign.findFirst({
          where: { orgId, userId, roomId: room.id, turnId, channel: 'email' },
          include: { targets: { orderBy: { position: 'asc' } } },
        });
        if (!campaign) {
          campaign = await prisma.outreachCampaign.create({
            data: { roomId: room.id, turnId, userId, orgId, channel: 'email', status: 'queued' },
            include: { targets: { orderBy: { position: 'asc' } } },
          });
        }
        const keyFor = (row) => String(row.email || row.company || '').trim().toLowerCase();
        const byKey = new Map((campaign.targets || []).map((row) => [keyFor(row), row]));
        let position = (campaign.targets || []).reduce((max, row) => Math.max(max, Number(row.position) || 0), -1) + 1;
        let created = 0;
        for (const row of clean) {
          const key = keyFor(row);
          if (byKey.has(key)) continue;
          const target = await prisma.outreachTarget.create({
            data: {
              campaignId: campaign.id, position: position++, company: row.company,
              email: row.email || null, phone: row.phone || null,
              website: row.website || null, address: row.address || null,
              inputContext: {
                source_url: records.find((source) => String(source?.company || '').trim() === row.company)?.source_url || row.website || null,
                fit_rationale: row.fitReason, distinctive_signal: row.signal || null,
                outreach_angle: row.angle, notes: row.content, source: row.source,
              },
            },
          });
          byKey.set(key, target); created += 1;
        }
        const persistedRecords = clean.map((row) => {
          const target = byKey.get(keyFor(row));
          return target ? {
            record_id: target.id, memory_id: target.id, company: row.company,
            email: row.email || null, campaign_id: campaign.id,
          } : null;
        }).filter(Boolean);
        return jsonResponse(res, {
          status: 'completed', store: 'outreach_targets', received: clean.length,
          persisted: persistedRecords.length, created, updated: persistedRecords.length - created,
          ids: persistedRecords.map((row) => row.record_id), records: persistedRecords,
        }, 200);
      } catch (err) {
        console.warn('[prospects.bulk.crm] failed:', err.message);
        return jsonResponse(res, { error: err.message }, 500);
      }
    }
    try {
      let created = 0; let updated = 0;
      const ids = [];
      const persistedRecords = [];
      const workers = Math.min(8, clean.length);
      let cursor = 0;
      await Promise.all(Array.from({ length: workers }, async () => {
        while (cursor < clean.length) {
          const row = clean[cursor++];
          const companyTag = `company:${row.slug}`;
          const tags = ['prospect', 'lead', companyTag,
            ...(row.phone ? ['has-phone'] : []), ...(row.email ? ['has-email'] : [])];
          const provenance = { source_type: 'prospect', source_platform: 'hyperagents-prospect',
            prospect_source: row.source, company: row.company, phone: row.phone || null,
            email: row.email || null, website: row.website || null, address: row.address || null,
            fit_reason: row.fitReason, distinctive_signal: row.signal || null,
            outreach_angle: row.angle, produced_by: 'room-intelligence' };
          const existing = await prisma.memory.findFirst({
            where: { orgId, deletedAt: null, isLatest: true, tags: { has: companyTag } },
            orderBy: { createdAt: 'desc' }, select: { id: true },
          });
          const data = { title: `Prospect: ${row.company}`.slice(0, 500), content: row.content,
            tags, sourcePlatform: 'hyperagents-prospect', scope: 'organization',
            visibility: 'organization', producedByTurn: turnId, producedByAgent: 'room-intelligence',
            actionable: true, provenance, lastConfirmedAt: new Date() };
          if (existing) {
            const saved = await prisma.memory.update({ where: { id: existing.id }, data });
            ids.push(saved.id); persistedRecords.push({ memory_id: saved.id, company: row.company, email: row.email || null }); updated += 1;
          } else {
            const saved = await prisma.memory.create({ data: { ...data, userId, orgId, memoryType: 'fact' } });
            ids.push(saved.id); persistedRecords.push({ memory_id: saved.id, company: row.company, email: row.email || null }); created += 1;
          }
        }
      }));
      return jsonResponse(res, { status: 'completed', received: clean.length,
        persisted: ids.length, created, updated, ids, records: persistedRecords }, 200);
    } catch (err) {
      console.warn('[prospects.bulk] failed:', err.message);
      return jsonResponse(res, { error: err.message }, 500);
    }
  }

  if (pathname === '/v1/employees/bootstrap' && req.method === 'GET') {
    const callerKey = (req.headers['authorization'] || '').replace('Bearer ', '').trim()
      || (req.headers['x-hivemind-master-key'] || '').trim();
    const expected = process.env.HIVEMIND_MASTER_API_KEY;
    if (!expected || callerKey !== expected) {
      return jsonResponse(res, { error: 'master key required' }, 403);
    }
    if (!prisma) return jsonResponse(res, { error: 'Database unavailable' }, 503);
    const store = await _getEmployeeStore();
    try {
      const rows = await store.listForBootstrap({});
      const { decryptToken } = await import('./connectors/framework/connector-store.js');
      const { ConnectorStore } = await import('./connectors/framework/connector-store.js');
      const { enrichEmployeeWithHyperState } = await import('./employees/hyper-state.js');
      const connStore = new ConnectorStore(prisma);

      const out = [];
      for (const r of rows) {
        let apiKey = null;
        if (r.scopedApiKeyEncrypted) {
          try { apiKey = decryptToken(r.scopedApiKeyEncrypted); } catch {}
        }
        let slackBotToken = null;
        if (r.slackTeamId) {
          try {
            slackBotToken = await connStore.getAccessToken(r.createdBy, 'slack');
          } catch {}
        }
        const baseEmployee = {
          id: r.id,
          slug: r.slug,
          name: r.name,
          org_id: r.orgId,
          team_id: r.teamId,
          persona: r.persona,
          model: r.model,
          llm_provider: r.llmProvider,
          tools: r.tools,
          policy_rules: r.policyRules,
          scope: r.scope,
          slack_team_id: r.slackTeamId,
          slack_channels_allowed: r.slackChannelsAllowed,
          slack_display_name: r.slackDisplayName,
          slack_avatar_url: r.avatarUrl,
          slack_avatar_emoji: r.slackAvatarEmoji,
          role_archetype: r.roleArchetype,
          peer_review_targets: r.peerReviewTargets || [],
          status: r.status,
          api_key: apiKey,
          slack_bot_token: slackBotToken,
          created_by: r.createdBy,
        };
        out.push(await enrichEmployeeWithHyperState(baseEmployee));
      }
      return jsonResponse(res, { employees: out, generated_at: new Date().toISOString() });
    } catch (err) {
      console.warn('[employees.bootstrap] failed:', err.message);
      return jsonResponse(res, { error: err.message }, 500);
    }
  }

  // GET /v1/employees/:slug/chat-profile — internal-only; master-key authed.
  // Returns ONE employee (any non-archived status, incl. draft) + decrypted
  // api_key + hyper state, so the sidecar can build an ephemeral 1-on-1 chat
  // agent without the employee being deployed/running. Distinct from the
  // bootstrap snapshot (which only lists running employees for reconcile).
  const chatProfileMatch = pathname.match(/^\/v1\/employees\/([a-z0-9-]{1,120})\/chat-profile$/);
  if (chatProfileMatch && req.method === 'GET') {
    const callerKey = (req.headers['authorization'] || '').replace('Bearer ', '').trim()
      || (req.headers['x-hivemind-master-key'] || '').trim();
    const expected = process.env.HIVEMIND_MASTER_API_KEY;
    if (!expected || callerKey !== expected) {
      return jsonResponse(res, { error: 'master key required' }, 403);
    }
    if (!prisma) return jsonResponse(res, { error: 'Database unavailable' }, 503);
    const slug = chatProfileMatch[1];
    const orgId = new URL(req.url, 'http://x').searchParams.get('org_id') || null;
    const store = await _getEmployeeStore();
    try {
      const r = await store.findBySlugForChat(slug, { orgId });
      if (!r) return jsonResponse(res, { error: 'employee not found' }, 404);
      const { decryptToken, encryptToken } = await import('./connectors/framework/connector-store.js');
      const { enrichEmployeeWithHyperState } = await import('./employees/hyper-state.js');
      let apiKey = null;
      if (r.scopedApiKeyEncrypted) {
        try { apiKey = decryptToken(r.scopedApiKeyEncrypted); } catch {}
      }
      // Draft employees are created without a scoped key (minted at deploy).
      // 1-on-1 chat needs one to bootstrap tools/memory — mint on demand so a
      // never-deployed employee is still chattable. Idempotent per employee.
      if (!apiKey) {
        try {
          const crypto = await import('node:crypto');
          const raw = 'hmk_emp_' + crypto.randomBytes(24).toString('hex');
          const keyHash = crypto.createHash('sha256').update(raw).digest('hex');
          const minted = await prisma.apiKey.create({
            data: {
              userId: r.createdBy,
              orgId: r.orgId,
              name: `${r.name} (employee, chat)`,
              keyHash,
              keyPrefix: raw.slice(0, 12),
              scopes: ['memory:read', 'memory:write', 'mcp', 'slack:act'],
            },
          });
          await store.setScopedApiKey({ id: r.id, apiKeyId: minted.id, encryptedKey: encryptToken(raw) });
          apiKey = raw;
        } catch (mintErr) {
          console.warn('[employees.chat-profile] key mint failed:', mintErr.message);
        }
      }
      const baseEmployee = {
        id: r.id,
        slug: r.slug,
        name: r.name,
        org_id: r.orgId,
        team_id: r.teamId,
        persona: r.persona,
        model: r.model,
        llm_provider: r.llmProvider,
        tools: r.tools,
        policy_rules: r.policyRules,
        scope: r.scope,
        role_archetype: r.roleArchetype,
        peer_review_targets: r.peerReviewTargets || [],
        status: r.status,
        api_key: apiKey,
        created_by: r.createdBy,
        // Per-agent connector grants → 1-on-1 chat registers the same toolkits (Gmail/
        // Docs/Sheets/MCP) it uses in rooms. Global learned playbook → injected into the
        // private-chat persona so the agent applies what it learned everywhere (read-only).
        connectors: r.enabledConnectors || [],
        evo_playbook: Array.isArray(r.evoPlaybook) ? r.evoPlaybook : [],
      };
      return jsonResponse(res, await enrichEmployeeWithHyperState(baseEmployee));
    } catch (err) {
      console.warn('[employees.chat-profile] failed:', err.message);
      return jsonResponse(res, { error: err.message }, 500);
    }
  }

  // PUT /v1/employees/:id/sidecar-status — master-key authed.
  // Python sidecar POSTs after building (or failing to build) the
  // Assistant for an employee so the UI badge flips draft → running
  // (or error) automatically.
  const sidecarStatusMatch = pathname.match(/^\/v1\/employees\/([0-9a-f-]{36})\/sidecar-status$/);
  if (sidecarStatusMatch && req.method === 'PUT') {
    const callerKey = (req.headers['authorization'] || '').replace('Bearer ', '').trim()
      || (req.headers['x-hivemind-master-key'] || '').trim();
    const expected = process.env.HIVEMIND_MASTER_API_KEY;
    if (!expected || callerKey !== expected) {
      return jsonResponse(res, { error: 'master key required' }, 403);
    }
    if (!prisma) return jsonResponse(res, { error: 'Database unavailable' }, 503);
    const store = await _getEmployeeStore();
    const empId = sidecarStatusMatch[1];
    const body = await parseBody(req);
    const newStatus = body?.status;
    if (!newStatus) return jsonResponse(res, { error: 'status required' }, 400);
    try {
      const updated = await store.setStatus({
        id: empId,
        status: newStatus,
        errorMessage: body?.error_message,
      });
      return jsonResponse(res, { employee: updated });
    } catch (err) {
      return jsonResponse(res, { error: err.message }, 500);
    }
  }

  // PUT /v1/employees/:id/metrics — master-key authed. Sidecar reports
  // per-turn token/message/error counts after each LLM turn (1-1 chat,
  // team-tasks, hyper-rooms) so the UI msgs/tok counters reflect real usage.
  // Must sit BEFORE the session-gated employeeIdMatch block (sidecar has no
  // session cookie — it authenticates with the master key like sidecar-status).
  const empMetricsMatch = pathname.match(/^\/v1\/employees\/([0-9a-f-]{36})\/metrics$/);
  if (empMetricsMatch && req.method === 'PUT') {
    const callerKey = (req.headers['authorization'] || '').replace('Bearer ', '').trim()
      || (req.headers['x-hivemind-master-key'] || '').trim();
    const expected = process.env.HIVEMIND_MASTER_API_KEY;
    if (!expected || callerKey !== expected) {
      return jsonResponse(res, { error: 'master key required' }, 403);
    }
    if (!prisma) return jsonResponse(res, { error: 'Database unavailable' }, 503);
    const store = await _getEmployeeStore();
    const empId = empMetricsMatch[1];
    const body = await parseBody(req).catch(() => ({}));
    const clamp = (v) => Math.max(0, Math.floor(Number(v) || 0));
    const tokens = clamp(body?.tokens);
    const messages = clamp(body?.messages);
    const errors = clamp(body?.errors);
    try {
      const updated = await store.incrementMetrics({ id: empId, tokens, messages, errors });
      return jsonResponse(res, { status: 'success', employee_id: empId, metrics: updated?.metricsLast24h || null });
    } catch (err) {
      return jsonResponse(res, { error: err.message }, 500);
    }
  }

  // POST /v1/employees/:id/eval — master-key authed (beside /metrics).
  // Scores one agent response against its persona role and appends a JSONL
  // row to <archiveRoot>/evaluations/<key>_evals.jsonl. The autonomous tuning
  // loop reads that file (count >= TUNING_THRESHOLD triggers a variant).
  const empEvalMatch = pathname.match(/^\/v1\/employees\/([0-9a-f-]{36})\/eval$/);
  if (empEvalMatch && req.method === 'POST') {
    const callerKey = (req.headers['authorization'] || '').replace('Bearer ', '').trim()
      || (req.headers['x-hivemind-master-key'] || '').trim();
    const expected = process.env.HIVEMIND_MASTER_API_KEY;
    if (!expected || callerKey !== expected) {
      return jsonResponse(res, { error: 'master key required' }, 403);
    }
    if (!prisma) return jsonResponse(res, { error: 'Database unavailable' }, 503);
    const store = await _getEmployeeStore();
    const empId = empEvalMatch[1];
    const body = await parseBody(req).catch(() => ({}));
    const query = String(body?.query || '');
    const response = String(body?.response || '');
    if (!query || !response) return jsonResponse(res, { error: 'query and response required' }, 400);
    try {
      const emp = await store.getById({ id: empId });
      if (!emp) return jsonResponse(res, { error: 'Employee not found' }, 404);
      const { employeeLearningKey, scoreResponse } = await import('./employees/autonomous-scorer.js');
      const key = employeeLearningKey(emp);
      const { score, breakdown } = scoreResponse({ key, query, response });
      // archiveRoot resolution mirrors hyper-state.js (not exported there).
      const archiveRoot = process.env.HIVEMIND_ARCHIVE_DIR || path.resolve(process.cwd(), 'archive');
      const evalDir = path.join(archiveRoot, 'evaluations');
      await fs.promises.mkdir(evalDir, { recursive: true });
      const row = { ts: new Date().toISOString(), query, response, score, breakdown };
      await fs.promises.appendFile(path.join(evalDir, `${key}_evals.jsonl`), JSON.stringify(row) + '\n');
      const { enrichEmployeeWithHyperState } = await import('./employees/hyper-state.js');
      const enriched = await enrichEmployeeWithHyperState(emp);
      const state = enriched?.hyper || null;
      const evaluation_count = state?.evaluation_count ?? null;
      return jsonResponse(res, { status: 'success', evaluation_count, state });
    } catch (err) {
      return jsonResponse(res, { error: err.message }, 500);
    }
  }

  // Routes scoped to a single employee
  const employeeIdMatch = pathname.match(/^\/v1\/employees\/([0-9a-f-]{36})(?:\/(.+))?$/);
  if (employeeIdMatch) {
    const current = await requireSession(req, res);
    if (!current) return;
    const store = await _getEmployeeStore();
    if (!store) return jsonResponse(res, { error: 'Database unavailable' }, 503);
    const empId = employeeIdMatch[1];
    const sub = employeeIdMatch[2] || null;
    const orgId = current.session.orgId;
    const userId = current.session.userId;
    const membership = await getOrgMembership(userId, orgId);
    const isOrgAdmin = membership?.role === 'owner' || membership?.role === 'admin';

    const emp = await store.getById({ id: empId, orgId });
    if (!emp) return jsonResponse(res, { error: 'Employee not found' }, 404);

    // GET /v1/employees/:id
    if (!sub && req.method === 'GET') {
      const { enrichEmployeeWithHyperState } = await import('./employees/hyper-state.js');
      return jsonResponse(res, await enrichEmployeeWithHyperState(emp));
    }

    // PATCH /v1/employees/:id
    if (!sub && req.method === 'PATCH') {
      if (!isOrgAdmin) return jsonResponse(res, { error: 'Forbidden' }, 403);
      try {
        const body = await parseBody(req);
        const updated = await store.update({ id: empId, data: body });
        _notifyEmployeesReload();
        audit({
          organizationId: orgId, userId,
          eventType: 'employee.updated', eventCategory: 'employee', action: 'update',
          resourceType: 'digital_employee', resourceId: empId,
          newValue: body, ..._reqMeta(req),
        });
        const { enrichEmployeeWithHyperState } = await import('./employees/hyper-state.js');
        return jsonResponse(res, { employee: await enrichEmployeeWithHyperState(updated) });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // DELETE /v1/employees/:id (archive)
    if (!sub && req.method === 'DELETE') {
      if (!isOrgAdmin) return jsonResponse(res, { error: 'Forbidden' }, 403);
      try {
        await store.archive({ id: empId });
        _notifyEmployeesReload();
        audit({
          organizationId: orgId, userId,
          eventType: 'employee.archived', eventCategory: 'employee', action: 'delete',
          resourceType: 'digital_employee', resourceId: empId,
          oldValue: { name: emp.name }, ..._reqMeta(req),
        });
        return jsonResponse(res, { success: true });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // POST /v1/employees/:id/pause
    if (sub === 'pause' && req.method === 'POST') {
      if (!isOrgAdmin) return jsonResponse(res, { error: 'Forbidden' }, 403);
      try {
        const updated = await store.setStatus({ id: empId, status: 'paused' });
        _notifyEmployeesReload();
        audit({
          organizationId: orgId, userId,
          eventType: 'employee.paused', eventCategory: 'employee', action: 'update',
          resourceType: 'digital_employee', resourceId: empId,
          ..._reqMeta(req),
        });
        const { enrichEmployeeWithHyperState } = await import('./employees/hyper-state.js');
        return jsonResponse(res, { employee: await enrichEmployeeWithHyperState(updated) });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // POST /v1/employees/:id/resume
    if (sub === 'resume' && req.method === 'POST') {
      if (!isOrgAdmin) return jsonResponse(res, { error: 'Forbidden' }, 403);
      try {
        const updated = await store.setStatus({ id: empId, status: 'running' });
        _notifyEmployeesReload();
        audit({
          organizationId: orgId, userId,
          eventType: 'employee.resumed', eventCategory: 'employee', action: 'update',
          resourceType: 'digital_employee', resourceId: empId,
          ..._reqMeta(req),
        });
        const { enrichEmployeeWithHyperState } = await import('./employees/hyper-state.js');
        return jsonResponse(res, { employee: await enrichEmployeeWithHyperState(updated) });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // POST /v1/employees/:id/deploy — take a draft (or errored) employee LIVE.
    // Distinct from resume (paused→running): deploy is the draft/error→deploying
    // entrypoint, guarantees a scoped HIVEMIND key exists (mints on demand),
    // and sets status 'deploying' so the sidecar reconcile builds the agent and
    // flips it to running/error via /sidecar-status. No container provisioning —
    // the sidecar is a long-lived process; deploy just makes the row reconcilable.
    if (sub === 'deploy' && req.method === 'POST') {
      if (!isOrgAdmin) return jsonResponse(res, { error: 'Forbidden' }, 403);
      try {
        const { enrichEmployeeWithHyperState } = await import('./employees/hyper-state.js');
        // Idempotent: already live or mid-deploy → no-op success.
        if (emp.status === 'running' || emp.status === 'deploying') {
          return jsonResponse(res, { employee: await enrichEmployeeWithHyperState(emp), status: emp.status, already: true });
        }
        // Ensure a scoped key (created employees have one; legacy/error rows may not).
        const keyRow = await prisma.digitalEmployee.findUnique({
          where: { id: empId },
          select: { scopedApiKeyEncrypted: true, createdBy: true, name: true },
        });
        if (keyRow && !keyRow.scopedApiKeyEncrypted) {
          try {
            const crypto = await import('node:crypto');
            const { encryptToken } = await import('./connectors/framework/connector-store.js');
            const raw = 'hmk_emp_' + crypto.randomBytes(24).toString('hex');
            const keyHash = crypto.createHash('sha256').update(raw).digest('hex');
            const minted = await prisma.apiKey.create({
              data: {
                userId: keyRow.createdBy || userId,
                orgId,
                name: `${keyRow.name} (employee, deploy)`,
                keyHash,
                keyPrefix: raw.slice(0, 12),
                scopes: ['memory:read', 'memory:write', 'mcp', 'slack:act'],
              },
            });
            await store.setScopedApiKey({ id: empId, apiKeyId: minted.id, encryptedKey: encryptToken(raw) });
          } catch (mintErr) {
            return jsonResponse(res, { error: `could not provision employee key: ${mintErr.message}` }, 500);
          }
        }
        const updated = await store.setStatus({ id: empId, status: 'deploying' });
        _notifyEmployeesReload();
        audit({
          organizationId: orgId, userId,
          eventType: 'employee.deployed', eventCategory: 'employee', action: 'update',
          resourceType: 'digital_employee', resourceId: empId,
          ..._reqMeta(req),
        });
        return jsonResponse(res, { employee: await enrichEmployeeWithHyperState(updated), status: 'deploying' }, 202);
      } catch (err) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // POST /v1/employees/:id/tune — org-admin (like deploy). Kicks off the
    // autonomous prompt-tuning loop for this employee as a detached background
    // process so the request returns immediately (the loop reads the evals
    // JSONL, calls the Groq teacher, and writes a prompt variant). Non-blocking.
    if (sub === 'tune' && req.method === 'POST') {
      if (!isOrgAdmin) return jsonResponse(res, { error: 'Forbidden' }, 403);
      try {
        const { spawn } = await import('node:child_process');
        const script = path.join(PROJECT_ROOT, 'scripts', 'prompt-tune.mjs');
        const child = spawn(process.execPath, [script, '--employee', empId], {
          detached: true,
          stdio: 'ignore',
        });
        child.unref();
        audit({
          organizationId: orgId, userId,
          eventType: 'employee.tuned', eventCategory: 'employee', action: 'update',
          resourceType: 'digital_employee', resourceId: empId,
          ..._reqMeta(req),
        });
        return jsonResponse(res, { status: 'running' }, 202);
      } catch (err) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // GET /v1/employees/:id/runtime-config (called by Python sidecar)
    // Auth here is the session cookie; sidecar will additionally use API key.
    if (sub === 'runtime-config' && req.method === 'GET') {
      const cfg = await store.getRuntimeConfig({ id: empId });
      if (!cfg) return jsonResponse(res, { error: 'Not found' }, 404);
      const { enrichEmployeeWithHyperState } = await import('./employees/hyper-state.js');
      return jsonResponse(res, await enrichEmployeeWithHyperState(cfg));
    }

    // POST /v1/employees/:id/remint-key — re-issue scoped HIVEMIND api_key
    // for legacy employees where the create-time mint silently failed
    // (symptom: hyper-rooms turn seals at 0 tok because the agent can't
    // bootstrap tools). Idempotent: deactivates the old key before mint.
    if (sub === 'remint-key' && req.method === 'POST') {
      if (!isOrgAdmin) return jsonResponse(res, { error: 'Forbidden' }, 403);
      try {
        const crypto = await import('node:crypto');
        const { encryptToken } = await import('./connectors/framework/connector-store.js');
        // Deactivate any prior scoped key linked to this employee.
        if (emp.hivemindApiKeyId) {
          try {
            await prisma.apiKey.update({
              where: { id: emp.hivemindApiKeyId },
              data: { revokedAt: new Date(), revokedReason: 'employee key reminted' },
            });
          } catch (_) { /* ignore — key might have been hard-deleted */ }
        }
        const raw = 'hmk_emp_' + crypto.randomBytes(24).toString('hex');
        const keyHash = crypto.createHash('sha256').update(raw).digest('hex');
        const apiKey = await prisma.apiKey.create({
          data: {
            userId: emp.createdBy || userId,
            orgId,
            name: `${emp.name} (employee, reminted)`,
            keyHash,
            keyPrefix: raw.slice(0, 12),
            scopes: ['memory:read', 'memory:write', 'mcp', 'slack:act'],
          },
        });
        await store.setScopedApiKey({ id: emp.id, apiKeyId: apiKey.id, encryptedKey: encryptToken(raw) });
        _notifyEmployeesReload();
        audit({
          organizationId: orgId, userId,
          eventType: 'employee.key_reminted', eventCategory: 'employee', action: 'update',
          resourceType: 'digital_employee', resourceId: empId,
          ..._reqMeta(req),
        });
        return jsonResponse(res, { success: true, api_key_id: apiKey.id });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    return jsonResponse(res, { error: 'Not found' }, 404);
  }

  // POST /v1/orgs/:id/employees/remint-all-keys — bulk back-fill for legacy
  // employees in this org missing scoped HIVEMIND keys. Org-admin only.
  const remintAllMatch = pathname.match(/^\/v1\/orgs\/([0-9a-f-]{36})\/employees\/remint-all-keys$/);
  if (remintAllMatch && req.method === 'POST') {
    const current = await requireSession(req, res);
    if (!current) return;
    const targetOrgId = remintAllMatch[1];
    if (current.session.orgId !== targetOrgId) {
      return jsonResponse(res, { error: 'Forbidden' }, 403);
    }
    const admin = await requireOrgAdmin(req, res, current.session.userId, targetOrgId);
    if (!admin) return;
    const store = await _getEmployeeStore();
    if (!store) return jsonResponse(res, { error: 'Database unavailable' }, 503);
    try {
      const rows = await prisma.digitalEmployee.findMany({
        where: { orgId: targetOrgId, scopedApiKeyEncrypted: null },
        select: { id: true, name: true, createdBy: true },
      });
      const crypto = await import('node:crypto');
      const { encryptToken } = await import('./connectors/framework/connector-store.js');
      const results = [];
      for (const r of rows) {
        try {
          const raw = 'hmk_emp_' + crypto.randomBytes(24).toString('hex');
          const keyHash = crypto.createHash('sha256').update(raw).digest('hex');
          const apiKey = await prisma.apiKey.create({
            data: {
              userId: r.createdBy || current.session.userId,
              orgId: targetOrgId,
              name: `${r.name} (employee, backfill)`,
              keyHash,
              keyPrefix: raw.slice(0, 12),
              scopes: ['memory:read', 'memory:write', 'mcp', 'slack:act'],
            },
          });
          await store.setScopedApiKey({ id: r.id, apiKeyId: apiKey.id, encryptedKey: encryptToken(raw) });
          results.push({ employee_id: r.id, name: r.name, ok: true });
        } catch (err) {
          results.push({ employee_id: r.id, name: r.name, ok: false, error: err.message });
        }
      }
      _notifyEmployeesReload();
      audit({
        organizationId: targetOrgId, userId: current.session.userId,
        eventType: 'employees.keys_backfilled', eventCategory: 'employee', action: 'update',
        resourceType: 'organization', resourceId: targetOrgId,
        newValue: { count: results.length, succeeded: results.filter(r => r.ok).length },
        ..._reqMeta(req),
      });
      return jsonResponse(res, {
        total: rows.length,
        succeeded: results.filter(r => r.ok).length,
        failed: results.filter(r => !r.ok).length,
        results,
      });
    } catch (err) {
      return jsonResponse(res, { error: err.message }, 500);
    }
  }

  // POST /v1/orgs/:id/employees/pause-all — kill switch (org_admin only)
  const pauseAllMatch = pathname.match(/^\/v1\/orgs\/([0-9a-f-]{36})\/employees\/pause-all$/);
  if (pauseAllMatch && req.method === 'POST') {
    const current = await requireSession(req, res);
    if (!current) return;
    const targetOrg = pauseAllMatch[1];
    if (targetOrg !== current.session.orgId) {
      return jsonResponse(res, { error: 'Forbidden' }, 403);
    }
    const admin = await requireOrgAdmin(req, res, current.session.userId, targetOrg);
    if (!admin) return;
    const store = await _getEmployeeStore();
    try {
      const result = await store.pauseAllInOrg({ orgId: targetOrg });
      audit({
        organizationId: targetOrg, userId: current.session.userId,
        eventType: 'employee.pause_all', eventCategory: 'employee', action: 'update',
        resourceType: 'organization', resourceId: targetOrg,
        metadata: { paused_count: result.count },
        ..._reqMeta(req),
      });
      return jsonResponse(res, { paused_count: result.count });
    } catch (err) {
      return jsonResponse(res, { error: err.message }, 500);
    }
  }
  // ─── End Digital Employees ────────────────────────────────

  // ─── Team Tasks + Employee Chat (sidecar proxy) ───────────
  // Forwards to the Python sidecar's /v1/team-tasks/* and
  // /v1/employees/:slug/chat endpoints, which require the master key.
  // Frontend authenticates via session cookie; this layer attaches
  // the master key + caller's org_id so the sidecar can scope the
  // run + persist the task row to the right organization.
  const _sidecarBase = () => process.env.HIVEMIND_EMPLOYEES_URL || 'http://hm-employees:8060';
  const _sidecarKey = () => process.env.HIVEMIND_MASTER_API_KEY || '';

  async function _forwardSidecar(req, res, target, { injectOrg = false } = {}) {
    const current = await requireSession(req, res);
    if (!current) return true;
    if (!_sidecarKey()) {
      return jsonResponse(res, { error: 'sidecar not configured (master key missing)' }, 503);
    }
    let body = null;
    if (req.method !== 'GET' && req.method !== 'DELETE') {
      body = await parseBody(req).catch(() => ({}));
      if (injectOrg && body && typeof body === 'object') {
        body.org_id = current.session.orgId;
        body.requested_by = current.session.userId;
      }
    }
    const url = _sidecarBase() + target;
    try {
      const resp = await fetch(url, {
        method: req.method,
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Token': _sidecarKey(),
          'X-Org-Id': current.session.orgId,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(60000),
      });
      const text = await resp.text();
      let payload;
      try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
      return jsonResponse(res, payload, resp.status);
    } catch (err) {
      return jsonResponse(res, { error: `sidecar unreachable: ${err.message}` }, 502);
    }
  }

  // POST /v1/team-tasks — kick off a multi-employee task
  if (pathname === '/v1/team-tasks' && req.method === 'POST') {
    await _forwardSidecar(req, res, '/v1/team-tasks', { injectOrg: true });
    return;
  }
  // GET /v1/team-tasks — recent task history for current org
  if (pathname === '/v1/team-tasks' && req.method === 'GET') {
    await _forwardSidecar(req, res, `/v1/team-tasks${url.search || ''}`);
    return;
  }
  // GET  /v1/team-tasks/:id            — status + outcome
  // GET  /v1/team-tasks/:id/transcript — paginated transcript
  const teamTaskMatch = pathname.match(/^\/v1\/team-tasks\/([0-9a-f-]{36})(\/transcript)?$/);
  if (teamTaskMatch && req.method === 'GET') {
    const tail = teamTaskMatch[2] ? `/${teamTaskMatch[1]}/transcript` : `/${teamTaskMatch[1]}`;
    const qs = url.search || '';
    await _forwardSidecar(req, res, `/v1/team-tasks${tail}${qs}`);
    return;
  }
  // POST /v1/employees/:slug/chat — 1-on-1 ReAct turn against one employee
  const empChatMatch = pathname.match(/^\/v1\/employees\/([a-z0-9-]+)\/chat$/);
  if (empChatMatch && req.method === 'POST') {
    await _forwardSidecar(req, res, `/v1/employees/${empChatMatch[1]}/chat`);
    return;
  }
  // ─── End Team Tasks ───────────────────────────────────────

  // ═══════════════════════════════════════════════════════════
  // Hyper Agents — Rooms (Slack/WhatsApp-style CSI swarm)
  // ───────────────────────────────────────────────────────────
  // /v1/hyper-rooms/*
  //   - list/create rooms per user
  //   - post a turn (idempotent on user_message)
  //   - SSE stream for live turn lines
  //   - archive: distill transcript → one summary memory
  //   - human-gated prompt promotion path
  // ═══════════════════════════════════════════════════════════
  {
    const { deriveCsiLane, buildIdempotencyKey, preflightTurn } = await import('./employees/hyper-rooms.js');

    // GET /v1/hyper-rooms — list current user's rooms
    if (pathname === '/v1/hyper-rooms' && req.method === 'GET') {
      const current = await requireSession(req, res);
      if (!current) return;
      try {
        const membership = await getOrgMembership(current.session.userId, current.session.orgId);
        const orgAgentAccess = canUsePrivilegedAgent(effectiveRoles(membership));
        const ownedProjects = orgAgentAccess ? [] : await prisma.projectMember.findMany({
          where: { userId: current.session.userId, role: 'owner', project: { orgId: current.session.orgId, archivedAt: null } },
          select: { projectId: true },
        });
        if (!orgAgentAccess && ownedProjects.length === 0) {
          return jsonResponse(res, { error: 'Forbidden', code: 'PRIVILEGED_AGENT_ROLE_REQUIRED' }, 403);
        }
        const ownedProjectIds = new Set(ownedProjects.map((entry) => entry.projectId));
        // Org-shared rooms: any member of the room's org sees the org's rooms
        // (Digital-Employees rooms are collaborative; rooms carry org_id). Org
        // isolation preserved — a member never sees another org's rooms.
        let rooms = await prisma.hyperRoom.findMany({
          // One company per org: retired (archived) rooms from a prior company are
          // hidden so re-onboarding shows only the current company's rooms.
          where: { orgId: current.session.orgId, archivedAt: null },
          orderBy: [{ updatedAt: 'desc' }],
          take: 200,
        });
        // Stamp project_id via raw SQL — the deployed Prisma client predates the
        // column, so findMany() omits it. Without this every room reads as org-wide.
        try {
          const rids = rooms.map(r => r.id);
          if (rids.length) {
            const ph = rids.map((_, i) => `$${i + 1}::uuid`).join(',');
            const prows = await prisma.$queryRawUnsafe(
              `SELECT id, project_id, goal, room_tag,
                      (agent_connectors->>'_domain_home' = 'true') AS is_domain_home
                 FROM "hivemind"."hyper_rooms" WHERE id IN (${ph})`, ...rids,
            );
            const pmap = Object.fromEntries((prows || []).map(x => [x.id, x.project_id]));
            const gmap = Object.fromEntries((prows || []).map(x => [x.id, x.goal]));
            const tmap = Object.fromEntries((prows || []).map(x => [x.id, x.room_tag]));
            const dmap = Object.fromEntries((prows || []).map(x => [x.id, x.is_domain_home]));
            for (const r of rooms) {
              r.projectId = pmap[r.id] || null;
              r.goal = gmap[r.id] || '';
              r.roomTag = tmap[r.id] || 'general';
              r.isDomainHome = dmap[r.id] === true;
            }
          }
        } catch { /* leave projectId undefined */ }
        if (!orgAgentAccess) rooms = rooms.filter((room) => room.projectId && ownedProjectIds.has(room.projectId));
        // Hydrate participants + project scope for the rail
        const allIds = Array.from(new Set(rooms.flatMap(r => r.participantIds || [])));
        const projectIds = Array.from(new Set(rooms.map(r => r.projectId).filter(Boolean)));
        const employees = allIds.length
          ? await prisma.digitalEmployee.findMany({
              where: { id: { in: allIds } },
              select: {
                id: true,
                slug: true,
                name: true,
                avatarUrl: true,
                roleArchetype: true,
                peerReviewTargets: true,
                policyRules: true,
                scope: true,
                persona: true,
                model: true,
                llmProvider: true,
                status: true,
              },
            })
          : [];
        const projects = projectIds.length
          ? await prisma.project.findMany({
              where: { id: { in: projectIds }, orgId: current.session.orgId },
              select: { id: true, name: true, slug: true },
            })
          : [];
        const { enrichEmployeesWithHyperState } = await import('./employees/hyper-state.js');
        const enrichedEmployees = await enrichEmployeesWithHyperState(employees);
        const empById = Object.fromEntries(enrichedEmployees.map(e => [e.id, { ...e, lane: deriveCsiLane(e) }]));
        const projectById = Object.fromEntries(projects.map(p => [p.id, p]));
        return jsonResponse(res, {
          rooms: rooms.map(r => ({
            id: r.id,
            name: r.name,
            goal: r.goal || '',
            template: r.template,
            room_tag: r.roomTag || 'general',
            is_domain_home: r.isDomainHome === true,
            quality_mode: r.qualityMode || 'auto',
            sim_mode: r.simMode || 'off',
            sim_agents: r.simAgents || 24,
            participant_ids: r.participantIds,
            participants: (r.participantIds || []).map(id => empById[id]).filter(Boolean),
            created_at: r.createdAt,
            updated_at: r.updatedAt,
            archived_at: r.archivedAt,
            summary_memory_id: r.summaryMemoryId,
            project_id: r.projectId || null,
            project: r.projectId && projectById[r.projectId]
              ? {
                  id: projectById[r.projectId].id,
                  name: projectById[r.projectId].name,
                  slug: projectById[r.projectId].slug,
                }
              : null,
          })),
        });
      } catch (err) {
        console.warn('[hyper-rooms] list failed:', err.message);
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // POST /v1/hyper/domain-rooms/ensure — idempotently backfill the nine
    // permanent expertise homes for an already-onboarded organization.
    if (pathname === '/v1/hyper/domain-rooms/ensure' && req.method === 'POST') {
      const current = await requireSession(req, res);
      if (!current) return;
      try {
        const hqRows = await prisma.$queryRawUnsafe(
          `SELECT user_id, participant_ids, agent_connectors->'_company' AS company
             FROM "hivemind"."hyper_rooms"
            WHERE org_id = $1::uuid
              AND archived_at IS NULL
              AND agent_connectors ? '_company'
            ORDER BY created_at DESC LIMIT 1`,
          current.session.orgId,
        );
        const hq = hqRows?.[0];
        if (!hq) return jsonResponse(res, { ok: true, onboarded: false, rooms: [] });
        const company = typeof hq.company === 'string' ? JSON.parse(hq.company) : hq.company;
        const rooms = await ensureDomainRooms({
          prisma,
          orgId: current.session.orgId,
          userId: hq.user_id || current.session.userId,
          participantIds: hq.participant_ids || [],
          company,
        });
        return jsonResponse(res, { ok: true, onboarded: true, rooms });
      } catch (err) {
        console.warn('[hyper-domain-rooms] ensure failed:', err.message);
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // POST /v1/hyper-rooms — create
    if (pathname === '/v1/hyper-rooms' && req.method === 'POST') {
      const current = await requireSession(req, res);
      if (!current) return;
      const body = await parseBody(req);
      const name = typeof body.name === 'string' ? body.name.trim().slice(0, 120) : '';
      const goal = typeof body.goal === 'string' ? body.goal.trim().slice(0, 2000) : '';
      const participantIds = Array.isArray(body.participant_ids)
        ? body.participant_ids.filter(s => typeof s === 'string')
        : [];
      if (!name) return jsonResponse(res, { error: 'name is required' }, 400);
      if (!goal) return jsonResponse(res, { error: 'goal is required' }, 400);
      try {
        // Restrict participants to employees in this org
        const valid = participantIds.length
          ? await prisma.digitalEmployee.findMany({
              where: { id: { in: participantIds }, orgId: current.session.orgId },
              select: { id: true },
            })
          : [];
        const validIds = valid.map(v => v.id);
        const ALLOWED_TEMPLATES = new Set([
          'auto', 'debate', 'decision', 'swarm', 'deep_sim', 'brainstorm', 'council',
          'lean_coffee', 'retrospective', 'review', 'standup',
        ]);
        const template = (typeof body.template === 'string' && ALLOWED_TEMPLATES.has(body.template))
          ? body.template : 'debate';
        const ALLOWED_ROOM_TAGS = new Set(['general', 'campaign', 'seo', 'marketing', 'outreach', 'branding', 'fundraising', 'research', 'product', 'design', 'legal_finance']);
        const roomTag = (typeof body.room_tag === 'string' && ALLOWED_ROOM_TAGS.has(body.room_tag))
          ? body.room_tag : 'general';
        let permanentLeadId = null;
        if (typeof body.permanent_lead_id === 'string' && validIds.includes(body.permanent_lead_id)) {
          permanentLeadId = body.permanent_lead_id;
        } else if (validIds.length > 0) {
          permanentLeadId = validIds.slice().sort()[0];
        }
        let permanentSkepticId = null;
        if (typeof body.permanent_skeptic_id === 'string' && validIds.includes(body.permanent_skeptic_id)) {
          permanentSkepticId = body.permanent_skeptic_id;
        }
        // Scope: optional project_id nests the room inside a project HIVEMIND.
        // Validate it belongs to this org; ignore otherwise (falls back to org-wide).
        let projectId = null;
        if (typeof body.project_id === 'string' && body.project_id) {
          const proj = await prisma.project.findFirst({
            where: { id: body.project_id, orgId: current.session.orgId },
            select: { id: true },
          }).catch(() => null);
          if (!proj) return jsonResponse(res, { error: 'project not found in this org' }, 400);
          projectId = proj.id;
        }
        if (!await requirePrivilegedAgentAccess(req, res, current, projectId)) return;
        const room = await createHyperRoom({
            userId: current.session.userId,
            orgId: current.session.orgId,
            name,
            participantIds: validIds,
            template,
            permanentLeadId,
            permanentSkepticId,
        });
        // Persist goal/scope via raw SQL — avoids requiring a regenerated Prisma
        // client for newly-added columns during rolling deploys.
        try {
          await prisma.$executeRawUnsafe(
            'UPDATE "hivemind"."hyper_rooms" SET "goal" = $1, "room_tag" = $2 WHERE "id" = $3::uuid',
            goal, roomTag, room.id,
          );
          room.goal = goal;
          room.room_tag = roomTag;
        } catch (e) { console.warn('[hyper-rooms] goal set failed:', e.message); }
        if (projectId) {
          try {
            await prisma.$executeRawUnsafe(
              'UPDATE "hivemind"."hyper_rooms" SET "project_id" = $1::uuid WHERE "id" = $2::uuid',
              projectId, room.id,
            );
            room.projectId = projectId;
            const scopedProject = await prisma.project.findFirst({
              where: { id: projectId, orgId: current.session.orgId },
              select: { id: true, name: true, slug: true },
            }).catch(() => null);
            if (scopedProject) room.project = scopedProject;
          } catch (e) { console.warn('[hyper-rooms] project scope set failed:', e.message); }
        }
        return jsonResponse(res, { room }, 201);
      } catch (err) {
        if (err?.code === 'PLAN_LIMIT') return capacityErrorResponse(res, err);
        console.warn('[hyper-rooms] create failed:', err.message);
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // ── HyperAgents onboarding (Polsia-style company genesis) ──────────────
    // POST /v1/hyper/onboarding/start { website_url, goal? } → kicks an async
    // pipeline that reads the company website, drafts a grounded profile +
    // mission (persisted to HIVEMIND memory), assembles a starting team, plans
    // first tasks and provisions an HQ room. The FE polls /status and renders
    // the log lines as a live terminal. One job per org at a time; jobs are
    // in-memory (a refresh mid-run re-attaches via /status).
    // POST /v1/hyper/growth-baseline is deliberately a short independent
    // workflow: it refreshes sourced company-position evidence before a Room
    // decides whether a growth campaign is warranted.
    if (pathname === '/v1/hyper/growth-baselines' && req.method === 'GET') {
      const current = await requireSession(req, res);
      if (!current) return;
      if (!await requirePrivilegedAgentAccess(req, res, current)) return;
      const limit = Number(url.searchParams.get('limit') || 12);
      return jsonResponse(res, { baselines: await listGrowthBaselines({ prisma, orgId: current.session.orgId, limit }) });
    }
    if (pathname === '/v1/hyper/growth-baseline' && req.method === 'POST') {
      const current = await requireSession(req, res);
      if (!current) return;
      if (!await requirePrivilegedAgentAccess(req, res, current)) return;
      const body = await parseBody(req).catch(() => ({}));
      try {
        const baseline = await runGrowthBaseline({
          prisma,
          orgId: current.session.orgId,
          userId: current.session.userId,
          websiteUrl: body?.website_url,
          socialUrls: body?.social_urls,
          platforms: body?.platforms,
          metrics: body?.metrics,
          days: body?.days,
          mode: body?.mode === 'full_all' ? 'full_all' : 'refresh',
          includeWebsite: body?.include_website !== false,
        });
        return jsonResponse(res, { baseline });
      } catch (error) {
        return jsonResponse(res, { error: error.code || 'growth_baseline_failed', message: error.message }, error.status || 500);
      }
    }
    if (pathname === '/v1/hyper/growth-operating-state' && req.method === 'GET') {
      const current = await requireSession(req, res);
      if (!current) return;
      if (!await requirePrivilegedAgentAccess(req, res, current)) return;
      try { return jsonResponse(res, await getGrowthOperatingState({ prisma, orgId: current.session.orgId })); }
      catch (error) { return jsonResponse(res, { error: 'growth_operating_state_unavailable', message: error.message }, 503); }
    }
    if (pathname === '/v1/hyper/growth-plans' && req.method === 'GET') {
      const current = await requireSession(req, res);
      if (!current) return;
      if (!await requirePrivilegedAgentAccess(req, res, current)) return;
      try { return jsonResponse(res, { plans: await listGrowthPlans({ prisma, orgId: current.session.orgId, limit: url.searchParams.get('limit') }) }); }
      catch (error) { return jsonResponse(res, { error: 'growth_plan_history_unavailable', message: error.message }, 503); }
    }
    if (pathname === '/v1/hyper/growth-plan' && req.method === 'POST') {
      const current = await requireSession(req, res);
      if (!current) return;
      if (!await requirePrivilegedAgentAccess(req, res, current)) return;
      const body = await parseBody(req).catch(() => ({}));
      const mode = body?.mode === 'initial_full' ? 'initial_full' : 'operate';
      try {
        const result = await runGrowthPlan({
          prisma, orgId: current.session.orgId, userId: current.session.userId, mode,
          aspects: Array.isArray(body?.aspects) ? body.aspects : [], objective: body?.objective,
          autonomyMode: body?.autonomy_mode,
        });
        return jsonResponse(res, result, 201);
      } catch (error) {
        return jsonResponse(res, { error: 'growth_plan_failed', message: error.message }, 503);
      }
    }
    if (pathname === '/v1/hyper/growth-goals' && req.method === 'POST') {
      const current = await requireSession(req, res);
      if (!current) return;
      if (!await requirePrivilegedAgentAccess(req, res, current)) return;
      const body = await parseBody(req).catch(() => ({}));
      const title = String(body.title || '').trim().slice(0, 255);
      const objective = String(body.objective || '').trim().slice(0, 5000);
      if (!title || !objective) return jsonResponse(res, { error: 'title_and_objective_required' }, 400);
      const mode = ['MANUAL_REVIEW', 'ASSISTED', 'AUTO'].includes(body.autonomy_mode) ? body.autonomy_mode : 'MANUAL_REVIEW';
      try {
        const goal = await createGrowthGoal({ prisma, orgId: current.session.orgId, userId: current.session.userId, title, objective, autonomyMode: mode, policy: body.policy || {}, sourceRefs: Array.isArray(body.source_refs) ? body.source_refs : [] });
        return jsonResponse(res, { goal }, 201);
      } catch (error) { return jsonResponse(res, { error: 'growth_goal_create_failed', message: error.message }, 503); }
    }

    if (pathname === '/v1/hyper/onboarding/status' && req.method === 'GET') {
      const current = await requireSession(req, res);
      if (!current) return;
      if (!await requirePrivilegedAgentAccess(req, res, current)) return;
      const job = _hyperOnboardJobs.get(current.session.orgId);
      if (!job) return jsonResponse(res, { running: false, lines: [], done: false });
      // A completed job whose HQ room was since DELETED is stale — serving it
      // trapped the FE in a done-screen loop (Enter → /company 404 → fallback
      // re-attaches to this same job). Invalidate it so the user gets a fresh
      // onboarding input instead.
      if (job.done && !job.error && job.result?.room_id) {
        const hqAlive = await prisma.hyperRoom.findFirst({
          where: { id: job.result.room_id, orgId: current.session.orgId, archivedAt: null },
          select: { id: true },
        }).catch(() => null);
        if (!hqAlive) {
          _hyperOnboardJobs.delete(current.session.orgId);
          return jsonResponse(res, { running: false, lines: [], done: false });
        }
      }
      return jsonResponse(res, {
        running: !job.done,
        done: job.done,
        error: job.error || null,
        lines: job.lines,
        result: job.done && !job.error ? job.result : null,
      });
    }

    if (pathname === '/v1/hyper/onboarding/start' && req.method === 'POST') {
      const current = await requireSession(req, res);
      if (!current) return;
      if (!await requirePrivilegedAgentAccess(req, res, current)) return;
      const orgId = current.session.orgId;
      const userId = current.session.userId;
      if (!orgId) return jsonResponse(res, { error: 'no active organization' }, 400);
      const existing = _hyperOnboardJobs.get(orgId);
      if (existing && !existing.done) {
        return jsonResponse(res, { ok: true, already_running: true });
      }
      const body = await parseBody(req);
      let siteUrl = typeof body.website_url === 'string' ? body.website_url.trim() : '';
      if (siteUrl && !/^https?:\/\//i.test(siteUrl)) siteUrl = `https://${siteUrl}`;
      let host = '';
      try { host = new URL(siteUrl).hostname.replace(/^www\./, ''); } catch { /* validated below */ }
      if (!host) return jsonResponse(res, { error: 'valid website_url is required' }, 400);
      const userGoal = typeof body.goal === 'string' ? body.goal.trim().slice(0, 500) : '';
      const claimedCompanyLocation = typeof body.company_location === 'string' ? body.company_location.trim().slice(0, 240) : '';

      const job = { lines: [], done: false, error: null, startedAt: Date.now(), result: null, timings: {} };
      _hyperOnboardJobs.set(orgId, job);
      const say = (text) => { job.lines.push({ ts: Date.now(), text }); };
      let lastTimingAt = job.startedAt;
      const markTiming = (stage) => {
        const now = Date.now();
        job.timings[stage] = now - lastTimingAt;
        lastTimingAt = now;
      };

      // The shared fetch router rewrites this legacy-compatible request onto the
      // canonical Cerebras gpt-oss-120b route, with the configured provider failover.
      const llm = async (sys, user, { json = false, maxTokens = 900 } = {}) => {
        const r = await groqFetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
          body: JSON.stringify({
            model: 'llama-3.3-70b-versatile',
            messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
            temperature: 0.5,
            max_tokens: maxTokens,
            ...(json ? { response_format: { type: 'json_object' } } : {}),
          }),
        });
        if (!r.ok) throw new Error(`llm ${r.status}`);
        const d = await r.json();
        return (d.choices?.[0]?.message?.content || '').trim();
      };
      // Persist a memory through the canonical ingest front door on core.
      // Save one onboarding memory through the canonical ingest front door.
      // memoryType drives base salience (importance_score): decision=0.85,
      // summary=0.72, fact=0.55 — so identity+mission+
      // positioning outrank plain facts. tags carry the entity-boost lever
      // (entity:<name> stacks +0.14/match at recall) + the org-canon pin.
      const saveMemory = async ({ title, content, tags, memoryType = 'fact', authorityLevel = 'claimed' }) => {
        try {
          const r = await fetch(`${CONFIG.coreApiBaseUrl}/api/ingest/source`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-API-Key': getInternalApiKey(),
              'x-hm-user-id': userId,
              'x-hm-org-id': orgId,
            },
            body: JSON.stringify({
              title, content, tags,
              mode: 'atomic',
              source: { type: 'api', platform: 'hyperagents-onboarding', url: siteUrl, title },
              metadata: { memory_type: memoryType, priority: 'high', authority_level: authorityLevel },
            }),
          });
          return r.ok;
        } catch { return false; }
      };
      // Wipe any prior onboarding memories so a re-run supersedes cleanly (no
      // duplicate profiles piling up). Scoped to this org's onboarding source tag.
      const clearPriorOnboarding = async () => {
        // One company per org: re-onboarding REPLACES the prior company. Retire
        // the prior company's agents + rooms so the new company's HQ room seats
        // only its own freshly-hired team and org-wide recall/canon returns only
        // the new company. Archive (not delete) — recoverable via archived_at.
        // These writes are the isolation boundary for a replacement onboarding.
        // Fail closed if either cannot complete; continuing would mix companies.
        await clearHyperCompanyContext({ orgId, userId });
      };
      const stripHtml = (html) => html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&[a-z#0-9]+;/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      // Real web research via the core web-intel (Tavily) job API — submit a
      // search job with the master key, poll it to completion (≤20s), return
      // compact findings. Best-effort: a failed/slow search returns [] and the
      // pipeline continues (onboarding must never wedge on one search).
      const coreHeaders = {
        'Content-Type': 'application/json',
        'X-API-Key': getInternalApiKey(),
        'x-hm-user-id': userId,
        'x-hm-org-id': orgId,
      };
      const webSearch = async (query, { limit = 5 } = {}) => {
        try {
          const start = await fetch(`${CONFIG.coreApiBaseUrl}/api/web/search/jobs`, {
            method: 'POST', headers: coreHeaders,
            body: JSON.stringify({ query, limit }),
          });
          if (!start.ok) return [];
          const sd = await start.json().catch(() => ({}));
          // Core replies {job_id, status:'queued'} (202); tolerate {job:{id}} too.
          const jobId = sd.job_id || sd.job?.id || sd.id;
          if (!jobId) return [];
          for (let i = 0; i < 14; i++) {
            await new Promise((r) => setTimeout(r, 1500));
            const jr = await fetch(`${CONFIG.coreApiBaseUrl}/api/web/jobs/${jobId}`, { headers: coreHeaders });
            if (!jr.ok) return [];
            const jd = await jr.json().catch(() => ({}));
            const j = jd.job || jd;
            if (j.status === 'succeeded') {
              return (j.results || []).slice(0, limit).map((r) => ({
                title: r.title || '', url: r.url || '', snippet: (r.snippet || r.content || '').slice(0, 400),
              }));
            }
            if (j.status === 'failed') return [];
          }
          return [];
        } catch { return []; }
      };

      // Fire the pipeline — never blocks the HTTP response.
      (async () => {
        try {
          say('Getting started');
          say('Creating your company');
          const companyGuess = host.split('.')[0].replace(/[-_]/g, ' ').toUpperCase();
          say('Saving your brief');

          // Read the homepage first, then follow the most informative same-site
          // links that the company actually exposes. Never invent conventional
          // /about, /product, or /pricing paths.
          const homepageUrl = `https://${host}/`;
          const fetchPage = async (pageUrl) => {
            say(`Fetching: ${pageUrl}...`);
            const ac = new AbortController();
            const t = setTimeout(() => ac.abort(), 8000);
            try {
              const r = await fetch(pageUrl, { signal: ac.signal, headers: { 'User-Agent': 'HIVEMIND-Onboarding/1.0' } });
              if (!r.ok) return { url: pageUrl, text: '', html: '', links: [] };
              const html = await r.text();
              const resolvedUrl = r.url || pageUrl;
              return { url: resolvedUrl, text: stripHtml(html), html, links: discoverHttpLinks(html, resolvedUrl) };
            } catch { return { url: pageUrl, text: '', html: '', links: [] }; } finally { clearTimeout(t); }
          };
          // Start the customer-visible browser capture with the very first
          // onboarding work.  It is deliberately independent: semantic
          // discovery must never wait for a slow page render, and a failed
          // capture still falls through to the existing Firecrawl/official
          // image fallbacks below.
          const screenshotCapturePromise = captureWebsiteScreenshotWithPlaywright(homepageUrl);
          const [homepage, firecrawlResearch, initialCoverage] = await Promise.all([
            fetchPage(homepageUrl),
            researchCompanyWebsite(homepageUrl, { maxPages: 5, includeCrawl: false, onProgress: say }),
            searchCompanyMarket(`"${host}" company official LinkedIn Instagram Facebook X YouTube contact competitors`, { limit: 10 }),
          ]);
          markTiming('source_collection');
          const directHomepage = {
            url: homepage.url || homepageUrl,
            content: homepage.text,
            links: homepage.links || [],
            purpose: 'company',
            provider: 'direct',
          };
          let pages = mergeCompanyResearchPages(firecrawlResearch.pages, [directHomepage], homepageUrl, { limit: 6 });
          if (firecrawlResearch.provider !== 'firecrawl') {
            if (firecrawlResearch.error && firecrawlResearch.error !== 'not_configured') {
              say('Firecrawl was unavailable; using direct first-party website reading');
            }
            const candidates = discoverCompanyPages(homepage.html, homepage.url || homepageUrl, { maxPages: 40 });
            const selected = selectCompanyResearchPages(candidates, homepage.url || homepageUrl, { maxPages: 5 });
            const discovered = selected.filter((page) => page.depth > 0);
            if (discovered.length) say(`Selected ${discovered.length} complementary pages from the homepage navigation`);
            else say('No additional company pages were linked from the homepage');
            const linkedPages = await Promise.all(discovered.map(async (page) => ({
              ...(await fetchPage(page.url)),
              purpose: page.purpose,
            })));
            pages = [homepage, ...linkedPages].map((page) => ({
              url: page.url,
              content: page.text,
              links: page.links || [],
              purpose: page.purpose || 'company',
              provider: 'direct',
            }));
          }
          const siteText = firstPartyResearchDigest(pages, { maxChars: 18000 });
          if (!siteText.trim()) say('Website unreachable — continuing from the domain name alone');
          let screenshot = null;
          let websiteVisualSource = 'pending';

          // Identity is synthesized from first-party pages only. The parallel
          // external search is used later for corroboration and never supplies
          // the company name, location, or offering.
          say('Verifying company identity and location');
          const research = [];

          say('Drafting your company profile');
          let profile;
          try {
            profile = JSON.parse(await llm(
              'You resolve a company identity from FIRST-PARTY website evidence. Output ONLY JSON: {"name":"","industry":"","business_model":"","capabilities":[""],"tagline":"","what_it_does":"","icp":"","offer":"","positioning":"","competitors":[],"tone":"","opportunities":["",""],"risks":["",""],"location":"","location_city":"","location_region":"","location_country":"","location_evidence_url":"","location_source":"","evidence_gaps":[""]}. Rules: (1) every factual field must be supported by supplied first-party sources or the explicitly labeled user claim; (2) never substitute a similarly named company; (3) location means company HQ/operating location. Prefer an explicit contact/imprint/legal-page location and set location_source=first_party. If the site has no location but USER-PROVIDED COMPANY LOCATION is present, preserve it exactly and set location_source=user_claim; (4) never infer location from TLD, language, audience, or desired market; (5) if location is absent from both sources, return empty and list it in evidence_gaps; (6) competitors remain empty unless the company itself names them; (7) use the exact website brand name. Keep prose concise.',
              `Requested website: ${siteUrl}\nCanonical domain: ${host}\nUSER-PROVIDED COMPANY LOCATION: ${claimedCompanyLocation || '(none)'}\nUser goal: ${userGoal || '(none stated)'}\n\nFIRST-PARTY SOURCES ONLY:\n${siteText || '(website unavailable; keep unsupported fields empty)'}`,
              { json: true, maxTokens: 1100 },
            ));
          } catch {
            profile = { name: companyGuess, industry: '', business_model: '', capabilities: [], tagline: '', what_it_does: '', icp: '', offer: '', positioning: '', competitors: [], tone: '', opportunities: [], risks: [], location: '', location_city: '', location_region: '', location_country: '', location_evidence_url: '', evidence_gaps: ['Company profile synthesis unavailable'] };
          }
          profile = normalizeCompanyProfile(profile, {
            fallbackName: companyGuess,
            websiteUrl: homepageUrl,
            claimedLocation: claimedCompanyLocation,
          });
          profile.social_profiles = Array.isArray(firecrawlResearch.social_profiles)
            ? firecrawlResearch.social_profiles
            : [];
          profile.contact_details = firecrawlResearch.contacts || extractCompanyContacts(pages);
          markTiming('profile_synthesis');
          // Clamp: the LLM sometimes copies the site <title> verbatim
          // ("B&B. | Sinn für Marken | Markenagentur aus Hannover") — keep only
          // the segment before any "|"/"–" separator, cap length hard.
          const companyName = String(profile.name || companyGuess)
            .split(/\s*[|–—]\s*/)[0].trim().slice(0, 48) || companyGuess;

          say('Researching your market from the verified company profile');
          const locationContext = profile.location || profile.location_country || '';
          const evidenceQuery = `${companyName} ${host}`;
          say(`Running one company and social-presence search for ${companyName}...`);
          say('Writing your mission');
          const coveragePromise = initialCoverage.length ? Promise.resolve(initialCoverage) : (async () => {
            let findings = await searchCompanyMarket(evidenceQuery, {
              limit: 10,
              location: locationContext,
              country: profile.location_country,
            });
            if (!findings.length) findings = await webSearch(evidenceQuery, { limit: 10 });
            return findings;
          })();
          const missionPromise = llm(
            'Write a crisp 2-3 sentence company mission statement grounded in the profile. Output only the mission text.',
            JSON.stringify(profile), { maxTokens: 200 },
          ).catch(() => `Build ${companyName} into the category leader.`);
          let [coverage, mission] = await Promise.all([coveragePromise, missionPromise]);
          profile.social_profiles = verifiedSocialProfiles(pages, coverage, {
            includeSearchCandidates: true,
            companyName,
            websiteUrl: homepageUrl,
          });
          const officialSocialUrls = new Set(profile.social_profiles.map((social) => social.url));
          const identityTerms = [host, host.split('.')[0], companyName]
            .map((value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, ''))
            .filter((value) => value.length >= 5);
          coverage = coverage.filter((item) => {
            if (isFirstPartyUrl(item.url, homepageUrl)) return true;
            let normalizedUrl = '';
            try {
              const parsed = new URL(item.url);
              parsed.hostname = parsed.hostname.replace(/^www\./i, '');
              parsed.hash = '';
              parsed.search = '';
              parsed.pathname = parsed.pathname.replace(/\/$/, '');
              normalizedUrl = parsed.href;
            } catch { /* malformed search result */ }
            if (officialSocialUrls.has(normalizedUrl)) return true;
            const evidenceText = `${item.title || ''} ${item.snippet || ''} ${item.url || ''}`
              .toLowerCase().replace(/[^a-z0-9]/g, '');
            return identityTerms.some((term) => evidenceText.includes(term));
          });
          research.push(...coverage.map((item) => ({
            ...item,
            evidence_scope: isFirstPartyUrl(item.url, homepageUrl) ? 'first-party-search' : 'external-market',
          })));
          markTiming('mission_and_market');

          const companyContext = buildCompanyOperatingContext({
            company: companyName,
            website: siteUrl,
            profile,
            mission,
          }, { maxChars: 1600 });

          const starterRooms = DOMAIN_ROOM_DEFINITIONS.filter((roomDefinition) => roomDefinition.key !== 'general');
          const starterTaskGenerationPromise = llm(
            'Create one immediately useful starter task for EVERY supplied HyperAgents expertise room. Output ONLY JSON: {"tasks":[{"room_tag":"","title":"","detail":"","deliverable":""}]}. Use each room_tag exactly once and do not add tags. Titles must be action-oriented and at most 10 words. Each detail must be 30-60 words, company-specific, and explain the work, evidence, decision, and business value. Each deliverable must name one concrete output in at most 8 words. Research must verify unknowns; other rooms must consume verified company evidence instead of inventing claims. Do not create generic content for its own sake.',
            `ROOMS: ${JSON.stringify(starterRooms.map((roomDefinition) => ({ room_tag: roomDefinition.key, purpose: roomDefinition.purpose })))}\nCOMPANY: ${companyName}\nPROFILE: ${JSON.stringify(profile)}\nMISSION: ${mission}\nCURRENT SOURCES: ${JSON.stringify(research.slice(0, 6))}${userGoal ? `\nUSER PRIORITY: ${userGoal}` : ''}`,
            { json: true, maxTokens: 1800 },
          ).catch(() => null);

          say('Assembling your team');
          // One company per org: retire the prior company's agents + rooms + canon
          // BEFORE assembling the new team, so the fresh findMany sees an empty
          // active roster, hires 3 new specialists, and the HQ room seats only
          // this company's agents (no cross-company leak). Recoverable (archived).
          await clearPriorOnboarding();
          markTiming('replace_company_cleanup');

          // The screenshot is intentionally independent from profile creation.
          // Firecrawl can take ~25s to render a visual, while homepage text and
          // links arrive in under a second. Capture begins immediately and is
          // persisted after replacement cleanup without holding up onboarding.
          say(`Capturing homepage: https://${host}/...`);
          await prisma.organization.update({
            where: { id: orgId },
            data: { name: companyName },
          });
          const store = await _getEmployeeStore();
          let team = await prisma.digitalEmployee.findMany({ where: { orgId, archivedAt: null }, select: { id: true, name: true, roleArchetype: true }, take: 20 }).catch(() => []);
          // Legacy auto-hired generics (bare archetypes / the old Nova-Atlas-Vega
          // trio) don't count as specialists — the team must hold 3 REAL
          // marketplace professions. Generics are kept (never delete a user's
          // agents) but new specialist hires take their seats in the rooms.
          const _PLACEHOLDER_ROLES = new Set(['strategist', 'generalist', 'investigator', 'coordinator', 'skeptic',
            'chief strategist', 'growth lead', 'research analyst', '']);
          const _isSpecialist = (e) => !_PLACEHOLDER_ROLES.has(String(e.roleArchetype || '').trim().toLowerCase());
          const specialistCount = team.filter(_isSpecialist).length;
          if (store && specialistCount < 3) {
            // Marketplace catalog — MIRROR of FE shared/field-catalog.js (5 fields ×
            // 5 professions; a=role_archetype driving debate lanes). Keep in sync.
            const MARKETPLACE = {
              Marketing: [
                { t: 'Brand Strategist', a: 'strategist', b: 'positioning, narrative, brand architecture' },
                { t: 'Performance Marketer', a: 'investigator', b: 'paid acquisition, CAC, funnels, ROAS' },
                { t: 'Content Lead', a: 'generalist', b: 'editorial, SEO content, narrative at scale' },
                { t: 'SEO / Organic Growth', a: 'investigator', b: 'search, technical + content SEO, GEO' },
                { t: 'Lifecycle / CRM Manager', a: 'coordinator', b: 'retention, email/lifecycle, segmentation' },
              ],
              Fintech: [
                { t: 'Risk Analyst', a: 'skeptic', b: 'credit/fraud risk, exposure, models' },
                { t: 'Compliance Officer', a: 'skeptic', b: 'KYC/AML, licensing, regulatory' },
                { t: 'Payments PM', a: 'generalist', b: 'rails, processors, settlement, fees' },
                { t: 'Quantitative Analyst', a: 'investigator', b: 'pricing, modeling, unit economics' },
                { t: 'Treasury / Finance Lead', a: 'strategist', b: 'runway, capital, margin, forecasting' },
              ],
              Legal: [
                { t: 'Corporate Counsel', a: 'skeptic', b: 'entity, governance, commercial' },
                { t: 'Contracts Specialist', a: 'investigator', b: 'drafting, redlines, terms, risk' },
                { t: 'IP Attorney', a: 'strategist', b: 'patents, trademarks, IP strategy' },
                { t: 'Regulatory / Compliance Counsel', a: 'skeptic', b: 'sector regulation, filings, audits' },
                { t: 'Privacy / Data Counsel', a: 'skeptic', b: 'GDPR/data, consent, processing' },
              ],
              Product: [
                { t: 'Product Manager', a: 'coordinator', b: 'roadmap, priorities, outcomes' },
                { t: 'UX Researcher', a: 'investigator', b: 'user insight, evidence, jobs-to-be-done' },
                { t: 'Systems / Platform PM', a: 'generalist', b: 'architecture, dependencies, scale' },
                { t: 'Data / Analytics PM', a: 'investigator', b: 'metrics, experiments, instrumentation' },
                { t: 'Design Lead', a: 'strategist', b: 'craft, flows, coherence, brand fit' },
              ],
              Operations: [
                { t: 'Operations Lead (COO-style)', a: 'coordinator', b: 'process, throughput, accountability' },
                { t: 'Supply Chain Analyst', a: 'investigator', b: 'inventory, demand, logistics' },
                { t: 'RevOps Manager', a: 'generalist', b: 'pipeline, CRM, forecasting, handoffs' },
                { t: 'Customer Success Lead', a: 'coordinator', b: 'onboarding, retention, expansion' },
                { t: 'Program / Delivery Manager', a: 'coordinator', b: 'plans, risk, cross-team delivery' },
              ],
            };
            // Add a company-specific lane derived from the grounded profile.
            // This protects first-run staffing from provider failures and gives
            // the selector real domain professions instead of forcing every
            // company into generic marketing, product, or fintech roles.
            const domainRoles = fallbackDomainHires(profile);
            const domainField = domainRoles[0]?.field || profile.industry || 'Industry';
            MARKETPLACE[domainField] = domainRoles.map((role) => ({
              t: role.title, a: role.archetype, b: role.blurb,
            }));
            say(`Matching specialists to your domain: ${profile.industry || domainField}`);
            // Show the archetype [in brackets] so the picker can BALANCE the debate lenses.
            const catalogText = Object.entries(MARKETPLACE)
              .map(([f, ps]) => `${f}: ${ps.map((p) => `${p.t} [${p.a}]`).join(' | ')}`).join('\n');
            say('Choosing your specialists from the marketplace');
            // LLM picks the top 3 professions for THIS company + a human first
            // name each — no generic Nova/Atlas defaults, no bare archetypes.
            // CRITICAL for robust round-tables: the trio must span COMPLEMENTARY debate lenses
            // (a challenger + an evidence-hound + a direction-setter), not three of one archetype
            // (which debate as yes-men). Archetypes are shown in [brackets] in the catalog.
            let picks = [];
            try {
              const pj = JSON.parse(await llm(
                'You staff a 3-person AI team for a specific company from a fixed marketplace catalog. Each profession has an [archetype] tag. Output ONLY JSON: {"hires":[{"field":"<exact field>","title":"<exact profession title from the catalog>","name":"<realistic human first name, varied genders/origins, NOT Nova/Atlas/Vega>","focus":"<=12 words tying the role to THIS company"}]}. Pick EXACTLY 3, each from the catalog verbatim. RULES: (1) prioritize the company-specific domain field and choose at least two roles from it; (2) the three MUST span complementary lenses — ONE [skeptic], ONE [investigator], and ONE [strategist], [generalist], or [coordinator]; (3) no duplicate titles; (4) match the company\'s actual work and business model, not merely the user\'s first goal.',
                `COMPANY-SPECIFIC DOMAIN FIELD: ${domainField}\nCATALOG:\n${catalogText}\n\nCOMPANY: ${companyName}\nPROFILE: ${JSON.stringify(profile)}\nMISSION: ${mission}${userGoal ? `\nSTATED GOAL: ${userGoal}` : ''}`,
                { json: true, maxTokens: 500 },
              ));
              picks = (Array.isArray(pj.hires) ? pj.hires : [])
                .map((h) => {
                  const prof = (MARKETPLACE[h.field] || Object.values(MARKETPLACE).flat())
                    .find?.((p) => p.t === h.title)
                    || Object.values(MARKETPLACE).flat().find((p) => p.t === h.title);
                  return prof ? { name: String(h.name || '').trim().slice(0, 40), title: prof.t, archetype: prof.a, blurb: prof.b, focus: String(h.focus || '').slice(0, 120), field: h.field } : null;
                })
                .filter((x) => x && x.name)
                .slice(0, 3);
            } catch { /* fallback below */ }
            if (picks.length < 3 - specialistCount) {
              picks = domainRoles;
            }
            // Deterministic robustness guarantee: the trio must cover a CHALLENGER [skeptic],
            // an EVIDENCE lens [investigator], and a DIRECTION lens [strategist|generalist|
            // coordinator]. If the picks collapsed onto fewer lenses (LLM variance), re-cast the
            // REDUNDANT pick(s) to the missing archetype — keeping the human name, preferring a
            // field the picker already chose (category fit). This makes skepticism + character
            // distribution UNIFORM across every founding team → robust round-tables.
            if (picks.length === 3) {
              const LEADER = new Set(['strategist', 'generalist', 'coordinator']);
              const laneOf = (a) => (LEADER.has(a) ? 'leader' : a); // skeptic | investigator | leader
              const flat = Object.entries(MARKETPLACE).flatMap(([field, ps]) => ps.map((p) => ({ ...p, field })));
              const preferred = [...new Set(picks.map((p) => p.field).filter(Boolean))];
              const findFor = (lane, used) => {
                const pool = flat.filter((p) => laneOf(p.a) === lane && !used.has(p.t));
                return pool.find((p) => preferred.includes(p.field)) || pool[0] || null;
              };
              const have = new Set(picks.map((p) => laneOf(p.archetype)));
              const missing = ['skeptic', 'investigator', 'leader'].filter((w) => !have.has(w));
              if (missing.length) {
                const used = new Set(picks.map((p) => p.title));
                const laneCount = {};
                picks.forEach((p) => { const l = laneOf(p.archetype); laneCount[l] = (laneCount[l] || 0) + 1; });
                for (const miss of missing) {
                  const idx = picks.findIndex((p) => laneCount[laneOf(p.archetype)] > 1);
                  if (idx === -1) break;
                  const prof = findFor(miss, used);
                  if (!prof) continue;
                  laneCount[laneOf(picks[idx].archetype)] -= 1;
                  used.delete(picks[idx].title); used.add(prof.t);
                  picks[idx] = { name: picks[idx].name, title: prof.t, archetype: prof.a, blurb: prof.b, focus: picks[idx].focus || prof.b, field: prof.field };
                  laneCount[laneOf(prof.a)] = (laneCount[laneOf(prof.a)] || 0) + 1;
                }
                say('Balancing the team so your round-table has a challenger, an analyst, and a lead');
              }
            }
            const hires = await Promise.all(picks.slice(0, 3 - specialistCount).map(async (r) => {
              say(`Hiring ${r.name} — ${r.title} (${r.field})`);
              let persona = '';
              try {
                persona = await llm(
                  `You write concise system prompts for AI digital employees. Output ONLY the persona as plain text, 3-5 sentences, second person ("You are ..."). The employee is a ${r.title} (${r.blurb}) — an ${r.archetype}-minded specialist. Ground it in the company context provided: this is a ${r.title} for THIS company, not a generic role.`,
                  `Name: ${r.name}\nProfession: ${r.title} — ${r.blurb}\nCompany focus: ${r.focus}\nCompany: ${companyName}\nProfile: ${JSON.stringify(profile)}\nMission: ${mission}`,
                  { maxTokens: 260 },
                );
              } catch { /* fallback below */ }
              if (!persona) persona = `You are ${r.name}, ${r.title} at ${companyName} (${r.blurb}). You are an ${r.archetype}-minded specialist focused on ${r.focus}. You are direct, grounded in the company's real context, and always propose the next concrete action.`;
              try {
                const emp = await store.create({
                  orgId, name: r.name, persona,
                  roleArchetype: r.title, createdBy: userId,
                });
                return { id: emp.id, name: emp.name, roleArchetype: r.title };
              } catch (e) { console.warn('[hyper-onboarding] hire failed:', e.message); return null; }
            }));
            team.push(...hires.filter(Boolean));
            _notifyEmployeesReload();
          }
          markTiming('team_assembly');

          // ── File the company knowledge as a HIGH-SALIENCE, entity-rich
          // sectioned cluster so it always tops recall and grounds every agent.
          // Generic for any org: entities derived from name/aliases/domain/team.
          say('Filing your documents');
          say('Locking in your vision');
          // (prior company's agents/rooms/canon already retired at team-assembly)
          const lc = (s) => String(s || '').toLowerCase();
          const entityTags = Array.from(new Set([
            `entity:${lc(companyName)}`,
            `entity:${lc(companyName.split(/[\s.,]/)[0])}`,   // first token alias (e.g. "B&B")
            `entity:${lc(host)}`,                             // domain
            `entity:${lc(host.split('.')[0])}`,               // domain root
            ...team.map((tm) => `entity:${lc(tm.name)}`),     // each teammate (+0.14/match)
          ].filter((t) => t.length > 8)));
          // org-canon = the pinned "always company context" marker; company-profile
          // = the stable canon lane; pinned = never-decay; source tag = provenance.
          const canonTags = ['org-canon', 'company-profile', 'pinned', 'onboarding', 'source:hyperagents-onboarding', ...entityTags];
          const sections = [
            { title: `${companyName} — Company profile`, memoryType: 'summary',
              content: `COMPANY IDENTITY — ${companyName}${profile.tagline ? ` ("${profile.tagline}")` : ''}. ${profile.what_it_does || ''} Website: ${siteUrl}.${profile.location ? ` Company location: ${profile.location}.` : ''}` },
            ...(profile.location ? [{ title: `${companyName} — Company location`, memoryType: 'fact', authorityLevel: profile.location_source === 'first_party' ? 'verified' : 'claimed',
              content: `COMPANY LOCATION (${profile.location_source === 'first_party' ? 'first-party verified' : 'user provided'}) — ${companyName}: ${profile.location}. Evidence: ${profile.location_evidence_url || siteUrl}. Use this location to ground local market, customer, competitor, regulatory, hiring, and outreach research; do not treat it as the user's home address.` }] : []),
            ...((profile.social_profiles || []).length ? [{ title: `${companyName} — Social presence`, memoryType: 'fact', authorityLevel: 'verified',
              content: `SOCIAL PROFILES for ${companyName}: ${(profile.social_profiles || []).map((social) => `${social.platform}: ${social.url} [${(social.verified_by || []).join('+')}]`).join('; ')}.` }] : []),
            ...((profile.contact_details?.emails || []).length || (profile.contact_details?.phones || []).length ? [{ title: `${companyName} — Official contact points`, memoryType: 'fact', authorityLevel: 'verified',
              content: `OFFICIAL CONTACTS for ${companyName}, found on first-party pages. Emails: ${(profile.contact_details?.emails || []).join(', ') || '(none)'}. Phones: ${(profile.contact_details?.phones || []).join(', ') || '(none)'}.` }] : []),
            { title: `${companyName} — Mission`, memoryType: 'summary',
              content: `MISSION of ${companyName}: ${mission}` },
            { title: `${companyName} — Positioning`, memoryType: 'decision',
              content: `POSITIONING of ${companyName}: ${profile.positioning || '(n/a)'}${profile.tone ? ` Tone: ${profile.tone}.` : ''}` },
            { title: `${companyName} — ICP / target segments`, memoryType: 'decision',
              content: `ICP / TARGET SEGMENTS for ${companyName}: ${profile.icp || '(n/a)'}.${profile.offer ? ` Offer: ${profile.offer}.` : ''}` },
            { title: `${companyName} — Competitors & market`, memoryType: 'fact',
              content: `COMPETITORS of ${companyName}: ${(profile.competitors || []).join(', ') || '(none identified)'}.\nMARKET RESEARCH:\n${research.map((r) => `• ${r.title}: ${r.snippet}`).join('\n')}`.slice(0, 6000) },
            { title: `${companyName} — Operating context`, memoryType: 'summary', authorityLevel: 'verified',
              content: companyContext },
          ];
          await Promise.all(sections.map((section) => saveMemory({ ...section, tags: canonTags })));

          // Mirror the company identity into ORG-SCOPED profile facts so the
          // /hivemind/app/profile page + the get_user_profile chat tool show the
          // organization, not just the person. Onboarding already writes these as
          // org-canon MEMORIES (above); profile facts are the structured,
          // page-rendered surface. Best-effort — a fact-write failure must never
          // break onboarding. orgId scopes them; the onboarding userId is the
          // owner. Reuses ProfileStore.upsertFact (same store the API + dreamer use).
          try {
            const { getSharedProfileStore } = await import('./memory/profile-store.js');
            const _ps = getSharedProfileStore(prisma);
            const companyFacts = [
              { key: 'company', value: companyName },
              { key: 'company:mission', value: mission },
              { key: 'company:tagline', value: profile.tagline || null },
              { key: 'company:what_it_does', value: profile.what_it_does || null },
              { key: 'company:industry', value: profile.industry || null },
              { key: 'company:business_model', value: profile.business_model || null },
              { key: 'company:capabilities', value: (profile.capabilities || []).join('\n') || null },
              { key: 'company:offer', value: profile.offer || null },
              { key: 'company:positioning', value: profile.positioning || null },
              { key: 'company:icp', value: profile.icp || null },
              { key: 'company:tone', value: profile.tone || null },
              { key: 'company:opportunities', value: (profile.opportunities || []).join('\n') || null },
              { key: 'company:risks', value: (profile.risks || []).join('\n') || null },
              { key: 'company:evidence_gaps', value: (profile.evidence_gaps || []).join('\n') || null },
              { key: 'company:website', value: siteUrl || null },
              { key: 'company:social_profiles', value: (profile.social_profiles || []).map((social) => `${social.platform}: ${social.url}`).join('\n') || null },
              { key: 'company:contact_emails', value: (profile.contact_details?.emails || []).join('\n') || null },
              { key: 'company:contact_phones', value: (profile.contact_details?.phones || []).join('\n') || null },
              { key: 'company:operating_context', value: companyContext || null },
              { key: 'company:location', value: profile.location || null },
              { key: 'location', value: profile.location ? `Company HQ: ${profile.location}` : null },
              { key: 'company:location_city', value: profile.location_city || null },
              { key: 'company:location_region', value: profile.location_region || null },
              { key: 'company:location_country', value: profile.location_country || null },
            ].filter((f) => f.value && String(f.value).trim());
            await Promise.all(companyFacts.map((fact) => _ps.upsertFact({
                userId, orgId, category: 'static',
                key: fact.key, value: String(fact.value).slice(0, fact.key === 'company:operating_context' ? 2400 : 900),
                confidence: 0.95, sourceMemoryId: null,
              }).catch(() => {})));
          } catch (err) {
            console.warn('[onboarding] company→profile facts failed (non-fatal):', err.message);
          }
          markTiming('memory_and_profile');

          say('Planning your first tasks');
          let tasks = [];
          try {
            const generatedTasks = await starterTaskGenerationPromise;
            const tj = generatedTasks ? JSON.parse(generatedTasks) : { tasks: [] };
            const proposed = new Map((Array.isArray(tj.tasks) ? tj.tasks : [])
              .filter((task) => task && starterRooms.some((roomDefinition) => roomDefinition.key === task.room_tag))
              .map((task) => [task.room_tag, task]));
            tasks = starterRooms.map((roomDefinition, i) => {
              const x = proposed.get(roomDefinition.key) || {};
              return {
                id: `t${i + 1}`,
                room_tag: roomDefinition.key,
                room_name: roomDefinition.name,
                title: String(x.title || '').trim().slice(0, 80),
                detail: String(x.detail || '').trim().slice(0, 520),
                deliverable: String(x.deliverable || '').trim().slice(0, 160),
                tag: roomDefinition.key === 'research' ? 'RESEARCH'
                  : roomDefinition.key === 'product' || roomDefinition.key === 'design' ? 'FEATURE'
                    : roomDefinition.key === 'legal_finance' || roomDefinition.key === 'fundraising' ? 'STRATEGY'
                      : 'MARKETING',
                status: 'todo',
                room_id: null,
              };
            });
            if (tasks.some((task) => !task.title || !task.detail || !task.deliverable)) tasks = [];
          } catch { /* tasks optional */ }
          if (tasks.length !== starterRooms.length) {
            const localMarket = profile.location || profile.location_country || 'the company operating market';
            const fallbackTasks = {
              seo: ['Establish the search growth baseline', `Audit ${companyName}'s rendered website, indexability, page structure, search demand, and competitor visibility. Rank the technical and content opportunities by likely business impact, effort, and supporting evidence so the SEO room has a measurable starting point.`, 'Prioritized SEO baseline'],
              marketing: ['Choose the first growth experiment', `Use the verified offer, audience, and market context to select one focused experiment for ${localMarket}. Define the audience, message, channel, expected behavior, measurement method, and stop-or-scale decision without relying on unsupported demand assumptions.`, 'Growth experiment brief'],
              outreach: ['Build the first qualified prospect set', `Use the verified company profile, ICP, location, existing lead book, and source-backed discovery to identify relevant prospects for ${localMarket}. Persist only qualified records with evidence, a distinct fit rationale, and a personalized outreach angle. Do not contact anyone without the organization policy allowing it.`, 'Qualified prospect set'],
              campaign: ['Design the first campaign system', `Turn ${companyName}'s strongest defensible position into an approval-ready campaign direction. Specify the objective, audience, channel roles, content sequence, creative requirements, schedule, and success signals while keeping every public claim tied to available company evidence.`, 'Campaign operating brief'],
              branding: ['Sharpen the company narrative', `Compare ${companyName}'s current language with verified buyer needs and credible alternatives. Recommend a differentiated narrative, message hierarchy, voice principles, proof points, and prohibited claims that every market-facing room can reuse consistently.`, 'Brand narrative framework'],
              fundraising: ['Assess fundraising readiness', `Evaluate the company story, market evidence, traction signals, milestones, investor fit, and material gaps. Produce a candid readiness recommendation that separates verified facts from assumptions and identifies what must be proven before beginning investor outreach.`, 'Fundraising readiness memo'],
              research: ['Close the highest-risk evidence gaps', `Investigate unresolved company, buyer, competitor, location, and market questions using first-party sources and authoritative external evidence. Record citations, contradictions, confidence, and the decisions each finding unlocks for the other specialist rooms.`, 'Verified evidence register'],
              product: ['Prioritize the customer problem', `Translate the strongest verified buyer pain into one product priority. Define the affected user, desired outcome, current friction, assumptions, validation method, dependencies, and measurable acceptance signals before recommending implementation.`, 'Product priority brief'],
              design: ['Review the critical user journey', `Identify the highest-value user journey across ${companyName}'s current experience. Evaluate comprehension, trust, friction, accessibility, and conversion moments, then produce a focused improvement brief grounded in observed evidence rather than decorative redesign.`, 'Journey improvement brief'],
              legal_finance: ['Map immediate obligations and economics', `Identify the material legal, privacy, regulatory, contractual, financial, and unit-economic questions for ${localMarket}. Rank exposure and business impact, distinguish internal actions from matters requiring qualified professional review, and define the next evidence needed.`, 'Risk and economics register'],
            };
            tasks = starterRooms.map((roomDefinition, i) => ({
              id: `t${i + 1}`,
              room_tag: roomDefinition.key,
              room_name: roomDefinition.name,
              title: fallbackTasks[roomDefinition.key][0],
              detail: fallbackTasks[roomDefinition.key][1],
              deliverable: fallbackTasks[roomDefinition.key][2],
              tag: roomDefinition.key === 'research' ? 'RESEARCH'
                : roomDefinition.key === 'product' || roomDefinition.key === 'design' ? 'FEATURE'
                  : roomDefinition.key === 'legal_finance' || roomDefinition.key === 'fundraising' ? 'STRATEGY'
                    : 'MARKETING',
              status: 'todo',
              room_id: null,
            }));
          }
          // Website onboarding has one non-negotiable first research move. It
          // is deterministic rather than LLM-optional so every company gets a
          // source-backed competitor and local-market brief in its task list.
          // Day 1 selects this marked task; all other generated tasks retain
          // their current titles, order, and wire shape.
          if (siteUrl) {
            const localMarket = profile.location || profile.location_city || profile.location_country || 'the company operating market';
            const competitorTask = tasks.find((task) => task.room_tag === 'research');
            if (competitorTask) {
              Object.assign(competitorTask, {
                title: 'Map competitors and the local market',
                detail: `Build a source-backed competitor and market research brief for ${companyName} in ${localMarket}. Start from ${siteUrl}; identify direct and adjacent alternatives, buyer segments, positioning, local demand signals, and material constraints. Treat the company HQ / operating location (${localMarket}) as the required geographic anchor. Cite every competitor and market claim, distinguish evidence from assumptions, and record contradictions or gaps.`,
                deliverable: 'Competitor and local-market research brief',
                tag: 'RESEARCH',
                status: 'todo',
                room_id: null,
                day1_first_move: true,
              });
            }
          }
          say('Saving your tasks');

          say('Provisioning your workspace');
          // Marketplace specialists take the room seats ahead of legacy generics.
          const rankedTeam = [...team].sort((a, b) => Number(_isSpecialist(b)) - Number(_isSpecialist(a)));
          const participantIds = rankedTeam.map((t) => t.id).slice(0, 5);
          const room = await createHyperRoom({
              userId, orgId,
              name: `${companyName} — HQ`,
              participantIds,
              template: 'auto',
              permanentLeadId: participantIds.slice().sort()[0] || null,
          });
          // "You are the team running <name>" — NOT "Operate <name>", which a
          // model can misread as a proper noun ("Operate B&B" evaluated as a
          // third-party partner company in a live run).
          const roomGoal = `You are the team running ${companyName} — this is YOUR company.\n${companyContext}\nFIRST TASKS:\n${tasks.map((x, i) => `${i + 1}. ${x.title} — ${x.detail}`).join('\n')}`.slice(0, 2400);
          try {
            await prisma.$executeRawUnsafe('UPDATE "hivemind"."hyper_rooms" SET "goal" = $1 WHERE "id" = $2::uuid', roomGoal, room.id);
          } catch (e) { console.warn('[hyper-onboarding] room goal failed:', e.message); }

          say('Almost done');
          const resultPayload = {
            company: companyName,
            website: siteUrl,
            screenshot: screenshot || null,
            website_visual_source: websiteVisualSource,
            screenshot_pending: true,
            research_provider: firecrawlResearch.provider,
            company_location: profile.location || null,
            profile, mission, company_context: companyContext, tasks,
            research: research.slice(0, 10),
            source_pages: pages.slice(0, 12).map((page) => ({ url: page.url || '', title: page.title || '', purpose: page.purpose || 'company' })).filter((page) => page.url),
            documents: [
              `${companyName} — Company profile`,
              ...(research.length ? [`${companyName} — Market research`] : []),
              `${companyName} — Mission`,
            ],
            team: rankedTeam.slice(0, 6).map((x) => ({ id: x.id, name: x.name, role: x.roleArchetype || null })),
            room_id: room.id,
            room_name: room.name,
            onboarded_at: new Date().toISOString(),
            onboarding_duration_ms: Date.now() - job.startedAt,
            onboarding_timings_ms: job.timings,
          };
          try {
            resultPayload.domain_rooms = await ensureDomainRooms({
              prisma,
              orgId,
              userId,
              participantIds,
              company: resultPayload,
            });
          } catch (e) {
            console.warn('[hyper-onboarding] domain rooms failed:', e.message);
            resultPayload.domain_rooms = [];
          }
          markTiming('workspace_provisioning');
          resultPayload.onboarding_duration_ms = Date.now() - job.startedAt;
          resultPayload.onboarding_timings_ms = { ...job.timings, total: resultPayload.onboarding_duration_ms };
          // Persist the company state on the HQ room (agent_connectors is a
          // legacy jsonb — we namespace under _company). Central for ALL org
          // types (rooms never live on the self-host agent), zero-migration,
          // and it survives control-plane restarts — the dashboard reads it
          // via GET /v1/hyper/company.
          try {
            await prisma.$executeRawUnsafe(
              'UPDATE "hivemind"."hyper_rooms" SET "agent_connectors" = "agent_connectors" || $1::jsonb WHERE "id" = $2::uuid',
              JSON.stringify({ _company: resultPayload }), room.id,
            );
          } catch (e) { console.warn('[hyper-onboarding] company state persist failed:', e.message); }
          try {
            await activateHqAfterOnboarding({
              prisma, orgId, userId, objective: FIRST_LIFE_OBJECTIVE, onboardedAt: resultPayload.onboarded_at,
            });
            say('Runtime is ready for its first wake');
          } catch (error) {
            console.warn('[hyper-onboarding] HQ activation failed:', error.message);
            say('HQ activation is queued for retry');
          }
          void (async () => {
            const capturedScreenshot = await screenshotCapturePromise;
            let finalScreenshot = await storeFirecrawlWebsiteVisual({ screenshot: capturedScreenshot, orgId });
            let finalSource = finalScreenshot ? 'playwright-screenshot' : null;
            if (!finalScreenshot) {
              const firecrawlScreenshot = await captureWebsiteScreenshot(homepage.url || homepageUrl);
              finalScreenshot = await storeFirecrawlWebsiteVisual({ screenshot: firecrawlScreenshot, orgId });
              finalSource = finalScreenshot ? 'firecrawl-screenshot' : null;
            }
            if (!finalScreenshot) {
              finalScreenshot = await storeOfficialWebsiteVisual({ html: homepage.html || '', pageUrl: homepage.url || homepageUrl, orgId });
              finalSource = finalScreenshot ? 'official-site-image' : null;
            }
            resultPayload.screenshot = finalScreenshot;
            resultPayload.website_visual_source = finalSource;
            resultPayload.screenshot_pending = false;
            job.result = resultPayload;
            if (finalScreenshot) say('Website preview ready');
            else say('Website preview unavailable — using a branded company card');
            try {
              await prisma.$executeRawUnsafe(
                'UPDATE "hivemind"."hyper_rooms" SET "agent_connectors" = "agent_connectors" || $1::jsonb WHERE "id" = $2::uuid',
                JSON.stringify({ _company: resultPayload }), room.id,
              );
            } catch (error) { console.warn('[hyper-onboarding] website preview persist failed:', error.message); }
            // Do not send Day-0 from the background scrape. It is claimed
            // exactly once after the completed record is visibly loaded in
            // "Your Company" (POST /v1/hyper/company/day0-report).
          })();
          console.info('[hyper-onboarding] timing', JSON.stringify({
            org_id: orgId,
            company: companyName,
            provider: firecrawlResearch.provider,
            screenshot: 'pending',
            social_profiles: profile.social_profiles.length,
            timings_ms: resultPayload.onboarding_timings_ms,
          }));
          say(`Completed · onboarding in ${Math.max(1, Math.round((Date.now() - job.startedAt) / 1000))}s`);
          job.result = resultPayload;
          job.done = true;
        } catch (err) {
          console.warn('[hyper-onboarding] failed:', err.message);
          say(`Onboarding hit an error: ${err.message}`);
          job.error = err.message;
          job.done = true;
        }
      })();

      return jsonResponse(res, { ok: true, started: true });
    }

    // POST /v1/hyper/onboarding/reset — replace-company reset. Prior Rooms and
    // employees are archived, organization memories/vectors are purged, and
    // structured company profile facts are retired. Identity, membership,
    // billing, connector credentials, and immutable audit history are retained.
    if (pathname === '/v1/hyper/onboarding/reset' && req.method === 'POST') {
      const current = await requireSession(req, res);
      if (!current) return;
      try {
        const reset = await clearHyperCompanyContext({
          orgId: current.session.orgId,
          userId: current.session.userId,
        });
        _hyperOnboardJobs.delete(current.session.orgId);
        return jsonResponse(res, { ok: true, reset });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // GET /v1/hyper/company/screenshot — stream the session org's homepage
    // capture from the data volume (cookie-auth; served lazily so the ~130KB
    // never rides in the /company JSON). 404 when none captured yet.
    if (pathname === '/v1/hyper/company/screenshot' && req.method === 'GET') {
      const current = await requireSession(req, res);
      if (!current) return;
      try {
        const paths = companyVisualPaths(current.session.orgId);
        const fp = fs.existsSync(paths.screenshot) ? paths.screenshot
          : (fs.existsSync(paths.official) ? paths.official : null);
        if (!fp) return jsonResponse(res, { error: 'no screenshot' }, 404);
        const buf = fs.readFileSync(fp);
        let contentType = 'image/jpeg';
        if (fp === paths.official && fs.existsSync(paths.metadata)) {
          try {
            contentType = JSON.parse(fs.readFileSync(paths.metadata, 'utf8')).contentType || contentType;
          } catch { /* retain safe JPEG default */ }
        }
        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': buf.length,
          'Cache-Control': 'private, max-age=300',
          'X-Content-Type-Options': 'nosniff',
        });
        return res.end(buf);
      } catch (err) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // Public, immutable avatar asset used by lifecycle emails. It renders the
    // same Humation package, stable seed, and role palette as AgentAvatar.jsx.
    if (pathname === '/v1/public/humation-avatar.svg' && req.method === 'GET') {
      const seed = String(url.searchParams.get('seed') || '').trim().slice(0, 160);
      const roleArchetype = String(url.searchParams.get('role') || 'Communicator').trim().slice(0, 40);
      if (!seed) return jsonResponse(res, { error: 'seed_required' }, 400);
      const svg = renderHumationAvatarSvg({ id: seed, name: roleArchetype, roleArchetype }, { size: 72 });
      res.writeHead(200, {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Content-Length': Buffer.byteLength(svg),
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
      });
      return res.end(svg);
    }

    // POST /v1/hyper/company/day0-report — the CompanyDashboard calls this
    // only after it has rendered the completed company payload. The database
    // claim makes delivery idempotent across refreshes, tabs, and retries:
    // one organization gets one Day-0 report, not one per scrape or page load.
    if (pathname === '/v1/hyper/company/day0-report' && req.method === 'POST') {
      const current = await requireSession(req, res);
      if (!current) return;
      try {
        const rows = await prisma.$queryRawUnsafe(
          `SELECT id
             FROM "hivemind"."hyper_rooms"
            WHERE org_id = $1::uuid AND "agent_connectors" ? '_company' AND archived_at IS NULL
            ORDER BY created_at DESC LIMIT 1`,
          current.session.orgId,
        );
        const row = rows?.[0];
        if (!row?.id) return jsonResponse(res, { error: 'not_onboarded' }, 404);
        const started = await startDayZeroOnboardingReport({
          prisma,
          orgId: current.session.orgId,
          hqRoomId: row.id,
          userId: current.session.userId,
        });
        if (!started.accepted) return jsonResponse(res, started);
        // Day 1 is scheduled only after the first Day-0 receipt. A versioned
        // report reissue never starts a second complimentary lifecycle.
        void started.completion.then(async (result) => {
          if (started.reissue) return;
          // Day 0 seals onboarding; activation reminders stop here. Day 1+
          // remain owned by their established, typed lifecycle workflows.
          const owner = await prisma.user.findUnique({ where: { id: current.session.userId }, select: { email: true } }).catch(() => null);
          if (owner?.email) {
            await advanceActivationForEmail({
              prisma, email: owner.email, userId: current.session.userId, orgId: current.session.orgId,
              stage: ACTIVATION_STAGES.DAY0_DELIVERED, reason: 'day0_delivered',
            });
          }
          const dayOne = await scheduleDayOneWorkflow({
            orgId: started.orgId, hqRoomId: started.hqRoomId, onboardedAt: started.company.onboarded_at,
          });
          if (!dayOne.ok && !dayOne.skipped) console.warn('[hyper-company] day-1 workflow scheduling failed:', dayOne.reason);
          return result;
        }).catch((error) => console.warn('[hyper-company] day-0 report failed:', error.message));
        return jsonResponse(res, { ok: true, accepted: true, status: 'sending', version: DAY_ZERO_REPORT_VERSION }, 202);
      } catch (err) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // GET /v1/hyper/company — the HyperAgents hero dashboard state. Reads the
    // company payload persisted on the newest HQ room (agent_connectors._company)
    // and overlays live team + rooms. 404 when the org never onboarded.
    if (pathname === '/v1/hyper/company' && req.method === 'GET') {
      const current = await requireSession(req, res);
      if (!current) return;
      try {
        const rows = await prisma.$queryRawUnsafe(
          `SELECT id, name, "agent_connectors"->'_company' AS company
             FROM "hivemind"."hyper_rooms"
            WHERE org_id = $1::uuid AND "agent_connectors" ? '_company' AND archived_at IS NULL
            ORDER BY created_at DESC LIMIT 1`,
          current.session.orgId,
        );
        const row = rows?.[0];
        if (!row?.company) return jsonResponse(res, { onboarded: false }, 404);
        const company = typeof row.company === 'string' ? JSON.parse(row.company) : row.company;
        const employees = await prisma.digitalEmployee.findMany({
          where: { orgId: current.session.orgId, archivedAt: null },
          select: { id: true, slug: true, name: true, avatarUrl: true, roleArchetype: true, persona: true, status: true },
          take: 12,
        }).catch(() => []);
        // Closed-loop outcomes summary (7d) for the dashboard tile. Zeros when
        // the ledger table doesn't exist yet (un-migrated deploy) — never fail
        // the company payload over the counter.
        let outcomes = { emails_sent: 0, calls: 0, replies: 0, bookings: 0 };
        try {
          const oc = await prisma.$queryRawUnsafe(
            `SELECT
               COUNT(*) FILTER (WHERE channel = 'email' AND sent_at >= now() - interval '7 days') AS emails,
               COUNT(*) FILTER (WHERE channel = 'call'  AND sent_at >= now() - interval '7 days') AS calls,
               COUNT(*) FILTER (WHERE outcome = 'replied' AND outcome_at >= now() - interval '7 days') AS replies,
               COUNT(*) FILTER (WHERE outcome = 'booked'  AND outcome_at >= now() - interval '7 days') AS bookings
             FROM "hivemind"."outbound_actions"
            WHERE org_id = $1::uuid AND status = 'sent'`,
            current.session.orgId,
          );
          const o = oc?.[0] || {};
          outcomes = {
            emails_sent: Number(o.emails || 0), calls: Number(o.calls || 0),
            replies: Number(o.replies || 0), bookings: Number(o.bookings || 0),
          };
        } catch { /* zeros */ }
        const onboardedAtMs = Date.parse(company.onboarded_at || '');
        const lifecycleDay = Number.isFinite(onboardedAtMs)
          ? Math.max(0, Math.floor((Date.now() - onboardedAtMs) / 86_400_000))
          : 0;
        return jsonResponse(res, {
          onboarded: true,
          hq_room_id: row.id,
          company,
          employees,
          outcomes,
          lifecycle: { day: lifecycleDay, onboarded_at: company.onboarded_at || null },
        });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // PATCH /v1/hyper/company/location — explicit HQ confirmation collected
    // when the user enters the workspace. This is organization context, not a
    // personal/home address, and is mirrored to the org-scoped profile store.
    if (pathname === '/v1/hyper/company/location' && req.method === 'PATCH') {
      const current = await requireSession(req, res);
      if (!current) return;
      const body = await parseBody(req);
      const location = typeof body.location === 'string' ? body.location.trim().slice(0, 240) : '';
      if (location.length < 2) return jsonResponse(res, { error: 'headquarters location is required' }, 400);
      try {
        const rows = await prisma.$queryRawUnsafe(
          `SELECT id, "agent_connectors"->'_company' AS company
             FROM "hivemind"."hyper_rooms"
            WHERE org_id = $1::uuid AND "agent_connectors" ? '_company' AND archived_at IS NULL
            ORDER BY created_at DESC LIMIT 1`,
          current.session.orgId,
        );
        const row = rows?.[0];
        if (!row?.company) return jsonResponse(res, { error: 'not onboarded' }, 404);
        const company = typeof row.company === 'string' ? JSON.parse(row.company) : row.company;
        company.profile = { ...(company.profile || {}), location, location_source: 'user_claim', location_evidence_url: 'user-provided' };
        company.company_location = location;
        await prisma.$executeRawUnsafe(
          'UPDATE "hivemind"."hyper_rooms" SET "agent_connectors" = "agent_connectors" || $1::jsonb WHERE "id" = $2::uuid',
          JSON.stringify({ _company: company }), row.id,
        );
        try {
          const { getSharedProfileStore } = await import('./memory/profile-store.js');
          const profileStore = getSharedProfileStore(prisma);
          for (const fact of [
            { key: 'company:location', value: location },
            { key: 'location', value: `Company HQ: ${location}` },
          ]) {
            await profileStore.upsertFact({
              userId: current.session.userId,
              orgId: current.session.orgId,
              category: 'static',
              key: fact.key,
              value: fact.value,
              confidence: 1,
              sourceMemoryId: null,
            });
          }
        } catch (error) {
          console.warn('[hyper-company] HQ profile fact update failed:', error.message);
        }
        const activeJob = _hyperOnboardJobs.get(current.session.orgId);
        if (activeJob?.result) activeJob.result = company;
        return jsonResponse(res, { ok: true, company, location });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // PATCH /v1/hyper/company/contacts — user-corrected organization contact
    // details. Stored on the HQ company state and mirrored into org profile
    // facts so every room receives the corrected operating context.
    if (pathname === '/v1/hyper/company/contacts' && req.method === 'PATCH') {
      const current = await requireSession(req, res);
      if (!current) return;
      const body = await parseBody(req);
      const emails = Array.from(new Set((Array.isArray(body.emails) ? body.emails : [])
        .map((value) => String(value || '').trim().toLowerCase())
        .filter((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)))).slice(0, 5);
      const phones = Array.from(new Set((Array.isArray(body.phones) ? body.phones : [])
        .map((value) => String(value || '').trim().slice(0, 80))
        .filter((value) => value.replace(/\D/g, '').length >= 8))).slice(0, 5);
      const socialProfiles = (Array.isArray(body.social_profiles) ? body.social_profiles : []).map((item) => {
        const platform = String(item?.platform || '').trim().toLowerCase().slice(0, 40);
        const url = String(item?.url || '').trim().slice(0, 800);
        try { return platform && new URL(url).protocol === 'https:' ? { platform, url, verified_by: ['user_confirmed'] } : null; } catch { return null; }
      }).filter(Boolean).slice(0, 10);
      try {
        const rows = await prisma.$queryRawUnsafe(
          `SELECT id, "agent_connectors"->'_company' AS company FROM "hivemind"."hyper_rooms"
           WHERE org_id = $1::uuid AND "agent_connectors" ? '_company' AND archived_at IS NULL
           ORDER BY created_at DESC LIMIT 1`, current.session.orgId,
        );
        const row = rows?.[0];
        if (!row?.company) return jsonResponse(res, { error: 'not onboarded' }, 404);
        const company = typeof row.company === 'string' ? JSON.parse(row.company) : row.company;
        company.profile = { ...(company.profile || {}), social_profiles: socialProfiles, contact_details: { emails, phones } };
        await prisma.$executeRawUnsafe(
          'UPDATE "hivemind"."hyper_rooms" SET "agent_connectors" = "agent_connectors" || $1::jsonb WHERE "id" = $2::uuid',
          JSON.stringify({ _company: company }), row.id,
        );
        try {
          const { getSharedProfileStore } = await import('./memory/profile-store.js');
          const profileStore = getSharedProfileStore(prisma);
          await Promise.all([
            profileStore.upsertFact({ userId: current.session.userId, orgId: current.session.orgId, category: 'static', key: 'company:contact_emails', value: emails.join('\n'), confidence: 1, sourceMemoryId: null }),
            profileStore.upsertFact({ userId: current.session.userId, orgId: current.session.orgId, category: 'static', key: 'company:contact_phones', value: phones.join('\n'), confidence: 1, sourceMemoryId: null }),
            profileStore.upsertFact({ userId: current.session.userId, orgId: current.session.orgId, category: 'static', key: 'company:social_profiles', value: socialProfiles.map((item) => `${item.platform}: ${item.url}`).join('\n'), confidence: 1, sourceMemoryId: null }),
          ]);
        } catch (error) { console.warn('[hyper-company] contact profile fact update failed:', error.message); }
        return jsonResponse(res, { ok: true, company });
      } catch (err) { return jsonResponse(res, { error: err.message }, 500); }
    }

    // GET /v1/hyper/outcomes — closed-loop value counters for the dashboard:
    // what actually LEFT the platform (emails sent, calls placed) and what came
    // back (replies, bookings), from the outbound_actions ledger. 7d + 30d.
    if (pathname === '/v1/hyper/outcomes' && req.method === 'GET') {
      const current = await requireSession(req, res);
      if (!current) return;
      try {
        const [rows, prospectMemories] = await Promise.all([prisma.$queryRawUnsafe(
          `SELECT
             COUNT(*) FILTER (WHERE channel = 'email' AND sent_at >= now() - interval '7 days')  AS emails_7d,
             COUNT(*) FILTER (WHERE channel = 'call'  AND sent_at >= now() - interval '7 days')  AS calls_7d,
             COUNT(*) FILTER (WHERE outcome = 'replied' AND outcome_at >= now() - interval '7 days') AS replies_7d,
             COUNT(*) FILTER (WHERE outcome = 'booked'  AND outcome_at >= now() - interval '7 days') AS bookings_7d,
             COUNT(*) FILTER (WHERE channel = 'email' AND sent_at >= now() - interval '30 days') AS emails_30d,
             COUNT(*) FILTER (WHERE channel = 'call'  AND sent_at >= now() - interval '30 days') AS calls_30d,
             COUNT(*) FILTER (WHERE outcome = 'replied' AND outcome_at >= now() - interval '30 days') AS replies_30d,
             COUNT(*) FILTER (WHERE outcome = 'booked'  AND outcome_at >= now() - interval '30 days') AS bookings_30d
           FROM "hivemind"."outbound_actions"
          WHERE org_id = $1::uuid AND status = 'sent'`,
          current.session.orgId,
        ), prisma.$queryRawUnsafe(
          `SELECT id, title, content, tags, source_platform, created_at, updated_at
             FROM "hivemind"."memories"
            WHERE org_id = $1::uuid
              AND deleted_at IS NULL
              AND is_latest = true
              AND ('prospect' = ANY(COALESCE(tags, ARRAY[]::text[]))
                   OR source_platform = 'hyperagents-prospect')
            ORDER BY created_at DESC
            LIMIT 500`,
          current.session.orgId,
        )]);
        const r0 = rows?.[0] || {};
        const n = (v) => Number(v || 0);
        return jsonResponse(res, {
          window_7d:  { emails_sent: n(r0.emails_7d),  calls: n(r0.calls_7d),  replies: n(r0.replies_7d),  bookings: n(r0.bookings_7d) },
          window_30d: { emails_sent: n(r0.emails_30d), calls: n(r0.calls_30d), replies: n(r0.replies_30d), bookings: n(r0.bookings_30d) },
        });
      } catch (err) {
        // Ledger table may not exist yet on an un-migrated deploy — return zeros,
        // never a 500 (the dashboard tile must degrade gracefully).
        return jsonResponse(res, {
          window_7d:  { emails_sent: 0, calls: 0, replies: 0, bookings: 0 },
          window_30d: { emails_sent: 0, calls: 0, replies: 0, bookings: 0 },
        });
      }
    }

    // Fine-grained, per-action-type standing approval rules (Grok-Bot-style
    // "always allow: create a doc" while a different action still asks) — the
    // gap vs. the coarse per-room autoSend toggle. Org-scoped, admin-gated:
    // this changes autonomous-write behavior for the whole org, not just the
    // caller's own rooms. No FE surface yet — this is the backend + API only;
    // configure via this endpoint until a settings UI exists.
    if (pathname === '/v1/hyper/approval-rules' && req.method === 'GET') {
      const current = await requireSession(req, res);
      if (!current) return;
      const membership = await requireOrgAdmin(req, res, current.session.userId, current.session.orgId);
      if (!membership) return;
      try {
        const rows = await prisma.$queryRawUnsafe(
          `SELECT action_label, decision, created_at, updated_at
             FROM hivemind.hyper_approval_rules
            WHERE org_id = $1::uuid
            ORDER BY action_label`,
          current.session.orgId,
        );
        return jsonResponse(res, { rules: rows });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    if (pathname === '/v1/hyper/approval-rules' && req.method === 'POST') {
      const current = await requireSession(req, res);
      if (!current) return;
      const membership = await requireOrgAdmin(req, res, current.session.userId, current.session.orgId);
      if (!membership) return;
      const body = await parseBody(req).catch(() => ({}));
      const actionLabel = String(body?.action_label || '').trim().slice(0, 160);
      const decision = String(body?.decision || '').trim().toLowerCase();
      if (!actionLabel || !['always_allow', 'always_deny'].includes(decision)) {
        return jsonResponse(res, { error: 'action_label and decision (always_allow|always_deny) are required' }, 400);
      }
      try {
        await prisma.$executeRawUnsafe(
          `INSERT INTO hivemind.hyper_approval_rules (org_id, action_label, decision, created_by)
           VALUES ($1::uuid, $2, $3, $4::uuid)
           ON CONFLICT (org_id, action_label)
           DO UPDATE SET decision = $3, updated_at = now()`,
          current.session.orgId, actionLabel, decision, current.session.userId,
        );
        return jsonResponse(res, { status: 'saved', action_label: actionLabel, decision });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    if (pathname === '/v1/hyper/approval-rules' && req.method === 'DELETE') {
      const current = await requireSession(req, res);
      if (!current) return;
      const membership = await requireOrgAdmin(req, res, current.session.userId, current.session.orgId);
      if (!membership) return;
      const actionLabel = String(url.searchParams.get('action_label') || '').trim().slice(0, 160);
      if (!actionLabel) return jsonResponse(res, { error: 'action_label is required' }, 400);
      try {
        await prisma.$executeRawUnsafe(
          `DELETE FROM hivemind.hyper_approval_rules WHERE org_id = $1::uuid AND action_label = $2`,
          current.session.orgId, actionLabel,
        );
        return jsonResponse(res, { status: 'deleted', action_label: actionLabel });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // GET /v1/hyper/leads — the "Your Leads" board: one row per prospect the org
    // has run outreach on, with all firm info + latest send state, sent date/time,
    // reply/booking outcome, and a coarse "potential" derived from the outcome.
    // Sourced from outreach_targets (the campaign wrapper) LEFT-JOINed to the
    // outbound_actions ledger (sent-truth + reply/booking outcomes).
    if (pathname === '/v1/hyper/leads' && req.method === 'GET') {
      const current = await requireSession(req, res);
      if (!current) return;
      try {
        const [rows, prospectMemories, correspondenceArtifacts] = await Promise.all([
          prisma.$queryRawUnsafe(
          `SELECT
             t.id, t.company, t.email, t.phone, t.website, t.address,
             t.state, t.result_ref, t.updated_at,
             c.channel, c.id AS campaign_id, c.created_at AS campaign_at,
             oa.sent_at, oa.outcome, oa.outcome_at, oa.subject
           FROM "hivemind"."outreach_targets" t
           JOIN "hivemind"."outreach_campaigns" c ON c.id = t.campaign_id
           LEFT JOIN LATERAL (
             SELECT sent_at, outcome, outcome_at, subject
               FROM "hivemind"."outbound_actions" oa
              WHERE oa.org_id = c.org_id
                AND ((c.channel = 'email' AND oa.channel = 'email' AND lower(oa.recipient) = lower(t.email))
                  OR (c.channel = 'call'  AND oa.channel = 'call'  AND oa.recipient = regexp_replace(t.phone, '[^0-9+]', '', 'g')))
              ORDER BY oa.sent_at DESC LIMIT 1
           ) oa ON true
           WHERE c.org_id = $1::uuid
           ORDER BY COALESCE(oa.sent_at, t.updated_at) DESC
           LIMIT 500`,
            current.session.orgId,
          ),
          prisma.$queryRawUnsafe(
            `SELECT id, title, content, tags, source_platform, created_at, updated_at
               FROM "hivemind"."memories"
              WHERE org_id = $1::uuid
                AND deleted_at IS NULL
                AND is_latest = true
                AND ('prospect' = ANY(COALESCE(tags, ARRAY[]::text[]))
                     OR source_platform = 'hyperagents-prospect')
              ORDER BY created_at DESC
              LIMIT 500`,
            current.session.orgId,
          ),
          prisma.sourceArtifact.findMany({
            where: { orgId: current.session.orgId, sourcePlatform: 'gmail_watcher' },
            select: { payload: true, metadata: true, createdAt: true },
            orderBy: { createdAt: 'desc' },
            take: 500,
          }),
        ]);
        // Collapse to one row per prospect (email or company+phone) — latest wins.
        const field = (content, label) => {
          const match = String(content || '').match(new RegExp(`(?:^|\\n)${label}:\\s*(.*)`, 'i'));
          return match ? match[1].trim() : null;
        };
        const keyFor = (row) => {
          const company = String(row.company || '').toLowerCase()
            .replace(/[^a-z0-9äöüß]+/gi, ' ').replace(/\s+/g, ' ').trim();
          return company || String(row.email || row.phone || row.id || '').toLowerCase().trim();
        };
        const byKey = new Map();
        const correspondenceByLead = new Map();
        const correspondenceByEmail = new Map();
        for (const artifact of correspondenceArtifacts) {
          const payload = artifact.payload && typeof artifact.payload === 'object' ? artifact.payload : {};
          const metadata = artifact.metadata && typeof artifact.metadata === 'object' ? artifact.metadata : {};
          const correspondence = {
            state: metadata.match_type === 'sender_fallback' ? 'possible_reply' : 'replied',
            match_type: metadata.match_type || 'thread',
            sender: payload.sender || null,
            subject: payload.subject || null,
            received_at: payload.received_at || artifact.createdAt,
          };
          if (payload.lead_memory_id && !correspondenceByLead.has(`memory:${payload.lead_memory_id}`)) {
            correspondenceByLead.set(`memory:${payload.lead_memory_id}`, correspondence);
          }
          const sender = String(payload.sender || '').trim().toLowerCase();
          if (sender && !correspondenceByEmail.has(sender)) correspondenceByEmail.set(sender, correspondence);
        }
        for (const memory of prospectMemories) {
          const content = String(memory.content || '');
          const company = field(content, 'PROSPECT') || String(memory.title || '').replace(/^Prospect:\s*/i, '').trim();
          if (!company) continue;
          const lead = {
            id: `memory:${memory.id}`, company,
            email: field(content, 'EMAIL'), phone: field(content, 'PHONE'),
            website: field(content, 'WEBSITE'), address: field(content, 'ADDRESS'),
            note: field(content, 'NOTE'), fit_reason: field(content, 'FIT_REASON'),
            distinctive_signal: field(content, 'DISTINCTIVE_SIGNAL'),
            outreach_angle: field(content, 'OUTREACH_ANGLE'),
            source: memory.source_platform || 'hyperagents-prospect',
            channel: null, state: 'discovered', sent: false, replied: false,
            booked: false, potential: 'none', subject: null, sent_at: null,
            outcome: null, outcome_at: null, skipped_reason: null, error: null,
            discovered_at: memory.created_at,
            correspondence: correspondenceByLead.get(`memory:${memory.id}`) || correspondenceByEmail.get(String(field(content, 'EMAIL') || '').toLowerCase()) || null,
          };
          byKey.set(keyFor(lead), lead);
        }
        for (const r of rows) {
          const key = keyFor(r);
          const existing = byKey.get(key);
          byKey.set(key, { ...(existing || {}), ...r,
            email: r.email || existing?.email || null,
            phone: r.phone || existing?.phone || null,
            website: r.website || existing?.website || null,
            address: r.address || existing?.address || null,
            note: existing?.note || null, fit_reason: existing?.fit_reason || null,
            distinctive_signal: existing?.distinctive_signal || null,
            outreach_angle: existing?.outreach_angle || null,
            discovered_at: existing?.discovered_at || r.campaign_at,
            correspondence: existing?.correspondence || correspondenceByEmail.get(String(r.email || '').toLowerCase()) || null,
          });
        }
        const leads = [...byKey.values()].map((r) => {
          const rr = r.result_ref || {};
          const sent = !!r.sent_at || r.state === 'sent';
          const replied = r.outcome === 'replied';
          const booked = r.outcome === 'booked' || r.outcome === 'completed';
          // Coarse potential: booked > replied > sent(awaiting) > queued/skipped.
          const potential = booked ? 'high' : replied ? 'medium' : sent ? 'low' : 'none';
          return {
            id: r.id, company: r.company, email: r.email, phone: r.phone,
            website: r.website, address: r.address, channel: r.channel,
            state: r.state, sent, replied, booked, potential,
            subject: r.subject || null,
            sent_at: r.sent_at || null,
            outcome: r.outcome || null, outcome_at: r.outcome_at || null,
            skipped_reason: rr.skipped || null,
            error: rr.error || null,
            note: r.note || null,
            fit_reason: r.fit_reason || null,
            distinctive_signal: r.distinctive_signal || null,
            outreach_angle: r.outreach_angle || null,
            discovered_at: r.discovered_at || r.campaign_at || null,
            correspondence: r.correspondence || null,
            call_analysis: rr.callAnalysis || null,
          };
        });
        const summary = {
          total: leads.length,
          emails_sent: leads.filter((l) => l.channel === 'email' && l.sent).length,
          calls: leads.filter((l) => l.channel === 'call' && l.sent).length,
          replies: leads.filter((l) => l.replied).length,
          meetings: leads.filter((l) => l.booked).length,
        };
        return jsonResponse(res, { leads, summary });
      } catch (err) {
        // Un-migrated / no campaigns yet → empty board, never a 500.
        return jsonResponse(res, { leads: [], summary: { total: 0, emails_sent: 0, calls: 0, replies: 0, meetings: 0 } });
      }
    }

    // GET /v1/hyper-rooms/:id/hq-activity — the HQ control-room feed: every
    // non-HQ room run that reported here (agent-voice cards, newest last).
    const hqActMatch = pathname.match(/^\/v1\/hyper-rooms\/([0-9a-f-]{36})\/hq-activity$/);
    if (hqActMatch && req.method === 'GET') {
      const current = await requireSession(req, res);
      if (!current) return;
      try {
        const rows = await prisma.$queryRawUnsafe(
          `SELECT id, source_room_id, source_room_name, agent_name, agent_role,
                  headline, summary, status, created_at
             FROM "hivemind"."hq_activity"
            WHERE org_id = $1::uuid AND hq_room_id = $2::uuid
            ORDER BY created_at ASC LIMIT 200`,
          current.session.orgId, hqActMatch[1],
        );
        return jsonResponse(res, {
          activity: rows.map((r) => ({
            id: r.id, source_room_id: r.source_room_id, source_room_name: r.source_room_name,
            agent_name: r.agent_name, agent_role: r.agent_role,
            headline: r.headline, summary: r.summary, status: r.status, created_at: r.created_at,
          })),
        });
      } catch {
        return jsonResponse(res, { activity: [] }); // un-migrated → empty
      }
    }

    // POST /v1/hyper/tasks/open { task_id } — open (or create) the room for a
    // dashboard task. First click provisions a room named after the task with
    // the task detail as its goal and marks the task in the persisted state;
    // later clicks return the same room. Polsia: click a task → its workroom.
    if (pathname === '/v1/hyper/tasks/open' && req.method === 'POST') {
      const current = await requireSession(req, res);
      if (!current) return;
      const body = await parseBody(req);
      const taskId = typeof body.task_id === 'string' ? body.task_id : '';
      if (!taskId) return jsonResponse(res, { error: 'task_id is required' }, 400);
      try {
        const rows = await prisma.$queryRawUnsafe(
          `SELECT id, "agent_connectors"->'_company' AS company
             FROM "hivemind"."hyper_rooms"
            WHERE org_id = $1::uuid AND "agent_connectors" ? '_company' AND archived_at IS NULL
            ORDER BY created_at DESC LIMIT 1`,
          current.session.orgId,
        );
        const row = rows?.[0];
        if (!row?.company) return jsonResponse(res, { error: 'not onboarded' }, 404);
        const company = typeof row.company === 'string' ? JSON.parse(row.company) : row.company;
        const task = (company.tasks || []).find((x) => x.id === taskId);
        if (!task) return jsonResponse(res, { error: 'task not found' }, 404);
        // Human task clicks always enter a neutral Work Room. The Director decides
        // whether this turn needs a direct answer, research, debate, an artifact,
        // or a proposal for a governed Runtime lifecycle.
        //
        // kickoff is the room's user_message — what the FE shows as "the user
        // asked". It used to wrap task.title in a "You are working with the X
        // team..." framing + a restated COMPANY CONTEXT line + a "choose the
        // smallest useful approach... never claim an external action occurred"
        // policy paragraph, all bolted onto the request text. Every one of
        // those was already duplicated elsewhere in the turn: Director builds
        // its own, richer company_brief separately (2000+ chars vs this one
        // line), room_goal already carries the company mission (see `goal`
        // below and rr?.goal for the existing-room branch), and the
        // response-depth/no-fabrication policy is already baked into
        // Director's own synth system prompt — it doesn't need to be told
        // twice, and stuffing it into user_message just made the room look
        // like the user typed a paragraph of boilerplate. Trimmed to exactly
        // the concise request: task title + its real, non-duplicated detail.
        const kickoff = task.detail ? `${task.title}\n\n${task.detail}` : task.title;
        if (task.room_id) {
          const existing = await prisma.hyperRoom.findFirst({
            where: { id: task.room_id, orgId: current.session.orgId, archivedAt: null },
            select: { id: true, name: true, roomMode: true },
          }).catch(() => null);
          if (existing?.roomMode === 'work') {
            let created = false;
            const idempotencyKey = `task-kickoff-${row.id}-${task.id}`.slice(0, 64);
            const kickTurn = await prisma.$transaction(async (tx) => {
              const prior = await tx.hyperTurn.findUnique({ where: { idempotencyKey } });
              if (prior) return prior;
              const last = await tx.hyperTurn.findFirst({
                where: { roomId: existing.id }, orderBy: { seq: 'desc' }, select: { seq: true },
              });
              created = true;
              return tx.hyperTurn.create({
                data: { roomId: existing.id, seq: (last?.seq ?? 0) + 1, userMessage: kickoff, status: 'live', idempotencyKey, lines: [] },
              });
            });
            if (created) {
              const rr = await prisma.hyperRoom.findUnique({
                where: { id: existing.id }, select: { participantIds: true, goal: true, projectId: true },
              }).catch(() => null);
              dispatchHyperRoomTurn({
                room_id: existing.id, turn_id: kickTurn.id,
                user_id: current.session.userId, org_id: current.session.orgId,
                user_message: kickoff, participant_ids: rr?.participantIds || [],
                project_id: rr?.projectId || null, room_goal: rr?.goal || '',
                room_mode: 'work', task_tag: 'WORK',
                callback_url: `${process.env.CONTROL_PLANE_INTERNAL_URL || 'http://hm-control:3000'}/internal/hyper/turn-event`,
              }).catch((e) => console.warn('[hyper-tasks] domain kickoff dispatch failed:', e.message));
            }
            task.status = 'active';
            await prisma.$executeRawUnsafe(
              'UPDATE "hivemind"."hyper_rooms" SET "agent_connectors" = "agent_connectors" || $1::jsonb WHERE "id" = $2::uuid',
              JSON.stringify({ _company: company }), row.id,
            ).catch(() => {});
            return jsonResponse(res, { room: existing, task });
          }
          // A historical task may point at a specialist Company Room. Keep that
          // reference for audit, but never turn a human click into Runtime work.
          task.legacy_room_id = task.room_id;
          task.room_id = null;
        }
        const participantIds = (company.team || []).map((x) => x.id).filter(Boolean).slice(0, 5);
        const taskRoom = await createHyperRoom({
            userId: current.session.userId,
            orgId: current.session.orgId,
            name: task.title.slice(0, 120),
            participantIds,
            template: 'auto',
            roomMode: 'work',
            roomTag: 'general',
            permanentLeadId: participantIds.slice().sort()[0] || null,
          });
        const goal = `${task.title}\n${task.detail || ''}\nCompany: ${company.company} — ${company.mission || ''}`.slice(0, 2000);
        try {
          await prisma.$executeRawUnsafe('UPDATE "hivemind"."hyper_rooms" SET "goal" = $1 WHERE "id" = $2::uuid', goal, taskRoom.id);
        } catch { /* goal best-effort */ }
        // Mark the task with its room in the persisted state.
        task.room_id = taskRoom.id;
        task.status = 'active';
        try {
          await prisma.$executeRawUnsafe(
            'UPDATE "hivemind"."hyper_rooms" SET "agent_connectors" = "agent_connectors" || $1::jsonb WHERE "id" = $2::uuid',
            JSON.stringify({ _company: company }), row.id,
          );
        } catch { /* state best-effort */ }
        // ATOMIC KICKOFF: create + dispatch the first turn server-side (same
        // pattern as the nightly cycle) — the FE comment always assumed this,
        // but this path only RETURNED kickoff_message, so task rooms opened
        // with 0 turns and sat silent until the user typed. Event-driven: the
        // task's own kickoff text is the turn, agents start immediately.
        try {
          const kickTurn = await prisma.hyperTurn.create({
            data: { roomId: taskRoom.id, seq: 1, userMessage: kickoff, status: 'live',
                    idempotencyKey: `task-kickoff-${taskRoom.id}`, lines: [] },
          });
          const roomRow2 = await prisma.hyperRoom.findUnique({
            where: { id: taskRoom.id }, select: { participantIds: true, goal: true, projectId: true },
          }).catch(() => null);
          dispatchHyperRoomTurn({
            room_id: taskRoom.id, turn_id: kickTurn.id,
            user_id: current.session.userId, org_id: current.session.orgId,
            user_message: kickoff, participant_ids: roomRow2?.participantIds || [],
            project_id: roomRow2?.projectId || null, room_goal: roomRow2?.goal || goal,
            room_mode: 'work', task_tag: 'WORK',
            callback_url: `${process.env.CONTROL_PLANE_INTERNAL_URL || 'http://hm-control:3000'}/internal/hyper/turn-event`,
          }).catch((e) => console.warn('[hyper-tasks] kickoff dispatch failed:', e.message));
        } catch (e) { console.warn('[hyper-tasks] kickoff turn create failed:', e.message || e.code || e); }
        return jsonResponse(res, { room: { id: taskRoom.id, name: taskRoom.name }, task, kickoff_message: kickoff }, 201);
      } catch (err) {
        if (err?.code === 'PLAN_LIMIT') return capacityErrorResponse(res, err);
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // GET/PATCH /v1/hyper-rooms/:id/connectors — room-level connector toggles.
    // One switch per connector (like the web tool): when on, every agent in the
    // room can use it during the run. Owner-only. Values from the catalog.
    const roomConnMatch = pathname.match(/^\/v1\/hyper-rooms\/([0-9a-f-]{36})\/connectors$/);
    if (roomConnMatch) {
      const current = await requireSession(req, res);
      if (!current) return;
      const roomId = roomConnMatch[1];
      const room = await prisma.hyperRoom.findFirst({
        where: { id: roomId, userId: current.session.userId },
        select: { id: true },
      }).catch(() => null);
      if (!room) return jsonResponse(res, { error: 'room not found' }, 404);

      // Catalog: 6 MCP connectors + native Google (gmail, google_docs).
      const ALLOWED = new Set(['github', 'notion', 'slack', 'hubspot', 'airtable', 'linear', 'gmail', 'google_docs']);

      if (req.method === 'GET') {
        const rows = await prisma.$queryRawUnsafe(
          'SELECT enabled_connectors FROM "hivemind"."hyper_rooms" WHERE id = $1::uuid', roomId,
        ).catch(() => null);
        return jsonResponse(res, { enabled_connectors: rows?.[0]?.enabled_connectors || [] });
      }

      if (req.method === 'PATCH' || req.method === 'PUT') {
        const body = await parseBody(req);
        const list = body.enabled_connectors;
        if (!Array.isArray(list)) {
          return jsonResponse(res, { error: 'enabled_connectors array required' }, 400);
        }
        const clean = [...new Set(list.filter(c => typeof c === 'string' && ALLOWED.has(c)))];
        await prisma.$executeRawUnsafe(
          'UPDATE "hivemind"."hyper_rooms" SET enabled_connectors = $1::text[] WHERE id = $2::uuid',
          clean, roomId,
        );
        return jsonResponse(res, { ok: true, enabled_connectors: clean });
      }
      return jsonResponse(res, { error: 'method not allowed' }, 405);
    }

    // /v1/hyper-rooms/:id/turns(/:turnId)(/stream)
    const roomTurnMatch = pathname.match(/^\/v1\/hyper-rooms\/([0-9a-f-]{36})\/turns(?:\/([0-9a-f-]{36})(\/stream)?)?$/);
    const flybyDecisionMatch = pathname.match(/^\/v1\/hyper-rooms\/([0-9a-f-]{36})\/turns\/([0-9a-f-]{36})\/flyby-decision$/);
    const flybyDecisionCompat = roomTurnMatch && roomTurnMatch[2] && !roomTurnMatch[3] && url.searchParams.get('action') === 'flyby-decision';
    // Phase 7 — resolve a queued connector write (approval card action).
    const roomApproveMatch = pathname.match(/^\/v1\/hyper-rooms\/([0-9a-f-]{36})\/approve$/);
    const roomWorkPlanMatch = pathname.match(/^\/v1\/hyper-rooms\/([0-9a-f-]{36})\/work-plan$/);
    const roomWorkPlanResumeMatch = pathname.match(/^\/v1\/hyper-rooms\/([0-9a-f-]{36})\/work-plan\/([0-9a-f-]{36})\/resume$/);
    const roomWorkPlanHandoffMatch = pathname.match(/^\/v1\/hyper-rooms\/([0-9a-f-]{36})\/work-plan\/([0-9a-f-]{36})\/handoff$/);
    const roomMetaMatch = pathname.match(/^\/v1\/hyper-rooms\/([0-9a-f-]{36})$/);

    // GET /v1/hyper-rooms/:id/work-plan — one continuous, durable projection
    // for a human Work Room. This reads the existing work-order ledger; it never
    // creates a second workflow authority or derives completion from prose.
    if (roomWorkPlanMatch && req.method === 'GET') {
      const current = await requireSession(req, res);
      if (!current) return;
      const roomId = roomWorkPlanMatch[1];
      const room = await prisma.hyperRoom.findFirst({
        where: { id: roomId, orgId: current.session.orgId, archivedAt: null },
        select: { id: true, roomMode: true },
      });
      if (!room) return jsonResponse(res, { error: 'Room not found' }, 404);
      if (room.roomMode !== 'work') return jsonResponse(res, { error: 'Work plan is only available for Work Rooms' }, 409);
      const rows = await prisma.$queryRawUnsafe(
        `SELECT wo.id, wo.turn_id, wo.plan_step_id, wo.depends_on, wo.kind, wo.status,
                wo.title, wo.objective, wo.owner_slug, wo.owner_lane, wo.error,
                wo.wait_for, wo.handoff,
                wo.attempt, wo.created_at, wo.started_at, wo.completed_at, wo.updated_at,
                latest.summary AS latest_summary
           FROM "hivemind"."hyper_work_orders" wo
           LEFT JOIN LATERAL (
             SELECT summary
               FROM "hivemind"."hyper_work_results" result
              WHERE result.work_order_id = wo.id
              ORDER BY result.attempt DESC, result.created_at DESC
              LIMIT 1
           ) latest ON true
          WHERE wo.org_id = $1::uuid AND wo.room_id = $2::uuid AND wo.hq_cycle_id IS NULL
          ORDER BY wo.created_at ASC, wo.plan_step_id ASC NULLS LAST`,
        current.session.orgId, roomId,
      ).catch(() => []);
      const steps = (rows || []).map((row) => {
        const status = String(row.status || 'queued');
        const projectedStatus = status === 'blocked' ? 'needs_attention'
          : status === 'running' ? 'active'
          : status;
        return {
          id: String(row.id), turn_id: row.turn_id ? String(row.turn_id) : null,
          step_id: row.plan_step_id || null,
          depends_on: Array.isArray(row.depends_on) ? row.depends_on : [],
          status: projectedStatus,
          title: row.title, objective: row.objective, kind: row.kind,
          owner: { slug: row.owner_slug || null, lane: row.owner_lane || null },
          attempt: Number(row.attempt || 0), blocker: row.error || null,
          waiting: row.wait_for && typeof row.wait_for === 'object' ? row.wait_for : null,
          handoff: row.handoff && typeof row.handoff === 'object' ? row.handoff : null,
          summary: row.latest_summary || null,
          timestamps: { created_at: row.created_at, started_at: row.started_at,
                        completed_at: row.completed_at, updated_at: row.updated_at },
        };
      });
      return jsonResponse(res, { room_id: roomId, mode: 'work', steps });
    }

    // POST /v1/hyper-rooms/:id/work-plan/:workOrderId/resume — resolve an
    // exact pause and re-run the same durable Work Order. The new HyperTurn is
    // only an audit/SSE transport envelope; it is explicitly pinned to the old
    // work-order identity and cannot create a Runtime lifecycle.
    if (roomWorkPlanResumeMatch && req.method === 'POST') {
      const current = await requireSession(req, res);
      if (!current) return;
      const [, roomId, workOrderId] = roomWorkPlanResumeMatch;
      const body = await parseBody(req);
      const resolution = body?.resolution;
      if (!resolution || typeof resolution !== 'object' || Array.isArray(resolution)) {
        return jsonResponse(res, { error: 'resolution object is required' }, 400);
      }
      const serializedResolution = JSON.stringify(resolution);
      if (serializedResolution.length > 8000) {
        return jsonResponse(res, { error: 'resolution is too large' }, 400);
      }
      const room = await prisma.hyperRoom.findFirst({
        where: { id: roomId, orgId: current.session.orgId, archivedAt: null, roomMode: 'work' },
      });
      if (!room) return jsonResponse(res, { error: 'Work Room not found' }, 404);
      const result = await prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRawUnsafe(
          `SELECT id, turn_id, plan_step_id, depends_on, kind, title, objective,
                  owner_lane, required_evidence, acceptance_criteria, input_snapshot,
                  wait_for, handoff, status
             FROM "hivemind"."hyper_work_orders"
            WHERE id = $1::uuid AND org_id = $2::uuid AND room_id = $3::uuid
              AND hq_cycle_id IS NULL
            FOR UPDATE`,
          workOrderId, current.session.orgId, roomId,
        );
        const order = rows?.[0];
        if (!order) return { error: 'Work step not found', status: 404 };
        const status = String(order.status || '');
        if (!status.startsWith('waiting_for_')) {
          const snapshot = order.input_snapshot && typeof order.input_snapshot === 'object'
            ? order.input_snapshot : {};
          const resumeTurnId = typeof snapshot.resume_turn_id === 'string' ? snapshot.resume_turn_id : null;
          if ((status === 'queued' || status === 'running') && resumeTurnId) {
            const existing = await tx.hyperTurn.findFirst({
              where: { id: resumeTurnId, roomId }, select: { id: true, status: true },
            });
            if (existing) return { order, turn: existing, duplicate: true };
          }
          return { error: 'Work step is not waiting for a resolution', status: 409 };
        }
        const waitFor = order.wait_for && typeof order.wait_for === 'object' ? order.wait_for : {};
        const last = await tx.hyperTurn.findFirst({ where: { roomId }, orderBy: { seq: 'desc' }, select: { seq: true } });
        const seq = (last?.seq ?? 0) + 1;
        const userMessage = String(waitFor.prompt || waitFor.reason || 'Continue the paused work step.').slice(0, 8000);
        const idempotencyKey = `work-resume:${crypto.createHash('sha256')
          .update(`${workOrderId}:${serializedResolution}`).digest('hex')}`.slice(0, 64);
        const existing = await tx.hyperTurn.findUnique({ where: { idempotencyKey } });
        if (existing) return { order, turn: existing, duplicate: true };
        const turn = await tx.hyperTurn.create({
          data: { roomId, seq, userMessage, status: 'live', idempotencyKey, lines: [] },
        });
        const updated = await tx.$executeRawUnsafe(
          `UPDATE "hivemind"."hyper_work_orders"
              SET status = 'queued', wait_for = jsonb_set(COALESCE(wait_for, '{}'::jsonb), '{resolution}', $1::jsonb, true),
                  input_snapshot = jsonb_set(COALESCE(input_snapshot, '{}'::jsonb), '{resume_turn_id}', to_jsonb($2::text), true),
                  error = NULL, updated_at = now()
            WHERE id = $3::uuid AND org_id = $4::uuid AND status = $5`,
          serializedResolution, turn.id, workOrderId, current.session.orgId, status,
        );
        if (!String(updated).endsWith('1')) throw new Error('Work step changed while resuming');
        return { order, turn, duplicate: false };
      });
      if (result.error) return jsonResponse(res, { error: result.error }, result.status);
      const order = result.order;
      const waitFor = order.wait_for && typeof order.wait_for === 'object' ? order.wait_for : {};
      const envelope = {
        contract: 'work-room-resume.v1',
        work_order_id: String(order.id),
        resume_key: waitFor.resume_key || null,
        resolution,
        step: {
          id: order.plan_step_id || `work-${String(order.id).slice(0, 8)}`,
          depends_on: Array.isArray(order.depends_on) ? order.depends_on : [],
          kind: order.kind, owner_lane: order.owner_lane || 'Strategist', title: order.title,
          objective: order.objective,
          required_evidence: Array.isArray(order.required_evidence) ? order.required_evidence : [],
          acceptance_criteria: Array.isArray(order.acceptance_criteria) ? order.acceptance_criteria : [],
        },
      };
      if (!result.duplicate) {
        dispatchHyperRoomTurn({
          room_id: room.id, turn_id: result.turn.id,
          user_id: current.session.userId, org_id: current.session.orgId,
          user_message: result.turn.userMessage, participant_ids: room.participantIds || [],
          project_id: room.projectId || null, room_goal: room.goal || '', room_mode: 'work', task_tag: 'WORK',
          execution_context: JSON.stringify(envelope),
          callback_url: `${(process.env.CONTROL_PLANE_INTERNAL_URL || 'http://hm-control:3000')}/internal/hyper/turn-event`,
        }).catch((error) => console.warn('[work-plan] resume dispatch failed:', error.message));
      }
      return jsonResponse(res, {
        ok: true, work_order_id: String(order.id), turn_id: result.turn.id,
        status: result.duplicate ? 'resuming' : 'queued', duplicate: Boolean(result.duplicate),
      }, 202);
    }

    // Accept a completed Work Room recommendation into HQ's normal semantic
    // instruction loop. This does not create a todo, select a playbook, or
    // grant authority; HQ remains responsible for those later decisions.
    if (roomWorkPlanHandoffMatch && req.method === 'POST') {
      const current = await requireSession(req, res);
      if (!current) return;
      const [, roomId, workOrderId] = roomWorkPlanHandoffMatch;
      const body = await parseBody(req).catch(() => ({}));
      if (body.decision !== 'accept') return jsonResponse(res, { error: 'decision must be accept' }, 400);
      const room = await prisma.hyperRoom.findFirst({
        where: { id: roomId, orgId: current.session.orgId, archivedAt: null, roomMode: 'work' },
        select: { id: true },
      });
      if (!room) return jsonResponse(res, { error: 'Work Room not found' }, 404);

      const accepted = await prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRawUnsafe(
          `SELECT wo.id, wo.title, wo.objective, wo.status, wo.handoff,
                  result.id AS result_id, result.status AS result_status,
                  result.summary AS result_summary,
                  COALESCE(resume_turn.status, source_turn.status) AS effective_turn_status,
                  COALESCE(resume_turn.lines, source_turn.lines) AS effective_turn_lines
             FROM "hivemind"."hyper_work_orders" wo
             LEFT JOIN LATERAL (
               SELECT id, status, summary
                 FROM "hivemind"."hyper_work_results"
                WHERE work_order_id = wo.id
                ORDER BY attempt DESC, created_at DESC
                LIMIT 1
             ) result ON true
             LEFT JOIN "hivemind"."hyper_turns" source_turn ON source_turn.id = wo.turn_id
             LEFT JOIN "hivemind"."hyper_turns" resume_turn
               ON resume_turn.id = CASE
                    WHEN COALESCE(wo.input_snapshot->>'resume_turn_id', '')
                         ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                    THEN (wo.input_snapshot->>'resume_turn_id')::uuid
                    ELSE NULL
                  END
            WHERE wo.id = $1::uuid AND wo.org_id = $2::uuid
              AND wo.room_id = $3::uuid AND wo.hq_cycle_id IS NULL
            FOR UPDATE OF wo`,
          workOrderId, current.session.orgId, roomId,
        );
        const order = rows?.[0];
        if (!order) return { error: 'Work step not found', status: 404 };
        if (order.status !== 'completed' || order.result_status !== 'completed') {
          return { error: 'Only a completed, evidenced work step can be handed to Runtime', status: 409 };
        }
        const effectiveLines = Array.isArray(order.effective_turn_lines) ? order.effective_turn_lines : [];
        const verificationPassed = effectiveLines.some((event) => event?.t === 'verify' && event?.met === true);
        if (order.effective_turn_status !== 'complete' || !verificationPassed) {
          return { error: 'The Room turn must complete verification before Runtime handoff', status: 409 };
        }
        const handoff = order.handoff && typeof order.handoff === 'object' ? order.handoff : {};
        if (!['runtime', 'hq', 'hq runtime'].includes(String(handoff.owner || '').trim().toLowerCase())) {
          return { error: 'This work step has no Runtime handoff', status: 409 };
        }
        if (handoff.runtime_instruction_id) {
          const instruction = await tx.hqInstruction.findFirst({
            where: { id: String(handoff.runtime_instruction_id), orgId: current.session.orgId },
          });
          const runtime = await tx.hqRuntime.findUnique({ where: { orgId: current.session.orgId } });
          return instruction && runtime ? { order, handoff, instruction, runtime, duplicate: true } : {
            error: 'The recorded Runtime handoff cannot be resolved', status: 409,
          };
        }
        const runtime = await tx.hqRuntime.findUnique({ where: { orgId: current.session.orgId } });
        if (!runtime || runtime.state === 'INACTIVE') {
          return { error: 'HQ Runtime must be active before accepting this handoff', status: 409 };
        }
        const instructionBody = String(handoff.objective || order.objective || order.title).trim().slice(0, 5000);
        if (!instructionBody) return { error: 'Runtime handoff objective is missing', status: 409 };
        const instruction = await tx.hqInstruction.create({
          data: {
            runtimeId: runtime.id,
            orgId: current.session.orgId,
            userId: current.session.userId,
            body: instructionBody,
            interpreted: {
              source: 'work_room_handoff', execution_mode: 'single_outcome',
              work_room_id: roomId, work_order_id: workOrderId,
              work_result_id: order.result_id, source_summary: order.result_summary || null,
            },
          },
        });
        const nextHandoff = {
          ...handoff, status: 'accepted', runtime_instruction_id: instruction.id,
          work_result_id: order.result_id, accepted_by: current.session.userId,
          accepted_at: new Date().toISOString(),
        };
        await tx.$executeRawUnsafe(
          `UPDATE "hivemind"."hyper_work_orders"
              SET handoff = $1::jsonb, updated_at = now()
            WHERE id = $2::uuid AND org_id = $3::uuid`,
          JSON.stringify(nextHandoff), workOrderId, current.session.orgId,
        );
        await tx.growthJournal.create({
          data: {
            orgId: current.session.orgId, actorUserId: current.session.userId,
            eventType: 'work_room_handoff_accepted',
            summary: `Accepted the completed Work Room result: ${String(order.title || 'work result').slice(0, 180)}`,
            evidenceRefs: [`hyper-work-result:${order.result_id}`],
            decision: { room_id: roomId, work_order_id: workOrderId, instruction_id: instruction.id },
          },
        });
        return { order, handoff: nextHandoff, instruction, runtime, duplicate: false };
      });
      if (accepted.error) return jsonResponse(res, { error: accepted.error }, accepted.status);
      await scheduleHqWake({
        prisma, runtimeId: accepted.runtime.id, orgId: current.session.orgId,
        runtimeEpoch: accepted.runtime.epoch,
        idempotencyKey: `work-room-handoff:${workOrderId}`,
        triggerType: 'instruction_updated', dueAt: new Date(),
        payload: { instruction_id: accepted.instruction.id, source: 'work_room_handoff' },
      });
      if (!accepted.duplicate) {
        await appendHqEvent({
          prisma, runtimeId: accepted.runtime.id, orgId: current.session.orgId,
          runtimeEpoch: accepted.runtime.epoch, eventType: 'instruction_received',
          title: 'A completed Work Room result was accepted',
          summary: 'The handoff is now a durable operating instruction. HQ will classify it semantically before creating any lifecycle.',
          details: { room_id: roomId, work_order_id: workOrderId, instruction_id: accepted.instruction.id },
        });
      }
      return jsonResponse(res, {
        ok: true, duplicate: Boolean(accepted.duplicate),
        instruction_id: accepted.instruction.id, handoff: accepted.handoff,
      }, accepted.duplicate ? 200 : 202);
    }

    // DELETE /v1/hyper-rooms/:id — permanent delete (?hard=true) or archive.
    // Archive (default) sets archived_at so the room drops to the rail's
    // Archived section; hard delete removes the row and cascades its turns +
    // agent_evals (schema onDelete: Cascade). Both tenant-scoped.
    if (roomMetaMatch && req.method === 'DELETE') {
      const current = await requireSession(req, res);
      if (!current) return;
      const roomId = roomMetaMatch[1];
      const room = await prisma.hyperRoom.findFirst({
        where: { id: roomId, userId: current.session.userId, orgId: current.session.orgId, archivedAt: null },
        select: { id: true },
      });
      if (!room) return jsonResponse(res, { error: 'Room not found' }, 404);
      const hard = url.searchParams.get('hard') === 'true';
      const force = url.searchParams.get('force') === 'true';
      try {
        // HQ protection: this room carries the persisted company state
        // (_company — profile/mission/tasks/deliverables shown on the hero).
        // Deleting it wipes the dashboard. Require an explicit force so the
        // FE can show a real "this clears your company" confirm first; a
        // forced delete drops the org back to the onboarding page.
        const hqRows = await prisma.$queryRawUnsafe(
          `SELECT 1 FROM "hivemind"."hyper_rooms" WHERE id = $1::uuid AND "agent_connectors" ? '_company'`,
          roomId,
        ).catch(() => []);
        const domainRows = await prisma.$queryRawUnsafe(
          `SELECT 1 FROM "hivemind"."hyper_rooms" WHERE id = $1::uuid AND "agent_connectors" ? '_domain_home'`,
          roomId,
        ).catch(() => []);
        if (domainRows?.length) {
          return jsonResponse(res, {
            error: 'This is a permanent company Room. It stays available for this expertise area.',
            code: 'DOMAIN_HOME_ROOM',
          }, 409);
        }
        if (hqRows?.length && !force) {
          return jsonResponse(res, {
            error: 'This is your company HQ — it holds your company profile, mission, tasks and deliverables. Deleting it clears the dashboard and you will need to onboard again.',
            code: 'HQ_ROOM',
          }, 409);
        }
        if (hqRows?.length && force) {
          _hyperOnboardJobs.delete(current.session.orgId); // stale done-job must not resurrect the old dashboard
        }
        if (hard || (hqRows?.length && force)) {
          await prisma.hyperRoom.delete({ where: { id: roomId } });
          return jsonResponse(res, { ok: true, deleted: true, mode: 'hard' });
        }
        await prisma.hyperRoom.update({
          where: { id: roomId },
          data: { archivedAt: new Date() },
        });
        return jsonResponse(res, { ok: true, archived: true, mode: 'archive' });
      } catch (err) {
        console.warn('[hyper-rooms] delete failed:', err.message);
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // DELETE /v1/hyper-rooms/:id/turns — clear the whole discussion (every
    // turn + its agent activity). Keeps an ordinary Work Room, while permanent
    // Company Intelligence Rooms retain their operating history. Tenant-scoped.
    if (roomTurnMatch && roomTurnMatch[2] == null && req.method === 'DELETE') {
      const current = await requireSession(req, res);
      if (!current) return;
      const roomId = roomTurnMatch[1];
      // Org-shared: any org member can clear a room's runs (matches the read +
      // participate model). Scoping by userId broke Clear for rooms owned by a
      // different member (incl. the HQ room) — it 404'd and silently no-op'd.
      const room = await prisma.hyperRoom.findFirst({
        where: { id: roomId, orgId: current.session.orgId, archivedAt: null },
        select: { id: true, agentConnectors: true },
      });
      if (!room) return jsonResponse(res, { error: 'Room not found' }, 404);
      if (room.agentConnectors?._domain_home === true) {
        return jsonResponse(res, {
          error: 'Company Intelligence Room history is retained as durable company context.',
          code: 'DOMAIN_HOME_ROOM',
        }, 409);
      }
      try {
        const result = await prisma.$transaction(async (tx) => {
          const deleted = await tx.hyperTurn.deleteMany({ where: { roomId } });
          await tx.hyperRoom.update({
            where: { id: roomId },
            data: { roomJournal: [] },
          });
          // Control-room reports are outside the turn relation, so remove them
          // explicitly. Other turn-owned records cascade from hyper_turns.
          await tx.$executeRawUnsafe(
            'DELETE FROM "hivemind"."hq_activity" WHERE org_id = $1::uuid AND source_room_id = $2::uuid',
            current.session.orgId, roomId,
          ).catch(() => {});
          return deleted;
        });
        return jsonResponse(res, { ok: true, cleared: result.count });
      } catch (err) {
        console.warn('[hyper-rooms] clear discussion failed:', err.message);
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // DELETE /v1/hyper-rooms/:id/turns/:turnId — remove ONE run (the per-turn
    // clear X). Org-shared, same as the whole-discussion clear. Previously there
    // was NO handler for this path, so the per-turn clear silently no-op'd.
    if (roomTurnMatch && roomTurnMatch[2] != null && !roomTurnMatch[3] && req.method === 'DELETE') {
      const current = await requireSession(req, res);
      if (!current) return;
      const roomId = roomTurnMatch[1];
      const turnId = roomTurnMatch[2];
      const room = await prisma.hyperRoom.findFirst({
        where: { id: roomId, orgId: current.session.orgId, archivedAt: null },
        select: { id: true },
      });
      if (!room) return jsonResponse(res, { error: 'Room not found' }, 404);
      try {
        const result = await prisma.hyperTurn.deleteMany({ where: { id: turnId, roomId } });
        await prisma.$executeRawUnsafe(
          'DELETE FROM "hivemind"."hq_activity" WHERE org_id = $1::uuid AND turn_id = $2::uuid',
          current.session.orgId, turnId,
        ).catch(() => {});
        return jsonResponse(res, { ok: true, cleared: result.count });
      } catch (err) {
        console.warn('[hyper-rooms] delete turn failed:', err.message);
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // GET /v1/hyper-rooms/:id — metadata + recent turns
    if (roomMetaMatch && req.method === 'GET') {
      const current = await requireSession(req, res);
      if (!current) return;
      const roomId = roomMetaMatch[1];
      // Org-shared read: any org member can view a room's metadata + turns.
      const room = await prisma.hyperRoom.findFirst({
        where: { id: roomId, orgId: current.session.orgId, archivedAt: null },
      });
      if (!room) return jsonResponse(res, { error: 'Room not found' }, 404);
      // project_id/goal are read via raw SQL — deployed Prisma clients can lag
      // additive columns, so prisma.hyperRoom.findFirst() may omit them.
      try {
        const pr = await prisma.$queryRawUnsafe(
          'SELECT project_id, goal, room_tag, quality_mode, sim_mode, sim_agents, room_journal FROM "hivemind"."hyper_rooms" WHERE id = $1::uuid AND org_id = $2::uuid', roomId, current.session.orgId,
        );
        room.projectId = pr?.[0]?.project_id || null;
        room.goal = pr?.[0]?.goal || '';
        room.room_tag = pr?.[0]?.room_tag || 'general';
        room.quality_mode = pr?.[0]?.quality_mode || 'auto';
        room.sim_mode = pr?.[0]?.sim_mode || 'off';
        room.sim_agents = pr?.[0]?.sim_agents || 24;
        room.room_journal = Array.isArray(pr?.[0]?.room_journal) ? pr[0].room_journal : [];
        // Backward-compatible FE field while clients move to room_journal.
        room.evo_journal = room.room_journal;
      } catch { /* leave undefined */ }
      const [linkedCampaign, newestTurns] = await Promise.all([
        prisma.campaign.findFirst({
          where: { roomId, orgId: current.session.orgId },
          select: { id: true },
        }).catch(() => null),
        prisma.hyperTurn.findMany({
          where: { roomId },
          orderBy: { seq: 'desc' },
          take: 20,
        }),
      ]);
      room.campaign_id = linkedCampaign?.id || null;
      // Prewarm the sidecar on room OPEN (fire-and-forget): warms the company brief
      // + the cold MCP connector inspects (~20-30s, the dominant first-turn latency)
      // while the user is still typing — their first message then starts hot. The
      // sidecar throttles per (org, room), so refreshes/re-opens are no-ops.
      try {
        fetch(`${process.env.EMPLOYEES_SIDECAR_URL || process.env.HIVEMIND_EMPLOYEES_URL || 'http://hm-employees:8060'}/internal/hyper/prewarm`, {
          method: 'POST',
          headers: {
            'X-API-Key': getInternalApiKey(),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            room_id: roomId,
            user_id: current.session.userId,
            org_id: current.session.orgId,
            project_id: room.projectId || null,
            goal: room.goal || '',
            connectors: room.enabledConnectors || [],
          }),
        }).catch(() => { /* best-effort — never blocks room open */ });
      } catch { /* best-effort */ }
      const turns = newestTurns.reverse();
      const employees = (room.participantIds || []).length
        ? await prisma.digitalEmployee.findMany({
            where: { id: { in: room.participantIds } },
            select: {
              id: true,
              slug: true,
              name: true,
              avatarUrl: true,
              roleArchetype: true,
              peerReviewTargets: true,
              policyRules: true,
              scope: true,
              persona: true,
              model: true,
              llmProvider: true,
              status: true,
            },
          })
        : [];
      const { enrichEmployeesWithHyperState } = await import('./employees/hyper-state.js');
      const enrichedParticipants = await enrichEmployeesWithHyperState(employees);
      return jsonResponse(res, {
        room: {
          ...room,
          is_domain_home: room.agentConnectors?._domain_home === true,
          swarm_instructions: (room.agentConnectors && typeof room.agentConnectors === 'object'
            ? String(room.agentConnectors._swarm_instructions || '') : ''),
          participants: enrichedParticipants.map(e => ({ ...e, lane: deriveCsiLane(e) })),
        },
        turns,
      });
    }

    // PATCH /v1/hyper-rooms/:id — rename or update participants. Org-shared
    // (same model as read/participate/clear) so members can edit shared rooms.
    if (roomMetaMatch && req.method === 'PATCH') {
      const current = await requireSession(req, res);
      if (!current) return;
      const body = await parseBody(req);
      const roomId = roomMetaMatch[1];
      const room = await prisma.hyperRoom.findFirst({
        where: { id: roomId, orgId: current.session.orgId, archivedAt: null },
      });
      if (!room) return jsonResponse(res, { error: 'Room not found' }, 404);
      if (room.agentConnectors?._domain_home === true
          && (Object.prototype.hasOwnProperty.call(body, 'name') || Object.prototype.hasOwnProperty.call(body, 'room_tag'))) {
        return jsonResponse(res, {
          error: 'Permanent company Room names and expertise types cannot be changed.',
          code: 'DOMAIN_HOME_ROOM',
        }, 409);
      }
      const data = {};
      if (typeof body.name === 'string' && body.name.trim()) data.name = body.name.trim().slice(0, 120);
      const hasGoalPatch = Object.prototype.hasOwnProperty.call(body, 'goal');
      let nextGoal = null;
      if (hasGoalPatch) {
        nextGoal = typeof body.goal === 'string' ? body.goal.trim().slice(0, 2000) : '';
        if (!nextGoal) return jsonResponse(res, { error: 'goal is required' }, 400);
      }
      if (Array.isArray(body.participant_ids)) {
        const valid = body.participant_ids.length
          ? await prisma.digitalEmployee.findMany({
              where: { id: { in: body.participant_ids }, orgId: current.session.orgId },
              select: { id: true },
            })
          : [];
        data.participantIds = valid.map(v => v.id);
      }
      const ALLOWED_TEMPLATES = new Set([
        'auto', 'debate', 'decision', 'swarm', 'deep_sim', 'brainstorm', 'council',
        'lean_coffee', 'retrospective', 'review', 'standup',
      ]);
      if (typeof body.template === 'string' && ALLOWED_TEMPLATES.has(body.template)) {
        data.template = body.template;
      }
      if (typeof body.permanent_lead_id === 'string' || body.permanent_lead_id === null) {
        if (body.permanent_lead_id) {
          const emp = await prisma.digitalEmployee.findFirst({
            where: { id: body.permanent_lead_id, orgId: current.session.orgId },
            select: { id: true },
          });
          if (!emp) return jsonResponse(res, { error: 'Lead employee not in org' }, 400);
        }
        data.permanentLeadId = body.permanent_lead_id || null;
      }
      if (typeof body.permanent_skeptic_id === 'string' || body.permanent_skeptic_id === null) {
        if (body.permanent_skeptic_id) {
          // Must be a valid employee in this org
          const emp = await prisma.digitalEmployee.findFirst({
            where: { id: body.permanent_skeptic_id, orgId: current.session.orgId },
            select: { id: true },
          });
          if (!emp) return jsonResponse(res, { error: 'Skeptic employee not in org' }, 400);
        }
        data.permanentSkepticId = body.permanent_skeptic_id || null;
      }
      // Swarm Instructions — owner-set standing orders the room follows on EVERY
      // run. Stored in the agentConnectors jsonb (no migration); the sidecar reads
      // agent_connectors->>'_swarm_instructions' at every turn.
      if (typeof body.swarm_instructions === 'string') {
        const si = body.swarm_instructions.trim().slice(0, 4000);
        await prisma.$executeRawUnsafe(
          'UPDATE "hivemind"."hyper_rooms" SET "agent_connectors" = "agent_connectors" || $1::jsonb WHERE "id" = $2::uuid',
          JSON.stringify({ _swarm_instructions: si }), roomId,
        );
      }
      if (body.journal_reset === true) {
        await prisma.$executeRawUnsafe(
          'UPDATE "hivemind"."hyper_rooms" SET "room_journal" = \'[]\'::jsonb, "updated_at" = now() WHERE "id" = $1::uuid AND "org_id" = $2::uuid',
          roomId, current.session.orgId,
        );
      }
      const updated = await prisma.hyperRoom.update({ where: { id: roomId }, data });
      if (body.journal_reset === true) {
        updated.room_journal = [];
        updated.evo_journal = [];
      }
      if (hasGoalPatch) {
        try {
          await prisma.$executeRawUnsafe(
            'UPDATE "hivemind"."hyper_rooms" SET "goal" = $1 WHERE "id" = $2::uuid',
            nextGoal, roomId,
          );
          updated.goal = nextGoal;
        } catch (e) { console.warn('[hyper-rooms] goal update failed:', e.message); }
      }
        const ALLOWED_ROOM_TAGS = new Set(['general', 'campaign', 'seo', 'marketing', 'outreach', 'branding', 'fundraising', 'research', 'product', 'design', 'legal_finance']);
      if (typeof body.room_tag === 'string' && ALLOWED_ROOM_TAGS.has(body.room_tag)) {
        try {
          await prisma.$executeRawUnsafe(
            'UPDATE "hivemind"."hyper_rooms" SET "room_tag" = $1 WHERE "id" = $2::uuid',
            body.room_tag, roomId,
          );
          updated.room_tag = body.room_tag;
        } catch (e) { console.warn('[hyper-rooms] room_tag update failed:', e.message); }
      }
      // Scope change (Org ↔ Project) — persisted via raw SQL so it works without a
      // regenerated Prisma client for the project_id column. null clears to org-wide.
      if (Object.prototype.hasOwnProperty.call(body, 'project_id')) {
        let nextProjectId = null;
        if (typeof body.project_id === 'string' && body.project_id) {
          const proj = await prisma.project.findFirst({
            where: { id: body.project_id, orgId: current.session.orgId },
            select: { id: true },
          }).catch(() => null);
          if (!proj) return jsonResponse(res, { error: 'project not found in this org' }, 400);
          nextProjectId = proj.id;
        }
        try {
          await prisma.$executeRawUnsafe(
            'UPDATE "hivemind"."hyper_rooms" SET "project_id" = $1::uuid WHERE "id" = $2::uuid',
            nextProjectId, roomId,
          );
          updated.projectId = nextProjectId;
        } catch (e) { console.warn('[hyper-rooms] scope update failed:', e.message); }
      }
      // Quality mode (auto | best) — raw SQL so it works without a regenerated
      // Prisma client for the additive quality_mode column.
      if (typeof body.quality_mode === 'string' && ['auto', 'best'].includes(body.quality_mode)) {
        try {
          await prisma.$executeRawUnsafe(
            'UPDATE "hivemind"."hyper_rooms" SET "quality_mode" = $1 WHERE "id" = $2::uuid',
            body.quality_mode, roomId,
          );
          updated.quality_mode = body.quality_mode;
        } catch (e) { console.warn('[hyper-rooms] quality_mode update failed:', e.message); }
      }
      // Additive sim_mode column (Population-Sim toggle). Same raw-SQL pattern so a
      // missing column / pre-migration never 500s the PATCH.
      if (typeof body.sim_mode === 'string' && ['on', 'off'].includes(body.sim_mode)) {
        try {
          await prisma.$executeRawUnsafe(
            'UPDATE "hivemind"."hyper_rooms" SET "sim_mode" = $1 WHERE "id" = $2::uuid',
            body.sim_mode, roomId,
          );
          updated.sim_mode = body.sim_mode;
        } catch (e) { console.warn('[hyper-rooms] sim_mode update failed:', e.message); }
      }
      // Population-sim cast size (slider 10-100). Clamped; same fail-safe raw-SQL pattern.
      if (body.sim_agents != null && Number.isFinite(Number(body.sim_agents))) {
        const n = Math.max(10, Math.min(100, Math.round(Number(body.sim_agents))));
        try {
          await prisma.$executeRawUnsafe(
            'UPDATE "hivemind"."hyper_rooms" SET "sim_agents" = $1 WHERE "id" = $2::uuid',
            n, roomId,
          );
          updated.sim_agents = n;
        } catch (e) { console.warn('[hyper-rooms] sim_agents update failed:', e.message); }
      }
      return jsonResponse(res, { room: updated });
    }

    // DELETE /v1/hyper-rooms/:id — soft archive + distill summary memory
    if (roomMetaMatch && req.method === 'DELETE') {
      const current = await requireSession(req, res);
      if (!current) return;
      const roomId = roomMetaMatch[1];
      const room = await prisma.hyperRoom.findFirst({
        where: { id: roomId, userId: current.session.userId, orgId: current.session.orgId, archivedAt: null },
      });
      if (!room) return jsonResponse(res, { error: 'Room not found' }, 404);
      if (room.archivedAt) return jsonResponse(res, { room });

      // Pull turns to feed the distill prompt
      const turns = await prisma.hyperTurn.findMany({
        where: { roomId, status: 'complete' },
        orderBy: { seq: 'asc' },
        take: 200,
      });

      // Build a compact transcript for the summary memory
      const lines = [];
      for (const t of turns) {
        lines.push(`USER: ${t.userMessage}`);
        for (const evt of (t.lines || [])) {
          if (evt.t === 'line' || evt.t === 'revise') {
            lines.push(`${evt.agent} (lead): ${evt.content || ''}`);
          } else if (evt.t === 'react' || evt.t === 'validate') {
            lines.push(`${evt.agent} (${evt.agreement || 'react'}): ${evt.content || ''}`);
          }
        }
      }
      const transcript = lines.join('\n').slice(0, 30_000);

      // Best-effort summary memory write via control-plane proxy → core.
      // Stays inside the canonical pipeline by hitting /api/memories.
      let summaryMemoryId = null;
      try {
        const corePath = '/api/memories';
        const url = new URL(corePath, CONFIG.coreApiBaseUrl);
        const resp = await fetch(url.toString(), {
          method: 'POST',
          headers: {
            'X-API-Key': getInternalApiKey(),
            'X-HM-User-Id': current.session.userId,
            'X-HM-Org-Id': current.session.orgId,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            title: `Hyper room — ${room.name}`,
            content: transcript || 'Empty room.',
            memory_type: 'summary',
            tags: ['hyper-room', `room:${roomId}`],
            source_metadata: { source_platform: 'hyper-agents', source_id: roomId },
            metadata: { hyper_room_id: roomId, turn_count: turns.length },
          }),
        });
        if (resp.ok) {
          const data = await resp.json();
          summaryMemoryId = data?.memory?.id || data?.id || null;
        }
      } catch (err) {
        console.warn('[hyper-rooms] archive summary write failed:', err.message);
      }

      const updated = await prisma.hyperRoom.update({
        where: { id: roomId },
        data: { archivedAt: new Date(), summaryMemoryId },
      });
      return jsonResponse(res, { room: updated, summary_memory_id: summaryMemoryId });
    }

    // POST /v1/hyper-rooms/:id/turns/:turnId/flyby-decision — continue a
    // deep simulation after the user approves/rejects the temporary specialist.
    if ((flybyDecisionMatch || flybyDecisionCompat) && req.method === 'POST') {
      const current = await requireSession(req, res);
      if (!current) return;
      const body = await parseBody(req);
      const roomId = flybyDecisionMatch ? flybyDecisionMatch[1] : roomTurnMatch[1];
      const turnId = flybyDecisionMatch ? flybyDecisionMatch[2] : roomTurnMatch[2];
      const decision = String(body.decision || '').trim().toLowerCase();
      if (!['agree', 'disagree'].includes(decision)) {
        return jsonResponse(res, { error: 'decision must be agree or disagree' }, 400);
      }
      try {
        // Org-shared participate: any org member can continue a flyby decision.
        const room = await prisma.hyperRoom.findFirst({
          where: { id: roomId, orgId: current.session.orgId, archivedAt: null },
        });
        if (!room) return jsonResponse(res, { error: 'Room not found' }, 404);
        try {
          const gr = await prisma.$queryRawUnsafe(
            'SELECT project_id, goal, room_tag, room_mode FROM "hivemind"."hyper_rooms" WHERE id = $1::uuid',
            roomId,
          );
          room.projectId = gr?.[0]?.project_id || null;
          room.goal = gr?.[0]?.goal || '';
          room.roomTag = gr?.[0]?.room_tag || 'general';
          room.roomMode = gr?.[0]?.room_mode || null;
        } catch { room.goal = ''; }
        const turn = await prisma.hyperTurn.findFirst({
          where: { id: turnId, roomId },
          select: { id: true, userMessage: true, lines: true, status: true, sealedAt: true },
        });
        if (!turn) return jsonResponse(res, { error: 'Turn not found' }, 404);
        if (turn.sealedAt || turn.status !== 'live') {
          return jsonResponse(res, { error: 'Turn is no longer live' }, 409);
        }
        const proposal = (turn.lines || []).find(ev => ev && ev.t === 'flyby_proposal');
        const flybySpec = body.flyby_spec || proposal?.spec || null;
        const { appendTurnEvent } = await import('./employees/hyper-rooms.js');
        await appendTurnEvent(prisma, turnId, {
          t: 'flyby_decision',
          decision,
          spec: flybySpec,
          ts: Date.now(),
        });

        dispatchHyperRoomTurn({
          room_id: roomId,
          turn_id: turnId,
          user_id: current.session.userId,
          org_id: current.session.orgId,
          user_message: turn.userMessage,
          participant_ids: room.participantIds || [],
          project_id: room.projectId || null,
          room_goal: room.goal || '',
          room_mode: roomExecutionMode(room),
          task_tag: roomExecutionTag(room),
          flyby_decision: decision,
          flyby_spec: flybySpec,
          callback_url: `${(process.env.CONTROL_PLANE_INTERNAL_URL || 'http://hm-control:3000')}/internal/hyper/turn-event`,
        }).catch(err => console.warn('[hyper-rooms] flyby continuation failed:', err.message));

        return jsonResponse(res, { ok: true, status: 'continuing' }, 202);
      } catch (err) {
        console.warn('[hyper-rooms] flyby decision failed:', err.message);
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // POST /v1/hyper-rooms/:id/approve — resolve a queued connector write
    // (Phase 7 approval card). Body: { approval_id, decision: "approve"|"deny" }.
    // Proxies to the sidecar with the master key (sidecar reads X-API-Key).
    if (roomApproveMatch && req.method === 'POST') {
      const current = await requireSession(req, res);
      if (!current) return true;
      const roomId = roomApproveMatch[1];
      const body = await parseBody(req).catch(() => ({}));
      const approvalId = String(body.approval_id || '').trim();
      const decision = String(body.decision || '').trim().toLowerCase();
      if (!approvalId || !['approve', 'deny'].includes(decision)) {
        return jsonResponse(res, { error: 'approval_id and decision (approve|deny) required' }, 400);
      }
      const MASTER = getInternalApiKey();
      try {
        const room = await prisma.hyperRoom.findFirst({ where: { id: roomId, orgId: current.session.orgId, archivedAt: null } });
        if (!room) return jsonResponse(res, { error: 'Room not found' }, 404);
        // DURABLE resolve: the approval_request event (with its descriptor) is
        // persisted in the turn's lines, so this survives sidecar restarts and
        // works across replicas — unlike the old in-memory store on the sidecar.
        const turns = await prisma.hyperTurn.findMany({
          where: { roomId }, orderBy: { seq: 'desc' }, take: 30, select: { id: true, lines: true },
        });
        let rec = null; let turnId = null; let alreadyResolved = false;
        for (const t of turns) {
          const lines = Array.isArray(t.lines) ? t.lines : [];
          const ev = lines.find((l) => l && l.t === 'approval_request' && l.approval_id === approvalId);
          if (ev) {
            rec = ev; turnId = t.id;
            alreadyResolved = lines.some((l) => l && l.t === 'approval_resolved' && l.approval_id === approvalId);
            break;
          }
        }
        const { appendTurnEvent } = await import('./employees/hyper-rooms.js');
        if (!rec || !rec.descriptor) {
          // Legacy fallback: older approvals still live in the sidecar's memory.
          const sidecarBase = process.env.EMPLOYEES_SIDECAR_URL || process.env.HIVEMIND_EMPLOYEES_URL || 'http://hm-employees:8060';
          const resp = await fetch(`${sidecarBase}/internal/hyper/approve`, {
            method: 'POST',
            headers: { 'X-API-Key': MASTER, 'Content-Type': 'application/json' },
            body: JSON.stringify({ approval_id: approvalId, decision }),
            signal: AbortSignal.timeout(60000),
          }).catch(() => null);
          if (!resp) return jsonResponse(res, { error: 'approval not found (it may have expired — re-run the turn)' }, 404);
          const text = await resp.text();
          let payload; try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
          return jsonResponse(res, payload, resp.status);
        }
        if (alreadyResolved) {
          return jsonResponse(res, { ok: true, approval_id: approvalId, decision: 'already_resolved' }, 200);
        }
        let result = null;
        if (decision === 'approve') {
          const path = rec.bridge === 'mcp' ? '/api/connectors/mcp/exec' : '/api/connectors/google/exec';
          const r = await fetch(`${CONFIG.coreApiBaseUrl}${path}`, {
            method: 'POST',
            headers: {
              'X-API-Key': MASTER,
              'X-HM-User-Id': room.userId,
              'X-HM-Org-Id': room.orgId,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(rec.descriptor),
            signal: AbortSignal.timeout(60000),
          });
          const tx = await r.text();
          try { result = JSON.parse(tx); } catch { result = { raw: tx }; }
          if (!r.ok) return jsonResponse(res, { error: `bridge ${r.status}`, result }, 502);
        }
        await appendTurnEvent(prisma, turnId, {
          t: 'approval_resolved', approval_id: approvalId, decision, label: rec.label, result, ts: Date.now(),
        });
        // Ledger: only approved gmail sends count as an outbound value action.
        if (decision === 'approve' && rec.bridge !== 'mcp' && String(rec.descriptor?.tool || '').startsWith('gmail_send')) {
          recordOutboundAction({
            orgId: room.orgId, userId: room.userId, roomId, approvalId,
            channel: 'email',
            recipient: rec.descriptor?.arguments?.to || rec.to || null,
            subject: rec.descriptor?.arguments?.subject || rec.subject || null,
            messageId: result?.id || null, threadId: result?.threadId || null,
            meta: { via: 'approve', tool: rec.descriptor?.tool },
          }).catch(() => {});
        }
        return jsonResponse(res, { ok: true, approval_id: approvalId, decision, result }, 200);
      } catch (err) {
        console.warn('[hyper-rooms] approve failed:', err.message);
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // Outreach campaign runner — /v1/hyper-rooms/:id/outreach-campaigns +
    // /v1/outreach-campaigns/* (create/get/start/stop/patch/generate/execute).
    if (pathname.includes('outreach-campaigns')
        || pathname === '/internal/hyper/outreach/propose'
        || pathname === '/internal/hyper/outreach/calls/reconcile'
        || pathname === '/internal/hyper/outreach/runtime-call/start'
        || pathname.startsWith('/internal/hyper/tara/calls/')) {
      if (await outreachModule().handle(req, res, pathname)) return true;
    }

    // POST /v1/hyper-rooms/:id/send-email — one-click send from the FE preview
    // popup: the user reviewed (and possibly EDITED) the draft in-app, so this IS
    // the human approval. Sends via the core Gmail bridge with markdown→HTML
    // polish + optional image attachments (client-rendered mermaid PNGs).
    // Resolves the pending approval card (if any) so it can't double-send.
    const roomSendEmailMatch = pathname.match(/^\/v1\/hyper-rooms\/([0-9a-f-]{36})\/send-email$/);
    if (roomSendEmailMatch && req.method === 'POST') {
      const current = await requireSession(req, res);
      if (!current) return true;
      const roomId = roomSendEmailMatch[1];
      const body = await parseBody(req).catch(() => ({}));
      const to = String(body.to || '').trim();
      const subject = String(body.subject || '').trim();
      const bodyMd = String(body.body_md || '').trim();
      if (!to || !subject || !bodyMd) {
        return jsonResponse(res, { error: 'to, subject and body_md are required' }, 400);
      }
      if (!/^[\w.+-]+@[\w.-]+\.\w+$/.test(to)) {
        return jsonResponse(res, { error: 'to must be a valid email address' }, 400);
      }
      // Bounded attachments: max 6 images, ~2MB base64 each (mermaid PNGs are ~100KB).
      const attachments = (Array.isArray(body.attachments) ? body.attachments : [])
        .filter((a) => a && a.filename && a.data_b64 && String(a.mime || '').startsWith('image/'))
        .slice(0, 6)
        .map((a) => ({
          filename: String(a.filename).replace(/[^\w.-]/g, '_').slice(0, 80),
          mime: String(a.mime).slice(0, 60),
          data_b64: String(a.data_b64).slice(0, 2_000_000),
        }));
      const MASTER = getInternalApiKey();
      try {
        const room = await prisma.hyperRoom.findFirst({ where: { id: roomId, orgId: current.session.orgId, archivedAt: null } });
        if (!room) return jsonResponse(res, { error: 'Room not found' }, 404);
        const r = await fetch(`${CONFIG.coreApiBaseUrl}/api/connectors/google/exec`, {
          method: 'POST',
          headers: {
            'X-API-Key': MASTER,
            'X-HM-User-Id': room.userId,
            'X-HM-Org-Id': room.orgId,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            tool: 'gmail_send',
            arguments: { to, subject, body: bodyMd, markdown: true, attachments },
          }),
          signal: AbortSignal.timeout(60000),
        });
        const tx = await r.text();
        let result; try { result = JSON.parse(tx); } catch { result = { raw: tx }; }
        if (!r.ok) return jsonResponse(res, { error: `gmail send failed (${r.status})`, result }, 502);
        // Ledger: this send actually left the platform (one-click preview send).
        recordOutboundAction({
          orgId: room.orgId, userId: room.userId, roomId,
          approvalId: String(body.approval_id || '').trim() || null,
          channel: 'email', recipient: to, subject,
          messageId: result?.id || null, threadId: result?.threadId || null,
          meta: { via: 'send-email', attachments: attachments.length },
        }).catch(() => {});
        // Mark the approval card resolved (best-effort) so the stale card can't re-send.
        const approvalId = String(body.approval_id || '').trim();
        if (approvalId) {
          try {
            const turns = await prisma.hyperTurn.findMany({
              where: { roomId }, orderBy: { seq: 'desc' }, take: 30, select: { id: true, lines: true },
            });
            for (const t of turns) {
              const lines = Array.isArray(t.lines) ? t.lines : [];
              if (lines.some((l) => l && l.t === 'approval_request' && l.approval_id === approvalId)) {
                const { appendTurnEvent } = await import('./employees/hyper-rooms.js');
                await appendTurnEvent(prisma, t.id, {
                  t: 'approval_resolved', approval_id: approvalId, decision: 'approve',
                  label: 'gmail_send', result: { sent: true, edited_in_preview: true }, ts: Date.now(),
                });
                break;
              }
            }
          } catch (e) { console.warn('[hyper-rooms] send-email approval mark failed:', e.message); }
        }
        return jsonResponse(res, { ok: true, sent: true, to, subject, result }, 200);
      } catch (err) {
        console.warn('[hyper-rooms] send-email failed:', err.message);
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // POST /v1/hyper-rooms/:id/call — channel 2 of the closed loop: place a
    // REAL outbound TARA call from a room. Body: { to, goal? }. The user's
    // click IS the approval (same trust model as send-email). Proxies to the
    // tara-deepgram outbound API, which enforces the configured phone
    // allowlist server-side (a 400 from there surfaces as-is). On successful
    // dial, writes the outbound_actions ledger row (channel=call); the
    // /api/tara/calls/end path later fills outcome completed/booked by the
    // session_id carried in meta.
    const roomCallMatch = pathname.match(/^\/v1\/hyper-rooms\/([0-9a-f-]{36})\/call$/);
    if (roomCallMatch && req.method === 'POST') {
      const current = await requireSession(req, res);
      if (!current) return true;
      const roomId = roomCallMatch[1];
      const body = await parseBody(req);
      const to = String(body.to || '').trim();
      if (!/^\+[1-9]\d{6,14}$/.test(to)) {
        return jsonResponse(res, { error: 'to must be an E.164 phone number (e.g. +4915112345678)' }, 400);
      }
      try {
        const room = await prisma.hyperRoom.findFirst({ where: { id: roomId, orgId: current.session.orgId, archivedAt: null } });
        if (!room) return jsonResponse(res, { error: 'Room not found' }, 404);
        const provider = await taraProviderFor(room.orgId);
        const taraBase = provider.baseUrl;
        const sessionId = `hyper-${roomId.slice(0, 8)}-${Date.now()}`;
        const caps = await fetch(`${taraBase}/capabilities`, { signal: AbortSignal.timeout(4000) })
          .then(async (r) => (r.ok ? r.json() : null))
          .catch(() => null);
        if (caps && caps.telephony === false && caps.browser !== false) {
          return jsonResponse(res, {
            ok: true,
            dialing: false,
            delivery: 'browser',
            provider: provider.provider,
            reason: 'provider has no telephony bridge — use the browser voice session',
            browser_call: {
              provider: provider.provider,
              session_id: sessionId,
              goal: String(body.goal || '').slice(0, 300) || undefined,
              language: String(body.language || 'en').slice(0, 8),
              mode: 'external',
            },
          }, 200);
        }
        const r = await fetch(`${taraBase}/calls/outbound`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // Both adapters share ONE dial gate — scoping the key to deepgram
            // made every Grok room call 401 at the adapter.
            ...(process.env.TARA_DG_API_KEY ? { 'X-TARA-Key': process.env.TARA_DG_API_KEY } : {}),
          },
          body: JSON.stringify({
            to,
            session_id: sessionId,
            user_id: room.userId,
            org_id: room.orgId,
            goal: String(body.goal || '').slice(0, 300) || undefined,
            provider: provider.provider,
            config_revision: provider.revision,
          }),
          signal: AbortSignal.timeout(20000),
        }).catch(() => null);
        if (!r) return jsonResponse(res, { error: 'TARA outbound service unreachable' }, 503);
        const tx = await r.text();
        let result; try { result = JSON.parse(tx); } catch { result = { raw: tx }; }
        if (!r.ok) return jsonResponse(res, { error: result?.error || `dial failed (${r.status})`, result }, r.status === 400 ? 400 : 502);
        // Ledger: the dial actually went out (value action, channel 2).
        recordOutboundAction({
          orgId: room.orgId, userId: room.userId, roomId,
          channel: 'call', recipient: to,
          messageId: result?.call_leg_id || null,
          meta: { via: 'room-call', session_id: sessionId, provider: provider.provider, goal: String(body.goal || '').slice(0, 300) || undefined },
        }).catch(() => {});
        return jsonResponse(res, { ok: true, dialing: true, provider: provider.provider, session_id: sessionId, call_leg_id: result?.call_leg_id || null }, 200);
      } catch (err) {
        console.warn('[hyper-rooms] call failed:', err.message);
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // POST /v1/hyper-rooms/:id/turns — submit user message, kick a turn
    if (roomTurnMatch && roomTurnMatch[2] == null && req.method === 'POST') {
      const current = await requireSession(req, res);
      if (!current) return;
      const body = await parseBody(req);
      const roomId = roomTurnMatch[1];
      const userMessage = typeof body.user_message === 'string' ? body.user_message : '';
      const requestedTurnId = typeof body.turn_id === 'string'
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.turn_id)
          ? body.turn_id
          : null;

      // Org-shared participate: any org member can submit a turn to an org room.
      const room = await prisma.hyperRoom.findFirst({
        where: { id: roomId, orgId: current.session.orgId, archivedAt: null },
      });
      if (room) {
        try {
          const gr = await prisma.$queryRawUnsafe(
            'SELECT project_id, goal, room_tag, room_mode FROM "hivemind"."hyper_rooms" WHERE id = $1::uuid',
            roomId,
          );
          room.projectId = gr?.[0]?.project_id || null;
          room.goal = gr?.[0]?.goal || '';
          room.roomTag = gr?.[0]?.room_tag || 'general';
          room.roomMode = gr?.[0]?.room_mode || null;
        } catch { room.goal = ''; }
      }
      if (!room) return jsonResponse(res, { error: 'Room not found' }, 404);
      const agentAccess = await requirePrivilegedAgentAccess(req, res, current, room.projectId || null);
      if (!agentAccess) return;

      // ── HQ dispatch: a work request typed in HQ runs in the right kind room ──
      if (process.env.HQ_DISPATCH !== 'off' && !body.action && userMessage.trim()) {
        const isHq = room.agentConnectors && typeof room.agentConnectors === 'object'
          && Object.prototype.hasOwnProperty.call(room.agentConnectors, '_company');
        const kind = isHq ? classifyHqKind(userMessage) : null;
        if (kind && isHqWorkRequest(userMessage)) {
          try {
            const target = await findOrCreateKindRoom(current.session, room, kind, userMessage);
            // Create + kick the turn in the TARGET room (idempotent seq).
            const tgtTurn = await prisma.$transaction(async (tx) => {
              const last = await tx.hyperTurn.findFirst({ where: { roomId: target.id }, orderBy: { seq: 'desc' }, select: { seq: true } });
              const seq = (last?.seq ?? 0) + 1;
              return tx.hyperTurn.create({
                data: { roomId: target.id, seq, userMessage, status: 'live',
                        idempotencyKey: buildIdempotencyKey({ roomId: target.id, seq, userMessage }), lines: [] },
              });
            });
            dispatchHyperRoomTurn({
              room_id: target.id, turn_id: tgtTurn.id,
              user_id: current.session.userId, org_id: current.session.orgId,
              user_message: userMessage, participant_ids: target.participantIds || [],
              project_id: null, room_goal: `${kind} work routed from HQ`,
              room_mode: 'runtime', task_tag: `ROOM_${String(kind).toUpperCase()}`,
              callback_url: `${(process.env.CONTROL_PLANE_INTERNAL_URL || 'http://hm-control:3000')}/internal/hyper/turn-event`,
            }).catch((e) => console.warn('[hq-dispatch] kick failed:', e.message));
            // Routing card in the HQ feed so the owner sees where it went.
            await prisma.$executeRawUnsafe(
              `INSERT INTO "hivemind"."hq_activity"
                 (org_id, hq_room_id, source_room_id, source_room_name, turn_id, headline, summary, status)
               VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5::uuid,$6,$7,'routed') ON CONFLICT (turn_id) DO NOTHING`,
              current.session.orgId, room.id, target.id, `${_HQ_KIND_LABEL[kind]} desk`, tgtTurn.id,
              `Routed to the ${_HQ_KIND_LABEL[kind]} desk`, String(userMessage).slice(0, 400),
            ).catch(() => {});
            return jsonResponse(res, { ok: true, routed: true, room_id: target.id, turn_id: tgtTurn.id, kind }, 200);
          } catch (e) {
            console.warn('[hq-dispatch] failed, running in HQ:', e.message);
            // fall through — run in HQ rather than lose the turn
          }
        }
      }

      if (body.action === 'flyby-decision') {
        const turnId = typeof body.turn_id === 'string' ? body.turn_id : '';
        const decision = String(body.decision || '').trim().toLowerCase();
        if (!room) return jsonResponse(res, { error: 'Room not found' }, 404);
        if (!turnId) return jsonResponse(res, { error: 'turn_id is required' }, 400);
        if (!['agree', 'disagree'].includes(decision)) {
          return jsonResponse(res, { error: 'decision must be agree or disagree' }, 400);
        }
        try {
          const turn = await prisma.hyperTurn.findFirst({
            where: { id: turnId, roomId },
            select: { id: true, userMessage: true, lines: true, status: true, sealedAt: true },
          });
          if (!turn) return jsonResponse(res, { error: 'Turn not found' }, 404);
          if (turn.sealedAt || turn.status !== 'live') {
            return jsonResponse(res, { error: 'Turn is no longer live' }, 409);
          }
          const proposal = (turn.lines || []).find(ev => ev && ev.t === 'flyby_proposal');
          const flybySpec = body.flyby_spec || proposal?.spec || null;
          const { appendTurnEvent } = await import('./employees/hyper-rooms.js');
          await appendTurnEvent(prisma, turnId, {
            t: 'flyby_decision',
            decision,
            spec: flybySpec,
            ts: Date.now(),
          });

          dispatchHyperRoomTurn({
            room_id: roomId,
            turn_id: turnId,
            user_id: current.session.userId,
            org_id: current.session.orgId,
            user_message: turn.userMessage,
            participant_ids: room.participantIds || [],
            project_id: room.projectId || null,
            room_goal: room.goal || '',
            room_mode: roomExecutionMode(room),
            task_tag: roomExecutionTag(room),
            flyby_decision: decision,
            flyby_spec: flybySpec,
            callback_url: `${(process.env.CONTROL_PLANE_INTERNAL_URL || 'http://hm-control:3000')}/internal/hyper/turn-event`,
          }).catch(err => console.warn('[hyper-rooms] flyby continuation failed:', err.message));

          return jsonResponse(res, { ok: true, status: 'continuing' }, 202);
        } catch (err) {
          console.warn('[hyper-rooms] flyby decision failed:', err.message);
          return jsonResponse(res, { error: err.message }, 500);
        }
      }
      const pre = preflightTurn({ room, userMessage });
      if (pre) return jsonResponse(res, pre, 400);

      const meteredTurnId = requestedTurnId || crypto.randomUUID();
      const hyperCreditKey = `hyperagent:turn:${meteredTurnId}`;
      const hyperCredit = await controlCreditService.reserve({
        orgId: current.session.orgId, userId: current.session.userId,
        service: 'hyperagent_turn', units: 1, source: 'hyperagents',
        idempotencyKey: hyperCreditKey, metadata: { room_id: roomId },
      });
      if (!hyperCredit.admitted) return jsonResponse(res, planLimitBody(hyperCredit.check, 'credits'), 402);

      const runLimit = await planEnforcer.checkLimit(current.session.orgId, 'hyperAgentRuns', 1);
      if (!runLimit.allowed) {
        if (!hyperCredit.duplicate) await controlCreditService.release({ orgId: current.session.orgId, idempotencyKey: hyperCreditKey });
        return jsonResponse(res, planLimitBody(runLimit, 'hyperAgentRuns'), runLimit.status || 429);
      }

      // Evaluate once and latch on the turn. Flagship/network failure is the
      // byte-compatible stable path; no user can drift models mid-turn.
      const { hyperPlannerModeFor } = await import('./employees/cloudflare-hyper-planner-client.js');
      const fastPlannerMode = await hyperPlannerModeFor({
        orgId: current.session.orgId, userId: current.session.userId,
      });

      // Sequence is monotonic per room. Atomic via SELECT max + insert
      // wrapped in serializable transaction.
      try {
        let createdNew = false;
        const turn = await prisma.$transaction(async (tx) => {
          const last = await tx.hyperTurn.findFirst({
            where: { roomId },
            orderBy: { seq: 'desc' },
            select: { seq: true },
          });
          const nextSeq = (last?.seq ?? 0) + 1;
          const key = body.idempotency_key
            && typeof body.idempotency_key === 'string'
            && body.idempotency_key.length <= 64
              ? body.idempotency_key
              : buildIdempotencyKey({ roomId, seq: nextSeq, userMessage });

          // Idempotency: if a turn with this key already exists, return it.
          const existing = await tx.hyperTurn.findUnique({ where: { idempotencyKey: key } });
          if (existing) return existing;

          const created = await tx.hyperTurn.create({
            data: {
              id: meteredTurnId,
              roomId,
              seq: nextSeq,
              userMessage,
              status: 'live',
              idempotencyKey: key,
              lines: [],
              fastPlannerMode,
            },
          });
          await tx.hyperRoom.update({
            where: { id: roomId },
            data: { updatedAt: new Date() },
          });
          createdNew = true;
          return created;
        });

        if (createdNew) {
          await controlUsageService.record({
            orgId: current.session.orgId,
            userId: current.session.userId,
            type: 'hyperAgentRuns',
            quantity: 1,
            source: 'hyperagents',
            idempotencyKey: `hyperagent-run:${turn.id}`,
            metadata: { turn_id: turn.id, room_id: roomId },
          });
          if (!hyperCredit.duplicate) await controlCreditService.settle({ orgId: current.session.orgId, idempotencyKey: hyperCreditKey });
        } else if (!hyperCredit.duplicate) {
          await controlCreditService.release({ orgId: current.session.orgId, idempotencyKey: hyperCreditKey });
        }

        const isIndependentGrowthRun = room.agentConnectors?._domain_home === true
          && String(room.roomTag || room.room_tag || 'general') === 'general'
          && requestsGrowthStage(userMessage);

        // Emit a bootstrap router event immediately so the UI can render the
        // lead/reactor line before the sidecar finishes the heavier recall and
        // simulation prep. The sidecar will emit the authoritative router event
        // later; the frontend treats this as the same conversation state.
        if (!isIndependentGrowthRun) try {
          const { appendTurnEvent } = await import('./employees/hyper-rooms.js');
          const participantRows = room.participantIds?.length
            ? await prisma.digitalEmployee.findMany({
                where: { id: { in: room.participantIds } },
                select: {
                  id: true,
                  slug: true,
                  roleArchetype: true,
                  persona: true,
                },
              })
            : [];
          const participantById = Object.fromEntries(participantRows.map(p => [p.id, p]));
          const leadId = room.permanentLeadId && participantById[room.permanentLeadId]
            ? room.permanentLeadId
            : (room.participantIds || [])[0] || null;
          const lead = leadId ? participantById[leadId] : null;
          const reactors = (room.participantIds || [])
            .filter(pid => pid !== leadId)
            .map(pid => participantById[pid]?.slug)
            .filter(Boolean);
          if (lead?.slug) {
            await appendTurnEvent(prisma, turn.id, {
              t: 'router_bootstrap',
              id: `router:${turn.id}:bootstrap`,
              lead: lead.slug,
              reactors,
              lanes: Object.fromEntries(
                participantRows.map(p => [p.slug, deriveCsiLane({
                  roleArchetype: p.roleArchetype,
                  persona: p.persona,
                  slug: p.slug,
                  name: p.slug,
                })]),
              ),
              template: room.template || 'debate',
              room_kind: room.roomTag || room.room_tag || 'general',
              turn_seq: turn.seq,
              bootstrap: true,
              received_ts: Date.now(),
            });
          }
        } catch (err) {
          console.warn('[hyper-rooms] bootstrap router append failed:', err.message);
        }

        // Kick the sidecar only after the 202 response has been flushed. This
        // lets the frontend open SSE/poll immediately instead of waiting behind
        // any sidecar connection/setup latency.
        const dispatchSidecar = async () => {
          try {
          const isHq = room.agentConnectors?._domain_home === true && String(room.roomTag || room.room_tag || 'general') === 'general';
          if (isHq && requestsGrowthStage(userMessage)) {
            const { appendTurnEvent, sealTurn } = await import('./employees/hyper-rooms.js');
            try {
              const prior = await getLatestGrowthPlan({ prisma, orgId: current.session.orgId });
              const mode = prior ? 'operate' : 'initial_full';
              await appendTurnEvent(prisma, turn.id, { t: 'growth_plan_runner', status: 'running', mode, title: mode === 'initial_full' ? 'Building the first Growth Operating Plan' : 'Updating the Growth Operating Plan' });
              const result = await runGrowthPlan({
                prisma, orgId: current.session.orgId, userId: current.session.userId, mode,
                objective: userMessage, turnId: turn.id,
                onProgress: ({ stage, detail }) => appendTurnEvent(prisma, turn.id, { t: 'growth_plan_progress', status: 'complete', stage, detail }),
              });
              await appendTurnEvent(prisma, turn.id, { t: 'growth_plan_complete', status: 'complete', artifact_id: result.artifact_id, mode: result.mode, aspects: result.aspects, plan: result.plan, committed: result.committed });
              await appendTurnEvent(prisma, turn.id, { t: 'final_report', status: 'complete', kind: 'growth_operating_plan', text: result.plan.report_markdown, artifact_id: result.artifact_id });
              await sealTurn(prisma, turn.id, { status: 'complete', costTokens: Number(result.usage?.total_tokens || 0) });
            } catch (error) {
              console.warn('[growth-plan-runner] failed:', error.message);
              await appendTurnEvent(prisma, turn.id, { t: 'growth_plan_failed', status: 'failed', error: error.message });
              await sealTurn(prisma, turn.id, { status: 'failed', event: { t: 'seal', status: 'failed', error: error.message, cost_tokens: 0 } });
            }
            return;
          }
          let executionContext = '';
          dispatchHyperRoomTurn({
            room_id: roomId,
            turn_id: turn.id,
            user_id: current.session.userId,
            org_id: current.session.orgId,
            user_message: userMessage,
            participant_ids: room.participantIds || [],
            project_id: room.projectId || null,
            room_goal: room.goal || '',
            room_mode: roomExecutionMode(room),
            task_tag: isHq ? 'HQ' : roomExecutionTag(room),
            fast_planner_mode: turn.fastPlannerMode || 'off',
            ...(executionContext ? { execution_context: executionContext } : {}),
            ...(typeof body.language === 'string' && body.language.trim() ? { language: body.language.trim() } : {}),
            callback_url: `${(process.env.CONTROL_PLANE_INTERNAL_URL || 'http://hm-control:3000')}/internal/hyper/turn-event`,
          }).catch(err => console.warn('[hyper-rooms] sidecar kick failed:', err.message));
          } catch (err) {
            console.warn('[hyper-rooms] sidecar dispatch threw:', err.message);
          }
        };
        setImmediate(() => dispatchSidecar().catch(err => console.warn('[hyper-rooms] async sidecar dispatch failed:', err.message)));

        return jsonResponse(res, { turn_id: turn.id, status: turn.status }, 202);
      } catch (err) {
        if (!hyperCredit.duplicate) await controlCreditService.release({ orgId: current.session.orgId, idempotencyKey: hyperCreditKey }).catch(() => {});
        console.warn('[hyper-rooms] turn create failed:', err.message);
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // GET /v1/hyper-rooms/:id/turns/:turnId — sealed turn DB read
    if (roomTurnMatch && roomTurnMatch[2] && !roomTurnMatch[3] && req.method === 'GET') {
      const current = await requireSession(req, res);
      if (!current) return;
      const [_, roomId, turnId] = roomTurnMatch;
      const room = await prisma.hyperRoom.findFirst({
        where: { id: roomId, orgId: current.session.orgId, archivedAt: null },
      });
      if (!room) return jsonResponse(res, { error: 'Room not found' }, 404);
      const turn = await prisma.hyperTurn.findFirst({ where: { id: turnId, roomId } });
      if (!turn) return jsonResponse(res, { error: 'Turn not found' }, 404);
      return jsonResponse(res, { turn });
    }

    // GET /v1/hyper-rooms/:id/turns/:turnId/stream — SSE for live turn
    if (roomTurnMatch && roomTurnMatch[2] && roomTurnMatch[3] === '/stream' && req.method === 'GET') {
      const current = await requireSession(req, res);
      if (!current) return;
      const [_, roomId, turnId] = roomTurnMatch;
      return handleHyperTurnStreamRoute({
        req,
        res,
        prisma,
        roomId,
        turnId,
        orgId: current.session.orgId,
        jsonResponse,
      });
    }

    // POST /v1/hyper-rooms/:id/promote-prompt — human-gated promotion
    const promoteMatch = pathname.match(/^\/v1\/hyper-rooms\/([0-9a-f-]{36})\/promote-prompt$/);
    if (promoteMatch && req.method === 'POST') {
      // Delegated to sidecar tuner (file-based prompt variants)
      await _forwardSidecar(req, res, '/internal/hyper/promote-prompt');
      return;
    }

    // ─── Internal hook: sidecar writes turn events back here ───
    // Sidecar POSTs each JSONL event during execution; we append it to
    // the row and let any open SSE subscriber pick it up on next poll.
    if (pathname === '/internal/hyper/turn-event' && req.method === 'POST') {
      const { appendTurnEvent, sealTurn } = await import('./employees/hyper-rooms.js');
      const routeResult = await handleInternalHyperTurnEventRoute({
        req,
        res,
        prisma,
        jsonResponse,
        parseBody,
        hasInternalApiKey,
        appendTurnEvent,
        sealTurn,
      });
      if (routeResult?.statusCode) return routeResult;
      const { body } = routeResult || {};
      try {
        if (body.event.t === 'growth_plan_contract') {
          try {
            const sourceTurn = await prisma.hyperTurn.findUnique({
              where: { id: body.turn_id }, select: { roomId: true },
            });
            const sourceRoom = sourceTurn && await prisma.hyperRoom.findUnique({
              where: { id: sourceTurn.roomId }, select: { orgId: true, userId: true, agentConnectors: true },
            });
            const isHq = Boolean(sourceRoom?.agentConnectors?._domain_home);
            if (!sourceRoom || !isHq) throw new Error('Growth plans may be committed only by Company HQ');
            const committed = await commitGrowthPlan({
              prisma, orgId: sourceRoom.orgId, userId: sourceRoom.userId,
              turnId: body.turn_id, contract: body.event.contract,
            });
            await appendTurnEvent(prisma, body.turn_id, {
              t: 'growth_plan_committed', status: 'accepted',
              goal_id: committed.goal.id, growth_stage_id: committed.stage.id,
              delegation_id: committed.delegation.id, work_order_id: committed.work_order?.id,
              room_id: committed.room.id, room_tag: committed.delegation.room_tag,
            });
          } catch (growthError) {
            console.warn('[growth-stage] contract rejected:', growthError.message);
            await appendTurnEvent(prisma, body.turn_id, {
              t: 'growth_plan_rejected', status: 'rejected', error: growthError.message,
            });
          }
        }
        const { handleCampaignRoomEvent } = await import('./campaigns/pipeline.js');
        await handleCampaignRoomEvent({ prisma, turnId: body.turn_id, event: body.event });
        if (body.event.t === 'seal') {
          // Reconcile product usage at the one lifecycle boundary shared by
          // every execution path. This is idempotent with the manual-turn
          // admission path and covers task/HQ/runtime-created turns that never
          // pass through POST /v1/hyper-rooms/:id/turns.
          try {
            const metering = await meterHyperAgentTurn(body.turn_id);
            if (!metering.metered) console.warn('[hyper-meter] turn not metered', body.turn_id, metering.reason);
          } catch (meterError) {
            console.warn('[hyper-meter] reconciliation failed:', body.turn_id, meterError.message);
          }
          // METER the turn's LLM token cost against the org's plan. HyperAgents was a billing dead-end
          // (cost_tokens stored on hyperTurn but never billed). Resolve org from the turn's room → record.
          try {
            const _ct = Number(body.event.cost_tokens || 0);
            if (_ct > 0) {
              const _t = await prisma.hyperTurn.findUnique({ where: { id: body.turn_id }, select: { roomId: true } });
              const _r = _t && await prisma.hyperRoom.findUnique({ where: { id: _t.roomId }, select: { orgId: true } });
              // TODO: per-key metering needs its own principal plumbing — the agent bearer that reaches this
              // endpoint does not carry an apiKeyId in scope here; wire when control-plane auth thread exposes it.
              if (_r?.orgId) { const { UsageTracker } = await import('./billing/usage-tracker.js'); await new UsageTracker(prisma).recordTokens(_r.orgId, _ct); }
            }
          } catch { /* never break the seal on a metering error */ }
          // ── Task lifecycle: a sealed COMPLETE turn in a task room marks the
          // dashboard task done + files its deliverable into the company state
          // (documents list). Best-effort — never breaks the seal path.
          try {
            if ((body.event.status || 'complete') === 'complete') {
              const _t2 = await prisma.hyperTurn.findUnique({ where: { id: body.turn_id }, select: { roomId: true } });
              if (_t2?.roomId) {
                const hqRows = await prisma.$queryRawUnsafe(
                  `SELECT hq.id, hq."agent_connectors"->'_company' AS company
                     FROM "hivemind"."hyper_rooms" hq
                    WHERE hq."agent_connectors" ? '_company' AND hq.archived_at IS NULL
                      AND hq.org_id = (SELECT org_id FROM "hivemind"."hyper_rooms" WHERE id = $1::uuid)
                    ORDER BY hq.created_at DESC LIMIT 1`,
                  _t2.roomId,
                );
                const hq = hqRows?.[0];
                const companyState = hq?.company ? (typeof hq.company === 'string' ? JSON.parse(hq.company) : hq.company) : null;
                const doneTask = companyState?.tasks?.find((x) => x.room_id === _t2.roomId);
                if (hq && doneTask && doneTask.status !== 'done') {
                  doneTask.status = 'done';
                  doneTask.done_at = new Date().toISOString();
                  companyState.deliverables = Array.isArray(companyState.deliverables) ? companyState.deliverables : [];
                  if (!companyState.deliverables.some((d) => d.room_id === _t2.roomId)) {
                    companyState.deliverables.push({
                      title: doneTask.title, room_id: _t2.roomId,
                      sealed_at: doneTask.done_at, tokens: Number(body.event.cost_tokens || 0),
                    });
                  }
                  await prisma.$executeRawUnsafe(
                    'UPDATE "hivemind"."hyper_rooms" SET "agent_connectors" = "agent_connectors" || $1::jsonb WHERE "id" = $2::uuid',
                    JSON.stringify({ _company: companyState }), hq.id,
                  );
                }
              }
            }
          } catch (e) { console.warn('[hyper-task-done] hook failed:', e.message); }

          // ── HQ control-room feed: any NON-HQ room run that seals posts a
          // templated agent-voice report into the org's HQ room, so HQ becomes a
          // live overview of all company activity. Best-effort; never breaks seal.
          try {
            await recordHqActivity(prisma, body.turn_id, body.event);
          } catch (e) { console.warn('[hq-activity] hook failed:', e.message); }

          // A Day-1 Workflow may already be waiting for this seal. Workflows
          // buffers early events, so this is safe even when the room finishes
          // before the instance reaches waitForEvent. Delivery remains gated
          // by the persisted sealed turn inside deliverDayOneFirstMove.
          void notifyDayOneWorkflowCompletion({
            prisma,
            turnId: body.turn_id,
            status: body.event.status || 'complete',
          }).then((result) => {
            if (!result.ok && !result.skipped) console.warn('[day1] completion event failed:', result.reason);
          }).catch((error) => console.warn('[day1] completion event failed:', error.message));
        }

        // ── CSI artifact persistence (best-effort, must never delay/break the append path) ──
        try {
          const _isUuid = (s) => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
          const ev = body.event;
          const turn_id = body.turn_id;

          // Resolve roomId + orgId from the turn row
          const _turn = await prisma.hyperTurn.findUnique({ where: { id: turn_id }, select: { roomId: true } });
          if (_turn && prisma) {
            const _room = await prisma.hyperRoom.findUnique({ where: { id: _turn.roomId }, select: { orgId: true } });
            if (_room) {
              const roomId = _turn.roomId;
              const orgId = _room.orgId;
              const round = ev.round || 0;

              // Stable refId for events that lack an id field
              const _stableRef = `${turn_id}:${ev.t}:${ev.agent || ev.reviewer || ev.voter || 'x'}:${round}`;

              if (ev.t === 'hypothesis' && ev.content) {
                const refId = ev.id || _stableRef;
                await prisma.hyperClaim.create({
                  data: { refId, turnId: turn_id, roomId, orgId, agentSlug: ev.agent, lane: ev.lane, kind: 'hypothesis', text: ev.content, confidence: ev.confidence ?? null, round, evidenceMemoryIds: (ev.evidence_memory_ids || []).filter(_isUuid) },
                });
                for (const memId of (ev.evidence_memory_ids || []).filter(_isUuid)) {
                  await prisma.hyperRelation.create({ data: { turnId: turn_id, roomId, orgId, relationType: 'derived_from', fromRef: refId, toRef: memId } }).catch(() => {});
                }
              } else if (ev.t === 'chain_of_thought' && (ev.refined_hypothesis || '')) {
                const refId = ev.id || _stableRef;
                await prisma.hyperClaim.create({
                  data: { refId, turnId: turn_id, roomId, orgId, agentSlug: ev.agent, lane: ev.lane, kind: 'refined', text: ev.refined_hypothesis || '', confidence: ev.confidence ?? null, round, evidenceMemoryIds: (ev.evidence_memory_ids || []).filter(_isUuid) },
                });
                for (const memId of (ev.evidence_memory_ids || []).filter(_isUuid)) {
                  await prisma.hyperRelation.create({ data: { turnId: turn_id, roomId, orgId, relationType: 'derived_from', fromRef: refId, toRef: memId } }).catch(() => {});
                }
              } else if (ev.t === 'line' && (ev.kind === 'lead' || ev.kind === 'synthesis') && ev.content) {
                await prisma.hyperClaim.create({
                  data: { refId: _stableRef, turnId: turn_id, roomId, orgId, agentSlug: ev.agent, kind: ev.kind, text: ev.content || '', round },
                });
              } else if (ev.t === 'peer_review') {
                await prisma.hyperTrial.create({
                  data: { turnId: turn_id, roomId, orgId, trialKind: 'peer_review', reviewerSlug: ev.reviewer ?? null, targetRef: ev.target_hypothesis_id ?? null, verdict: ev.agreement ?? null, content: ev.content ?? null, round },
                });
                if (ev.reviewer && ev.target_hypothesis_id) {
                  await prisma.hyperRelation.create({ data: { turnId: turn_id, roomId, orgId, relationType: ev.agreement || 'review', fromRef: ev.reviewer, toRef: ev.target_hypothesis_id } }).catch(() => {});
                }
              } else if (ev.t === 'react') {
                await prisma.hyperTrial.create({
                  data: { turnId: turn_id, roomId, orgId, trialKind: 'react', reviewerSlug: ev.agent ?? null, verdict: ev.agreement ?? null, confidence: ev.confidence ?? null, content: ev.content ?? null, round },
                });
              } else if (ev.t === 'vote') {
                await prisma.hyperTrial.create({
                  data: { turnId: turn_id, roomId, orgId, trialKind: 'vote', reviewerSlug: ev.voter ?? null, targetRef: ev.vote_for_hypothesis_id ?? null, verdict: ev.score != null ? `score:${ev.score}` : null, content: ev.content ?? null, round },
                });
                if (ev.voter && ev.vote_for_hypothesis_id && ev.vote_for_hypothesis_id !== 'none') {
                  await prisma.hyperRelation.create({ data: { turnId: turn_id, roomId, orgId, relationType: 'votes_for', fromRef: ev.voter, toRef: ev.vote_for_hypothesis_id } }).catch(() => {});
                }
              } else if (ev.t === 'validate') {
                await prisma.hyperTrial.create({
                  data: { turnId: turn_id, roomId, orgId, trialKind: 'validate', reviewerSlug: ev.agent ?? null, verdict: ev.verdict ?? null, content: ev.content ?? null, round },
                });
              } else if (ev.t === 'skeptic_challenge') {
                await prisma.hyperTrial.create({
                  data: { turnId: turn_id, roomId, orgId, trialKind: 'skeptic', reviewerSlug: ev.agent ?? null, content: JSON.stringify({ challenges: ev.challenges, alternatives: ev.unorthodox_alternatives, assumptions: ev.hidden_assumptions }).slice(0, 4000), round },
                });
              }
            }
          }
        } catch (_artifactErr) {
          logger.warn({ err: _artifactErr.message, turn_id: body.turn_id }, '[hyper-rooms] artifact persist failed (best-effort)');
        }

        return jsonResponse(res, routeResult?.response || { ok: true });
      } catch (err) {
        console.warn('[hyper-rooms] turn-event append failed:', err.message);
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // GET /v1/hyper-rooms/:roomId/artifacts — CSI artifact read
    const artifactsMatch = pathname.match(/^\/v1\/hyper-rooms\/([0-9a-f-]{36})\/artifacts$/);
    if (artifactsMatch && req.method === 'GET') {
      const current = await requireSession(req, res);
      if (!current) return;
      const roomId = artifactsMatch[1];
      const room = await prisma.hyperRoom.findFirst({
        where: { id: roomId, userId: current.session.userId, orgId: current.session.orgId, archivedAt: null },
      });
      if (!room) return jsonResponse(res, { error: 'Room not found' }, 404);
      const qp = new URL(req.url, 'http://x').searchParams;
      const type = qp.get('type') || 'all';
      const limitRaw = parseInt(qp.get('limit') || '200', 10);
      const limit = Math.min(isNaN(limitRaw) ? 200 : limitRaw, 500);
      const orderAsc = { orderBy: { createdAt: 'asc' } };
      const result = { claims: [], trials: [], relations: [] };
      if (type === 'all' || type === 'claim') {
        result.claims = await prisma.hyperClaim.findMany({ where: { roomId }, take: limit, ...orderAsc });
      }
      if (type === 'all' || type === 'trial') {
        result.trials = await prisma.hyperTrial.findMany({ where: { roomId }, take: limit, ...orderAsc });
      }
      if (type === 'all' || type === 'relation') {
        result.relations = await prisma.hyperRelation.findMany({ where: { roomId }, take: limit, ...orderAsc });
      }
      return jsonResponse(res, result);
    }

    // Generated HyperRoom artifacts are tenant-scoped SourceArtifacts. HTML is
    // served with a restrictive CSP and rendered by the frontend in a sandboxed
    // iframe; previews are immutable browser-validation receipts.
    const hyperArtifactMatch = pathname.match(/^\/v1\/hyper-artifacts\/([0-9a-f-]{36})(?:\/(preview))?$/);
    if (hyperArtifactMatch && req.method === 'GET') {
      const current = await requireSession(req, res);
      if (!current) return;
      const artifact = await readHyperArtifact({
        prisma,
        artifactId: hyperArtifactMatch[1],
        orgId: current.session.orgId,
      });
      if (!artifact) return jsonResponse(res, { error: 'Artifact not found' }, 404);
      const payload = artifact.payload && typeof artifact.payload === 'object' ? artifact.payload : {};
      if (hyperArtifactMatch[2] === 'preview') {
        const viewport = url.searchParams.get('viewport') === 'mobile' ? 'mobile' : 'desktop';
        const encoded = payload.previews?.[viewport];
        if (!encoded) return jsonResponse(res, { error: 'Artifact preview unavailable' }, 404);
        const image = Buffer.from(String(encoded), 'base64');
        res.writeHead(200, {
          'Content-Type': 'image/jpeg',
          'Content-Length': image.length,
          'Cache-Control': 'private, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(image);
        return;
      }
      const html = String(payload.html || '');
      if (!html) return jsonResponse(res, { error: 'Artifact content unavailable' }, 404);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(html),
        'Cache-Control': 'private, max-age=31536000, immutable',
        'Content-Security-Policy': "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'",
        'Cross-Origin-Resource-Policy': 'same-origin',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'SAMEORIGIN',
        'Referrer-Policy': 'no-referrer',
      });
      res.end(html);
      return;
    }
  }
  // ─── End Hyper Agents Rooms ───────────────────────────────

  // ─── Referral campaigns and redemption ────────────────────
  // Preview is session-authenticated so campaigns are not an anonymous code
  // oracle. Redemption is once per organization and snapshots its terms.
  if (pathname === '/v1/referrals/preview' && req.method === 'GET') {
    const current = await requireSession(req, res);
    if (!current) return;
    if (promotionAttemptLimited(req)) return jsonResponse(res, { valid: false }, 429);
    const code = normalizeReferralCode(url.searchParams.get('code'));
    const user = await prisma?.user.findUnique({ where: { id: current.session.userId }, select: { email: true } }).catch(() => null);
    const promotion = code ? await findPromotionForCode({ prisma, code, email: user?.email, orgId: current.session.orgId }).catch(() => null) : null;
    if (promotion) {
      recordPromotionAttempt(req, true);
      const offer = promotion.version;
      return jsonResponse(res, { valid: true, promotion: {
        name: promotion.promotion.internalName, code_hint: promotion.promotion.codeHint,
        base_plan: offer.basePlan, limits: offer.limits, account_type: offer.accountType,
        storage_mode: offer.storageMode, ends_at: promotion.promotion.endsAt,
      } });
    }
    const campaign = code ? await prisma?.referralCampaign.findUnique({ where: { code } }).catch(() => null) : null;
    const now = new Date();
    const valid = Boolean(campaign?.active && (!campaign.startsAt || campaign.startsAt <= now) && (!campaign.endsAt || campaign.endsAt > now)
      && (campaign.maxRedemptions == null || campaign.redemptionCount < campaign.maxRedemptions));
    if (!valid) { recordPromotionAttempt(req, false); return jsonResponse(res, { valid: false }, 404); }
    recordPromotionAttempt(req, true);
    return jsonResponse(res, {
      valid: true,
      campaign: {
        code: campaign.code, name: campaign.name, onboarding_days: campaign.onboardingDays,
        onboarding_plan: campaign.onboardingPlan, onboarding_limits: campaign.onboardingLimits,
        runway_plan: campaign.runwayPlan, runway_limits: campaign.runwayLimits,
      },
    });
  }

  if (pathname === '/v1/referrals/redeem' && req.method === 'POST') {
    const current = await requireSession(req, res);
    if (!current) return;
    const membership = await getOrgMembership(current.session.userId, current.session.orgId);
    if (!membership || !effectiveRoles(membership).includes('org_owner')) return jsonResponse(res, { error: 'organization owner required' }, 403);
    if (promotionAttemptLimited(req)) return jsonResponse(res, { error: 'promotion unavailable' }, 429);
    const body = await parseBody(req).catch(() => ({}));
    try {
      const user = await prisma.user.findUnique({ where: { id: current.session.userId }, select: { email: true } });
      const promotion = await redeemPromotion({ prisma, orgId: current.session.orgId, userId: current.session.userId, email: user?.email || '', code: body.code, requestId: req.headers['x-request-id'] || null });
      await audit({ organizationId: current.session.orgId, userId: current.session.userId, eventType: 'commercial.promotion_redeemed', eventCategory: 'billing', action: 'create',
        resourceType: 'promotion_redemption', resourceId: promotion.redemption.id, metadata: { promotion_id: promotion.promotion.id }, ..._reqMeta(req) });
      recordPromotionAttempt(req, true);
      return jsonResponse(res, { ok: true, promotion: promotion.termsSnapshot });
    } catch (promotionError) {
      // Existing codes remain redeemable during migration. Do not disclose
      // whether a new promotion failed eligibility versus did not exist.
      try {
      const result = await redeemReferral({ prisma, orgId: current.session.orgId, userId: current.session.userId, code: body.code });
      recordPromotionAttempt(req, true);
      return jsonResponse(res, { ok: true, referral: { code: result.terms.code, phase: 'onboarding', runway_starts_at: result.runwayStartsAt.toISOString(), terms: result.terms } });
      } catch {
        recordPromotionAttempt(req, false);
        return jsonResponse(res, { error: 'promotion unavailable' }, 409);
      }
    }
  }

  // Legacy adapter: existing scripts keep their path, but all new records are
  // created through PromotionService rather than a second campaign model.
  if (pathname === '/v1/admin/referrals' && (req.method === 'GET' || req.method === 'POST')) {
    if (!isAdminAuthorized(req, url)) return jsonResponse(res, { error: 'admin authorization required' }, 403);
    if (req.method === 'GET') {
      const campaigns = await listPromotions(prisma);
      return jsonResponse(res, { campaigns });
    }
    const body = await parseBody(req).catch(() => ({}));
    const onboardingPlan = String(body.onboarding_plan || 'enterprise').toLowerCase();
    const runwayPlan = String(body.runway_plan || 'enterprise').toLowerCase();
    if (!body.code || !body.name || !PLANS[onboardingPlan] || !PLANS[runwayPlan]) {
      return jsonResponse(res, { error: 'code, name, and valid onboarding/runway plans are required' }, 400);
    }
    try {
      const created = await createPromotion({ prisma, input: {
        internal_name: body.name, code: body.code, base_plan: onboardingPlan, limits: body.onboarding_limits,
        account_type: onboardingPlan === 'enterprise' ? 'enterprise_managed' : 'personal',
        billing_mode: 'entitlement_only', commercial_terms: { kind: 'trial', trial_days: Number(body.onboarding_days || 14) },
        max_redemptions: body.max_redemptions, starts_at: body.starts_at, ends_at: body.ends_at,
        fallback_action: ['free', 'pro', 'scale'].includes(runwayPlan) ? runwayPlan : 'manual_review',
      } });
      return jsonResponse(res, { campaign: created.promotion, code: created.plaintextCode }, 201);
    } catch (error) {
      return jsonResponse(res, { error: error.message }, 400);
    }
  }

  // ─── Billing (Stripe-backed) ──────────────────────────────
  // GET  /v1/billing/plan         — current plan + usage + limits
  // POST /v1/billing/checkout     — create Stripe Checkout session
  // POST /v1/billing/portal       — create Stripe Customer Portal session
  // GET  /v1/billing/invoices     — list recent invoices
  // GET  /v1/billing/invoices.csv — CSV export of recent invoices
  if (pathname.startsWith('/v1/billing') && (req.method === 'GET' || req.method === 'POST')) {
    const current = await requireSession(req, res);
    if (!current) return;
    const callerMem = await getOrgMembership(current.session.userId, current.session.orgId);
    if (!callerMem) return jsonResponse(res, { error: 'Organization membership not found' }, 404);
    // A plan/allowance summary is shared with active members. Invoices and
    // every commercial action remain manager-only even though they are GETs.
    const commercialRead = pathname === '/v1/billing/invoices' || pathname === '/v1/billing/invoices.csv';
    const action = (req.method === 'GET' && !commercialRead) ? 'read' : 'manage';
    if (!prisma) return jsonResponse(res, { error: 'Database unavailable' }, 503);

    let billingAccess;
    try {
      billingAccess = await resolveTenantAccess(prisma, {
        orgId: current.session.orgId, userId: current.session.userId,
      }, { resource: 'billing', action });
    } catch {
      return jsonResponse(res, { error: 'Resource not found' }, 404);
    }

    const orgId = current.session.orgId;
    const userId = current.session.userId;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return jsonResponse(res, { error: 'Org not found' }, 404);

    const billingMod = await import('./billing/stripe.js');
    const plansMod = await import('./billing/plans.js');
    const catalogPlans = await listCatalogPlans(prisma);
    const { UsageTracker } = await import('./billing/usage-tracker.js');
    const usageTracker = new UsageTracker(prisma);

    // GET /v1/billing/plan
    if (pathname === '/v1/billing/plan' && req.method === 'GET') {
      const { plan, entitlement } = await getEffectivePlan(prisma, orgId);
      const { knowledgeBaseUploads: _uploadTelemetry, ...usage } = await usageTracker.getUsage(orgId);
      const { knowledgeBaseUploads: _cumulativeUploadTelemetry, ...cumulative } = await usageTracker.getCumulativeUsage(orgId);
      const limitCheck = await usageTracker.checkLimits(orgId, plan);
      const usageSummary = await planEnforcer.getUsageSummary(orgId);
      return jsonResponse(res, {
        plan: {
          id: plan.id,
          name: plan.name,
          price: plan.price,
          currency: plan.currency,
          limits: plan.limits,
          features: plan.features,
          support: plan.support,
          sla: plan.sla,
        },
        subscription: {
          status: org.subscriptionStatus || 'inactive',
          // Never expose payment-provider identifiers to ordinary members.
          ...(action === 'manage' ? {
            stripe_customer_id: org.stripeCustomerId || null,
            stripe_subscription_id: org.stripeSubscriptionId || null,
          } : {}),
          current_period_end: org.currentPeriodEnd?.toISOString() || null,
          trial_ends_at: org.trialEndsAt?.toISOString() || null,
        },
        entitlement: entitlement ? {
          source: entitlement.source, phase: entitlement.phase, effective_from: entitlement.effectiveFrom,
          effective_until: entitlement.effectiveUntil, status: entitlement.status || 'active',
          grant_id: entitlement.grantId || null, account_type: entitlement.accountType || org.accountType || null,
          hosting_mode: entitlement.hostingMode || org.hostingMode, storage_mode: entitlement.storageMode || org.memoryStorageMode,
        } : null,
        organization: {
          id: org.id,
          plan: org.plan,
          account_type: org.accountType || 'personal',
          hosting_mode: org.hostingMode,
          memory_storage_mode: org.memoryStorageMode,
        },
        can_manage_billing: billingAccess.canManageBilling,
        usage,
        usage_summary: usageSummary,
        cumulative_usage: cumulative,
        warnings: limitCheck.warnings || [],
        reminders: usageSummary.reminders || [],
        credit_contract: 'monthly-credit-ledger-v1',
        exceeded: limitCheck.exceeded || [],
        stripe_enabled: billingMod.isEnabled(),
        all_plans: catalogPlans.map(p => ({
          id: p.id,
          name: p.name,
          price: p.price,
          currency: p.currency,
          limits: p.limits,
          features: p.features,
          available_self_serve: Boolean(plansMod.getStripePriceId(p.id)),
        })),
      });
    }

    // POST /v1/billing/dummy/confirm — owner confirms an allow-listed test checkout.
    // Production never enables this globally; BILLING_DUMMY_ALLOWED_ORGS is mandatory.
    if (pathname === '/v1/billing/dummy/confirm' && req.method === 'POST') {
      if (!dummyCheckoutAllowed(orgId)) return jsonResponse(res, { error: 'Dummy checkout is not enabled for this organization' }, 403);
      const body = await parseBody(req).catch(() => ({}));
      const checkoutId = String(body.checkout_id || '').trim();
      if (!/^[0-9a-f-]{36}$/i.test(checkoutId)) return jsonResponse(res, { error: 'valid checkout_id required' }, 400);
      try {
        const result = await prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', `billing:checkout:${checkoutId}`);
          const checkout = await tx.billingCheckout.findUnique({ where: { id: checkoutId } });
          if (!checkout || checkout.orgId !== orgId || checkout.userId !== userId || checkout.provider !== 'dummy') {
            const error = new Error('Checkout not found'); error.status = 404; throw error;
          }
          if (checkout.status === 'confirmed') return { checkout, alreadyConfirmed: true };
          if (checkout.status !== 'pending' || checkout.expiresAt <= new Date()) {
            await tx.billingCheckout.updateMany({ where: { id: checkout.id, status: 'pending' }, data: { status: 'expired' } });
            const error = new Error('Checkout expired'); error.status = 410; throw error;
          }
          const offer = checkout.offer || {};
          const activation = offer.kind === 'referral'
            ? await claimReferralOffer({ tx, orgId, userId, offer })
            : await activateOffer({ tx, orgId, offer, source: 'dummy_checkout' });
          if (offer.kind === 'runway') await activateEnterpriseRunway({ tx, orgId, offer });
          const confirmed = await tx.billingCheckout.update({
            where: { id: checkout.id },
            data: { status: 'confirmed', confirmedAt: new Date() },
          });
          return { checkout: confirmed, activation, alreadyConfirmed: false };
        });
        audit({
          organizationId: orgId, userId,
          eventType: 'billing.dummy_checkout_confirmed', eventCategory: 'billing', action: 'update',
          resourceType: 'billing_checkout', resourceId: checkoutId,
          metadata: { plan: result.checkout.targetPlanId, already_confirmed: result.alreadyConfirmed }, ..._reqMeta(req),
        });
        if (!result.alreadyConfirmed) {
          provisionPaidManagedOrg(orgId, result.activation?.onboardingPlan || result.activation?.runwayPlan)
            .catch((error) => console.error('[managed-provision] post-checkout failed', { orgId, error: error.message }));
        }
        return jsonResponse(res, {
          success: true,
          already_confirmed: result.alreadyConfirmed,
          plan: result.checkout.targetPlanId,
          status: result.checkout.status,
        });
      } catch (error) {
        return jsonResponse(res, { error: error.message }, error.status || 409);
      }
    }

    // POST /v1/billing/checkout — { plan: "pro"|"scale", referral_code? }
    // POST /v1/billing/runway/quote — server-authoritative price for a scope config
    // (mode/data/seats/tokens). The FE estimator shows this; checkout re-computes it
    // so a client can never dictate the amount.
    if (pathname === '/v1/billing/runway/quote' && req.method === 'POST') {
      const body = await parseBody(req).catch(() => ({}));
      const quote = computeRunwayQuote(body);
      return jsonResponse(res, {
        mode: quote.mode, config: quote.config, currency: quote.currency,
        rows: quote.rows.map(([label, detail, amount]) => ({ label, detail, amount })),
        monthly_total: quote.monthlyTotal, setup_one_time: quote.setupOneTime,
      });
    }

    // POST /v1/billing/runway/checkout — self-serve runway subscription. The org
    // configures its scope; we price it HERE, charge the calculated amount via a
    // dynamic Stripe subscription, and (on webhook) activate a CUSTOM entitlement
    // matching the scope. This is the post-onboarding path for enterprise orgs.
    if (pathname === '/v1/billing/runway/checkout' && req.method === 'POST') {
      // This configuration becomes the organization's paid commercial contract.
      // Members may inspect billing; only the owner can create it.
      if (!effectiveRoles(callerMem).includes('org_owner')) {
        return jsonResponse(res, { error: 'organization owner required' }, 403);
      }
      const body = await parseBody(req).catch(() => ({}));
      const quote = computeRunwayQuote(body);
      if (!(quote.monthlyTotal > 0)) return jsonResponse(res, { error: 'invalid scope configuration' }, 400);
      const offer = buildRunwayOffer(body, quote);
      const now = new Date();
      // Dummy path for allow-listed test orgs (no real charge) — mirrors /billing/checkout.
      if (!billingMod.isEnabled() || dummyCheckoutAllowed(orgId)) {
        if (!dummyCheckoutAllowed(orgId)) {
          return jsonResponse(res, { error: 'Payment provider is not configured for this organization' }, 503);
        }
        const checkout = await prisma.billingCheckout.create({
          data: { orgId, userId, provider: 'dummy', targetPlanId: 'enterprise', offer,
            expiresAt: new Date(now.getTime() + 30 * 60 * 1000) },
        });
        return jsonResponse(res, {
          checkout_url: `/hivemind/app/billing?dummy_checkout=${checkout.id}`,
          session_id: checkout.id, provider: 'dummy', offer,
          monthly_total: quote.monthlyTotal, setup_one_time: quote.setupOneTime,
        });
      }
      // Real Stripe: dynamic-price monthly subscription (+ one-time setup for self-hosted).
      const owner = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
      const customerId = await billingMod.ensureCustomer(prisma, org, owner?.email || null);
      if (!customerId) return jsonResponse(res, { error: 'Failed to create Stripe customer' }, 502);
      // Persist the offer BEFORE Stripe so the webhook can activate it by session id.
      const checkout = await prisma.billingCheckout.create({
        data: { orgId, userId, provider: 'stripe', targetPlanId: 'enterprise', offer,
          expiresAt: new Date(now.getTime() + 60 * 60 * 1000) },
      });
      try {
        const session = await billingMod.createRunwayCheckoutSession({
          customerId, orgId, userId, quote,
          checkoutId: checkout.id,
        });
        await prisma.billingCheckout.update({ where: { id: checkout.id }, data: { providerRef: session.id } }).catch(() => {});
        audit({
          organizationId: orgId, userId,
          eventType: 'billing.runway_checkout_started', eventCategory: 'billing', action: 'create',
          resourceType: 'subscription', resourceId: session.id,
          metadata: { monthly_total: quote.monthlyTotal, mode: quote.mode }, ..._reqMeta(req),
        });
        return jsonResponse(res, { checkout_url: session.url, session_id: session.id, monthly_total: quote.monthlyTotal });
      } catch (err) {
        console.error(`[billing/runway] Stripe checkout failed org=${orgId}: ${err?.message}`, err?.type || '', err?.param || '');
        await prisma.billingCheckout.updateMany({ where: { id: checkout.id, status: 'pending' }, data: { status: 'expired' } }).catch(() => {});
        return jsonResponse(res, { error: `Stripe checkout failed: ${err.message}` }, 502);
      }
    }

    if (pathname === '/v1/billing/checkout' && req.method === 'POST') {
      const body = await parseBody(req).catch(() => ({}));
      const targetPlanId = String(body.plan || '').trim();
      const targetPlan = plansMod.PLANS[targetPlanId];
      if (!targetPlan || targetPlanId === 'free') return jsonResponse(res, { error: 'invalid checkout plan' }, 400);
      const referralCode = normalizeReferralCode(body.referral_code);
      const checkoutUser = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } }).catch(() => null);
      const attachedGrant = !referralCode
        ? await prisma.entitlementGrant.findFirst({ where: { orgId, promotionId: { not: null }, source: 'promotion' }, orderBy: { createdAt: 'desc' } }).catch(() => null)
        : null;
      const attachedRedemption = attachedGrant?.promotionId
        ? await prisma.promotionRedemption.findFirst({ where: { orgId, promotionId: attachedGrant.promotionId }, orderBy: { redeemedAt: 'desc' } }).catch(() => null)
        : null;
      const [attachedPromotion, attachedVersion] = attachedRedemption
        ? await Promise.all([
          prisma.promotion.findUnique({ where: { id: attachedRedemption.promotionId } }),
          prisma.promotionVersion.findUnique({ where: { id: attachedRedemption.promotionVersionId } }),
        ])
        : [null, null];
      // A partner URL is intentionally code-free for the recipient. Once it
      // has been redeemed, recover its server-managed Stripe discount from the
      // immutable entitlement grant instead of asking the user to re-enter a
      // promotion code at checkout.
      const resolvedCheckoutPromotion = referralCode
        ? await findPromotionForCode({ prisma, code: referralCode, email: checkoutUser?.email || '', orgId }).catch(() => null)
        : attachedPromotion && attachedVersion ? { promotion: attachedPromotion, version: attachedVersion } : null;
      const checkoutPromotion = referralCode || resolvedCheckoutPromotion?.promotion.billingMode === 'stripe_discount'
        ? resolvedCheckoutPromotion : null;
      if (checkoutPromotion) {
        if (checkoutPromotion.version.basePlan !== targetPlanId) {
          return jsonResponse(res, { error: 'This offer applies to a different plan' }, 409);
        }
        if (checkoutPromotion.promotion.billingMode === 'contract') {
          return jsonResponse(res, { error: 'This offer is managed by your Singulance commercial contact' }, 409);
        }
      }

      if (!billingMod.isEnabled()) {
        if (!dummyCheckoutAllowed(orgId)) {
          return jsonResponse(res, { error: 'Payment provider is not configured for this organization' }, 503);
        }
        const now = new Date();
        let offer = buildStandardOffer(targetPlanId, now);
        // Entitlement-only promotions are redeemed through the owner-safe
        // redemption operation. The dummy checkout keeps legacy referrals for
        // local payment testing, but does not fabricate a paid Stripe discount.
        if (referralCode) {
          if (checkoutPromotion) {
            return jsonResponse(res, { error: 'Redeem this promotion from Billing before checkout' }, 409);
          }
          const campaign = await prisma.referralCampaign.findUnique({ where: { code: referralCode } });
          if (!campaign || !campaign.active || (campaign.startsAt && campaign.startsAt > now)
            || (campaign.endsAt && campaign.endsAt <= now)) {
            return jsonResponse(res, { error: 'invalid or inactive referral code' }, 400);
          }
          offer = buildReferralOffer(campaign, now);
        } else if (targetPlan.commercial?.selfServe !== true) {
          return jsonResponse(res, { error: 'This plan requires a custom offer or referral code' }, 400);
        }
        const checkout = await prisma.billingCheckout.create({
          data: {
            orgId, userId, provider: 'dummy', targetPlanId,
            offer, expiresAt: new Date(now.getTime() + 30 * 60 * 1000),
          },
        });
        audit({
          organizationId: orgId, userId,
          eventType: 'billing.checkout_started', eventCategory: 'billing', action: 'create',
          resourceType: 'billing_checkout', resourceId: checkout.id,
          metadata: { plan: targetPlanId, provider: 'dummy', referral: Boolean(referralCode) }, ..._reqMeta(req),
        });
        return jsonResponse(res, {
          checkout_url: `/hivemind/app/billing?dummy_checkout=${checkout.id}`,
          session_id: checkout.id,
          provider: 'dummy',
          offer,
          expires_at: checkout.expiresAt,
        });
      }
      const priceId = plansMod.getStripePriceId(targetPlanId);
      if (!priceId) {
        return jsonResponse(res, { error: `Plan "${targetPlanId}" is not available for self-serve checkout` }, 400);
      }

      // Lookup the org owner's email so Stripe Customer has something useful.
      const owner = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
      const customerId = await billingMod.ensureCustomer(prisma, org, owner?.email || null);
      if (!customerId) {
        return jsonResponse(res, { error: 'Failed to create Stripe customer' }, 502);
      }

      try {
        const stripePromotionCodeId = checkoutPromotion?.promotion.billingMode === 'stripe_discount'
          ? checkoutPromotion.version.commercialTerms?.stripe_promotion_code_id
          : null;
        if (checkoutPromotion?.promotion.billingMode === 'stripe_discount' && !stripePromotionCodeId) {
          return jsonResponse(res, { error: 'This promotion is not ready for checkout' }, 409);
        }
        const session = await billingMod.createCheckoutSession({
          customerId,
          priceId,
          orgId,
          userId,
          promotionCodeId: stripePromotionCodeId,
          promotionId: checkoutPromotion?.promotion.id || null,
          promotionVersionId: checkoutPromotion?.version.id || null,
        });
        audit({
          organizationId: orgId, userId,
          eventType: 'billing.checkout_started', eventCategory: 'billing', action: 'create',
          resourceType: 'subscription', resourceId: session.id,
          metadata: { plan: targetPlanId, price_id: priceId, promotion_id: checkoutPromotion?.promotion.id || null }, ..._reqMeta(req),
        });
        return jsonResponse(res, { checkout_url: session.url, session_id: session.id });
      } catch (err) {
        return jsonResponse(res, { error: `Stripe checkout failed: ${err.message}` }, 502);
      }
    }

    // POST /v1/billing/reconcile — recover authoritative Stripe state after Checkout.
    if (pathname === '/v1/billing/reconcile' && req.method === 'POST') {
      if (!billingMod.isEnabled()) {
        return jsonResponse(res, { error: 'Stripe not configured on this deployment' }, 503);
      }
      if (plansMod.PLANS[org.plan]?.commercial?.audience === 'enterprise') {
        return jsonResponse(res, { error: 'Enterprise billing is managed outside self-serve checkout' }, 409);
      }
      if (!org.stripeCustomerId) {
        return jsonResponse(res, { reconciled: false, reason: 'no_customer' }, 412);
      }
      try {
        const stripe = await billingMod.getStripe();
        const subscriptions = await stripe.subscriptions.list({
          customer: org.stripeCustomerId,
          status: 'all',
          limit: 10,
        });
        const subscription = subscriptions.data.find((item) => (
          billingMod.isEntitledSubscriptionStatus(item.status)
          && (!item.metadata?.hivemind_org_id || item.metadata.hivemind_org_id === orgId)
        ));
        const updated = await syncPersonalStripeSubscription({ org, subscription, plansMod });
        if (!updated) {
          return jsonResponse(res, { reconciled: false, reason: 'no_active_personal_subscription' }, 409);
        }
        return jsonResponse(res, {
          reconciled: true,
          plan: updated.plan,
          subscription_status: updated.subscriptionStatus,
        });
      } catch (err) {
        console.error('[billing] Stripe reconciliation failed:', err.message);
        return jsonResponse(res, { error: 'Stripe reconciliation failed' }, 502);
      }
    }

    // POST /v1/billing/portal — opens Stripe Customer Portal
    if (pathname === '/v1/billing/portal' && req.method === 'POST') {
      if (!billingMod.isEnabled()) {
        return jsonResponse(res, { error: 'Stripe not configured on this deployment' }, 503);
      }
      if (!org.stripeCustomerId) {
        return jsonResponse(res, { error: 'No Stripe customer for this org yet — start a checkout first' }, 412);
      }
      try {
        const session = await billingMod.createPortalSession({ customerId: org.stripeCustomerId });
        return jsonResponse(res, { portal_url: session.url });
      } catch (err) {
        return jsonResponse(res, { error: `Stripe portal failed: ${err.message}` }, 502);
      }
    }

    // GET /v1/billing/invoices
    if (pathname === '/v1/billing/invoices' && req.method === 'GET') {
      if (!org.stripeCustomerId) return jsonResponse(res, { invoices: [] });
      try {
        const invoices = await billingMod.listInvoices({ customerId: org.stripeCustomerId });
        return jsonResponse(res, { invoices });
      } catch (err) {
        return jsonResponse(res, { error: err.message, invoices: [] }, 502);
      }
    }

    // GET /v1/billing/invoices.csv — same shape, CSV body
    if (pathname === '/v1/billing/invoices.csv' && req.method === 'GET') {
      if (!org.stripeCustomerId) {
        res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="invoices.csv"' });
        return res.end('invoice_number,status,amount_paid,currency,period_start,period_end,created\n');
      }
      try {
        const invoices = await billingMod.listInvoices({ customerId: org.stripeCustomerId, limit: 100 });
        const header = 'invoice_number,status,amount_paid,currency,period_start,period_end,created,hosted_invoice_url\n';
        const rows = invoices.map(i => [
          i.number || i.id,
          i.status,
          (i.amount_paid / 100).toFixed(2),
          i.currency,
          i.period_start || '',
          i.period_end || '',
          i.created,
          i.hosted_invoice_url || '',
        ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
        res.writeHead(200, {
          'Content-Type': 'text/csv',
          'Content-Disposition': 'attachment; filename="invoices.csv"',
        });
        return res.end(header + rows + (rows ? '\n' : ''));
      } catch (err) {
        return jsonResponse(res, { error: err.message }, 502);
      }
    }

    return jsonResponse(res, { error: `Unknown billing route: ${pathname}` }, 404);
  }
  // ─── End Billing ──────────────────────────────────────────

  // ─── Stripe webhook ───────────────────────────────────────
  // POST /v1/webhooks/stripe — public endpoint, signature-verified.
  // Idempotent: every successfully processed event_id is recorded in
  // hivemind.stripe_events; replays no-op.
  if (pathname === '/v1/webhooks/stripe' && req.method === 'POST') {
    const billingMod = await import('./billing/stripe.js');
    const plansMod = await import('./billing/plans.js');
    if (!billingMod.isEnabled()) {
      return jsonResponse(res, { error: 'Stripe not configured' }, 503);
    }
    const sig = req.headers['stripe-signature'] || '';
    const { raw } = await parseBodyWithRaw(req);
    let event;
    try {
      event = await billingMod.constructEvent({ rawBody: raw, signature: sig });
    } catch (err) {
      // SELF-DIAGNOSING FAILURE. "No signatures found matching the expected signature" has three
      // very different causes and the bare message distinguishes none of them, so every occurrence
      // used to require a from-scratch investigation:
      //   (a) the raw body never arrived (something upstream consumed the stream) -> len === 0
      //   (b) the header is missing or malformed                                  -> no t=/v1=
      //   (c) the configured whsec_ belongs to a DIFFERENT Stripe endpoint        -> body+header fine
      // (c) is the common one — every Stripe endpoint (dashboard endpoint, `stripe listen`, a second
      // environment) has its own signing secret, and they are indistinguishable at a glance.
      // Emit the facts that separate them. NEVER log the secret or the body: only a length, the
      // header's own timestamp skew, and a short fingerprint of the secret so two deployments can be
      // compared without either being disclosed.
      const _len = Buffer.isBuffer(raw) ? raw.length : -1;
      const _t = /(^|,)t=(\d+)/.exec(String(sig || ''));
      const _skewSec = _t ? Math.abs(Math.floor(Date.now() / 1000) - Number(_t[2])) : null;
      let _fp = 'none';
      try {
        const _sec = process.env.STRIPE_WEBHOOK_SECRET || '';
        if (_sec) _fp = (await import('crypto')).createHash('sha256').update(_sec).digest('hex').slice(0, 8);
      } catch { /* fingerprint is best-effort */ }
      const _cause = _len === 0 ? 'BODY EMPTY — the request stream was consumed before this handler'
        : !/(^|,)v1=/.test(String(sig || '')) ? 'HEADER MALFORMED — no v1= scheme in stripe-signature'
        : (_skewSec != null && _skewSec > 300) ? `TIMESTAMP SKEW ${_skewSec}s — replay or clock drift`
        : 'SECRET MISMATCH — body and header look valid, so STRIPE_WEBHOOK_SECRET is very likely from a different Stripe endpoint';
      console.warn(`[stripe-webhook] signature verification failed: ${err.message}`);
      console.warn(`[stripe-webhook] diagnosis: ${_cause} `
        + `(raw_bytes=${_len} sig_header=${sig ? 'present' : 'MISSING'} `
        + `skew_s=${_skewSec ?? 'n/a'} secret_fp=${_fp} livemode_key=${String(process.env.STRIPE_SECRET_KEY || '').startsWith('sk_live') ? 'yes' : 'no'})`);
      return jsonResponse(res, { error: 'invalid signature' }, 400);
    }
    if (!prisma) return jsonResponse(res, { error: 'Database unavailable' }, 503);

    // Idempotency check.
    try {
      const existing = await prisma.$queryRawUnsafe(
        `SELECT 1 FROM hivemind.stripe_events WHERE event_id = $1 LIMIT 1`,
        event.id,
      );
      if (Array.isArray(existing) && existing.length > 0) {
        return jsonResponse(res, { ok: true, replay: true });
      }
    } catch (err) {
      console.warn('[stripe-webhook] idempotency check failed:', err.message);
    }

    // Resolve org via metadata.hivemind_org_id, fall back to customer.id.
    const obj = event.data?.object || {};
    const metaOrgId = obj.metadata?.hivemind_org_id
      || obj.subscription_details?.metadata?.hivemind_org_id
      || null;
    const customerId = obj.customer || (typeof obj === 'object' && obj.id?.startsWith?.('cus_') ? obj.id : null);
    let org = null;
    if (metaOrgId) {
      org = await prisma.organization.findUnique({ where: { id: metaOrgId } }).catch(() => null);
    }
    if (!org && customerId) {
      org = await billingMod.findOrgByCustomerId(prisma, customerId);
    }

    try {
      switch (event.type) {
        case 'checkout.session.completed': {
          // Initial subscription created — Stripe sends customer.subscription.created
          // separately so we mostly just persist the customer_id here.
          if (org && customerId && !org.stripeCustomerId) {
            await prisma.organization.update({
              where: { id: org.id },
              data: { stripeCustomerId: customerId },
            });
          }
          // Runway self-serve: activate the CUSTOM entitlement stored on the checkout
          // row (scope-configured limits) instead of the fixed-plan sync. Keyed by the
          // Stripe session id we saved as providerRef. Idempotent via advisory lock +
          // status check. The dynamic runway price is unmapped, so the fixed-plan sync
          // below no-ops for it anyway — this branch is what grants access.
          if (org && obj.payment_status === 'paid'
              && (obj.metadata?.kind === 'runway' || obj.id)) {
            const pending = await prisma.billingCheckout.findUnique({ where: { providerRef: obj.id } }).catch(() => null);
            if (pending && pending.orgId === org.id && pending.offer?.kind === 'runway') {
              try {
                const activated = await prisma.$transaction(async (tx) => {
                  await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', `billing:checkout:${pending.id}`);
                  const fresh = await tx.billingCheckout.findUnique({ where: { id: pending.id } });
                  if (fresh?.status !== 'pending') return false;
                  await activateOffer({ tx, orgId: org.id, offer: pending.offer, source: 'stripe_runway' });
                  await activateEnterpriseRunway({ tx, orgId: org.id, offer: pending.offer });
                  await tx.billingCheckout.update({ where: { id: pending.id }, data: { status: 'confirmed', confirmedAt: new Date() } });
                  return true;
                });
                if (activated) {
                  const invitation = await prisma.enterpriseInvitation.findFirst({ where: { orgId: org.id, status: 'redeemed' }, select: { id: true } }).catch(() => null);
                  if (invitation) await audit({ organizationId: org.id, eventType: 'commercial.enterprise_onboarding_to_runway', eventCategory: 'billing', action: 'update', resourceType: 'enterprise_invitation', resourceId: invitation.id,
                    metadata: { checkout_id: pending.id, provider: 'stripe' }, actorType: 'system' });
                }
                provisionPaidManagedOrg(org.id, 'enterprise')
                  .catch((e) => console.error('[managed-provision] runway post-checkout failed', { orgId: org.id, error: e.message }));
              } catch (e) { console.error('[runway] activation failed', { orgId: org.id, error: e.message }); }
              break; // handled — skip the fixed-plan sync
            }
          }
          if (org && obj.payment_status === 'paid') {
            const subscriptionId = billingMod.getSubscriptionIdFromStripeObject(obj);
            if (subscriptionId) {
              const stripe = await billingMod.getStripe();
              const subscription = await stripe.subscriptions.retrieve(subscriptionId);
              org = await syncPersonalStripeSubscription({ org, subscription, plansMod }) || org;
            }
          }
          break;
        }
        case 'customer.subscription.created':
        case 'customer.subscription.updated':
        case 'customer.subscription.resumed': {
          if (!org) break;
          const updated = await syncPersonalStripeSubscription({ org, subscription: obj, plansMod });
          if (updated) {
            org = updated;
            provisionPaidManagedOrg(org.id, org.plan)
              .catch((error) => console.error('[managed-provision] post-stripe failed', { orgId: org.id, error: error.message }));
          }
          break;
        }
        case 'customer.subscription.deleted':
        case 'customer.subscription.paused': {
          if (!org) break;
          await prisma.$transaction(async (tx) => {
            await tx.organization.update({
              where: { id: org.id },
              data: {
                plan: 'free',
                stripeSubscriptionId: null,
                subscriptionStatus: event.type === 'customer.subscription.paused' ? 'paused' : 'canceled',
                currentPeriodEnd: null,
                trialEndsAt: null,
              },
            });
            await tx.organizationEntitlement.updateMany({
              where: { orgId: org.id, source: 'stripe', effectiveUntil: null }, data: { effectiveUntil: new Date() },
            });
          });
          break;
        }
        case 'invoice.payment_failed': {
          if (!org) break;
          await prisma.organization.update({
            where: { id: org.id },
            data: { subscriptionStatus: 'past_due' },
          });
          break;
        }
        case 'invoice.paid':
        case 'invoice.payment_succeeded': {
          if (!org) break;
          const subscriptionId = billingMod.getSubscriptionIdFromStripeObject(obj);
          if (subscriptionId) {
            const stripe = await billingMod.getStripe();
            const subscription = await stripe.subscriptions.retrieve(subscriptionId);
            org = await syncPersonalStripeSubscription({ org, subscription, plansMod }) || org;
          }
          break;
        }
        default:
          // Unknown event types are recorded but ignored.
          break;
      }

      // Persist the event AFTER processing succeeds so failures retry.
      await prisma.$executeRawUnsafe(
        `INSERT INTO hivemind.stripe_events (event_id, event_type, org_id, payload, processed_at)
         VALUES ($1, $2, $3::uuid, $4::jsonb, NOW())
         ON CONFLICT (event_id) DO NOTHING`,
        event.id,
        event.type,
        org?.id || null,
        JSON.stringify(event).slice(0, 200_000),
      );
      audit({
        organizationId: org?.id || null,
        userId: null,
        actorType: 'webhook',
        eventType: `stripe.${event.type}`,
        eventCategory: 'billing',
        action: 'webhook',
        resourceType: 'subscription',
        resourceId: obj.id || event.id,
        metadata: { event_id: event.id, customer: customerId },
      }).catch(() => {});
      return jsonResponse(res, { ok: true });
    } catch (err) {
      console.error('[stripe-webhook] handler failed:', err.message, event.type, event.id);
      return jsonResponse(res, { error: err.message }, 500);
    }
  }
  // ─── End Stripe webhook ───────────────────────────────────

  // POST /v1/connectors/slack/events — Slack Events API webhook
  // Public endpoint (no session). Auth via HMAC signature over raw body.
  // Handles url_verification handshake + message/reaction/pin events.
  if (pathname === '/v1/connectors/slack/events' && req.method === 'POST') {
    // Secret resolution: env first, then the gitignored on-disk fallback
    // (/app/.slack-signing-secret). The fallback exists because the running
    // containers cannot gain new env vars without a recreate — dropping the
    // secret file into the bind-mounted core/ dir + restart is enough.
    let signingSecret = process.env.SLACK_SIGNING_SECRET || null;
    if (!signingSecret) {
      try {
        const fsMod = await import('node:fs');
        signingSecret = fsMod.readFileSync('/app/.slack-signing-secret', 'utf8').trim() || null;
      } catch { /* file absent */ }
    }
    if (!signingSecret) {
      console.error('[slack-events] SLACK_SIGNING_SECRET not configured (env + /app/.slack-signing-secret both empty)');
      return jsonResponse(res, { error: 'webhook not configured' }, 503);
    }

    // Read raw body for HMAC; reject if too large
    const chunks = [];
    let totalLen = 0;
    const MAX_BODY = 1_000_000; // 1MB
    for await (const chunk of req) {
      totalLen += chunk.length;
      if (totalLen > MAX_BODY) {
        return jsonResponse(res, { error: 'body too large' }, 413);
      }
      chunks.push(chunk);
    }
    const rawBody = Buffer.concat(chunks).toString('utf8');

    // Verify signature: v0=hex(hmac-sha256(secret, "v0:" + ts + ":" + body))
    const ts = req.headers['x-slack-request-timestamp'];
    const sig = req.headers['x-slack-signature'];
    if (!ts || !sig) {
      return jsonResponse(res, { error: 'missing signature headers' }, 400);
    }
    const skewSec = Math.abs(Math.floor(Date.now() / 1000) - parseInt(ts, 10));
    if (Number.isNaN(skewSec) || skewSec > 300) {
      return jsonResponse(res, { error: 'stale timestamp' }, 400);
    }
    const crypto = await import('node:crypto');
    const base = `v0:${ts}:${rawBody}`;
    const expected = `v0=${crypto.createHmac('sha256', signingSecret).update(base).digest('hex')}`;
    let sigOk = false;
    try {
      sigOk = crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(String(sig), 'utf8'));
    } catch {
      sigOk = false;
    }
    if (!sigOk) {
      return jsonResponse(res, { error: 'bad signature' }, 401);
    }

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return jsonResponse(res, { error: 'invalid json' }, 400);
    }

    // 1. URL verification handshake (Slack one-time when subscribing)
    if (payload.type === 'url_verification') {
      console.log('[slack-events] url_verification challenge received — responding');
      return jsonResponse(res, { challenge: payload.challenge });
    }

    // 2. Event callback — ack 200 fast, ingest async
    if (payload.type === 'event_callback') {
      const teamId = payload.team_id;
      const event = payload.event || {};
      console.log(`[slack-events] inbound event_callback type=${event.type} subtype=${event.subtype || '-'} team=${teamId} channel=${event.channel || '-'}`);

      // Respond 200 within 3s (Slack retry policy)
      jsonResponse(res, { ok: true });

      // Background ingest (fire-and-forget)
      setImmediate(async () => {
        try {
          if (!connectorStore || !prisma) return;
          // Resolve connector by team_id (multi-tenant fanout)
          let conn = await prisma.platformIntegration.findFirst({
            where: {
              platformType: 'slack',
              isActive: true,
              connectorMetadata: { path: ['provider_metadata', 'team_id'], equals: teamId },
            },
          });
          if (!conn) {
            // Fallback: team_id not captured on the connection (older OAuth /
            // Nango). Use the MOST-RECENTLY-connected active Slack connector —
            // a fresh reconnect supersedes a stale one (whose token may be
            // dead). Correct for a single workspace; multi-workspace needs
            // team_id capture at OAuth time.
            conn = await prisma.platformIntegration.findFirst({
              where: { platformType: 'slack', isActive: true },
              orderBy: { updatedAt: 'desc' },
            });
          }
          if (!conn) {
            console.warn(`[slack-events] no connector for team_id=${teamId}`);
            return;
          }

          // Forward to core for ingestion (master-key authed)
          const apiKey = process.env.HIVEMIND_MASTER_API_KEY;
          if (!apiKey) {
            console.error('[slack-events] HIVEMIND_MASTER_API_KEY missing — cannot ingest');
            return;
          }
          await fetch(`${CONFIG.coreApiBaseUrl}/api/connectors/slack/event-ingest`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
            body: JSON.stringify({
              user_id: conn.userId,
              org_id: conn.orgId || null,
              team_id: teamId,
              event,
              event_type: event.type,
              event_subtype: event.subtype || null,
              event_ts: event.event_ts || event.ts || null,
            }),
          });
        } catch (err) {
          console.error('[slack-events] ingest dispatch failed:', err.message);
        }
      });
      return;
    }

    // Unknown payload type — ack so Slack stops retrying
    return jsonResponse(res, { ok: true });
  }

  // POST /v1/connectors/slack/interactivity — Slack interactive components
  // (button clicks). Body is application/x-www-form-urlencoded: payload=<json>.
  // HMAC-verified, then forwarded to core (master-key) to perform the save.
  if (pathname === '/v1/connectors/slack/interactivity' && req.method === 'POST') {
    const signingSecret = process.env.SLACK_SIGNING_SECRET;
    if (!signingSecret) return jsonResponse(res, { error: 'webhook not configured' }, 503);
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > 1_000_000) return jsonResponse(res, { error: 'body too large' }, 413);
      chunks.push(chunk);
    }
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const ts = req.headers['x-slack-request-timestamp'];
    const sig = req.headers['x-slack-signature'];
    if (!ts || !sig) return jsonResponse(res, { error: 'missing signature headers' }, 400);
    if (Math.abs(Math.floor(Date.now() / 1000) - parseInt(ts, 10)) > 300) {
      return jsonResponse(res, { error: 'stale timestamp' }, 400);
    }
    const crypto = await import('node:crypto');
    const expected = `v0=${crypto.createHmac('sha256', signingSecret).update(`v0:${ts}:${rawBody}`).digest('hex')}`;
    let sigOk = false;
    try { sigOk = crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(String(sig), 'utf8')); } catch { sigOk = false; }
    if (!sigOk) return jsonResponse(res, { error: 'bad signature' }, 401);

    let payload;
    try { payload = JSON.parse(new URLSearchParams(rawBody).get('payload') || '{}'); } catch { return jsonResponse(res, { error: 'invalid payload' }, 400); }

    jsonResponse(res, { ok: true });
    setImmediate(async () => {
      try {
        const action = (payload.actions && payload.actions[0]) || null;
        if (!action || !String(action.action_id || '').startsWith('hm_save_pick')) return;
        const apiKey = process.env.HIVEMIND_MASTER_API_KEY;
        if (!apiKey) { console.error('[slack-interactivity] HIVEMIND_MASTER_API_KEY missing'); return; }
        await fetch(`${CONFIG.coreApiBaseUrl}/api/connectors/slack/interactivity`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
          body: JSON.stringify({ value: action.value, response_url: payload.response_url || null }),
        });
      } catch (err) {
        console.error('[slack-interactivity] dispatch failed:', err.message);
      }
    });
    return;
  }

  // ─── End Connector Routes ──────────────────────────────────────

  // POST /v1/tara/cartesia-token — mint a short-lived Cartesia agent access
  // token for the browser voice widget. The secret CARTESIA_API_KEY stays
  // server-side; the browser only ever sees a ~60s token + the agent id.
  if (pathname === '/v1/tara/cartesia-token' && req.method === 'POST') {
    const current = await requireSession(req, res);
    if (!current) return;
    if (!await requirePrivilegedAgentAccess(req, res, current)) return;
    const apiKey = process.env.CARTESIA_API_KEY || '';
    const agentId = process.env.CARTESIA_AGENT_ID || '';
    if (!apiKey || !agentId) {
      return jsonResponse(res, { error: 'Cartesia not configured (CARTESIA_API_KEY / CARTESIA_AGENT_ID)' }, 503);
    }
    try {
      const r = await fetch('https://api.cartesia.ai/access-token', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Cartesia-Version': '2025-04-16',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ grants: { agent: true }, expires_in: 60 }),
      });
      if (!r.ok) {
        const detail = await r.text().catch(() => '');
        console.warn('[tara] cartesia token mint failed:', r.status, detail.slice(0, 200));
        return jsonResponse(res, { error: 'Token mint failed' }, 502);
      }
      const data = await r.json();
      return jsonResponse(res, { token: data.token, agent_id: agentId, version: '2025-04-16' });
    } catch (err) {
      console.warn('[tara] cartesia token mint error:', err.message);
      return jsonResponse(res, { error: 'Token mint error' }, 502);
    }
  }

  // ─── TARA provider control (session-cookie → Core, admin-gated writes) ──
  // Browser-initiated outbound dial ("Talk to TARA" → call a number).
  // The FE used to POST the adapter's /calls/outbound DIRECTLY, which 401s the
  // moment TARA_DG_API_KEY is set — and the browser must never hold that key,
  // because it authorizes dialing anyone. Dial server-side instead: the session
  // cookie proves who is asking, the tenant is pinned from the session (never
  // the body), and the provider follows the org's CURRENT toggle rather than a
  // hardcoded adapter.
  if (pathname === '/v1/tara/outbound' && req.method === 'POST') {
    const current = await requireSession(req, res);
    if (!current) return;
    const body = await parseBody(req);
    const to = String(body.to || '').replace(/[\s()/-]/g, '');
    if (!/^\+[1-9]\d{7,14}$/.test(to)) {
      return jsonResponse(res, { error: 'to must be a valid E.164 number' }, 400);
    }
    const orgId = current.session.orgId;
    const userId = current.session.userId;
    const provider = await taraProviderFor(orgId).catch(() => null);
    if (!provider) return jsonResponse(res, { error: 'no voice provider configured' }, 503);
    const sessionId = `out-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    // Same compact org brief the campaign dialer sends, so a manually-dialed call
    // opens knowing the org as well as an automated one does.
    const orgBrief = await (async () => {
      try {
        const { buildOrgBrief } = await import('./tara/org-brief.js');
        return await buildOrgBrief(prisma, orgId, { userId });
      } catch { return ''; }
    })();
    try {
      const r = await fetch(`${provider.baseUrl}/calls/outbound`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(process.env.TARA_DG_API_KEY ? { 'X-TARA-Key': process.env.TARA_DG_API_KEY } : {}),
        },
        body: JSON.stringify({
          to,
          session_id: sessionId,
          user_id: userId,
          org_id: orgId,
          language: String(body.language || 'en').slice(0, 8),
          voice_id: body.voice_id || undefined,
          goal: body.goal ? String(body.goal).slice(0, 600) : undefined,
          company: body.company ? String(body.company).slice(0, 200) : undefined,
          org_brief: orgBrief || undefined,
          mode: 'external',
        }),
        signal: AbortSignal.timeout(25000),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) return jsonResponse(res, { error: data.error || `dial failed (${r.status})` }, r.status === 400 ? 400 : 502);
      return jsonResponse(res, { ...data, session_id: data.session_id || sessionId, provider: provider.provider });
    } catch (error) {
      return jsonResponse(res, { error: `TARA voice service unreachable: ${error.message}` }, 502);
    }
  }

  // Hang up a browser-initiated call. Same reason as the dial above: the
  // adapter gates this behind the dial key, which the browser cannot hold.
  const taraHangupMatch = pathname.match(/^\/v1\/tara\/outbound\/([A-Za-z0-9_-]{6,64})\/hangup$/);
  if (taraHangupMatch && req.method === 'POST') {
    const current = await requireSession(req, res);
    if (!current) return;
    const provider = await taraProviderFor(current.session.orgId).catch(() => null);
    if (!provider) return jsonResponse(res, { error: 'no voice provider configured' }, 503);
    try {
      const r = await fetch(`${provider.baseUrl}/calls/outbound/${taraHangupMatch[1]}/hangup`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(process.env.TARA_DG_API_KEY ? { 'X-TARA-Key': process.env.TARA_DG_API_KEY } : {}),
        },
        signal: AbortSignal.timeout(15000),
      });
      return jsonResponse(res, { ok: r.ok }, r.ok ? 200 : 502);
    } catch (error) {
      return jsonResponse(res, { error: error.message }, 502);
    }
  }

  if (pathname === '/v1/tara/runtime-config' || pathname === '/v1/tara/voice-sessions' || pathname === '/v1/tara/voices') {
    const current = await requireSession(req, res);
    if (!current) return;
    if (pathname === '/v1/tara/runtime-config' && req.method === 'PATCH') {
      const admin = await requireOrgAdmin(req, res, current.session.userId, current.session.orgId);
      if (!admin) return;
    }
    const body = req.method === 'GET' ? undefined : await parseBody(req);
    return proxyToCore(req, res, {
      session: current.session,
      method: req.method,
      path: pathname === '/v1/tara/runtime-config'
        ? '/api/tara/runtime-config'
        : pathname === '/v1/tara/voices'
          ? '/api/tara/voices'
          : '/api/tara/voice-sessions',
      body,
      query: url.search || '',
    });
  }

  // Unified AI Campaigns. Keep the public route stable while Core owns tenant
  // validation, idempotency, room creation, and all campaign state changes.
  if (pathname === '/v1/campaigns' || pathname.startsWith('/v1/campaigns/')) {
    const current = await requireSession(req, res);
    if (!current) return;
    const multipart = String(req.headers['content-type'] || '').includes('multipart/form-data');
    let parsed;
    try {
      parsed = (req.method === 'GET' || req.method === 'HEAD')
        ? { body: undefined, raw: undefined }
        : multipart ? await parseBodyWithRaw(req, 6 * 1024 * 1024) : { body: await parseBody(req), raw: undefined };
    } catch (error) {
      return jsonResponse(res, { error: error.code || 'invalid_request', message: error.message }, error.status || 400);
    }
    return proxyToCore(req, res, {
      session: current.session,
      method: req.method,
      path: pathname.replace('/v1/campaigns', '/api/campaigns'),
      body: parsed.parsed ?? parsed.body,
      rawBody: parsed.raw,
      query: url.search || '',
    });
  }

  // ─── Proxy Routes (session-cookie → core API with master key) ─────
  // Hosted local Cloudflare Workflows cannot call a loopback-only Core URL.
  // This narrow service-to-service bridge is disabled outside explicit local
  // mode and authenticates with the same dedicated Workflow secret at both
  // boundaries. It never creates a browser session and never maps arbitrary
  // paths into Core.
  if (/^\/internal\/knowledge-ingest\/v1\/jobs\/[0-9a-f-]{36}\/(?:stages\/(?:acquire|materialize(?:\/(?:start|status))?|reconcile)|fail)$/.test(pathname)) {
    return proxyKnowledgeWorkflowToCore(req, res, pathname);
  }

  // Cloudflare canonical-projection requests are authenticated and replay
  // fenced by Core. Preserve their exact bytes and signature headers; never
  // expose an arbitrary internal-path proxy or translate them into a session.
  if (/^\/internal\/canonical-projection\/v1\/memories\/[0-9a-f-]{36}\/stages\/(?:load|reconstruct|resolve|normalize|persist|reconcile|complete|failed)$/.test(pathname)) {
    return proxyCanonicalProjectionToCore(req, res, pathname);
  }

  if (pathname.startsWith('/v1/proxy/')) {
    const current = await requireSession(req, res);
    if (!current) return;

    // Map /v1/proxy/health → /health, everything else → /api/...
    let corePath;
    if (pathname === '/v1/proxy/health') {
      corePath = '/health';
    } else {
      corePath = pathname.replace('/v1/proxy/', '/api/');
    }

    const isMultipart = (req.headers['content-type'] || '').startsWith('multipart/');

    // Read body: raw Buffer for multipart, parsed JSON for everything else
    let body = undefined;
    let rawBody = undefined;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (isMultipart) {
        try {
          const maxMultipartBytes = Number(process.env.KNOWLEDGE_MULTIPART_MAX_BYTES || 52 * 1024 * 1024);
          rawBody = (await parseBodyWithRaw(req, maxMultipartBytes)).raw;
        } catch (error) {
          return jsonResponse(res, {
            error: error.code || 'payload_too_large',
            message: error.status === 413 ? 'Upload exceeds the maximum request size.' : error.message,
          }, error.status || 400);
        }
      } else {
        body = await parseBody(req);
      }
    }

    return proxyToCore(req, res, {
      session: current.session,
      method: req.method,
      path: corePath,
      body,
      query: url.search || '',
      rawBody,
    });
  }
  // ─── End Proxy Routes ─────────────────────────────────────────

  if (pathname === '/' && req.method === 'GET') {
    return jsonResponse(res, {
      service: 'hivemind-control-plane',
      login_url: '/auth/login',
      bootstrap_url: '/v1/bootstrap',
      core_api_base_url: CONFIG.coreApiBaseUrl
    });
  }

  // ─── SCIM 2.0 endpoints (/scim/v2/*) ──────────────────────────
  if (pathname.startsWith('/scim/v2/')) {
    const auditLoggerForScim = await _getAuditLogger();
    const handled = await handleScimRequest(req, res, prisma, pathname, auditLoggerForScim, CONFIG.publicBaseUrl);
    if (handled) return;
  }

  // ─── /v1/auth/sso-redirect — IdP-initiated login redirect ─────
  // GET /v1/auth/sso-redirect?org=<subdomain>
  // Returns Zitadel auth URL for the org's project, else falls back to default.
  if (pathname === '/v1/auth/sso-redirect' && req.method === 'GET') {
    const slug = url.searchParams.get('org') || '';
    const returnTo = url.searchParams.get('return_to') || CONFIG.postLoginRedirect;

    let projectId = null;
    if (slug && prisma) {
      const cfg = await resolveSsoConfig(prisma, slug);
      if (cfg && cfg.enabled && cfg.zitadelProjectId) {
        projectId = cfg.zitadelProjectId;
      }
    }

    if (!zitadelClient) {
      return jsonResponse(res, { error: 'ZITADEL not configured' }, 503);
    }

    const state = await sessionStore.createAuthState({ returnTo });
    // zitadelClient.buildAuthorizeUrl supports optional projectId via extra param
    const authUrl = zitadelClient.buildAuthorizeUrl(state, {
      ...(projectId ? { resource: projectId } : {}),
    });

    return jsonResponse(res, { auth_url: authUrl, org: slug || null });
  }

  // ─── /v1/orgs/:id/sso — SSO config CRUD ──────────────────────
  const ssoConfigMatch = pathname.match(/^\/v1\/orgs\/([^/]+)\/sso$/);
  if (ssoConfigMatch) {
    if (!prisma) return jsonResponse(res, { error: 'Database unavailable' }, 503);
    const current = await requireSession(req, res);
    if (!current) return;
    const orgId = ssoConfigMatch[1];
    const membership = await requireOrgAdmin(req, res, current.session.userId, orgId);
    if (!membership) return;

    if (req.method === 'GET') {
      const cfg = await prisma.orgSsoConfig.findUnique({ where: { orgId } });
      if (!cfg) {
        return jsonResponse(res, { sso_config: null });
      }
      return jsonResponse(res, {
        sso_config: {
          org_id: cfg.orgId,
          sso_type: cfg.ssoType,
          zitadel_project_id: cfg.zitadelProjectId,
          saml_idp_metadata_url: cfg.samlIdpMetadataUrl,
          saml_acs_url: cfg.samlAcsUrl,
          subdomain: cfg.subdomain,
          enabled: cfg.enabled,
          jit_provisioning: cfg.jitProvisioning,
          default_role: cfg.defaultRole,
          default_team_id: cfg.defaultTeamId,
          has_scim_token: Boolean(cfg.scimTokenHash),
          scim_token_id: cfg.scimTokenId,
          created_at: cfg.createdAt,
          updated_at: cfg.updatedAt,
          // Derived ACS URL for customer to paste into Okta/Azure AD
          acs_url: cfg.subdomain
            ? `https://${cfg.subdomain}.hivemind.davinciai.eu/saml/acs`
            : null,
        },
      });
    }

    if (req.method === 'PUT') {
      const body = await parseBody(req);
      const data = {};
      if (typeof body.sso_type === 'string') data.ssoType = body.sso_type;
      if (typeof body.zitadel_project_id === 'string') data.zitadelProjectId = body.zitadel_project_id || null;
      if (typeof body.saml_idp_metadata_url === 'string') data.samlIdpMetadataUrl = body.saml_idp_metadata_url || null;
      if (typeof body.subdomain === 'string') {
        const sub = body.subdomain.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
        data.subdomain = sub || null;
        data.samlAcsUrl = sub ? `https://${sub}.hivemind.davinciai.eu/saml/acs` : null;
      }
      if (typeof body.enabled === 'boolean') data.enabled = body.enabled;
      if (typeof body.jit_provisioning === 'boolean') data.jitProvisioning = body.jit_provisioning;
      if (typeof body.default_role === 'string') data.defaultRole = body.default_role || 'member';
      if (typeof body.default_team_id === 'string') data.defaultTeamId = body.default_team_id || null;

      const cfg = await prisma.orgSsoConfig.upsert({
        where: { orgId },
        create: { orgId, ...data },
        update: data,
      });

      audit({
        organizationId: orgId,
        userId: current.session.userId,
        eventType: 'sso.config_changed',
        eventCategory: 'security',
        action: 'update',
        resourceType: 'sso_config',
        newValue: data,
        ..._reqMeta(req),
      });

      return jsonResponse(res, {
        success: true,
        sso_config: {
          org_id: cfg.orgId,
          sso_type: cfg.ssoType,
          subdomain: cfg.subdomain,
          enabled: cfg.enabled,
          has_scim_token: Boolean(cfg.scimTokenHash),
          acs_url: cfg.subdomain ? `https://${cfg.subdomain}.hivemind.davinciai.eu/saml/acs` : null,
        },
      });
    }

    return jsonResponse(res, { error: 'Method not allowed' }, 405);
  }

  // ─── POST /v1/orgs/:id/sso/scim-token — generate SCIM token ──
  const scimTokenGenMatch = pathname.match(/^\/v1\/orgs\/([^/]+)\/sso\/scim-token$/);
  if (scimTokenGenMatch) {
    if (!prisma) return jsonResponse(res, { error: 'Database unavailable' }, 503);
    const current = await requireSession(req, res);
    if (!current) return;
    const orgId = scimTokenGenMatch[1];
    const membership = await requireOrgAdmin(req, res, current.session.userId, orgId);
    if (!membership) return;

    if (req.method === 'POST') {
      // Generate token: scim_<32-byte hex>
      const rawToken = `scim_${crypto.randomBytes(32).toString('hex')}`;
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      const tokenId = crypto.randomUUID().slice(0, 8);

      await prisma.orgSsoConfig.upsert({
        where: { orgId },
        create: { orgId, scimTokenHash: tokenHash, scimTokenId: tokenId },
        update: { scimTokenHash: tokenHash, scimTokenId: tokenId },
      });

      audit({
        organizationId: orgId,
        userId: current.session.userId,
        eventType: 'sso.scim_token_generated',
        eventCategory: 'security',
        action: 'create',
        resourceType: 'scim_token',
        newValue: { token_id: tokenId },
        ..._reqMeta(req),
      });

      return jsonResponse(res, {
        success: true,
        // Returned once — caller must save this immediately
        scim_token: rawToken,
        token_id: tokenId,
        warning: 'Save this token now — it will not be shown again.',
      }, 201);
    }

    if (req.method === 'DELETE') {
      await prisma.orgSsoConfig.upsert({
        where: { orgId },
        create: { orgId, scimTokenHash: null, scimTokenId: null },
        update: { scimTokenHash: null, scimTokenId: null },
      });

      audit({
        organizationId: orgId,
        userId: current.session.userId,
        eventType: 'sso.scim_token_revoked',
        eventCategory: 'security',
        action: 'delete',
        resourceType: 'scim_token',
        ..._reqMeta(req),
      });

      return jsonResponse(res, { success: true });
    }

    return jsonResponse(res, { error: 'Method not allowed' }, 405);
  }

  // ─── JIT Provisioning hook (called after /auth/callback) ──────
  // This is integrated inline in the Zitadel callback handler above.
  // The _jitProvision helper is called at the bottom of /auth/callback.
  // Defined here as a module-level helper for reuse.

  // ─── Hermes agents control plane ─────────────────────────────
  // Flag-gated (HERMES_MANAGER_ENABLED!=='true' → 404), session-auth'd,
  // org-scoped inside the handler. Raw-SQL persistence (hermes_agents/jobs),
  // no schema.prisma drift. See core/src/hermes/control-routes.js.
  if (await handleHermesRoutes(req, res, { pathname, method: req.method, prisma, jsonResponse, parseBody, requireSession })) {
    return;
  }

  return jsonResponse(res, { error: 'Not found' }, 404);
});

if (shouldStartHttpServer()) {
  server.listen(CONFIG.port, '0.0.0.0', () => {
    console.log(`[control-plane] listening on ${CONFIG.port}`);
  });
} else {
  console.log(`[control-plane] HTTP disabled for runtime role ${process.env.HIVEMIND_RUNTIME_ROLE || 'all'}`);
}
