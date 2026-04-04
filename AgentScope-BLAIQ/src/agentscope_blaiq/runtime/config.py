from __future__ import annotations

from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_env: str = "development"
    log_level: str = "INFO"
    app_host: str = "0.0.0.0"
    app_port: int = 8090
    database_url: str = "sqlite+aiosqlite:///./agentscope_blaiq.db"
    redis_url: str = "redis://localhost:6379/0"
    upload_dir: Path = Field(default=Path("./data/uploads"))
    artifact_dir: Path = Field(default=Path("./data/artifacts"))
    log_dir: Path = Field(default=Path("./logs"))
    default_tenant: str = "default"
    default_source_scope: str = "web"
    default_artifact_type: str = "visual_html"
    litellm_api_base_url: str | None = None
    litellm_api_key: str | None = None
    strategic_model: str = "gemini-2.5-pro"
    research_model: str = "gemini-2.5-pro"
    content_director_model: str = "gemini-2.5-pro"
    hitl_model: str = "vertex_ai/claude-sonnet-4-6@default"
    vangogh_model: str = "vertex_ai/claude-sonnet-4-6@default"
    governance_model: str = "gemini-2.5-pro"
    llm_fallback_model: str | None = "gemini-2.5-flash-lite"
    llm_timeout_seconds: int = 60
    llm_max_output_tokens: int = 1200
    strategic_temperature: float = 0.1
    research_temperature: float = 0.2
    hitl_temperature: float = 0.2
    vangogh_temperature: float = 0.7
    governance_temperature: float = 0.0
    model_reasoning_effort: str | None = None
    openai_api_key: str | None = None
    openai_api_base_url: str | None = None
    groq_api_key: str | None = None
    groq_api_base_url: str | None = None
    enable_graph_agent: bool = False
    hivemind_mcp_rpc_url: str | None = None
    hivemind_api_key: str | None = None
    hivemind_timeout_seconds: int = 20
    hivemind_web_poll_interval_seconds: float = 1.0
    hivemind_web_poll_attempts: int = 10


settings = Settings()
