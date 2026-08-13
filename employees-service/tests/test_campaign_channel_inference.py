"""Live incident (2026-08-13): a campaign room whose brief never carried
`channels` (created via a free-text "Launch X Campaign" ask, not the
channel-picker flow) reached the compiler with channels=[]. The compiler
correctly produced an empty actions/media_plan for zero requested channels,
governance correctly rejected it ("actions must not be empty", "media_plan.
channels must not be empty" ...), and the repair loop's guard has nothing to
key off when there's no per-action/per-field/per-channel-deficit signal to
repair — an empty bundle isn't a few broken actions, it's a missing
precondition repair can't fix. `_campaign_requirements` now infers a real
channel instead of asking the compiler to build a plan for zero channels.
"""
from hivemind_employees.hyper.engine import Director


def _director(*, campaign_brief=None, enabled_connectors=None):
    async def emit(event):
        pass

    return Director(
        user_message="Launch Compliance-Focused Webinar Campaign", user_id="user-1", org_id="org-1",
        project_id=None, participants=[{"slug": "lead", "name": "Lead", "_lane": "Strategist"}],
        room_template="auto", room_goal="", enabled_connectors=enabled_connectors or [], emit=emit,
        room_kind="campaign", intended_output="answer", campaign_brief=campaign_brief or {},
    )


def test_empty_brief_channels_infers_x_organic_default():
    director = _director(campaign_brief={"channels": []})
    channels, requirements = director._campaign_requirements()
    assert channels == ["x_organic"]
    assert requirements == ["goal", "channel:x_organic"]


def test_missing_channels_key_entirely_also_infers_default():
    director = _director(campaign_brief={"goal": "Launch a webinar series"})
    channels, _ = director._campaign_requirements()
    assert channels == ["x_organic"]


def test_connected_connectors_are_preferred_over_the_bare_default():
    director = _director(campaign_brief={"channels": []}, enabled_connectors=["gmail"])
    channels, requirements = director._campaign_requirements()
    assert channels == ["gmail"]
    assert requirements == ["goal", "channel:gmail"]


def test_explicit_brief_channels_are_never_overridden():
    director = _director(campaign_brief={"channels": ["linkedin", "gmail"]}, enabled_connectors=["gmail"])
    channels, requirements = director._campaign_requirements()
    assert channels == ["linkedin", "gmail"]
    assert requirements == ["goal", "channel:linkedin", "channel:gmail"]


def test_channels_regex_fallback_still_wins_over_inference():
    director = _director(campaign_brief={}, )
    director.user_message = "Launch a campaign.\nCHANNELS: linkedin, tara"
    channels, _ = director._campaign_requirements()
    assert channels == ["linkedin", "tara"]
