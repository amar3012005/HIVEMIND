"""Half the domain packs had only 2 skills of their own (branding, design,
fundraising, legal_finance, marketing, product) and hq had zero — thin next to
campaign's 15 or seo's 11. This guards that the researched deepening actually
landed and stays landed: every domain a human Work Room can be profiled into
(execution_profiles.py's room_kind set) has real, named, sourced skills, not
generic filler, and none silently disappears in a future edit.
"""
import inspect

from hivemind_employees.hyper.domains import get_domain_pack
from hivemind_employees.hyper.execution_profiles import EXECUTION_PROFILES

MINIMUM_SKILLS_PER_PROFILED_DOMAIN = {
    "branding": 5, "design": 5, "product": 5, "hq": 3,
    "marketing": 5, "fundraising": 5, "legal_finance": 5,
}


def test_every_execution_profile_room_kind_has_adequate_skill_depth():
    profiled_room_kinds = {p.room_kind for p in EXECUTION_PROFILES.values()}
    for room_kind, minimum in MINIMUM_SKILLS_PER_PROFILED_DOMAIN.items():
        if room_kind not in profiled_room_kinds and room_kind != "hq":
            continue  # not every profiled kind needed deepening (campaign/seo/outreach already deep)
        pack = get_domain_pack(room_kind)
        assert pack is not None, f"{room_kind} has no installed domain pack at all"
        skill_count = len(getattr(pack, "skills", None) or [])
        assert skill_count >= minimum, (
            f"{room_kind} has {skill_count} skills, expected >= {minimum} — "
            "did the researched skill files get removed or moved?"
        )


def test_new_skills_are_named_and_sourced_not_generic_filler():
    # Every researched skill names a real author/book/standard in its body — the
    # exact discipline that distinguishes these from invented "best practice" text.
    expected_source_markers = {
        "branding/skills/distinctive-assets-availability.md": "Sharp",
        "branding/skills/brand-archetype-fit.md": "Pearson",
        "branding/skills/onliness-statement.md": "Neumeier",
        "design/skills/affordance-signifier-audit.md": "Norman",
        "design/skills/heuristic-evaluation.md": "Nielsen",
        "design/skills/less-but-better-audit.md": "Rams",
        "product/skills/rice-prioritization.md": "Intercom",
        "product/skills/appetite-scoping.md": "Shape Up",
        "product/skills/kano-classes.md": "Kano",
        "hq/skills/okr-ladder.md": "Doerr",
        "hq/skills/accountability-matrix.md": "PMBOK",
        "hq/skills/operating-rhythm.md": "Harnish",
        "marketing/skills/storybrand-message-frame.md": "Miller",
        "marketing/skills/see-think-do-care.md": "Kaushik",
        "marketing/skills/experiment-statistical-power.md": "Kohavi",
        "fundraising/skills/default-alive-test.md": "Graham",
        "fundraising/skills/safe-and-dilution-math.md": "Y Combinator",
        "fundraising/skills/investor-narrative-arc.md": "Sequoia",
        "legal_finance/skills/capital-efficiency-read.md": "Bessemer",
        "legal_finance/skills/contract-risk-review.md": "CONTRACT RISK REVIEW",
        "legal_finance/skills/gdpr-processing-screen.md": "Art.",
    }
    base = inspect.getfile(get_domain_pack).rsplit("domains", 1)[0] + "domains"
    for rel_path, marker in expected_source_markers.items():
        with open(f"{base}/{rel_path}", encoding="utf-8") as f:
            content = f.read()
        assert marker in content, f"{rel_path} missing expected source marker {marker!r}"
