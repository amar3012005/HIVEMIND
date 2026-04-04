from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from agentscope_blaiq.app import main
from agentscope_blaiq.app.runtime_checks import CheckReport


class FakeBegin:
    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def run_sync(self, fn):
        return None


class FakeEngine:
    def begin(self):
        return FakeBegin()


class FakeSession:
    def __init__(self):
        self.saved = []
        self.commits = 0

    def add(self, obj):
        self.saved.append(obj)

    async def commit(self):
        self.commits += 1


def test_health_and_ready_routes(monkeypatch, tmp_path):
    bootstrap_called = {"value": False}

    async def fake_bootstrap_database(engine=None):
        bootstrap_called["value"] = True

    monkeypatch.setattr(main, "bootstrap_database", fake_bootstrap_database)
    monkeypatch.setattr(main, "check_storage_paths", lambda *args, **kwargs: CheckReport(ok=True, details={"upload_dir": {"writable": True}}, issues=[]))
    async def fake_runtime_ready():
        return CheckReport(ok=True, details={"storage": {}, "database": {}, "redis": {}, "models": {}}, issues=[])

    monkeypatch.setattr(main, "check_runtime_ready", fake_runtime_ready)
    monkeypatch.setattr(main.settings, "upload_dir", tmp_path / "uploads")
    monkeypatch.setattr(main.settings, "artifact_dir", tmp_path / "artifacts")
    monkeypatch.setattr(main.settings, "log_dir", tmp_path / "logs")

    with TestClient(main.app) as client:
        assert bootstrap_called["value"] is True
        health = client.get("/healthz")
        assert health.status_code == 200
        assert health.json()["status"] == "ok"

        ready = client.get("/readyz")
        assert ready.status_code == 200
        assert ready.json()["ready"] is True


def test_runtime_checks_expose_litellm_env(monkeypatch):
    async def fake_bootstrap_database(engine=None):
        return None

    monkeypatch.setattr(main, "bootstrap_database", fake_bootstrap_database)
    async def fake_runtime_ready():
        return CheckReport(ok=True, details={"storage": {}, "database": {}, "redis": {}, "models": {}}, issues=[])

    monkeypatch.setattr(main, "check_runtime_ready", fake_runtime_ready)
    monkeypatch.setenv("STRATEGIC_MODEL", "gpt-4o-mini")
    monkeypatch.setenv("RESEARCH_MODEL", "gpt-4o-mini")
    monkeypatch.setenv("VANGOGH_MODEL", "gpt-4o-mini")
    monkeypatch.setenv("GOVERNANCE_MODEL", "gpt-4o-mini")
    monkeypatch.setenv("LITELLM_PLANNER_MODEL", "gpt-4o-mini")
    monkeypatch.setenv("LITELLM_PRE_MODEL", "gpt-4o-mini")
    monkeypatch.setenv("LITELLM_POST_MODEL", "gpt-4o-mini")
    monkeypatch.setenv("OPENAI_FALLBACK_MODEL", "gpt-4o-mini")

    with TestClient(main.app) as client:
        response = client.get("/api/v1/runtime/checks")
        assert response.status_code == 200
        payload = response.json()
        assert payload["ready"] is True
        assert payload["model_config"]["planner_model"] == "gpt-4o-mini"
        assert payload["model_config"]["fallback_model"] == "gpt-4o-mini"


def test_upload_route_returns_research_validation(monkeypatch, tmp_path):
    async def fake_bootstrap_database(engine=None):
        return None

    monkeypatch.setattr(main, "bootstrap_database", fake_bootstrap_database)
    fake_session = FakeSession()
    original_get_db = main.get_db

    async def fake_get_db():
        yield fake_session

    main.app.dependency_overrides[original_get_db] = fake_get_db
    monkeypatch.setattr(main.settings, "upload_dir", tmp_path / "uploads")
    monkeypatch.setattr(main.settings, "artifact_dir", tmp_path / "artifacts")
    monkeypatch.setattr(main.settings, "log_dir", tmp_path / "logs")

    try:
        with TestClient(main.app) as client:
            response = client.post(
                "/api/v1/upload",
                data={"tenant_id": "tenant-a"},
                files={"file": ("report.txt", b"AgentScope is ready for research.", "text/plain")},
            )
            assert response.status_code == 200
            payload = response.json()
            assert payload["research_validation"]["ready"] is True
            assert Path(payload["storage_path"]).exists()
    finally:
        main.app.dependency_overrides.clear()


def test_upload_rejects_empty_file(monkeypatch, tmp_path):
    async def fake_bootstrap_database(engine=None):
        return None

    monkeypatch.setattr(main, "bootstrap_database", fake_bootstrap_database)
    fake_session = FakeSession()
    original_get_db = main.get_db

    async def fake_get_db():
        yield fake_session

    main.app.dependency_overrides[original_get_db] = fake_get_db
    monkeypatch.setattr(main.settings, "upload_dir", tmp_path / "uploads")
    monkeypatch.setattr(main.settings, "artifact_dir", tmp_path / "artifacts")
    monkeypatch.setattr(main.settings, "log_dir", tmp_path / "logs")

    try:
        with TestClient(main.app) as client:
            response = client.post(
                "/api/v1/upload",
                data={"tenant_id": "tenant-a"},
                files={"file": ("empty.txt", b"", "text/plain")},
            )
            assert response.status_code == 422
    finally:
        main.app.dependency_overrides.clear()
