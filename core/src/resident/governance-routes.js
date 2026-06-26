/**
 * Phase 2 governance API.
 *
 * Endpoints:
 *   GET    /api/governance/metrics?org_id=…&days=7
 *   GET    /api/governance/action-log?org_id=…&status=proposed|approved|applied|reverted&limit=50
 *   POST   /api/governance/actions/:id/approve  — approve + apply via GraphActionExecutor
 *   POST   /api/governance/actions/:id/reject   — mark rejected (audit only)
 *   POST   /api/governance/rollback/:batch_id   — revert every applied action in batch
 *
 * All routes require orgId header. Tenant isolation middleware additionally
 * enforces this at the Prisma layer.
 */

import { invalidateCognitionSettings } from './cognition-pilot.js';

function ok(body, statusCode = 200) {
  return { handled: true, statusCode, body };
}

function isUuid(s) {
  return typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

export const GOVERNANCE_ROUTE_TEMPLATES = [
  '/api/governance/metrics',
  '/api/governance/action-log',
  '/api/governance/actions/:id/approve',
  '/api/governance/actions/:id/reject',
  '/api/governance/rollback/:batch_id',
  '/api/governance/cognition-settings',
];

export function createGovernanceRoutes({ prisma, memoryStore, logger = console } = {}) {
  return {
    async dispatch({ pathname, method, body = {}, query = {}, userId, orgId }) {
      if (!prisma) return ok({ error: 'governance disabled (no prisma client)' }, 503);
      if (!orgId) return ok({ error: 'orgId required (X-HM-Org-Id header)' }, 400);

      // ── GET /api/governance/cognition-settings — toggle state for this org +
      //    its active projects (workspace-admin settings + project cards).
      if (pathname === '/api/governance/cognition-settings' && method === 'GET') {
        let orgRow = null;
        let projRows = [];
        try {
          const r = await prisma.$queryRawUnsafe(
            `SELECT cognition_org_enabled, cognition_personal_enabled,
                    cognition_schedule_mode, cognition_window_start_hour,
                    cognition_window_end_hour, cognition_schedule_tz,
                    cognition_cross_project_enabled, profile_automaintain_enabled
               FROM hivemind.organizations WHERE id=$1::uuid`,
            orgId,
          );
          orgRow = r?.[0] || null;
          projRows = await prisma.$queryRawUnsafe(
            `SELECT id, name, self_evolve_enabled FROM hivemind.projects WHERE org_id=$1::uuid AND status='active' ORDER BY name`,
            orgId,
          );
        } catch (e) {
          return ok({ error: `settings read failed: ${e.message}` }, 500);
        }
        return ok({
          org_enabled: !!orgRow?.cognition_org_enabled,
          personal_enabled: !!orgRow?.cognition_personal_enabled,
          cross_project_enabled: !!orgRow?.cognition_cross_project_enabled,
          profile_automaintain_enabled: !!orgRow?.profile_automaintain_enabled,
          schedule: {
            mode: orgRow?.cognition_schedule_mode || 'nightmode',
            window_start_hour: orgRow?.cognition_window_start_hour ?? null,
            window_end_hour: orgRow?.cognition_window_end_hour ?? null,
            tz: orgRow?.cognition_schedule_tz || 'UTC',
          },
          projects: (projRows || []).map((p) => ({
            id: p.id, name: p.name, self_evolve_enabled: !!p.self_evolve_enabled,
          })),
        });
      }

      // ── POST /api/governance/cognition-settings — admin/owner sets the toggles.
      //    Body: { org_enabled?, personal_enabled?, project_id?, self_evolve_enabled? }
      if (pathname === '/api/governance/cognition-settings' && method === 'POST') {
        const mem = await prisma.userOrganization.findUnique({
          where: { userId_orgId: { userId, orgId } },
          select: { role: true, roles: true },
        }).catch(() => null);
        const roles = new Set([
          ...(mem?.role ? [mem.role] : []),
          ...(Array.isArray(mem?.roles) ? mem.roles : []),
        ]);
        const isAdmin = ['admin', 'owner', 'org_admin', 'org_owner'].some((r) => roles.has(r));
        if (!isAdmin) return ok({ error: 'admin/owner role required', roles_seen: [...roles] }, 403);

        try {
          if (typeof body.org_enabled === 'boolean') {
            // Anchor the enable moment ONLY on a false→true transition, so the
            // cognition loop starts from a 1-hour window at toggle-on time and
            // NEVER backfills the org's historical memories. Re-saving an
            // already-on toggle preserves the original anchor; turning it on
            // after an off resets to now (fresh 1h window). Off leaves the
            // anchor (harmless — the loop is gated by the flag itself).
            await prisma.$executeRawUnsafe(
              `UPDATE hivemind.organizations
                  SET cognition_org_enabled = $1,
                      cognition_enabled_at = CASE
                        WHEN $1 = true AND cognition_org_enabled = false THEN now()
                        ELSE cognition_enabled_at
                      END
                WHERE id = $2::uuid`,
              body.org_enabled, orgId,
            );
          }
          if (typeof body.personal_enabled === 'boolean') {
            await prisma.$executeRawUnsafe(
              `UPDATE hivemind.organizations SET cognition_personal_enabled=$1 WHERE id=$2::uuid`,
              body.personal_enabled, orgId,
            );
          }
          if (typeof body.cross_project_enabled === 'boolean') {
            await prisma.$executeRawUnsafe(
              `UPDATE hivemind.organizations SET cognition_cross_project_enabled=$1 WHERE id=$2::uuid`,
              body.cross_project_enabled, orgId,
            );
          }
          if (typeof body.profile_automaintain_enabled === 'boolean') {
            // Per-org opt-in for the profile-dream cron. Durable (DB), survives
            // container recreate — unlike the global env master switches.
            await prisma.$executeRawUnsafe(
              `UPDATE hivemind.organizations SET profile_automaintain_enabled=$1 WHERE id=$2::uuid`,
              body.profile_automaintain_enabled, orgId,
            );
          }
          if (body.schedule && typeof body.schedule === 'object') {
            const s = body.schedule;
            const mode = ['nightmode', 'interval', 'continuous'].includes(s.mode) ? s.mode : null;
            const clampHour = (h) => (Number.isInteger(h) && h >= 0 && h <= 23 ? h : null);
            const startH = s.window_start_hour === null ? null : clampHour(s.window_start_hour);
            const endH = s.window_end_hour === null ? null : clampHour(s.window_end_hour);
            const tz = typeof s.tz === 'string' && s.tz.length <= 64 ? s.tz : null;
            if (mode) {
              await prisma.$executeRawUnsafe(
                `UPDATE hivemind.organizations SET cognition_schedule_mode=$1 WHERE id=$2::uuid`,
                mode, orgId,
              );
            }
            if (s.window_start_hour !== undefined) {
              await prisma.$executeRawUnsafe(
                `UPDATE hivemind.organizations SET cognition_window_start_hour=$1 WHERE id=$2::uuid`,
                startH, orgId,
              );
            }
            if (s.window_end_hour !== undefined) {
              await prisma.$executeRawUnsafe(
                `UPDATE hivemind.organizations SET cognition_window_end_hour=$1 WHERE id=$2::uuid`,
                endH, orgId,
              );
            }
            if (tz) {
              await prisma.$executeRawUnsafe(
                `UPDATE hivemind.organizations SET cognition_schedule_tz=$1 WHERE id=$2::uuid`,
                tz, orgId,
              );
            }
          }
          if (body.project_id && typeof body.self_evolve_enabled === 'boolean') {
            if (!isUuid(body.project_id)) return ok({ error: 'invalid project_id' }, 400);
            await prisma.$executeRawUnsafe(
              `UPDATE hivemind.projects SET self_evolve_enabled=$1 WHERE id=$2::uuid AND org_id=$3::uuid`,
              body.self_evolve_enabled, body.project_id, orgId,
            );
          }
        } catch (e) {
          return ok({ error: `settings write failed: ${e.message}` }, 500);
        }
        invalidateCognitionSettings(orgId);
        return ok({ ok: true });
      }

      // ── GET /api/governance/metrics?days=7
      if (pathname === '/api/governance/metrics' && method === 'GET') {
        const days = Math.min(Math.max(parseInt(query.days || '7', 10) || 7, 1), 90);
        const since = new Date();
        since.setDate(since.getDate() - days);
        since.setHours(0, 0, 0, 0);

        const rows = await prisma.governanceMetric.findMany({
          where: { orgId, day: { gte: since } },
          orderBy: [{ day: 'desc' }, { agentName: 'asc' }],
        });

        const agentState = await prisma.governanceAgentState.findMany({});
        const totals = rows.reduce((acc, r) => {
          acc.actions_proposed += r.actionsProposed;
          acc.actions_approved += r.actionsApproved;
          acc.actions_applied  += r.actionsApplied;
          acc.actions_reverted += r.actionsReverted;
          acc.actions_rejected += r.actionsRejected;
          acc.actions_failed   += r.actionsFailed;
          return acc;
        }, { actions_proposed: 0, actions_approved: 0, actions_applied: 0, actions_reverted: 0, actions_rejected: 0, actions_failed: 0 });

        return ok({
          window_days: days,
          totals,
          by_day: rows.map((r) => ({
            agent: r.agentName,
            day: r.day.toISOString().slice(0, 10),
            proposed: r.actionsProposed,
            approved: r.actionsApproved,
            applied: r.actionsApplied,
            reverted: r.actionsReverted,
            rejected: r.actionsRejected,
            failed: r.actionsFailed,
            latency_ms_p95: r.latencyMsP95,
          })),
          agent_state: agentState.map((a) => ({
            agent: a.agentName,
            last_run_at: a.lastRunAt,
            last_completed_at: a.lastCompletedAt,
            cursor_memory_id: a.cursorMemoryId,
            daily_token_budget: a.dailyTokenBudget,
            tokens_spent_today: a.tokensSpentToday,
            circuit_breaker_until: a.circuitBreakerUntil,
          })),
        });
      }

      // ── GET /api/governance/action-log
      if (pathname === '/api/governance/action-log' && method === 'GET') {
        const status = query.status || undefined;
        const limit = Math.min(parseInt(query.limit || '50', 10) || 50, 500);
        const rows = await prisma.governanceActionLog.findMany({
          where: { orgId, ...(status ? { status } : {}) },
          orderBy: { createdAt: 'desc' },
          take: limit,
        });
        return ok({
          count: rows.length,
          actions: rows.map((r) => ({
            id: r.id,
            batch_id: r.batchId,
            agent: r.agentName,
            action_type: r.actionType,
            status: r.status,
            confidence: r.confidence,
            target_memory_id: r.targetMemoryId,
            evidence_ids: r.evidenceIds,
            reasoning: r.reasoning,
            reversible: r.reversible,
            applied_at: r.appliedAt,
            reverted_at: r.revertedAt,
            created_at: r.createdAt,
          })),
        });
      }

      // ── POST /api/governance/actions/:id/approve
      const approveMatch = pathname.match(/^\/api\/governance\/actions\/([0-9a-f-]+)\/approve$/i);
      if (approveMatch && method === 'POST') {
        const id = approveMatch[1];
        if (!isUuid(id)) return ok({ error: 'invalid action id' }, 400);

        const action = await prisma.governanceActionLog.findFirst({ where: { id, orgId } });
        if (!action) return ok({ error: 'action not found' }, 404);
        if (action.status !== 'proposed' && action.status !== 'approved') {
          return ok({ error: `action status=${action.status}, cannot approve` }, 409);
        }

        // Build action input for executor
        const execAction = {
          recommendation: action.actionType,
          target_memory_ids: Array.isArray(action.evidenceIds) ? action.evidenceIds : [],
          confidence: action.confidence ?? 0.9,
          reason: action.reasoning || 'approved by user',
        };

        let executionResult = null;
        let applyStatus = 'applied';
        let applyError = null;
        try {
          if (!memoryStore) throw new Error('memoryStore unavailable');
          const { GraphActionExecutor } = await import('./graph-action-executor.js');
          const executor = new GraphActionExecutor({ memoryStore, logger });
          executionResult = await executor.executeActions([execAction], {
            minConfidence: 0,
            duplicateMode: 'flag',
          });
          if (!executionResult || executionResult.executed < 1) {
            applyStatus = 'failed';
            applyError = executionResult?.results?.[0]?.error || executionResult?.results?.[0]?.reason || 'no_action_executed';
          }
        } catch (err) {
          applyStatus = 'failed';
          applyError = err?.message || String(err);
        }

        const now = new Date();
        const updated = await prisma.governanceActionLog.update({
          where: { id },
          data: {
            orgId, // satisfy tenant middleware
            status: applyStatus,
            appliedAt: applyStatus === 'applied' ? now : null,
            afterSnapshot: executionResult || null,
          },
        });

        // Bump daily metric
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        await prisma.governanceMetric.upsert({
          where: { agentName_orgId_day: { agentName: action.agentName, orgId, day: today } },
          create: {
            agentName: action.agentName, orgId, day: today,
            actionsApproved: 1,
            actionsApplied: applyStatus === 'applied' ? 1 : 0,
            actionsFailed: applyStatus === 'failed' ? 1 : 0,
          },
          update: {
            actionsApproved: { increment: 1 },
            actionsApplied: { increment: applyStatus === 'applied' ? 1 : 0 },
            actionsFailed: { increment: applyStatus === 'failed' ? 1 : 0 },
          },
        }).catch(() => null);

        return ok({
          id: updated.id,
          status: updated.status,
          applied_at: updated.appliedAt,
          execution: executionResult,
          error: applyError,
        }, applyStatus === 'failed' ? 500 : 200);
      }

      // ── POST /api/governance/actions/:id/reject
      const rejectMatch = pathname.match(/^\/api\/governance\/actions\/([0-9a-f-]+)\/reject$/i);
      if (rejectMatch && method === 'POST') {
        const id = rejectMatch[1];
        if (!isUuid(id)) return ok({ error: 'invalid action id' }, 400);
        const action = await prisma.governanceActionLog.findFirst({ where: { id, orgId } });
        if (!action) return ok({ error: 'action not found' }, 404);
        if (action.status === 'applied' || action.status === 'reverted') {
          return ok({ error: `cannot reject status=${action.status}` }, 409);
        }
        const updated = await prisma.governanceActionLog.update({
          where: { id },
          data: { orgId, status: 'rejected' },
        });
        const today = new Date(); today.setHours(0,0,0,0);
        await prisma.governanceMetric.upsert({
          where: { agentName_orgId_day: { agentName: action.agentName, orgId, day: today } },
          create: { agentName: action.agentName, orgId, day: today, actionsRejected: 1 },
          update: { actionsRejected: { increment: 1 } },
        }).catch(() => null);
        return ok({ id: updated.id, status: updated.status });
      }

      // ── POST /api/governance/rollback/:batch_id
      const rbMatch = pathname.match(/^\/api\/governance\/rollback\/([0-9a-f-]+)$/i);
      if (rbMatch && method === 'POST') {
        const batchId = rbMatch[1];
        if (!isUuid(batchId)) return ok({ error: 'invalid batch_id' }, 400);

        const applied = await prisma.governanceActionLog.findMany({
          where: { orgId, batchId, status: 'applied', reversible: true },
        });
        if (applied.length === 0) return ok({ error: 'no applied reversible actions for batch' }, 404);

        let reverted = 0;
        const errors = [];
        for (const a of applied) {
          try {
            // Phase 2: best-effort revert. For link_update_chain we can re-flip
            // is_latest on the prior chain; for merge we restore the absorbed
            // memories. For now we mark reverted in audit log so user has trail;
            // physical revert handler lands in P3 alongside before_snapshot capture.
            await prisma.governanceActionLog.update({
              where: { id: a.id },
              data: { orgId, status: 'reverted', revertedAt: new Date() },
            });
            reverted += 1;
          } catch (err) {
            errors.push({ id: a.id, error: err?.message || String(err) });
          }
        }

        // Roll metric bumps
        const today = new Date(); today.setHours(0,0,0,0);
        const byAgent = new Map();
        for (const a of applied) {
          byAgent.set(a.agentName, (byAgent.get(a.agentName) || 0) + 1);
        }
        for (const [agentName, n] of byAgent) {
          await prisma.governanceMetric.upsert({
            where: { agentName_orgId_day: { agentName, orgId, day: today } },
            create: { agentName, orgId, day: today, actionsReverted: n },
            update: { actionsReverted: { increment: n } },
          }).catch(() => null);
        }

        return ok({
          batch_id: batchId,
          attempted: applied.length,
          reverted,
          errors,
        });
      }

      return null;
    },
  };
}
