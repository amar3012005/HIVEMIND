from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
from typing import Any

from agentscope_blaiq.persistence.database import Base, get_engine
from agentscope_blaiq.runtime.config import settings


def ensure_runtime_paths() -> dict[str, dict[str, Any]]:
    details: dict[str, dict[str, Any]] = {}
    for label, path in {
        "upload_dir": settings.upload_dir,
        "artifact_dir": settings.artifact_dir,
        "log_dir": settings.log_dir,
    }.items():
        path.mkdir(parents=True, exist_ok=True)
        details[label] = {"path": str(path), "exists": path.exists(), "writable": _is_writable(path)}
    return details


def _is_writable(path: Path) -> bool:
    try:
        probe = path / ".bootstrap_probe"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink(missing_ok=True)
        return True
    except Exception:
        return False


async def bootstrap_database() -> dict[str, Any]:
    engine = get_engine()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return {"database_url": settings.database_url, "status": "bootstrapped"}


async def bootstrap() -> dict[str, Any]:
    return {
        "paths": ensure_runtime_paths(),
        "database": await bootstrap_database(),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Bootstrap the AgentScope-BLAIQ deployment runtime.")
    parser.add_argument(
        "--check",
        action="store_true",
        help="Validate the runtime paths and database bootstrap path without starting the API server.",
    )
    parser.add_argument(
        "--migrate",
        action="store_true",
        help="Run the database bootstrap/migration step.",
    )
    args = parser.parse_args()

    if args.check and not args.migrate:
        print(json.dumps({"paths": ensure_runtime_paths(), "database": {"status": "skipped"}}))
        return 0

    result = asyncio.run(bootstrap())
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
