from hivemind_employees.api_hyper_rooms import _apply_outreach_contract


def test_compound_outreach_cannot_pass_with_one_email_for_ten_prospects():
    verdict = {
        "met": True, "artifact_ok": True, "assignments_ok": True,
        "grounded_ok": True, "gaps": [],
    }
    plan = {
        "outreach_request": {
            "requested_count": 10, "discover": True, "persist": True,
            "draft": True, "deliver": True, "monitor": True,
        },
        "outreach_metrics": {
            "prospects_discovered": 10,
            "prospects_persisted": 10,
            "verified_recipients": 1,
        },
    }

    result = _apply_outreach_contract(verdict, plan, [{"label": "gmail.send_email"}])

    assert result["met"] is False
    assert result["artifact_ok"] is False
    assert result["outreach_observed"] == {
        "discover": 10, "persist": 10, "draft": 1, "deliver": 0, "monitor": 0,
    }
    assert "outreach lifecycle draft incomplete: 1/10" in result["gaps"]
    assert "outreach lifecycle deliver incomplete: 0/10" in result["gaps"]
    assert "outreach lifecycle monitor incomplete: 0/10" in result["gaps"]


def test_prepare_only_outreach_passes_when_requested_internal_phases_are_complete():
    verdict = {
        "met": True, "artifact_ok": True, "assignments_ok": True,
        "grounded_ok": True, "gaps": [],
    }
    plan = {
        "outreach_request": {
            "requested_count": 3, "discover": True, "persist": True,
            "draft": False, "deliver": False, "monitor": False,
        },
        "outreach_metrics": {
            "prospects_discovered": 3,
            "prospects_persisted": 3,
            "verified_recipients": 2,
        },
    }

    result = _apply_outreach_contract(verdict, plan, [])

    assert result["met"] is True
    assert result["gaps"] == []


def test_outreach_without_explicit_quantity_uses_actual_results_not_a_fake_quota():
    verdict = {
        "met": True, "artifact_ok": True, "assignments_ok": True,
        "grounded_ok": True, "gaps": [],
    }
    plan = {
        "outreach_request": {
            "requested_count": None, "discover": True, "persist": True,
            "draft": False, "deliver": False, "monitor": False,
        },
        "outreach_metrics": {
            "prospects_discovered": 7,
            "prospects_persisted": 7,
        },
    }

    result = _apply_outreach_contract(verdict, plan, [])

    assert result["met"] is True
    assert result["outreach_contract"]["requested_count"] is None
    assert result["outreach_observed"]["discover"] == 7


def test_outreach_without_explicit_quantity_still_requires_real_evidence():
    verdict = {
        "met": True, "artifact_ok": True, "assignments_ok": True,
        "grounded_ok": True, "gaps": [],
    }
    plan = {
        "outreach_request": {
            "requested_count": None, "discover": True, "persist": True,
            "draft": False, "deliver": False, "monitor": False,
        },
        "outreach_metrics": {},
    }

    result = _apply_outreach_contract(verdict, plan, [])

    assert result["met"] is False
    assert "outreach lifecycle discover produced no verified result" in result["gaps"]
