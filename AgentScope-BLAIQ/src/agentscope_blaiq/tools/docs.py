from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from agentscope_blaiq.contracts.evidence import Citation, EvidenceFinding, SourceRecord
from agentscope_blaiq.persistence.repositories import UploadRepository


def validate_uploaded_document(path: Path) -> dict[str, Any]:
    issues: list[str] = []
    details: dict[str, Any] = {"path": str(path)}
    if not path.exists():
        issues.append("file_missing")
        details["ready"] = False
        return {"ready": False, "issues": issues, "details": details}
    raw = path.read_bytes()
    text = raw.decode("utf-8", errors="ignore").strip()
    details["byte_size"] = len(raw)
    details["text_preview"] = text[:240]
    if len(raw) == 0:
        issues.append("empty_file")
    if not text:
        issues.append("unreadable_text")
    details["ready"] = not issues
    return {"ready": not issues, "issues": issues, "details": details}


async def load_uploaded_doc_findings(
    session: AsyncSession,
    tenant_id: str,
    require_ready: bool = False,
) -> tuple[list[SourceRecord], list[EvidenceFinding], list[Citation]]:
    repo = UploadRepository(session)
    uploads = await repo.list_for_tenant(tenant_id)
    sources: list[SourceRecord] = []
    findings: list[EvidenceFinding] = []
    citations: list[Citation] = []
    for upload in uploads:
        source_id = upload.upload_id
        source = SourceRecord(source_id=source_id, source_type="upload", title=upload.filename, location=upload.storage_path)
        sources.append(source)
        path = Path(upload.storage_path)
        validation = validate_uploaded_document(path)
        if require_ready and not validation["ready"]:
            continue
        text = validation["details"].get("text_preview", "")[:500] if validation["details"].get("ready") else ""
        findings.append(
            EvidenceFinding(
                finding_id=f"doc:{source_id}",
                title=upload.filename,
                summary=text[:240] or "Uploaded document available for research.",
                source_ids=[source_id],
                confidence=0.55,
            )
        )
        citations.append(Citation(source_id=source_id, label=upload.filename, excerpt=text[:180] or None))
    return sources, findings, citations
