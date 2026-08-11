// ── Enterprise access codes ─────────────────────────────────────────────────
// An enterprise access code gates self-serve enterprise signup: it proves the
// workspace is entitled to the standard 14-day enterprise onboarding → runway
// terms (activated via buildStandardOffer('enterprise') + activateOffer).
//
// This is NOT a referral/partner code (those live in the referral_campaigns
// table and carry custom partner limits). An access code just unlocks the
// STANDARD enterprise onboarding for a hand-selected signup.
//
// Deliberately an ALLOW-LIST, never "any non-empty string": an open gate would
// let anyone self-provision a paid enterprise workspace with 14 days of full
// access. Existing explicit environment codes remain as a short-lived
// compatibility path while enterprise invitations replace them. A test-only
// default is allowed outside production, never as a deployed backdoor.
const DEFAULT_ENTERPRISE_ACCESS_CODES = process.env.NODE_ENV === 'production' ? [] : ['TEST2026'];

/** Canonicalize a code the same way the signup form does (upper, no spaces). */
export function normalizeEnterpriseAccessCode(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '');
}

/** The legacy allow-list: test defaults outside production ∪ explicit env codes. */
export function enterpriseAccessCodeSet() {
  const fromEnv = String(process.env.ENTERPRISE_ACCESS_CODES || '')
    .split(',')
    .map((code) => normalizeEnterpriseAccessCode(code))
    .filter(Boolean);
  return new Set([
    ...DEFAULT_ENTERPRISE_ACCESS_CODES.map(normalizeEnterpriseAccessCode),
    ...fromEnv,
  ]);
}

/** True iff `value` is a currently-valid enterprise access code. */
export function isValidEnterpriseAccessCode(value) {
  const code = normalizeEnterpriseAccessCode(value);
  if (!code) return false;
  return enterpriseAccessCodeSet().has(code);
}
