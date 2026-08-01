from hivemind_employees.api_outreach import GenerateRequest, _email_system_prompt


def test_email_prompt_is_tenant_generic_and_uses_supplied_sender():
    request = GenerateRequest(
        channel="email", turn_id="turn-1", sender_company="GreenLeaf Bakery",
        sender_email="hello@greenleaf.example", sender_name="Mina",
        prospect={
            "lead_id": "lead-1", "company": "Corner Cafe",
            "email": "owner@corner.example", "fit_reason": "Local wholesale fit",
            "outreach_angle": "Fresh weekday delivery",
        },
    )

    prompt = _email_system_prompt(request)

    assert "GreenLeaf Bakery" in prompt
    assert "hello@greenleaf.example" in prompt
    assert "singulancelabs.com" not in prompt.lower()
    assert "brand names exactly" not in prompt.lower()
