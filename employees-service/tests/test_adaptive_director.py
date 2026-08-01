import asyncio
import json

from hivemind_employees.hyper.engine import Director
from hivemind_employees.hyper.domains.seo.reporting import render_remediation_report


def _director(*, message: str, room_kind: str = "general", company_brief: str = "", enabled_connectors=None):
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
            {"slug": "researcher", "name": "Researcher", "_lane": "Investigator"},
            {"slug": "builder", "name": "Builder", "_lane": "Builder"},
        ],
        room_template="auto",
        room_goal="Standing specialist goal",
        enabled_connectors=enabled_connectors or [],
        emit=emit,
        room_kind=room_kind,
        company_brief=company_brief,
    )
    return director, events


def test_light_intensity_is_a_bounded_director_contract(monkeypatch):
    director, _events = _director(message="Can we run a campaign for law firms?")
    payload = {
        "recall_queries": ["law firms", "campaign history"],
        "connector_calls": [],
        "web_query": "law firm campaign benchmarks",
        "seo_audit_url": None,
        "seo_audit_scope": "none",
        "seo_task": "none",
        "places_query": None,
        "needs_debate": True,
        "method_skills": [],
        "campaign_method_assignments": [],
        "turn_mode": "task",
        "collaboration_intensity": "light",
        "response_depth": "operating",
        "evidence_mode": "standard",
        "post_output_actions": [],
        "campaign_request": None,
    }

    async def plan_call(*_args, **_kwargs):
        return {"content": json.dumps(payload)}

    monkeypatch.setattr(director, "_groq", plan_call)
    plan = asyncio.run(director._plan_gather())

    assert plan["collaboration_intensity"] == "light"
    assert plan["response_depth"] == "direct"
    assert plan["needs_debate"] is False
    assert len(plan["recall_queries"]) == 1


def test_seo_remediation_refreshes_measured_evidence_without_forcing_deep(monkeypatch):
    director, _events = _director(
        message="Resolve 4 critical and 0 high finding(s)",
        room_kind="seo",
        company_brief="Company: BB Markenagentur\nWebsite: https://bb-markenagentur.de/",
    )
    payload = {
        "recall_queries": ["previous SEO work"],
        "connector_calls": [],
        "web_query": None,
        "seo_audit_url": None,
        "seo_audit_scope": "site",
        "seo_task": "remediate",
        "places_query": None,
        "needs_debate": False,
        "method_skills": [],
        "campaign_method_assignments": [],
        "turn_mode": "task",
        "collaboration_intensity": "standard",
        "response_depth": "focused",
        "evidence_mode": "standard",
        "post_output_actions": [],
        "campaign_request": None,
    }

    async def plan_call(*_args, **_kwargs):
        return {"content": json.dumps(payload)}

    monkeypatch.setattr(director, "_groq", plan_call)
    plan = asyncio.run(director._plan_gather())

    assert plan["collaboration_intensity"] == "standard"
    assert plan["response_depth"] == "focused"
    assert plan["seo_audit_url"] == "https://bb-markenagentur.de/"
    assert plan["seo_audit_page_limit"] == 25
    assert plan["recall_queries"] == ["previous SEO work"]
    assert plan["needs_debate"] is False


def test_light_collaboration_is_visible_without_persona_calls():
    director, events = _director(message="Can you give me a quick answer?")

    asyncio.run(director._emit_light_collaboration({
        "turn_mode": "task",
        "recall_queries": [],
        "connector_calls": [],
        "web_query": None,
        "seo_audit_url": None,
    }))

    contributions = [event for event in events if event.get("t") == "react"]
    assert len(contributions) == 3
    assert all(event.get("activity_only") is True for event in contributions)


def test_outreach_work_order_gets_typed_method_when_director_selects_none(monkeypatch):
    director, _events = _director(message="Find qualified manufacturers", room_kind="outreach")
    director.work_order = {"kind": "outreach_growth"}
    payload = {
        "recall_queries": [], "connector_calls": [], "web_query": None,
        "seo_audit_url": None, "seo_audit_scope": "none", "seo_task": "none",
        "places_query": "manufacturing companies in Hannover", "needs_debate": False,
        "method_skills": [], "campaign_method_assignments": [], "work_orders": [],
        "turn_mode": "task", "collaboration_intensity": "standard",
        "response_depth": "focused", "evidence_mode": "prospecting",
        "post_output_actions": [], "campaign_request": None,
    }

    async def plan_call(*_args, **_kwargs):
        return {"content": json.dumps(payload)}

    monkeypatch.setattr(director, "_groq", plan_call)
    plan = asyncio.run(director._plan_gather())
    assert plan["method_skills"] == ["prospect-qualification"]


def test_outreach_director_preserves_full_compound_lifecycle(monkeypatch):
    director, _events = _director(
        message="Find me 10 clients and send them emails about TARA",
        room_kind="outreach",
        enabled_connectors=["gmail"],
    )
    payload = {
        "recall_queries": ["TARA offer and target buyers"],
        "connector_calls": [], "web_query": None,
        "seo_audit_url": None, "seo_audit_scope": "none", "seo_task": "none",
        "places_query": "regulated companies in Berlin", "needs_debate": False,
        "method_skills": ["prospect-qualification", "cold-email-sequence"],
        "campaign_method_assignments": [], "work_orders": [],
        "turn_mode": "task", "collaboration_intensity": "deep",
        "response_depth": "operating", "evidence_mode": "prospecting",
        "post_output_actions": [{
            "capability": "gmail.send_email", "explicit": True, "target_hint": None,
        }],
        "outreach_request": {
            "requested_count": 10, "geography": "Berlin", "sector": "regulated enterprises",
            "audience": "operations leaders", "offer": "TARA", "discover": True,
            "persist": True, "draft": True, "deliver": True, "monitor": True,
        },
        "campaign_request": None,
    }

    async def plan_call(*_args, **_kwargs):
        return {"content": json.dumps(payload)}

    monkeypatch.setattr(director, "_groq", plan_call)
    plan = asyncio.run(director._plan_gather())

    assert plan["outreach_request"] == payload["outreach_request"]
    assert plan["post_output_actions"][0]["capability"] == "gmail.send_email"


def test_runtime_outreach_keeps_room_selected_lifecycle_and_action(monkeypatch):
    monkeypatch.setenv("GOOGLE_MAPS_API_KEY", "test-key")
    director, _events = _director(
        message="Find relevant companies nearby and prepare personalized outreach",
        room_kind="outreach",
        enabled_connectors=["gmail"],
    )
    director.work_order = {
        "contract": "hq-work-order.v2", "work_order_id": "wo-1",
        "objective": "Build a source-backed local pipeline and prepare outreach.",
    }
    payload = {
        "recall_queries": ["existing qualified leads"],
        "connector_calls": [], "web_query": None,
        "seo_audit_url": None, "seo_audit_scope": "none", "seo_task": "none",
        "places_query": "regulated companies in Hannover", "needs_debate": True,
        "method_skills": ["prospect-qualification", "cold-email-sequence"],
        "campaign_method_assignments": [],
        "work_orders": [{
            "kind": "research", "owner_lane": "Researcher",
            "title": "Build and prepare the local pipeline",
            "objective": "Discover, persist, and prepare personalized outreach.",
            "required_evidence": ["company context", "provider evidence"],
            "acceptance_criteria": ["Return durable records and prepared actions"],
        }],
        "turn_mode": "task", "collaboration_intensity": "deep",
        "response_depth": "operating", "evidence_mode": "prospecting",
        "post_output_actions": [{
            "capability": "gmail.create_draft", "explicit": True, "target_hint": None,
        }],
        "outreach_request": {
            "requested_count": None, "geography": "Hannover", "sector": None,
            "audience": "regulated companies", "offer": None, "discover": True,
            "persist": True, "draft": True, "deliver": False, "monitor": False,
        },
        "campaign_request": None,
    }

    async def plan_call(*_args, **_kwargs):
        return {"content": json.dumps(payload)}

    monkeypatch.setattr(director, "_groq", plan_call)
    plan = asyncio.run(director._plan_gather())

    assert plan["outreach_request"] == payload["outreach_request"]
    assert plan["post_output_actions"][0]["capability"] == "gmail.create_draft"
    assert plan["places_query"] == "regulated companies in Hannover"
    assert plan["needs_debate"] is False
    assert plan["collaboration_intensity"] == "standard"
    assert len(plan["work_orders"]) == 1


def test_runtime_outreach_uses_same_run_records_for_one_batch_of_drafts(monkeypatch):
    director, _events = _director(
        message="Find relevant local companies and prepare personalized drafts",
        room_kind="outreach",
    )
    director.work_order = {
        "contract": "hq-work-order.v2", "work_order_id": "wo-2",
        "objective": "Build and prepare a local outreach batch.",
        "completion_requirements": [
            {"type": "records_persisted", "minimum": 2},
            {"type": "email_drafts", "minimum": 2},
        ],
    }
    director.post_output_actions = [{
        "capability": "gmail.create_draft", "operation": "draft_email",
        "connected": True,
    }]
    model_calls = []
    records = [{
        "company": "Alpha GmbH", "email": "hello@alpha.example",
        "source_url": "https://alpha.example", "fit_reason": "Strong fit",
        "outreach_angle": "Relevant workflow",
    }, {
        "company": "Beta GmbH", "email": "hello@beta.example",
        "source_url": "https://beta.example", "fit_reason": "Strong fit",
        "outreach_angle": "Different workflow",
    }]

    async def execute(name, _args):
        director._exec_counts[name] += 1
        return json.dumps({"prospects": records, "persisted": 2})

    async def model(*args, **_kwargs):
        model_calls.append(args)
        return {"content": json.dumps({"email_drafts": [{
            "prospect_company": record["company"], "to": record["email"],
            "subject": f"A note for {record['company']}",
            "body": "A grounded and personalized message. Open to a short conversation?",
            "rationale": record["outreach_angle"],
        } for record in records]})}

    monkeypatch.setattr(director, "_exec", execute)
    monkeypatch.setattr(director, "_groq", model)
    plan = {
        "recall_queries": [], "connector_calls": [], "web_query": None,
        "seo_audit_url": None, "places_query": "companies in Hannover",
        "method_skills": ["prospect-qualification", "cold-email-sequence"],
        "post_output_actions": director.post_output_actions,
        "outreach_request": {
            "requested_count": 2, "discover": True, "persist": True,
            "draft": True, "deliver": False, "monitor": False,
        },
        "work_orders": [{
            "kind": "research", "owner_lane": "Researcher", "title": "Build batch",
            "objective": "Discover, persist, and draft.", "required_evidence": [],
            "acceptance_criteria": [],
        }],
    }

    results = asyncio.run(director._run_work_order_subtasks(plan))

    assert len(model_calls) == 1
    assert results[0]["status"] == "completed"
    artifacts = results[0]["output"]["artifacts"]
    assert [artifact["kind"] for artifact in artifacts] == ["prospect_records", "email_drafts"]
    assert artifacts[1]["record_count"] == 2


def test_work_brief_is_short_natural_language_and_mentions_the_report():
    director, events = _director(message="Build a market-entry strategy")
    director.response_depth = "operating"

    asyncio.run(director._emit_work_brief({
        "turn_mode": "task",
        "recall_queries": ["company positioning"],
        "connector_calls": [],
        "web_query": "market evidence",
        "seo_audit_url": None,
        "places_query": None,
        "needs_debate": True,
    }))

    brief = next(event for event in events if event.get("t") == "work_brief")
    assert brief["agent"] == "lead"
    assert brief["report_expected"] is True
    assert "Researcher and Builder" in brief["content"]
    assert "polished report" in brief["content"]
    assert "done criterion" not in brief["content"].lower()


def test_prospect_qualification_uses_only_places_evidence(monkeypatch):
    director, _events = _director(
        message="Find accounting firms in Hannover",
        company_brief="Acme offers workflow software.",
    )

    async def model_must_not_run(*_args, **_kwargs):
        raise AssertionError("prospect qualification must not invent facts with an LLM")

    monkeypatch.setattr(director, "_groq", model_must_not_run)
    rows = [{
        "company": "Example GmbH",
        "category": "Accounting firm",
        "address": "Hannover, Germany",
        "rating": 4.8,
        "review_count": 42,
        "website": "https://example.test",
        "email": "",
        "phone": "",
    }]

    asyncio.run(director._qualify_prospect_rows(rows, "accounting firms in Hannover"))

    assert "Google Places classifies Example GmbH" in rows[0]["fit_reason"]
    assert "4.8/5" in rows[0]["distinctive_signal"]
    assert "verified Accounting firm presence" in rows[0]["outreach_angle"]
    assert "validate the need" in rows[0]["outreach_angle"]


def test_chat_turn_is_marked_conversational_and_never_becomes_a_report(monkeypatch):
    director, events = _director(message="hello")

    async def chat_call(*_args, **_kwargs):
        return {"content": "Hi! We’re ready when you are."}

    monkeypatch.setattr(director, "_groq", chat_call)
    result = asyncio.run(director._chat_turn(0))

    assert result["turn_mode"] == "chat"
    reply = next(event for event in events if event.get("kind") == "synthesis")
    assert reply["conversational"] is True
    assert not any(event.get("t") in {"plan", "final_report"} for event in events)


def test_deep_intensity_guarantees_visible_debate(monkeypatch):
    director, _events = _director(message="Launch a 14-day multichannel campaign in France")
    payload = {
        "recall_queries": [], "connector_calls": [], "web_query": None,
        "seo_audit_url": None, "seo_audit_scope": "none", "places_query": None,
        "seo_task": "none",
        "needs_debate": False, "method_skills": [], "campaign_method_assignments": [],
        "turn_mode": "task", "collaboration_intensity": "deep",
        "response_depth": "operating", "evidence_mode": "standard",
        "post_output_actions": [],
        "campaign_request": None,
    }

    async def plan_call(*_args, **_kwargs):
        return {"content": json.dumps(payload)}

    monkeypatch.setattr(director, "_groq", plan_call)
    plan = asyncio.run(director._plan_gather())

    assert plan["collaboration_intensity"] == "deep"
    assert plan["needs_debate"] is True


def test_director_keeps_explicit_post_output_action_independent_of_connection(monkeypatch):
    director, _events = _director(message="Can you write a mail to my founder with all details?")
    payload = {
        "recall_queries": [], "connector_calls": [], "web_query": None,
        "seo_audit_url": None, "seo_audit_scope": "none", "seo_task": "none",
        "places_query": None, "needs_debate": False, "method_skills": ["polished-email"],
        "campaign_method_assignments": [], "turn_mode": "task",
        "collaboration_intensity": "light", "response_depth": "direct",
        "evidence_mode": "standard",
        "post_output_actions": [{
            "capability": "gmail.create_draft", "explicit": True,
            "target_hint": "my founder",
        }],
        "campaign_request": None,
    }

    async def plan_call(*_args, **_kwargs):
        return {"content": json.dumps(payload)}

    monkeypatch.setattr(director, "_groq", plan_call)
    plan = asyncio.run(director._plan_gather())

    assert plan["post_output_actions"] == [{
        "capability": "gmail.create_draft",
        "connector": "gmail",
        "operation": "draft_email",
        "artifact_kind": "email",
        "target_hint": "my founder",
        "explicit": True,
        "connected": False,
    }]


def test_director_normalizes_bounded_work_orders(monkeypatch):
    director, _events = _director(message="Build a market-entry strategy")
    payload = {
        "recall_queries": [], "connector_calls": [], "web_query": None,
        "seo_audit_url": None, "seo_audit_scope": "none", "seo_task": "none",
        "places_query": None, "needs_debate": True, "method_skills": [],
        "campaign_method_assignments": [], "turn_mode": "task",
        "collaboration_intensity": "standard", "response_depth": "focused",
        "evidence_mode": "standard", "post_output_actions": [], "campaign_request": None,
        "work_orders": [
            {"kind": "research", "owner_lane": "Researcher", "title": "Map demand",
             "objective": "Identify evidenced demand signals.", "required_evidence": ["company"],
             "acceptance_criteria": ["Three grounded signals"]},
            {"kind": "decision", "owner_lane": "Strategist", "title": "Choose wedge",
             "objective": "Recommend the strongest entry wedge.", "required_evidence": ["demand"],
             "acceptance_criteria": ["One explicit trade-off"]},
            {"kind": "creative", "owner_lane": "Builder", "title": "Draft launch", "objective": "Draft copy",
             "required_evidence": [], "acceptance_criteria": ["Ready copy"]},
            {"kind": "analysis", "owner_lane": "Builder", "title": "Must trim", "objective": "Overflow",
             "required_evidence": [], "acceptance_criteria": []},
        ],
    }

    async def plan_call(*_args, **_kwargs):
        return {"content": json.dumps(payload)}

    monkeypatch.setattr(director, "_groq", plan_call)
    plan = asyncio.run(director._plan_gather())

    assert len(plan["work_orders"]) == 3
    assert plan["work_orders"][0]["owner_lane"] == "Researcher"
    assert director._work_order_owner("Researcher")["slug"] == "researcher"


def test_work_orders_execute_as_independent_agent_results(monkeypatch):
    director, events = _director(message="Create a positioning recommendation")
    director.blackboard = ["COMPANY: Acme provides compliance software."]

    async def create(**_kwargs):
        return None  # local runtime must also work before the SQL migration is applied

    async def start(*_args, **_kwargs):
        return False

    async def complete(**_kwargs):
        return False

    async def worker_call(*_args, **kwargs):
        assert kwargs["max_tokens"] == 220
        return {"content": (
            "Recommendation: lead with the compliance workflow. Evidence: company context.\n\n"
            "This deliberately long second paragraph must stay on the evidence board and out of the visible "
            "worker chat bubble so the Room remains readable for the user."
        )}

    monkeypatch.setattr("hivemind_employees.hyper.engine.create_hyper_work_order", create)
    monkeypatch.setattr("hivemind_employees.hyper.engine.start_hyper_work_order", start)
    monkeypatch.setattr("hivemind_employees.hyper.engine.complete_hyper_work_order", complete)
    monkeypatch.setattr(director, "_groq", worker_call)

    results = asyncio.run(director._run_work_orders({"work_orders": [{
        "kind": "analysis", "owner_lane": "Strategist", "title": "Choose positioning",
        "objective": "Recommend one credible wedge.", "required_evidence": ["company"],
        "acceptance_criteria": ["One recommendation"],
    }]}))

    assert results[0]["status"] == "completed"
    assert results[0]["owner_slug"] == "lead"
    assert any("WORK_RESULT[Lead | Choose positioning]" in item for item in director.blackboard)
    assert any(event.get("t") == "work_order" and event.get("status") == "completed" for event in events)
    worker_react = next(event for event in events if event.get("t") == "react")
    assert worker_react["content"].startswith("Completed Choose positioning:")
    assert len(worker_react["content"]) <= 180
    assert "second paragraph" not in worker_react["content"]


def test_post_output_action_uses_global_connected_toolkit(monkeypatch):
    director, _events = _director(
        message="Draft this in Gmail", enabled_connectors=["gmail"],
    )
    payload = {
        "recall_queries": [], "connector_calls": [], "web_query": None,
        "seo_audit_url": None, "seo_audit_scope": "none", "seo_task": "none",
        "places_query": None, "needs_debate": False, "method_skills": ["polished-email"],
        "campaign_method_assignments": [], "turn_mode": "task",
        "collaboration_intensity": "light", "response_depth": "direct",
        "evidence_mode": "standard",
        "post_output_actions": [{
            "capability": "gmail.create_draft", "explicit": True, "target_hint": None,
        }],
        "campaign_request": None,
    }

    async def plan_call(*_args, **_kwargs):
        return {"content": json.dumps(payload)}

    monkeypatch.setattr(director, "_groq", plan_call)
    plan = asyncio.run(director._plan_gather())

    assert plan["post_output_actions"][0]["connected"] is True
    assert plan["post_output_actions"][0]["artifact_kind"] == "email"


def test_director_rejects_non_explicit_connector_action(monkeypatch):
    director, _events = _director(message="What makes a good founder email?")
    payload = {
        "recall_queries": [], "connector_calls": [], "web_query": None,
        "seo_audit_url": None, "seo_audit_scope": "none", "seo_task": "none",
        "places_query": None, "needs_debate": False, "method_skills": [],
        "campaign_method_assignments": [], "turn_mode": "task",
        "collaboration_intensity": "light", "response_depth": "direct",
        "evidence_mode": "standard",
        "post_output_actions": [{
            "capability": "gmail.create_draft", "explicit": False,
            "target_hint": None,
        }],
        "campaign_request": None,
    }

    async def plan_call(*_args, **_kwargs):
        return {"content": json.dumps(payload)}

    monkeypatch.setattr(director, "_groq", plan_call)
    plan = asyncio.run(director._plan_gather())

    assert plan["post_output_actions"] == []


def test_runtime_emits_resumable_connection_event_but_keeps_final_output(monkeypatch):
    director, events = _director(message="Write a mail to my founder with all details")
    action = {
        "capability": "gmail.create_draft", "connector": "gmail",
        "operation": "draft_email", "artifact_kind": "email",
        "target_hint": "my founder", "explicit": True, "connected": False,
    }
    plan = {
        "recall_queries": [], "connector_calls": [], "web_query": None,
        "seo_audit_url": None, "seo_audit_page_limit": 0, "seo_task": "none",
        "places_query": None, "needs_debate": False, "method_skills": [],
        "campaign_method_assignments": [], "turn_mode": "task",
        "collaboration_intensity": "light", "response_depth": "direct",
        "evidence_mode": "standard", "post_output_actions": [action],
        "campaign_request": None,
    }

    async def no_op(*_args, **_kwargs):
        return None

    async def gather(*_args, **_kwargs):
        return 0

    async def synth(*_args, **_kwargs):
        return "Subject: Founder update\n\nHere are the details."

    monkeypatch.setattr(director, "_init_connector_tools", no_op)
    monkeypatch.setattr(director, "_plan_gather", lambda: asyncio.sleep(0, result=plan))
    monkeypatch.setattr(director, "_run_gather", gather)
    monkeypatch.setattr(director, "_synthesize", synth)

    result = asyncio.run(director.run())

    request = next(event for event in events if event.get("t") == "connection_required")
    assert request["connector"] == "gmail"
    assert request["resume_on_connect"] is True
    assert result["final_text"].startswith("Subject:")
    assert result["intended_output"] == "email"


def test_remediation_report_does_not_claim_unmeasured_or_applied_fixes():
    report = render_remediation_report({
        "seed_url": "https://singulancelabs.com/",
        "capability": {"artifact_id": "artifact-1"},
        "coverage": {"pages_scanned": 24},
        "severity": {"critical": 0, "high": 0, "medium": 1, "low": 2},
        "findings": [{
            "id": "title-length", "severity": "medium", "title": "Title length",
            "template": "/research/:slug", "instances": 3,
            "evidence": {"title_length": 79}, "recommendation": "Shorten the measured titles.",
        }],
    })

    assert "0 critical" in report
    assert "0 high" in report
    assert "Title length" in report
    assert "No website change was claimed" in report
    assert "30%" not in report
