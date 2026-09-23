from __future__ import annotations

import asyncio
import json

from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse

from app.contracts import AnalyzeRequest, AnalyzeResponse
from app.entities import MODEL_ID, MODEL_REVISION, model_status
from app.pipeline import PIPELINE_VERSION, analyze, canonical_hash

app = FastAPI(title="HIVE-MIND Understand", version="0.1.0")
_semaphore = asyncio.Semaphore(2)


@app.get("/health")
def health():
    return {"ok": True, "service": "hm-understand", "version": PIPELINE_VERSION}


@app.get("/ready")
def ready():
    status = model_status()
    return {"ok": status["loaded"], "model": status}


@app.get("/v1/capabilities")
def capabilities():
    status = model_status(load=False)
    return {
        "schema_version": "1", "pipeline_version": PIPELINE_VERSION,
        "entity_model": {"id": MODEL_ID, "revision": MODEL_REVISION, "loaded": status["loaded"]},
        "language_detection": "langid.py 1.1.6 (97 language labels; raw ranking scores are not probabilities)",
        "audio_video": False, "max_blocks": 100, "max_block_chars": 100_000,
        "entity_types": ["person", "organization", "location", "product", "project", "date", "money", "custom"],
    }


@app.post("/v1/analyze")
async def analyze_route(request: AnalyzeRequest):
    async with _semaphore:
        try:
            return await asyncio.to_thread(analyze, request)
        except Exception as error:
            raise HTTPException(status_code=422, detail=f"analysis_failed:{type(error).__name__}") from error


@app.post("/v1/analyze/stream")
async def analyze_stream(request: AnalyzeRequest):
    async def events():
        async with _semaphore:
            try:
                blocks = []
                complete = True
                started = asyncio.get_running_loop().time()
                for source_block in request.blocks:
                    partial = await asyncio.to_thread(
                        analyze, request.model_copy(update={"blocks": [source_block]}),
                    )
                    block_result = partial.blocks[0]
                    blocks.append(block_result)
                    complete = complete and partial.complete
                    yield f"event: block\ndata: {block_result.model_dump_json()}\n\n"
                status = model_status()
                result = AnalyzeResponse(
                    source_id=request.source.id, source_revision=request.source.revision,
                    content_hash=request.source.content_hash or canonical_hash(request),
                    pipeline_version=PIPELINE_VERSION,
                    model_versions={
                        "entity": f"{status['id']}@{status['revision']}" if status["loaded"] else None,
                        "language": "langid-1.1.6" if any(b.language.get("source", "").startswith("langid") for b in blocks) else None,
                    },
                    complete=complete, blocks=blocks,
                    totals={"blocks": len(blocks), "mentions": sum(len(b.mentions) for b in blocks),
                            "candidates": sum(len(b.candidates) for b in blocks),
                            "processing_ms": max(0, int((asyncio.get_running_loop().time() - started) * 1000))},
                )
                yield f"event: final\ndata: {result.model_dump_json()}\n\n"
            except Exception as error:
                payload = json.dumps({"code": "analysis_failed", "kind": type(error).__name__})
                yield f"event: error\ndata: {payload}\n\n"
    return StreamingResponse(events(), media_type="text/event-stream", headers={"cache-control": "no-cache"})
