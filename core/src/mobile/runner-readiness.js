/** Native admission stays closed until the paired Runner preserves signed consent bindings. */
export function nativeRunnerAdmissionGate({ pathname, method, session, env = process.env }) {
  if (!session?.nativeMobile || method === 'OPTIONS' || !/^\/v1\/harness-chat(?:\/|$)/.test(pathname)) return { allowed: true };
  // Existing account/session cleanup remains possible while admission is disabled.
  if (method === 'DELETE' && /^\/v1\/harness-chat\/sessions\/[^/]+$/.test(pathname)) return { allowed: true };
  if (env.HIVE_MOBILE_RUNNER_CONSENT_READY === 'true') return { allowed: true };
  return { allowed: false, status: 503, code: 'MOBILE_RUNNER_NOT_READY' };
}
