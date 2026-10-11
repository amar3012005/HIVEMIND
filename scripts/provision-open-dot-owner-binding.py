#!/usr/bin/env python3
"""Resolve the one approved Open Dot owner binding from Core's existing database.

This runs only from the immutable canonical release worktree in local-prototype
mode. It uses a disposable container from the live Core image, queries one exact
verified account and its SINGULANCE owner membership, and writes only the two
non-secret IDs plus the fixed public URL to the managed environment file.
"""

from __future__ import annotations

import fcntl
import os
import re
import stat
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote


EMAIL = "amarsai2005@gmail.com"
ORGANIZATION_NAME = "SINGULANCE"
PUBLIC_URL = "https://dots.singulancelabs.com"
OUTPUT_KEYS = ("OPEN_DOT_ORGANIZATION_ID", "OPEN_DOT_USER_ID", "OPEN_DOT_PUBLIC_URL")
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I)

QUERY = r"""
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  try {
    const rows = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      return tx.$queryRaw`
        SELECT u.id AS user_id, o.id AS organization_id
        FROM hivemind.users AS u
        JOIN hivemind.user_organizations AS uo ON uo.user_id = u.id
        JOIN hivemind.organizations AS o ON o.id = uo.org_id
        WHERE u.email = ${'amarsai2005@gmail.com'}
          AND u.deleted_at IS NULL
          AND uo.is_active = TRUE
          AND uo.deactivated_at IS NULL
          AND UPPER(o.name) = ${'SINGULANCE'}
          AND (uo.role = 'owner' OR 'org_owner' = ANY(uo.roles) OR 'owner' = ANY(uo.roles))
      `;
    }, { timeout: 10000 });
    if (rows.length !== 1) process.exitCode = 4;
    else process.stdout.write(JSON.stringify(rows.map(({ user_id, organization_id }) => ({ user_id, organization_id }))));
  } catch {
    process.exitCode = 5;
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
})();
"""


def fail(message: str) -> "NoReturn":
    print(f"FATAL: {message}", file=sys.stderr)
    raise SystemExit(1)


def env_values(path: Path) -> tuple[bytes, dict[str, tuple[int, int, str]]]:
    content = path.read_bytes()
    found: dict[str, tuple[int, int, str]] = {}
    offset = 0
    for line in content.splitlines(keepends=True):
        body = line.rstrip(b"\r\n")
        if not body or body.lstrip().startswith(b"#") or b"=" not in body:
            offset += len(line)
            continue
        key_bytes, raw = body.split(b"=", 1)
        try:
            key = key_bytes.decode("ascii")
            value = raw.decode("utf-8").strip()
        except UnicodeDecodeError:
            offset += len(line)
            continue
        if key in OUTPUT_KEYS or key in {"POSTGRES_USER", "POSTGRES_DB", "POSTGRES_PASSWORD"}:
            if key in found:
                fail(f"managed environment has duplicate {key} entries")
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            found[key] = (offset, offset + len(body), value)
        offset += len(line)
    return content, found


def inspect_text(*args: str) -> str:
    try:
        result = subprocess.run(["docker", "inspect", *args], check=True, text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        return result.stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        fail("cannot inspect the live Core container for its immutable image and database network")


def matching_networks(core_networks: list[str], postgres_alias_networks: list[str]) -> list[str]:
    return sorted(set(core_networks) & set(postgres_alias_networks))


def resolve_binding(values: dict[str, tuple[int, int, str]]) -> tuple[str, str]:
    if not values.get("POSTGRES_PASSWORD", (0, 0, ""))[2]:
        fail("managed environment is missing non-empty POSTGRES_PASSWORD")
    image_id = inspect_text("--format", "{{.Image}}", "hm-core")
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", image_id):
        fail("live Core container does not expose an immutable image ID")
    core_networks = set(inspect_text(
        "--format", "{{range $name, $net := .NetworkSettings.Networks}}{{println $name}}{{end}}", "hm-core"
    ).splitlines())
    postgres_alias_networks = set(inspect_text(
        "--format",
        '{{range $name, $net := .NetworkSettings.Networks}}{{range $alias := $net.Aliases}}{{if eq $alias "postgres"}}{{println $name}}{{end}}{{end}}{{end}}',
        "hm-postgres",
    ).splitlines())
    network_names = matching_networks(list(core_networks), list(postgres_alias_networks))
    if len(network_names) != 1:
        fail("cannot identify exactly one network shared by Core and managed hm-postgres")

    pg_user = values.get("POSTGRES_USER", (0, 0, "hivemind_user"))[2] or "hivemind_user"
    pg_db = values.get("POSTGRES_DB", (0, 0, "hivemind"))[2] or "hivemind"
    pg_password = values["POSTGRES_PASSWORD"][2]
    database_url = (
        f"postgresql://{quote(pg_user, safe='')}:{quote(pg_password, safe='')}@postgres:5432/"
        f"{quote(pg_db, safe='')}?schema=hivemind&connection_limit=2&pool_timeout=5"
    )
    fd, env_temp = tempfile.mkstemp(prefix="opendot-db-", dir="/tmp")
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(f"DATABASE_URL={database_url}\n")
        command = [
            "docker", "run", "--rm", "--read-only", "--cap-drop=ALL",
            "--security-opt=no-new-privileges:true", "--network", network_names[0],
            "--env-file", env_temp, "--entrypoint", "node", image_id,
            "-e", QUERY,
        ]
        try:
            result = subprocess.run(command, check=True, text=True,
                                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                    timeout=45)
        except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
            fail("read-only Core identity lookup failed; no binding values were changed")
    finally:
        try:
            os.unlink(env_temp)
        except FileNotFoundError:
            pass
    try:
        rows = __import__("json").loads(result.stdout)
    except (ValueError, TypeError):
        fail("read-only Core identity lookup returned an invalid result")
    if not isinstance(rows, list) or len(rows) != 1:
        fail("expected exactly one active, undeleted SINGULANCE owner membership for the approved account")
    user_id = rows[0].get("user_id")
    organization_id = rows[0].get("organization_id")
    if not isinstance(user_id, str) or not UUID.fullmatch(user_id):
        fail("Core returned an invalid owner user identifier")
    if not isinstance(organization_id, str) or not UUID.fullmatch(organization_id):
        fail("Core returned an invalid organization identifier")
    return organization_id, user_id


def write_binding(path: Path, original: bytes, values: dict[str, tuple[int, int, str]],
                  organization_id: str, user_id: str) -> None:
    desired = {
        "OPEN_DOT_ORGANIZATION_ID": organization_id,
        "OPEN_DOT_USER_ID": user_id,
        "OPEN_DOT_PUBLIC_URL": PUBLIC_URL,
    }
    for key, expected in desired.items():
        current = values.get(key)
        if current and current[2] and current[2] != expected:
            fail(f"managed environment already has a conflicting {key}; refusing to overwrite it")
    to_append = {key: val for key, val in desired.items() if key not in values}
    to_replace = {key: val for key, val in desired.items()
                  if key in values and not values[key][2]}
    if not to_append and not to_replace:
        print("Open Dot owner binding already matches the verified account; managed environment unchanged")
        return

    chunks: list[bytes] = []
    cursor = 0
    for key, (start, end, _) in sorted(values.items(), key=lambda item: item[1][0]):
        if key not in to_replace:
            continue
        chunks.append(original[cursor:start])
        line_end = original.find(b"\n", start)
        terminator = b"\n" if line_end >= 0 else b""
        if line_end >= 0 and line_end > start and original[line_end - 1:line_end] == b"\r":
            terminator = b"\r\n"
        chunks.append(f"{key}={to_replace[key]}".encode("utf-8") + terminator)
        cursor = line_end + 1 if line_end >= 0 else len(original)
    chunks.append(original[cursor:])
    updated = b"".join(chunks)
    if to_append:
        if updated and not updated.endswith((b"\n", b"\r")):
            updated += b"\n"
        updated += b"".join(f"{key}={value}\n".encode("utf-8") for key, value in to_append.items())
    info = path.stat()
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = path.with_name(f"{path.name}.open-dot-binding.{timestamp}.bak")
    backup_fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        current_content = path.read_bytes()
        if current_content != original:
            os.close(backup_fd)
            backup.unlink()
            fail("managed environment changed before the private backup could be created")
        with os.fdopen(backup_fd, "wb") as handle:
            handle.write(current_content)
            handle.flush()
            os.fsync(handle.fileno())
    except Exception:
        try:
            backup.unlink()
        except OSError:
            pass
        raise
    os.chmod(backup, 0o600)

    temp_fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(temp_fd, stat.S_IMODE(info.st_mode) & 0o600 or 0o600)
        if hasattr(os, "fchown"):
            os.fchown(temp_fd, info.st_uid, info.st_gid)
        with os.fdopen(temp_fd, "wb") as handle:
            handle.write(updated)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, path)
        dir_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
    except Exception:
        try:
            os.unlink(temp_name)
        except OSError:
            pass
        raise
    print("Provisioned the verified Open Dot owner binding in the managed environment")


def main() -> None:
    if len(sys.argv) != 3 or sys.argv[1] != "--env-file":
        fail("usage: provision-open-dot-owner-binding.py --env-file /path/to/managed.env")
    env_path = Path(sys.argv[2])
    if not env_path.is_absolute() or not env_path.is_file():
        fail("managed environment file is unavailable")
    lock_path = env_path.with_name(env_path.name + ".open-dot-binding.lock")
    try:
        lock_fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
    except OSError:
        fail("cannot acquire the managed environment lock")
    try:
        os.fchmod(lock_fd, 0o600)
        fcntl.flock(lock_fd, fcntl.LOCK_EX)
        original, values = env_values(env_path)
        org_id, user_id = resolve_binding(values)
        # Re-read under the lock immediately before replacement.
        latest, latest_values = env_values(env_path)
        if latest != original:
            fail("managed environment changed during owner resolution; rerun after review")
        write_binding(env_path, latest, latest_values, org_id, user_id)
    finally:
        os.close(lock_fd)


if __name__ == "__main__":
    main()
