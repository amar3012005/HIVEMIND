import crypto from 'node:crypto';

const MODES = new Set(['off', 'shadow', 'primary', 'email_only']);
const INTENTS = new Set(['auto', 'login', 'register']);
const EXPIRY_MS = 10 * 60 * 1000;
const RESEND_MS = 30 * 1000;

function requiredSecret(name) {
  const value = String(process.env[name] || '');
  if (value.length < 32) throw new Error(`${name} must contain at least 32 characters`);
  return crypto.createHash('sha256').update(value).digest();
}

function seal(value) {
  const key = requiredSecret('EMAIL_AUTH_ENCRYPTION_KEY');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64url')).join('.');
}

function open(value) {
  const [iv, tag, encrypted] = String(value).split('.').map((part) => Buffer.from(part, 'base64url'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', requiredSecret('EMAIL_AUTH_ENCRYPTION_KEY'), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

function digest(value, purpose) {
  return crypto.createHmac('sha256', requiredSecret('EMAIL_AUTH_TOKEN_SECRET'))
    .update(`${purpose}\0${value}`).digest('hex');
}

function equalsDigest(value, expected, purpose) {
  const actual = Buffer.from(digest(value, purpose), 'hex');
  const wanted = Buffer.from(String(expected || ''), 'hex');
  return actual.length === wanted.length && crypto.timingSafeEqual(actual, wanted);
}

export function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) return null;
  return email;
}

export function resolveEmailIdentityMode() {
  if (process.env.EMAIL_IDENTITY_V1_ENABLED !== 'true') return 'off';
  const mode = String(process.env.EMAIL_IDENTITY_V1_MODE || 'off').toLowerCase();
  return MODES.has(mode) ? mode : 'off';
}

export function safeReturnTo(candidate, fallback, allowedOrigins = null) {
  try {
    const target = new URL(String(candidate || ''));
    const approved = Array.isArray(allowedOrigins)
      ? allowedOrigins
      : String(process.env.EMAIL_AUTH_ALLOWED_ORIGINS || '')
        .split(',').map((entry) => entry.trim()).filter(Boolean);
    if (!approved.includes(target.origin)) return fallback;
    if (!target.pathname.startsWith('/hivemind/')) return fallback;
    return target.toString();
  } catch { return fallback; }
}

export function createEmailIdentityService({ prisma, publicBaseUrl }) {
  if (!prisma) throw new Error('Prisma is required');

  async function createOutbox(tx, challenge, email, otp, linkToken) {
    const fragmentUrl = `${publicBaseUrl.replace(/\/$/, '')}/hivemind/login#email_challenge=${encodeURIComponent(challenge.id)}&email_token=${encodeURIComponent(linkToken)}`;
    return tx.authEmailOutbox.create({ data: {
      challengeId: challenge.id,
      environment: challenge.environment,
      payloadCiphertext: seal(JSON.stringify({ email, otp, fragmentUrl })),
      status: 'pending',
    } });
  }

  async function start({ email: rawEmail, intent = 'auto', returnTo, mode, environment }) {
    const email = normalizeEmail(rawEmail);
    if (!email) return { accepted: false };
    const selectedIntent = INTENTS.has(intent) ? intent : 'auto';
    const otp = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    const linkToken = crypto.randomBytes(32).toString('base64url');
    const now = new Date();
    const created = await prisma.$transaction(async (tx) => {
      const row = await tx.emailAuthChallenge.create({ data: {
        emailCiphertext: seal(email), emailLookupHash: digest(email, 'email'),
        otpHash: digest(otp, 'otp'), linkTokenHash: digest(linkToken, 'link'),
        intent: selectedIntent, returnTo, environment, flagMode: mode,
        expiresAt: new Date(now.getTime() + EXPIRY_MS),
        resendAvailableAt: new Date(now.getTime() + RESEND_MS),
      } });
      const outbox = await createOutbox(tx, row, email, otp, linkToken);
      await tx.authIdentityEvent.create({ data: { challengeId: row.id, eventType: 'email.challenge_started', outcome: 'accepted', metadata: { environment, intent: selectedIntent, mode } } });
      return { challenge: row, outbox };
    });
    return { accepted: true, challengeId: created.challenge.id, outboxId: created.outbox.id };
  }

  async function verify({ challengeId, code, linkToken }) {
    return prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw`SELECT * FROM "email_auth_challenges" WHERE "id" = ${challengeId}::uuid FOR UPDATE`;
      const row = rows?.[0];
      const now = new Date();
      if (!row || row.consumed_at || new Date(row.expires_at) <= now || Number(row.attempts) >= 5) return { ok: false, reason: 'invalid' };
      const valid = code
        ? /^\d{6}$/.test(String(code)) && equalsDigest(String(code), row.otp_hash, 'otp')
        : linkToken && equalsDigest(String(linkToken), row.link_token_hash, 'link');
      if (!valid) {
        await tx.emailAuthChallenge.update({ where: { id: challengeId }, data: { attempts: { increment: 1 } } });
        await tx.authIdentityEvent.create({ data: { challengeId, eventType: 'email.challenge_verified', outcome: 'denied', metadata: {} } });
        return { ok: false, reason: 'invalid' };
      }
      const updated = row.verified_at
        ? await tx.emailAuthChallenge.findUnique({ where: { id: challengeId } })
        : await tx.emailAuthChallenge.update({ where: { id: challengeId }, data: { verifiedAt: now } });
      if (!row.verified_at) await tx.authIdentityEvent.create({ data: { challengeId, eventType: 'email.challenge_verified', outcome: 'success', metadata: { method: code ? 'otp' : 'link' } } });
      return { ok: true, email: open(updated.emailCiphertext), challenge: updated };
    });
  }

  async function resend(challengeId) {
    const now = new Date();
    return prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw`SELECT * FROM "email_auth_challenges" WHERE "id" = ${challengeId}::uuid FOR UPDATE`;
      const row = rows?.[0];
      if (!row || row.consumed_at || new Date(row.expires_at) <= now || Number(row.resend_count) >= 3 || new Date(row.resend_available_at) > now) return { ok: false };
      const otp = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
      const linkToken = crypto.randomBytes(32).toString('base64url');
      const updated = await tx.emailAuthChallenge.update({ where: { id: challengeId }, data: {
        otpHash: digest(otp, 'otp'), linkTokenHash: digest(linkToken, 'link'),
        resendCount: { increment: 1 }, resendAvailableAt: new Date(now.getTime() + RESEND_MS),
      } });
      const outbox = await createOutbox(tx, updated, open(row.email_ciphertext), otp, linkToken);
      await tx.authIdentityEvent.create({ data: { challengeId, eventType: 'email.challenge_resent', outcome: 'accepted', metadata: {} } });
      return { ok: true, outboxId: outbox.id };
    });
  }

  async function claimOutbox(id) {
    return prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw`SELECT * FROM "auth_email_outbox" WHERE "id" = ${id}::uuid FOR UPDATE`;
      const raw = rows?.[0];
      if (!raw) return null;
      const staleSending = raw.status === 'sending' && new Date(raw.updated_at).getTime() < Date.now() - 120_000;
      if (!['pending', 'retry'].includes(raw.status) && !staleSending) return null;
      const claimed = await tx.authEmailOutbox.update({ where: { id }, data: { status: 'sending', attempt: { increment: 1 } } });
      return { ...claimed, payload: JSON.parse(open(claimed.payloadCiphertext)) };
    });
  }

  async function settleOutbox(id, result) {
    return prisma.authEmailOutbox.update({ where: { id }, data: result.ok ? {
      status: 'sent', providerStatus: result.status || 'queued', providerMessageId: result.messageId || null, sentAt: new Date(), terminalAt: new Date(), lastError: null,
    } : { status: 'retry', providerStatus: 'failed', nextAttemptAt: null, lastError: { code: result.code || 'delivery_failed' } } });
  }

  async function consume(challengeId, userId) {
    return prisma.$transaction(async (tx) => {
      const updated = await tx.emailAuthChallenge.updateMany({ where: { id: challengeId, verifiedAt: { not: null }, consumedAt: null }, data: { consumedAt: new Date() } });
      if (updated.count) await tx.authIdentityEvent.create({ data: { challengeId, userId, eventType: 'email.session_issued', outcome: 'success', metadata: {} } });
      return updated.count === 1;
    });
  }

  return { start, verify, resend, claimOutbox, settleOutbox, consume };
}

export const EMAIL_AUTH_PUBLIC_RESPONSE = Object.freeze({
  ok: true, expires_in_seconds: 600, resend_after_seconds: 30,
  message: 'If this address can sign in, a code is on its way.',
});
