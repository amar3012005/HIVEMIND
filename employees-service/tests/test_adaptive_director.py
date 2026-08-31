import asyncio
import inspect
import json

from hivemind_employees.hyper.engine import Director, _work_order_activity, run_director
from hivemind_employees.hyper.domains.seo.reporting import render_remediation_report


def _director(*, message: str, room_kind: str = "general", company_brief: str = "",
              enabled_connectors=None, execution_profile=None):
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
        execution_profile=execution_profile,
    )
    return director, events


def test_run_director_forwards_execution_profile(monkeypatch):
    captured = {}

    class FakeDirector:
        def __init__(self, **kwargs):
            captured.update(kwargs)

        async def run(self):
            return {"status": "complete"}

    monkeypatch.setattr("hivemind_employees.hyper.engine.Director", FakeDirector)

    profile = {
        "contract": "execution-profile.v1",
        "profile_id": "fundraising.presentation.v1",
        "allowed_outputs": ["artifact"],
    }

    async def emit(_event):
        return None

    result = asyncio.run(run_director(
        user_message="Create a Series A pitch deck",
        user_id="user-1",
        org_id="org-1",
        project_id=None,
        participants=[],
        room_template="auto",
        room_goal=None,
        enabled_connectors=[],
        emit=emit,
        execution_profile=profile,
    ))

    assert result == {"status": "complete"}
    assert captured["execution_profile"] == profile


def test_artifact_only_profile_cannot_silently_degrade_to_text(monkeypatch):
    monkeypatch.setenv("Visual_path_In_Hyperrooms", "true")
    director, _events = _director(
        message="Create the requested experience deliverable",
        room_kind="design",
        execution_profile={
            "contract": "execution-profile.v1",
            "profile_id": "design.artifact.v1",
            "allowed_outputs": ["artifact"],
            "required_artifacts": ["design_artifact"],
        },
    )
    payload = {
        "recall_queries": [], "history_turns_back": 0, "connector_calls": [],
        "web_query": None, "seo_audit_url": None, "seo_audit_scope": "none",
        "seo_task": "none", "places_query": None, "needs_debate": False,
        "method_skills": [], "campaign_method_assignments": [], "work_orders": [],
        "turn_plan": [], "turn_mode": "task", "execution_engine": "debate",
        "collaboration_intensity": "standard", "response_depth": "focused",
        "evidence_mode": "standard", "post_output_actions": [],
        "outreach_request": None, "campaign_request": None, "artifact_intent": None,
    }

    async def plan_call(*_args, **_kwargs):
        return {"content": json.dumps(payload)}

    monkeypatch.setattr(director, "_groq", plan_call)
    plan = asyncio.run(director._plan_gather())

    assert director.artifact_intent is not None
    assert director.artifact_intent["kind"] == "interactive_document"
    assert plan["artifact_intent"] == director.artifact_intent
    assert plan["execution_engine"] == "debate"


def test_source_evidence_excludes_skills_and_agent_work_results():
    director, _events = _director(
        message="Compare two options",
        company_brief="Singulance Labs provides HIVEMIND and TARA.",
    )
    director.blackboard = [
        "COMPANY CONTEXT[authoritative]: verified company fact",
        "- Retained metric: 12 observed users",
        "SKILL[evidence-first]: method guidance",
        "WORK_RESULT[Analyst | compare]: invented 38 percent conversion",
        "- gmail/thread: verified connector text",
        "- gmail: NOT AUTHORIZED — reconnect required",
    ]

    evidence = director._source_evidence_snapshot()

    assert any("verified company fact" in row for row in evidence)
    assert any("provides HIVEMIND and TARA" in row for row in evidence)
    assert any("12 observed users" in row for row in evidence)
    assert any("verified connector text" in row for row in evidence)
    assert not any("SKILL[" in row for row in evidence)
    assert not any("WORK_RESULT[" in row for row in evidence)
    assert not any("NOT AUTHORIZED" in row for row in evidence)


def test_synthesis_context_keeps_agent_claims_out_of_source_evidence():
    director, _events = _director(
        message="Compare two options",
        company_brief="Singulance Labs provides HIVEMIND and TARA.",
    )
    director.blackboard = [
        "RECALL[company]: GDPR-native operating layer",
        "SKILL[evidence-first]: compare source lineage",
        "WORK_RESULT[Analyst | compare]: prior pilot converted 38 percent",
    ]

    context = director._synthesis_context(8000)
    source, remainder = context.split("METHOD GUIDANCE", 1)

    assert "GDPR-native operating layer" in source
    assert "provides HIVEMIND and TARA" in source
    assert "38 percent" not in source
    assert "38 percent" not in remainder
    assert "instructions only; never evidence" in context
    assert "candidate prose is intentionally omitted" in context


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

    async def compose(record, _sender_company):
        model_calls.append(record["company"])
        return {
            "subject": f"A note for {record['company']}",
            "body": "A grounded and personalized message. Open to a short conversation?",
        }

    monkeypatch.setattr(director, "_exec", execute)
    monkeypatch.setattr(director, "_compose_outreach_email", compose)
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

    assert model_calls == ["Alpha GmbH", "Beta GmbH"]
    assert results[0]["status"] == "completed", results[0]
    artifacts = results[0]["output"]["artifacts"]
    assert [artifact["kind"] for artifact in artifacts] == ["prospect_records", "email_drafts"]
    assert artifacts[1]["record_count"] == 2


def test_runtime_outreach_persists_upstream_records_before_accepting_drafts(monkeypatch):
    director, events = _director(
        message="Reuse the accepted batch and prepare personalized drafts",
        room_kind="outreach",
    )
    records = [{
        "company": "Alpha GmbH", "email": "hello@alpha.example",
        "source_url": "https://alpha.example/evidence", "fit_reason": "Strong fit",
        "outreach_angle": "Relevant workflow",
    }, {
        "company": "Beta GmbH", "email": "hello@beta.example",
        "source_url": "https://beta.example/evidence", "fit_reason": "Strong fit",
        "outreach_angle": "Different workflow",
    }]
    director.work_order = {
        "contract": "hq-work-order.v2", "work_order_id": "wo-upstream",
        "objective": "Persist the accepted batch and prepare outreach.",
        "upstream_result": {"deliverables": [{
            "kind": "prospect_records", "record_count": 2, "records": records,
        }]},
        "completion_requirements": [
            {"type": "records_persisted", "minimum": 2},
            {"type": "source_evidence", "minimum": 2},
            {"type": "distinct_fields", "minimum": 2},
            {"type": "email_drafts", "minimum": 2},
        ],
    }

    async def persist(*, prospects, **_kwargs):
        assert [row["company"] for row in prospects] == ["Alpha GmbH", "Beta GmbH"]
        return {"persisted": 2, "records": [
            {"company": row["company"], "memory_id": f"memory-{index}"}
            for index, row in enumerate(prospects, start=1)
        ]}

    async def compose(record, _sender_company):
        return {
            "subject": f"A note for {record['company']}",
            "body": "A grounded message. Open to a short conversation?",
        }

    monkeypatch.setattr("hivemind_employees.hyper.engine.save_prospects_bulk_emulated", persist)
    monkeypatch.setattr(director, "_compose_outreach_email", compose)
    plan = {
        "recall_queries": [], "connector_calls": [], "web_query": None,
        "seo_audit_url": None, "places_query": None,
        "method_skills": ["cold-email-sequence"], "post_output_actions": [],
        "outreach_request": {
            "requested_count": 2, "discover": False, "persist": True,
            "draft": True, "deliver": False, "monitor": False,
        },
        "work_orders": [{
            "kind": "outreach", "owner_lane": "Builder", "title": "Prepare batch",
            "objective": "Persist and draft.", "required_evidence": [],
            "acceptance_criteria": [],
        }],
    }

    results = asyncio.run(director._run_work_order_subtasks(plan))

    assert not [check for check in results[0]["checks"] if not check["passed"]]
    assert results[0]["status"] == "completed", results[0]
    prospects, drafts = results[0]["output"]["artifacts"]
    assert prospects["persisted_count"] == 2
    assert all(row.get("memory_id") for row in prospects["records"])
    assert drafts["record_count"] == 2
    assert any(event.get("tool") == "leads_persist" for event in events)


def test_runtime_formatter_cannot_invent_input_after_machine_checks_pass(monkeypatch):
    director, _events = _director(message="Prepare the accepted artifacts", room_kind="outreach")
    director.work_order = {
        "contract": "hq-work-order.v2", "work_order_id": "wo-complete",
        "objective": "Prepare artifacts only.", "acceptance_criteria": [],
        "completion_requirements": [],
    }
    director.work_results = [{
        "id": "subtask_1", "title": "Prepare accepted artifacts", "status": "completed",
        "checks": [{
            "criterion": "machine:deliverables", "type": "deliverables",
            "observed": "count=1", "passed": True,
        }],
        "output": {"kind": "rows", "text": "Prepared.", "artifacts": [{
            "kind": "prepared_records", "source": "room_worker",
            "record_count": 1, "records": [{"id": "record-1"}],
        }]},
        "evidence_refs": ["source:record-1"], "gaps": [],
    }]

    async def formatter(*_args, **_kwargs):
        return {"content": json.dumps({
            "report_markdown": "Prepared.",
            "deliverables": [],
            "needs_input": [{"item": "Approval from a Room employee"}],
            "blockers": [{"description": "Wait for approval"}],
            "checkpoint": {
                "stage": "prepared", "completed": True, "next": "await approval",
                "disposition": "request_hq", "reason": "Approval needed",
                "requires": "approval_from_owner",
            },
        })}

    monkeypatch.setattr(director, "_groq", formatter)
    result = asyncio.run(director._synthesize_work_order_result())

    assert result["status"] == "completed"
    assert result["needs_input"] == []
    assert result["blockers"] == []
    assert result["checkpoint"]["disposition"] == "complete"
    assert result["checkpoint"]["completed"] == ["Prepare accepted artifacts"]


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
            "This deliberately long second paragraph must remain visible in the worker chat bubble so the "
            "user can inspect the complete bounded contribution."
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
    assert "deliberately long second paragraph" in worker_react["content"]
    assert "complete bounded contribution" in worker_react["content"]


def test_synthesis_context_keeps_verified_receipts_but_excludes_worker_prose():
    director, _events = _director(message="Compare current public prices")
    director.blackboard = [
        "WORK_RESULT[Lena | Research]: unsupported candidate prose",
        "WEB: older search context",
    ]
    director.work_results = [{
        "status": "completed",
        "text": "agent interpretation must not become evidence",
        "evidence": [{
            "adapter": "cloudflare_browser",
            "provider_id": "browser-receipt-1",
            "url": "https://example.com/pricing",
            "title": "Current pricing",
            "excerpt": "Model A — $999",
        }],
    }]

    context = director._synthesis_context(8000)

    assert "VERIFIED PROVIDER RECEIPT" in context
    assert "browser-receipt-1" in context
    assert "Model A — $999" in context
    assert "unsupported candidate prose" not in context
    assert "agent interpretation must not become evidence" not in context


def test_synthesis_context_prefers_latest_receipt_per_url_and_keeps_all_sources():
    director, _events = _director(message="Compare three competitor prices")
    director.work_results = [
        {"status": "completed", "evidence": [{
            "adapter": "cloudflare_browser", "provider_id": "old",
            "url": "https://one.example/pricing", "excerpt": "old blocked page",
        }]},
        {"status": "completed", "evidence": [
            {"adapter": "cloudflare_browser", "provider_id": "new",
             "url": "https://one.example/pricing", "excerpt": "One — $100"},
            {"adapter": "cloudflare_browser", "provider_id": "two",
             "url": "https://two.example/pricing", "excerpt": "Two — $200"},
            {"adapter": "cloudflare_browser", "provider_id": "three",
             "url": "https://three.example/pricing", "excerpt": "Three — $300"},
        ]},
    ]

    context = director._synthesis_context(100)

    assert "old blocked page" not in context
    assert "One — $100" in context
    assert "Two — $200" in context
    assert "Three — $300" in context


def test_work_room_turn_plan_runs_dependencies_before_dependent_steps(monkeypatch):
    director, _events = _director(message="Assess our product direction")
    director.room_mode = "work"
    director.is_work_room = True
    director.blackboard = ["COMPANY: Acme provides compliance software."]
    calls = []

    async def create(**kwargs):
        calls.append(("create", kwargs["plan_step_id"], kwargs["depends_on"]))
        return None

    async def start(*_args, **_kwargs):
        return False

    async def complete(**_kwargs):
        return False

    async def worker_call(messages, **_kwargs):
        calls.append(("worker", messages[-1]["content"]))
        return {"content": "Recommendation: validate the compliance wedge. Evidence: company context."}

    monkeypatch.setattr("hivemind_employees.hyper.engine.create_hyper_work_order", create)
    monkeypatch.setattr("hivemind_employees.hyper.engine.start_hyper_work_order", start)
    monkeypatch.setattr("hivemind_employees.hyper.engine.complete_hyper_work_order", complete)
    monkeypatch.setattr(director, "_groq", worker_call)

    results = asyncio.run(director._run_work_orders({"turn_plan": [
        {"id": "evidence", "depends_on": [], "kind": "research", "owner_lane": "Researcher",
         "title": "Inspect evidence", "objective": "Identify the strongest customer signal.",
         "required_evidence": ["company"], "acceptance_criteria": ["One grounded signal"]},
        {"id": "decision", "depends_on": ["evidence"], "kind": "decision", "owner_lane": "Strategist",
         "title": "Choose validation", "objective": "Recommend the next product validation.",
         "required_evidence": ["signal"], "acceptance_criteria": ["One explicit decision"]},
    ]}))

    assert [result["step_id"] for result in results] == ["evidence", "decision"]
    assert [(entry[0], entry[1], entry[2]) for entry in calls if entry[0] == "create"] == [
        ("create", "evidence", []), ("create", "decision", ["evidence"]),
    ]
    worker_inputs = [entry[1] for entry in calls if entry[0] == "worker"]
    assert "COMPLETED PREREQUISITES" not in worker_inputs[0]
    assert "COMPLETED PREREQUISITES" in worker_inputs[1]


def test_reviewer_rejection_runs_bounded_repair_and_fresh_review(monkeypatch):
    director, events = _director(message=(
        "Research three current public competitor pricing pages using the browser, "
        "capture evidence, compare them, and produce a reviewed artifact."
    ))
    director.room_mode = "work"
    director.is_work_room = True
    director.grok_runtime_mode = "full"
    director.grok_runtime_version = "v1"
    calls = []

    async def create(**kwargs):
        return {"id": f"00000000-0000-0000-0000-{len(calls) + 1:012d}"}

    async def start(*_args, **_kwargs):
        return True

    async def complete(**_kwargs):
        return True

    async def agent_hook(_owner, order, _prompt):
        calls.append(order["id"])
        if order["id"] == "independent-review":
            return {"text": "Google is consent-gated and lacks a captured price.\nVERDICT: REPAIR"}
        if order["id"] == "independent-review-repair-1":
            return {"text": "All three pages, prices, URLs, comparison and artifact are supported.\nVERDICT: PASS"}
        return {
            "text": "Captured current public pricing with exact URLs and prepared comparison inputs.",
            "evidence": [{
                "adapter": "cloudflare_browser", "provider_id": f"receipt-{order['id']}",
                "url": "https://example.com/pricing", "title": "Rendered pricing",
                "excerpt": "$999 current rendered price",
            }],
            "artifacts": [{"kind": "comparison", "id": f"artifact-{order['id']}"}],
        }

    monkeypatch.setenv("HYPER_GROK_MAX_REPAIRS", "1")
    monkeypatch.setattr("hivemind_employees.hyper.engine.create_hyper_work_order", create)
    monkeypatch.setattr("hivemind_employees.hyper.engine.start_hyper_work_order", start)
    monkeypatch.setattr("hivemind_employees.hyper.engine.complete_hyper_work_order", complete)
    director.work_agent_hook = agent_hook

    results = asyncio.run(director._run_work_orders({"turn_plan": [
        {"id": "execute-1", "depends_on": [], "kind": "research", "owner_lane": "Researcher",
         "title": "Capture pricing", "objective": "Capture three public pricing pages.",
         "required_evidence": ["browser receipts"], "acceptance_criteria": ["three prices"]},
        {"id": "independent-review", "depends_on": ["execute-1"], "kind": "decision",
         "owner_lane": "Skeptic", "title": "Review evidence", "objective": "Verify completion.",
         "required_evidence": [], "acceptance_criteria": ["complete artifact"],
         "verification_assignment": True},
    ]}))

    assert calls == [
        "execute-1", "independent-review", "repair-1", "independent-review-repair-1",
    ]
    assert all(result["status"] == "completed" for result in results)
    assert "independent-review" not in [result["step_id"] for result in results]
    assert "repair-1" in [result["step_id"] for result in results]
    assert any(event.get("title") == "Repair unmet completion checks (attempt 1)" for event in events)


def test_work_room_waits_without_starting_worker_and_preserves_handoff(monkeypatch):
    director, events = _director(message="Prepare the decision and wait for confirmation")
    director.room_mode = "work"
    director.is_work_room = True
    calls = []

    async def create(**kwargs):
        calls.append(("create", kwargs["wait_for"], kwargs["handoff"]))
        return {"id": "11111111-1111-1111-1111-111111111111", "status": "queued", "attempt": 0}

    async def pause(**kwargs):
        calls.append(("pause", kwargs["status"], kwargs["wait_for"], kwargs["handoff"]))
        return True

    async def should_not_run(*_args, **_kwargs):
        raise AssertionError("a waiting work step must not invoke a worker")

    monkeypatch.setattr("hivemind_employees.hyper.engine.create_hyper_work_order", create)
    monkeypatch.setattr("hivemind_employees.hyper.engine.pause_hyper_work_order", pause)
    monkeypatch.setattr(director, "_groq", should_not_run)

    results = asyncio.run(director._run_work_orders({"turn_plan": [{
        "id": "propose", "depends_on": [], "kind": "decision", "owner_lane": "Strategist",
        "title": "Propose next move", "objective": "Prepare the evidence-backed recommendation.",
        "required_evidence": ["company"], "acceptance_criteria": ["Clear recommendation"],
        "wait": {"kind": "approval", "reason": "A decision is required before work continues.",
                 "prompt": "Confirm the recommendation.", "resume_key": "recommendation-confirmed"},
        "handoff": {"owner": "runtime", "objective": "Consider the approved recommendation.",
                    "rationale": "The proposal affects the operating queue."},
    }]}))

    assert results[0]["status"] == "waiting_for_approval"
    assert results[0]["handoff"]["owner"] == "runtime"
    assert calls[0][0] == "create"
    assert calls[1][0:2] == ("pause", "waiting_for_approval")
    assert any(event.get("t") == "work_order" and event.get("status") == "waiting_for_approval" for event in events)


def test_work_room_resume_executes_existing_work_order_once(monkeypatch):
    director, events = _director(message="Continue the paused work step")
    director.room_mode = "work"
    director.is_work_room = True
    director.company_brief = "Acme provides compliance software."
    director.work_room_resume = {
        "contract": "work-room-resume.v1",
        "work_order_id": "11111111-1111-1111-1111-111111111111",
        "resume_key": "answer-received",
        "resolution": {"answer": "Target regulated operators first."},
        "step": {
            "id": "recommend", "depends_on": ["evidence"], "kind": "decision", "owner_lane": "Strategist",
            "title": "Choose next move", "objective": "Select the evidence-backed next move.",
            "required_evidence": ["company"], "acceptance_criteria": ["One explicit choice"],
        },
    }
    calls = []

    async def start(work_order_id, _org_id):
        calls.append(("start", work_order_id))
        return True

    async def complete(**kwargs):
        calls.append(("complete", kwargs["work_order_id"], kwargs["status"]))
        return True

    async def worker_call(*_args, **_kwargs):
        return {"content": "Recommendation: validate the regulated-operator segment first."}

    async def should_not_create(**_kwargs):
        raise AssertionError("a resumed step must retain its original work-order identity")

    monkeypatch.setattr("hivemind_employees.hyper.engine.create_hyper_work_order", should_not_create)
    monkeypatch.setattr("hivemind_employees.hyper.engine.start_hyper_work_order", start)
    monkeypatch.setattr("hivemind_employees.hyper.engine.complete_hyper_work_order", complete)
    monkeypatch.setattr(director, "_groq", worker_call)

    result = asyncio.run(director._run_resumed_work_step(0.0))

    assert result["work_results"][0]["id"] == "11111111-1111-1111-1111-111111111111"
    assert result["work_results"][0]["status"] == "completed"
    assert result["work_results"][0]["depends_on"] == []
    assert calls == [
        ("start", "11111111-1111-1111-1111-111111111111"),
        ("complete", "11111111-1111-1111-1111-111111111111", "completed"),
    ]
    assert any(event.get("resumed") is True for event in events)


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


def test_director_rejects_document_write_without_explicit_destination(monkeypatch):
    director, _events = _director(
        message="Build Regulated Enterprise Audience Persona",
        enabled_connectors=["gmail"],
    )
    payload = {
        "recall_queries": ["regulated enterprise audience"],
        "connector_calls": [], "web_query": None,
        "seo_audit_url": None, "seo_audit_scope": "none", "seo_task": "none",
        "places_query": None, "needs_debate": True, "method_skills": [],
        "campaign_method_assignments": [], "turn_mode": "task",
        "collaboration_intensity": "standard", "response_depth": "focused",
        "evidence_mode": "standard",
        "post_output_actions": [{
            "capability": "google_docs.create_document", "explicit": True,
            "target_hint": "Audience Persona",
        }],
        "campaign_request": None,
    }

    async def plan_call(*_args, **_kwargs):
        return {"content": json.dumps(payload)}

    monkeypatch.setattr(director, "_groq", plan_call)
    plan = asyncio.run(director._plan_gather())

    assert plan["post_output_actions"] == []


def test_director_preserves_explicit_google_docs_destination(monkeypatch):
    director, _events = _director(
        message="Create this audience persona in Google Docs",
        enabled_connectors=["google-docs"],
    )
    payload = {
        "recall_queries": [], "connector_calls": [], "web_query": None,
        "seo_audit_url": None, "seo_audit_scope": "none", "seo_task": "none",
        "places_query": None, "needs_debate": False, "method_skills": [],
        "campaign_method_assignments": [], "turn_mode": "task",
        "collaboration_intensity": "light", "response_depth": "direct",
        "evidence_mode": "standard",
        "post_output_actions": [{
            "capability": "google_docs.create_document", "explicit": True,
            "target_hint": "Google Docs",
        }],
        "campaign_request": None,
    }

    async def plan_call(*_args, **_kwargs):
        return {"content": json.dumps(payload)}

    monkeypatch.setattr(director, "_groq", plan_call)
    plan = asyncio.run(director._plan_gather())

    assert plan["post_output_actions"] == [{
        "capability": "google_docs.create_document",
        "connector": "google-docs",
        "operation": "create_document",
        "artifact_kind": "doc",
        "target_hint": "Google Docs",
        "explicit": True,
        "connected": True,
    }]


def test_gmail_connection_exposes_only_its_available_read_tools(monkeypatch):
    director, _events = _director(
        message="Summarize the latest reply",
        enabled_connectors=["gmail"],
    )

    asyncio.run(director._init_connector_tools())

    assert set(director._connector_routes) == {
        "gmail_search", "gmail_get", "gmail_get_thread",
    }
    assert "drive_search" not in director._connector_routes
    assert "docs_get" not in director._connector_routes


def test_worker_discussion_keeps_the_complete_bounded_note():
    note = (
        "Recommendation: prioritize compliance-led messaging. "
        "Evidence: the retained ICP names regulated CIOs and procurement leaders. "
        "Unresolved gap: LinkedIn role-level audience data was not observed."
    )

    activity = _work_order_activity("Develop the audience persona", note)

    assert activity == "Completed Develop the audience persona: " + note
    assert "..." not in activity


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


def test_durable_repair_executor_is_domain_neutral():
    source = inspect.getsource(Director._run_work_orders).lower()
    forbidden_playbook_terms = (
        "competitor pricing",
        "pricing observations",
        "company named in room/company context",
        "credible accessible competitor",
    )

    assert all(term not in source for term in forbidden_playbook_terms)
    assert "resolve every exact unmet completion check" in source
    assert "original work-order acceptance criteria" in source
