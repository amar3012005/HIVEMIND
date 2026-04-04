from __future__ import annotations

from pathlib import Path

from agentscope_blaiq.app import runtime_checks


def test_compose_has_litellm_parity_and_minimal_stack():
    compose = Path("/Users/amar/blaiq/AgentScope-BLAIQ/deployment/docker-compose.coolify.yml").read_text(encoding="utf-8")
    assert "services:" in compose
    assert "app:" in compose
    assert "postgres:" in compose
    assert "redis:" in compose
    assert "python /app/deployment/bootstrap.py --migrate" in compose
    assert "APP_HOST" in compose
    assert "APP_PORT" in compose
    assert "APP_DATABASE_URL" in compose
    assert "APP_REDIS_URL" in compose
    assert "LITELLM_PLANNER_MODEL" in compose
    assert "LITELLM_PRE_MODEL" in compose
    assert "LITELLM_POST_MODEL" in compose
    assert "LITELLM_REFORMAT_MODEL" in compose
    assert "LITELLM_API_BASE_URL" in compose
    assert "LITELLM_API_KEY" in compose
    assert "MODEL_REASONING_EFFORT" in compose
    assert "OPENAI_FALLBACK_MODEL" in compose
    assert "/readyz" in compose
    assert "qdrant" not in compose.lower()
    assert "neo4j" not in compose.lower()
    assert "temporal" not in compose.lower()


def test_env_example_has_model_routing_defaults():
    env_example = Path("/Users/amar/blaiq/AgentScope-BLAIQ/deployment/.env.example").read_text(encoding="utf-8")
    assert "APP_HOST" in env_example
    assert "APP_PORT" in env_example
    assert "APP_DATABASE_URL" in env_example
    assert "APP_REDIS_URL" in env_example
    assert "LITELLM_PLANNER_MODEL" in env_example
    assert "LITELLM_PRE_MODEL" in env_example
    assert "LITELLM_POST_MODEL" in env_example
    assert "LITELLM_REFORMAT_MODEL" in env_example
    assert "LITELLM_API_BASE_URL" in env_example
    assert "LITELLM_API_KEY" in env_example
    assert "MODEL_REASONING_EFFORT" in env_example
    assert "OPENAI_FALLBACK_MODEL" in env_example
    assert "STRATEGIC_MODEL" in env_example
    assert "RESEARCH_MODEL" in env_example
    assert "VANGOGH_MODEL" in env_example
    assert "GOVERNANCE_MODEL" in env_example


def test_bootstrap_script_is_present_and_migrates():
    bootstrap = Path("/Users/amar/blaiq/AgentScope-BLAIQ/deployment/bootstrap.py").read_text(encoding="utf-8")
    assert "--migrate" in bootstrap
    assert "create_all" in bootstrap
    assert "ensure_runtime_paths" in bootstrap


def test_model_env_reports_proxy_and_runtime_metadata(monkeypatch):
    monkeypatch.setenv("STRATEGIC_MODEL", "openai/gpt-4o-mini")
    monkeypatch.setenv("RESEARCH_MODEL", "gemini/gemini-2.5-pro")
    monkeypatch.setenv("VANGOGH_MODEL", "vertex_ai/claude-sonnet-4-6@default")
    monkeypatch.setenv("GOVERNANCE_MODEL", "openai/gpt-4o-mini")
    monkeypatch.setenv("LITELLM_PLANNER_MODEL", "gpt-4o-mini")
    monkeypatch.setenv("LITELLM_PRE_MODEL", "gpt-4o-mini")
    monkeypatch.setenv("LITELLM_POST_MODEL", "gpt-4o-mini")
    monkeypatch.setenv("LITELLM_REFORMAT_MODEL", "gpt-4o-mini")
    monkeypatch.setenv("LITELLM_API_BASE_URL", "http://litellm:4000/v1")
    monkeypatch.setenv("MODEL_REASONING_EFFORT", "medium")
    monkeypatch.setattr(runtime_checks.settings, "litellm_api_key", "test-key")
    monkeypatch.setattr(runtime_checks.settings, "openai_api_key", None)
    monkeypatch.setattr(runtime_checks.settings, "model_reasoning_effort", "medium")

    report = runtime_checks.check_model_env()
    assert report.ok is True
    assert report.details["api_base_url"] == "http://litellm:4000/v1"
    assert report.details["api_key_present"] is True
    assert report.details["runtime"]["reasoning_effort"] == "medium"
    assert report.details["models"]["strategic"]["provider_prefixed"] is True
    assert report.details["models"]["research"]["provider"] == "gemini"
