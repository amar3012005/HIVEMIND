"""A General Work Room's room_kind was frozen to "general" for its entire life —
resolve_turn_room_kind hard-returns "general" whenever room_mode == "work" — so it
could never deterministically invoke the Campaign compiler or the Outreach lifecycle
contract; it could only improvise a report while borrowing a method skill for flavor.
These tests guard the profile-selection boundary that fixes that, and the two
guarantees a broken instance of it would silently violate: never reclassify the same
turn, and never let a prose report substitute for an operational profile's required
artifacts.
"""
import inspect
import json

import pytest

from hivemind_employees.hyper.execution_profiles import (
    DEFAULT_PROFILE_ID, EXECUTION_PROFILES, ExecutionProfile,
    default_execution_profile, get_execution_profile, profile_registry_manifest,
)
from hivemind_employees.hyper.domains import get_domain_pack


def test_every_profile_room_kind_resolves_to_an_installed_domain_pack():
    for profile_id, profile in EXECUTION_PROFILES.items():
        if profile.room_kind == "general":
            continue  # "general" has no pack by design; Director already handles None
        pack = get_domain_pack(profile.room_kind)
        assert pack is not None, f"{profile_id} declares room_kind={profile.room_kind!r} but no pack is installed"


def test_default_profile_is_general_answer_and_never_operational():
    assert DEFAULT_PROFILE_ID == "general.answer.v1"
    default = default_execution_profile()
    assert default.id == DEFAULT_PROFILE_ID
    assert not default.is_operational(), "the fallback profile must never require artifacts a broken classifier cannot produce"


def test_operational_profiles_declare_at_least_one_required_artifact():
    # is_operational() gates the "no prose substitutes for artifacts" completion check
    # (api_hyper_rooms.py). A profile with effect="prepare_only" but zero required
    # artifacts would silently fall through to the lenient general-answer path.
    for profile_id, profile in EXECUTION_PROFILES.items():
        if profile.effect == "prepare_only":
            assert profile.required_artifacts, f"{profile_id} is prepare_only but declares no required_artifacts"
            assert profile.is_operational()


def test_marketing_copy_profile_is_text_only_and_not_operational():
    profile = EXECUTION_PROFILES["marketing.copy.v1"]
    assert profile.allowed_outputs == ("direct_answer",)
    assert profile.effect == "internal"
    assert not profile.required_artifacts
    assert not profile.is_operational()


def test_get_execution_profile_unknown_id_returns_none_not_a_default():
    # The CALLER (_select_execution_profile) is responsible for falling back to
    # default_execution_profile() and must know it did — get_execution_profile silently
    # returning a default here would hide a classifier bug (an unregistered profile_id)
    # as if it were a normal, honest default selection.
    assert get_execution_profile("not.a.real.profile") is None
    assert get_execution_profile("") is None


def test_registry_manifest_never_leaks_engine_internals_to_the_selector():
    # "The model never sees provider names, connector implementations, playbook ids, or
    # authority state" — enforced structurally: the manifest can only ever contain the
    # five fields below, because profile_registry_manifest() builds them by hand.
    for row in profile_registry_manifest():
        assert set(row.keys()) == {"profile_id", "room_kind", "allowed_outputs", "effect", "when"}


def test_every_profile_declares_a_nonempty_disambiguating_when():
    # Regression for the confirmed misroute: "8 feature requests, prioritize 3" landed on
    # research.decision.v1 instead of product.artifact.v1 because the selector saw only
    # bare id/room_kind/allowed_outputs/effect — no natural-language trigger to tell
    # "decision" and "product" apart. `when` is the ONLY disambiguating signal the
    # selector model gets; a profile with an empty one is exactly as blind as before.
    for profile_id, profile in EXECUTION_PROFILES.items():
        assert profile.when.strip(), f"{profile_id} has no `when` — selector cannot disambiguate it"

    manifest_by_id = {row["profile_id"]: row["when"] for row in profile_registry_manifest()}
    for profile_id, profile in EXECUTION_PROFILES.items():
        assert manifest_by_id[profile_id] == profile.when, f"{profile_id}'s when did not survive into the manifest"


def test_twelve_profiles_cover_every_requested_domain():
    expected_room_kinds = {
        "general", "research", "campaign", "outreach", "marketing", "seo",
        "branding", "fundraising", "product", "design", "legal_finance",
    }
    assert {p.room_kind for p in EXECUTION_PROFILES.values()} == expected_room_kinds
    assert len(EXECUTION_PROFILES) == 12


def test_profile_ids_are_unique_and_versioned():
    ids = list(EXECUTION_PROFILES.keys())
    assert len(ids) == len(set(ids))
    for profile_id in ids:
        assert profile_id.endswith(".v1"), f"{profile_id} must declare a version suffix"


# ── resume-safety: read-before-select must make reselection impossible ──────────────

class _FakeReq:
    turn_id = "11111111-1111-1111-1111-111111111111"
    callback_url = "http://x/internal/hyper/turn-event"
    user_message = "prepare outreach for regulated banks"
    room_goal = ""
    room_mode = "work"


@pytest.mark.asyncio
async def test_resume_reads_persisted_profile_and_never_calls_the_classifier(monkeypatch):
    import hivemind_employees.api_hyper_rooms as api

    persisted = {
        "contract": "execution-profile.v1", "profile_id": "outreach.prepare.v1",
        "room_kind": "outreach", "allowed_outputs": ["outreach_dashboard"],
        "effect": "prepare_only", "required_artifacts": ["source_backed_lead"],
        "review_policy": "reviewer", "reason": "already selected on a prior attempt",
    }

    async def fake_get(turn_id):
        assert turn_id == _FakeReq.turn_id
        return persisted

    calls = {"select": 0}

    async def fake_select(req, conns):
        calls["select"] += 1
        raise AssertionError("the classifier must never run once a profile is persisted")

    monkeypatch.setattr(api, "get_work_room_execution_profile", fake_get)
    monkeypatch.setattr(api, "_select_execution_profile", fake_select)

    result = await api._resolve_work_room_execution_profile(_FakeReq(), [])

    assert result == persisted
    assert calls["select"] == 0


@pytest.mark.asyncio
async def test_fresh_turn_selects_then_persists_then_reads_back_the_winner(monkeypatch):
    """Simulates a concurrent-dispatch race: our own selection call succeeds, but by the
    time we try to persist it, a concurrent invocation already won the write-once slot.
    We must return the WINNER's profile, not the one we happened to compute ourselves —
    that is what actually makes "never reclassify" true under concurrency, not just the
    write-once guard in isolation."""
    import hivemind_employees.api_hyper_rooms as api

    reads = []
    winner = {"profile_id": "general.answer.v1", "room_kind": "general", "required_artifacts": []}

    async def fake_get(turn_id):
        reads.append(turn_id)
        return None if len(reads) == 1 else winner

    async def fake_select(req, conns):
        return {"profile_id": "outreach.prepare.v1", "room_kind": "outreach", "required_artifacts": ["x"]}

    persisted_calls = []

    async def fake_persist(turn_id, profile):
        persisted_calls.append((turn_id, profile))
        return False  # someone else's write-once already claimed the slot

    monkeypatch.setattr(api, "get_work_room_execution_profile", fake_get)
    monkeypatch.setattr(api, "_select_execution_profile", fake_select)
    monkeypatch.setattr(api, "persist_work_room_execution_profile", fake_persist)

    result = await api._resolve_work_room_execution_profile(_FakeReq(), [])

    assert result == winner, "must return the persisted winner, not the value this call computed"
    assert len(reads) == 2, "must read once before selecting and once after persisting"


# ── structural guards: verified against the real source, not mocked ────────────────

def test_write_once_guard_is_present_in_the_persistence_sql():
    from hivemind_employees import db
    source = inspect.getsource(db.persist_work_room_execution_profile)
    assert "WHERE id = $1::uuid AND execution_profile IS NULL" in source, (
        "the write-once guarantee must be an atomic property of the UPDATE itself, "
        "not an application-level read-then-write race"
    )


def test_campaign_escape_hatch_is_gated_off_for_work_mode_turns():
    from hivemind_employees.hyper import engine
    source = inspect.getsource(engine.Director.run)
    assert 'self.room_kind != "campaign" and self.room_mode != "work"' in source, (
        "a Work Room turn's specialist engine is now chosen deterministically before "
        "the Director runs; only profile_id == campaign.contract.v1 (which already sets "
        "room_kind == 'campaign') may invoke the Campaign compiler for a Work Room turn"
    )


def test_operational_incomplete_check_precedes_the_unconditional_complete_path():
    import hivemind_employees.api_hyper_rooms as api
    source = inspect.getsource(api._orchestrate_single_agent)
    incomplete_at = source.index("_operational_incomplete = _operational_profile and")
    lenient_at = source.index('elif (req.room_mode or "").strip().lower() == "work" and final_text.strip():')
    assert incomplete_at < lenient_at, (
        "the operational-artifact check must be evaluated (and its branch taken first via "
        "if/elif) before the lenient always-complete path can run, or an outreach/campaign "
        "profile with zero real artifacts would still be reported complete"
    )
