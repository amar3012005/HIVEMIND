from fastapi.testclient import TestClient

from app.api import app
import app.api as api


def test_liveness_does_not_claim_model_readiness(monkeypatch):
    calls = []

    def unavailable(*, load=True):
        calls.append(load)
        return {"id": "fixture", "loaded": False, "loading": False, "error": "fixture unavailable"}

    monkeypatch.setattr(api, "model_status", unavailable)
    client = TestClient(app)

    assert client.get("/health").status_code == 200
    response = client.get("/ready")
    assert response.status_code == 503
    assert response.json()["detail"]["model"]["loaded"] is False
    assert calls == [False]


def test_readiness_requires_the_pinned_model_to_be_loaded(monkeypatch):
    calls = []

    def loaded(*, load=True):
        calls.append(load)
        return {"id": "fixture", "loaded": True, "loading": False, "error": None}

    monkeypatch.setattr(api, "model_status", loaded)
    response = TestClient(app).get("/ready")

    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert calls == [False]
