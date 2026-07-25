// ── Outreach Contract v1 — the universal HyperAgent → TARA handoff ──────────
//
// One provider-neutral envelope that ANY voice/messaging provider can execute.
// The OS (HyperAgents room / round-table report) emits it; a provider adapter
// (tara-deepgram, tara-grok, a future vendor, or the user's own browser)
// fulfils it. Nothing in here is provider-specific: `provider.preferred` is a
// HINT, not a requirement, and `delivery.mode` says how it can actually be
// carried out right now.
//
// Why versioned: the seam is consumed by two runtimes (JS core + the Python
// sidecar) and by adapters we don't control. Readers MUST accept vN and vN-1
// and ignore unknown fields rather than fail — that is what lets a new provider
// "take it forward" without a lock-step deploy.

export const OUTREACH_CONTRACT_VERSION = 1;

/** Channels the contract can describe. Adapters advertise which they fulfil. */
export const OUTREACH_CHANNELS = new Set(['call', 'email']);

/**
 * How a contract can be carried out.
 *  - `telephony` — the provider dials PSTN/SIP itself (adapter POST /calls/outbound)
 *  - `browser`   — no telephony wired: hand the contract to the USER's browser
 *                  voice session; they press Call and TARA runs the same goal
 *  - `email`     — delivered over the connected mailbox
 */
export const DELIVERY_MODES = new Set(['telephony', 'browser', 'email']);

const str = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

/**
 * Build the canonical contract. Pure — no I/O, no provider calls — so both the
 * proposal path (preview in the approval popup) and the execution path emit an
 * IDENTICAL document. A human approves exactly what runs.
 *
 * @param {object} o
 * @param {object} o.campaign  OutreachCampaign row (channel, org/user, voice snapshot)
 * @param {object} o.target    OutreachTarget row (company/phone/email/payload)
 * @param {object} [o.delivery] { mode, reason } from resolveDelivery()
 * @param {string} [o.voiceId] resolved provider voice id (optional)
 * @param {string} [o.skillId] TARA skill selected for this contract (optional)
 * @param {Date}   [o.now]
 */
export function buildOutreachContract({ campaign, target, delivery, voiceId = null, skillId = null, now = new Date() }) {
  const payload = target?.payload || {};
  const channel = OUTREACH_CHANNELS.has(campaign?.channel) ? campaign.channel : 'call';
  const mode = DELIVERY_MODES.has(delivery?.mode)
    ? delivery.mode
    : (channel === 'email' ? 'email' : 'telephony');

  return {
    contract_version: OUTREACH_CONTRACT_VERSION,
    contract_id: target?.id || null,
    campaign_id: campaign?.id || null,
    room_id: campaign?.roomId || null,
    turn_id: campaign?.turnId || null,
    issued_at: now.toISOString(),
    org_id: campaign?.orgId || null,
    user_id: campaign?.userId || null,
    channel,

    // WHO to reach. Provider-neutral identifiers only.
    target: {
      company: str(target?.company, 300),
      phone: str(target?.phone, 40) || null,
      email: str(target?.email, 320) || null,
      website: str(target?.website, 500) || null,
      address: str(target?.address, 500) || null,
    },

    // WHAT to achieve. This is the part TARA reasons against; every provider
    // gets the same objective so outcomes stay comparable across vendors.
    objective: {
      goal: str(payload.goal, 2000),
      opener: str(payload.opener, 1000) || null,
      strategy: str(payload.strategy, 2000) || null,
      // Compat: the directive is the flattened form legacy adapters already accept.
      directive: [
        str(payload.goal, 2000),
        payload.opener ? `Open with: ${str(payload.opener, 1000)}` : null,
        payload.strategy ? `Strategy: ${str(payload.strategy, 2000)}` : null,
      ].filter(Boolean).join('. '),
      subject: channel === 'email' ? str(payload.subject, 300) || null : null,
      body: channel === 'email' ? str(payload.body, 20000) || null : null,
    },

    // HOW it should sound. voice_id is provider-specific and therefore optional —
    // an adapter that doesn't know the id falls back to its own default.
    persona: {
      skill_id: skillId || null,
      language: str(payload.language, 8) || 'en',
      voice_style: str(payload.voice_style, 60) || null,
      voice_id: voiceId || null,
    },

    // Preferred provider — a HINT. Any adapter may fulfil the contract.
    provider: {
      preferred: campaign?.voiceProvider || null,
      config_revision: campaign?.voiceConfigSnapshot?.revision || null,
    },

    delivery: { mode, reason: str(delivery?.reason, 200) || null },

    constraints: {
      // First contact is always human-gated; the drain only sends 'running'.
      requires_human_start: true,
      single_flight: true,
    },
  };
}

/**
 * Decide how this contract can actually be executed right now.
 *
 * Telephony is NOT a given: an adapter may ship voice without a PSTN bridge
 * (tara-grok does exactly this today — it has no /calls/outbound). Rather than
 * hard-failing the campaign, fall back to `browser`: the contract is parked for
 * the user to run from their own browser voice session, with the same goal,
 * language and voice.
 *
 * @param {object} o
 * @param {string} o.channel
 * @param {object} o.capabilities  { telephony:boolean, browser:boolean }
 * @returns {{mode:string, reason:string|null}}
 */
export function resolveDelivery({ channel, capabilities }) {
  if (channel === 'email') return { mode: 'email', reason: null };
  if (capabilities?.telephony) return { mode: 'telephony', reason: null };
  return {
    mode: 'browser',
    reason: 'provider has no telephony bridge — run this call from the browser',
  };
}
