import { DurableObject } from "cloudflare:workers";
import { CronExpressionParser } from "cron-parser";

type DispatchMessage = { tenantId: string; occurrenceId: string };
type TriggerSchedule =
  | { kind: "once"; runAt: string }
  | { kind: "cron"; expression: string; timezone: string };
type TriggerInput = { schedule: TriggerSchedule; payload: unknown };
type TerminalInput = { status: "completed" | "failed"; runId?: string; receiptId?: string };

interface AppEnv {
  TENANT_SCHEDULES: DurableObjectNamespace<TenantSchedules>;
  DREAMER_QUEUE: Queue<DispatchMessage>;
  ENVIRONMENT: string;
  DISPATCH_ENABLED: string;
  DSH_TRIGGER_URL: string;
  SCHEDULER_ADMIN_TOKEN: string;
  DSH_DISPATCH_TOKEN: string;
  DSH_CALLBACK_TOKEN: string;
}

type ScheduleRow = {
  trigger_id: string;
  kind: string;
  run_at: string | null;
  expression: string | null;
  timezone: string | null;
  payload_json: string;
  version: number;
  active: number;
  next_due_at: number | null;
};
type OccurrenceRow = {
  id: string;
  trigger_id: string;
  due_at: number;
  payload_json: string;
  version: number;
  status: string;
  attempts: number;
  lease_token: string | null;
  lease_until: number | null;
  dsh_run_id: string | null;
  error: string | null;
  receipt_json: string | null;
  accepted_at: number | null;
  updated_at: number;
};

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const ALARM_BATCH = 100;
const RECONCILE_AFTER_MS = 24 * 60 * 60 * 1000;
const MAX_QUEUE_ATTEMPTS = 8;

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

function nextDue(schedule: TriggerSchedule, after: number): number {
  if (schedule.kind === "once") {
    const due = Date.parse(schedule.runAt);
    if (!Number.isFinite(due) || !/Z$|[+-]\d\d:\d\d$/.test(schedule.runAt)) throw new Error("run_at_must_include_offset");
    return due;
  }
  if (schedule.expression.trim().split(/\s+/).length !== 5) throw new Error("five_field_cron_required");
  try {
    new Intl.DateTimeFormat("en", { timeZone: schedule.timezone }).format();
    return CronExpressionParser.parse(schedule.expression, {
      currentDate: new Date(after),
      tz: schedule.timezone,
    }).next().getTime();
  } catch {
    throw new Error("invalid_cron_or_timezone");
  }
}

function parseTrigger(input: unknown): { schedule: TriggerSchedule; payloadJson: string } {
  if (!input || typeof input !== "object") throw new Error("trigger_body_required");
  const body = input as Partial<TriggerInput>;
  const schedule = body.schedule;
  if (!schedule || typeof schedule !== "object") throw new Error("schedule_required");
  if (schedule.kind === "once") {
    if (typeof schedule.runAt !== "string") throw new Error("run_at_required");
  } else if (schedule.kind === "cron") {
    if (typeof schedule.expression !== "string" || typeof schedule.timezone !== "string") throw new Error("cron_and_timezone_required");
  } else throw new Error("schedule_kind_invalid");
  if (body.payload === undefined || body.payload === null) throw new Error("dsh_payload_required");
  const payloadJson = JSON.stringify(body.payload);
  if (new TextEncoder().encode(payloadJson).length > MAX_PAYLOAD_BYTES) throw new Error("dsh_payload_too_large");
  nextDue(schedule, Date.now());
  return { schedule, payloadJson };
}

function storedSchedule(row: ScheduleRow): TriggerSchedule {
  return row.kind === "once"
    ? { kind: "once", runAt: row.run_at! }
    : { kind: "cron", expression: row.expression!, timezone: row.timezone! };
}

function sameToken(actual: string | null, expected: string | undefined): boolean {
  if (!actual?.startsWith("Bearer ") || !expected || expected.length < 24) return false;
  const supplied = actual.slice(7);
  let difference = supplied.length ^ expected.length;
  const count = Math.max(supplied.length, expected.length);
  for (let i = 0; i < count; i++) difference |= (supplied.charCodeAt(i) || 0) ^ (expected.charCodeAt(i) || 0);
  return difference === 0;
}

async function doCall(env: AppEnv, tenantId: string, path: string, method: string, body?: unknown): Promise<Response> {
  const stub = env.TENANT_SCHEDULES.getByName(tenantId);
  return stub.fetch(new Request(`https://tenant.internal${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify({ tenantId, ...body as object }),
  }));
}

export class TenantSchedules extends DurableObject<AppEnv> {
  private ensureSchema(): void {
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS tenant_identity (id TEXT PRIMARY KEY)`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS triggers (
      trigger_id TEXT PRIMARY KEY, kind TEXT NOT NULL, run_at TEXT, expression TEXT, timezone TEXT,
      payload_json TEXT NOT NULL, version INTEGER NOT NULL, active INTEGER NOT NULL,
      next_due_at INTEGER, updated_at INTEGER NOT NULL
    )`);
    this.ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS triggers_due ON triggers(active, next_due_at)`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS occurrences (
      id TEXT PRIMARY KEY, trigger_id TEXT NOT NULL, due_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL, version INTEGER NOT NULL, status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, lease_token TEXT, lease_until INTEGER,
      dsh_run_id TEXT, error TEXT, receipt_json TEXT, accepted_at INTEGER, updated_at INTEGER NOT NULL
    )`);
    this.ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS occurrences_pending ON occurrences(status, due_at)`);
  }

  private tenant(tenantId: string): void {
    if (!ID.test(tenantId)) throw new Error("tenant_id_invalid");
    const saved = this.ctx.storage.sql.exec<{ id: string }>("SELECT id FROM tenant_identity LIMIT 1").toArray()[0];
    if (saved && saved.id !== tenantId) throw new Error("tenant_scope_mismatch");
    if (!saved) this.ctx.storage.sql.exec("INSERT INTO tenant_identity(id) VALUES (?)", tenantId);
  }

  private async arm(): Promise<void> {
    const due = this.ctx.storage.sql.exec<{ due: number | null }>(
      "SELECT MIN(next_due_at) AS due FROM triggers WHERE active = 1 AND next_due_at IS NOT NULL",
    ).one()?.due;
    const pending = this.ctx.storage.sql.exec<{ total: number }>(
      "SELECT COUNT(*) AS total FROM occurrences WHERE status = 'pending'",
    ).one()?.total ?? 0;
    const stale = this.ctx.storage.sql.exec<{ due: number | null }>(
      "SELECT MIN(accepted_at) AS due FROM occurrences WHERE status = 'accepted'",
    ).one()?.due;
    const candidates = [due, pending ? Date.now() + 10_000 : null, stale === null || stale === undefined ? null : stale + RECONCILE_AFTER_MS]
      .filter((value): value is number => value !== null && value !== undefined);
    if (candidates.length) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1_000, Math.min(...candidates)));
    else await this.ctx.storage.deleteAlarm();
  }

  async alarm(): Promise<void> {
    this.ensureSchema();
    try {
      if (this.env.DISPATCH_ENABLED !== "true") {
        await this.ctx.storage.setAlarm(Date.now() + 60_000);
        return;
      }
      const now = Date.now();
      this.ctx.storage.sql.exec(
        "UPDATE occurrences SET status = 'needs_reconciliation', updated_at = ? WHERE status = 'accepted' AND accepted_at <= ?",
        now, now - RECONCILE_AFTER_MS,
      );
      for (let i = 0; i < ALARM_BATCH; i++) {
        const row = this.ctx.storage.sql.exec<ScheduleRow>(
          "SELECT * FROM triggers WHERE active = 1 AND next_due_at <= ? ORDER BY next_due_at LIMIT 1", now,
        ).toArray()[0];
        if (!row || row.next_due_at === null) break;
        const tenantId = this.ctx.storage.sql.exec<{ id: string }>("SELECT id FROM tenant_identity LIMIT 1").toArray()[0]!.id;
        const occurrenceId = `${tenantId}:${row.trigger_id}:${row.next_due_at}`;
        this.ctx.storage.sql.exec(
          "INSERT OR IGNORE INTO occurrences(id, trigger_id, due_at, payload_json, version, status, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
          occurrenceId, row.trigger_id, row.next_due_at, row.payload_json, row.version, now,
        );
        if (row.kind === "once") {
          this.ctx.storage.sql.exec("UPDATE triggers SET active = 0, next_due_at = NULL WHERE trigger_id = ?", row.trigger_id);
        } else {
          const next = nextDue(storedSchedule(row), row.next_due_at);
          this.ctx.storage.sql.exec("UPDATE triggers SET next_due_at = ? WHERE trigger_id = ?", next, row.trigger_id);
        }
      }
      const tenantId = this.ctx.storage.sql.exec<{ id: string }>("SELECT id FROM tenant_identity LIMIT 1").toArray()[0]?.id;
      if (tenantId) {
        const pending = [...this.ctx.storage.sql.exec<OccurrenceRow>(
          "SELECT * FROM occurrences WHERE status = 'pending' ORDER BY due_at LIMIT ?", ALARM_BATCH,
        )];
        for (const row of pending) {
          await this.env.DREAMER_QUEUE.send({ tenantId, occurrenceId: row.id });
          this.ctx.storage.sql.exec("UPDATE occurrences SET status = 'queued', updated_at = ? WHERE id = ? AND status = 'pending'", Date.now(), row.id);
        }
      }
      await this.arm();
    } catch (error) {
      await this.ctx.storage.setAlarm(Date.now() + 30_000);
      throw error;
    }
  }

  async fetch(request: Request): Promise<Response> {
    this.ensureSchema();
    const path = new URL(request.url).pathname;
    let body: Record<string, unknown> = {};
    if (request.method !== "GET") {
      try { body = await request.json() as Record<string, unknown>; }
      catch { return json({ error: "invalid_json" }, 400); }
    }
    try {
      if (request.method !== "GET") this.tenant(String(body.tenantId || ""));
      if (path === "/register" && request.method === "PUT") {
        const triggerId = String(body.triggerId || "");
        if (!ID.test(triggerId)) throw new Error("trigger_id_invalid");
        const { schedule, payloadJson } = parseTrigger(body.input);
        const existing = this.ctx.storage.sql.exec<ScheduleRow>("SELECT * FROM triggers WHERE trigger_id = ?", triggerId).toArray()[0];
        if (existing && existing.active === 1 && existing.payload_json === payloadJson &&
          JSON.stringify(storedSchedule(existing)) === JSON.stringify(schedule)) {
          return json({ tenantId: body.tenantId, triggerId, version: existing.version,
            nextDueAt: existing.next_due_at === null ? null : new Date(existing.next_due_at).toISOString(), idempotent: true });
        }
        const version = (existing?.version ?? 0) + 1;
        const next = nextDue(schedule, Date.now());
        this.ctx.storage.sql.exec(
          `INSERT INTO triggers(trigger_id, kind, run_at, expression, timezone, payload_json, version, active, next_due_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
           ON CONFLICT(trigger_id) DO UPDATE SET kind=excluded.kind, run_at=excluded.run_at,
           expression=excluded.expression, timezone=excluded.timezone, payload_json=excluded.payload_json,
           version=excluded.version, active=1, next_due_at=excluded.next_due_at, updated_at=excluded.updated_at`,
          triggerId, schedule.kind, schedule.kind === "once" ? schedule.runAt : null,
          schedule.kind === "cron" ? schedule.expression : null,
          schedule.kind === "cron" ? schedule.timezone : null, payloadJson, version, next, Date.now(),
        );
        this.ctx.storage.sql.exec(
          "UPDATE occurrences SET status = 'cancelled', updated_at = ? WHERE trigger_id = ? AND status IN ('pending', 'queued')",
          Date.now(), triggerId,
        );
        await this.arm();
        return json({ tenantId: body.tenantId, triggerId, version, nextDueAt: new Date(next).toISOString() });
      }
      if (path === "/cancel" && request.method === "POST") {
        const triggerId = String(body.triggerId || "");
        this.ctx.storage.sql.exec("UPDATE triggers SET active = 0, next_due_at = NULL, updated_at = ? WHERE trigger_id = ?", Date.now(), triggerId);
        this.ctx.storage.sql.exec(
          "UPDATE occurrences SET status = 'cancelled', updated_at = ? WHERE trigger_id = ? AND status IN ('pending', 'queued')",
          Date.now(), triggerId,
        );
        await this.arm();
        return json({ triggerId, cancelled: true });
      }
      if (path === "/status" && request.method === "GET") {
        const triggers = [...this.ctx.storage.sql.exec<ScheduleRow>("SELECT * FROM triggers ORDER BY updated_at DESC LIMIT 100")]
          .map(({ payload_json: _payload, ...row }) => row);
        const occurrences = [...this.ctx.storage.sql.exec<OccurrenceRow>("SELECT * FROM occurrences ORDER BY due_at DESC LIMIT 100")]
          .map(({ payload_json: _payload, lease_token: _lease, ...row }) => row);
        return json({ triggers, occurrences });
      }
      if (path === "/claim" && request.method === "POST") {
        const id = String(body.occurrenceId || "");
        const row = this.ctx.storage.sql.exec<OccurrenceRow>("SELECT * FROM occurrences WHERE id = ?", id).toArray()[0];
        if (!row) return json({ state: "missing" }, 404);
        if (!["pending", "queued", "dispatching"].includes(row.status)) return json({ state: "done", status: row.status });
        if (row.status === "dispatching" && (row.lease_until ?? 0) > Date.now()) return json({ state: "busy" });
        const lease = crypto.randomUUID();
        this.ctx.storage.sql.exec(
          "UPDATE occurrences SET status = 'dispatching', attempts = attempts + 1, lease_token = ?, lease_until = ?, updated_at = ? WHERE id = ?",
          lease, Date.now() + 60_000, Date.now(), id,
        );
        return json({ state: "claimed", lease, occurrence: {
          id: row.id, triggerId: row.trigger_id, scheduledAt: new Date(row.due_at).toISOString(),
          version: row.version, payload: JSON.parse(row.payload_json),
        } });
      }
      if (path === "/accepted" && request.method === "POST") {
        this.ctx.storage.sql.exec(
          "UPDATE occurrences SET status = 'accepted', dsh_run_id = ?, accepted_at = ?, lease_token = NULL, lease_until = NULL, updated_at = ? WHERE id = ? AND status = 'dispatching' AND lease_token = ?",
          String(body.runId || ""), Date.now(), Date.now(), String(body.occurrenceId || ""), String(body.lease || ""),
        );
        await this.arm();
        return json({ recorded: true });
      }
      if (path === "/retry" && request.method === "POST") {
        this.ctx.storage.sql.exec(
          "UPDATE occurrences SET status = ?, error = ?, lease_token = NULL, lease_until = NULL, updated_at = ? WHERE id = ? AND status = 'dispatching' AND lease_token = ?",
          body.exhausted ? "dispatch_failed" : "queued", String(body.error || "dispatch_failed").slice(0, 300), Date.now(),
          String(body.occurrenceId || ""), String(body.lease || ""),
        );
        return json({ recorded: true });
      }
      if (path === "/terminal" && request.method === "POST") {
        const id = String(body.occurrenceId || "");
        const input = body.input as TerminalInput;
        if (!input || !["completed", "failed"].includes(input.status)) throw new Error("terminal_status_invalid");
        const row = this.ctx.storage.sql.exec<OccurrenceRow>("SELECT * FROM occurrences WHERE id = ?", id).toArray()[0];
        if (!row) return json({ error: "occurrence_not_found" }, 404);
        if (["completed", "failed"].includes(row.status)) return json({ status: row.status, idempotent: row.status === input.status }, row.status === input.status ? 200 : 409);
        if (!["dispatching", "accepted", "needs_reconciliation", "dispatch_failed"].includes(row.status)) return json({ error: "occurrence_not_dispatched" }, 409);
        if (row.dsh_run_id && input.runId && row.dsh_run_id !== input.runId) return json({ error: "dsh_run_id_mismatch" }, 409);
        if (input.receiptId !== undefined && (typeof input.receiptId !== "string" || input.receiptId.length > 200)) throw new Error("receipt_id_invalid");
        const receipt = input.receiptId ? JSON.stringify({ receiptId: input.receiptId }) : null;
        this.ctx.storage.sql.exec(
          "UPDATE occurrences SET status = ?, dsh_run_id = COALESCE(dsh_run_id, ?), receipt_json = ?, updated_at = ? WHERE id = ?",
          input.status, input.runId || null, receipt, Date.now(), id,
        );
        await this.arm();
        return json({ status: input.status, occurrenceId: id });
      }
      return json({ error: "not_found" }, 404);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "invalid_request" }, 400);
    }
  }
}

async function dispatch(env: AppEnv, message: Message<DispatchMessage>): Promise<void> {
  const { tenantId, occurrenceId } = message.body || {} as DispatchMessage;
  if (!ID.test(tenantId || "") || !occurrenceId?.startsWith(`${tenantId}:`)) { message.ack(); return; }
  const claimedResponse = await doCall(env, tenantId, "/claim", "POST", { occurrenceId });
  const claimed = await claimedResponse.json() as {
    state: string; lease?: string; occurrence?: { id: string; triggerId: string; scheduledAt: string; version: number; payload: unknown };
  };
  if (claimed.state === "done" || claimed.state === "missing") { message.ack(); return; }
  if (claimed.state === "busy" || !claimed.occurrence || !claimed.lease) { message.retry({ delaySeconds: 30 }); return; }
  const { occurrence, lease } = claimed;
  try {
    if (env.DISPATCH_ENABLED !== "true") throw new Error("dispatch_disabled");
    const url = new URL(env.DSH_TRIGGER_URL);
    if (url.protocol !== "https:" && !(env.ENVIRONMENT === "local" && url.hostname === "127.0.0.1")) throw new Error("dsh_trigger_url_invalid");
    if (!env.DSH_DISPATCH_TOKEN) throw new Error("dsh_dispatch_token_missing");
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${env.DSH_DISPATCH_TOKEN}`,
        "content-type": "application/json",
        "idempotency-key": occurrence.id,
        "x-hivemind-tenant-id": tenantId,
        "x-hivemind-trigger-id": occurrence.triggerId,
        "x-hivemind-occurrence-id": occurrence.id,
        "x-hivemind-scheduled-at": occurrence.scheduledAt,
        "x-hivemind-trigger-version": String(occurrence.version),
      },
      body: JSON.stringify(occurrence.payload),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`dsh_http_${response.status}`);
    const ack = await response.json().catch(() => ({})) as { runId?: string; workflowId?: string; id?: string };
    const runId = String(ack.runId || ack.workflowId || ack.id || response.headers.get("x-dsh-run-id") || "");
    if (!runId) throw new Error("dsh_run_id_missing");
    const recorded = await doCall(env, tenantId, "/accepted", "POST", { occurrenceId, lease, runId });
    if (!recorded.ok) throw new Error("occurrence_acceptance_failed");
    message.ack();
  } catch (error) {
    const exhausted = message.attempts >= MAX_QUEUE_ATTEMPTS;
    await doCall(env, tenantId, "/retry", "POST", {
      occurrenceId, lease, exhausted, error: error instanceof Error ? error.message : "dispatch_failed",
    });
    message.retry({ delaySeconds: exhausted ? 0 : Math.min(300, 15 * 2 ** Math.min(message.attempts, 4)) });
  }
}

export default {
  async fetch(request: Request, env: AppEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ status: "ready", enabled: env.DISPATCH_ENABLED === "true" });
    const match = /^\/v1\/tenants\/([^/]+)(?:\/triggers\/([^/]+)|\/occurrences\/([^/]+)\/terminal|\/status)$/.exec(url.pathname);
    if (!match || !ID.test(match[1])) return json({ error: "not_found" }, 404);
    const [, tenantId, triggerId, occurrenceId] = match;
    const callback = Boolean(occurrenceId);
    if (!sameToken(request.headers.get("authorization"), callback ? env.DSH_CALLBACK_TOKEN : env.SCHEDULER_ADMIN_TOKEN)) {
      return json({ error: "unauthorized" }, 401);
    }
    if (callback && request.method === "POST") {
      const input = await request.json().catch(() => null);
      return doCall(env, tenantId, "/terminal", "POST", { occurrenceId, input });
    }
    if (triggerId && ID.test(triggerId) && request.method === "PUT") {
      const input = await request.json().catch(() => null);
      return doCall(env, tenantId, "/register", "PUT", { triggerId, input });
    }
    if (triggerId && ID.test(triggerId) && request.method === "DELETE") {
      return doCall(env, tenantId, "/cancel", "POST", { triggerId });
    }
    if (url.pathname.endsWith("/status") && request.method === "GET") {
      return doCall(env, tenantId, "/status", "GET");
    }
    return json({ error: "not_found" }, 404);
  },
  async queue(batch: MessageBatch<DispatchMessage>, env: AppEnv): Promise<void> {
    for (let i = 0; i < batch.messages.length; i += 3) {
      await Promise.all(batch.messages.slice(i, i + 3).map((message) => dispatch(env, message)));
    }
  },
} satisfies ExportedHandler<AppEnv, DispatchMessage>;
