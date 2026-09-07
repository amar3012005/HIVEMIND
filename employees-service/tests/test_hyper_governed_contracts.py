from hivemind_employees.hyper.governed_contracts import (
    build_debate_contract,
    build_prospecting_contract,
    build_task_skills,
    normalize_prospecting_request,
    select_research_route,
)
from hivemind_employees.api_hyper_rooms import _apply_outreach_contract
from hivemind_employees.hyper.engine import Director


def test_debate_contract_risk_routes_none_reviewer_roundtable(monkeypatch):
    monkeypatch.setenv("HYPER_EVIDENCE_ROUNDTABLE_MODE", "shadow")
    people = [
        {"id": "employee-1", "slug": "ravi", "name": "Ravi"},
        {"id": "employee-2", "slug": "marta", "name": "Marta"},
        {"id": "employee-3", "slug": "elena", "name": "Elena"},
        {"id": "employee-4", "slug": "jonas", "name": "Jonas"},
    ]
    direct = build_debate_contract(plan={"turn_mode": "chat"}, participants=people,
        user_message="Hello", room_kind="general", intended_output="answer")
    assert direct["mode"] == "none"
    maker = build_debate_contract(plan={"turn_mode": "task"}, participants=people,
        user_message="Write an email", room_kind="content", intended_output="email")
    assert maker["mode"] == "reviewer"
    panel = build_debate_contract(plan={"turn_mode": "task", "needs_debate": True}, participants=people,
        user_message="Choose between two strategies", room_kind="strategy", intended_output="answer")
    assert panel["mode"] == "roundtable"
    assert [p["role"] for p in panel["participants"]] == ["investigator", "domain_expert", "skeptic", "judge"]
    assert [p["agent_id"] for p in panel["participants"]] == ["ravi", "marta", "elena", "jonas"]
    assert all(p["employee_id"].startswith("employee-") for p in panel["participants"])
    assert all(p["model_profile"]["route"] == "cloudflare_ai_gateway_openrouter" for p in panel["participants"])


def test_room_policy_can_strengthen_but_not_weaken_debate():
    weak = build_debate_contract(plan={"turn_mode": "task"}, participants=[], user_message="Summarize",
        room_kind="general", intended_output="answer", room_instructions="require review")
    assert weak["mode"] == "reviewer"
    strong = build_debate_contract(plan={"turn_mode": "task", "needs_debate": True}, participants=[],
        user_message="Decide", room_kind="strategy", intended_output="answer",
        room_instructions="do not debate")
    assert strong["mode"] == "roundtable"


def test_standard_evidence_does_not_force_strategy_room_roundtable():
    contract = build_debate_contract(
        plan={"turn_mode": "task", "needs_debate": False, "evidence_mode": "standard"},
        participants=[{"id": "one", "slug": "one"}, {"id": "two", "slug": "two"}],
        user_message="What does our company do? Answer in three bullets.",
        room_kind="strategy", intended_output="answer",
    )
    assert contract["mode"] == "none"
    assert contract["participants"] == []


def test_roundtable_never_invents_unassigned_characters():
    contract = build_debate_contract(
        plan={"turn_mode": "task", "needs_debate": True},
        participants=[{"id": "one", "slug": "one"}, {"id": "two", "slug": "two"}],
        user_message="Decide", room_kind="strategy", intended_output="answer",
    )
    assert contract["participants"] == []
    assert contract["execution_blocked_reason"] == "at_least_three_assigned_digital_employees_required"


def test_prospecting_is_room_neutral_and_shadow_safe(monkeypatch):
    monkeypatch.setenv("HYPER_PROSPECT_WORKFLOW_MODE", "shadow")
    plan = {"outreach_request": {"requested_count": 12, "geography": "anywhere", "sector": "banks", "audience": "CISO", "offer": "private AI", "discover": True, "persist": True, "draft": True, "deliver": True, "call": False, "monitor": True}}
    contract = build_prospecting_contract(plan=plan, room_kind="strategy", room_mode="runtime", room_instructions="Only regulated institutions", known_urls=[], places_available=True, web_available=True, deep_research=False)
    assert contract["contract"] == "prospecting_contract.v1"
    assert contract["research_route"]["primary"] == "parallel_findall"
    assert contract["room_policy"]["room_kind"] == "strategy"
    assert contract["room_policy"]["external_effects_allowed"] is False
    assert contract["governance"]["approval_required"] is True
    assert contract["governance"]["shadow_side_effects"] is False


def test_known_entities_enrich_and_local_businesses_use_maps():
    known = normalize_prospecting_request({"known_entities": ["Acme"], "discover": True})
    assert select_research_route(prospecting=known, known_urls=[], deep_research=False, places_available=True, parallel_available=True, web_available=True)["primary"] == "parallel_enrichment"
    local = normalize_prospecting_request({"geography": "Berlin", "sector": "law firms", "discover": True})
    assert select_research_route(prospecting=local, known_urls=[], deep_research=False, places_available=True, parallel_available=True, web_available=True)["primary"] == "google_maps"


def test_known_urls_prefer_playwright_and_deep_research_prefers_parallel_task():
    assert select_research_route(prospecting=None, known_urls=["https://example.com/legal"], deep_research=True, places_available=True, parallel_available=True, web_available=True)["primary"] == "playwright_extract"
    assert select_research_route(prospecting=None, known_urls=[], deep_research=True, places_available=False, parallel_available=True, web_available=True)["primary"] == "parallel_task"


def test_task_and_output_skills_are_versioned():
    skills = build_task_skills({"method_skills": ["cold-email"], "outreach_request": {"discover": True, "draft": True}}, "presentation")
    assert {row["id"] for row in skills} >= {"cold.email", "prospect.discovery", "prospect.qualification", "investor.deck"}
    assert all(row["version"] == "1.0.0" for row in skills)


def test_single_room_email_draft_does_not_require_provider_delivery():
    verdict = {"met": True, "artifact_ok": True, "assignments_ok": True,
               "grounded_ok": True, "gaps": []}
    plan = {
        "outreach_request": {
            "requested_count": 10, "discover": False, "persist": False,
            "draft": True, "deliver": False, "monitor": False,
        },
        "outreach_metrics": {},
    }
    result = _apply_outreach_contract(verdict, plan, [], text_draft_ready=True)
    assert result["met"] is True
    assert result["artifact_ok"] is True
    assert result["artifact_kind"] == "room_text_draft"
    assert result["outreach_observed"]["draft"] == 1
    assert result["gaps"] == []


def test_named_recipient_email_does_not_expand_to_ten_prospects():
    request = normalize_prospecting_request({"draft": True, "deliver": True})
    assert request["requested_count"] == 1
    discovery = normalize_prospecting_request({"discover": True})
    assert discovery["requested_count"] == 10


def test_visual_brand_dna_is_a_bounded_skill_reference():
    director = Director.__new__(Director)
    director.brand_dna = {
        "available": True,
        "reference": {"run_id": "run-1", "version": "visual-intelligence-v1"},
        "identity": {"name": "Acme"},
        "palette": {"primary": "#123456"},
        "visual_generation_brief": {"style": "calm editorial"},
        "evidence_refs": [{"page_url": "https://example.com", "r2_key": "org/x/page.png"}],
    }
    block = director._brand_dna_prompt_block()
    assert "VERIFIED BRAND DNA SKILL REFERENCE" in block
    assert "#123456" in block
    assert "run-1" in block


def test_visual_brand_dna_fallback_never_invents_rules():
    director = Director.__new__(Director)
    director.brand_dna = None
    assert "do not invent company brand rules" in director._brand_dna_prompt_block()
