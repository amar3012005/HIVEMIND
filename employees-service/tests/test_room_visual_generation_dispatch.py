from types import SimpleNamespace

from hivemind_employees.api_hyper_rooms import _room_visual_job_payload


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
