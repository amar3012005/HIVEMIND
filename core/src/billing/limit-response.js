/** Pure HTTP response contract for enforced plan and credit limits. */
const PLAN_LADDER = { free: 'pro', pro: 'scale', scale: 'enterprise', enterprise_onboarding: 'enterprise', enterprise: null };

export function planLimitBody(check, resource) {
  const c = check || {};
  if (c.status === 503) {
    return {
      error: 'usage_verification_unavailable',
      code: 'usage_verification_unavailable',
      message: c.reason || 'Usage verification is temporarily unavailable',
      resource,
      retryable: true,
    };
  }
  const plan = c.plan || 'free';
  const suggested = Object.prototype.hasOwnProperty.call(PLAN_LADDER, plan)
    ? PLAN_LADDER[plan]
    : 'pro';
  const credits = resource === 'credits';
  return {
    error: credits ? 'credits_exhausted' : 'plan_limit_exceeded',
    code: credits ? 'credits_exhausted' : 'plan_limit_exceeded',
    message: c.reason || 'Plan limit exceeded',
    resource,
    plan,
    limit: c.limit ?? null,
    current: c.current ?? null,
    remaining: c.remaining ?? null,
    suggested_plan: suggested,
    upgrade_url: '/hivemind/app/billing',
  };
}
