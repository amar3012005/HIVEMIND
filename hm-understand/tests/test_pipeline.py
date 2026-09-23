from app.contracts import AnalyzeRequest
from app.pipeline import analyze


def test_candidate_evidence_offsets_and_uncertainty(monkeypatch):
    monkeypatch.setattr("app.pipeline.model_status", lambda: {"loaded": False})
    monkeypatch.setattr("app.pipeline.extract_entities", lambda text, labels: [])
    text = "Rama did not approve the €12,000 budget for Project Atlas. Launch may happen in October."
    request = AnalyzeRequest.model_validate({
        "source": {"id": "doc-1", "revision": "r1"},
        "blocks": [{"id": "p1", "text": text, "locator": {"page": 2}}],
    })

    result = analyze(request)
    block = result.blocks[0]
    assert result.complete is False
    assert any(item.text == "€12,000" and item.label == "money" for item in block.mentions)
    assert any(item.kind == "uncertain" and "negation" in item.signals for item in block.candidates)
    assert any(item.kind == "uncertain" and "uncertainty_or_condition" in item.signals for item in block.candidates)
    for item in [*block.mentions, *block.candidates]:
        quote = item.evidence.quote
        assert text[item.evidence.start:item.evidence.end] == quote
        assert item.evidence.locator.page == 2


def test_short_input_is_not_falsely_assigned_language(monkeypatch):
    monkeypatch.setattr("app.pipeline.model_status", lambda: {"loaded": False})
    monkeypatch.setattr("app.pipeline.extract_entities", lambda text, labels: [])
    request = AnalyzeRequest.model_validate({
        "source": {"id": "note", "revision": "1"},
        "blocks": [{"id": "b", "text": "€12,000"}],
    })
    result = analyze(request)
    assert result.blocks[0].language["primary"] == "und"
    assert any(mention.label == "money" for mention in result.blocks[0].mentions)
    assert result.blocks[0].quality["refinement_required"] is True
    assert "local_entity_model_unavailable" in result.blocks[0].quality["refinement_reasons"]


def test_refinement_signal_marks_unvalidated_language_and_uncertainty(monkeypatch):
    monkeypatch.setattr("app.pipeline.model_status", lambda: {"loaded": True, "loaded_tensors": 1,
                                                                 "checkpoint_tensors": 1})
    monkeypatch.setattr("app.pipeline.extract_entities", lambda text, labels: [])
    text = "Rama शायद अक्टूबर में Project Atlas launch करेगी, लेकिन approval अभी pending है।"
    request = AnalyzeRequest.model_validate({
        "source": {"id": "doc-hi", "revision": "r1"},
        "blocks": [{"id": "p1", "text": text, "language": "hi"}],
    })
    block = analyze(request).blocks[0]
    assert block.quality["refinement_required"] is True
    assert "language_outside_smoke_set" in block.quality["refinement_reasons"]
    assert all(text[item.evidence.start:item.evidence.end] == item.evidence.quote
               for item in [*block.mentions, *block.candidates])


def test_evaluated_language_with_clear_statement_does_not_require_refinement(monkeypatch):
    monkeypatch.setattr("app.pipeline.model_status", lambda: {"loaded": True, "loaded_tensors": 1,
                                                                 "checkpoint_tensors": 1})
    monkeypatch.setattr("app.pipeline.extract_entities", lambda text, labels: [
        {"text": "Rama", "label": "person", "score": 0.9, "start": 0, "end": 4, "extractor": "gliner"},
    ])
    request = AnalyzeRequest.model_validate({
        "source": {"id": "doc-en", "revision": "r1"},
        "blocks": [{"id": "p1", "text": "Rama approved the annual plan for Project Atlas today.",
                    "language": "en"}],
    })
    block = analyze(request).blocks[0]
    assert block.quality["refinement_required"] is False
    assert block.quality["refinement_reasons"] == []


def test_candidate_without_model_entity_is_refinement_required(monkeypatch):
    monkeypatch.setattr("app.pipeline.model_status", lambda: {"loaded": True, "loaded_tensors": 1,
                                                                 "checkpoint_tensors": 1})
    monkeypatch.setattr("app.pipeline.extract_entities", lambda text, labels: [])
    request = AnalyzeRequest.model_validate({
        "source": {"id": "doc-en-unanchored", "revision": "r1"},
        "blocks": [{"id": "p1", "text": "The board approved a 12000 EUR budget for the new launch.",
                    "language": "en"}],
    })
    block = analyze(request).blocks[0]
    assert block.quality["refinement_required"] is True
    assert "candidate_without_model_entity_anchor" in block.quality["refinement_reasons"]


def test_spanish_condition_is_not_promoted_as_a_fact_candidate():
    from app.extractors import extract_candidates
    text = "El lanzamiento podría ocurrir en octubre, sujeto a revisión de seguridad."
    candidates = extract_candidates(text)
    assert len(candidates) == 1
    assert candidates[0]["kind"] == "uncertain"
    assert "uncertainty_or_condition" in candidates[0]["signals"]


def test_capitalization_fallback_avoids_sentence_initial_common_words():
    from app.extractors import extract_literals
    text = "On Tuesday, Budget owners asked Nora Klein about Project Atlas and FIN-042."
    candidates = [item["text"] for item in extract_literals(text)
                  if item["label"] == "proper_name_candidate"]
    assert "Nora Klein" in candidates
    assert "Project Atlas" in candidates
    assert "FIN" in candidates
    assert "On" not in candidates
    assert "Budget" not in candidates


def test_currency_code_is_not_a_proper_name_candidate():
    from app.extractors import extract_literals
    text = "Rama approved a EUR 12000 budget for Project Atlas."
    candidates = [item["text"] for item in extract_literals(text)
                  if item["label"] == "proper_name_candidate"]
    assert "Rama" not in candidates
    assert "EUR" not in candidates
    assert "Project Atlas" in candidates


def test_hash_is_stable_for_same_source_content():
    import app.pipeline as pipeline
    pipeline.model_status = lambda: {"loaded": False}
    pipeline.extract_entities = lambda text, labels: []
    request = AnalyzeRequest.model_validate({
        "source": {"id": "doc", "revision": "1"},
        "blocks": [{"id": "b", "text": "The team selected Project Atlas after review."}],
    })
    assert analyze(request).content_hash == analyze(request).content_hash


def test_checkpoint_sha256_matches_pinned_digest(tmp_path):
    import hashlib
    from app.entities import checkpoint_sha256
    path = tmp_path / "weights.safetensors"
    payload = b"pinned-model-checkpoint-fixture"
    path.write_bytes(payload)
    assert checkpoint_sha256(path) == hashlib.sha256(payload).hexdigest()


def test_model_cpu_threads_are_clamped_to_container_budget():
    from app.entities import configure_cpu_threads

    class TorchThreadSettings:
        intra = None
        inter = None

        @classmethod
        def set_num_threads(cls, value):
            cls.intra = value

        @classmethod
        def set_num_interop_threads(cls, value):
            cls.inter = value

    assert configure_cpu_threads(TorchThreadSettings, 10) == 4
    assert TorchThreadSettings.intra == 4
    assert TorchThreadSettings.inter == 1
    assert configure_cpu_threads(TorchThreadSettings, 0) == 1


def test_large_block_windows_cover_tail_and_keep_offsets(monkeypatch):
    monkeypatch.setattr("app.pipeline.model_status", lambda: {"loaded": False})
    monkeypatch.setattr("app.pipeline.extract_entities", lambda text, labels: [])
    from app.pipeline import _windows
    text = "A sentence about Project Atlas and a planned launch. " * 120
    windows = _windows(text, limit=500)
    assert windows[0][0] == 0
    assert windows[-1][1] == len(text)
    assert all(end > start for start, end in windows)


def test_stream_emits_each_completed_block_before_final(monkeypatch):
    from fastapi.testclient import TestClient
    import app.api as api

    calls = []

    def fake_analyze(request):
        calls.append(request.blocks[0].id)
        monkeypatch.setattr("app.pipeline.model_status", lambda: {"loaded": False})
        monkeypatch.setattr("app.pipeline.extract_entities", lambda text, labels: [])
        return analyze(request)

    monkeypatch.setattr(api, "analyze", fake_analyze)
    monkeypatch.setattr(api, "model_status", lambda: {"id": "test", "revision": "r1", "loaded": False})
    request = {
        "source": {"id": "stream-doc", "revision": "r1"},
        "blocks": [{"id": "p1", "text": "Rama approved the launch plan for Project Atlas."},
                   {"id": "p2", "text": "The review happens in October after the security test."}],
    }
    response = TestClient(api.app).post("/v1/analyze/stream", json=request)
    events = [line for line in response.text.splitlines() if line.startswith("event:")]
    assert response.status_code == 200
    assert calls == ["p1", "p2"]
    assert events == ["event: block", "event: block", "event: final"]
