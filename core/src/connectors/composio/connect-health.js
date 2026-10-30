/**
 * Daily connect-health run over every listed Composio app.
 *
 * For each toolkit it applies the same rule as the connect route ({@link classifyToolkitConnect}) and, for apps Core
 * can connect, checks the auth config behind them: a configured id must exist and be enabled, and a managed app whose
 * auto-provisioned configs are all disabled is broken. Composio has no side-effect-free initiate call, so the run never
 * creates connected accounts or links; a config that exists and is enabled is the strongest check available.
 *
 * Apps that cannot be connected by design (custom OAuth app or an unsupported scheme) are counted as `blocked`, not as
 * failures, so the alarm fires on regressions only. Failures are published to the connect route and toolkit list as
 * overrides until the next run clears them.
 */
import {
  composioApiRequest, getAuthConfigId, listAllToolkits, setConnectHealthOverrides,
} from './composio-service.js';
import { classifyToolkitConnect } from './connect-readiness.js';

const PAGE_LIMIT = 100;
const MAX_PAGES = 50;

/**
 * Read every auth config visible to the Composio project.
 * @param {(method: string, path: string) => Promise<any>} request - Composio request function.
 * @returns {Promise<Array<{ id: string, toolkit: string, name: string, status: string }>>}
 */
export async function listAuthConfigs(request) {
  const configs = [];
  let cursor;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await request('GET', `/api/v3.1/auth_configs?limit=${PAGE_LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    const items = Array.isArray(result?.items) ? result.items : [];
    for (const item of items) {
      if (typeof item?.id === 'string') configs.push({ id: item.id, toolkit: item.toolkit?.slug || '', name: item.name || '', status: item.status || '' });
    }
    cursor = result?.next_cursor;
    if (!cursor || !items.length) return configs;
  }
  throw new Error('Composio auth config listing exceeded the page limit');
}

/**
 * Pure verdict for the whole catalog.
 * @param {Array<object>} toolkits - Rows from `listAllToolkits`.
 * @param {Array<{ id: string, toolkit: string, name: string, status: string }>} authConfigs
 * @param {(slug: string) => string | null} configuredId - Core-owned auth config id for a toolkit, if any.
 * @returns {{ counts: Record<string, number>, failures: Record<string, string>, blocked: string[] }}
 */
export function assessConnectHealth(toolkits, authConfigs, configuredId) {
  const byId = new Map(authConfigs.map((config) => [config.id, config]));
  const autoByToolkit = new Map();
  for (const config of authConfigs) {
    if (config.name !== `${config.toolkit}-auto`) continue;
    autoByToolkit.set(config.toolkit, [...(autoByToolkit.get(config.toolkit) || []), config]);
  }
  const counts = { toolkits: toolkits.length, connectable: 0, apiKey: 0, noAuth: 0, blocked: 0, failures: 0 };
  const failures = {};
  const blocked = [];
  for (const toolkit of toolkits) {
    const slug = String(toolkit.slug || '').toLowerCase();
    const id = configuredId(slug);
    const verdict = classifyToolkitConnect(toolkit, { authConfigId: id });
    if (verdict.mode === 'no_auth') { counts.noAuth++; continue; }
    if (verdict.mode === 'api_key') { counts.apiKey++; continue; }
    if (verdict.mode === 'blocked') { counts.blocked++; blocked.push(slug); continue; }
    if (verdict.mode === 'configured') {
      const config = byId.get(id);
      if (!config) failures[slug] = 'auth_config_missing';
      else if (config.status !== 'ENABLED') failures[slug] = 'auth_config_disabled';
    } else {
      const autos = autoByToolkit.get(slug) || [];
      if (autos.length && !autos.some((config) => config.status === 'ENABLED')) failures[slug] = 'auth_config_disabled';
    }
    if (failures[slug]) counts.failures++; else counts.connectable++;
  }
  return { counts, failures, blocked };
}

/**
 * Run the check, publish failures as connect overrides and log one line. A failing run (Composio unreachable) keeps
 * the previous overrides and logs an alarm, because an unknown state is not a healthy one.
 *
 * @param {{ request?: Function, loadToolkits?: Function, configuredId?: Function, setOverrides?: Function, log?: Function, alarm?: Function }} [deps]
 * @returns {Promise<{ counts: Record<string, number>, failures: Record<string, string>, blocked: string[] } | null>}
 */
export async function runComposioConnectHealth({
  request = composioApiRequest,
  loadToolkits = () => listAllToolkits().then((page) => page.items),
  configuredId = getAuthConfigId,
  setOverrides = setConnectHealthOverrides,
  log = (line) => console.info(line),
  alarm = (line) => console.error(line),
} = {}) {
  let result;
  try {
    const [toolkits, authConfigs] = await Promise.all([loadToolkits(), listAuthConfigs(request)]);
    result = assessConnectHealth(toolkits, authConfigs, configuredId);
  } catch (error) {
    alarm(`[composio-connect-health] ALARM check_failed status=${error?.status || 'none'}`);
    return null;
  }
  setOverrides(result.failures);
  log(`[composio-connect-health] ${JSON.stringify(result.counts)}`);
  const failed = Object.entries(result.failures);
  if (failed.length) alarm(`[composio-connect-health] ALARM broken_connect ${failed.map(([slug, reason]) => `${slug}:${reason}`).join(',')}`);
  return result;
}
