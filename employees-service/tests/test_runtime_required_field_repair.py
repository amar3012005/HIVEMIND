"""The Room reported SUCCESS while returning `channel_mix: null`, five attempts running.

Core's predicate correctly refused it, but nothing in the producer ever checked its own
output — and the synth system prompt actively licensed the null with "do not fabricate
fields merely to satisfy completion checks". That sentence made a REQUIRED JUDGEMENT field
look like a fact the model must not invent.
"""
import inspect
import json

from hivemind_employees.hyper import engine as engine_mod
from hivemind_employees.hyper.engine import Director


def _source(name: str) -> str:
    return inspect.getsource(getattr(Director, name))


def test_generated_artifact_contract_is_forwarded_to_the_room():
    src = _source("_work_order_from_room_phase")
    # Core derives these from the predicates it will run. They were generated and dropped.
    assert "artifact_requirements" in src
    assert "artifact_schemas" in src


def test_synth_prompt_no_longer_licenses_an_empty_required_field():
    src = _source("_synthesize_runtime_stage_result")
    # The exact sentence that authorised the null must be gone.
    assert "do not fabricate fields merely to satisfy completion checks" not in src
    # The fact/judgement split must be explicit, and empties explicitly refused.
    assert "must never come back as null" in src
    assert "judgement" in src


def test_repair_pass_is_bounded_and_monotonic():
    src = _source("_synthesize_runtime_stage_result")
    assert "_missing_required" in src
    # Exactly ONE repair call — not a loop that could burn tokens without converging.
    assert src.count("fill_these_required_fields") == 1
    # It may only FILL blanks, never overwrite a field that was already good.
    assert 'if current.get(field) in (None, "", [], {})' in src


def test_blank_detection_matches_the_real_production_artifact():
    # Reproduce _missing_required's contract against the artifact that actually shipped:
    # every key present, channel_mix and recommended_next_motions both JSON null.
    schemas = {"marketing_strategy": {"schema": {"properties": {"data": {"required": [
        "niche_wedge", "positioning", "audience", "competitor_plan", "channel_mix"]}}}}}

    def missing(rows):
        out = {}
        for row in rows:
            spec = schemas.get(str(row.get("key") or "")) or {}
            req = (((spec.get("schema") or {}).get("properties") or {}).get("data") or {}).get("required") or []
            payload = row.get("data") if isinstance(row.get("data"), dict) else {}
            blank = [f for f in req if payload.get(f) in (None, "", [], {})]
            if blank:
                out[str(row.get("key"))] = blank
        return out

    shipped = [{"key": "marketing_strategy", "data": {
        "niche_wedge": "x", "positioning": "y", "audience": [{"segment": "a"}],
        "competitor_plan": "z", "channel_mix": None, "recommended_next_motions": None}}]
    assert missing(shipped) == {"marketing_strategy": ["channel_mix"]}

    # A filled required set passes even while the PREFERRED field stays null — preferred
    # checks are advisory and must not trigger a repair call.
    filled = json.loads(json.dumps(shipped))
    filled[0]["data"]["channel_mix"] = {"organic": ["founder-led posts"], "paid": ["LinkedIn", "search"]}
    assert missing(filled) == {}

    # An empty dict/list is as bad as null — that was the other way this slipped through.
    for empty in ({}, [], ""):
        blanked = json.loads(json.dumps(filled))
        blanked[0]["data"]["channel_mix"] = empty
        assert missing(blanked) == {"marketing_strategy": ["channel_mix"]}


def test_module_logger_is_used_not_a_missing_attribute():
    src = _source("_synthesize_runtime_stage_result")
    # `self.log` does not exist on this class; using it would raise at runtime in the exact
    # branch that only fires when a field is blank — i.e. only in production.
    assert "self.log" not in src
    assert hasattr(engine_mod, "log")


def test_campaign_link_policy_states_the_exact_allowed_set():
    """The validator rejects any URL in final_copy that is not in the brief. The Room was
    told only the abstract rule ("never invent URLs") and never the allowed SET, so it wrote
    ordinary-looking CTAs with landing-page links and all 5 actions were rejected."""
    from hivemind_employees.hyper.campaign_contract import campaign_system_contract, campaign_url_clause

    # Production case: company has no website on file -> allowed set is EMPTY.
    empty = campaign_url_clause([])
    assert "NO approved URL" in empty
    assert "NO link of any kind" in empty
    # It must name a concrete linkless alternative, or the model will invent one anyway.
    assert "reply to this post" in empty or "DM us" in empty

    supplied = campaign_url_clause(["https://singulancelabs.com/", " "])
    assert "https://singulancelabs.com" in supplied
    assert "singulancelabs.com/" not in supplied.replace("https://singulancelabs.com", "")  # trailing slash normalised
    # Same normalisation the validator applies (rstrip "/.,"), so producer and checker agree.
    assert "or no link at all" in supplied

    # The clause must be part of the contract every campaign stage receives.
    assert "LINK POLICY" in campaign_system_contract([])
    assert "LINK POLICY" in campaign_system_contract(["https://example.com"])


def test_allowed_urls_read_the_same_brief_keys_as_the_validator():
    import inspect
    from hivemind_employees.hyper import campaign_contract as cc
    from hivemind_employees.hyper.engine import Director

    producer = inspect.getsource(Director._campaign_allowed_urls)
    validator = inspect.getsource(cc.validate_campaign_contract) if hasattr(cc, "validate_campaign_contract") else ""
    for key in ("destination_url", "destinationUrl", "website_url"):
        assert key in producer, f"producer must read {key}"
    # Drift between these two key sets is the whole bug class.
    if validator:
        for key in ("destination_url", "destinationUrl", "website_url"):
            assert key in validator, f"validator reads {key}; producer must match"
