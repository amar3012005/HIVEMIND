#!/usr/bin/env python3
"""Install only Open Dot's route in the existing managed Caddy instance.

The Caddyfile remains the durable source. The live API update is scoped to one
server's route array, protected by its ETag, so unrelated live routes are never
replaced from a separately adapted full config.
"""
import argparse
import copy
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import urllib.parse
import urllib.request

SITE = "dots.singulancelabs.com"
UPSTREAM = "localhost:3177"
CADDY_CONTAINER = "hm-caddy"
CADDYFILE_DEST = "/etc/caddy/Caddyfile"
BLOCK_START = "# BEGIN SINGULANCE OPEN DOT"
BLOCK_END = "# END SINGULANCE OPEN DOT"
BLOCK = (
    f"\n{BLOCK_START}\n{SITE} {{\n\treverse_proxy {UPSTREAM}\n}}\n"
    f"{BLOCK_END}\n"
)


def request(path, body=None, headers=None, method=None):
    req = urllib.request.Request(
        "http://127.0.0.1:2019" + path,
        data=body,
        headers=headers or {},
        method=method,
    )
    with urllib.request.urlopen(req, timeout=15) as response:
        raw = response.read()
        return (json.loads(raw) if raw else None), response.headers.get("Etag")


def adapt(text):
    result, _ = request("/adapt", text, {"Content-Type": "text/caddyfile"})
    return result["result"]


def verify_caddyfile_mount(config):
    """Return only after the host file is the Caddyfile Caddy actually reads."""
    template = (
        '{{range .Mounts}}{{if eq .Destination "'
        + CADDYFILE_DEST
        + '"}}{{.Source}}{{end}}{{end}}'
    )
    result = subprocess.run(
        ["docker", "inspect", "--format", template, CADDY_CONTAINER],
        check=True,
        capture_output=True,
        text=True,
        timeout=15,
    )
    mounted_source = result.stdout.strip()
    if not mounted_source:
        raise RuntimeError("Managed Caddyfile bind mount is missing; no changes made")
    try:
        if Path(mounted_source).resolve(strict=True) != Path(config).resolve(strict=True):
            raise RuntimeError("Managed Caddyfile bind mount does not match the target file; no changes made")
    except OSError as exc:
        raise RuntimeError("Managed Caddyfile bind mount cannot be verified; no changes made") from exc


def normalize_verified_file_aliases(adapted, live):
    """Normalize only Caddy's implicit hidden-file path across the verified bind mount."""
    normalized = copy.deepcopy(adapted)
    aliases = 0

    def walk(source, active):
        nonlocal aliases
        if isinstance(source, dict) and isinstance(active, dict):
            for key, value in source.items():
                if key not in active:
                    continue
                other = active[key]
                if key == "hide" and isinstance(value, list) and isinstance(other, list) and len(value) == len(other):
                    for index, item in enumerate(value):
                        if item == "./Caddyfile" and other[index] == CADDYFILE_DEST:
                            value[index] = CADDYFILE_DEST
                            aliases += 1
                        else:
                            walk(item, other[index])
                else:
                    walk(value, other)
        elif isinstance(source, list) and isinstance(active, list):
            for item, other in zip(source, active):
                walk(item, other)

    walk(normalized, live)
    return normalized, aliases


def _host_values(route):
    values = []
    for matcher in route.get("match", []) if isinstance(route, dict) else []:
        if isinstance(matcher, dict) and isinstance(matcher.get("host"), list):
            values.extend(value for value in matcher["host"] if isinstance(value, str))
    return values


def _proxy_dials(route):
    dials = []

    def walk(value):
        if isinstance(value, dict):
            if value.get("handler") == "reverse_proxy":
                for upstream in value.get("upstreams", []):
                    if isinstance(upstream, dict) and isinstance(upstream.get("dial"), str):
                        dials.append(upstream["dial"])
            for child in value.values():
                walk(child)
        elif isinstance(value, list):
            for child in value:
                walk(child)

    walk(route)
    return dials


def _find_site_routes(config):
    found = []
    servers = config.get("apps", {}).get("http", {}).get("servers", {})
    for server_name, server in servers.items():
        for index, route in enumerate(server.get("routes", [])):
            if SITE in _host_values(route):
                found.append((server_name, index, route))
    return found


def _route_can_match_site(route):
    matchers = route.get("match") if isinstance(route, dict) else None
    if not matchers:
        return True
    for matcher in matchers:
        if not isinstance(matcher, dict):
            return True
        hosts = matcher.get("host")
        if hosts is None:
            # Match arrays are ORed; a hostless matcher can also catch Open Dot.
            return True
        for host in hosts:
            if host == SITE or host == "*":
                return True
            if isinstance(host, str) and host.startswith("*.") and SITE.endswith(host[1:]):
                return True
    return False


def _all_routes(config):
    servers = config.get("apps", {}).get("http", {}).get("servers", {})
    for server_name, server in servers.items():
        for index, route in enumerate(server.get("routes", [])):
            yield server_name, index, route


def _extract_owned_route(config):
    found = _find_site_routes(config)
    if len(found) != 1:
        raise RuntimeError("Caddyfile must adapt to exactly one Open Dot route")
    server_name, _, route = found[0]
    if _host_values(route) != [SITE] or _proxy_dials(route) != [UPSTREAM]:
        raise RuntimeError("Caddyfile Open Dot route does not match the owned host and upstream")
    return server_name, route


def _without_route(config, server_name, route):
    result = copy.deepcopy(config)
    routes = result["apps"]["http"]["servers"][server_name]["routes"]
    matches = [index for index, item in enumerate(routes) if item == route]
    if len(matches) != 1:
        raise RuntimeError("Could not uniquely identify the owned Open Dot route")
    routes.pop(matches[0])
    return result


def _write_private(path, contents):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as saved:
        saved.write(contents)
        saved.flush()
        os.fsync(saved.fileno())


def _write_stream(stream, contents):
    stream.seek(0)
    stream.write(contents)
    stream.truncate()
    stream.flush()
    os.fsync(stream.fileno())


def _route_path(server_name):
    server = urllib.parse.quote(server_name, safe="")
    return f"/config/apps/http/servers/{server}/routes"


def _same_routes(left, right):
    return isinstance(left, list) and isinstance(right, list) and left == right


def _stable_adapter_config(config):
    """Alpha-rename Caddy's generated group labels without changing their links."""
    result = copy.deepcopy(config)
    names = {}

    def walk(value):
        if isinstance(value, dict):
            for key, child in value.items():
                if key == "group" and isinstance(child, str) and re.fullmatch(r"group[0-9]+", child):
                    value[key] = names.setdefault(child, f"group{len(names)}")
                else:
                    walk(child)
        elif isinstance(value, list):
            for child in value:
                walk(child)

    walk(result)
    return result


def _same_adapted_config(left, right):
    # Caddy assigns groupNN names while adapting routes. Inserting a hostname
    # earlier in its sorted route order can renumber groups and reorder
    # terminal routes for disjoint literal hosts. Normalize those two adapter
    # effects for comparison only; never use the normalized value for writes.
    return _stable_adapter_config(_sort_disjoint_literal_host_routes(left)) == _stable_adapter_config(
        _sort_disjoint_literal_host_routes(right)
    )


def _literal_host(host):
    return (
        isinstance(host, str)
        and bool(host)
        and host == host.strip()
        and not any(char.isspace() or char in "*{}?<>/\\%" for char in host)
    )


def _route_exact_hosts(route):
    if not isinstance(route, dict) or route.get("terminal") is not True:
        return None
    alternatives = route.get("match")
    if not isinstance(alternatives, list) or not alternatives:
        return None
    hosts = []
    for alternative in alternatives:
        values = alternative.get("host") if isinstance(alternative, dict) else None
        if not isinstance(values, list) or not values or not all(_literal_host(value) for value in values):
            return None
        hosts.extend(value.casefold() for value in values)
    if len(set(hosts)) != len(hosts):
        return None
    return tuple(sorted(hosts))


def _sort_disjoint_literal_host_routes(config):
    """Sort comparison copies only when terminal routes have disjoint exact hosts."""
    result = copy.deepcopy(config)
    servers = result.get("apps", {}).get("http", {}).get("servers", {})
    if not isinstance(servers, dict):
        return result
    for server in servers.values():
        routes = server.get("routes") if isinstance(server, dict) else None
        if not isinstance(routes, list) or not routes:
            continue
        host_keys = [_route_exact_hosts(route) for route in routes]
        if any(key is None for key in host_keys):
            continue
        all_hosts = [host for key in host_keys for host in key]
        if len(set(all_hosts)) != len(all_hosts):
            continue
        server["routes"] = [route for _, route in sorted(zip(host_keys, routes), key=lambda pair: pair[0])]
    return result


def install(config, state):
    config = Path(config)
    with config.open("r+b") as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        original = stream.read()
        verify_caddyfile_mount(config)

        live, live_etag = request("/config/")
        if not isinstance(live, dict) or not live_etag:
            raise RuntimeError("Caddy live config or concurrency fence is unavailable; no changes made")

        text = original.decode("utf-8")
        has_start = BLOCK_START in text
        has_end = BLOCK_END in text
        if has_start != has_end or text.count(BLOCK_START) > 1 or text.count(BLOCK_END) > 1:
            raise RuntimeError("Open Dot Caddyfile ownership markers are incomplete or duplicated")
        owned_in_file = has_start and BLOCK.strip() in text
        if has_start and not owned_in_file:
            raise RuntimeError("Existing Open Dot Caddyfile block is not owned by this helper")

        adapted_source = adapt(original)
        adapted_route = None
        adapted_server = None
        if owned_in_file:
            adapted_server, adapted_route = _extract_owned_route(adapted_source)
            source_without_owned = _without_route(adapted_source, adapted_server, adapted_route)
            active = _find_site_routes(live)
            if (
                len(active) != 1
                or active[0][0] != adapted_server
                or active[0][2] != adapted_route
            ):
                raise RuntimeError("Owned Open Dot file block does not match the live Caddy route")
            live_without_owned = _without_route(live, adapted_server, adapted_route)
        else:
            if _find_site_routes(adapted_source):
                raise RuntimeError("An unmanaged Open Dot route already exists in the Caddyfile")
            source_without_owned = adapted_source
            live_without_owned = live

        # Align only comparison copies before matching positional file aliases.
        # Actual live route order is retained for the append and rollback paths.
        source_for_compare = _sort_disjoint_literal_host_routes(source_without_owned)
        live_for_compare = _sort_disjoint_literal_host_routes(live_without_owned)
        normalized, aliases = normalize_verified_file_aliases(source_for_compare, live_for_compare)
        same_baseline = _same_adapted_config(normalized, live_for_compare)
        if not same_baseline:
            raise RuntimeError("Caddy live/file drift remains after the verified Caddyfile path normalization; no changes made")
        if aliases > 1:
            raise RuntimeError("Unexpected number of Caddyfile path aliases; no changes made")

        if owned_in_file:
            print("Open Dot ingress already installed; live route and owned file block match")
            return

        candidate = original + BLOCK.encode("utf-8")
        adapted_candidate = adapt(candidate)
        server_name, route = _extract_owned_route(adapted_candidate)
        if server_name not in live.get("apps", {}).get("http", {}).get("servers", {}):
            raise RuntimeError("Open Dot route does not target an existing live HTTP server")
        candidate_without_route = _without_route(adapted_candidate, server_name, route)
        candidate_for_compare = _sort_disjoint_literal_host_routes(candidate_without_route)
        source_for_compare = _sort_disjoint_literal_host_routes(adapted_source)
        if not _same_adapted_config(candidate_for_compare, source_for_compare):
            raise RuntimeError("Adding Open Dot changes other adapted Caddy routes; no changes made")

        if _find_site_routes(live):
            raise RuntimeError("An Open Dot route already exists in live Caddy config but is not owned here")
        active_server = live["apps"]["http"]["servers"][server_name]
        live_routes = active_server.get("routes")
        if not isinstance(live_routes, list) or any(_route_can_match_site(item) for item in live_routes):
            raise RuntimeError("A live Caddy route may intercept Open Dot; no changes made")

        route_path = _route_path(server_name)
        scoped_routes, route_etag = request(route_path)
        if not _same_routes(scoped_routes, live_routes) or not route_etag:
            raise RuntimeError("Caddy routes changed during preflight; no changes made")
        desired_routes = copy.deepcopy(live_routes) + [route]

        state.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(state, 0o700)
        file_backup = state / "Caddyfile.before-open-dot"
        config_backup = state / "Caddy-config.before-open-dot.json"
        _write_private(file_backup, original)
        config_record = json.dumps(
            {"etag": live_etag, "config": live}, sort_keys=True, separators=(",", ":")
        ).encode("utf-8")
        _write_private(config_backup, config_record)

        try:
            request(
                route_path,
                json.dumps(route).encode("utf-8"),
                {"Content-Type": "application/json", "If-Match": route_etag},
                method="POST",
            )
        except Exception as failure:
            # A dropped response may follow a committed append. Continue only
            # when the exact expected array proves that our single append landed.
            try:
                current_routes, _ = request(route_path)
            except Exception as reconcile_failure:
                raise RuntimeError("Caddy route update outcome is unknown; inspect private backups") from reconcile_failure
            if not _same_routes(current_routes, desired_routes):
                if _same_routes(current_routes, live_routes):
                    raise RuntimeError("Caddy route update failed before applying; no file change made") from failure
                raise RuntimeError("Caddy route update outcome is ambiguous; inspect private backups") from failure

        current_routes, _ = request(route_path)
        if not _same_routes(current_routes, desired_routes):
            raise RuntimeError("Caddy route array changed after update; file was not changed")

        try:
            _write_stream(stream, candidate)
            stream.seek(0)
            if stream.read() != candidate:
                raise OSError("managed Caddyfile did not retain the owned block")
        except Exception as failure:
            # Restore only if the route array still consists of the exact
            # preflight snapshot plus our one route.
            route_rollback_failure = None
            try:
                current_routes, current_etag = request(route_path)
                if not _same_routes(current_routes, desired_routes) or not current_etag:
                    raise RuntimeError("live route changed concurrently")
                request(
                    route_path,
                    json.dumps(live_routes).encode("utf-8"),
                    {"Content-Type": "application/json", "If-Match": current_etag},
                    method="PUT",
                )
                restored_routes, _ = request(route_path)
                if not _same_routes(restored_routes, live_routes):
                    raise RuntimeError("live route rollback did not restore the exact snapshot")
            except Exception as rollback_failure:
                route_rollback_failure = rollback_failure
            try:
                _write_stream(stream, original)
            except Exception as file_rollback_failure:
                if route_rollback_failure:
                    raise RuntimeError("Ingress file write failed; both route and file rollback failed, reconcile from private backups") from route_rollback_failure
                raise RuntimeError("Ingress file write failed; route restored but file needs reconciliation from its private backup") from file_rollback_failure
            if route_rollback_failure:
                raise RuntimeError("Ingress file restored; live route rollback failed, reconcile against private backups") from route_rollback_failure
            raise RuntimeError("Ingress file write failed; original file and live route array restored") from failure

        print("Open Dot route installed through scoped Caddy API; private file and live-config rollback saved")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--state-dir", required=True, type=Path)
    args = parser.parse_args()
    install(Path("/root/hivemind/infra/Caddyfile"), args.state_dir)
