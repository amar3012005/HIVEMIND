"""TeamRoom — async phase machine driving a roster of EmployeeWorkers.

Built on `agentscope.pipeline.MsgHub` for peer-message broadcasting. We
disable MsgHub auto-broadcast so we can run agents inside a phase in
parallel (asyncio.gather) without mid-phase races, then explicitly
broadcast each phase's output as a single end-of-phase batch.

Phase shape (mirrors MiroFish CSI deep-research):
    Round N
      1. INVESTIGATE   each worker gathers evidence (tools optional)
      2. PROPOSE       each worker drafts a CLAIM
      3. REVIEW        per claim, pick up to 2 adversarial reviewers
      4. REVISE        proposer rewrites claims with needs_revision verdict
      5. SYNTHESIZE    (last round only) one synthesizer consolidates

    Gate: stop early when min reviewed_ratio AND no open contradictions.

Transcript collection runs alongside MsgHub: every published message is
also recorded as a `WorkerMessage` so we can stream to Slack cards,
persist to Postgres, and dump JSON for replay.
"""
from __future__ import annotations

import asyncio
import logging
import re
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple

from agentscope.message import Msg
from agentscope.pipeline import MsgHub

from .worker import EmployeeWorker, WorkerMessage

log = logging.getLogger(__name__)

EventCallback = Callable[[WorkerMessage], None]


# ── Public dataclasses ───────────────────────────────────────────
@dataclass
class TeamTask:
    """Input describing what the team should accomplish."""
    task_id: str
    brief: str
    requested_by: Optional[str] = None  # slack_user_id or employee_id
    channel: Optional[str] = None
    thread_ts: Optional[str] = None
    max_rounds: int = 2
    min_claims_for_synthesis: int = 2
    min_reviewed_ratio: float = 0.8

    @classmethod
    def quick(cls, brief: str, max_rounds: int = 2) -> "TeamTask":
        return cls(task_id=str(uuid.uuid4()), brief=brief, max_rounds=max_rounds)


@dataclass
class TeamOutcome:
    task_id: str
    final_answer: str
    rounds_completed: int
    claim_count: int
    review_count: int
    revision_count: int
    contradictions: int
    transcript: List[Dict[str, Any]] = field(default_factory=list)
    gate_reason: str = ""


# ── Phase prompts ────────────────────────────────────────────────
_PROMPT_INVESTIGATE = (
    "Investigate the team task. Use your tools (recall memory, search) to "
    "gather evidence. Report 2–4 short bullet findings with citations. Do "
    "NOT propose a final answer yet — this turn is for evidence-gathering only."
)
_PROMPT_PROPOSE = (
    "Based on the team's findings so far, propose ONE concrete claim that "
    "advances the task. Format:\n"
    "CLAIM: <one sentence>\n"
    "EVIDENCE: <which findings/sources support it>\n"
    "CONFIDENCE: <low|medium|high>"
)
_PROMPT_REVIEW = (
    "Review the latest CLAIM from your peer. Challenge it — look for missing "
    "evidence, contradictions with prior findings, or scope creep. Format:\n"
    "VERDICT: <supports | contradicts | needs_revision>\n"
    "CRITIQUE: <why, citing specifics>"
)
_PROMPT_REVISE = (
    "A peer reviewer flagged your claim. Read their critique above and "
    "revise to address it. Format:\n"
    "REVISED_CLAIM: <updated one-sentence claim>\n"
    "CHANGES: <what you changed and why>"
)
_PROMPT_SYNTHESIZE = (
    "You are the synthesizer. Read every CLAIM and VERDICT in the transcript "
    "above and produce the team's consolidated answer. Drop any claim with "
    "an unresolved 'contradicts' verdict. Format:\n"
    "FINAL_ANSWER: <2–4 sentences resolving the original task>\n"
    "OPEN_QUESTIONS: <anything the team could not resolve>"
)


_VERDICT_RE = re.compile(r"VERDICT\s*:\s*(supports|contradicts|needs[_\s-]revision)", re.IGNORECASE)
_CLAIM_RE = re.compile(r"CLAIM\s*:\s*(.+?)(?:\n[A-Z_]+:|$)", re.IGNORECASE | re.DOTALL)


def _parse_verdict(text: str) -> str:
    m = _VERDICT_RE.search(text or "")
    if not m:
        return "needs_revision"
    raw = m.group(1).lower().replace(" ", "_").replace("-", "_")
    return "needs_revision" if raw.startswith("needs") else raw


def _is_valid_claim(text: str) -> bool:
    return bool(_CLAIM_RE.search(text or ""))


# ── TeamRoom ─────────────────────────────────────────────────────
class TeamRoom:
    """One ephemeral room running one TeamTask across one roster."""

    def __init__(
        self,
        task: TeamTask,
        roster: List[EmployeeWorker],
        on_event: Optional[EventCallback] = None,
        task_store: Optional[Any] = None,
    ):
        if not roster:
            raise ValueError("TeamRoom needs at least one worker")
        self.task = task
        self.roster = roster
        self._on_event = on_event
        # Optional persistence side-channel. Duck-typed Protocol:
        #   await store.open(task, roster_ids)
        #   await store.record(task_id, msg)
        #   await store.close(outcome, status="completed"|"failed")
        #   await store.fail(task_id, error)
        # Failures inside the store must never break the phase machine.
        self._store = task_store
        self._transcript: List[WorkerMessage] = []
        for worker in self.roster:
            worker.bind_task(task.brief)

    # ── Public entry ──────────────────────────────────────────
    async def run(self) -> TeamOutcome:
        log.info(
            "TeamRoom start: task=%s roster=%d max_rounds=%d",
            self.task.task_id, len(self.roster), self.task.max_rounds,
        )

        if self._store is not None:
            try:
                await self._store.open(self.task, [w.employee_id for w in self.roster])
            except Exception as exc:
                log.warning("task_store.open failed (continuing in-memory): %s", exc)

        participants = [w.agent for w in self.roster]
        # Announcement Msg seeds every agent's memory with the task brief.
        announcement = Msg(
            name="TeamRoom",
            content=(
                f"You are joining a team task.\n\n"
                f"TASK BRIEF\n----------\n{self.task.brief}\n\n"
                f"ROSTER\n------\n"
                + "\n".join(f"- {w.employee_name} ({w.role_archetype})" for w in self.roster)
                + "\n\nYou will be asked to perform phase-specific work each turn. "
                  "Stay in-character with your persona. Cite evidence when proposing claims."
            ),
            role="user",
        )

        rounds_completed = 0
        gate_reason = "max_rounds"
        final_answer = ""

        # enable_auto_broadcast=False: we control when phase output is
        # visible to peers so parallel phase execution is race-free.
        async with MsgHub(
            participants=participants,
            announcement=announcement,
            enable_auto_broadcast=False,
            name=f"team-{self.task.task_id[:8]}",
        ) as hub:
            await self._record_system(
                f"Task opened: {self.task.brief}",
                round_num=0,
                metadata={"roster": [w.slug for w in self.roster]},
            )

            for round_num in range(1, self.task.max_rounds + 1):
                rounds_completed = round_num
                await self._record_system(f"=== Round {round_num} begin ===", round_num)

                await self._phase_investigate(hub, round_num)
                new_claims = await self._phase_propose(hub, round_num)
                await self._phase_review(hub, round_num, new_claims)
                await self._phase_revise(hub, round_num)

                if self._gate_satisfied():
                    gate_reason = "gate_satisfied"
                    await self._record_system(
                        f"Gate satisfied at round {round_num} — stopping early.",
                        round_num,
                    )
                    break

            final_answer = await self._phase_synthesize(hub, rounds_completed)

        outcome = self._build_outcome(rounds_completed, final_answer, gate_reason)
        if self._store is not None:
            try:
                await self._store.close(outcome, status="completed")
            except Exception as exc:
                log.warning("task_store.close failed: %s", exc)
        return outcome

    # ── Phase 1: investigate (parallel, no broadcast yet) ────
    async def _phase_investigate(self, hub: MsgHub, round_num: int) -> None:
        results = await self._gather(
            self.roster,
            lambda w: w.respond(_PROMPT_INVESTIGATE, round_num=round_num, phase="investigate"),
        )
        replies = [(w, turn) for w, turn in results if turn]
        await self._broadcast_batch(hub, replies, round_num, kind="chat", phase="investigate")

    # ── Phase 2: propose (parallel, then broadcast) ──────────
    async def _phase_propose(self, hub: MsgHub, round_num: int) -> List[WorkerMessage]:
        results = await self._gather(
            self.roster,
            lambda w: w.respond(_PROMPT_PROPOSE, round_num=round_num, phase="propose"),
        )
        kept: List[Tuple[EmployeeWorker, WorkerTurn]] = [
            (w, turn) for w, turn in results if turn and turn.text and _is_valid_claim(turn.text)
        ]
        messages = await self._broadcast_batch(
            hub, kept, round_num, kind="claim", phase="propose"
        )
        return messages

    # ── Phase 3: review (parallel reviewers per claim) ───────
    async def _phase_review(
        self, hub: MsgHub, round_num: int, new_claims: List[WorkerMessage]
    ) -> None:
        if not new_claims:
            return

        # Build (reviewer, claim_msg) tuples — at most 2 reviewers per claim.
        plans: List[Tuple[EmployeeWorker, WorkerMessage]] = []
        for claim_msg in new_claims:
            proposer = self._find_worker(claim_msg.sender_id)
            for reviewer in self._pick_reviewers(proposer, max_reviewers=2):
                plans.append((reviewer, claim_msg))

        async def _do(plan: Tuple[EmployeeWorker, WorkerMessage]) -> Tuple[EmployeeWorker, str, WorkerMessage]:
            reviewer, claim_msg = plan
            instruction = (
                f"{_PROMPT_REVIEW}\n\n"
                f"The claim under review was authored by {claim_msg.sender_name} "
                f"({claim_msg.sender_role})."
            )
            reply = await reviewer.respond(instruction, round_num=round_num, phase="review", target_message=claim_msg)
            return reviewer, reply, claim_msg

        outputs = await asyncio.gather(*(_do(p) for p in plans), return_exceptions=True)

        replies_to_broadcast: List[Tuple[EmployeeWorker, str, Dict[str, Any]]] = []
        for out in outputs:
            if isinstance(out, BaseException):
                log.warning("review failed: %s", out)
                continue
            reviewer, reply, claim_msg = out
            if not reply or not reply.text:
                continue
            verdict = _parse_verdict(reply.text)
            replies_to_broadcast.append((
                reviewer,
                reply,
                {
                    "phase": "review",
                    "target_claim_id": claim_msg.msg_id,
                    "target_author": claim_msg.sender_name,
                    "verdict": verdict,
                },
            ))
        await self._broadcast_with_metadata(hub, replies_to_broadcast, round_num, kind="review")

    # ── Phase 4: revise ──────────────────────────────────────
    async def _phase_revise(self, hub: MsgHub, round_num: int) -> None:
        reviews_by_claim: Dict[str, List[WorkerMessage]] = {}
        for r in self._of_kind("review"):
            cid = r.metadata.get("target_claim_id")
            if cid:
                reviews_by_claim.setdefault(cid, []).append(r)

        needs_revision: List[WorkerMessage] = []
        for claim in self._of_kind("claim"):
            rs = reviews_by_claim.get(claim.msg_id, [])
            if any(r.metadata.get("verdict") == "needs_revision" for r in rs):
                needs_revision.append(claim)
        if not needs_revision:
            return

        async def _do(claim_msg: WorkerMessage) -> Tuple[Optional[EmployeeWorker], str, Dict[str, Any]]:
            proposer = self._find_worker(claim_msg.sender_id)
            if not proposer:
                return None, "", {}
            reply = await proposer.respond(_PROMPT_REVISE, round_num=round_num, phase="revise", target_message=claim_msg)
            return proposer, reply, {
                "phase": "revise",
                "revises_claim_id": claim_msg.msg_id,
            }

        outputs = await asyncio.gather(*(_do(c) for c in needs_revision), return_exceptions=True)
        replies_to_broadcast: List[Tuple[EmployeeWorker, str, Dict[str, Any]]] = []
        for out in outputs:
            if isinstance(out, BaseException):
                log.warning("revise failed: %s", out)
                continue
            proposer, reply, meta = out
            if proposer and reply and reply.text:
                replies_to_broadcast.append((proposer, reply, meta))
        await self._broadcast_with_metadata(hub, replies_to_broadcast, round_num, kind="revision")

    # ── Phase 5: synthesize ──────────────────────────────────
    async def _phase_synthesize(self, hub: MsgHub, round_num: int) -> str:
        synth = self._pick_synthesizer()
        if not synth:
            return "(no synthesizer available; review transcript directly)"
        reply = await synth.respond(_PROMPT_SYNTHESIZE, round_num=round_num, phase="synthesize")
        if reply and reply.text:
            await self._broadcast_with_metadata(
                hub,
                [(synth, reply, {"phase": "synthesize"})],
                round_num,
                kind="synthesis",
            )
        return reply.text if reply and reply.text else "(synthesizer returned empty answer)"

    # ── Gate policy ──────────────────────────────────────────
    def _gate_satisfied(self) -> bool:
        claims = self._of_kind("claim")
        reviews = self._of_kind("review")
        if not claims:
            return False
        reviewed_ids = {r.metadata.get("target_claim_id") for r in reviews}
        reviewed = sum(1 for c in claims if c.msg_id in reviewed_ids)
        ratio = reviewed / max(len(claims), 1)
        if ratio < self.task.min_reviewed_ratio:
            return False
        revised_ids = {rev.metadata.get("revises_claim_id") for rev in self._of_kind("revision")}
        open_contradictions = any(
            r.metadata.get("verdict") == "contradicts"
            and r.metadata.get("target_claim_id") not in revised_ids
            for r in reviews
        )
        return not open_contradictions

    # ── Reviewer + synthesizer selection ─────────────────────
    def _pick_reviewers(
        self, proposer: Optional[EmployeeWorker], max_reviewers: int
    ) -> List[EmployeeWorker]:
        if not proposer:
            return []
        candidates = [w for w in self.roster if w.employee_id != proposer.employee_id]
        ranked = sorted(
            candidates,
            key=lambda w: (
                0 if w.can_challenge(proposer.role_archetype) else 1,
                self._review_count_for(w),
            ),
        )
        return ranked[:max_reviewers]

    def _pick_synthesizer(self) -> Optional[EmployeeWorker]:
        synths = [w for w in self.roster if w.role_archetype.lower() in {"synthesizer", "synthesiser", "lead"}]
        if synths:
            return synths[0]
        claim_count: Dict[str, int] = {}
        for c in self._of_kind("claim"):
            claim_count[c.sender_id] = claim_count.get(c.sender_id, 0) + 1
        if not claim_count:
            return self.roster[0]
        best_id = max(claim_count.items(), key=lambda kv: kv[1])[0]
        return self._find_worker(best_id) or self.roster[0]

    # ── Helpers ──────────────────────────────────────────────
    async def _gather(
        self,
        workers: List[EmployeeWorker],
        coro_factory: Callable[[EmployeeWorker], Awaitable[str]],
    ) -> List[Tuple[EmployeeWorker, WorkerTurn]]:
        if not workers:
            return []
        outputs = await asyncio.gather(
            *(coro_factory(w) for w in workers), return_exceptions=True
        )
        results: List[Tuple[EmployeeWorker, WorkerTurn]] = []
        for w, out in zip(workers, outputs):
            if isinstance(out, BaseException):
                log.warning("worker %s failed: %s", w.slug, out)
                continue
            results.append((w, out or WorkerTurn(text="")))
        return results

    async def _broadcast_batch(
        self,
        hub: MsgHub,
        replies: List[Tuple[EmployeeWorker, WorkerTurn]],
        round_num: int,
        kind: str,
        phase: str,
    ) -> List[WorkerMessage]:
        """Broadcast batch to peers via MsgHub.broadcast() + record locally."""
        out_msgs: List[WorkerMessage] = []
        for worker, turn in replies:
            if not turn or not turn.text:
                continue
            for action in turn.actions:
                await self._record(
                    worker,
                    action.get("content") or action.get("label") or "simulation action",
                    round_num=round_num,
                    kind="action",
                    metadata={"phase": phase, **(action.get("metadata") or {}), "action_label": action.get("label")},
                )
            msg = Msg(name=worker.slug, content=turn.text, role="assistant")
            await hub.broadcast(msg)
            out_msgs.append(
                await self._record(
                    worker, turn.text, round_num=round_num, kind=kind, metadata={"phase": phase}
                )
            )
        return out_msgs

    async def _broadcast_with_metadata(
        self,
        hub: MsgHub,
        replies: List[Tuple[EmployeeWorker, WorkerTurn, Dict[str, Any]]],
        round_num: int,
        kind: str,
    ) -> List[WorkerMessage]:
        out_msgs: List[WorkerMessage] = []
        for worker, turn, meta in replies:
            if not turn or not turn.text:
                continue
            for action in turn.actions:
                await self._record(
                    worker,
                    action.get("content") or action.get("label") or "simulation action",
                    round_num=round_num,
                    kind="action",
                    metadata={**meta, **(action.get("metadata") or {}), "action_label": action.get("label")},
                )
            msg = Msg(name=worker.slug, content=turn.text, role="assistant", metadata=meta)
            await hub.broadcast(msg)
            out_msgs.append(
                await self._record(worker, turn.text, round_num=round_num, kind=kind, metadata=meta)
            )
        return out_msgs

    async def _record(
        self,
        worker: EmployeeWorker,
        content: str,
        *,
        round_num: int,
        kind: str,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> WorkerMessage:
        msg = WorkerMessage(
            msg_id=str(uuid.uuid4()),
            sender_id=worker.employee_id,
            sender_name=worker.employee_name,
            sender_role=worker.role_archetype,
            content=content,
            round_num=round_num,
            kind=kind,
            ts=datetime.now(timezone.utc).isoformat(),
            metadata=metadata or {},
        )
        await self._publish(msg)
        return msg

    async def _record_system(
        self,
        content: str,
        round_num: int,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> WorkerMessage:
        msg = WorkerMessage(
            msg_id=str(uuid.uuid4()),
            sender_id="system",
            sender_name="TeamRoom",
            sender_role="system",
            content=content,
            round_num=round_num,
            kind="system",
            metadata=metadata or {},
        )
        await self._publish(msg)
        return msg

    async def _publish(self, msg: WorkerMessage) -> None:
        """Append to in-memory transcript, fire subscribers, persist."""
        self._transcript.append(msg)
        if self._on_event is not None:
            try:
                self._on_event(msg)
            except Exception:
                pass
        if self._store is not None:
            try:
                await self._store.record(self.task.task_id, msg)
            except Exception as exc:
                # Persistence is best-effort: never break the phase machine.
                log.warning("task_store record raised: %s", exc)

    def _of_kind(self, kind: str) -> List[WorkerMessage]:
        return [m for m in self._transcript if m.kind == kind]

    def _review_count_for(self, worker: EmployeeWorker) -> int:
        return sum(1 for r in self._of_kind("review") if r.sender_id == worker.employee_id)

    def _find_worker(self, employee_id: str) -> Optional[EmployeeWorker]:
        for w in self.roster:
            if w.employee_id == employee_id:
                return w
        return None

    def _build_outcome(self, rounds_completed: int, final_answer: str, gate_reason: str) -> TeamOutcome:
        claims = self._of_kind("claim")
        reviews = self._of_kind("review")
        revisions = self._of_kind("revision")
        contradictions = sum(1 for r in reviews if r.metadata.get("verdict") == "contradicts")
        return TeamOutcome(
            task_id=self.task.task_id,
            final_answer=final_answer,
            rounds_completed=rounds_completed,
            claim_count=len(claims),
            review_count=len(reviews),
            revision_count=len(revisions),
            contradictions=contradictions,
            transcript=[m.to_dict() for m in self._transcript],
            gate_reason=gate_reason,
        )
