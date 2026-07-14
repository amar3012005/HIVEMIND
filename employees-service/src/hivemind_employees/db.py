"""Async Postgres connection pool — reads DigitalEmployee + ApiKey
rows that the Node side writes. Read-only on hot path (employee
lifecycle stays in control-plane), but writes happen for metric bumps.
"""
from __future__ import annotations

import asyncpg
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
    """Self-evolving employees toggle ('on' = reflect+inject per-employee playbooks,
    else 'off'). Defaults to 'off' (graceful pre-migration: a missing column means the
    additional feature is dormant and the turn runs untouched). org_id scopes the read."""
    pool = await init_pool()
    async with pool.acquire() as conn:
        try:
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
    return "off"


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
