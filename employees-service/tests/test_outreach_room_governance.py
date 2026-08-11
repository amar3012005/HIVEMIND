from hivemind_employees.hyper.domains.outreach.governance import lifecycle_checks


def test_explicit_quantity_is_binding_for_room_artifacts():
    checks = lifecycle_checks(
        {
            "requested_count": 10, "discover": True, "persist": True,
            "draft": True, "deliver": True,
        },
        discovered=10, persisted=10, drafted=4, proposed_actions=1,
    )

    by_criterion = {check["criterion"]: check for check in checks}
    assert by_criterion["outreach:discover"]["passed"] is True
    assert by_criterion["outreach:persist"]["passed"] is True
    assert by_criterion["outreach:draft"]["passed"] is False
    assert by_criterion["outreach:authority_handoff"]["passed"] is True


def test_unspecified_quantity_accepts_actual_verified_batch():
    checks = lifecycle_checks(
        {
            "requested_count": None, "discover": True, "persist": True,
            "draft": False, "deliver": False,
        },
        discovered=7, persisted=7, drafted=0, proposed_actions=0,
    )

    assert checks
    assert all(check["passed"] is True for check in checks)
    assert all(check["expected"] == "at least one verified result" for check in checks)


def test_delivery_request_requires_authority_handoff_not_fake_receipt():
    checks = lifecycle_checks(
        {
            "requested_count": None, "discover": False, "persist": False,
            "draft": False, "deliver": True,
        },
        discovered=0, persisted=0, drafted=0, proposed_actions=0,
    )

    assert checks == [{
        "criterion": "outreach:authority_handoff",
        "type": "authority_handoff",
        "expected": "at least one authority-gated proposed action",
        "observed": "count=0",
        "passed": False,
    }]
