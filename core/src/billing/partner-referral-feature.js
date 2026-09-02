export function partnerReferralsEnabled(env = process.env) {
  return String(env?.PARTNER_REFERRALS_ENABLED || '').trim().toLowerCase() === 'true';
}
