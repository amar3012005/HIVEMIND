import crypto from 'node:crypto';

const MAX_RECEIPT_BYTES = 4 * 1024 * 1024;
const MAX_FIELDS = 32;
const FIELD_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/;
const SESSION_ID_RE = /^session-[A-Za-z0-9-]{8,160}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class ConnectedAppReceiptError extends Error {
  constructor(code, status = 400) {
    super(code); this.code = code; this.status = status;
  }
}

function fail(code, status) { throw new ConnectedAppReceiptError(code, status); }
function text(value, max, code) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) fail(code);
  return value.trim();
}
function fields(value) {
  if (!Array.isArray(value) || value.length > MAX_FIELDS) fail('invalid_receipt_fields');
  const result = [...new Set(value.map((field) => text(field, 80, 'invalid_receipt_fields')))];
  if (result.some((field) => !FIELD_RE.test(field))) fail('invalid_receipt_fields');
  return result;
}
function object(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  return value;
}
function keyFromEnv(env) {
  const raw = String(env.HIVE_CONNECTED_APP_RECEIPT_ENCRYPTION_KEY || '').trim();
  let key;
  if (/^[a-f0-9]{64}$/i.test(raw)) key = Buffer.from(raw, 'hex');
  else {
    try { key = Buffer.from(raw, 'base64'); } catch { key = Buffer.alloc(0); }
  }
  if (key.length !== 32) fail('receipt_encryption_key_unavailable', 503);
  return key;
}
function aad(row) {
  return Buffer.from([row.id, row.orgId, row.userId, row.sessionId, row.callId].join('\u0000'));
}
function encodeEnvelope(row, envelope, env) {
  const clear = Buffer.from(JSON.stringify(envelope));
  if (clear.length > MAX_RECEIPT_BYTES) fail('receipt_too_large', 413);
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFromEnv(env), nonce);
  cipher.setAAD(aad(row));
  return {
    ciphertext: Buffer.concat([cipher.update(clear), cipher.final()]),
    nonce,
    authTag: cipher.getAuthTag(),
    contentHash: crypto.createHash('sha256').update(clear).digest('hex'),
    contentBytes: clear.length,
  };
}
function decodeEnvelope(row, env) {
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyFromEnv(env), row.nonce);
    decipher.setAAD(aad(row)); decipher.setAuthTag(row.authTag);
    const clear = Buffer.concat([decipher.update(row.ciphertext), decipher.final()]);
    if (crypto.createHash('sha256').update(clear).digest('hex') !== row.contentHash) fail('receipt_integrity_failure', 500);
    return object(JSON.parse(clear.toString('utf8')), 'invalid_receipt_envelope');
  } catch (error) {
    if (error instanceof ConnectedAppReceiptError) throw error;
    fail('receipt_decryption_failure', 500);
  }
}
async function scoped(prisma, owner, action) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      "SELECT set_config('app.hivemind_org_id',$1,true),set_config('app.hivemind_user_id',$2,true)",
      owner.orgId, owner.userId,
    );
    return action(tx);
  });
}

export async function storeConnectedAppReceipt({ prisma, owner, input, env = process.env, now = new Date() }) {
  if (!UUID_RE.test(owner.orgId) || !UUID_RE.test(owner.userId)) fail('invalid_receipt_owner');
  const sessionId = text(input.session_id, 180, 'invalid_receipt_session');
  if (!SESSION_ID_RE.test(sessionId)) fail('invalid_receipt_session');
  const callId = text(input.call_id, 180, 'invalid_receipt_call');
  const allowedFields = fields(input.allowed_fields || []);
  const projection = object(input.approved_projection || {}, 'invalid_receipt_projection');
  if (Object.keys(projection).some((field) => !allowedFields.includes(field))) fail('receipt_projection_not_allowed');
  const row = {
    id: crypto.randomUUID(), orgId: owner.orgId, userId: owner.userId, sessionId, callId,
  };
  const encrypted = encodeEnvelope(row, { raw: input.raw_receipt, projection }, env);
  const ttlHours = Math.max(1, Math.min(Number(env.HIVE_CONNECTED_APP_RECEIPT_TTL_HOURS || 168), 720));
  const expiresAt = new Date(now.getTime() + ttlHours * 3_600_000);
  const data = {
    ...row,
    turnId: Number.isSafeInteger(input.turn_id) && input.turn_id >= 0 ? BigInt(input.turn_id) : null,
    provider: text(input.provider, 80, 'invalid_receipt_provider'),
    tool: text(input.tool, 180, 'invalid_receipt_tool'),
    contractVersion: typeof input.contract_version === 'string' && input.contract_version.trim() !== ''
      ? text(input.contract_version, 180, 'invalid_receipt_contract') : null,
    allowedFields, projectionPolicy: text(input.projection_policy, 80, 'invalid_receipt_policy'),
    ...encrypted, expiresAt,
  };
  return scoped(prisma, owner, async (tx) => {
    const prior = await tx.connectedAppReceipt.findUnique({
      where: { sessionId_callId: { sessionId, callId } },
    });
    if (prior) {
      if (prior.contentHash !== data.contentHash) fail('receipt_call_conflict', 409);
      return prior;
    }
    return tx.connectedAppReceipt.create({ data });
  });
}

export async function readConnectedAppReceipt({ prisma, owner, receiptId, sessionId, requestedFields, env = process.env, now = new Date() }) {
  if (!UUID_RE.test(owner.orgId) || !UUID_RE.test(owner.userId) || !UUID_RE.test(receiptId) || !SESSION_ID_RE.test(sessionId)) fail('invalid_receipt_read');
  const requested = fields(requestedFields);
  if (requested.length === 0) fail('receipt_fields_required');
  return scoped(prisma, owner, async (tx) => {
    const row = await tx.connectedAppReceipt.findFirst({
      where: { id: receiptId, orgId: owner.orgId, userId: owner.userId, sessionId },
    });
    if (!row) fail('receipt_not_found', 404);
    if (row.expiresAt <= now) fail('receipt_expired', 410);
    const allowed = fields(row.allowedFields);
    if (requested.some((field) => !allowed.includes(field))) fail('receipt_field_not_allowed', 403);
    const envelope = decodeEnvelope(row, env);
    const projection = object(envelope.projection, 'invalid_receipt_envelope');
    if (requested.some((field) => !Object.hasOwn(projection, field))) fail('receipt_field_unavailable', 422);
    await tx.connectedAppReceipt.update({ where: { id: row.id }, data: { lastReadAt: now } });
    return Object.fromEntries(requested.map((field) => [field, projection[field]]));
  });
}
