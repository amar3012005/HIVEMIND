from types import SimpleNamespace

from hivemind_employees.api_hyper_rooms import (
    _campaign_post_visual_payload,
    _director_final_visual_payload,
    _room_visual_job_payload,
    _visual_delivery_ready,
)


def _request(message: str):
    return SimpleNamespace(
        user_message=message,
        room_id="aa0e4263-cd83-45ec-9bcb-aae37e9a350b",
        turn_id="turn-visual-canary",
    )


def test_room_visual_payload_preserves_instruction_ratio_and_idempotency():
    payload = _room_visual_job_payload(
        _request("Create one designer-grade 16:9 campaign visual for SINGULANCE"),
        "general",
    )
    assert payload["instruction"].startswith("Create one designer-grade")
    assert payload["use_case"] == "campaign_social"
    assert payload["output"] == {
        "mode": "single", "count": 1, "aspect_ratios": ["16:9"], "quality": "quality",
    }
    assert payload["source"]["room_id"] == "aa0e4263-cd83-45ec-9bcb-aae37e9a350b"
    assert payload["idempotency_key"] == "room-visual:turn-visual-canary"


def test_room_visual_payload_builds_coordinated_sets():
    payload = _room_visual_job_payload(
        _request("Generate four coordinated images in 1:1 and 4:5"),
        "design",
    )
    assert payload["use_case"] == "room_visual"
    assert payload["output"]["mode"] == "set"
    assert payload["output"]["count"] == 4
    assert payload["output"]["aspect_ratios"] == ["1:1", "4:5"]


def test_linkedin_post_report_queues_one_coordinated_visual_per_post():
    payload = _campaign_post_visual_payload(
        _request("Generate me 3 posts for my LinkedIn campaign"),
        "general",
        "Post 1\nVisual: hybrid heating system\nPost 2\nVisual: hot water infographic\nPost 3\nVisual: longevity timeline",
    )
    assert payload is not None
    assert payload["use_case"] == "campaign_social"
    assert payload["output"] == {
        "mode": "set", "count": 3, "aspect_ratios": ["4:5"], "quality": "quality",
    }
    assert "one for each approved post" in payload["instruction"]
    assert "hot water infographic" in payload["instruction"]
    assert payload["source"]["kind"] == "room_director_campaign_report"
    assert payload["idempotency_key"] == "room-visual-report:turn-visual-canary"


def test_non_campaign_report_does_not_auto_queue_visuals():
    assert _campaign_post_visual_payload(
        _request("Write three hiring interview questions"), "general", "Questions...",
    ) is None


def test_director_selected_image_uses_completed_room_result_as_final_brief():
    payload = _director_final_visual_payload(
        _request("Develop the launch concept and produce its final visual"),
        "general",
        "Approved synthesis: lead with the verified modular system and buyer outcome.",
        {
            "output_family": "image",
            "output_contract": {"artifact_kind": "generated_image"},
            "artifact_intent": {
                "kind": "generated_image", "purpose": "launch visual", "audience": "buyers",
            },
            "source_receipts": [{"title": "Verified product page"}],
            "work_results": [{"owner": "Researcher", "title": "Buyer check", "text": "Verified buyer concern."}],
        },
    )
    assert payload is not None
    assert payload["source"]["kind"] == "room_director_final_synthesis"
    assert payload["idempotency_key"] == "room-visual-final:turn-visual-canary"
    assert "APPROVED FINAL SYNTHESIS" in payload["instruction"]
    assert "Verified buyer concern" in payload["instruction"]
    assert "opening request alone" in payload["instruction"]


def test_visual_delivery_waits_for_completed_grounded_room_result():
    approved = {"met": True, "grounded_ok": True}
    synthesis = "A sufficiently detailed final synthesis for rendering."
    assert _visual_delivery_ready("complete", approved, synthesis) is True
    assert _visual_delivery_ready("blocked", approved, synthesis) is False
    assert _visual_delivery_ready("complete", {"met": False, "grounded_ok": True}, synthesis) is False
    assert _visual_delivery_ready("complete", {"met": True, "grounded_ok": False}, synthesis) is False
