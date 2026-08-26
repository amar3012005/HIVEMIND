from hivemind_employees.hyper.engine import _normalize_openrouter_parameters, _or_model, _or_provider_routing
from hivemind_employees.hyper.model_policy import HYPER_FAST_MODEL, canonical_hyper_model, requires_openrouter


def test_legacy_hyper_models_normalize_to_nitro():
    for model in (None, "", "gpt-oss-20b", "openai/gpt-oss-20b", "grok-3", "x-ai/grok-4"):
        assert canonical_hyper_model(model) == HYPER_FAST_MODEL
        assert requires_openrouter(model)


def test_unrelated_models_are_preserved():
    assert canonical_hyper_model("openai/gpt-oss-120b") == "openai/gpt-oss-120b"
    assert canonical_hyper_model("google/gemini-2.5-flash") == "google/gemini-2.5-flash"


def test_legacy_20b_openrouter_mapping_prefers_novita(monkeypatch):
    monkeypatch.delenv("HYPER_OR_IGNORE", raising=False)
    assert _or_model("openai/gpt-oss-20b") == HYPER_FAST_MODEL
    order, ignored = _or_provider_routing(HYPER_FAST_MODEL)
    assert order == ["novita"]
    assert "Novita" not in ignored


def test_openrouter_uses_provider_supported_token_budget_name():
    body = _normalize_openrouter_parameters({"max_completion_tokens": 120, "messages": []})
    assert body["max_tokens"] == 120
    assert "max_completion_tokens" not in body
