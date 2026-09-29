import crypto from 'node:crypto';
import os from 'node:os';
import { dispatchWorkRun } from './work-runs.js';
import { getActiveOrganizationMembership } from '../workspace/access-policy.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORMATS = Object.freeze({
  pdf: 'application/pdf', html: 'text/html', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  png: 'image/png', mp4: 'video/mp4',
});
const MAX_GOAL = 8000;
const MAX_INSTRUCTIONS = 4000;

function bad(message) { return Object.assign(new Error(message), { status: 400 }); }

/** Find next wall-clock occurrence. Minute scan deliberately handles DST gaps and folds. */
export function nextDailyRunAt(time, timezone, after = new Date()) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(time))) throw bad('Daily time must be HH:mm');
  let formatter;
  try { formatter = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); }
  catch { throw bad('Invalid IANA timezone'); }
  const start = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000;
  for (let minute = 0; minute < 49 * 60; minute += 1) {
    const candidate = new Date(start + minute * 60_000);
    if (formatter.format(candidate) === time) return candidate;
  }
  throw bad('No occurrence found in next 49 hours');
}

export function normalizeWorkRunScheduleInput(body, now = new Date()) {
  if (!UUID.test(String(body?.room_id || ''))) throw bad('Valid room_id is required');
  const goal = String(body?.goal || '').trim();
  if (!goal || goal.length > MAX_GOAL) throw bad(`goal must contain 1-${MAX_GOAL} characters`);
  const instructions = String(body?.instructions || '').trim();
  if (instructions.length > MAX_INSTRUCTIONS) throw bad(`instructions exceed ${MAX_INSTRUCTIONS} characters`);
  const agentSlug = String(body?.agent_slug || '').trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,119}$/i.test(agentSlug)) throw bad('Valid agent_slug is required');
  const outputFormat = String(body?.output_format || '').toLowerCase();
  if (!Object.hasOwn(FORMATS, outputFormat)) throw bad('Unsupported output_format');
  const cadence = body?.cadence === 'daily' ? 'daily' : body?.cadence === 'once' ? 'once' : null;
  if (!cadence) throw bad('cadence must be once or daily');
  const timezone = cadence === 'daily' ? String(body?.timezone || '') : null;
  const localTime = cadence === 'daily' ? String(body?.time || '') : null;
  const runAt = cadence === 'daily' ? nextDailyRunAt(localTime, timezone, now) : new Date(body?.at);
  if (!Number.isFinite(runAt.getTime()) || runAt <= now) throw bad('at must be a future ISO timestamp');
  if (cadence === 'once' && runAt.getTime() - now.getTime() > 366 * 24 * 3600_000) throw bad('at is too far in the future');
  const playbookId = body?.playbook_id == null ? null : String(body.playbook_id);
  if (playbookId && !/^[a-zA-Z0-9:_./-]{1,120}$/.test(playbookId)) throw bad('Invalid playbook_id');
  const scope = body?.scope == null ? {} : body.scope;
  if (!scope || typeof scope !== 'object' || Array.isArray(scope) || Buffer.byteLength(JSON.stringify(scope)) > 12_000) throw bad('scope must be a compact object');
  return { roomId: body.room_id, goal, instructions, agentSlug, outputFormat, cadence,
    timezone, localTime, nextRunAt: runAt, playbookId, scope };
}

export async function createWorkRunSchedule({ prisma, orgId, userId, body, now = new Date() }) {
  const input = normalizeWorkRunScheduleInput(body, now);
  if (!await getActiveOrganizationMembership(prisma, { orgId, userId })) throw Object.assign(new Error('Organization membership is inactive'), { status: 403 });
  const room = await prisma.hyperRoom.findFirst({ where: { id: input.roomId, orgId, userId, archivedAt: null }, select: { id: true } });
  if (!room) throw Object.assign(new Error('Room not found'), { status: 404 });
  const employee = await prisma.digitalEmployee.findFirst({
    where: { orgId, slug: input.agentSlug, archivedAt: null, status: { not: 'error' } }, select: { id: true },
  });
  if (!employee) throw Object.assign(new Error('Assigned employee not found'), { status: 404 });
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO "hivemind"."work_run_schedules"
      (org_id,user_id,room_id,goal,instructions,agent_slug,playbook_id,scope,output_format,cadence,timezone,local_time,next_run_at)
     VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13::timestamptz) RETURNING *`,
    orgId, userId, input.roomId, input.goal, input.instructions, input.agentSlug,
    input.playbookId, JSON.stringify(input.scope), input.outputFormat, input.cadence,
    input.timezone, input.localTime, input.nextRunAt,
  );
  return rows[0];
}

const keyFor = (id, due) => crypto.createHash('sha256').update(`${id}:${new Date(due).toISOString()}`).digest('hex');

/** One atomic lease per due schedule. A retry keeps same occurrence key. */
export async function runDueWorkRunSchedule({ prisma, now = new Date(), owner = `${os.hostname()}:${process.pid}`, dispatch = dispatchWorkRun, logger = console } = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `WITH candidate AS (
      SELECT id FROM "hivemind"."work_run_schedules"
       WHERE status = 'active' AND next_run_at <= $1::timestamptz
         AND (lease_until IS NULL OR lease_until < $1::timestamptz)
       ORDER BY next_run_at, id FOR UPDATE SKIP LOCKED LIMIT 1
     )
     UPDATE "hivemind"."work_run_schedules" AS schedule
        SET lease_owner = $2, lease_until = $1::timestamptz + interval '2 minutes', updated_at = now()
       FROM candidate WHERE schedule.id = candidate.id RETURNING schedule.*`, now, owner,
  );
  const schedule = rows?.[0];
  if (!schedule) return null;
  const due = new Date(schedule.next_run_at);
  const release = async (patch) => prisma.$queryRawUnsafe(
    `UPDATE "hivemind"."work_run_schedules"
        SET status = $3, next_run_at = $4::timestamptz, last_workrun_id = $5::uuid,
            failure_count = $6, last_error = $7, lease_owner = NULL, lease_until = NULL, updated_at = now()
      WHERE id = $1::uuid AND lease_owner = $2 RETURNING id`,
    schedule.id, owner, patch.status, patch.nextRunAt, patch.workRunId,
    patch.failures, patch.error,
  );
  try {
    const membership = await getActiveOrganizationMembership(prisma, { orgId: schedule.org_id, userId: schedule.user_id });
    const room = await prisma.hyperRoom.findFirst({ where: { id: schedule.room_id, orgId: schedule.org_id, userId: schedule.user_id, archivedAt: null }, select: { id: true } });
    const employee = await prisma.digitalEmployee.findFirst({ where: { orgId: schedule.org_id, slug: schedule.agent_slug, archivedAt: null, status: { not: 'error' } }, select: { id: true } });
    if (!membership || !room || !employee) throw new Error('Schedule identity, room, or assigned employee is no longer active');
    const format = schedule.output_format;
    const goal = `${schedule.goal}\n\nScheduled instructions: ${schedule.instructions || 'Follow room and organization policies.'}\nRequired deliverable: ${format.toUpperCase()} artifact. Register artifact and finish only after it is available in the WorkRun.`;
    const result = await dispatch({
      prisma, orgId: schedule.org_id, userId: schedule.user_id, roomId: schedule.room_id,
      agentId: schedule.agent_slug, hyperagentSlug: schedule.agent_slug,
      playbookId: schedule.playbook_id, goal,
      scope: { ...(schedule.scope || {}), schedule_id: schedule.id, scheduled_for: due.toISOString() },
      completionContract: { min_artifacts: 1, artifact_content_type: FORMATS[format] },
      triggerKey: keyFor(schedule.id, due),
    });
    if (result.workRun.status === 'failed') throw new Error('Scheduled WorkRun failed to dispatch');
    const nextRunAt = schedule.cadence === 'daily'
      ? nextDailyRunAt(schedule.local_time, schedule.timezone, new Date(Math.max(now.getTime(), due.getTime())))
      : null;
    await release({ status: nextRunAt ? 'active' : 'completed', nextRunAt, workRunId: result.workRun.id, failures: 0, error: null });
    return { scheduleId: schedule.id, workRunId: result.workRun.id, status: 'dispatched' };
  } catch (error) {
    const failures = Number(schedule.failure_count || 0) + 1;
    await release({ status: failures >= 3 ? 'paused' : 'active', nextRunAt: due,
      workRunId: schedule.last_workrun_id || null, failures, error: String(error.message).slice(0, 1000) });
    logger.warn?.('[workrun-schedule] dispatch failed', { schedule_id: schedule.id, failures, error: error.message });
    return { scheduleId: schedule.id, status: failures >= 3 ? 'paused' : 'retry', error: error.message };
  }
}

export function startWorkRunScheduler({ prisma, logger = console, intervalMs = 15_000 } = {}) {
  if (!prisma) return null;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { for (let i = 0; i < 10; i += 1) if (!await runDueWorkRunSchedule({ prisma, logger })) break; }
    catch (error) { logger.warn?.('[workrun-schedule] tick failed:', error.message); }
    finally { busy = false; }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  tick();
  return { stop: () => clearInterval(timer), tick };
}
