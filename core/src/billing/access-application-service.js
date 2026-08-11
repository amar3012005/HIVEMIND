import crypto from 'node:crypto';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STATUS = new Set(['pending', 'approved', 'discarded', 'invited', 'converted']);

function text(value, max, required = false) {
  const normalized = String(value || '').trim().replace(/\s+/g, ' ');
  if (required && !normalized) throw new Error('Required field is missing');
  if (normalized.length > max) throw new Error('Field is too long');
  return normalized || null;
}

export function normalizeAccessApplication(input = {}) {
  const email = text(input.email, 254, true)?.toLowerCase();
  if (!EMAIL.test(email)) throw new Error('Email is invalid');
  const requested = String(input.account_type || input.use || '').toLowerCase();
  const accountType = requested.includes('enterprise') ? 'enterprise' : requested.includes('personal') ? 'personal' : null;
  if (!accountType) throw new Error('Account type is required');
  return {
    email,
    emailHash: crypto.createHash('sha256').update(email).digest('hex'),
    name: text(input.name, 160, true),
    accountType,
    companyName: text(input.company_name || input.company, 255),
    useCase: text(input.use_case || input.use, 120),
    niche: text(input.niche, 120),
    message: text(input.message, 4000),
    source: text(input.source, 160) || 'singulancelabs.com',
  };
}

export async function submitAccessApplication(prisma, input) {
  const data = normalizeAccessApplication(input);
  return prisma.accessApplication.upsert({
    where: { emailHash_accountType: { emailHash: data.emailHash, accountType: data.accountType } },
    create: data,
    update: { ...data, status: 'pending', reviewNote: null, reviewedBy: null, reviewedAt: null },
  });
}

export async function reviewAccessApplication(prisma, { id, status, operator, note = null }) {
  if (!STATUS.has(status) || !['approved', 'discarded'].includes(status)) throw new Error('Review action is invalid');
  const result = await prisma.accessApplication.updateMany({
    where: { id, status: { in: ['pending', 'approved'] } },
    data: { status, reviewNote: text(note, 2000), reviewedBy: operator, reviewedAt: new Date() },
  });
  if (!result.count) throw new Error('Application is unavailable');
  return prisma.accessApplication.findUnique({ where: { id } });
}

export function publicAccessApplication(row) {
  return {
    id: row.id, name: row.name, email: row.email, account_type: row.accountType,
    company_name: row.companyName, use_case: row.useCase, niche: row.niche,
    message: row.message, source: row.source, status: row.status,
    review_note: row.reviewNote, reviewed_by: row.reviewedBy,
    reviewed_at: row.reviewedAt, invitation_type: row.invitationType,
    enterprise_invitation_id: row.enterpriseInvitationId,
    invitation_sent_at: row.invitationSentAt, created_at: row.createdAt,
  };
}
