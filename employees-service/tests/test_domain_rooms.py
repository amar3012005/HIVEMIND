from hivemind_employees.hyper.domains import domain_slugs, get_domain_pack
from hivemind_employees.hyper.engine import Director
from hivemind_employees.hyper.rooms import lead_shape_for
from hivemind_employees.hyper.skills import (
    default_skill_for,
    load_method_skill,
    resolve_room_kind,
    skill_catalog,
)


EXPECTED = {"seo", "marketing", "branding", "fundraising", "research", "product", "design", "legal_finance", "campaign"}


def test_initial_domain_packs_are_complete_and_versioned():
    assert EXPECTED.issubset(set(domain_slugs()))
    for slug in EXPECTED:
        pack = get_domain_pack(slug)
        assert pack is not None
        assert pack.version == 1
        assert pack.director_prompt
        assert pack.toolkit_prompt
        assert "## " in pack.report_contract
        assert len(pack.skills) >= 2


def test_explicit_room_tag_wins_over_message_keyword_classification():
    assert resolve_room_kind("ROOM_SEO", "", "write a fundraising campaign") == "seo"
    assert resolve_room_kind("ROOM_BRANDING", "", "research competitors") == "branding"
    assert resolve_room_kind("ROOM_FUNDRAISING", "", "improve our SEO") == "fundraising"


def test_general_rooms_keep_existing_dynamic_classifier():
    assert resolve_room_kind("GENERAL", "", "draft a cold email sequence") == "outreach"
    assert resolve_room_kind("GENERAL", "", "help us prioritize the roadmap") == "strategy"


def test_domain_skills_use_progressive_disclosure():
    catalog = dict(skill_catalog("seo"))
    assert "keyword-intent-map" in catalog
    assert "evidence-first" in catalog
    default = default_skill_for("seo")
    assert default in catalog
    assert "intent clusters" in load_method_skill("keyword-intent-map")


def test_domain_pack_controls_room_lead_shape():
    assert lead_shape_for("seo") == "maker"
    assert lead_shape_for("marketing") == "maker"
    assert lead_shape_for("branding") == "panel"
    assert lead_shape_for("fundraising") == "panel"
    assert lead_shape_for("campaign") == "maker"
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
