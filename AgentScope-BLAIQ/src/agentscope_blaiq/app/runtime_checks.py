from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from redis.asyncio import Redis
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import create_async_engine

from agentscope_blaiq.runtime.config import settings

from .model_resolver import current_litellm_config, resolve_route


@dataclass
class CheckReport:
    ok: bool
    details: dict[str, Any] = field(default_factory=dict)
    issues: list[str] = field(default_factory=list)


def check_storage_paths(upload_dir: Path, artifact_dir: Path, log_dir: Path) -> CheckReport:
    issues: list[str] = []
    details: dict[str, Any] = {}
    for name, path in {"upload_dir": upload_dir, "artifact_dir": artifact_dir, "log_dir": log_dir}.items():
        path.mkdir(parents=True, exist_ok=True)
        writable = path.exists() and path.is_dir() and os_access_writable(path)
        details[name] = {"path": str(path), "writable": writable}
        if not writable:
            issues.append(f"{name}_not_writable")
    return CheckReport(ok=not issues, details=details, issues=issues)


def os_access_writable(path: Path) -> bool:
    try:
        probe = path / ".write_probe"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink(missing_ok=True)
        return True
    except Exception:
        return False


async def check_database(database_url: str) -> CheckReport:
    issues: list[str] = []
    details: dict[str, Any] = {"database_url": database_url}
    url = make_url(database_url)
    backend = url.get_backend_name()
    details["backend"] = backend
    try:
        if backend == "sqlite":
            if url.database not in (None, "", ":memory:"):
                db_path = Path(url.database)
                details["file_exists"] = db_path.exists()
                if not db_path.exists():
                    issues.append("database_file_missing")
        else:
            engine = create_async_engine(database_url, future=True, echo=False)
            try:
                async with engine.connect() as conn:
                    await conn.execute(text("SELECT 1"))
            finally:
                await engine.dispose()
    except Exception as exc:  # pragma: no cover
        issues.append("database_unreachable")
        details["error"] = str(exc)
    return CheckReport(ok=not issues, details=details, issues=issues)


async def check_redis(redis_url: str) -> CheckReport:
    issues: list[str] = []
    details: dict[str, Any] = {"redis_url": redis_url}
    client = Redis.from_url(redis_url, decode_responses=True)
    try:
        details["ping"] = await client.ping()
    except Exception as exc:  # pragma: no cover
        issues.append("redis_unreachable")
        details["error"] = str(exc)
    finally:
        await client.aclose()
    return CheckReport(ok=not issues, details=details, issues=issues)


def check_model_env() -> CheckReport:
    config = current_litellm_config()
    required_routes = {
        "strategic": config.strategic_model,
        "research": config.research_model,
        "vangogh": config.vangogh_model,
        "governance": config.governance_model,
    }
    route_details = {
        name: {
            "route": route.raw,
            "provider": route.provider,
            "model": route.model,
            "provider_prefixed": "/" in route.raw,
        }
        for name, route in ((k, resolve_route(v)) for k, v in required_routes.items())
    }
    return CheckReport(
        ok=True,
        details={
            "models": route_details,
            "api_base_url": config.api_base_url,
            "api_key_present": bool(settings.litellm_api_key or settings.openai_api_key),
            "planner_model": config.planner_model,
            "pre_model": config.pre_model,
            "post_model": config.post_model,
            "reformat_model": config.reformat_model,
            "fallback_model": config.fallback_model,
            "timeout_seconds": config.timeout_seconds,
            "max_output_tokens": config.max_output_tokens,
            "runtime": {
                "app_env": settings.app_env,
                "app_host": settings.app_host,
                "app_port": settings.app_port,
                "default_tenant": settings.default_tenant,
                "default_source_scope": settings.default_source_scope,
                "default_artifact_type": settings.default_artifact_type,
                "reasoning_effort": settings.model_reasoning_effort,
            },
        },
        issues=[],
    )


async def check_runtime_ready() -> CheckReport:
    storage = check_storage_paths(settings.upload_dir, settings.artifact_dir, settings.log_dir)
    database = await check_database(settings.database_url)
    redis = await check_redis(settings.redis_url)
    model_env = check_model_env()
    issues = [*storage.issues, *database.issues, *redis.issues]
    return CheckReport(
        ok=not issues,
        details={
            "storage": storage.details,
            "database": database.details,
            "redis": redis.details,
            "models": model_env.details,
            "runtime": {
                "app_env": settings.app_env,
                "app_host": settings.app_host,
                "app_port": settings.app_port,
                "default_tenant": settings.default_tenant,
            },
        },
        issues=issues,
    )
