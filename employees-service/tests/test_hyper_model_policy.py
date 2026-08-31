from hivemind_employees.hyper.engine import (
    _GROQ_PROVIDER_DISABLED,
    _normalize_openrouter_parameters,
    _or_model,
    _or_provider_routing,
    _route_direct_openrouter,
)
from hivemind_employees.hyper.model_policy import HYPER_FAST_MODEL, canonical_hyper_model, requires_openrouter


def test_legacy_hyper_models_normalize_to_nitro():
    for model in (None, "", "gpt-oss-20b", "openai/gpt-oss-20b", "grok-3", "x-ai/grok-4"):
        assert canonical_hyper_model(model) == HYPER_FAST_MODEL
        assert requires_openrouter(model)


def test_unrelated_models_are_preserved():
    assert canonical_hyper_model("openai/gpt-oss-120b") == "openai/gpt-oss-120b"
    assert canonical_hyper_model("google/gemini-2.5-flash") == "google/gemini-2.5-flash"


def test_legacy_20b_openrouter_mapping_prefers_bedrock_with_fast_fallbacks(monkeypatch):
    monkeypatch.delenv("HYPER_OR_IGNORE", raising=False)
    assert _or_model("openai/gpt-oss-20b") == HYPER_FAST_MODEL
    order, ignored = _or_provider_routing(HYPER_FAST_MODEL)
    assert order == [
        "amazon-bedrock",
        "amazon-bedrock/eu-west-1",
        "groq",
        "together",
    ]
    assert not {provider.lower() for provider in order} & {provider.lower() for provider in ignored}


def test_groq_is_kept_as_ordered_openrouter_fallback_for_gpt_oss_20b(monkeypatch):
    monkeypatch.setenv("HYPER_OR_IGNORE", "DekaLLM")
    order, ignored = _or_provider_routing(HYPER_FAST_MODEL)
    assert order is not None
    assert "groq" in order
    assert "Groq" not in ignored


def test_hyperagent_gpt_oss_never_routes_to_direct_groq(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")
    monkeypatch.setenv("HYPER_OPENROUTER_PRIMARY", "0")
    assert _GROQ_PROVIDER_DISABLED is True
    assert _route_direct_openrouter(HYPER_FAST_MODEL) is True


def test_openrouter_uses_provider_supported_token_budget_name():
    body = _normalize_openrouter_parameters({"max_completion_tokens": 120, "messages": []})
    assert body["max_tokens"] == 120
    assert "max_completion_tokens" not in body
