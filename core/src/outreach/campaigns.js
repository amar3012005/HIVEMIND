// Outreach campaign runner — durable batch email/call campaigns over the Places
// prospects of a sealed HyperAgents turn.
//
// Hybrid control model:
//   - Created atomically when the user clicks "Send outreach emails"/"Start
//     outreach calls" (snapshot of eligible prospects → outreach_targets rows).
//   - The FE drives the one-by-one loop (generate → execute per target) and the
//     progress bar while the tab is open; every route bumps lastTickAt.
//   - A drain interval takes over campaigns whose lastTickAt goes stale (tab
//     died) and finishes the remaining targets server-side, honoring the same
//     pacing rules. Idempotency is ledger-first: a target is only ever sent once.
//
// The single-shot send paths are REUSED, not forked: email goes through the same
// core google-exec gmail_send bridge as /send-email; calls go through the same
// tara-deepgram /calls/outbound as /call. OutboundAction stays the sent-truth
// ledger (reply-match + outcomes strip pick campaign sends up for free).
//
// Spec: docs/superpowers/specs/2026-07-16-outreach-campaign-runner-design.md

import { outreachKillSwitchActive, outreachDailyCap, outreachAutonomyEnabled, assertAutonomousSendAllowed, outreachAutoProposeEnabled } from './outreach-contract.js';
import { buildOutreachContract, resolveDelivery } from './contract.js';

// ── Provider capability probe ───────────────────────────────────────────────
// Telephony is NOT guaranteed: an adapter can ship realtime voice with no PSTN
// bridge (tara-grok does exactly that — it has no /calls/outbound, so dialing it
// 404s and the campaign target hard-fails). Ask the adapter what it supports,
// cache it, and let the caller fall back to a browser-run call.
const CAPABILITY_TTL_MS = 5 * 60 * 1000;
const _capabilityCache = new Map(); // baseUrl → { value, expiresAt }

async function providerCapabilities(baseUrl) {
  const hit = _capabilityCache.get(baseUrl);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  let value = null;
  try {
    const res = await fetch(`${baseUrl}/capabilities`, { signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      const data = await res.json();
      value = { telephony: !!data?.telephony, browser: data?.browser !== false };
    }
  } catch { /* adapter down or older build — fall through to the probe below */ }
  if (!value) {
    // Older adapters have no /capabilities. Probe the dial route itself: a
    // POST-only route answers 405 to GET (exists); a missing one answers 404.
    try {
      const res = await fetch(`${baseUrl}/calls/outbound`, { method: 'GET', signal: AbortSignal.timeout(4000) });
      value = { telephony: res.status !== 404, browser: true };
    } catch {
      value = { telephony: false, browser: true };
    }
  }
  _capabilityCache.set(baseUrl, { value, expiresAt: Date.now() + CAPABILITY_TTL_MS });
  return value;
}

const EMAIL_RE = /^[\w.+-]+@[\w.-]+\.\w+$/;
const E164_RE = /^\+[1-9]\d{6,14}$/;
const MAX_TARGETS = 50;
const EMAIL_PACE_MS = 8000; // min gap between email sends per campaign (Gmail heuristics)
const DRAIN_STALE_MS = 5 * 60 * 1000; // FE silent this long → drain takes over
const SENDING_STUCK_MS = 10 * 60 * 1000; // 'sending' older than this → ledger-check
const DRAIN_EVERY_MS = 2 * 60 * 1000;

/**
 * Wire the outreach routes + drain loop. `deps` supplies the control-plane's own
 * primitives so this module never duplicates auth/ledger/config logic:
 *   { prisma, CONFIG, getInternalApiKey, jsonResponse, parseBody,
 *     requireSession, recordOutboundAction, sidecarBaseUrl, taraProviderFor }
 */
export function createOutreachModule(deps) {
  const {
    prisma, CONFIG, getInternalApiKey, jsonResponse, parseBody,
    requireSession, recordOutboundAction, sidecarBaseUrl, taraProviderFor,
  } = deps;

  // ── snapshot: latest prospects event per query from the sealed turn ────────
  function prospectsFromTurn(lines) {
    const byQuery = {};
    for (const l of (Array.isArray(lines) ? lines : [])) {
      if (l && l.t === 'prospects' && Array.isArray(l.prospects)) byQuery[l.query || '_'] = l;
    }
    return Object.values(byQuery).flatMap((ev) => ev.prospects || []);
  }

  async function connectedGmail(userId) {
    try {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT platform_user_id FROM "hivemind"."platform_integrations"
          WHERE user_id = $1::uuid AND platform_type = 'gmail' AND platform_user_id IS NOT NULL
          ORDER BY updated_at DESC NULLS LAST LIMIT 1`, userId,
      );
      const v = rows?.[0]?.platform_user_id;
      return v && String(v).includes('@') ? String(v).trim() : null;
    } catch { return null; }
  }

  async function loadCampaign(id, orgId, withTargets = true) {
    return prisma.outreachCampaign.findFirst({
      where: { id, orgId },
      include: withTargets ? { targets: { orderBy: { position: 'asc' } } } : undefined,
    });
  }

  const tick = (id) => prisma.outreachCampaign.update({
    where: { id }, data: { lastTickAt: new Date() },
  }).catch(() => {});

  // Resolve a concrete Cartesia voice_id from the contract's language + tone. Fetches
  // TARA's live voice catalog (GET /voices?language=), cached 1h. Prefers a feminine voice
  // (TARA's persona) for warm/friendly tones, else the first for that language. Returns null
  // on any failure → TARA resolves a language-appropriate default itself (never blocks a call).
  const _voiceCache = { at: 0, byLang: {} };
  async function resolveVoiceId(orgId, language, voiceStyle) {
    try {
      const lang = String(language || 'en').slice(0, 8);
      if (Date.now() - _voiceCache.at > 3600000) { _voiceCache.byLang = {}; _voiceCache.at = Date.now(); }
      if (!_voiceCache.byLang[lang]) {
        const provider = await taraProviderFor(orgId);
        const r = await fetch(`${provider.baseUrl}/voices?language=${encodeURIComponent(lang)}`,
          { signal: AbortSignal.timeout(6000) }).catch(() => null);
        const j = r && r.ok ? await r.json().catch(() => null) : null;
        _voiceCache.byLang[lang] = Array.isArray(j) ? j : (Array.isArray(j?.voices) ? j.voices : []);
      }
      const voices = _voiceCache.byLang[lang] || [];
      if (!voices.length) return null;
      const style = String(voiceStyle || '').toLowerCase();
      const wantFem = !/formal|crisp|authorit|deep/.test(style); // default to TARA's feminine persona
      const pick = voices.find((v) => wantFem && String(v.gender || '').toLowerCase().startsWith('fem'))
        || voices[0];
      return pick?.id || null;
    } catch { return null; }
  }

  // ── per-target generation (proxies to the employees sidecar LLM) ───────────
  async function generateTarget(campaign, target) {
    await prisma.outreachTarget.update({ where: { id: target.id }, data: { state: 'generating' } });
    try {
      const r = await fetch(`${sidecarBaseUrl}/outreach/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel: campaign.channel,
          turn_id: campaign.turnId,
          sender_email: campaign.senderEmail || '',
          user_id: campaign.userId, org_id: campaign.orgId,
          prospect: {
            company: target.company, email: target.email, phone: target.phone,
            website: target.website, address: target.address,
          },
        }),
        signal: AbortSignal.timeout(90000),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j || j.error) throw new Error(j?.error || `generate failed (${r.status})`);
      const payload = campaign.channel === 'email'
        ? { subject: String(j.subject || '').slice(0, 500), body: String(j.body || '') }
        : {
            goal: String(j.goal || '').slice(0, 300), opener: String(j.opener || '').slice(0, 400),
            // Prospect brief (firm + why-fit + prior-call learnings) — rides the
            // dial as TARA's [PROSPECT CONTEXT] so the strategist isn't blind.
            ...(j.context ? { context: String(j.context).slice(0, 800) } : {}),
            // Auto-selected call contract (P: TARA-from-contract): language + conversation
            // strategy + voice tone — chosen by the contract generator, resolved to a concrete
            // Cartesia voice at dial time. Drives voice/language/strategy automatically.
            language: String(j.language || 'en').slice(0, 8),
            ...(j.strategy ? { strategy: String(j.strategy).slice(0, 200) } : {}),
            ...(j.voice_style ? { voice_style: String(j.voice_style).slice(0, 40) } : {}),
          };
      if (campaign.channel === 'email' && (!payload.subject || !payload.body)) throw new Error('empty email payload');
      if (campaign.channel === 'call' && !payload.goal) throw new Error('empty call goal');
      return prisma.outreachTarget.update({
        where: { id: target.id }, data: { state: 'ready', payload },
      });
    } catch (err) {
      await prisma.outreachTarget.update({
        where: { id: target.id },
        data: { state: 'failed', resultRef: { error: `generate: ${String(err.message).slice(0, 300)}` } },
      });
      throw err;
    }
  }

  // ── execute lanes (shared by the FE route and the drain worker) ────────────
  async function executeEmail(campaign, target) {
    // Idempotency: the ledger is send-truth — never resend a target that has one.
    if (target.resultRef?.outboundActionId) return target;
    const payload = target.payload || {};
    if (!target.email || !EMAIL_RE.test(target.email)) throw new Error('target has no valid email');
    if (!payload.subject || !payload.body) throw new Error('target payload not generated');
    // Cross-campaign dedup — HARD guard: this org already emailed this address
    // (any prior campaign, any prior turn). Never contact the same client twice.
    const already = await prisma.$queryRawUnsafe(
      `SELECT id, sent_at FROM "hivemind"."outbound_actions"
        WHERE org_id = $1::uuid AND channel = 'email' AND status = 'sent'
          AND lower(recipient) = lower($2) LIMIT 1`,
      campaign.orgId, target.email,
    ).catch(() => []);
    if (already?.length) {
      const when = already[0].sent_at ? new Date(already[0].sent_at).toISOString().slice(0, 10) : 'earlier';
      return prisma.outreachTarget.update({
        where: { id: target.id },
        data: {
          state: 'skipped',
          resultRef: { skipped: `already emailed ${target.email} (${when}) — not re-sent`, dedupOf: already[0].id },
        },
      });
    }
    // Pace: min gap since this campaign's last successful email send.
    const last = await prisma.outreachTarget.findFirst({
      where: { campaignId: campaign.id, state: 'sent' }, orderBy: { updatedAt: 'desc' },
    });
    if (last && Date.now() - new Date(last.updatedAt).getTime() < EMAIL_PACE_MS) {
      const wait = EMAIL_PACE_MS - (Date.now() - new Date(last.updatedAt).getTime());
      const err = new Error(`pacing: retry in ${Math.ceil(wait / 1000)}s`);
      err.retryable = true; err.status = 429;
      throw err;
    }
    await prisma.outreachTarget.update({ where: { id: target.id }, data: { state: 'sending' } });
    const r = await fetch(`${CONFIG.coreApiBaseUrl}/api/connectors/google/exec`, {
      method: 'POST',
      headers: {
        'X-API-Key': getInternalApiKey(),
        'X-HM-User-Id': campaign.userId, 'X-HM-Org-Id': campaign.orgId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tool: 'gmail_send',
        arguments: { to: target.email, subject: payload.subject, body: payload.body, markdown: true },
      }),
      signal: AbortSignal.timeout(60000),
    });
    const tx = await r.text();
    let result; try { result = JSON.parse(tx); } catch { result = { raw: tx }; }
    if (!r.ok) {
      const authDead = r.status === 401 || /invalid_grant|invalid credentials|401/i.test(tx);
      await prisma.outreachTarget.update({
        where: { id: target.id },
        data: { state: 'failed', resultRef: { error: `gmail send failed (${r.status})${authDead ? ' — reconnect Gmail' : ''}` } },
      });
      if (authDead) {
        // Token dead — pause the whole campaign instead of burning every target.
        await prisma.outreachCampaign.update({ where: { id: campaign.id }, data: { status: 'paused' } });
        const err = new Error('gmail-reauth'); err.status = 401; throw err;
      }
      throw new Error(`gmail send failed (${r.status})`);
    }
    const action = await recordOutboundAction({
      orgId: campaign.orgId, userId: campaign.userId, roomId: campaign.roomId,
      channel: 'email', recipient: target.email, subject: payload.subject,
      messageId: result?.id || null, threadId: result?.threadId || null,
      meta: { via: 'outreach-campaign', campaign_id: campaign.id, target_id: target.id },
    }).catch(() => null);
    return prisma.outreachTarget.update({
      where: { id: target.id },
      data: {
        state: 'sent',
        resultRef: { outboundActionId: action?.id || true, messageId: result?.id || null, threadId: result?.threadId || null },
      },
    });
  }

  async function executeCall(campaign, target) {
    if (target.resultRef?.taraCallLegId) return target; // already dialed
    const payload = target.payload || {};
    if (!target.phone || !E164_RE.test(String(target.phone).replace(/[\s()/-]/g, ''))) {
      throw new Error('target has no valid E.164 phone');
    }
    if (!payload.goal) throw new Error('target call goal not generated');
    // TARA is one voice — strictly serial per campaign.
    const inFlight = await prisma.outreachTarget.findFirst({
      where: { campaignId: campaign.id, state: 'sending', NOT: { id: target.id } },
    });
    if (inFlight) { const err = new Error('another call in this campaign is in flight'); err.status = 409; throw err; }
    await prisma.outreachTarget.update({ where: { id: target.id }, data: { state: 'sending' } });
    const to = String(target.phone).replace(/[\s()/-]/g, '');
    const sessionId = `outreach-${target.id.slice(0, 8)}-${Date.now()}`;
    // Directive folds goal + opener + the auto-selected conversation strategy so TARA's
    // strategist plans with intent.
    const directive = [
      payload.goal,
      payload.opener ? `Open with: ${payload.opener}` : null,
      payload.strategy ? `Strategy: ${payload.strategy}` : null,
    ].filter(Boolean).join('. ');
    // Auto-select voice from the contract (language + tone). Best-effort; null → TARA default.
    const language = String(payload.language || 'en').slice(0, 8);
    const voiceId = await resolveVoiceId(campaign.orgId, language, payload.voice_style);
    const provider = campaign.voiceProvider
      ? { provider: campaign.voiceProvider, revision: campaign.voiceConfigSnapshot?.revision || 1, config: campaign.voiceConfigSnapshot || {}, baseUrl: campaign.voiceProvider === 'grok' ? CONFIG.taraGrokBaseUrl : CONFIG.taraDeepgramBaseUrl }
      : await taraProviderFor(campaign.orgId);

    // ── Telephony present? If not, hand the contract to the user's browser ──
    // Previously this dialed unconditionally: against a provider with no PSTN
    // bridge the POST 404s and the target dies as 'failed'. Instead park it as
    // 'browser' carrying the SAME universal contract, so the user can run the
    // call from their own voice session with the identical goal/voice/language.
    const capabilities = await providerCapabilities(provider.baseUrl);
    const delivery = resolveDelivery({ channel: 'call', capabilities });
    if (delivery.mode === 'browser') {
      const contract = buildOutreachContract({
        campaign, target, delivery, voiceId,
        skillId: campaign.voiceConfigSnapshot?.skill_id || null,
      });
      const updated = await prisma.outreachTarget.update({
        where: { id: target.id },
        data: {
          state: 'browser',
          payload: { ...payload, contract },
          resultRef: {
            ...(target.resultRef || {}),
            delivery: 'browser',
            provider: provider.provider,
            reason: delivery.reason,
          },
        },
      });
      console.log(JSON.stringify({
        svc: 'outreach', level: 'info', event: 'call_handoff_browser',
        campaign_id: campaign.id, target_id: target.id, provider: provider.provider,
      }));
      return updated;
    }

    const r = await fetch(`${provider.baseUrl}/calls/outbound`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(provider.provider === 'deepgram' && process.env.TARA_DG_API_KEY ? { 'X-TARA-Key': process.env.TARA_DG_API_KEY } : {}),
      },
      body: JSON.stringify({
        to, session_id: sessionId, user_id: campaign.userId, org_id: campaign.orgId,
        goal: String(directive).slice(0, 600),
        // Auto-selected call contract: language + concrete Cartesia voice (TARA resolves a
        // language default when voice_id is null).
        language,
        voice_id: voiceId || undefined,
        // Full prospect metadata contract — TARA plans + speaks around WHO it's
        // calling (firm brief + why-fit + prior-call learnings from generate).
        context: payload.context ? String(payload.context).slice(0, 800) : undefined,
        contact_name: target.company ? String(target.company).slice(0, 120) : undefined,
        provider: provider.provider,
        config_revision: provider.revision,
      }),
      signal: AbortSignal.timeout(20000),
    }).catch(() => null);
    if (!r) {
      await prisma.outreachTarget.update({
        where: { id: target.id }, data: { state: 'failed', resultRef: { error: 'TARA outbound service unreachable' } },
      });
      throw new Error('TARA outbound service unreachable');
    }
    const tx = await r.text();
    let result; try { result = JSON.parse(tx); } catch { result = { raw: tx }; }
    if (!r.ok) {
      await prisma.outreachTarget.update({
        where: { id: target.id },
        data: { state: 'failed', resultRef: { error: String(result?.error || `dial failed (${r.status})`).slice(0, 300) } },
      });
      const err = new Error(result?.error || `dial failed (${r.status})`); err.status = r.status === 400 ? 400 : 502; throw err;
    }
    recordOutboundAction({
      orgId: campaign.orgId, userId: campaign.userId, roomId: campaign.roomId,
      channel: 'call', recipient: to, messageId: result?.call_leg_id || null,
      meta: { via: 'outreach-campaign', campaign_id: campaign.id, target_id: target.id, session_id: sessionId, provider: provider.provider, goal: payload.goal, company: target.company || undefined },
    }).catch(() => {});
    // Dial success = executed (v1). Call OUTCOME (completed/booked/no-answer)
    // lands on the OutboundAction via the existing /api/tara/calls/end path.
    return prisma.outreachTarget.update({
      where: { id: target.id },
      data: { state: 'sent', resultRef: { taraCallLegId: result?.call_leg_id || null, sessionId } },
    });
  }

  // P6 Outreach Contract — the send choke point for BOTH the FE lane and the autonomous
  // drain worker. Honors the kill switch (instant all-outreach stop) and a per-org daily cap.
  // Skip-not-throw (mirrors the dedup path): a blocked target is marked 'skipped' with a reason
  // so the campaign advances cleanly. Defaults (kill off, cap 0) are behavior-neutral.
  async function executeTarget(c, t) {
    if (outreachKillSwitchActive()) {
      return prisma.outreachTarget.update({
        where: { id: t.id },
        data: { state: 'skipped', resultRef: { skipped: 'outreach kill switch engaged — not sent', blockedBy: 'kill_switch' } },
      }).catch(() => t);
    }
    const cap = outreachDailyCap();
    if (cap) {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM "hivemind"."outbound_actions"
          WHERE org_id = $1::uuid AND status = 'sent' AND sent_at >= now() - interval '1 day'`,
        c.orgId,
      ).catch(() => [{ n: 0 }]);
      const sentToday = rows?.[0]?.n || 0;
      if (sentToday >= cap) {
        return prisma.outreachTarget.update({
          where: { id: t.id },
          data: { state: 'skipped', resultRef: { skipped: `daily outreach cap reached (${cap})`, blockedBy: 'daily_cap' } },
        }).catch(() => t);
      }
    }
    return c.channel === 'email' ? executeEmail(c, t) : executeCall(c, t);
  }

  // ── drain worker: finish campaigns whose FE went away ──────────────────────
  async function drainOnce() {
    // P6 — autonomous execution switch. When off, the FE must drive every send (no
    // background autonomy). Default on. Kill switch also short-circuits all sending.
    if (!outreachAutonomyEnabled() || outreachKillSwitchActive()) return;
    const stale = new Date(Date.now() - DRAIN_STALE_MS);
    const campaigns = await prisma.outreachCampaign.findMany({
      where: { status: 'running', lastTickAt: { lt: stale } },
      include: { targets: { orderBy: { position: 'asc' } } },
      take: 5,
    });
    for (const c of campaigns) {
      // First-contact-HITL invariant: only auto-advance a human-authorized running
      // campaign — never cold-originate. (Redundant with the query filter, but the
      // contract is the single place the invariant is asserted + auditable.)
      const gate = assertAutonomousSendAllowed({ campaign: c });
      if (!gate.allowed) continue;
      try {
        // Un-stick: 'sending' older than SENDING_STUCK_MS → the ledger decides.
        for (const t of c.targets.filter((x) => x.state === 'sending'
            && Date.now() - new Date(x.updatedAt).getTime() > SENDING_STUCK_MS)) {
          const sent = await prisma.$queryRawUnsafe(
            `SELECT id FROM "hivemind"."outbound_actions"
              WHERE org_id = $1::uuid AND meta->>'target_id' = $2 LIMIT 1`, c.orgId, t.id,
          ).catch(() => []);
          await prisma.outreachTarget.update({
            where: { id: t.id },
            data: sent?.length
              ? { state: 'sent', resultRef: { outboundActionId: sent[0].id, recoveredByDrain: true } }
              : { state: 'selected', resultRef: null }, // never actually left — safe to redo
          });
        }
        const fresh = await loadCampaign(c.id, c.orgId);
        const pending = fresh.targets.filter((t) => ['selected', 'ready'].includes(t.state));
        for (const t of pending) {
          if ((await prisma.outreachCampaign.findFirst({ where: { id: c.id }, select: { status: true } }))?.status !== 'running') break;
          try {
            let target = t;
            if (target.state === 'selected') target = await generateTarget(fresh, target);
            if (c.channel === 'email') {
              const gap = Date.now() % EMAIL_PACE_MS; // simple pacing between drain sends
              await new Promise((ok) => { setTimeout(ok, EMAIL_PACE_MS - gap + 250); });
            }
            await executeTarget(fresh, await prisma.outreachTarget.findFirst({ where: { id: target.id } }));
          } catch (err) {
            if (err.status === 401) break; // campaign was auto-paused (gmail reauth)
            console.warn('[outreach-drain] target failed:', t.id, err.message);
          }
        }
        await finalizeIfDone(c.id, c.orgId);
      } catch (err) { console.warn('[outreach-drain] campaign error:', c.id, err.message); }
    }
  }

  async function finalizeIfDone(id, orgId) {
    const c = await loadCampaign(id, orgId);
    if (!c || c.status !== 'running') return;
    const open = c.targets.some((t) => ['selected', 'ready', 'generating', 'sending'].includes(t.state));
    if (!open) {
      await prisma.outreachCampaign.update({
        where: { id }, data: { status: 'done', finishedAt: new Date() },
      });
    }
  }

  function startDrain() {
    const h = setInterval(() => { drainOnce().catch((e) => console.warn('[outreach-drain]', e.message)); }, DRAIN_EVERY_MS);
    h.unref?.();
    return h;
  }

  // ── HTTP handler — returns true when the request was handled ───────────────
  async function handle(req, res, pathname) {
    // POST /internal/hyper/outreach/propose { room_id, turn_id, channel } — P6 human-approved
    // auto-generation. The OS assembles a QUEUED (proposed) campaign from a turn's eligible
    // prospects; it is NEVER auto-started — a human must Start it (first-contact HITL), and the
    // drain only ever sends 'running'. Internal-auth + flag-gated (HYPER_OUTREACH_AUTO_PROPOSE).
    if (pathname === '/internal/hyper/outreach/propose' && req.method === 'POST') {
      if (!outreachAutoProposeEnabled()) {
        return jsonResponse(res, { error: 'outreach auto-propose is disabled', code: 'autopropose_disabled' }, 403), true;
      }
      const key = String(req.headers['x-api-key'] || '').trim();
      if (!key || key !== getInternalApiKey()) return jsonResponse(res, { error: 'unauthorized' }, 401), true;
      const body = await parseBody(req).catch(() => ({}));
      const channel = String(body.channel || '').trim();
      const roomId = String(body.room_id || '').trim();
      const turnId = String(body.turn_id || '').trim();
      if (!['email', 'call'].includes(channel) || !/^[0-9a-f-]{36}$/.test(roomId) || !/^[0-9a-f-]{36}$/.test(turnId)) {
        return jsonResponse(res, { error: 'room_id, turn_id and channel(email|call) are required' }, 400), true;
      }
      const room = await prisma.hyperRoom.findFirst({ where: { id: roomId, archivedAt: null } });
      if (!room) return jsonResponse(res, { error: 'room not found' }, 404), true;
      const turn = await prisma.hyperTurn.findFirst({ where: { id: turnId, roomId: room.id } });
      if (!turn) return jsonResponse(res, { error: 'turn not found' }, 404), true;
      // Prospects: an EXPLICIT prospect (an agent's propose_call decision — "call THIS firm")
      // takes precedence; otherwise derive the stack from the turn's discovered prospects.
      const explicit = Array.isArray(body.prospects) ? body.prospects
        : (body.prospect && typeof body.prospect === 'object' ? [body.prospect] : null);
      const all = explicit || prospectsFromTurn(turn.lines);
      const eligible = all.filter((p) => (channel === 'email'
        ? p.email && EMAIL_RE.test(p.email)
        : p.phone && E164_RE.test(String(p.phone).replace(/[\s()/-]/g, '')))).slice(0, MAX_TARGETS);
      if (!eligible.length) return jsonResponse(res, { error: `no ${channel}-eligible prospect(s)` }, 400), true;
      const senderEmail = channel === 'email' ? await connectedGmail(room.userId) : null;
      const voice = channel === 'call' ? await taraProviderFor(room.orgId) : null;
      const campaign = await prisma.outreachCampaign.create({
        data: {
          roomId: room.id, turnId, userId: room.userId, orgId: room.orgId,
          channel, senderEmail,
          ...(voice ? { voiceProvider: voice.provider, voiceConfigSnapshot: { revision: voice.revision, ...voice.config } } : {}),
          status: 'queued',       // PROPOSED — a human must Start it (first-contact HITL)
          lastTickAt: null,       // not live; drain ignores non-'running' anyway
          targets: {
            create: eligible.map((p, i) => ({
              position: i,
              company: String(p.company || '').slice(0, 300),
              email: p.email ? String(p.email).slice(0, 320) : null,
              phone: p.phone ? String(p.phone).slice(0, 40) : null,
              website: p.website ? String(p.website).slice(0, 500) : null,
              address: p.address ? String(p.address).slice(0, 500) : null,
            })),
          },
        },
        include: { targets: { orderBy: { position: 'asc' } } },
      });
      // Generate the first target's CONTRACT up front (goal + strategy + auto voice/language)
      // so the approval popup shows the real plan the moment the OS decides. Best-effort —
      // the campaign stands even if generation is slow/failed (targets generate on Start too).
      let contract = null;
      try {
        const t0 = campaign.targets[0];
        if (t0) {
          const gen = await generateTarget(campaign, t0);
          const pl = gen?.payload || {};
          const voiceId = channel === 'call' ? await resolveVoiceId(room.orgId, pl.language, pl.voice_style) : null;
          const capabilities = voice ? await providerCapabilities(voice.baseUrl) : { telephony: false, browser: true };
          const delivery = resolveDelivery({ channel, capabilities });
          const universal = buildOutreachContract({
            campaign, target: gen, delivery, voiceId,
            skillId: campaign.voiceConfigSnapshot?.skill_id || null,
          });
          contract = {
            ...universal,
            prospect: t0.company || t0.email || t0.phone || null,
            goal: universal.objective.goal || null,
            strategy: universal.objective.strategy || null,
            language: universal.persona.language || 'en',
            voice_style: universal.persona.voice_style || null,
            voice_id: universal.persona.voice_id || null,
            targets: campaign.targets.length,
          };
        }
      } catch (e) { console.warn('[outreach-propose] contract gen failed (non-fatal):', e.message); }
      // Live popup hint: if the caller passed the room's callback_url, push a `call_contract`
      // event so the FE can surface the approval popup immediately (card fallback = the queued
      // campaign in the list). Approve = Start the campaign; Reject = stop/cancel.
      const cbUrl = String(body.callback_url || '').trim();
      if (cbUrl && contract) {
        fetch(cbUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-API-Key': getInternalApiKey() },
          body: JSON.stringify({ turn_id: turnId, event: { t: 'call_contract', campaign_id: campaign.id, contract } }),
          signal: AbortSignal.timeout(8000),
        }).catch(() => {});
      }
      return jsonResponse(res, {
        campaign, proposed: true, contract,
        note: 'Proposed (queued). Requires a human Start before any send — first-contact HITL.',
      }, 200), true;
    }

    // POST /v1/hyper-rooms/:roomId/outreach-campaigns — create (snapshot)
    let m = pathname.match(/^\/v1\/hyper-rooms\/([0-9a-f-]{36})\/outreach-campaigns$/);
    if (m && req.method === 'POST') {
      const current = await requireSession(req, res);
      if (!current) return true;
      const body = await parseBody(req).catch(() => ({}));
      const channel = String(body.channel || '').trim();
      const turnId = String(body.turn_id || '').trim();
      if (!['email', 'call'].includes(channel) || !/^[0-9a-f-]{36}$/.test(turnId)) {
        return jsonResponse(res, { error: 'channel (email|call) and turn_id are required' }, 400), true;
      }
      const room = await prisma.hyperRoom.findFirst({ where: { id: m[1], orgId: current.session.orgId, archivedAt: null } });
      if (!room) return jsonResponse(res, { error: 'Room not found' }, 404), true;
      const turn = await prisma.hyperTurn.findFirst({ where: { id: turnId, roomId: room.id } });
      if (!turn) return jsonResponse(res, { error: 'Turn not found' }, 404), true;
      const all = prospectsFromTurn(turn.lines);
      const eligible = all.filter((p) => (channel === 'email'
        ? p.email && EMAIL_RE.test(p.email)
        : p.phone && E164_RE.test(String(p.phone).replace(/[\s()/-]/g, '')))).slice(0, MAX_TARGETS);
      if (!eligible.length) return jsonResponse(res, { error: `no ${channel}-eligible prospects on this turn` }, 400), true;
      const senderEmail = channel === 'email' ? await connectedGmail(room.userId) : null;
      if (channel === 'email' && !senderEmail) {
        return jsonResponse(res, { error: 'no connected Gmail — connect Gmail to send outreach' }, 400), true;
      }
      const voice = channel === 'call' ? await taraProviderFor(room.orgId) : null;
      const campaign = await prisma.outreachCampaign.create({
        data: {
          roomId: room.id, turnId, userId: room.userId, orgId: room.orgId,
          channel, senderEmail, lastTickAt: new Date(),
          ...(voice ? { voiceProvider: voice.provider, voiceConfigSnapshot: { revision: voice.revision, ...voice.config } } : {}),
          targets: {
            create: eligible.map((p, i) => ({
              position: i,
              company: String(p.company || '').slice(0, 300),
              email: p.email ? String(p.email).slice(0, 320) : null,
              phone: p.phone ? String(p.phone).slice(0, 40) : null,
              website: p.website ? String(p.website).slice(0, 500) : null,
              address: p.address ? String(p.address).slice(0, 500) : null,
            })),
          },
        },
        include: { targets: { orderBy: { position: 'asc' } } },
      });
      // Pre-mark any target we've ALREADY emailed (any prior campaign) as skipped
      // so the panel shows "already emailed" up front and the run won't re-send.
      if (channel === 'email') {
        const emails = campaign.targets.map((t) => t.email).filter(Boolean);
        if (emails.length) {
          const prior = await prisma.$queryRawUnsafe(
            `SELECT DISTINCT lower(recipient) AS r FROM "hivemind"."outbound_actions"
              WHERE org_id = $1::uuid AND channel = 'email' AND status = 'sent'
                AND lower(recipient) = ANY($2::text[])`,
            room.orgId, emails.map((e) => e.toLowerCase()),
          ).catch(() => []);
          const seen = new Set((prior || []).map((x) => x.r));
          const dupes = campaign.targets.filter((t) => t.email && seen.has(t.email.toLowerCase()));
          if (dupes.length) {
            await prisma.outreachTarget.updateMany({
              where: { id: { in: dupes.map((t) => t.id) } },
              data: { state: 'skipped', resultRef: { skipped: 'already emailed — not re-sent' } },
            });
            const reloaded = await loadCampaign(campaign.id, room.orgId);
            return jsonResponse(res, { campaign: reloaded }, 200), true;
          }
        }
      }
      return jsonResponse(res, { campaign }, 200), true;
    }

    // GET /v1/outreach-campaigns/:id
    m = pathname.match(/^\/v1\/outreach-campaigns\/([0-9a-f-]{36})$/);
    if (m && req.method === 'GET') {
      const current = await requireSession(req, res);
      if (!current) return true;
      const c = await loadCampaign(m[1], current.session.orgId);
      if (!c) return jsonResponse(res, { error: 'Campaign not found' }, 404), true;
      return jsonResponse(res, { campaign: c }, 200), true;
    }

    // POST /v1/outreach-campaigns/:id/start | /stop
    m = pathname.match(/^\/v1\/outreach-campaigns\/([0-9a-f-]{36})\/(start|stop)$/);
    if (m && req.method === 'POST') {
      const current = await requireSession(req, res);
      if (!current) return true;
      const c = await loadCampaign(m[1], current.session.orgId, false);
      if (!c) return jsonResponse(res, { error: 'Campaign not found' }, 404), true;
      const want = m[2] === 'start' ? 'running' : 'paused';
      const legal = m[2] === 'start' ? ['queued', 'paused'] : ['running', 'queued'];
      if (!legal.includes(c.status)) return jsonResponse(res, { error: `cannot ${m[2]} a ${c.status} campaign` }, 409), true;
      const updated = await prisma.outreachCampaign.update({
        where: { id: c.id },
        data: { status: want, lastTickAt: new Date(), ...(m[2] === 'start' && !c.startedAt ? { startedAt: new Date() } : {}) },
      });
      return jsonResponse(res, { campaign: updated }, 200), true;
    }

    // PATCH /v1/outreach-campaigns/:id/targets/:tid — deselect/reselect + payload edit
    m = pathname.match(/^\/v1\/outreach-campaigns\/([0-9a-f-]{36})\/targets\/([0-9a-f-]{36})$/);
    if (m && req.method === 'PATCH') {
      const current = await requireSession(req, res);
      if (!current) return true;
      const c = await loadCampaign(m[1], current.session.orgId, false);
      if (!c) return jsonResponse(res, { error: 'Campaign not found' }, 404), true;
      const t = await prisma.outreachTarget.findFirst({ where: { id: m[2], campaignId: c.id } });
      if (!t) return jsonResponse(res, { error: 'Target not found' }, 404), true;
      if (['sending', 'sent'].includes(t.state)) return jsonResponse(res, { error: `target is ${t.state} — immutable` }, 409), true;
      const body = await parseBody(req).catch(() => ({}));
      const data = {};
      if (typeof body.selected === 'boolean') {
        data.state = body.selected ? 'selected' : 'deselected';
        if (body.selected && t.payload) data.state = 'ready'; // keep an edited payload
      }
      if (body.payload && typeof body.payload === 'object') {
        data.payload = c.channel === 'email'
          ? { subject: String(body.payload.subject || t.payload?.subject || '').slice(0, 500), body: String(body.payload.body || t.payload?.body || '') }
          : { goal: String(body.payload.goal || t.payload?.goal || '').slice(0, 300), opener: String(body.payload.opener || t.payload?.opener || '').slice(0, 400),
              // Inline edits never drop the generated prospect brief.
              ...(t.payload?.context ? { context: t.payload.context } : {}) };
        if (!data.state && t.state !== 'deselected') data.state = 'ready';
      }
      if (!Object.keys(data).length) return jsonResponse(res, { error: 'nothing to update' }, 400), true;
      const updated = await prisma.outreachTarget.update({ where: { id: t.id }, data });
      tick(c.id);
      return jsonResponse(res, { target: updated }, 200), true;
    }

    // POST /v1/outreach-campaigns/:id/targets/:tid/generate | /execute
    m = pathname.match(/^\/v1\/outreach-campaigns\/([0-9a-f-]{36})\/targets\/([0-9a-f-]{36})\/(generate|execute)$/);
    if (m && req.method === 'POST') {
      const current = await requireSession(req, res);
      if (!current) return true;
      const c = await loadCampaign(m[1], current.session.orgId, false);
      if (!c) return jsonResponse(res, { error: 'Campaign not found' }, 404), true;
      const t = await prisma.outreachTarget.findFirst({ where: { id: m[2], campaignId: c.id } });
      if (!t) return jsonResponse(res, { error: 'Target not found' }, 404), true;
      tick(c.id);
      try {
        if (m[3] === 'generate') {
          if (!['selected', 'failed', 'ready'].includes(t.state)) {
            return jsonResponse(res, { error: `cannot generate for a ${t.state} target` }, 409), true;
          }
          const updated = await generateTarget(c, t);
          return jsonResponse(res, { target: updated }, 200), true;
        }
        if (c.status !== 'running') return jsonResponse(res, { error: 'campaign is not running — press Start' }, 409), true;
        if (t.state !== 'ready') return jsonResponse(res, { error: `cannot execute a ${t.state} target` }, 409), true;
        const updated = await executeTarget(c, t);
        await finalizeIfDone(c.id, c.orgId);
        return jsonResponse(res, { target: updated }, 200), true;
      } catch (err) {
        return jsonResponse(res, { error: err.message, retryable: !!err.retryable }, err.status || 500), true;
      }
    }

    return false;
  }

  return { handle, startDrain, _internal: { prospectsFromTurn, executeTarget, generateTarget, drainOnce, finalizeIfDone } };
}
