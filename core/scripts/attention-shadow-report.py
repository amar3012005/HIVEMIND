#!/usr/bin/env python3
"""Read-only comparison of the attention verdicts for one company's connected-app events.

For each event in the window it lists: when it happened and arrived, whether it was live, the company relevance verdict
(company_activity_relevance_v3), Runtime's attention verdict for the employees (relevance_decision.shadowRuntimeAttention in shadow
mode, attentionForEmployees in active mode), the tool hints, Core's forward outcome and the employee OpenDot chose. It ends with
counts and what the live-only rule, burst coalescing and the per-app allowance would have done.

Every query runs in a read-only transaction (SET default_transaction_read_only = on); nothing is written. Arguments are validated
before they reach SQL. The default commands reach production over SSH; pass --core-psql / --opendot-psql to point elsewhere.

Usage:
  python3 core/scripts/attention-shadow-report.py --org 8de2085e-45d4-452b-878e-37ffc751c193 \
    --from 2026-10-31T06:00:00Z --to 2026-10-31T10:00:00Z [--max-age-ms 600000] [--burst-ms 60000] [--per-app-hour 6] [--json]
"""
import argparse
import collections
import datetime as dt
import json
import re
import subprocess
import sys

UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
# Shell commands (run by the local shell); the OpenDot one reads the database user and name inside the container.
CORE_PSQL = "ssh singulance-engine 'docker exec -i hm-postgres psql -U hivemind_user -d hivemind -At -q'"
OPENDOT_PSQL = ("ssh -i /Users/amar/.ssh/id_ed25519_hetzner_singulance root@100.85.110.36 "
                "'docker exec -i runner-dot-production-postgres sh -c \"psql -U \\${POSTGRES_USER:-postgres} -d \\${POSTGRES_DB:-postgres} -At -q\"'")


def iso(value):
    """Parse an ISO time argument; refuses anything else so it can be embedded as a SQL literal."""
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise argparse.ArgumentTypeError("times need a zone, for example 2026-10-31T06:00:00Z")
    return parsed.astimezone(dt.timezone.utc)


def query(command, sql):
    """Run one read-only statement through psql and return its single JSON value."""
    script = f"SET default_transaction_read_only = on;\nBEGIN READ ONLY;\n{sql}\nCOMMIT;\n"
    result = subprocess.run(command, shell=True, input=script, capture_output=True, text=True, timeout=180)
    if result.returncode != 0:
        sys.exit(f"query failed: {result.stderr.strip()[:500]}")
    # json_agg separates elements with line breaks; string values never contain a raw one.
    text = "\n".join(line for line in result.stdout.splitlines() if line.strip() not in ("", "SET", "BEGIN", "COMMIT"))
    return json.loads(text) if text and text != "null" else []


def when(value):
    """A PostgreSQL timestamp as an aware datetime; fractions are padded to microseconds for older Python versions."""
    if not value:
        return None
    text = re.sub(r"\.(\d+)", lambda m: "." + m.group(1)[:6].ljust(6, "0"), value.replace("Z", "+00:00"))
    return dt.datetime.fromisoformat(text)


def choice(value):
    return value.get("choice") if isinstance(value, dict) else None


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--org", required=True)
    parser.add_argument("--from", dest="start", required=True, type=iso)
    parser.add_argument("--to", dest="end", required=True, type=iso)
    parser.add_argument("--max-age-ms", type=int, default=600_000, help="HIVEMIND_ATTENTION_MAX_EVENT_AGE_MS")
    parser.add_argument("--burst-ms", type=int, default=60_000, help="coalescing window to simulate")
    parser.add_argument("--per-app-hour", type=int, default=6, help="OPEN_DOT_EVENT_WAKES_PER_HOUR_PER_SOURCE to simulate")
    parser.add_argument("--core-psql", default=CORE_PSQL)
    parser.add_argument("--opendot-psql", default=OPENDOT_PSQL)
    parser.add_argument("--json", action="store_true", help="print rows as JSON lines instead of a table")
    args = parser.parse_args()
    org = args.org.lower()
    if not UUID.match(org) or args.end <= args.start:
        sys.exit("--org must be a UUID and --to later than --from")
    start, end = args.start.isoformat(), args.end.isoformat()

    events = query(args.core_psql, f"""SELECT coalesce(json_agg(t ORDER BY t.received_at),'[]') FROM (
      SELECT e.id, e.received_at, e.occurred_at, s.toolkit, s.slug,
        left(coalesce(e.data->'_hivemind'->>'title', e.data->>'subject', e.data->>'title', e.data->'pull_request'->>'title', ''), 90) AS title,
        coalesce(e.data->'repository'->>'full_name', e.data->>'sender', e.data->>'from', '') AS source,
        coalesce(e.data->>'message_id', e.data->>'messageId', '') AS message_id,
        e.relevance_status, e.relevance_decision, d.status AS forward_status, d.skip_reason AS forward_outcome, d.attempts AS forward_attempts
      FROM hivemind.hivemind_trigger_events e JOIN hivemind.hivemind_trigger_subscriptions s ON s.id=e.subscription_id
      LEFT JOIN hivemind.hivemind_employee_event_deliveries d ON d.event_id=e.id AND d.employee_id='>opendot'
      WHERE e.org_id='{org}' AND e.received_at>='{start}'::timestamptz AND e.received_at<'{end}'::timestamptz) t;""")
    start_ms, end_ms = int(args.start.timestamp() * 1000) - 3_600_000, int(args.end.timestamp() * 1000) + 3_600_000
    decisions = query(args.opendot_psql, f"""SELECT coalesce(json_agg(t),'[]') FROM (
      SELECT r.event_id, r.outcome, r.record FROM open_dot.event_routing_decisions r
      WHERE r.organization_id='{org}' AND r.created_at BETWEEN {start_ms} AND {end_ms}) t;""")
    names = {row["employee_id"]: row["name"] for row in query(args.opendot_psql, f"""SELECT coalesce(json_agg(t),'[]') FROM (
      SELECT DISTINCT ON (o.employee_id) o.employee_id, d.name FROM open_dot.hivemind_dot_owners o
      JOIN open_dot.dots d ON d.organization_id=o.organization_id AND d.id=o.dot_id WHERE o.organization_id='{org}'
      ORDER BY o.employee_id, d.created_at DESC) t;""")}
    by_event = {row["event_id"]: row for row in decisions}

    rows, wakes = [], collections.defaultdict(list)
    last_burst = {}
    for event in events:
        received, occurred = when(event["received_at"]), when(event["occurred_at"])
        happened = min(t for t in (received, occurred) if t)
        age_ms = int((received - happened).total_seconds() * 1000)
        live = age_ms <= args.max_age_ms
        decision = event["relevance_decision"] or {}
        runtime = decision.get("attentionForEmployees") or decision.get("shadowRuntimeAttention") or {}
        routed = by_event.get(event["id"]) or by_event.get(f"{event['toolkit']}:{event['message_id']}") or {}
        targets = (routed.get("record") or {}).get("targets") or []
        key = (event["toolkit"], event["slug"], event["source"])
        burst = live and key in last_burst and (received - last_burst[key]).total_seconds() * 1000 <= args.burst_ms
        if live:
            last_burst[key] = received if not burst else last_burst[key]
        row = {
            "received": received.strftime("%H:%M:%S"), "happened": happened.strftime("%H:%M:%S"), "ageMin": round(age_ms / 60000, 1),
            "live": live, "toolkit": event["toolkit"], "trigger": event["slug"], "title": event["title"],
            "thin": decision.get("classifierStatus") or decision.get("status") or event["relevance_status"], "thinChoice": decision.get("choice"),
            "deliveredAll": bool(decision.get("deliveredAll")), "source": decision.get("source"),
            "runtime": runtime.get("action") or (runtime.get("unavailable") and f"unavailable:{runtime['unavailable']}"),
            "urgency": choice(runtime.get("urgency")), "need": choice(runtime.get("assessment")), "toolSlugs": runtime.get("toolSlugs") or [],
            "forward": event["forward_status"], "forwardOutcome": event["forward_outcome"],
            "employees": [f"{names.get(t.get('employeeId'), t.get('employeeId', '?')[:8])}:{t.get('status')}{'/' + t['wake'] if t.get('wake') else ''}" for t in targets],
            "wouldCoalesce": bool(burst),
        }
        rows.append(row)
        for target in targets:
            if target.get("status") == "wake":
                wakes[(target.get("employeeId"), event["toolkit"])].append(row)

    if args.json:
        for row in rows:
            print(json.dumps(row))
    else:
        header = ["received", "happened", "ageMin", "live", "toolkit", "trigger", "thin", "runtime", "urgency", "toolSlugs", "forward", "employees", "title"]
        print("\t".join(header))
        for row in rows:
            print("\t".join(str(",".join(row[h]) if isinstance(row[h], list) else row[h]) for h in header))

    count = collections.Counter
    print("\n== summary", file=sys.stderr)
    print(f"events: {len(rows)}; by app: {dict(count(r['toolkit'] for r in rows))}", file=sys.stderr)
    print(f"live (<= {args.max_age_ms // 60000} min old at receipt): {sum(r['live'] for r in rows)}; too old: {sum(not r['live'] for r in rows)}"
          f" (too old by app: {dict(count(r['toolkit'] for r in rows if not r['live']))})", file=sys.stderr)
    print(f"company relevance: {dict(count(r['thin'] for r in rows))}; delivered-all overrides: {sum(r['deliveredAll'] for r in rows)}", file=sys.stderr)
    judged = [r for r in rows if r["runtime"]]
    print(f"Runtime verdicts present: {len(judged)}" + (f"; {dict(count(r['runtime'] for r in judged))}" if judged else
          " (none: shadow mode is not live yet, or the company is on neither list)"), file=sys.stderr)
    if judged:
        agree = count((r["thin"], r["runtime"]) for r in judged)
        print(f"company verdict x Runtime verdict: {dict(agree)}", file=sys.stderr)
    print(f"Core forward outcomes: {dict(count((r['forward'], r['forwardOutcome']) for r in rows))}", file=sys.stderr)
    live_rows = [r for r in rows if r["live"]]
    print(f"with burst coalescing ({args.burst_ms // 1000} s): {sum(not r['wouldCoalesce'] for r in live_rows)} forward requests instead of {len(live_rows)} live events", file=sys.stderr)
    for (employee, toolkit), items in sorted(wakes.items(), key=lambda kv: -len(kv[1])):
        print(f"woken: {names.get(employee, employee)} by {toolkit}: {len(items)}", file=sys.stderr)


if __name__ == "__main__":
    main()
