/**
 * Policy engine for Digital Employee actions.
 *
 * Every outbound action (slack_post, slack_react, slack_dm, etc.) is
 * checked here before SlackBridge executes it. Persists an ActionIntent
 * row with the result so we have a durable audit + replay trail.
 *
 * Policy rules live in DigitalEmployee.policyRules JSON:
 *   {
 *     allowed_channels: ["C123","C456"],         // optional allowlist
 *     blocked_channels: ["C789"],                // optional denylist
 *     blocked_actions:  ["slack_dm"],            // action type denylist
 *     rate_limit_per_min: 30,                    // per-employee
 *     work_hours: { tz: "UTC", start: 9, end: 18, days: [1,2,3,4,5] }
 *   }
 */

const DEFAULT_RATE_LIMIT = 30;

function inWorkHours(rules) {
  const wh = rules?.work_hours;
  if (!wh) return true;
  const now = new Date();
  // Naive UTC-only check (full tz handling deferred until Phase 3)
  const day = now.getUTCDay() === 0 ? 7 : now.getUTCDay(); // 1=Mon..7=Sun
  const hour = now.getUTCHours();
  if (Array.isArray(wh.days) && !wh.days.includes(day)) return false;
  if (typeof wh.start === 'number' && hour < wh.start) return false;
  if (typeof wh.end === 'number' && hour >= wh.end) return false;
  return true;
}

export async function checkPolicy({ intent, employee, redis }) {
  const rules = employee.policyRules || {};

  // 1. Action type denied
  if (Array.isArray(rules.blocked_actions) && rules.blocked_actions.includes(intent.actionType)) {
    return { allowed: false, reason: 'action_blocked', detail: `${intent.actionType} not permitted` };
  }

  // 2. Channel allow/deny list (for slack_* actions with .channel)
  const channel = intent.payload?.channel;
  if (channel) {
    if (Array.isArray(rules.allowed_channels) && rules.allowed_channels.length > 0
        && !rules.allowed_channels.includes(channel)) {
      return { allowed: false, reason: 'channel_not_allowed', detail: channel };
    }
    if (Array.isArray(rules.blocked_channels) && rules.blocked_channels.includes(channel)) {
      return { allowed: false, reason: 'channel_blocked', detail: channel };
    }
    // Also enforce the employee's slackChannelsAllowed list if set
    if (Array.isArray(employee.slackChannelsAllowed) && employee.slackChannelsAllowed.length > 0
        && !employee.slackChannelsAllowed.includes(channel)) {
      return { allowed: false, reason: 'channel_not_in_employee_allowlist', detail: channel };
    }
  }

  // 3. Work-hours gate
  if (!inWorkHours(rules)) {
    return { allowed: false, reason: 'outside_work_hours' };
  }

  // 4. Rate limit — Redis sliding minute window
  if (redis) {
    const limit = rules.rate_limit_per_min || DEFAULT_RATE_LIMIT;
    const minuteBucket = Math.floor(Date.now() / 60_000);
    const key = `rate:emp:${employee.id}:${minuteBucket}`;
    try {
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, 120);
      if (count > limit) {
        return { allowed: false, reason: 'rate_limit_exceeded', detail: `${count}/${limit}` };
      }
    } catch (err) {
      // Fail-open on Redis error so a flaky Redis can't kill all agents
      console.warn('[policy] redis rate-limit check failed, allowing:', err.message);
    }
  }

  return { allowed: true };
}

/**
 * Persist an ActionIntent row. Returns the created intent.
 */
export async function recordIntent({ prisma, employee, intent, status, denyReason, result }) {
  return prisma.actionIntent.create({
    data: {
      employeeId: employee.id,
      actionType: intent.actionType,
      payload: intent.payload || {},
      status,
      denyReason: denyReason || null,
      executedAt: status === 'executed' ? new Date() : null,
      result: result || null,
    },
  });
}
