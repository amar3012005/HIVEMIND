/**
 * Cold-test shared lib. REAL requests against the live core (no mocks).
 *
 * Run inside the container:
 *   docker exec hm-core node /app/scripts/cold-tests/<test>.mjs
 * so BASE defaults to localhost:3000. Identity is carried by X-HM-* headers
 * (the master key authenticates the *service*; the user/org headers scope the
 * request to the canonical TEST account — never a real customer).
 *
 * SAFETY: cold tests only ever WRITE to the canonical test user/org, and never
 * issue a destructive (delete/purge) operation against shared prod data.
 */

export const BASE = process.env.COLD_TEST_URL || 'http://localhost:3000';
export const MASTER_KEY = process.env.HIVEMIND_MASTER_API_KEY;
export const USER_ID = process.env.COLD_TEST_USER_ID || '54f5568b-4d6a-4ae1-9a33-48cb2909d59b';
export const ORG_ID = process.env.COLD_TEST_ORG_ID || '67503d34-97e9-49a8-8c52-8ee30cc7603e';

// Marker every cold-test write carries so the rows are identifiable + reversible.
export const COLDTEST_TAG = 'coldtest';

if (!MASTER_KEY) {
  console.error('HIVEMIND_MASTER_API_KEY env var required');
  process.exit(2);
}

function headers(extra = {}) {
  return {
    'Authorization': `Bearer ${MASTER_KEY}`,
    'Content-Type': 'application/json',
    'X-HM-User-Id': USER_ID,
    'X-HM-Org-Id': ORG_ID,
    ...extra,
  };
}

export async function api(method, path, body, { timeoutMs = 30000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: headers(),
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-json */ }
    return { status: res.status, ok: res.ok, json, text };
  } finally {
    clearTimeout(t);
  }
}

// Assertion helpers that accumulate into a structured result, never throw mid-suite.
export function makeReport(suite) {
  const checks = [];
  return {
    suite,
    check(name, pass, detail) {
      checks.push({ name, pass: !!pass, detail: detail || '' });
      const mark = pass ? 'PASS' : 'FAIL';
      console.log(`  [${mark}] ${name}${detail ? ' — ' + detail : ''}`);
      return !!pass;
    },
    finish() {
      const failed = checks.filter((c) => !c.pass);
      const result = {
        suite,
        total: checks.length,
        passed: checks.length - failed.length,
        failed: failed.length,
        green: failed.length === 0,
        checks,
        ts: process.env.COLD_TEST_TS || null, // stamped by orchestrator (no Date.now in agent ctx)
      };
      return result;
    },
  };
}

export function uniqueFact(prefix) {
  // Deterministic-ish unique token without Date.now (works in restricted ctx):
  // use high-res perf + pid. Falls back gracefully.
  let salt;
  try { salt = `${process.pid}-${Math.round(performance.now())}`; }
  catch { salt = `${process.pid}`; }
  return `${prefix} coldtest-token-${salt}`;
}
