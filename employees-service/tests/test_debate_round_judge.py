"""_debate() used to hardcode swarm_verdict.converged=True and always run
round 2 whenever the caller allowed up to 2 rounds — a fixed cap, not a real
judgment. _judge_debate_round() (the AgentScope multi-agent-debate moderator
pattern) now decides round 2 adaptively. These tests pin both branches:
skip round 2 when the judge is confident, and fail open (run round 2) on any
judge error — an outage must never silently cut real debate short.
"""
import asyncio

from hivemind_employees.hyper.engine import Director


def _director(message="Compare two options"):
    events = []

    async def emit(event):
        events.append(event)

    director = Director(
        user_message=message,
        user_id="user-1",
        org_id="org-1",
        project_id=None,
        participants=[
            {"slug": "lead", "name": "Lead", "_lane": "Strategist"},
            {"slug": "skeptic", "name": "Skeptic", "_lane": "Skeptic"},
        ],
        room_template="auto",
        room_goal="Standing specialist goal",
        enabled_connectors=[],
        emit=emit,
        room_kind="general",
        company_brief="Singulance Labs provides HIVEMIND and TARA.",
    )
    return director, events


def _fake_consult(name):
    async def _consult(self, emp, prompt, round_no):
        return {
            "slug": emp.get("slug"), "name": emp.get("name") or name,
            "lane": emp.get("_lane", ""), "text": f"{name} round {round_no} stance",
            "is_skeptic": "skeptic" in (emp.get("_lane") or "").lower(), "empty": False,
        }
    return _consult


def test_round_2_is_skipped_when_the_judge_is_confident(monkeypatch):
    director, events = _director()
    monkeypatch.setattr(Director, "_consult", _fake_consult("agent"))

    async def fake_judge(self, topic, transcript):
        return {"sufficient": True, "disagreement_note": "Both agree on the core risk.", "judged": True}
    monkeypatch.setattr(Director, "_judge_debate_round", fake_judge)

    asyncio.run(director._debate("What's our biggest risk?", rounds=2))

    round_starts = [e for e in events if e.get("t") == "round_start"]
    verdicts = [e for e in events if e.get("t") == "swarm_verdict"]
    assert len(round_starts) == 1, "round 2 must not start when the judge says sufficient"
    assert verdicts[-1]["skipped_round_2"] is True
    assert verdicts[-1]["disagreement_note"] == "Both agree on the core risk."
    assert director._debate_disagreement_note == "Both agree on the core risk."
    assert not any(t.get("round") == 2 for t in director.transcript)


def test_round_2_runs_when_the_judge_finds_real_disagreement(monkeypatch):
    director, events = _director()
    monkeypatch.setattr(Director, "_consult", _fake_consult("agent"))

    async def fake_judge(self, topic, transcript):
        return {"sufficient": False, "disagreement_note": "Clear split on priorities.", "judged": True}
    monkeypatch.setattr(Director, "_judge_debate_round", fake_judge)

    asyncio.run(director._debate("What's our biggest risk?", rounds=2))

    round_starts = [e for e in events if e.get("t") == "round_start"]
    verdicts = [e for e in events if e.get("t") == "swarm_verdict"]
    assert len(round_starts) == 2, "round 2 must run when the judge finds real disagreement"
    assert verdicts[-1]["skipped_round_2"] is False
    assert any(t.get("round") == 2 for t in director.transcript)


def test_judge_provider_error_is_caught_and_reports_unjudged(monkeypatch):
    """Exercises the REAL _judge_debate_round, not a mock of it — proves its own
    try/except actually catches a provider failure and returns judged=False
    rather than propagating and crashing the turn."""
    director, _events = _director()

    async def broken_groq(self, *args, **kwargs):
        raise RuntimeError("provider outage")
    monkeypatch.setattr(Director, "_groq", broken_groq)

    result = asyncio.run(director._judge_debate_round(
        "What's our biggest risk?", [{"name": "Agent", "text": "a stance", "empty": False}],
    ))

    assert result == {"sufficient": False, "disagreement_note": "", "judged": False}


def test_unjudged_verdict_fails_open_and_still_runs_round_2(monkeypatch):
    director, events = _director()
    monkeypatch.setattr(Director, "_consult", _fake_consult("agent"))

    # The caller's contract: any judged=False result — whether from a real
    # "not sufficient" verdict or a swallowed error upstream — must run round 2,
    # never skip it.
    async def unjudged(self, topic, transcript):
        return {"sufficient": False, "disagreement_note": "", "judged": False}
    monkeypatch.setattr(Director, "_judge_debate_round", unjudged)

    asyncio.run(director._debate("What's our biggest risk?", rounds=2))

    round_starts = [e for e in events if e.get("t") == "round_start"]
    assert len(round_starts) == 2, "an unjudged (failed) verdict must default to running round 2"


def test_judge_is_never_called_when_caller_only_allows_one_round(monkeypatch):
    director, events = _director()
    monkeypatch.setattr(Director, "_consult", _fake_consult("agent"))

    called = {"n": 0}

    async def counting_judge(self, topic, transcript):
        called["n"] += 1
        return {"sufficient": True, "disagreement_note": "", "judged": True}
    monkeypatch.setattr(Director, "_judge_debate_round", counting_judge)

    asyncio.run(director._debate("What's our biggest risk?", rounds=1))

    assert called["n"] == 0, "a single-round debate (e.g. campaign/seo) must never pay for a judge call"
    round_starts = [e for e in events if e.get("t") == "round_start"]
    assert len(round_starts) == 1
