from __future__ import annotations

from contextlib import asynccontextmanager
import logging
from urllib.parse import urlparse
from uuid import uuid4

from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse
from sqlalchemy.ext.asyncio import AsyncSession

from agentscope_blaiq.contracts.workflow import ResumeWorkflowRequest, SubmitWorkflowRequest, WorkflowStatus
from agentscope_blaiq.persistence.database import get_db
from agentscope_blaiq.persistence.migrations import bootstrap_database
from agentscope_blaiq.persistence.repositories import ArtifactRepository, UploadRepository, WorkflowRepository
from agentscope_blaiq.runtime.config import settings
from agentscope_blaiq.runtime.hivemind_mcp import HivemindMCPError
from agentscope_blaiq.runtime.registry import AgentRegistry
from agentscope_blaiq.tools.docs import validate_uploaded_document
from agentscope_blaiq.streaming.sse import encode_sse
from agentscope_blaiq.workflows.engine import WorkflowEngine
from .model_resolver import current_litellm_config
from .runtime_checks import check_runtime_ready, check_storage_paths


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings.upload_dir.mkdir(parents=True, exist_ok=True)
    settings.artifact_dir.mkdir(parents=True, exist_ok=True)
    settings.log_dir.mkdir(parents=True, exist_ok=True)
    await bootstrap_database()
    yield


app = FastAPI(title="AgentScope-BLAIQ", version="0.1.0", lifespan=lifespan)

logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
    force=True,
)

# CORS — allow the frontend dev server
_allowed_origins = [
    origin
    for origin in (settings.allowed_origins if hasattr(settings, "allowed_origins") else "").split(",")
    if origin.strip()
] or ["http://localhost:3002", "http://127.0.0.1:3002"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

registry = AgentRegistry()
engine_runner = WorkflowEngine(registry)


class HivemindTestRequest(BaseModel):
    query: str = Field(min_length=1)
    limit: int = Field(default=5, ge=1, le=20)
    mode: str = "insight"


def _parse_hivemind_user_id(rpc_url: str | None) -> str | None:
    if not rpc_url:
        return None
    try:
        path = urlparse(rpc_url).path.strip("/")
        parts = path.split("/")
        if "servers" in parts:
            idx = parts.index("servers")
            if idx + 1 < len(parts):
                return parts[idx + 1]
    except Exception:
        return None
    return None


@app.get("/")
async def root() -> dict[str, str]:
    return {"service": "AgentScope-BLAIQ", "status": "ok"}


@app.get("/healthz")
async def healthz() -> dict[str, object]:
    storage = check_storage_paths(settings.upload_dir, settings.artifact_dir, settings.log_dir)
    return {"status": "ok" if storage.ok else "degraded", "service": "AgentScope-BLAIQ", "storage": storage.details, "issues": storage.issues}


@app.get("/readyz")
async def readyz() -> JSONResponse:
    report = await check_runtime_ready()
    payload = {"status": "ready" if report.ok else "not_ready", "ready": report.ok, "details": report.details, "issues": report.issues}
    if not report.ok:
        return JSONResponse(status_code=503, content=payload)
    return JSONResponse(status_code=200, content=payload)


@app.get("/api/v1/runtime/checks")
async def runtime_checks() -> dict[str, object]:
    report = await check_runtime_ready()
    return {
        "ready": report.ok,
        "checks": report.details,
        "issues": report.issues,
        "model_config": current_litellm_config().as_dict(),
    }


@app.post("/api/v1/workflows/submit")
async def submit_workflow(request: SubmitWorkflowRequest, session: AsyncSession = Depends(get_db)) -> EventSourceResponse:
    if not request.user_query or not request.user_query.strip():
        raise HTTPException(status_code=422, detail="user_query cannot be empty")

    async def event_stream():
        async for payload in encode_sse(engine_runner.run(session, request)):
            yield payload

    return EventSourceResponse(
        event_stream(),
        ping=10,
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@app.post("/api/v1/workflows/resume")
async def resume_workflow(request: ResumeWorkflowRequest, session: AsyncSession = Depends(get_db)) -> EventSourceResponse:
    repo = WorkflowRepository(session)
    workflow = await repo.get_workflow_record(request.thread_id)
    if workflow is None:
        raise HTTPException(status_code=404, detail="Workflow not found")
    if request.tenant_id is not None and request.tenant_id != workflow.tenant_id:
        raise HTTPException(status_code=409, detail="tenant_id does not match the stored workflow")
    snapshot = await repo.get_status(request.thread_id)
    if snapshot is None:
        raise HTTPException(status_code=404, detail="Workflow not found")
    if snapshot.status not in {WorkflowStatus.blocked, WorkflowStatus.error}:
        raise HTTPException(status_code=409, detail="Workflow can only be resumed from blocked or error status")

    async def event_stream():
        async for payload in encode_sse(engine_runner.resume(session, request)):
            yield payload

    return EventSourceResponse(
        event_stream(),
        ping=10,
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@app.get("/api/v1/workflows/{thread_id}/status")
async def workflow_status(thread_id: str, session: AsyncSession = Depends(get_db)):
    snapshot = await WorkflowRepository(session).get_status(thread_id)
    if snapshot is None:
        raise HTTPException(status_code=404, detail="Workflow not found")
    return snapshot


@app.get("/api/v1/agents/live")
async def live_agents():
    return {"agents": registry.list_live()}


@app.get("/api/v1/hivemind/config")
async def hivemind_config():
    client = registry.hivemind
    return {
        "enabled": client.enabled,
        "rpc_url": client.rpc_url,
        "user_id": _parse_hivemind_user_id(client.rpc_url),
        "timeout_seconds": client.timeout_seconds,
        "poll_interval_seconds": client.poll_interval_seconds,
        "poll_attempts": client.poll_attempts,
    }


@app.post("/api/v1/hivemind/test")
async def hivemind_test(request: HivemindTestRequest):
    client = registry.hivemind
    if not client.enabled:
        raise HTTPException(status_code=409, detail="HIVE-MIND MCP is not configured")
    try:
        raw = await client.recall(query=request.query, limit=request.limit, mode=request.mode)
        payload = client._extract_tool_payload(raw)
        memories = []
        for key in ("memories", "results", "items", "data"):
            value = payload.get(key)
            if isinstance(value, list):
                memories = [item for item in value if isinstance(item, dict)]
                break
        preview = [
            {
                "id": item.get("memory_id") or item.get("id"),
                "title": item.get("title") or item.get("name") or "Untitled memory",
                "summary": str(item.get("summary") or item.get("snippet") or item.get("content") or "")[:240],
                "project": item.get("project"),
                "source_type": item.get("source_type"),
            }
            for item in memories[:10]
        ]
        return {
            "ok": True,
            "query": request.query,
            "count": len(memories),
            "preview": preview,
            "raw": payload,
        }
    except HivemindMCPError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.post("/api/v1/upload")
async def upload_file(
    file: UploadFile = File(...),
    tenant_id: str = Form(default="default"),
    thread_id: str | None = Form(default=None),
    session: AsyncSession = Depends(get_db),
):
    if not file.filename:
        raise HTTPException(status_code=422, detail="filename is required")
    upload_id = str(uuid4())
    target_dir = settings.upload_dir / tenant_id
    target_dir.mkdir(parents=True, exist_ok=True)
    target_path = target_dir / file.filename
    content = await file.read()
    if len(content) == 0:
        raise HTTPException(status_code=422, detail="empty uploads cannot be used for research")
    target_path.write_bytes(content)
    validation = validate_uploaded_document(target_path)
    metadata = {"content_length": str(len(content)), "research_validation": validation}
    await UploadRepository(session).save(
        upload_id=upload_id,
        tenant_id=tenant_id,
        filename=file.filename,
        storage_path=str(target_path),
        content_type=file.content_type,
        metadata=metadata,
        thread_id=thread_id,
    )
    return {
        "status": "success",
        "upload_id": upload_id,
        "filename": file.filename,
        "storage_path": str(target_path),
        "tenant_id": tenant_id,
        "research_validation": validation,
    }


@app.get("/api/v1/artifacts/{thread_id}")
async def get_artifact(thread_id: str, session: AsyncSession = Depends(get_db)):
    artifact = await ArtifactRepository(session).get_by_thread(thread_id)
    if artifact is None:
        raise HTTPException(status_code=404, detail="Artifact not found")
    return artifact
