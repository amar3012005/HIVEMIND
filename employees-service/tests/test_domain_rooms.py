from hivemind_employees.hyper.domains import domain_slugs, get_domain_pack
from hivemind_employees.hyper.engine import Director
from hivemind_employees.hyper.rooms import lead_shape_for
from hivemind_employees.hyper.skills import (
    default_skill_for,
    load_method_skill,
    resolve_room_kind,
    resolve_turn_room_kind,
    skill_catalog,
    work_skill_catalog,
)


EXPECTED = {"seo", "marketing", "outreach", "branding", "fundraising", "research", "product", "design", "legal_finance", "campaign"}


def test_initial_domain_packs_are_complete_and_versioned():
    assert EXPECTED.issubset(set(domain_slugs()))
    for slug in EXPECTED:
        pack = get_domain_pack(slug)
        assert pack is not None
        assert pack.version >= 1
        assert pack.director_prompt
        assert pack.toolkit_prompt
        assert "## " in pack.report_contract
        if slug != "outreach":
            assert len(pack.skills) >= 2


def test_explicit_room_tag_wins_over_message_keyword_classification():
    assert resolve_room_kind("ROOM_SEO", "", "write a fundraising campaign") == "seo"
    assert resolve_room_kind("ROOM_BRANDING", "", "research competitors") == "branding"
    assert resolve_room_kind("ROOM_FUNDRAISING", "", "improve our SEO") == "fundraising"
    assert resolve_room_kind("ROOM_OUTREACH", "", "research industrial prospects") == "outreach"


def test_general_rooms_keep_existing_dynamic_classifier():
    assert resolve_room_kind("GENERAL", "", "draft a cold email sequence") == "outreach"
    assert resolve_room_kind("GENERAL", "", "help us prioritize the roadmap") == "strategy"


def test_work_rooms_do_not_preclassify_human_requests_from_tags_or_words():
    assert resolve_turn_room_kind(
        "work", "ROOM_OUTREACH", "Legacy outreach task", "Draft a product roadmap"
    ) == "general"
    assert resolve_turn_room_kind(
        "work", "ROOM_PRODUCT", "Product task", "Research competitors"
    ) == "general"
    # Runtime rooms preserve the playbook-selected specialist contract.
    assert resolve_turn_room_kind(
        "runtime", "ROOM_OUTREACH", "", "Research competitors"
    ) == "outreach"


def test_work_room_catalog_supports_progressive_semantic_skill_selection():
    catalog = dict(work_skill_catalog())
    assert "positioning-ladder" in catalog
    assert "opportunity-solution-tree" in catalog
    assert "prospect-qualification" in catalog
    assert "evidence-first" in catalog
    assert len(catalog) == len(work_skill_catalog())


def test_work_room_director_stays_neutral_without_losing_method_range():
    director = Director(
        user_message="Assess our product direction and decide what to validate next.",
        user_id="user", org_id="org", project_id=None, participants=[],
        room_template="auto", room_goal="Legacy outreach task", enabled_connectors=[],
        emit=lambda event: None, room_kind="general", room_mode="work",
    )
    assert director.is_work_room is True
    assert director.room_kind == "general"
    assert director.domain_pack is None


def test_domain_skills_use_progressive_disclosure():
    catalog = dict(skill_catalog("seo"))
    assert "keyword-intent-map" in catalog
    assert "evidence-first" in catalog
    default = default_skill_for("seo")
    assert default in catalog
    assert "intent clusters" in load_method_skill("keyword-intent-map")
    assert default == "technical-seo-audit"
    assert "crawl-and-indexability" in catalog
    assert "site-architecture" in catalog
    assert "content-opportunity" in catalog
    assert "structured-data" in catalog
    assert "performance-and-cwv" in catalog
    assert "javascript-seo" in catalog
    assert "international-and-local" in catalog
    assert "seo-measurement" in catalog
    seo_pack = get_domain_pack("seo")
    assert seo_pack.capabilities[0] == {
        "id": "seo.site-intelligence",
        "version": "1.0.0",
        "when": "A public website must be discovered, rendered, technically audited, or mapped before SEO recommendations are made.",
    }
    assert seo_pack.capabilities[1]["id"] == "seo.search-console"


def test_seo_room_enforces_cerebras_gpt_oss_for_every_reasoning_lane():
    director = Director(
        user_message="audit example.com", user_id="user", org_id="org", project_id=None,
        participants=[], room_template="auto", room_goal="SEO audit",
        enabled_connectors=[], emit=lambda event: None, room_kind="seo",
        director_model="another/director", persona_model="another/persona", synth_model="another/synth",
    )
    assert director.director_model == "gpt-oss-120b"
    assert director.persona_model == "gpt-oss-120b"
    assert director.synth_model == "gpt-oss-120b"
    assert director.strict_model_provider is True


def test_non_seo_room_keeps_caller_model_selection():
    director = Director(
        user_message="research competitors", user_id="user", org_id="org", project_id=None,
        participants=[], room_template="auto", room_goal="Research",
        enabled_connectors=[], emit=lambda event: None, room_kind="research",
        director_model="custom/director", persona_model="custom/persona", synth_model="custom/synth",
    )
    assert director.director_model == "custom/director"
    assert director.persona_model == "custom/persona"
    assert director.synth_model == "custom/synth"
    assert director.strict_model_provider is False


def test_domain_pack_controls_room_lead_shape():
    assert lead_shape_for("seo") == "maker"
    assert lead_shape_for("marketing") == "maker"
    assert lead_shape_for("branding") == "panel"
    assert lead_shape_for("fundraising") == "panel"
    assert lead_shape_for("campaign") == "maker"
    assert lead_shape_for("outreach") == "maker"
    assert lead_shape_for("fundraising", "doc") == "maker"


def test_campaign_intelligence_pack_exposes_bounded_specialist_methods():
    catalog = dict(skill_catalog("campaign"))
    assert "campaign-operating-system" in catalog
    assert "media-plan-and-budget" in catalog
    assert "creative-hypothesis-system" in catalog
    assert "channel-preflight" in catalog
    assert "launch-safety" in catalog
    assert "measurement-and-experimentation" in catalog
    assert "account-evidence-audit" in catalog
    assert "paid-social-platforms" in catalog
    assert "intent-and-marketplace-ads" in catalog
    assert "organic-and-direct-channels" in catalog
    assert "attribution-and-tracking" in catalog
    assert "landing-and-funnel" in catalog
    assert "audit-and-optimization" in catalog
    assert "copy-and-format-adaptation" in catalog
    assert "campaign-reporting" in catalog
    assert default_skill_for("campaign") == "campaign-operating-system"


def test_room_journal_is_bounded_and_only_latest_report_is_recalled():
    journal = [
        {
            "asked": f"request {i}",
            "swarm_summary": f"decision {i}",
            "agents": [{"name": "Ari", "contribution": f"work {i}"}],
            "final_report_excerpt": f"report {i}",
        }
        for i in range(10)
    ]
    director = Director(
        user_message="continue", user_id="user", org_id="org", project_id=None,
        participants=[], room_template="auto", room_goal="Campaign",
        enabled_connectors=[], emit=lambda event: None, room_kind="campaign",
        room_journal=journal,
    )
    context = director._journal_block
    assert "request 0" not in context
    assert "request 9" in context
    assert "report 9" in context
    assert "report 8" not in context
