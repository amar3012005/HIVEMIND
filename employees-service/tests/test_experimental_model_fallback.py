"""nvidia/nemotron-3.5-lightning reasons by default with no way to ask for it off
implicitly — verified live 2026-08-12: it burned its entire token budget on
`reasoning` and returned content=null at both our real profile-selector budget
(300 tok) and synth budget (2200 tok). reasoning.enabled=false fixed both. Its
OpenRouter endpoints also measured 94.8%/98.9% 24h uptime — good, not
prod-grade — so any failure must fall back to the proven default, never take
an already-working step down with it.
"""
import asyncio

from hivemind_employees.hyper.engine import (
    Director, _fallback_model_for, _needs_reasoning_disabled, _or_provider_routing,
)


def test_reasoning_disabled_for_nemotron():
    assert _needs_reasoning_disabled("nvidia/nemotron-3.5-lightning") is True
    assert _needs_reasoning_disabled("NVIDIA/Nemotron-3.5-Lightning") is True  # case-insensitive


def test_reasoning_not_disabled_for_other_models():
    assert _needs_reasoning_disabled("openai/gpt-oss-120b") is False
    assert _needs_reasoning_disabled("") is False
    assert _needs_reasoning_disabled(None) is False


def test_fallback_model_for_nemotron_is_the_proven_default():
    assert _fallback_model_for("nvidia/nemotron-3.5-lightning") == "openai/gpt-oss-120b"


def test_no_fallback_for_models_without_a_configured_fallback():
    assert _fallback_model_for("openai/gpt-oss-120b") is None
    assert _fallback_model_for("anthropic/claude-3.5-sonnet") is None


def test_nemotron_pin_excludes_deepinfra_from_its_own_ignore_list(monkeypatch):
    # Reproduced live 2026-08-12: nemotron has only DeepInfra + CoreWeave as
    # OpenRouter hosts, and the global ignore list blacklists DeepInfra —
    # sending both order+ignore naming DeepInfra 404s with "All providers
    # have been ignored" since no other host survives.
    monkeypatch.delenv("HYPER_OR_IGNORE", raising=False)
    pin, ignore = _or_provider_routing("nvidia/nemotron-3.5-lightning")
    assert pin == ["DeepInfra", "CoreWeave"]
    assert "DeepInfra" not in ignore
    assert "deepinfra" not in [p.lower() for p in ignore]


def test_unpinned_model_keeps_the_full_default_ignore_list(monkeypatch):
    monkeypatch.delenv("HYPER_OR_IGNORE", raising=False)
    pin, ignore = _or_provider_routing("mistralai/mistral-large")
    assert pin is None
    assert "DeepInfra" in ignore  # unaffected — no pin to protect from the blacklist


def test_gpt_oss_120b_pin_is_unaffected_by_the_filter(monkeypatch):
    # None of its pinned providers (Cerebras/Together) are in the
    # default ignore list, so the filter must be a complete no-op here.
    monkeypatch.delenv("HYPER_OR_IGNORE", raising=False)
    pin, ignore = _or_provider_routing("openai/gpt-oss-120b")
    assert pin == ["Cerebras", "Together"]
    assert ignore == ["DekaLLM", "WandB", "DeepInfra", "Mancer", "SiliconFlow", "Phala", "Groq"]


def _director(**overrides):
    events = []

    async def emit(event):
        events.append(event)

    kwargs = dict(
        user_message="test", user_id="user-1", org_id="org-1", project_id=None,
        participants=[{"slug": "lead", "name": "Lead", "_lane": "Strategist"}],
        room_template="auto", room_goal="", enabled_connectors=[], emit=emit,
        room_kind="general",
    )
    kwargs.update(overrides)
    return Director(**kwargs), events


def test_groq_falls_back_to_default_model_when_experimental_model_fails(monkeypatch):
    director, _events = _director(director_model="nvidia/nemotron-3.5-lightning")

    calls = []

    async def fake_openrouter_chat(body, *, timeout):
        calls.append(dict(body))
        if body["model"] == "nvidia/nemotron-3.5-lightning":
            return None  # simulate the experimental endpoint being down
        return {"choices": [{"message": {"role": "assistant", "content": "fallback answer"}}],
                "usage": {"total_tokens": 10}}

    monkeypatch.setattr("hivemind_employees.hyper.engine._openrouter_chat", fake_openrouter_chat)
    monkeypatch.setattr("hivemind_employees.hyper.engine._route_direct_openrouter", lambda m: True)
    monkeypatch.setattr("hivemind_employees.hyper.engine._groq_key", lambda: "dummy-key")

    result = asyncio.run(director._groq([{"role": "user", "content": "hi"}], force_text=True))

    assert result == {"role": "assistant", "content": "fallback answer"}
    assert len(calls) == 2
    assert calls[0]["model"] == "nvidia/nemotron-3.5-lightning"
    assert calls[0]["reasoning"] == {"enabled": False}
    assert calls[1]["model"] == "openai/gpt-oss-120b"
    assert "reasoning" not in calls[1], "the fallback model should not inherit the experimental override"


def test_groq_never_calls_fallback_when_experimental_model_succeeds(monkeypatch):
    director, _events = _director(director_model="nvidia/nemotron-3.5-lightning")

    calls = []

    async def fake_openrouter_chat(body, *, timeout):
        calls.append(dict(body))
        return {"choices": [{"message": {"role": "assistant", "content": "real answer"}}],
                "usage": {"total_tokens": 10}}

    monkeypatch.setattr("hivemind_employees.hyper.engine._openrouter_chat", fake_openrouter_chat)
    monkeypatch.setattr("hivemind_employees.hyper.engine._route_direct_openrouter", lambda m: True)
    monkeypatch.setattr("hivemind_employees.hyper.engine._groq_key", lambda: "dummy-key")

    result = asyncio.run(director._groq([{"role": "user", "content": "hi"}], force_text=True))

    assert result == {"role": "assistant", "content": "real answer"}
    assert len(calls) == 1, "no fallback call should happen when the primary model succeeds"
