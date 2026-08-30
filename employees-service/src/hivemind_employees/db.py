"""Async Postgres connection pool — reads DigitalEmployee + ApiKey
rows that the Node side writes. Read-only on hot path (employee
lifecycle stays in control-plane), but writes happen for metric bumps.
"""
from __future__ import annotations

import asyncpg
import json
import logging
from typing import Optional, List, Dict, Any

from .config import get_settings

log = logging.getLogger(__name__)

_pool: Optional[asyncpg.Pool] = None


def _normalize_dsn(url: str) -> str:
    """Strip Prisma-specific query params asyncpg doesn't understand."""
    # asyncpg doesn't accept ?schema=&connection_limit=&pool_timeout=
    base, _, _ = url.partition("?")
    return base


async def init_pool() -> asyncpg.Pool:
    global _pool
    if _pool is not None:
        return _pool
    settings = get_settings()
    dsn = _normalize_dsn(settings.database_url)
    log.info("Initializing asyncpg pool")
    _pool = await asyncpg.create_pool(
        dsn=dsn,
        min_size=2,
        max_size=8,
        timeout=30.0,
        command_timeout=15.0,
        # Schema must match Prisma's hivemind schema
        server_settings={"search_path": "hivemind, public"},
    )
    return _pool


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


async def validate_work_room_execution(identity: Dict[str, Any]) -> Dict[str, Any]:
    """Resolve and validate the canonical tenant-scoped Work Room turn.

    The HTTP request is transport, not identity truth. Refuse stale or crossed
    room/turn/org/user combinations before any model or worker can spend tokens.
    """
    pool = await init_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT t.id AS turn_id, t.room_id, r.org_id, r.user_id, r.room_mode
              FROM hivemind.hyper_turns t
              JOIN hivemind.hyper_rooms r ON r.id = t.room_id
             WHERE t.id = $1::uuid
            """,
            str(identity.get("turn_id") or ""),
        )
    if not row:
        raise ValueError("work_room_execution_turn_not_found")
    expected = {
        "execution_id": str(row["turn_id"]),
        "turn_id": str(row["turn_id"]),
        "room_id": str(row["room_id"]),
        "org_id": str(row["org_id"]),
        "user_id": str(row["user_id"]),
    }
    mismatched = [key for key, value in expected.items() if str(identity.get(key) or "") != value]
    if str(row["room_mode"] or "") != "work":
        mismatched.append("room_mode")
    if mismatched:
        raise ValueError("work_room_execution_identity_mismatch:" + ",".join(sorted(set(mismatched))))
    return expected


async def persist_work_room_progress(
    *, turn_id: str, phase: str, identity: Dict[str, Any] | None = None,
    candidate: Dict[str, Any] | None = None,
    verification: Dict[str, Any] | None = None,
    terminal_reason: str | None = None,
) -> bool:
    """Checkpoint a Work Room phase independently from callback delivery."""
    try:
        pool = await init_pool()
        async with pool.acquire() as conn:
            result = await conn.execute(
                """
                UPDATE hivemind.hyper_turns
                   SET execution_phase = $2,
                       execution_identity = CASE WHEN $3::jsonb = '{}'::jsonb THEN execution_identity ELSE $3::jsonb END,
                       candidate_output = CASE WHEN $4::jsonb = '{}'::jsonb THEN candidate_output ELSE $4::jsonb END,
                       verification_verdict = CASE WHEN $5::jsonb = '{}'::jsonb THEN verification_verdict ELSE $5::jsonb END,
                       terminal_reason = COALESCE($6, terminal_reason),
                       last_progress_at = now()
                 WHERE id = $1::uuid
                """,
                turn_id, phase[:32], json.dumps(identity or {}, ensure_ascii=False),
                json.dumps(candidate or {}, ensure_ascii=False),
                json.dumps(verification or {}, ensure_ascii=False), terminal_reason,
            )
        return result.endswith("1")
    except Exception as exc:  # additive migration may not be live yet
        log.info("persist_work_room_progress unavailable (non-fatal): %s", exc)
        return False


async def persist_hyper_turn_outbox_event(turn_id: str, event: Dict[str, Any]) -> bool:
    """Persist an event before transport so callback loss cannot lose truth."""
    event_id = str(event.get("event_id") or "").strip()
    if not event_id:
        return False
    try:
        pool = await init_pool()
        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO hivemind.hyper_turn_event_outbox (turn_id, event_id, event)
                VALUES ($1::uuid, $2, $3::jsonb)
                ON CONFLICT (turn_id, event_id) DO NOTHING
                """,
                turn_id, event_id[:120], json.dumps(event, ensure_ascii=False),
            )
        return True
    except Exception as exc:
        log.info("persist_hyper_turn_outbox_event unavailable (non-fatal): %s", exc)
        return False


async def mark_hyper_turn_outbox_delivered(turn_id: str, event_id: str) -> bool:
    try:
        pool = await init_pool()
        async with pool.acquire() as conn:
            await conn.execute(
                """UPDATE hivemind.hyper_turn_event_outbox SET delivered_at = now()
                     WHERE turn_id = $1::uuid AND event_id = $2""",
                turn_id, event_id[:120],
            )
        return True
    except Exception:
        return False


async def get_work_room_execution_profile(turn_id: str) -> Optional[Dict[str, Any]]:
    """Read a turn's already-selected execution profile, if any.

    Called BEFORE running the profile-selection classifier, so a resume, retry,
    or reconnected turn re-enters the exact same specialist engine instead of
    asking the classifier again — an LLM call is not guaranteed to repeat its
    own answer, so "read before select" is what actually makes reselection
    impossible, not just unlikely.
    """
    try:
        pool = await init_pool()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT execution_profile FROM hivemind.hyper_turns WHERE id = $1::uuid",
                turn_id,
            )
    except Exception as exc:  # additive migration may not be live yet
        log.info("get_work_room_execution_profile unavailable (non-fatal): %s", exc)
        return None
    if not row or not row["execution_profile"]:
        return None
    value = row["execution_profile"]
    return json.loads(value) if isinstance(value, str) else dict(value)


async def persist_work_room_execution_profile(turn_id: str, profile: Dict[str, Any]) -> bool:
    """Write a turn's selected execution profile EXACTLY ONCE.

    The `WHERE execution_profile IS NULL` guard makes "never reclassify the
    same turn" an atomic property of this single UPDATE, not an application
    race between an earlier read and this write. Returns False (not an error)
    when a profile was already persisted — the caller should read it back with
    `get_work_room_execution_profile` rather than treat this as failure.
    """
    try:
        pool = await init_pool()
        async with pool.acquire() as conn:
            result = await conn.execute(
                """
                UPDATE hivemind.hyper_turns
                   SET execution_profile = $2::jsonb
                 WHERE id = $1::uuid AND execution_profile IS NULL
                """,
                turn_id, json.dumps(profile, ensure_ascii=False),
            )
        return result.endswith("1")
    except Exception as exc:  # additive migration may not be live yet
        log.info("persist_work_room_execution_profile unavailable (non-fatal): %s", exc)
        return False


async def list_running_employees() -> List[Dict[str, Any]]:
    """Pull every active employee row — gateway iterates this on boot
    and on every reconcile tick."""
    pool = await init_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT
              id, org_id, team_id, name, slug, persona, model, llm_provider,
              scope, slack_team_id, slack_channels_allowed, tools, policy_rules,
              status, replicas, max_replicas, hivemind_api_key_id, created_by,
              avatar_url, slack_display_name, slack_avatar_emoji,
              role_archetype, peer_review_targets
            FROM hivemind.digital_employees
            WHERE archived_at IS NULL
              AND status IN ('running', 'deploying')
            ORDER BY updated_at DESC
            """
        )
    out: List[Dict[str, Any]] = []
    for row in rows:
        item = dict(row)
        for key in ("id", "org_id", "team_id", "hivemind_api_key_id", "created_by"):
            if item.get(key) is not None:
                item[key] = str(item[key])
        out.append(item)
    return out


async def list_employees_by_ids(ids: List[str], org_id: Optional[str] = None) -> List[Dict[str, Any]]:
    """Fetch employees by id, ignoring status. Used by hyper-rooms where
    the user explicitly selected participants — Slack-gateway's
    running/deploying filter would wrongly exclude draft employees that
    have never been resumed.

    org_id MUST be passed by callers acting on behalf of a tenant: it
    enforces that loaded employees belong to that org, preventing
    cross-org invocation when a request body mixes foreign employee ids."""
    if not ids:
        return []
    pool = await init_pool()
    async with pool.acquire() as conn:
        if org_id is not None:
            rows = await conn.fetch(
                """
                SELECT
                  id, org_id, team_id, name, slug, persona, model, llm_provider,
                  scope, slack_team_id, slack_channels_allowed, tools, policy_rules,
                  status, replicas, max_replicas, hivemind_api_key_id, created_by,
                  avatar_url, slack_display_name, slack_avatar_emoji,
                  role_archetype, peer_review_targets
                FROM hivemind.digital_employees
                WHERE archived_at IS NULL
                  AND status <> 'paused'
                  AND id = ANY($1::uuid[])
                  AND org_id = $2::uuid
                """,
                ids, org_id,
            )
        else:
            rows = await conn.fetch(
                """
                SELECT
                  id, org_id, team_id, name, slug, persona, model, llm_provider,
                  scope, slack_team_id, slack_channels_allowed, tools, policy_rules,
                  status, replicas, max_replicas, hivemind_api_key_id, created_by,
                  avatar_url, slack_display_name, slack_avatar_emoji,
                  role_archetype, peer_review_targets
                FROM hivemind.digital_employees
                WHERE archived_at IS NULL
                  AND status <> 'paused'
                  AND id = ANY($1::uuid[])
                """,
                ids,
            )
    out: List[Dict[str, Any]] = []
    for row in rows:
        item = dict(row)
        for key in ("id", "org_id", "team_id", "hivemind_api_key_id", "created_by"):
            if item.get(key) is not None:
                item[key] = str(item[key])
        out.append(item)
    return out


async def get_api_key_for_employee(employee_id: str) -> Optional[Dict[str, Any]]:
    """Resolve the scoped HIVEMIND API key bound to an employee.
    Returns the row; raw key NEVER reads back (only hash stored), so this
    service must receive the raw key via env at container-boot OR derive
    it from a master-key call to control-plane /v1/employees/:id/rotate-key.
    """
    pool = await init_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT ak.id, ak.key_prefix, ak.scopes, ak.is_active
            FROM hivemind.digital_employees de
            JOIN hivemind.api_keys ak ON ak.id = de.hivemind_api_key_id
            WHERE de.id = $1
            """,
            employee_id,
        )
    return dict(row) if row else None


async def get_permanent_skeptic_id(room_id: str, org_id: Optional[str] = None) -> Optional[str]:
    """Returns the permanent_skeptic_id for the room, or None.
    Gracefully tolerates pre-migration rooms (column absent).

    org_id, when passed, scopes the read so a foreign room_id cannot leak
    a skeptic id from another tenant."""
    pool = await init_pool()
    async with pool.acquire() as conn:
        try:
            if org_id is not None:
                row = await conn.fetchrow(
                    "SELECT permanent_skeptic_id::text FROM hivemind.hyper_rooms "
                    "WHERE id = $1 AND org_id = $2::uuid",
                    room_id, org_id,
                )
            else:
                row = await conn.fetchrow(
                    "SELECT permanent_skeptic_id::text FROM hivemind.hyper_rooms WHERE id = $1",
                    room_id,
                )
            if row and row["permanent_skeptic_id"]:
                return str(row["permanent_skeptic_id"])
        except Exception as exc:  # noqa: BLE001
            log.warning("get_permanent_skeptic_id fallback: %s", exc)
    return None


async def get_permanent_lead_id(room_id: str, org_id: Optional[str] = None) -> Optional[str]:
    """Returns the permanent_lead_id for the room, or None.
    Gracefully tolerates pre-migration rooms (column absent)."""
    pool = await init_pool()
    async with pool.acquire() as conn:
        try:
            if org_id is not None:
                row = await conn.fetchrow(
                    "SELECT permanent_lead_id::text FROM hivemind.hyper_rooms "
                    "WHERE id = $1 AND org_id = $2::uuid",
                    room_id, org_id,
                )
            else:
                row = await conn.fetchrow(
                    "SELECT permanent_lead_id::text FROM hivemind.hyper_rooms WHERE id = $1",
                    room_id,
                )
            if row and row["permanent_lead_id"]:
                return str(row["permanent_lead_id"])
        except Exception as exc:  # noqa: BLE001
            log.warning("get_permanent_lead_id fallback: %s", exc)
    return None


async def set_permanent_skeptic_id(room_id: str, employee_id: Optional[str]) -> bool:
    """PATCH the permanent Skeptic for a room."""
    pool = await init_pool()
    try:
        async with pool.acquire() as conn:
            await conn.execute(
                "UPDATE hivemind.hyper_rooms SET permanent_skeptic_id = $1::uuid WHERE id = $2",
                employee_id, room_id,
            )
            return True
    except Exception as exc:  # noqa: BLE001
        log.warning("set_permanent_skeptic_id failed: %s", exc)
        return False


async def set_permanent_lead_id(room_id: str, employee_id: Optional[str]) -> bool:
    """PATCH the permanent lead for a room."""
    pool = await init_pool()
    try:
        async with pool.acquire() as conn:
            await conn.execute(
                "UPDATE hivemind.hyper_rooms SET permanent_lead_id = $1::uuid WHERE id = $2",
                employee_id, room_id,
            )
            return True
    except Exception as exc:  # noqa: BLE001
        log.warning("set_permanent_lead_id failed: %s", exc)
        return False


async def get_recent_turn_context(room_id: str, org_id: Optional[str] = None,
                                  limit: int = 4) -> List[Dict[str, Any]]:
    """Event-driven room memory for direct exchanges (@mention turns): the last N
    SEALED turns' (user_message, answering agent, answer text) read straight from
    hyper_turns.lines — the turn row IS the event bus, no extra store. Answer = the
    LAST 'line' event's content (the synthesis/lead reply). Oldest-first. Empty list
    on any failure (grounding is best-effort, never fatal). org_id tenant-scopes."""
    import json as _json
    out: List[Dict[str, Any]] = []
    pool = await init_pool()
    async with pool.acquire() as conn:
        try:
            if org_id is not None:
                rows = await conn.fetch(
                    "SELECT t.user_message, t.lines FROM hivemind.hyper_turns t "
                    "JOIN hivemind.hyper_rooms r ON r.id = t.room_id "
                    "WHERE t.room_id = $1 AND r.org_id = $2::uuid AND t.status = 'complete' "
                    "ORDER BY t.seq DESC LIMIT $3",
                    room_id, org_id, max(1, min(int(limit or 4), 8)),
                )
            else:
                rows = await conn.fetch(
                    "SELECT user_message, lines FROM hivemind.hyper_turns "
                    "WHERE room_id = $1 AND status = 'complete' ORDER BY seq DESC LIMIT $2",
                    room_id, max(1, min(int(limit or 4), 8)),
                )
            for row in rows:
                raw = row["lines"]
                lines = _json.loads(raw) if isinstance(raw, str) else list(raw or [])
                agent, answer = None, ""
                for ev in reversed(lines):
                    if isinstance(ev, dict) and ev.get("t") == "line" and (ev.get("content") or "").strip():
                        agent, answer = ev.get("agent"), str(ev.get("content") or "")
                        break
                if answer:
                    out.append({"user_message": str(row["user_message"] or ""),
                                "agent": agent, "answer": answer})
        except Exception as exc:  # noqa: BLE001
            log.warning("get_recent_turn_context fallback: %s", exc)
    return list(reversed(out))


async def get_turn_seq(turn_id: str, org_id: Optional[str] = None) -> Optional[int]:
    """Return the monotonic per-room seq for a turn (rotation ordinal).

    Returns None (NOT 0) when the row/column is unreadable — missing row,
    NULL seq, absent column (pre-migration), or DB error. Callers MUST
    distinguish None ('no seq available') from a real 0 and fall back to a
    deterministic-but-varying ordinal, otherwise every fallback turn would
    elect the same alphabetically-first lead/skeptic forever.

    org_id, when passed, scopes the read via hyper_turns -> hyper_rooms so
    a foreign turn_id cannot leak a seq from another tenant."""
    pool = await init_pool()
    async with pool.acquire() as conn:
        try:
            if org_id is not None:
                row = await conn.fetchrow(
                    "SELECT t.seq FROM hivemind.hyper_turns t "
                    "JOIN hivemind.hyper_rooms r ON r.id = t.room_id "
                    "WHERE t.id = $1 AND r.org_id = $2::uuid",
                    turn_id, org_id,
                )
            else:
                row = await conn.fetchrow(
                    "SELECT seq FROM hivemind.hyper_turns WHERE id = $1", turn_id
                )
            if row and row["seq"] is not None:
                return int(row["seq"])
        except Exception as exc:  # noqa: BLE001
            log.warning("get_turn_seq fallback (returning None): %s", exc)
    return None


async def get_room_template(room_id: str, org_id: Optional[str] = None) -> str:
    """B1: return the room's template ('debate' or 'decision').
    Defaults to 'debate' if row missing or column absent (graceful pre-migration).

    org_id, when passed, scopes the read so a foreign room_id cannot leak
    another tenant's template."""
    pool = await init_pool()
    async with pool.acquire() as conn:
        try:
            if org_id is not None:
                row = await conn.fetchrow(
                    "SELECT template FROM hivemind.hyper_rooms WHERE id = $1 AND org_id = $2::uuid",
                    room_id, org_id,
                )
            else:
                row = await conn.fetchrow(
                    "SELECT template FROM hivemind.hyper_rooms WHERE id = $1",
                    room_id,
                )
            if row and row["template"]:
                return str(row["template"])
        except Exception as exc:  # noqa: BLE001
            log.warning("get_room_template fallback: %s", exc)
    return "debate"


async def get_room_quality_mode(room_id: str, org_id: Optional[str] = None) -> str:
    """Return the room's quality mode ('auto' = multi-model cheap-gather+strong-synth,
    or 'best' = all gpt-oss-120b). Defaults to 'auto' if row/column missing (graceful
    pre-migration). org_id scopes the read so a foreign room_id can't leak config."""
    pool = await init_pool()
    async with pool.acquire() as conn:
        try:
            if org_id is not None:
                row = await conn.fetchrow(
                    "SELECT quality_mode FROM hivemind.hyper_rooms WHERE id = $1 AND org_id = $2::uuid",
                    room_id, org_id,
                )
            else:
                row = await conn.fetchrow(
                    "SELECT quality_mode FROM hivemind.hyper_rooms WHERE id = $1",
                    room_id,
                )
            if row and row["quality_mode"]:
                return str(row["quality_mode"])
        except Exception as exc:  # noqa: BLE001
            log.warning("get_room_quality_mode fallback: %s", exc)
    return "auto"


async def get_room_sim_mode(room_id: str, org_id: Optional[str] = None) -> str:
    """Return the room's population-sim mode ('on' = run the additional population simulation,
    else 'off'). Defaults to 'off' (graceful pre-migration: the additional feature is opt-in,
    so a missing column simply means the main flow runs untouched). org_id scopes the read."""
    pool = await init_pool()
    async with pool.acquire() as conn:
        try:
            if org_id is not None:
                row = await conn.fetchrow(
                    "SELECT sim_mode FROM hivemind.hyper_rooms WHERE id = $1 AND org_id = $2::uuid",
                    room_id, org_id,
                )
            else:
                row = await conn.fetchrow(
                    "SELECT sim_mode FROM hivemind.hyper_rooms WHERE id = $1", room_id,
                )
            if row and row["sim_mode"]:
                return str(row["sim_mode"])
        except Exception as exc:  # noqa: BLE001
            log.warning("get_room_sim_mode fallback: %s", exc)
    return "off"


async def get_room_sim_agents(room_id: str, org_id: Optional[str] = None) -> int:
    """Population-sim cast size (FE slider 10-100). Defaults to 24 (graceful pre-migration).
    Clamped to [10, 100] so a bad value can't blow up the parallel burst."""
    pool = await init_pool()
    async with pool.acquire() as conn:
        try:
            if org_id is not None:
                row = await conn.fetchrow(
                    "SELECT sim_agents FROM hivemind.hyper_rooms WHERE id = $1 AND org_id = $2::uuid",
                    room_id, org_id,
                )
            else:
                row = await conn.fetchrow(
                    "SELECT sim_agents FROM hivemind.hyper_rooms WHERE id = $1", room_id,
                )
            if row and row["sim_agents"]:
                return max(10, min(100, int(row["sim_agents"])))
        except Exception as exc:  # noqa: BLE001
            log.warning("get_room_sim_agents fallback: %s", exc)
    return 24


async def get_room_evo_mode(room_id: str, org_id: Optional[str] = None) -> str:
    """Self-evolving employees toggle ('on' = reflect+inject per-employee playbooks).
    Defaults to 'on' for a never-configured room — confirmed live 2026-08-12: a real
    turn generated genuinely useful, transferable lessons ("verify claims with
    external data", "state concrete next steps with dates/owners") from its own
    verify verdict, persisted them to digital_employees.evo_playbook, and a
    follow-up turn's get_employee_playbooks_map read them straight back — the
    write/read loop works end to end. A room that explicitly stores 'off' still
    gets 'off' (this only changes the NULL/never-set case, which used to silently
    mean dormant); any DB read failure also now fails open toward 'on' rather than
    silently disabling learning. org_id scopes the read."""
    try:
        pool = await init_pool()
        async with pool.acquire() as conn:
            if org_id is not None:
                row = await conn.fetchrow(
                    "SELECT evo_mode FROM hivemind.hyper_rooms WHERE id = $1 AND org_id = $2::uuid",
                    room_id, org_id,
                )
            else:
                row = await conn.fetchrow(
                    "SELECT evo_mode FROM hivemind.hyper_rooms WHERE id = $1", room_id,
                )
            if row and row["evo_mode"]:
                return str(row["evo_mode"])
    except Exception as exc:  # noqa: BLE001
        log.warning("get_room_evo_mode fallback: %s", exc)
    return "on"


async def get_employee_playbook(org_id: str, slug: str) -> list:
    """GLOBAL per-agent learned playbook — ordered list of operating lessons this
    employee distilled across ALL rooms. Lives on digital_employees (one row per
    org+slug) so it follows the agent into every room AND 1-on-1 private chat.
    Empty list if missing/pre-migration. org_id+slug scope the read (tenant-safe)."""
    import json as _json
    if not org_id or not slug:
        return []
    pool = await init_pool()
    async with pool.acquire() as conn:
        try:
            row = await conn.fetchrow(
                "SELECT evo_playbook FROM hivemind.digital_employees WHERE org_id = $1::uuid AND slug = $2",
                org_id, slug,
            )
            if row and row["evo_playbook"]:
                raw = row["evo_playbook"]
                pb = _json.loads(raw) if isinstance(raw, str) else list(raw)
                if isinstance(pb, list):
                    return [str(x) for x in pb if str(x).strip()]
        except Exception as exc:  # noqa: BLE001
            log.warning("get_employee_playbook fallback: %s", exc)
    return []


async def get_employee_playbooks_map(org_id: str, slugs: list) -> Dict[str, list]:
    """Batch form of get_employee_playbook for a room's participants: returns
    { "<slug>": ["lesson", ...] } for the given slugs. One query, tenant-scoped.
    Slugs with no lessons (or no row) are omitted. Empty dict on any failure."""
    import json as _json
    out: Dict[str, list] = {}
    clean = [str(s) for s in (slugs or []) if str(s).strip()]
    if not org_id or not clean:
        return out
    pool = await init_pool()
    async with pool.acquire() as conn:
        try:
            rows = await conn.fetch(
                "SELECT slug, evo_playbook FROM hivemind.digital_employees "
                "WHERE org_id = $1::uuid AND slug = ANY($2::text[])",
                org_id, clean,
            )
            for row in rows:
                raw = row["evo_playbook"]
                if not raw:
                    continue
                pb = _json.loads(raw) if isinstance(raw, str) else list(raw)
                if isinstance(pb, list):
                    lessons = [str(x) for x in pb if str(x).strip()]
                    if lessons:
                        out[str(row["slug"])] = lessons
        except Exception as exc:  # noqa: BLE001
            log.warning("get_employee_playbooks_map fallback: %s", exc)
    return out


async def update_employee_playbook(org_id: str, slug: str, lessons: list) -> bool:
    """Persist one employee's GLOBAL learned playbook (Loop 1 cross-room write-back).
    Best-effort: returns False (never raises) on failure so a reflection write can
    never break the sealed turn. org_id+slug scope the write (tenant-safe)."""
    import json as _json
    if not org_id or not slug or not isinstance(lessons, list):
        return False
    pool = await init_pool()
    async with pool.acquire() as conn:
        try:
            payload = _json.dumps([str(x) for x in lessons if str(x).strip()])
            await conn.execute(
                "UPDATE hivemind.digital_employees SET evo_playbook = $1::jsonb, updated_at = now() "
                "WHERE org_id = $2::uuid AND slug = $3",
                payload, org_id, slug,
            )
            return True
        except Exception as exc:  # noqa: BLE001
            log.warning("update_employee_playbook failed (non-fatal): %s", exc)
    return False


async def get_room_instructions(room_id: str, org_id: Optional[str] = None) -> str:
    """Owner-set Swarm Instructions for a room (agent_connectors._swarm_instructions).
    '' when unset. Fetched every turn so the room follows its standing orders on
    EVERY run regardless of which dispatch path kicked the turn."""
    if not room_id:
        return ""
    pool = await init_pool()
    async with pool.acquire() as conn:
        try:
            row = await conn.fetchrow(
                "SELECT agent_connectors->>'_swarm_instructions' AS si "
                "FROM hivemind.hyper_rooms WHERE id = $1::uuid"
                + (" AND org_id = $2::uuid" if org_id else ""),
                *( [room_id, org_id] if org_id else [room_id] ),
            )
            return str(row["si"] or "").strip()[:4000] if row and row["si"] else ""
        except Exception as exc:  # noqa: BLE001
            log.warning("get_room_instructions failed: %s", exc)
            return ""


async def get_room_playbook(room_id: str, org_id: Optional[str] = None) -> list:
    """ROOM-level learned method lessons (which skill sequences worked for this room
    kind), written by the post-turn reflection. Empty list if missing/pre-migration
    (graceful: the additional feature is dormant). org_id scopes the read."""
    import json as _json
    if not room_id:
        return []
    pool = await init_pool()
    async with pool.acquire() as conn:
        try:
            if org_id is not None:
                row = await conn.fetchrow(
                    "SELECT room_playbook FROM hivemind.hyper_rooms WHERE id = $1 AND org_id = $2::uuid",
                    room_id, org_id,
                )
            else:
                row = await conn.fetchrow(
                    "SELECT room_playbook FROM hivemind.hyper_rooms WHERE id = $1", room_id,
                )
            if row and row["room_playbook"]:
                raw = row["room_playbook"]
                pb = _json.loads(raw) if isinstance(raw, str) else list(raw)
                if isinstance(pb, list):
                    return [str(x) for x in pb if str(x).strip()]
        except Exception as exc:  # noqa: BLE001
            log.warning("get_room_playbook fallback: %s", exc)
    return []


async def update_room_playbook(room_id: str, org_id: str, lessons: list) -> bool:
    """Persist the room's learned method playbook. Best-effort (never raises) — a
    reflection write can never break the sealed turn. org-scoped (tenant-safe)."""
    import json as _json
    if not room_id or not org_id or not isinstance(lessons, list):
        return False
    pool = await init_pool()
    async with pool.acquire() as conn:
        try:
            payload = _json.dumps([str(x) for x in lessons if str(x).strip()])
            await conn.execute(
                "UPDATE hivemind.hyper_rooms SET room_playbook = $1::jsonb, updated_at = now() "
                "WHERE id = $2 AND org_id = $3::uuid",
                payload, room_id, org_id,
            )
            return True
        except Exception as exc:  # noqa: BLE001
            log.warning("update_room_playbook failed (non-fatal): %s", exc)
            return False


async def get_room_journal(room_id: str, org_id: str, limit: int = 8) -> list:
    """Return the Room's episodic journal, most-recent-last, capped at `limit`.

    Default `limit=8` is the EAGER continuity window — what's injected into
    every turn's prompt unconditionally (cheap, bounded, always present).
    Callers doing on-demand progressive loading (a Director tool reaching
    further back than the eager window) pass a larger `limit` — the stored
    array itself is no longer destructively trimmed to 8 on write (see
    append_room_journal_entry), so real older history exists to load."""
    try:
        pool = await init_pool()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT room_journal FROM hivemind.hyper_rooms "
                "WHERE id = $1::uuid AND org_id = $2::uuid",
                room_id, org_id,
            )
        raw = row["room_journal"] if row else []
        if isinstance(raw, str):
            raw = json.loads(raw)
        items = [item for item in (raw or []) if isinstance(item, dict)]
        return items[-max(1, int(limit or 8)):]
    except Exception as exc:  # noqa: BLE001
        log.warning("get_room_journal failed (non-fatal): %s", exc)
        return []


# Storage cap — generous enough that a room's real turn history survives for
# progressive on-demand loading (get_room_journal(limit=N) for N > 8), while
# still bounding jsonb column growth. NOT the same as the eager-injection
# window (8) — that's a read-time slice, not a storage limit. Before this,
# append_room_journal_entry trimmed the STORED array to 8 on every write,
# permanently deleting anything older — there was no history to "progressively
# load" because it never existed past turn 8. Confirmed live 2026-08-12: a
# room's own prior "Validate European AI Compliance Demand" decision was
# already gone from what the next turn could ever see beyond the eager block.
_JOURNAL_STORAGE_CAP = 200


async def append_room_journal_entry(room_id: str, org_id: str, entry: dict, keep: int = _JOURNAL_STORAGE_CAP) -> bool:
    """Append one journal entry atomically and retain the newest `keep` (storage
    cap, not the eager-injection window — see get_room_journal)."""
    if not isinstance(entry, dict):
        return False
    try:
        pool = await init_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                row = await conn.fetchrow(
                    "SELECT room_journal FROM hivemind.hyper_rooms "
                    "WHERE id = $1::uuid AND org_id = $2::uuid FOR UPDATE",
                    room_id, org_id,
                )
                if not row:
                    return False
                raw = row["room_journal"] or []
                if isinstance(raw, str):
                    raw = json.loads(raw)
                journal = [item for item in raw if isinstance(item, dict)]
                turn_id = str(entry.get("turn_id") or "").strip()
                if turn_id:
                    journal = [item for item in journal if str(item.get("turn_id") or "") != turn_id]
                journal.append(entry)
                journal = journal[-max(8, min(500, int(keep or _JOURNAL_STORAGE_CAP))):]
                await conn.execute(
                    "UPDATE hivemind.hyper_rooms SET room_journal = $1::jsonb, updated_at = now() "
                    "WHERE id = $2::uuid AND org_id = $3::uuid",
                    json.dumps(journal, ensure_ascii=False), room_id, org_id,
                )
        return True
    except Exception as exc:  # noqa: BLE001
        log.warning("append_room_journal_entry failed (non-fatal): %s", exc)
        return False


async def create_hyper_work_order(
    *,
    org_id: str,
    room_id: str,
    turn_id: str,
    order_key: str,
    kind: str,
    title: str,
    objective: str,
    owner: Dict[str, Any],
    selected_skills: list,
    required_evidence: list,
    acceptance_criteria: list,
    input_snapshot: Dict[str, Any],
    plan_step_id: str = "",
    depends_on: list | None = None,
    wait_for: Dict[str, Any] | None = None,
    handoff: Dict[str, Any] | None = None,
    agent_instance_id: str = "",
    workflow_instance_id: str = "",
    runtime_mode: str = "off",
    processing_version: int = 1,
) -> Optional[Dict[str, Any]]:
    """Create one tenant-scoped work order, idempotently per turn/order key.

    The migration is intentionally deployed separately. Until then this is a
    non-fatal no-op, allowing the shared runtime code to roll out safely before
    persistence is enabled.
    """
    if not all((org_id, room_id, turn_id, order_key, title, objective)):
        return None
    try:
        pool = await init_pool()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO hivemind.hyper_work_orders (
                  org_id, room_id, turn_id, order_key, plan_step_id, depends_on, kind, title, objective,
                  owner_employee_id, owner_slug, owner_lane, selected_skills,
                  required_evidence, acceptance_criteria, input_snapshot, wait_for, handoff,
                  agent_instance_id, workflow_instance_id, runtime_mode, processing_version
                ) VALUES (
                  $1::uuid, $2::uuid, $3::uuid, $4, NULLIF($5, ''), $6::jsonb, $7, $8, $9,
                  NULLIF($10, '')::uuid, $11, $12, $13::jsonb, $14::jsonb, $15::jsonb, $16::jsonb,
                  $17::jsonb, $18::jsonb, NULLIF($19, ''), NULLIF($20, ''), $21, $22
                )
                ON CONFLICT (turn_id, order_key) DO UPDATE
                  SET updated_at = now()
                RETURNING id, status, attempt
                """,
                org_id, room_id, turn_id, order_key[:80], plan_step_id[:80],
                json.dumps(depends_on or [], ensure_ascii=False), kind[:40], title[:180], objective,
                str(owner.get("id") or ""), str(owner.get("slug") or "")[:120],
                str(owner.get("_lane") or owner.get("lane") or "")[:40],
                json.dumps(selected_skills or [], ensure_ascii=False),
                json.dumps(required_evidence or [], ensure_ascii=False),
                json.dumps(acceptance_criteria or [], ensure_ascii=False),
                json.dumps(input_snapshot or {}, ensure_ascii=False),
                json.dumps(wait_for or {}, ensure_ascii=False),
                json.dumps(handoff or {}, ensure_ascii=False), agent_instance_id[:180],
                workflow_instance_id[:180], runtime_mode[:32], max(1, int(processing_version or 1)),
            )
        return {"id": str(row["id"]), "status": row["status"], "attempt": int(row["attempt"] or 0)} if row else None
    except Exception as exc:  # migration may not have landed yet; never sink a Room turn
        log.info("create_hyper_work_order unavailable (non-fatal): %s", exc)
        return None


async def upsert_hyper_agent_runtime(
    *, org_id: str, employee_id: str, agent_instance_id: str,
    capability_manifest: Dict[str, Any], processing_version: int = 1,
) -> Optional[Dict[str, Any]]:
    """Idempotently provision one stable runtime identity for a hired employee."""
    try:
        pool = await init_pool()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO hivemind.hyper_agent_runtimes
                  (org_id, employee_id, agent_instance_id, processing_version, capability_manifest)
                VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb)
                ON CONFLICT (employee_id) DO UPDATE SET
                  capability_manifest = EXCLUDED.capability_manifest,
                  processing_version = EXCLUDED.processing_version,
                  updated_at = now()
                WHERE hivemind.hyper_agent_runtimes.org_id = EXCLUDED.org_id
                RETURNING agent_instance_id, status, processing_version
                """,
                org_id, employee_id, agent_instance_id, max(1, int(processing_version or 1)),
                json.dumps(capability_manifest or {}, ensure_ascii=False),
            )
        return dict(row) if row else None
    except Exception as exc:
        log.info("upsert_hyper_agent_runtime unavailable: %s", exc)
        return None


async def pause_hyper_work_order(
    *,
    work_order_id: str,
    org_id: str,
    status: str,
    wait_for: Dict[str, Any],
    handoff: Dict[str, Any] | None = None,
) -> bool:
    """Persist an exact non-terminal wait without manufacturing a result.

    A waiting order remains the owner of its execution identity. A later
    resumption can claim that same order; it must not look like a failed or
    completed worker attempt just because a dependency is external.
    """
    allowed = {
        "waiting_for_input", "waiting_for_approval", "waiting_for_capability",
        "waiting_for_event", "waiting_for_dependency",
    }
    if status not in allowed:
        return False
    try:
        pool = await init_pool()
        async with pool.acquire() as conn:
            result = await conn.execute(
                """
                UPDATE hivemind.hyper_work_orders
                   SET status = $1, wait_for = $2::jsonb, handoff = $3::jsonb,
                       error = NULLIF($4, ''), updated_at = now()
                 WHERE id = $5::uuid AND org_id = $6::uuid
                   AND status IN ('queued', 'blocked', 'running', 'waiting_for_input',
                                  'waiting_for_approval', 'waiting_for_capability',
                                  'waiting_for_event', 'waiting_for_dependency')
                """,
                status, json.dumps(wait_for or {}, ensure_ascii=False),
                json.dumps(handoff or {}, ensure_ascii=False),
                str((wait_for or {}).get("reason") or "")[:1000], work_order_id, org_id,
            )
        return result.endswith("1")
    except Exception as exc:
        log.info("pause_hyper_work_order unavailable (non-fatal): %s", exc)
        return False


async def start_hyper_work_order(work_order_id: str, org_id: str) -> bool:
    """Claim a queued work order for its first attempt within its tenant."""
    try:
        pool = await init_pool()
        async with pool.acquire() as conn:
            result = await conn.execute(
                """
                UPDATE hivemind.hyper_work_orders
                SET status = 'running', attempt = attempt + 1, started_at = now(), updated_at = now(), error = NULL
                WHERE id = $1::uuid AND org_id = $2::uuid AND status IN ('queued', 'blocked')
                """,
                work_order_id, org_id,
            )
        return result.endswith("1")
    except Exception as exc:
        log.info("start_hyper_work_order unavailable (non-fatal): %s", exc)
        return False


async def get_hq_work_order(work_order_id: str, org_id: str) -> Optional[Dict[str, Any]]:
    """Load one HQ-owned work order and its assigned Company Room safely."""
    try:
        pool = await init_pool()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                SELECT wo.*, r.participant_ids, r.room_tag, r.goal AS room_goal,
                       COALESCE(r.agent_connectors->'_company', canonical.company) AS room_company,
                       rt.owner_user_id
                FROM hivemind.hyper_work_orders wo
                JOIN hivemind.hyper_rooms r
                  ON r.id = wo.room_id AND r.org_id = wo.org_id
                JOIN hivemind.hq_runtimes rt
                  ON rt.org_id = wo.org_id
                LEFT JOIN LATERAL (
                  SELECT cr.agent_connectors->'_company' AS company
                    FROM hivemind.hyper_rooms cr
                   WHERE cr.org_id = wo.org_id
                     AND cr.archived_at IS NULL
                     AND cr.agent_connectors ? '_company'
                   ORDER BY (cr.room_tag = 'general') DESC, cr.updated_at DESC
                   LIMIT 1
                ) canonical ON true
                WHERE wo.id = $1::uuid
                  AND wo.org_id = $2::uuid
                  AND wo.hq_cycle_id IS NOT NULL
                  AND r.archived_at IS NULL
                """,
                work_order_id, org_id,
            )
        if not row:
            return None
        item = dict(row)
        for key in ("id", "org_id", "room_id", "turn_id", "hq_cycle_id",
                    "growth_delegation_id", "owner_employee_id", "owner_user_id"):
            if item.get(key) is not None:
                item[key] = str(item[key])
        item["participant_ids"] = [str(value) for value in (item.get("participant_ids") or [])]
        if isinstance(item.get("room_company"), str):
            try:
                item["room_company"] = json.loads(item["room_company"])
            except Exception:
                item["room_company"] = {}
        return item
    except Exception as exc:
        log.info("get_hq_work_order unavailable: %s", exc)
        return None


async def resolve_hq_evidence(org_id: str, evidence_ids: list[str]) -> list[Dict[str, Any]]:
    """Resolve immutable artifact references into bounded worker evidence."""
    if not evidence_ids:
        return []
    try:
        pool = await init_pool()
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT id, source_platform, source_id, source_url, payload, metadata, created_at
                  FROM hivemind.source_artifacts
                 WHERE org_id = $1::uuid AND id = ANY($2::uuid[])
                 ORDER BY created_at DESC
                """,
                org_id, evidence_ids[:12],
            )
        result = []
        for row in rows:
            payload = row["payload"]
            metadata = row["metadata"]
            if isinstance(payload, str):
                try:
                    payload = json.loads(payload)
                except Exception:
                    payload = {}
            if isinstance(metadata, str):
                try:
                    metadata = json.loads(metadata)
                except Exception:
                    metadata = {}
            payload = payload if isinstance(payload, dict) else {}
            metadata = metadata if isinstance(metadata, dict) else {}
            # A full baseline can be large. Preserve the decision-bearing fields
            # while excluding raw post transcripts and provider response noise.
            if row["source_platform"] == "growth_baseline":
                social = payload.get("social_presence") if isinstance(payload.get("social_presence"), dict) else {}
                payload = {
                    "kind": payload.get("kind"), "as_of": payload.get("as_of"),
                    "status": payload.get("status"), "company": payload.get("company"),
                    "website": payload.get("website"), "market_signals": payload.get("market_signals"),
                    "data_gaps": payload.get("data_gaps"),
                    "social_presence": {
                        "totals": social.get("totals"), "accounts": social.get("accounts"),
                        "platform_reports": social.get("platform_reports"),
                    },
                }
            result.append({
                "id": str(row["id"]), "source_platform": row["source_platform"],
                "source_id": row["source_id"], "source_url": row["source_url"],
                "created_at": row["created_at"].isoformat(), "metadata": metadata,
                "payload": payload,
            })
        return result
    except Exception as exc:
        log.info("resolve_hq_evidence unavailable: %s", exc)
        return []


async def complete_hyper_work_order(
    *,
    work_order_id: str,
    org_id: str,
    status: str,
    summary: str,
    output: Dict[str, Any],
    evidence: list,
    artifacts: list,
    usage: Dict[str, Any],
    error: Optional[str] = None,
) -> bool:
    """Store one immutable worker result then close the matching tenant work order."""
    if status not in {"completed", "blocked", "failed"}:
        status = "failed"
    try:
        pool = await init_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                row = await conn.fetchrow(
                    """
                    SELECT work_order.attempt, work_order.runtime_epoch,
                           runtime.epoch AS current_runtime_epoch
                      FROM hivemind.hyper_work_orders AS work_order
                      LEFT JOIN hivemind.hq_runtimes AS runtime
                        ON runtime.org_id = work_order.org_id
                     WHERE work_order.id = $1::uuid AND work_order.org_id = $2::uuid
                     FOR UPDATE OF work_order
                    """,
                    work_order_id, org_id,
                )
                if not row:
                    return False
                runtime_epoch = row["runtime_epoch"]
                if runtime_epoch is not None and runtime_epoch != row["current_runtime_epoch"]:
                    log.info("discarding work result from obsolete Runtime epoch: %s", work_order_id)
                    return False
                attempt = max(1, int(row["attempt"] or 1))
                await conn.execute(
                    """
                    INSERT INTO hivemind.hyper_work_results
                      (work_order_id, runtime_epoch, attempt, status, summary, output, evidence, artifacts, usage)
                    VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb)
                    ON CONFLICT (work_order_id, attempt) DO NOTHING
                    """,
                    work_order_id, runtime_epoch, attempt, status, summary,
                    json.dumps(output or {}, ensure_ascii=False), json.dumps(evidence or [], ensure_ascii=False),
                    json.dumps(artifacts or [], ensure_ascii=False), json.dumps(usage or {}, ensure_ascii=False),
                )
                await conn.execute(
                    """
                    UPDATE hivemind.hyper_work_orders
                    SET status = $1, completed_at = now(), updated_at = now(), error = $2,
                        evidence_refs = $3::jsonb, artifact_refs = $4::jsonb
                    WHERE id = $5::uuid AND org_id = $6::uuid
                      AND (runtime_epoch IS NULL OR runtime_epoch = $7::uuid)
                    """,
                    status, error, json.dumps(evidence or [], ensure_ascii=False),
                    json.dumps(artifacts or [], ensure_ascii=False), work_order_id, org_id, runtime_epoch,
                )
        return True
    except Exception as exc:
        log.info("complete_hyper_work_order unavailable (non-fatal): %s", exc)
        return False


async def get_room_connector_grants(room_id: str, org_id: Optional[str] = None) -> Dict[str, list]:
    """P2 (HyperAgents×Connectors): return the room's per-character connector
    grants { employee_id: [connector,...] }. Empty dict if missing/pre-migration.
    org_id, when passed, scopes the read so a foreign room_id cannot leak grants."""
    import json as _json
    pool = await init_pool()
    async with pool.acquire() as conn:
        try:
            if org_id is not None:
                row = await conn.fetchrow(
                    "SELECT agent_connectors FROM hivemind.hyper_rooms WHERE id = $1 AND org_id = $2::uuid",
                    room_id, org_id,
                )
            else:
                row = await conn.fetchrow(
                    "SELECT agent_connectors FROM hivemind.hyper_rooms WHERE id = $1",
                    room_id,
                )
            if row and row["agent_connectors"]:
                raw = row["agent_connectors"]
                grants = _json.loads(raw) if isinstance(raw, str) else dict(raw)
                if isinstance(grants, dict):
                    # normalize: values must be lists of connector-name strings
                    return {
                        str(k): [str(c) for c in v if isinstance(c, str)]
                        for k, v in grants.items()
                        if isinstance(v, list)
                    }
        except Exception as exc:  # noqa: BLE001
            log.warning("get_room_connector_grants fallback: %s", exc)
    return {}


async def get_org_approval_rules(org_id: str) -> Dict[str, str]:
    """Fine-grained, per-action-type standing approval rules for this org
    (Grok-Bot-style "always allow: create a doc" while a different action
    still asks). {action_label: 'always_allow'|'always_deny'}. Empty dict if
    none/pre-migration — the existing per-turn write policy applies exactly
    as before with no rows."""
    pool = await init_pool()
    try:
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                'SELECT action_label, decision FROM hivemind.hyper_approval_rules WHERE org_id = $1::uuid',
                org_id,
            )
            return {str(r["action_label"]): str(r["decision"]) for r in rows}
    except Exception as exc:  # noqa: BLE001 — a failed read must fail OPEN to the ask/deny policy, not crash
        log.warning("get_org_approval_rules failed: %s", exc)
        return {}


async def get_room_enabled_connectors(room_id: str, org_id: Optional[str] = None) -> list:
    """Room-level connector toggles — the connectors enabled for this room
    (every agent may use them in the run). Empty list if none/pre-migration."""
    pool = await init_pool()
    async with pool.acquire() as conn:
        try:
            if org_id is not None:
                row = await conn.fetchrow(
                    "SELECT enabled_connectors FROM hivemind.hyper_rooms WHERE id = $1 AND org_id = $2::uuid",
                    room_id, org_id,
                )
            else:
                row = await conn.fetchrow(
                    "SELECT enabled_connectors FROM hivemind.hyper_rooms WHERE id = $1",
                    room_id,
                )
            if row and row["enabled_connectors"]:
                return [str(c) for c in row["enabled_connectors"] if isinstance(c, str)]
        except Exception as exc:  # noqa: BLE001
            log.warning("get_room_enabled_connectors fallback: %s", exc)
    return []


async def get_trust_scores(org_id: str, employee_ids: List[str]) -> Dict[str, float]:
    """A4: return {employee_id: trust_score} for given ids. Missing rows = 0.5."""
    if not employee_ids:
        return {}
    pool = await init_pool()
    out: Dict[str, float] = {eid: 0.5 for eid in employee_ids}
    try:
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT employee_id::text, trust_score
                FROM hivemind.agent_trust
                WHERE org_id = $1 AND employee_id = ANY($2::uuid[])
                """,
                org_id, employee_ids,
            )
            for r in rows:
                out[r["employee_id"]] = float(r["trust_score"])
    except Exception as exc:  # noqa: BLE001
        log.warning("get_trust_scores fallback: %s", exc)
    return out


async def update_trust(org_id: str, employee_id: str, delta: float, won: bool) -> Optional[float]:
    """A4: upsert + clamp [0,1]. Returns new score."""
    pool = await init_pool()
    try:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO hivemind.agent_trust (org_id, employee_id, trust_score, wins, losses, updated_at)
                VALUES ($1, $2, GREATEST(0.0, LEAST(1.0, 0.5 + $3)), $4, $5, now())
                ON CONFLICT (org_id, employee_id) DO UPDATE
                SET trust_score = GREATEST(0.0, LEAST(1.0, hivemind.agent_trust.trust_score + $3)),
                    wins = hivemind.agent_trust.wins + $4,
                    losses = hivemind.agent_trust.losses + $5,
                    updated_at = now()
                RETURNING trust_score
                """,
                org_id, employee_id, delta, 1 if won else 0, 0 if won else 1,
            )
            return float(row["trust_score"]) if row else None
    except Exception as exc:  # noqa: BLE001
        log.warning("update_trust failed org=%s emp=%s: %s", org_id, employee_id, exc)
        return None


async def get_slack_token(installer_user_id: str) -> Optional[str]:
    """Resolve the bot token for the employee owner's slack integration.
    Returns the encrypted_text — caller must decrypt via core helper OR
    we route via /api/employees/slack-action (preferred — no token here).
    """
    pool = await init_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT access_token_encrypted, sync_status, last_error_message
            FROM hivemind.platform_integrations
            WHERE platform_type = 'slack'
              AND user_id = $1
              AND is_active = true
            ORDER BY updated_at DESC
            LIMIT 1
            """,
            installer_user_id,
        )
    return dict(row) if row else None


async def bump_metrics(employee_id: str, tokens: int = 0, messages: int = 0, errors: int = 0) -> None:
    """Increment metrics_last_24h JSONB counters in-place."""
    pool = await init_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            """
            UPDATE hivemind.digital_employees
            SET metrics_last_24h = jsonb_set(
                  jsonb_set(
                    jsonb_set(
                      COALESCE(metrics_last_24h, '{}'::jsonb),
                      '{tokens}', to_jsonb(COALESCE((metrics_last_24h->>'tokens')::int, 0) + $2)
                    ),
                    '{messages}', to_jsonb(COALESCE((metrics_last_24h->>'messages')::int, 0) + $3)
                  ),
                  '{errors}', to_jsonb(COALESCE((metrics_last_24h->>'errors')::int, 0) + $4)
                ),
                last_active_at = NOW()
            WHERE id = $1
            """,
            employee_id, tokens, messages, errors,
        )


async def set_status(employee_id: str, status: str) -> None:
    pool = await init_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE hivemind.digital_employees SET status=$2, updated_at=NOW() WHERE id=$1",
            employee_id, status,
        )


async def get_company_name(org_id: str) -> str:
    """Canonical onboarded company name for the org (from the newest active
    HQ room's persisted _company payload). '' when the org has no onboarded
    company — callers treat that as missing company context."""
    if not org_id:
        return ""
    pool = await init_pool()
    async with pool.acquire() as conn:
        try:
            row = await conn.fetchrow(
                "SELECT agent_connectors->'_company'->>'company' AS name "
                "FROM hivemind.hyper_rooms "
                "WHERE org_id = $1::uuid AND agent_connectors ? '_company' AND archived_at IS NULL "
                "ORDER BY created_at DESC LIMIT 1",
                org_id,
            )
            if row and row["name"]:
                return str(row["name"]).strip()
        except Exception as exc:  # noqa: BLE001
            log.warning("get_company_name fallback: %s", exc)
    return ""


async def get_connected_gmail(user_id: str, org_id: Optional[str] = None) -> str:
    """The Gmail address the user connected (platform_integrations.platform_user_id) —
    the real sender for outreach. '' when none connected."""
    if not user_id:
        return ""
    pool = await init_pool()
    async with pool.acquire() as conn:
        try:
            row = await conn.fetchrow(
                "SELECT platform_user_id FROM hivemind.platform_integrations "
                "WHERE user_id = $1::uuid AND platform_type = 'gmail' "
                "AND platform_user_id IS NOT NULL ORDER BY updated_at DESC NULLS LAST LIMIT 1",
                user_id,
            )
            if row and row["platform_user_id"] and "@" in str(row["platform_user_id"]):
                return str(row["platform_user_id"]).strip()
        except Exception as exc:  # noqa: BLE001
            log.warning("get_connected_gmail failed: %s", exc)
    return ""


async def has_connected_gmail(user_id: str, org_id: Optional[str] = None) -> bool:
    """Return whether Gmail is available to this user in the active organization.

    Gmail may be represented by the legacy platform integration or by the current
    tenant-scoped Nango connection. Keep the address lookup separate: a valid Nango
    connection is usable even when its metadata does not expose the mailbox address.
    """
    if not user_id:
        return False
    pool = await init_pool()
    async with pool.acquire() as conn:
        try:
            legacy = await conn.fetchval(
                "SELECT EXISTS (SELECT 1 FROM hivemind.platform_integrations "
                "WHERE user_id = $1::uuid AND platform_type = 'gmail' AND is_active IS NOT FALSE)",
                user_id,
            )
            if legacy:
                return True
            if not org_id:
                return False
            return bool(await conn.fetchval(
                "SELECT EXISTS (SELECT 1 FROM hivemind.nango_connections "
                "WHERE user_id = $1::uuid AND org_id = $2::uuid "
                "AND provider_key IN ('gmail', 'google-mail') AND status = 'active')",
                user_id, org_id,
            ))
        except Exception as exc:  # noqa: BLE001
            log.warning("has_connected_gmail failed: %s", exc)
    return False
