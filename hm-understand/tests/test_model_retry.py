import app.entities as entities


def test_failed_model_load_retries_after_bounded_backoff(monkeypatch):
    monkeypatch.setattr(entities, "_model_attempted", False)
    monkeypatch.setattr(entities, "_model_load_failures", 0)
    monkeypatch.setattr(entities, "_model_retry_after", 0.0)
    now = 100.0

    assert entities._model_retry_ready(now)
    delay = entities._record_model_load_failure(ConnectionError("registry unavailable"), now)
    assert delay == entities.MODEL_RETRY_BASE_SECONDS
    assert entities._model_retry_ready(now + delay - 0.01) is False
    assert entities._model_retry_ready(now + delay) is True

    next_delay = entities._record_model_load_failure(TimeoutError("download timeout"), now + delay + 1)
    assert next_delay == entities.MODEL_RETRY_BASE_SECONDS * 2
    assert entities._model_retry_ready(now + delay + 1 + next_delay - 0.01) is False
    assert entities._model_retry_ready(now + delay + 1 + next_delay) is True


def test_model_retry_backoff_is_capped(monkeypatch):
    monkeypatch.setattr(entities, "_model_attempted", False)
    monkeypatch.setattr(entities, "_model_load_failures", 0)
    now = 0.0
    for _ in range(10):
        delay = entities._record_model_load_failure(RuntimeError("fixture"), now)
        now += delay
    assert delay == entities.MODEL_RETRY_MAX_SECONDS
