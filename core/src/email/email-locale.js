/**
 * The language of a system email: the recipient's profile language, else the organization default, else English.
 * Templates without a variant for the language render in English.
 */
import { normalizeOrgLocale } from '../organizations/language-setting.js';

/** Languages written right to left; their body is wrapped in a right-to-left container. */
export const RTL_EMAIL_LOCALES = Object.freeze(['ar']);

/**
 * Picks the language of one email.
 * `en` is the column default of a profile, so it cannot be told apart from a choice and does not outrank an organization default.
 * @param {{ profile?: unknown, org?: unknown }} sources The recipient's profile language and the organization default.
 * @returns {string} A supported language tag.
 */
export function resolveEmailLocale({ profile, org } = {}) {
  const own = normalizeOrgLocale(profile);
  if (own && own !== 'en') return own;
  return normalizeOrgLocale(org) ?? own ?? 'en';
}

async function firstValue(db, sql, id, field) {
  if (!id) return null;
  try { return (await db.$queryRawUnsafe(sql, id))?.[0]?.[field] ?? null; }
  catch { return null; /* A missing column or a database error leaves the language to the next source; an email is never blocked by this lookup. */ }
}

/**
 * Reads the language for an email to a known person.
 * @param {{ $queryRawUnsafe: Function } | null | undefined} db Prisma client; without it the language is English.
 * @param {{ userId?: string | null, orgId?: string | null }} who The recipient and the organization the message is about.
 * @returns {Promise<string>} A supported language tag; never throws.
 */
export async function readEmailLocale(db, { userId, orgId } = {}) {
  if (!db) return 'en';
  const [profile, org] = await Promise.all([
    firstValue(db, 'SELECT locale FROM hivemind.users WHERE id=$1::uuid', userId, 'locale'),
    firstValue(db, 'SELECT default_locale FROM hivemind.organizations WHERE id=$1::uuid', orgId, 'default_locale'),
  ]);
  return resolveEmailLocale({ profile, org });
}
