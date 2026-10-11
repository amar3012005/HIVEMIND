#!/usr/bin/env python3
"""Versioned, scoped installation into the existing managed Caddy instance.

Uses Caddy's native adapter and conditional config API. Refuses live/file drift;
keeps a private rollback copy and never prints configuration contents.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import urllib.request

SITE = "dots.singulancelabs.com"
BLOCK = "\n# BEGIN SINGULANCE OPEN DOT\ndots.singulancelabs.com {\n\treverse_proxy localhost:3177\n}\n# END SINGULANCE OPEN DOT\n"


def request(path, body=None, headers=None):
    req = urllib.request.Request("http://127.0.0.1:2019" + path, data=body, headers=headers or {})
    with urllib.request.urlopen(req, timeout=15) as response:
        raw = response.read()
        return (json.loads(raw) if raw else None), response.headers.get("Etag")


def adapt(text):
    result, _ = request("/adapt", text.encode(), {"Content-Type": "text/caddyfile"})
    return result["result"]


def install(config, state):
    # Lock the same inode that Caddy's bind mount reads; do not rename it.
    with config.open("r+") as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        original = stream.read()
        live, etag = request("/config/")
        baseline = adapt(original)
        if baseline != live or not etag:
            raise RuntimeError("Caddy live/file drift or missing concurrency fence; no changes made")
        if SITE in original:
            if BLOCK.strip() not in original:
                raise RuntimeError("Existing Open Dot route is not owned by this helper")
            print("Open Dot ingress already installed; live configuration matches file")
            return
        candidate = original + BLOCK
        desired = adapt(candidate)
        state.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(state, 0o700)
        backup = state / "Caddyfile.before-open-dot"
        # First-install evidence must not be overwritten on retry.
        fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as saved:
            saved.write(original)
            saved.flush()
            os.fsync(saved.fileno())
        try:
            request("/config/", json.dumps(desired).encode(), {"Content-Type": "application/json", "If-Match": etag})
            stream.seek(0)
            stream.write(candidate)
            stream.truncate()
            stream.flush()
            os.fsync(stream.fileno())
        except Exception as failure:
            recovery_failed = False
            # A lost HTTP response can follow a committed config mutation.
            # Reconcile it, but never replace another operator's new config.
            try:
                current, current_etag = request("/config/")
                if current == desired and current_etag:
                    request("/config/", json.dumps(live).encode(), {"Content-Type": "application/json", "If-Match": current_etag})
                elif current != live:
                    recovery_failed = True
            except Exception:
                recovery_failed = True
            # Attempt file recovery even if API recovery failed.
            try:
                stream.seek(0)
                stream.write(original)
                stream.truncate()
                stream.flush()
                os.fsync(stream.fileno())
            except Exception:
                recovery_failed = True
            if recovery_failed:
                raise RuntimeError("Ingress installation failed; recovery requires reconciliation against the private backup") from failure
            raise RuntimeError("Ingress installation failed; original config restored") from failure
        print("Open Dot ingress installed through native Caddy API; private rollback saved")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--state-dir", required=True, type=Path)
    args = parser.parse_args()
    install(Path("/root/hivemind/infra/Caddyfile"), args.state_dir)
