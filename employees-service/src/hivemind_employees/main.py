"""FastAPI entrypoint for the Digital Employees sidecar.

Boots the SlackGateway, holds Slack Bolt connections per workspace,
runs the reconcile loop, exposes /health and /admin/* admin endpoints.
"""
from __future__ import annotations

import asyncio
import logging
import sys
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Header

from .config import get_settings
from .db import init_pool, close_pool, list_running_employees
from .redis_client import init_redis, close_redis
from .hivemind_client import ServiceClient


def _configure_logging():
    settings = get_settings()
    level = getattr(logging, settings.log_level.upper(), logging.INFO)
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
        stream=sys.stdout,
    )


log = logging.getLogger("hivemind_employees")


# ── Service-wide state ─────────────────────────────────────────
class State:
    """Module-level singletons. Phase 2.3 will replace placeholders
    with real SlackGateway + WorkflowAgent pool."""
    employee_count: int = 0
    workspace_count: int = 0
    reconcile_task: asyncio.Task | None = None
    last_reconcile_at: str | None = None
    ready: bool = False


state = State()


async def _reconcile_once():
    """Pull active employees from DB. Phase 2.4 will diff against
    in-memory gateway state to add/remove agents."""
    try:
        rows = await list_running_employees()
        state.employee_count = len(rows)
        state.workspace_count = len({r["slack_team_id"] for r in rows if r["slack_team_id"]})
        from datetime import datetime, timezone
        state.last_reconcile_at = datetime.now(timezone.utc).isoformat()
        log.info(
            "reconcile: %d employees, %d workspaces",
            state.employee_count, state.workspace_count,
        )
    except Exception as e:
        log.warning("reconcile failed: %s", e)


async def _reconcile_loop():
    settings = get_settings()
    while True:
        await _reconcile_once()
        await asyncio.sleep(settings.reconcile_interval_s)


@asynccontextmanager
async def lifespan(app: FastAPI):
    _configure_logging()
    settings = get_settings()
    log.info(
        "hivemind-employees starting (replica=%s/%s, port=%s)",
        settings.replica_id, settings.replica_count, settings.port,
    )
    # Bring up shared infra
    await init_pool()
    await init_redis()
    # Initial reconcile (non-blocking)
    asyncio.create_task(_reconcile_once())
    # Start background loop
    state.reconcile_task = asyncio.create_task(_reconcile_loop())
    state.ready = True
    log.info("hivemind-employees ready")

    try:
        yield
    finally:
        log.info("hivemind-employees shutting down")
        state.ready = False
        if state.reconcile_task:
            state.reconcile_task.cancel()
            try:
                await state.reconcile_task
            except asyncio.CancelledError:
                pass
        await close_redis()
        await close_pool()
        log.info("hivemind-employees stopped")


app = FastAPI(
    title="HIVEMIND Digital Employees",
    version="0.1.0",
    description="Python sidecar — SlackAgents + AgentScope wrapper",
    lifespan=lifespan,
)


# ── Routes ─────────────────────────────────────────────────────
@app.get("/health")
async def health():
    """Lightweight health probe — Coolify + deploy.sh employees hit this."""
    if not state.ready:
        raise HTTPException(503, "starting up")
    return {
        "ok": True,
        "version": "0.1.0",
        "replica_id": get_settings().replica_id,
        "replica_count": get_settings().replica_count,
        "employees": state.employee_count,
        "workspaces": state.workspace_count,
        "last_reconcile_at": state.last_reconcile_at,
    }


@app.get("/health/deep")
async def health_deep():
    """Check downstream connectivity — Postgres + Redis + HIVEMIND core."""
    out = {"db": "?", "redis": "?", "core": "?"}
    try:
        pool = await init_pool()
        async with pool.acquire() as conn:
            await conn.fetchval("SELECT 1")
        out["db"] = "ok"
    except Exception as e:
        out["db"] = f"err: {e}"
    try:
        r = await init_redis()
        await r.ping()
        out["redis"] = "ok"
    except Exception as e:
        out["redis"] = f"err: {e}"
    try:
        svc = ServiceClient()
        h = await svc.core_health()
        await svc.aclose()
        out["core"] = "ok" if h.get("ok") else f"status: {h.get('status')}"
    except Exception as e:
        out["core"] = f"err: {e}"
    return out


@app.post("/admin/reload")
async def admin_reload(x_admin_token: str = Header(None, alias="X-Admin-Token")):
    """Called by hm-control-plane after employee CRUD to trigger
    immediate reconcile instead of waiting 30s."""
    settings = get_settings()
    expected = settings.hivemind_master_api_key
    if expected and x_admin_token != expected:
        raise HTTPException(401, "Invalid admin token")
    await _reconcile_once()
    return {"reloaded": True, "employees": state.employee_count, "workspaces": state.workspace_count}


# ── Entrypoint ─────────────────────────────────────────────────
def cli():
    """python -m hivemind_employees.main runs this."""
    import uvicorn
    settings = get_settings()
    uvicorn.run(
        "hivemind_employees.main:app",
        host="0.0.0.0",
        port=settings.port,
        log_level=settings.log_level,
        reload=False,
        access_log=False,
    )


if __name__ == "__main__":
    cli()
