from __future__ import annotations

from types import SimpleNamespace

import pytest

from agentscope_blaiq.tools import docs


def test_validate_uploaded_document(tmp_path):
    path = tmp_path / "doc.txt"
    path.write_text("Research-ready text.", encoding="utf-8")
    result = docs.validate_uploaded_document(path)
    assert result["ready"] is True
    assert result["details"]["byte_size"] > 0


@pytest.mark.asyncio
async def test_load_uploaded_doc_findings_respects_readiness(monkeypatch, tmp_path):
    path = tmp_path / "good.txt"
    path.write_text("Useful research content.", encoding="utf-8")

    class FakeUploadRepo:
        def __init__(self, session):
            self.session = session

        async def list_for_tenant(self, tenant_id):
            return [
                SimpleNamespace(upload_id="u1", filename="good.txt", storage_path=str(path)),
                SimpleNamespace(upload_id="u2", filename="bad.txt", storage_path=str(tmp_path / "missing.txt")),
            ]

    monkeypatch.setattr(docs, "UploadRepository", FakeUploadRepo)

    sources, findings, citations = await docs.load_uploaded_doc_findings(session=object(), tenant_id="tenant-a", require_ready=True)
    assert len(sources) == 2
    assert len(findings) == 1
    assert citations[0].label == "good.txt"
