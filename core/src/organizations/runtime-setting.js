/**
 * Per-organization "Enable Runtime" setting.
 *
 * `runtime_enabled` is stored on `hivemind.organizations` and defaults to true.
 * When false the company has no Chief of Staff: clients hide Runtime and Runtime
 * itself refuses to run. Control owns the value; clients and Runtime only read it.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROUTE = /^\/v1\/orgs\/([0-9a-f-]{36})\/runtime-settings$/i;
/** PostgreSQL `undefined_column`: the migration has not reached this database yet. */
const UNDEFINED_COLUMN = '42703';

function undefinedColumn(error) {
  return error?.code === UNDEFINED_COLUMN || error?.meta?.code === UNDEFINED_COLUMN
    || /column .*runtime_enabled.* does not exist/i.test(String(error?.message || ''));
}

/**
 * Reads the organization's Runtime switch.
 * An organization without a row, or a database that has not run the migration yet, is enabled.
 * @param {{ $queryRawUnsafe: Function }} db Prisma client or transaction.
 * @param {string} orgId Organization UUID.
 * @returns {Promise<boolean>} False only when an admin switched Runtime off.
 */
export async function readRuntimeEnabled(db, orgId) {
  if (!UUID.test(orgId || '')) return true;
  try {
    const rows = await db.$queryRawUnsafe('SELECT runtime_enabled FROM hivemind.organizations WHERE id=$1::uuid', orgId);
    return rows?.[0]?.runtime_enabled !== false;
  } catch (error) {
    if (undefinedColumn(error)) return true;
    throw error;
  }
}

/**
 * Writes the switch atomically and returns the previous and current values.
 * @param {{ $queryRawUnsafe: Function }} db Prisma client.
 * @param {string} orgId Organization UUID.
 * @param {boolean} enabled Requested value.
 * @returns {Promise<{ previous: boolean, current: boolean } | null>} Null when the organization does not exist.
 */
export async function writeRuntimeEnabled(db, orgId, enabled) {
  const rows = await db.$queryRawUnsafe(
    `UPDATE hivemind.organizations o SET runtime_enabled=$2::boolean, updated_at=now()
     FROM (SELECT id, runtime_enabled AS previous FROM hivemind.organizations WHERE id=$1::uuid FOR UPDATE) p
     WHERE o.id=p.id RETURNING p.previous AS previous, o.runtime_enabled AS current`, orgId, enabled);
  return rows?.[0] ? { previous: rows[0].previous !== false, current: rows[0].current !== false } : null;
}

/**
 * Handles `GET|PUT /v1/orgs/:orgId/runtime-settings` for organization owners and admins.
 * GET returns `{ organization_id, runtime_enabled }`. PUT takes `{ runtime_enabled: boolean }`,
 * records an audit entry when the value changes, and returns the same body plus `changed`.
 * @param {object} context Request, response and the control plane helpers this route depends on.
 * @returns {Promise<boolean>} True when the path belongs to this route.
 */
export async function handleRuntimeSettingRoute({ req, res, pathname, prisma, requireSession, requireOrgAdmin, parseBody, jsonResponse, audit }) {
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
      jsonResponse(res, { organization_id: orgId, runtime_enabled: await readRuntimeEnabled(prisma, orgId) }, 200, headers);
      return true;
    }
    const body = await parseBody(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(key => key !== 'runtime_enabled') || typeof body.runtime_enabled !== 'boolean') {
      jsonResponse(res, { error: 'runtime_enabled boolean is required' }, 400, headers);
      return true;
    }
    const result = await writeRuntimeEnabled(prisma, orgId, body.runtime_enabled);
    if (!result) { jsonResponse(res, { error: 'Resource not found' }, 404, headers); return true; }
    const changed = result.previous !== result.current;
    if (changed) {
      await audit?.({
        userId: current.session.userId,
        organizationId: orgId,
        eventType: 'organization.runtime_enabled_changed',
        eventCategory: 'data_modification',
        action: 'update',
        resourceType: 'organization_setting',
        resourceId: orgId,
        metadata: { setting: 'runtime_enabled' },
        oldValue: { runtime_enabled: result.previous },
        newValue: { runtime_enabled: result.current },
        ipAddress: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null,
        userAgent: req.headers['user-agent'] || null,
      });
    }
    jsonResponse(res, { organization_id: orgId, runtime_enabled: result.current, changed }, 200, headers);
  } catch (error) {
    console.warn('[runtime-setting] unavailable:', error?.code || error?.name);
    jsonResponse(res, { error: 'runtime_setting_unavailable' }, 503, headers);
  }
  return true;
}
