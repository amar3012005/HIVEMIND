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
