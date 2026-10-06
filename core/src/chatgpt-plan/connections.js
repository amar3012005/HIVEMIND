import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export class ChatgptPlanError extends Error {
  constructor(code, status = 403) { super(code); this.code = code; this.status = status; }
}
export function ownerKey(owner) {
  if (!UUID.test(owner?.orgId || '') || !UUID.test(owner?.userId || '')) throw new ChatgptPlanError('plan_owner_required');
  return `chatgpt-plan:v1:${owner.orgId}:${owner.userId}`;
}
function key(env) {
  const value = env.HIVE_CHATGPT_PLAN_ENCRYPTION_KEY;
  if (!/^[a-f0-9]{64}$/i.test(value || '')) throw new ChatgptPlanError('plan_vault_unconfigured', 503);
  return Buffer.from(value, 'hex');
}
export function planEnabled(env) {
  if (env.HIVE_CHATGPT_PLAN_APPROVED !== 'true' || env.HIVE_CHATGPT_PLAN_ENABLED !== 'true') {
    throw new ChatgptPlanError('hosted_chatgpt_plan_not_enabled', 503);
  }
  if (!env.HIVE_CHATGPT_PLAN_CLIENT_ID) throw new ChatgptPlanError('hosted_client_unconfigured', 503);
}
export function encrypt(owner, grant, env) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(env), nonce);
  cipher.setAAD(Buffer.from(`${ownerKey(owner)}:${env.HIVE_CHATGPT_PLAN_CLIENT_ID}`));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(grant), 'utf8'), cipher.final()]);
  return JSON.stringify({ v: 1, nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') });
}
export function decrypt(owner, encrypted, env) {
  try {
    const value = JSON.parse(encrypted);
    if (value.v !== 1) throw new Error('version');
    const cipher = createDecipheriv('aes-256-gcm', key(env), Buffer.from(value.nonce, 'base64'));
    cipher.setAAD(Buffer.from(`${ownerKey(owner)}:${env.HIVE_CHATGPT_PLAN_CLIENT_ID}`));
    cipher.setAuthTag(Buffer.from(value.tag, 'base64'));
    return JSON.parse(Buffer.concat([cipher.update(Buffer.from(value.ciphertext, 'base64')), cipher.final()]).toString('utf8'));
  } catch { throw new ChatgptPlanError('plan_grant_integrity_failed', 503); }
}
function validate(grant, env, { allowExpired = false } = {}) {
  if (!grant || typeof grant !== 'object' || Array.isArray(grant) || grant.issuer !== 'https://auth.openai.com' || grant.clientId !== env.HIVE_CHATGPT_PLAN_CLIENT_ID
    || typeof grant.subject !== 'string' || !grant.subject || (!Array.isArray(grant.scopes) || !grant.scopes.includes('chatgpt.tokens.use.direct'))
    || typeof grant.accessToken !== 'string' || grant.accessToken.length < 10
    || !Number.isSafeInteger(grant.expiresAt) || (!allowExpired && grant.expiresAt <= Date.now())
    || !Array.isArray(grant.models) || !grant.models.length
    || grant.models.some(model => typeof model !== 'string' || !model || model.length > 100)) {
    throw new ChatgptPlanError('verified_plan_grant_required');
  }
}
/** Trusted OAuth callback only. No browser/tool endpoint accepts tokens. OAuth verification is a prerequisite. */
export async function storeVerifiedPlanGrant(prisma, owner, grant, env) {
  planEnabled(env); ownerKey(owner); validate(grant, env);
  if (!(await prisma.userOrganization.findUnique({ where: { userId_orgId: { userId: owner.userId, orgId: owner.orgId } } }))?.isActive) {
    throw new ChatgptPlanError('plan_membership_revoked');
  }
  return prisma.chatgptPlanConnection.upsert({
    where: { orgId_userId: owner },
    create: { ...owner, encryptedGrant: encrypt(owner, grant, env), status: 'active' },
    update: { encryptedGrant: encrypt(owner, grant, env), status: 'active' },
    select: { id: true, status: true },
  });
}
/** No ambient credential fallback. Session and membership are verified for every model call. */
export async function resolveBrainPlan(prisma, owner, sessionId, model, env, { refresh } = {}) {
  planEnabled(env); ownerKey(owner);
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256) throw new ChatgptPlanError('owned_brain_session_required');
  const member = await prisma.userOrganization.findUnique({ where: { userId_orgId: { userId: owner.userId, orgId: owner.orgId } } });
  if (!member?.isActive) throw new ChatgptPlanError('plan_membership_revoked');
  const session = await prisma.harnessSession.findFirst({ where: { id: sessionId, ...owner, status: 'active' } });
  if (!session || session.profile !== 'hivemind-chat' || session.header?.agentPreset !== 'hivemind-chat'
    || session.header?.parentSession) throw new ChatgptPlanError('owned_brain_session_required');
  let connection = await prisma.chatgptPlanConnection.findUnique({ where: { orgId_userId: owner } });
  if (!connection || connection.status !== 'active') throw new ChatgptPlanError('chatgpt_connection_required');
  let grant = decrypt(owner, connection.encryptedGrant, env);
  validate(grant, env, { allowExpired: true });
  if (grant.expiresAt <= Date.now() + 30000) {
    if (typeof refresh !== 'function') throw new ChatgptPlanError('plan_reconnect_or_refresh_required', 503);
    connection = await refreshPlanGrant(prisma, owner, env, refresh);
    if (connection.reauthorizationRequired) throw new ChatgptPlanError('plan_reauthorization_required', 401);
    grant = decrypt(owner, connection.encryptedGrant, env);
  }
  validate(grant, env);
  if (!grant.models.includes(model)) throw new ChatgptPlanError('plan_model_unavailable', 400);
  return { accessToken: grant.accessToken, connectionId: connection.id };
}

/** Provider client must be the registered hosted client; lock spans refresh rotation. No retry with stale token. */
export async function refreshPlanGrant(prisma, owner, env, refresh) {
  planEnabled(env); ownerKey(owner);
  return prisma.$transaction(async tx => {
    const member = await tx.userOrganization.findUnique({ where: { userId_orgId: { userId: owner.userId, orgId: owner.orgId } } });
    if (!member?.isActive) throw new ChatgptPlanError('plan_membership_revoked');
    await tx.$queryRawUnsafe('SELECT id FROM hivemind.chatgpt_plan_connections WHERE org_id=$1::uuid AND user_id=$2::uuid FOR UPDATE', owner.orgId, owner.userId);
    const row = await tx.chatgptPlanConnection.findUnique({ where: { orgId_userId: owner } });
    if (!row || row.status !== 'active') throw new ChatgptPlanError('chatgpt_connection_required');
    const current = decrypt(owner, row.encryptedGrant, env);
    validate(current, env, { allowExpired: true });
    if (current.expiresAt > Date.now() + 30000) return row;
    if (typeof current.refreshToken !== 'string' || !current.refreshToken || typeof refresh !== 'function') {
      throw new ChatgptPlanError('plan_reconnect_or_refresh_required', 503);
    }
    let next;
    try { next = await refresh(current); } catch (error) {
      if (error?.code === 'plan_reauthorization_required') {
        await tx.chatgptPlanConnection.update({ where: { orgId_userId: owner }, data: { status: 'revoked', encryptedGrant: '' } });
        return { reauthorizationRequired: true };
      }
      throw new ChatgptPlanError('plan_refresh_failed', 503);
    }
    validate(next, env);
    if (next.subject !== current.subject || next.issuer !== current.issuer || next.clientId !== current.clientId) {
      throw new ChatgptPlanError('plan_refresh_identity_changed');
    }
    return tx.chatgptPlanConnection.update({ where: { orgId_userId: owner }, data: { encryptedGrant: encrypt(owner, next, env) } });
  }, { timeout: 30000 });
}
/** Local disconnect removes grant material; remote provider revocation remains a separate registered-client operation. */
export async function disconnectPlan(prisma, owner) {
  ownerKey(owner);
  const member = await prisma.userOrganization.findUnique({ where: { userId_orgId: { userId: owner.userId, orgId: owner.orgId } } });
  if (!member?.isActive) throw new ChatgptPlanError('plan_membership_revoked');
  await prisma.chatgptPlanConnection.updateMany({ where: { ...owner }, data: { status: 'revoked', encryptedGrant: '' } });
  return { disconnected: true };
}

/** Owner-scoped row lock also serializes catalog/disconnect against refresh rotation. */
export async function modifyPlanConnection(prisma, owner, env, action) {
  ownerKey(owner);
  return prisma.$transaction(async tx => {
    if (!(await tx.userOrganization.findUnique({ where: { userId_orgId: { userId: owner.userId, orgId: owner.orgId } } }))?.isActive) {
      throw new ChatgptPlanError('plan_membership_revoked');
    }
    await tx.$queryRawUnsafe('SELECT id FROM hivemind.chatgpt_plan_connections WHERE org_id=$1::uuid AND user_id=$2::uuid FOR UPDATE', owner.orgId, owner.userId);
    const row = await tx.chatgptPlanConnection.findUnique({ where: { orgId_userId: owner } });
    const grant = row?.status === 'active' ? decrypt(owner, row.encryptedGrant, env) : null;
    return action(tx, row, grant);
  }, { timeout: 15000 });
}
