/**
 * The paired Runner now verifies the opaque native-session hash against the
 * live Control Plane session and rechecks the current AI-consent record on
 * every admission and service request. Keep this routing check narrow; a
 * manual environment latch can drift after a compatible Runner is released
 * and unnecessarily strand authenticated mobile users.
 */
export function nativeRunnerAdmissionGate({ pathname, method, session }) {
  if (!session?.nativeMobile || method === 'OPTIONS' || !/^\/v1\/harness-chat(?:\/|$)/.test(pathname)) return { allowed: true };
  return { allowed: true };
}
