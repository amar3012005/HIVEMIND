import { resolveAuthorizedRoomEmployeeRoster } from './room-employee-roster.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = new Set(['once', 'daily', 'event', 'manual']);
const MODES = new Set(['auto', 'direct', 'company']);
const TABLE = '"hivemind"."hyper_task_triggers"';
const OCCURRENCES = '"hivemind"."hyper_task_occurrences"';

export function nextDailyDue(after, timezone, localTime) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(localTime)) throw new Error('invalid_local_time');
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    formatter.format(after);
  } catch { throw new Error('invalid_timezone'); }
  // Scan in UTC minutes: DST gaps skip nonexistent local times and repeated
  // local times choose the first occurrence after the supplied instant.
  let minute = Math.floor(after.getTime() / 60_000) + 1;
  const afterParts = Object.fromEntries(formatter.formatToParts(after).map(({ type, value }) => [type, value]));
  const afterDay = `${afterParts.year}-${afterParts.month}-${afterParts.day}`;
  const allowSameDay = `${afterParts.hour}:${afterParts.minute}` < localTime;
  for (let i = 0; i < 60 * 49; i++, minute++) {
    const candidate = new Date(minute * 60_000);
    const parts = Object.fromEntries(formatter.formatToParts(candidate).map(({ type, value }) => [type, value]));
    const candidateDay = `${parts.year}-${parts.month}-${parts.day}`;
    if (`${parts.hour}:${parts.minute}` === localTime && (candidateDay !== afterDay || allowSameDay)) return candidate;
  }
  throw new Error('daily_time_unavailable');
}

export function normalizeTriggerInput(input, now = new Date()) {
  const kind = String(input?.kind || 'once');
  const task = String(input?.task || '').trim();
  const modePreference = String(input?.mode_preference || 'auto');
  if (!KINDS.has(kind)) throw new Error('invalid_trigger_kind');
  if (!MODES.has(modePreference)) throw new Error('invalid_mode_preference');
  if (task.length < 4 || task.length > 2000) throw new Error('invalid_task');
  const brief = String(input?.brief || '').trim();
  const outputFormat = String(input?.output_format || 'plain_text').trim();
  const acceptanceCriteria = String(input?.acceptance_criteria || '').trim();
  if (brief.length > 4000 || acceptanceCriteria.length > 4000 || !/^[a-z][a-z0-9_]{2,39}$/.test(outputFormat)) throw new Error('invalid_task_packet');
  let nextRunAt = null;
  let timezone = null;
  let localTime = null;
  let eventKey = null;
  if (kind === 'once') {
    nextRunAt = new Date(String(input?.run_at || ''));
    if (!Number.isFinite(nextRunAt.getTime()) || nextRunAt <= now || nextRunAt.getTime() > now.getTime() + 366 * 86_400_000) throw new Error('invalid_run_at');
  } else if (kind === 'daily') {
    timezone = String(input?.timezone || '').trim();
    localTime = String(input?.local_time || '').trim();
    nextRunAt = nextDailyDue(now, timezone, localTime);
  } else if (kind === 'event') {
    eventKey = String(input?.event_key || '').trim();
    if (!/^[a-z][a-z0-9_.:-]{2,119}$/.test(eventKey)) throw new Error('invalid_event_key');
  }
  return { kind, task, modePreference, nextRunAt, timezone, localTime, eventKey,
    packet: { version: 1, task, brief, output_format: outputFormat, acceptance_criteria: acceptanceCriteria } };
}

function publicTrigger(row) {
  return {
    id: row.id, org_id: row.org_id, user_id: row.user_id, room_id: row.room_id,
    employee_id: row.employee_id, kind: row.kind, status: row.status, task: row.task,
    mode_preference: row.mode_preference, timezone: row.timezone, local_time: row.local_time,
    next_run_at: row.next_run_at, event_key: row.event_key, version: row.version,
    task_packet: row.task_packet, created_at: row.created_at,
  };
}

export async function createTrigger(prisma, { orgId, userId, roomId, employeeId, input, proposed = false }) {
  if (![orgId, userId, roomId, employeeId].every((id) => UUID.test(id))) throw new Error('invalid_identity');
  const authorized = await resolveAuthorizedRoomEmployeeRoster(prisma, { orgId, userId, roomId });
  if (!authorized.authorized || authorized.roster?.employee?.id !== employeeId) throw new Error('room_employee_unavailable');
  const normalized = normalizeTriggerInput(input);
  // Proposals do not become runnable until a human approves them through the
  // authenticated public route. They cannot carry standing external-send grants.
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO ${TABLE} (org_id,user_id,room_id,employee_id,kind,status,task,mode_preference,timezone,local_time,next_run_at,event_key,task_packet)
     VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,$8,$9,$10,$11::timestamptz,$12,$13::jsonb) RETURNING *`,
    orgId, userId, roomId, employeeId, normalized.kind, proposed ? 'proposed' : 'active',
    normalized.task, normalized.modePreference, normalized.timezone, normalized.localTime,
    normalized.nextRunAt, normalized.eventKey, JSON.stringify(normalized.packet),
  );
  return publicTrigger(rows[0]);
}

export async function listTriggers(prisma, { orgId, userId }) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM ${TABLE} WHERE org_id=$1::uuid AND user_id=$2::uuid ORDER BY created_at DESC LIMIT 100`, orgId, userId,
  );
  return rows.map(publicTrigger);
}

export async function updateTriggerStatus(prisma, { orgId, userId, triggerId, status }) {
  if (!UUID.test(triggerId) || !['active', 'paused'].includes(status)) throw new Error('invalid_trigger_update');
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE ${TABLE} SET status=$4, version=version+1, updated_at=now()
     WHERE id=$1::uuid AND org_id=$2::uuid AND user_id=$3::uuid RETURNING *`, triggerId, orgId, userId, status,
  );
  return rows[0] ? publicTrigger(rows[0]) : null;
}

export async function fireTrigger(prisma, { orgId, userId, triggerId, logicalKey, kind, eventKey = null }) {
  if (!UUID.test(triggerId) || !/^[a-zA-Z0-9_.:-]{1,120}$/.test(logicalKey)) throw new Error('invalid_trigger_event');
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO ${OCCURRENCES} (trigger_id,org_id,logical_key,due_at)
     SELECT id,org_id,$4,now() FROM ${TABLE}
     WHERE id=$1::uuid AND org_id=$2::uuid AND user_id=$3::uuid AND status='active' AND kind=$5
       AND ($5 <> 'event' OR event_key=$6)
     ON CONFLICT (trigger_id,logical_key) DO NOTHING
     RETURNING id,status`, triggerId, orgId, userId, logicalKey, kind, eventKey,
  );
  if (rows[0]) return rows[0];
  const existing = await prisma.$queryRawUnsafe(
    `SELECT o.id,o.status FROM ${OCCURRENCES} o JOIN ${TABLE} t ON t.id=o.trigger_id
     WHERE t.id=$1::uuid AND t.org_id=$2::uuid AND t.user_id=$3::uuid AND o.logical_key=$4`,
    triggerId, orgId, userId, logicalKey,
  );
  return existing[0] || null;
}

export async function claimDueOccurrences(prisma, limit = 10) {
  return prisma.$transaction(async (tx) => {
    const due = await tx.$queryRawUnsafe(
      `SELECT * FROM ${TABLE} WHERE status='active' AND next_run_at <= now()
       ORDER BY next_run_at LIMIT $1 FOR UPDATE SKIP LOCKED`, Math.min(Math.max(Number(limit) || 10, 1), 20),
    );
    for (const trigger of due) {
      const logicalKey = `due:${new Date(trigger.next_run_at).toISOString()}`;
      await tx.$executeRawUnsafe(
        `INSERT INTO ${OCCURRENCES} (trigger_id,org_id,logical_key,due_at)
         VALUES ($1::uuid,$2::uuid,$3,$4::timestamptz) ON CONFLICT (trigger_id,logical_key) DO NOTHING`,
        trigger.id, trigger.org_id, logicalKey, trigger.next_run_at,
      );
      const next = trigger.kind === 'daily' ? nextDailyDue(new Date(trigger.next_run_at), trigger.timezone, trigger.local_time) : null;
      await tx.$executeRawUnsafe(`UPDATE ${TABLE} SET next_run_at=$2::timestamptz,updated_at=now() WHERE id=$1::uuid`, trigger.id, next);
    }
    const rows = await tx.$queryRawUnsafe(
      `UPDATE ${OCCURRENCES} SET status='dispatching',lease_until=now()+interval '5 minutes',
         attempts=attempts+1,updated_at=now()
       WHERE id IN (SELECT id FROM ${OCCURRENCES}
         WHERE status IN ('queued','dispatching') AND (lease_until IS NULL OR lease_until < now())
         ORDER BY due_at LIMIT $1 FOR UPDATE SKIP LOCKED) RETURNING id,run_room_id,trigger_id`,
      Math.min(Math.max(Number(limit) || 10, 1), 20),
    );
    for (const row of rows) {
      if (row.run_room_id) continue;
      const created = await tx.$queryRawUnsafe(
        `INSERT INTO "hivemind"."hyper_rooms" (user_id,org_id,name,goal,participant_ids,permanent_lead_id,template,room_tag,project_id)
         SELECT t.user_id,t.org_id,left(coalesce(t.task_packet->>'task',t.task),120),t.task,
                ARRAY[t.employee_id]::uuid[],t.employee_id,'auto','general',source.project_id
         FROM ${TABLE} t JOIN "hivemind"."hyper_rooms" source ON source.id=t.room_id
         WHERE t.id=$1::uuid AND source.archived_at IS NULL
         RETURNING id`, row.trigger_id,
      );
      if (!created[0]) throw new Error('source_room_unavailable');
      await tx.$executeRawUnsafe(`UPDATE ${OCCURRENCES} SET run_room_id=$2::uuid WHERE id=$1::uuid`, row.id, created[0].id);
    }
    return rows.map(({ id }) => id);
  });
}

export async function getOccurrence(prisma, id) {
  if (!UUID.test(id)) return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT o.id,o.org_id,o.logical_key,o.status,o.workflow_id,o.run_room_id,t.user_id,t.room_id AS source_room_id,t.employee_id,
            t.task,t.task_packet,t.mode_preference,t.version AS trigger_version
     FROM ${OCCURRENCES} o JOIN ${TABLE} t ON t.id=o.trigger_id
     WHERE o.id=$1::uuid AND t.status='active' AND o.run_room_id IS NOT NULL`, id,
  );
  return rows[0] || null;
}

export async function markOccurrenceStarted(prisma, id, workflowId) {
  if (!UUID.test(id) || !/^[a-zA-Z0-9_-]{1,160}$/.test(workflowId)) throw new Error('invalid_workflow');
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE ${OCCURRENCES} SET status='running',workflow_id=$2,lease_until=NULL,updated_at=now()
     WHERE id=$1::uuid AND status IN ('dispatching','running') AND (workflow_id IS NULL OR workflow_id=$2)
     RETURNING id,status,workflow_id`, id, workflowId,
  );
  return rows[0] || null;
}

export async function completeOccurrence(prisma, id, { complete, reason, report, artifactRefs = [] }) {
  if (!UUID.test(id)) throw new Error('invalid_occurrence');
  const status = complete ? 'complete' : reason === 'input_required' ? 'input_required' : 'failed';
  const result = JSON.stringify({ reason: String(reason || '').slice(0, 160), report: String(report || '').slice(0, 12000) });
  const refs = JSON.stringify(artifactRefs.filter((ref) => UUID.test(ref)).slice(0, 20));
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE ${OCCURRENCES} SET status=$2,result=$3::jsonb,artifact_refs=$4::jsonb,lease_until=NULL,updated_at=now()
     WHERE id=$1::uuid AND status IN ('dispatching','running','input_required') RETURNING id,status`, id, status, result, refs,
  );
  return rows[0] || null;
}

export function occurrenceWorkflowId(id) {
  if (!UUID.test(id)) throw new Error('invalid_occurrence');
  return `trigger-${id}`;
}
