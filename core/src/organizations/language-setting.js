/**
 * Per-organization default language.
 *
 * `default_locale` is stored on `hivemind.organizations` (NULL = English). It is the language of team-wide messages
 * (digests, administrator emails) for a person who has not chosen a language of their own. Control owns the value;
 * clients, OpenDot and the email service only read it.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROUTE = /^\/v1\/orgs\/([0-9a-f-]{36})\/language-settings$/i;
/** PostgreSQL `undefined_column`: the migration has not reached this database yet. */
const UNDEFINED_COLUMN = '42703';

/** Languages OpenDot, Da-vinci and the system emails are translated into. Employees can answer in more, but a default needs a dictionary. */
export const ORG_LOCALES = Object.freeze(['en', 'de', 'hi', 'ja', 'ar']);

/**
 * Normalizes a language tag to a supported primary language.
 * @param {unknown} tag A tag such as `de`, `de-AT` or `ar_EG`.
 * @returns {string | null} A member of {@link ORG_LOCALES}, or null when the tag names another language or is not a tag.
 */
export function normalizeOrgLocale(tag) {
  if (typeof tag !== 'string') return null;
  const primary = tag.trim().toLowerCase().replace(/_/g, '-').split('-')[0];
  return ORG_LOCALES.includes(primary) ? primary : null;
}

function undefinedColumn(error) {
  return error?.code === UNDEFINED_COLUMN || error?.meta?.code === UNDEFINED_COLUMN
    || /column .*default_locale.* does not exist/i.test(String(error?.message || ''));
}

/**
 * Reads the organization's default language.
 * @param {{ $queryRawUnsafe: Function }} db Prisma client or transaction.
 * @param {string} orgId Organization UUID.
 * @returns {Promise<string | null>} A supported tag, or null when none is set, the organization is unknown or the migration has not run.
 */
export async function readOrgDefaultLocale(db, orgId) {
  if (!UUID.test(orgId || '')) return null;
  try {
    const rows = await db.$queryRawUnsafe('SELECT default_locale FROM hivemind.organizations WHERE id=$1::uuid', orgId);
    return normalizeOrgLocale(rows?.[0]?.default_locale);
  } catch (error) {
    if (undefinedColumn(error)) return null;
    throw error;
  }
}

/**
 * Writes the default atomically and returns the previous and current values.
 * @param {{ $queryRawUnsafe: Function }} db Prisma client.
 * @param {string} orgId Organization UUID.
 * @param {string | null} locale A supported tag, or null to clear the default.
 * @returns {Promise<{ previous: string | null, current: string | null } | null>} Null when the organization does not exist.
 */
export async function writeOrgDefaultLocale(db, orgId, locale) {
  const rows = await db.$queryRawUnsafe(
    `UPDATE hivemind.organizations o SET default_locale=$2::varchar, updated_at=now()
     FROM (SELECT id, default_locale AS previous FROM hivemind.organizations WHERE id=$1::uuid FOR UPDATE) p
     WHERE o.id=p.id RETURNING p.previous AS previous, o.default_locale AS current`, orgId, locale);
  return rows?.[0] ? { previous: normalizeOrgLocale(rows[0].previous), current: normalizeOrgLocale(rows[0].current) } : null;
}

/**
 * Handles `GET|PUT /v1/orgs/:orgId/language-settings` for organization owners and admins.
 * GET returns `{ organization_id, default_locale, supported }`. PUT takes `{ default_locale: string | null }`
 * (one of `supported`, or null to clear), records an audit entry when the value changes, and returns the same body plus `changed`.
 * @param {object} context Request, response and the control plane helpers this route depends on.
 * @returns {Promise<boolean>} True when the path belongs to this route.
 */
export async function handleLanguageSettingRoute({ req, res, pathname, prisma, requireSession, requireOrgAdmin, parseBody, jsonResponse, audit }) {
  const match = pathname.match(ROUTE);
  if (!match) return false;
  const headers = { 'Cache-Control': 'private, no-store' };
  if (!['GET', 'PUT'].includes(req.method)) { jsonResponse(res, { error: 'Method not allowed' }, 405, headers); return true; }
  if (!prisma) { jsonResponse(res, { error: 'Database unavailable' }, 503, headers); return true; }
  const current = await requireSession(req, res);
  if (!current) return true;
  const orgId = match[1];
  if (!await requireOrgAdmin(req, res, current.session.userId, orgId)) return true;
  try {
    if (req.method === 'GET') {
      jsonResponse(res, { organization_id: orgId, default_locale: await readOrgDefaultLocale(prisma, orgId), supported: ORG_LOCALES }, 200, headers);
      return true;
    }
    const body = await parseBody(req);
    const valid = body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 1 && 'default_locale' in body
      && (body.default_locale === null || (typeof body.default_locale === 'string' && ORG_LOCALES.includes(body.default_locale)));
    if (!valid) {
      jsonResponse(res, { error: 'default_locale must be one of the supported languages or null', supported: ORG_LOCALES }, 400, headers);
      return true;
    }
    const result = await writeOrgDefaultLocale(prisma, orgId, body.default_locale);
    if (!result) { jsonResponse(res, { error: 'Resource not found' }, 404, headers); return true; }
    const changed = result.previous !== result.current;
    if (changed) {
      await audit?.({
        userId: current.session.userId,
        organizationId: orgId,
        eventType: 'organization.default_locale_changed',
        eventCategory: 'data_modification',
        action: 'update',
        resourceType: 'organization_setting',
        resourceId: orgId,
        metadata: { setting: 'default_locale' },
        oldValue: { default_locale: result.previous },
        newValue: { default_locale: result.current },
        ipAddress: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null,
        userAgent: req.headers['user-agent'] || null,
      });
    }
    jsonResponse(res, { organization_id: orgId, default_locale: result.current, supported: ORG_LOCALES, changed }, 200, headers);
  } catch (error) {
    console.warn('[language-setting] unavailable:', error?.code || error?.name);
    jsonResponse(res, { error: 'language_setting_unavailable' }, 503, headers);
  }
  return true;
}
