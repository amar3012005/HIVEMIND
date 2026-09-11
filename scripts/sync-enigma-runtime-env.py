#!/usr/bin/env python3
"""Merge approved shared runtime configuration into an Enigma env file.

Read KEY=VALUE entries from stdin.  This intentionally never selects data-plane,
session, OAuth, or public-URL keys; those remain environment-owned.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path


ENVIRONMENT_OVERRIDES = {
    "HIVEMIND_ALLOWED_ORIGINS": "https://dev.next.singulancelabs.com,https://api.dev.next.singulancelabs.com,https://core.dev.next.singulancelabs.com",
    "CORS_ALLOW_ORIGINS": "https://dev.next.singulancelabs.com,https://api.dev.next.singulancelabs.com,https://core.dev.next.singulancelabs.com",
    "HIVEMIND_FRONTEND_URL": "https://dev.next.singulancelabs.com",
    "HIVEMIND_CORE_API_PUBLIC_URL": "https://core.dev.next.singulancelabs.com",
    "HIVEMIND_CONTROL_PLANE_PUBLIC_URL": "https://api.dev.next.singulancelabs.com",
    "GOOGLE_REDIRECT_URI": "https://api.dev.next.singulancelabs.com/auth/google/callback",
    "HIVEMIND_GOOGLE_REDIRECT_URI": "https://api.dev.next.singulancelabs.com/auth/google/callback",
}


def parse_env(lines: list[str]) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in lines:
        line = line.rstrip("\n")
        if "=" in line and not line.startswith("#"):
            key, value = line.split("=", 1)
            values[key] = value
    return values


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", required=True, type=Path)
    args = parser.parse_args()
    target = args.target
    values = parse_env(target.read_text().splitlines(keepends=True))
    values.update(parse_env(list(__import__("sys").stdin)))
    values.update(ENVIRONMENT_OVERRIDES)
    next_path = target.with_suffix(target.suffix + ".next")
    next_path.write_text("".join(f"{key}={value}\n" for key, value in sorted(values.items())))
    os.chmod(next_path, 0o600)
    os.replace(next_path, target)
    print(f"updated_keys={len(values)}")


if __name__ == "__main__":
    main()
