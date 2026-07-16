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
 *     requireSession, recordOutboundAction, sidecarBaseUrl }
 */
export function createOutreachModule(deps) {
  const {
    prisma, CONFIG, getInternalApiKey, jsonResponse, parseBody,
    requireSession, recordOutboundAction, sidecarBaseUrl,
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
        : { goal: String(j.goal || '').slice(0, 300), opener: String(j.opener || '').slice(0, 400) };
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
    const directive = payload.opener ? `${payload.goal}. Open with: ${payload.opener}` : payload.goal;
    const r = await fetch(`${CONFIG.taraDeepgramBaseUrl}/calls/outbound`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to, session_id: sessionId, user_id: campaign.userId, org_id: campaign.orgId,
        goal: String(directive).slice(0, 600),
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
      meta: { via: 'outreach-campaign', campaign_id: campaign.id, target_id: target.id, session_id: sessionId, goal: payload.goal },
    }).catch(() => {});
    // Dial success = executed (v1). Call OUTCOME (completed/booked/no-answer)
    // lands on the OutboundAction via the existing /api/tara/calls/end path.
    return prisma.outreachTarget.update({
      where: { id: target.id },
      data: { state: 'sent', resultRef: { taraCallLegId: result?.call_leg_id || null, sessionId } },
    });
  }

  const executeTarget = (c, t) => (c.channel === 'email' ? executeEmail(c, t) : executeCall(c, t));

  // ── drain worker: finish campaigns whose FE went away ──────────────────────
  async function drainOnce() {
    const stale = new Date(Date.now() - DRAIN_STALE_MS);
    const campaigns = await prisma.outreachCampaign.findMany({
      where: { status: 'running', lastTickAt: { lt: stale } },
      include: { targets: { orderBy: { position: 'asc' } } },
      take: 5,
    });
    for (const c of campaigns) {
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
      const campaign = await prisma.outreachCampaign.create({
        data: {
          roomId: room.id, turnId, userId: room.userId, orgId: room.orgId,
          channel, senderEmail, lastTickAt: new Date(),
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
          : { goal: String(body.payload.goal || t.payload?.goal || '').slice(0, 300), opener: String(body.payload.opener || t.payload?.opener || '').slice(0, 400) };
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
