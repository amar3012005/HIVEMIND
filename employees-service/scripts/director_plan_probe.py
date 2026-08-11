#!/usr/bin/env python3
"""Run only the HyperAgents Director planning call.

This probe deliberately does not gather evidence, run workers or debate, create a
Room, persist an artifact, or invoke a provider. It is the regression harness for
the first Director decision: given a request and the evidence already available,
what plan does the Director produce?

Examples:

  # Repeatable normalization test, no model request.
  python scripts/director_plan_probe.py \
    --request "Find regulated companies near Hannover and prepare drafts." \
    --fixture-plan /tmp/outreach-plan.json

  # Live Director-only probe. Run inside hm-employees so normal model settings
  # and credentials are available.
  docker exec -i hm-employees python /app/scripts/director_plan_probe.py \
    --live --request "Create a launch-ready campaign. Do not publish." \
    --company-brief-file /tmp/company-brief.txt
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from pathlib import Path
from typing import Any, Dict, List


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "src") not in sys.path:
    sys.path.insert(0, str(ROOT / "src"))

from hivemind_employees.hyper.engine import Director  # noqa: E402


DEFAULT_PARTICIPANTS = [
    {"slug": "director", "name": "Director", "_lane": "Strategist"},
    {"slug": "reviewer", "name": "Reviewer", "_lane": "Skeptic"},
]


def _read_text(value: str, path: str) -> str:
    if value:
        return value
    if path:
        return Path(path).read_text(encoding="utf-8")
    return ""


def _load_json(path: str) -> Dict[str, Any]:
    value = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("fixture plan must be a JSON object")
    return value


def _build_director(args: argparse.Namespace, events: List[Dict[str, Any]]) -> Director:
    async def emit(event: Dict[str, Any]) -> None:
        events.append(event)

    connectors = [item.strip() for item in args.connectors.split(",") if item.strip()]
    return Director(
        user_message=args.request,
        user_id=args.user_id,
        org_id=args.org_id,
        project_id=args.project_id or None,
        participants=DEFAULT_PARTICIPANTS,
        room_template="auto",
        room_goal=args.room_goal,
        enabled_connectors=connectors,
        emit=emit,
        director_model=args.model or None,
        persona_model=args.model or None,
        synth_model=args.model or None,
        company_brief=_read_text(args.company_brief, args.company_brief_file),
        room_kind=args.room_kind,
        room_mode=args.room_mode,
    )


async def probe(args: argparse.Namespace) -> Dict[str, Any]:
    events: List[Dict[str, Any]] = []
    director = _build_director(args, events)

    if args.fixture_plan:
        fixture = _load_json(args.fixture_plan)

        async def fixture_call(*_args: Any, **_kwargs: Any) -> Dict[str, str]:
            return {"content": json.dumps(fixture)}

        director._groq = fixture_call  # type: ignore[method-assign]
    elif not args.live:
        raise ValueError("choose --live or provide --fixture-plan; the probe never makes an implicit model call")

    # _plan_gather only needs registered connector names. Initializing them is
    # read-only and lets a live probe show the same tool catalog as production.
    if args.live:
        await director._init_connector_tools()

    started = time.perf_counter()
    plan = await director._plan_gather()
    latency_ms = round((time.perf_counter() - started) * 1000)
    return {
        "probe_contract": "director-plan-probe.v1",
        "input": {
            "request": args.request,
            "room_kind": director.room_kind,
            "room_mode": director.room_mode,
            "connector_names": director.connectors,
            "company_brief_chars": len(director.company_brief),
        },
        "decision": plan,
        "metrics": {
            "latency_ms": latency_ms,
            "tokens": director.tokens,
            "input_tokens": director.io.get("input", 0),
            "output_tokens": director.io.get("output", 0),
            "cached_tokens": director.io.get("cached", 0),
            "model_usage": director.model_usage,
        },
        "events": events,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request", required=True, help="Raw human request to inspect.")
    parser.add_argument("--live", action="store_true", help="Call the configured Director model once.")
    parser.add_argument("--fixture-plan", help="JSON plan response to normalize without a model call.")
    parser.add_argument("--company-brief", default="", help="Optional already-resolved company context.")
    parser.add_argument("--company-brief-file", default="", help="Read company context from a UTF-8 file.")
    parser.add_argument("--connectors", default="", help="Comma-separated connected capability names.")
    parser.add_argument("--room-kind", default="general")
    parser.add_argument("--room-mode", default="work", choices=("work", "runtime"))
    parser.add_argument("--room-goal", default="")
    parser.add_argument("--model", default="", help="Optional Director-model override.")
    parser.add_argument("--user-id", default="director-probe-user")
    parser.add_argument("--org-id", default="director-probe-org")
    parser.add_argument("--project-id", default="")
    parser.add_argument("--output", default="", help="Write the JSON result to this path as well as stdout.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.live and args.fixture_plan:
        raise SystemExit("--live and --fixture-plan are mutually exclusive")
    try:
        result = asyncio.run(probe(args))
    except Exception as exc:  # A probe must be scriptable: report failure as JSON.
        result = {"probe_contract": "director-plan-probe.v1", "error": str(exc)}
    rendered = json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True)
    print(rendered)
    if args.output:
        Path(args.output).write_text(rendered + "\n", encoding="utf-8")
    return 0 if "error" not in result else 1


if __name__ == "__main__":
    raise SystemExit(main())
