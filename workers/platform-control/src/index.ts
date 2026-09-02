import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import {
  isUuid,
  normalizedEmail,
  redactedEvent,
  type RegistryEvent,
  validEvent,
} from "./contract";
export { validEvent, normalizedEmail } from "./contract";

type Env = {
  PLATFORM_DB: D1Database;
  PLATFORM_REGISTRY_ADMISSION_SECRET: string;
  REGISTRY_RECONCILE_WORKFLOW: Workflow<{ after?: string }>;
  PLATFORM_REGISTRY_MODE?: string;
};
const MAX_BODY = 64 * 1024;
async function authorized(r: Request, env: Env) {
  const value = (r.headers.get("authorization") || "").replace(
    /^Bearer\s+/i,
    "",
  );
  if (!value || !env.PLATFORM_REGISTRY_ADMISSION_SECRET) return false;
  const e = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", e.encode(value)),
    crypto.subtle.digest(
      "SHA-256",
      e.encode(env.PLATFORM_REGISTRY_ADMISSION_SECRET),
    ),
  ]);
  const x = new Uint8Array(a),
    y = new Uint8Array(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.min(x.length, y.length); i++) d |= x[i] ^ y[i];
  return d === 0;
}
async function body(r: Request): Promise<unknown> {
  if (Number(r.headers.get("content-length") || 0) > MAX_BODY)
    throw new Error("payload_too_large");
  const raw = await r.text();
  if (raw.length > MAX_BODY) throw new Error("payload_too_large");
  return JSON.parse(raw);
}
function json(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}
async function apply(db: D1Database, event: RegistryEvent) {
  const known = await db
    .prepare("SELECT event_id FROM registry_events WHERE event_id=?")
    .bind(event.event_id)
    .first();
  if (known) return { applied: false, duplicate: true };
  const p = event.payload;
  const genericTypes = new Set([
    "team",
    "project",
    "team_member",
    "project_member",
    "notification",
    "organization_profile",
    "billing_checkout",
    "plan_catalog",
  ]);
  if (genericTypes.has(event.entity_type)) {
    const existing = await db
      .prepare(
        "SELECT revision FROM registry_workspace_records WHERE entity_type=? AND entity_id=?",
      )
      .bind(event.entity_type, event.entity_id)
      .first<{ revision: number }>();
    if (existing && existing.revision >= event.revision) {
      await db
        .prepare(
          "INSERT INTO registry_events(event_id,entity_type,entity_id,revision,operation,payload_json) VALUES(?,?,?,?,?,?)",
        )
        .bind(
          event.event_id,
          event.entity_type,
          event.entity_id,
          event.revision,
          event.operation,
          JSON.stringify(p),
        )
        .run();
      return { applied: false, duplicate: false, stale: true };
    }
    await db.batch([
      db
        .prepare(
          "INSERT INTO registry_workspace_records(entity_type,entity_id,org_id,payload_json,revision,deleted_at) VALUES(?,?,?,?,?,?) ON CONFLICT(entity_type,entity_id) DO UPDATE SET org_id=excluded.org_id,payload_json=excluded.payload_json,revision=excluded.revision,deleted_at=excluded.deleted_at",
        )
        .bind(
          event.entity_type,
          event.entity_id,
          String(p.org_id || "") || null,
          JSON.stringify(p),
          event.revision,
          event.operation === "delete" ? new Date().toISOString() : null,
        ),
      db
        .prepare(
          "INSERT INTO registry_events(event_id,entity_type,entity_id,revision,operation,payload_json) VALUES(?,?,?,?,?,?)",
        )
        .bind(
          event.event_id,
          event.entity_type,
          event.entity_id,
          event.revision,
          event.operation,
          JSON.stringify(p),
        ),
    ]);
    return { applied: true, duplicate: false };
  }
  const sql: Record<string, string> = {
    user: `INSERT INTO registry_users (id,zitadel_user_id,email_normalized,display_name,avatar_url,timezone,locale,encryption_key_id,encryption_key_version,created_at,updated_at,last_active_at,deleted_at,revision) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET zitadel_user_id=excluded.zitadel_user_id,email_normalized=excluded.email_normalized,display_name=excluded.display_name,avatar_url=excluded.avatar_url,timezone=excluded.timezone,locale=excluded.locale,encryption_key_id=excluded.encryption_key_id,encryption_key_version=excluded.encryption_key_version,updated_at=excluded.updated_at,last_active_at=excluded.last_active_at,deleted_at=excluded.deleted_at,revision=excluded.revision WHERE excluded.revision > registry_users.revision`,
    organization: `INSERT INTO registry_organizations (id,zitadel_org_id,name,slug,profile_json,commercial_json,billing_json,settings_json,hosting_mode,memory_storage_mode,created_at,updated_at,revision) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,slug=excluded.slug,profile_json=excluded.profile_json,commercial_json=excluded.commercial_json,billing_json=excluded.billing_json,settings_json=excluded.settings_json,hosting_mode=excluded.hosting_mode,memory_storage_mode=excluded.memory_storage_mode,updated_at=excluded.updated_at,revision=excluded.revision WHERE excluded.revision > registry_organizations.revision`,
    membership: `INSERT INTO registry_memberships (user_id,org_id,role,roles_json,is_active,invited_at,joined_at,deactivated_at,revision) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,org_id) DO UPDATE SET role=excluded.role,roles_json=excluded.roles_json,is_active=excluded.is_active,invited_at=excluded.invited_at,joined_at=excluded.joined_at,deactivated_at=excluded.deactivated_at,revision=excluded.revision WHERE excluded.revision > registry_memberships.revision`,
    invite: `INSERT INTO registry_invites (id,org_id,email_normalized,role,roles_json,token_hash,expires_at,used_at,revoked_at,created_by,idempotency_key,revision) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET used_at=excluded.used_at,revoked_at=excluded.revoked_at,revision=excluded.revision WHERE excluded.revision > registry_invites.revision`,
    api_key: `INSERT INTO registry_api_keys (id,user_id,org_id,key_hash,key_prefix,metadata_json,expires_at,revoked_at,revision) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET metadata_json=excluded.metadata_json,expires_at=excluded.expires_at,revoked_at=excluded.revoked_at,revision=excluded.revision WHERE excluded.revision > registry_api_keys.revision`,
    entitlement: `INSERT INTO registry_entitlements (id,org_id,source,phase,plan_id,limits_json,effective_from,effective_until,revision) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET limits_json=excluded.limits_json,effective_until=excluded.effective_until,revision=excluded.revision WHERE excluded.revision > registry_entitlements.revision`,
    memory_box: `INSERT INTO registry_memory_boxes (org_id,box_id,endpoint,credential_hash,credential_version,state,metadata_json,revision) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(org_id) DO UPDATE SET box_id=excluded.box_id,endpoint=excluded.endpoint,credential_hash=excluded.credential_hash,credential_version=excluded.credential_version,state=excluded.state,metadata_json=excluded.metadata_json,revision=excluded.revision WHERE excluded.revision > registry_memory_boxes.revision`,
  };
  if (event.operation === "delete") {
    const tables: Record<string, string> = {
      user: "registry_users",
      organization: "registry_organizations",
      membership: "registry_memberships",
      invite: "registry_invites",
      api_key: "registry_api_keys",
      entitlement: "registry_entitlements",
      memory_box: "registry_memory_boxes",
    };
    const where =
      event.entity_type === "membership"
        ? "user_id=? AND org_id=?"
        : event.entity_type === "memory_box"
          ? "org_id=?"
          : "id=?";
    const binds =
      event.entity_type === "membership"
        ? [p.user_id, p.org_id]
        : [event.entity_id];
    await db.batch([
      db
        .prepare(`DELETE FROM ${tables[event.entity_type]} WHERE ${where}`)
        .bind(...binds),
      db
        .prepare(
          "INSERT INTO registry_events(event_id,entity_type,entity_id,revision,operation,payload_json) VALUES(?,?,?,?,?,?)",
        )
        .bind(
          event.event_id,
          event.entity_type,
          event.entity_id,
          event.revision,
          event.operation,
          JSON.stringify(p),
        ),
    ]);
    return { applied: true, duplicate: false };
  }
  const values: Record<string, unknown[]> = {
    user: [
      event.entity_id,
      p.zitadel_user_id,
      normalizedEmail(p.email),
      p.display_name || null,
      p.avatar_url || null,
      p.timezone || null,
      p.locale || null,
      p.encryption_key_id || null,
      p.encryption_key_version || null,
      p.created_at || null,
      p.updated_at || null,
      p.last_active_at || null,
      p.deleted_at || null,
      event.revision,
    ],
    organization: [
      event.entity_id,
      p.zitadel_org_id,
      p.name,
      p.slug,
      JSON.stringify(p.profile || {}),
      JSON.stringify(p.commercial || {}),
      JSON.stringify(p.billing || {}),
      JSON.stringify(p.settings || {}),
      p.hosting_mode || null,
      p.memory_storage_mode || null,
      p.created_at || null,
      p.updated_at || null,
      event.revision,
    ],
    membership: [
      p.user_id,
      p.org_id,
      p.role,
      JSON.stringify(p.roles || []),
      p.is_active === false ? 0 : 1,
      p.invited_at || null,
      p.joined_at || null,
      p.deactivated_at || null,
      event.revision,
    ],
    invite: [
      event.entity_id,
      p.org_id,
      normalizedEmail(p.email),
      p.role,
      JSON.stringify(p.roles || []),
      p.token_hash,
      p.expires_at,
      p.used_at || null,
      p.revoked_at || null,
      p.created_by,
      p.idempotency_key || null,
      event.revision,
    ],
    api_key: [
      event.entity_id,
      p.user_id,
      p.org_id || null,
      p.key_hash,
      p.key_prefix,
      JSON.stringify(p.metadata || {}),
      p.expires_at || null,
      p.revoked_at || null,
      event.revision,
    ],
    entitlement: [
      event.entity_id,
      p.org_id,
      p.source,
      p.phase,
      p.plan_id,
      JSON.stringify(p.limits || {}),
      p.effective_from,
      p.effective_until || null,
      event.revision,
    ],
    memory_box: [
      p.org_id,
      p.box_id,
      p.endpoint || null,
      p.credential_hash || null,
      p.credential_version || null,
      p.state,
      JSON.stringify(p.metadata || {}),
      event.revision,
    ],
  };
  await db.batch([
    db.prepare(sql[event.entity_type]).bind(...values[event.entity_type]),
    db
      .prepare(
        "INSERT INTO registry_events(event_id,entity_type,entity_id,revision,operation,payload_json) VALUES(?,?,?,?,?,?)",
      )
      .bind(
        event.event_id,
        event.entity_type,
        event.entity_id,
        event.revision,
        event.operation,
        JSON.stringify(p),
      ),
  ]);
  return { applied: true, duplicate: false };
}
export class PlatformRegistryReconcileWorkflow extends WorkflowEntrypoint<
  Env,
  { after?: string }
> {
  async run(event: WorkflowEvent<{ after?: string }>, step: WorkflowStep) {
    return step.do("registry event count", async () => {
      const row = await this.env.PLATFORM_DB.prepare(
        "SELECT count(*) AS count, max(received_at) AS latest FROM registry_events",
      ).first<{ count: number; latest: string | null }>();
      return { count: Number(row?.count || 0), latest: row?.latest || null };
    });
  }
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/health")
      return json({ ok: true, mode: env.PLATFORM_REGISTRY_MODE || "off" });
    if (!(await authorized(request, env)))
      return json({ error: "unauthorized" }, 401);
    if (path === "/internal/v1/registry/events" && request.method === "POST") {
      try {
        const input = await body(request);
        if (!validEvent(input)) return json({ error: "invalid_event" }, 400);
        const result = await apply(env.PLATFORM_DB, input);
        console.log(
          JSON.stringify({
            event: "platform_registry_event",
            ...redactedEvent(input),
            ...result,
          }),
        );
        return json({ ok: true, ...result });
      } catch (e) {
        return json(
          { error: e instanceof Error ? e.message : "invalid_json" },
          400,
        );
      }
    }
    if (
      path === "/internal/v1/registry/membership" &&
      request.method === "GET"
    ) {
      const u = new URL(request.url);
      const userId = u.searchParams.get("user_id") || "",
        orgId = u.searchParams.get("org_id") || "";
      if (!isUuid(userId) || !isUuid(orgId))
        return json({ error: "invalid_identity" }, 400);
      const row = await env.PLATFORM_DB.prepare(
        "SELECT user_id,org_id,role,roles_json,is_active,joined_at,deactivated_at,revision FROM registry_memberships WHERE user_id=? AND org_id=?",
      )
        .bind(userId, orgId)
        .first();
      return json({ membership: row || null });
    }
    return json({ error: "not_found" }, 404);
  },
} satisfies ExportedHandler<Env>;
