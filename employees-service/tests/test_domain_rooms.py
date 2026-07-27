from hivemind_employees.hyper.domains import domain_slugs, get_domain_pack
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
    assert default_skill_for("campaign") == "campaign-operating-system"
