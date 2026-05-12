"""Smoke harness for TeamRoom (AgentScope backed).

Two modes:
  1. ``--mock --task "..."``
     Uses stub AgentBase subclasses (no LLM, no network). Verifies the
     TeamRoom phase machine + MsgHub broadcast plumbing without burning
     tokens. Default in CI.
  2. ``--from-db slug1,slug2 --task "..."``
     Pulls real DigitalEmployee rows from Postgres, builds an AgentScope
     ReActAgent per row, runs the team task end-to-end. Requires
     DATABASE_URL + HIVEMIND_CORE_URL + bootstrap reachable.

Usage::

    python -m hivemind_employees.orchestration.smoke --mock --task "plan EU launch"
    python -m hivemind_employees.orchestration.smoke --from-db helpdesk,legal --task "..."
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
from typing import List

from agentscope.agent import AgentBase
from agentscope.message import Msg

from .team_room import TeamRoom, TeamTask
from .worker import EmployeeWorker, WorkerMessage


# ── Stub agent (no LLM, no tools) ───────────────────────────────
class _StubAgent(AgentBase):
    """Mimics ReActAgent's external surface for offline smoke tests.

    Holds its own message memory (so MsgHub.broadcast → observe() lands
    somewhere) and emits canned replies based on the latest instruction
    text. Phase markers in the instructions disambiguate which canned
    output to produce.
    """

    def __init__(self, name: str, role: str):
        super().__init__()
        self.name = name
        self.role = role
        self._memory: List[Msg] = []

    async def observe(self, msg) -> None:  # type: ignore[override]
        if msg is None:
            return
        if isinstance(msg, list):
            self._memory.extend(msg)
        else:
            self._memory.append(msg)

    async def reply(self, msg=None, **_) -> Msg:  # type: ignore[override]
        if msg is not None:
            await self.observe(msg)
        instruction = self._latest_instruction_text()
        content = self._canned_reply(instruction)
        out = Msg(name=self.name, content=content, role="assistant")
        # Don't echo our own reply into local memory here — MsgHub will
        # observe() it back when broadcasting.
        return out

    # Helpers --------------------------------------------------
    def _latest_instruction_text(self) -> str:
        for m in reversed(self._memory):
            content = m.content
            if isinstance(content, list):
                text_parts = []
                for blk in content:
                    if isinstance(blk, dict):
                        text_parts.append(blk.get("text") or "")
                    else:
                        text_parts.append(str(blk))
                content = "\n".join(p for p in text_parts if p)
            content = (content or "").strip()
            if content:
                return content
        return ""

    def _canned_reply(self, prompt: str) -> str:
        lower = (prompt or "").lower()
        if "you are the synthesizer" in lower:
            return (
                f"FINAL_ANSWER: The team agrees to proceed with the "
                f"{self.role}-led plan within the scoped constraints; no "
                f"unresolved contradictions remain.\n"
                "OPEN_QUESTIONS: none"
            )
        if "revise to address" in lower or "revised_claim" in lower:
            return (
                f"REVISED_CLAIM: {self.role}-led action, scoped to the agreed "
                f"constraints, will resolve the request\n"
                "CHANGES: tightened scope per reviewer critique"
            )
        if "investigate the team task" in lower or "evidence-gathering" in lower:
            return (
                f"- {self.role} finding 1: relevant context recalled from memory\n"
                f"- {self.role} finding 2: one external reference identified"
            )
        if "propose one concrete claim" in lower:
            return (
                f"CLAIM: {self.role}-led action will resolve the request\n"
                f"EVIDENCE: my findings 1 and 2 above\n"
                f"CONFIDENCE: medium"
            )
        if "review the latest claim" in lower:
            if self.role in ("legal", "compliance", "challenger", "fact-checker"):
                return (
                    "VERDICT: needs_revision\n"
                    "CRITIQUE: claim under-specifies the constraint scope"
                )
            return (
                "VERDICT: supports\n"
                "CRITIQUE: claim is consistent with the findings cited"
            )
        return f"({self.role} acknowledges)"


def _mock_roster() -> List[EmployeeWorker]:
    """Three-employee mock team: explorer, legal (adversary), synthesizer."""
    specs = [
        ("emp-explorer", "Researcher", "explorer", ["advocate", "researcher"]),
        ("emp-legal", "Legal Counsel", "legal", ["explorer", "advocate", "researcher"]),
        ("emp-synth", "Synthesizer", "synthesizer", []),
    ]
    roster: List[EmployeeWorker] = []
    for eid, name, role, targets in specs:
        agent = _StubAgent(name=eid, role=role)
        roster.append(EmployeeWorker(
            employee_id=eid,
            employee_name=name,
            slug=eid,
            role_archetype=role,
            peer_review_targets=targets,
            agent=agent,
        ))
    return roster


async def _roster_from_db(slugs: List[str]) -> List[EmployeeWorker]:
    """Load real employees + build their AgentScope ReActAgents."""
    from ..agents.agentscope_factory import build_react_agent
    from ..bootstrap_client import fetch_bootstrap
    from ..db import close_pool, init_pool, list_running_employees

    await init_pool()
    try:
        rows = await list_running_employees()
        boot = {b["id"]: b for b in await fetch_bootstrap()}
    finally:
        await close_pool()

    by_slug = {r["slug"]: r for r in rows}
    roster: List[EmployeeWorker] = []
    for slug in slugs:
        emp = by_slug.get(slug)
        if not emp:
            print(f"skip: employee with slug={slug} not found", file=sys.stderr)
            continue
        b = boot.get(emp["id"], {})
        api_key = b.get("api_key")
        if not api_key:
            print(f"skip: no bootstrap api_key for {slug}", file=sys.stderr)
            continue
        agent = build_react_agent(emp, api_key)
        policy = emp.get("policy_rules") or {}
        roster.append(EmployeeWorker(
            employee_id=emp["id"],
            employee_name=emp["name"],
            slug=slug,
            role_archetype=policy.get("role_archetype") or "generalist",
            peer_review_targets=policy.get("peer_review_targets") or [],
            agent=agent,
        ))
    return roster


def _on_event(msg: WorkerMessage) -> None:
    head = f"[r{msg.round_num}] {msg.kind:9s} | {msg.sender_name:18s}"
    body = msg.content.replace("\n", " ")[:140]
    print(f"{head} | {body}")


async def _amain(args: argparse.Namespace) -> int:
    if args.mock:
        roster = _mock_roster()
    else:
        if not args.from_db:
            print("Either --mock or --from-db slugs required", file=sys.stderr)
            return 2
        slugs = [s.strip() for s in args.from_db.split(",") if s.strip()]
        roster = await _roster_from_db(slugs)

    if not roster:
        print("Empty roster — aborting", file=sys.stderr)
        return 2

    task = TeamTask.quick(args.task, max_rounds=args.rounds)

    task_store = None
    if args.persist:
        if not args.org_id:
            print("--persist requires --org-id", file=sys.stderr)
            return 2
        from .task_store import TaskStore
        task_store = TaskStore(org_id=args.org_id, team_id=args.team_id or None)

    room = TeamRoom(task=task, roster=roster, on_event=_on_event, task_store=task_store)
    outcome = await room.run()

    print("\n" + "=" * 60)
    print(f"FINAL ANSWER (rounds={outcome.rounds_completed}, "
          f"claims={outcome.claim_count}, reviews={outcome.review_count}, "
          f"revisions={outcome.revision_count}, gate={outcome.gate_reason})")
    print("=" * 60)
    print(outcome.final_answer)

    if args.json:
        print("\n--- TeamOutcome JSON ---")
        print(json.dumps({
            "task_id": outcome.task_id,
            "rounds_completed": outcome.rounds_completed,
            "claim_count": outcome.claim_count,
            "review_count": outcome.review_count,
            "revision_count": outcome.revision_count,
            "contradictions": outcome.contradictions,
            "gate_reason": outcome.gate_reason,
            "final_answer": outcome.final_answer,
            "transcript": outcome.transcript,
        }, indent=2))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--task", required=True, help="Task brief / question for the team")
    parser.add_argument("--mock", action="store_true", help="Use stub agents (no LLM)")
    parser.add_argument("--from-db", default="", help="Comma-separated employee slugs to load from Postgres")
    parser.add_argument("--rounds", type=int, default=2)
    parser.add_argument("--json", action="store_true", help="Dump TeamOutcome as JSON at the end")
    parser.add_argument("--persist", action="store_true",
                        help="Persist task + transcript to Postgres (requires --org-id)")
    parser.add_argument("--org-id", default="", help="Org UUID for persistence")
    parser.add_argument("--team-id", default="", help="Team UUID for persistence (optional)")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
        stream=sys.stderr,
    )
    return asyncio.run(_amain(args))


if __name__ == "__main__":
    sys.exit(main())
