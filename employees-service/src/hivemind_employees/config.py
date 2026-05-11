"""Runtime configuration — env vars, parsed once at boot."""
from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Service
    port: int = 8060
    log_level: str = "info"
    replica_id: str = "rep1"
    replica_count: int = 1

    # HIVEMIND
    hivemind_core_url: str = "http://hm-core:3000"
    hivemind_cp_url: str = "http://hm-control:3000"
    hivemind_public_core_url: str = "https://core.hivemind.davinciai.eu:8050"
    hivemind_public_cp_url: str = "https://api.hivemind.davinciai.eu:8040"
    hivemind_master_api_key: str | None = None

    # Shared infra
    database_url: str = "postgresql://hivemind_user:hivemind_secure_pwd_2026@hm-postgres:5432/hivemind?schema=hivemind"
    redis_url: str = "redis://hm-redis:6379/0"

    # Reconcile loop
    reconcile_interval_s: int = 30

    # Default LLM keys (per-employee override via DB later)
    anthropic_api_key: str | None = None
    openai_api_key: str | None = None
    groq_api_key: str | None = None
    openrouter_api_key: str | None = None


def get_settings() -> Settings:
    """Lazy singleton — instantiate at first call (after env is loaded)."""
    global _CACHED
    try:
        return _CACHED  # type: ignore[name-defined]
    except NameError:
        pass
    s = Settings()
    globals()["_CACHED"] = s
    return s
