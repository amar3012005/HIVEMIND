from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient

from agentscope_blaiq.app import main
from agentscope_blaiq.agents.governance import GovernanceReport
from agentscope_blaiq.contracts.artifact import ArtifactSection, PreviewMetadata, VisualArtifact
from agentscope_blaiq.contracts.evidence import Citation, EvidenceFinding, EvidencePack, SourceRecord
from agentscope_blaiq.contracts.workflow import (
    AgentRunPayload,
    AgentType,
    ArtifactFamily,
    ArtifactSpec,
    RequirementItem,
    RequirementStage,
    RequirementsChecklist,
    WorkflowMode,
    WorkflowPlan,
)
from agentscope_blaiq.persistence import database as database_module


def _parse_sse_payloads(raw_text: str) -> list[dict]:
    payloads: list[dict] = []
    for line in raw_text.splitlines():
        chunk = line.strip()
        if not chunk or not chunk.startswith("data: "):
            continue
        data = chunk[len("data: ") :].strip()
        while data.startswith("data: "):
            data = data[len("data: ") :].strip()
        if data == "[DONE]":
            continue
        payloads.append(json.loads(data))
    return payloads


def test_end_to_end_hybrid_workflow_with_upload(monkeypatch, tmp_path):
    db_path = tmp_path / "agentscope-e2e.db"
    upload_dir = tmp_path / "uploads"
    artifact_dir = tmp_path / "artifacts"
    log_dir = tmp_path / "logs"

    monkeypatch.setattr(main.settings, "database_url", f"sqlite+aiosqlite:///{db_path}")
    monkeypatch.setattr(main.settings, "upload_dir", upload_dir)
    monkeypatch.setattr(main.settings, "artifact_dir", artifact_dir)
    monkeypatch.setattr(main.settings, "log_dir", log_dir)
    monkeypatch.setattr(main.settings, "redis_url", "redis://127.0.0.1:6399/15")

    database_module._engine = None
    database_module._session_local = None
    main.engine_runner.session_factory = database_module.get_session_local()

    async def fake_build_plan(request):
        return WorkflowPlan(
            workflow_mode=WorkflowMode.hybrid,
            summary="Hybrid research then artifact generation",
            tasks=[
                AgentRunPayload(agent_type=AgentType.research, purpose="Research web", branch_key="web"),
                AgentRunPayload(agent_type=AgentType.research, purpose="Research docs", branch_key="docs"),
                AgentRunPayload(agent_type=AgentType.vangogh, purpose="Generate visual"),
                AgentRunPayload(agent_type=AgentType.governance, purpose="Review"),
            ],
            fan_in_required=True,
        )

    async def fake_gather(session, tenant_id, query, scope):
        if scope == "docs":
            stored_path = upload_dir / tenant_id / "brief.txt"
            assert stored_path.exists(), "docs branch should see uploaded doc file for tenant"
            source = SourceRecord(source_id="upload:brief.txt", source_type="upload", title="brief.txt", location=str(stored_path))
            finding = EvidenceFinding(
                finding_id="doc:brief.txt",
                title="brief.txt",
                summary="Uploaded document provided enterprise architecture notes.",
                source_ids=[source.source_id],
                confidence=0.72,
            )
            citation = Citation(source_id=source.source_id, label="brief.txt", excerpt="Enterprise architecture notes.")
            return EvidencePack(
                summary="Document evidence confirmed internal architecture constraints.",
                sources=[source],
                doc_findings=[finding],
                confidence=0.72,
                citations=[citation],
            )

        source = SourceRecord(
            source_id="https://docs.agentscope.io/",
            source_type="web",
            title="AgentScope Docs",
            location="https://docs.agentscope.io/",
        )
        finding = EvidenceFinding(
            finding_id="web:agentscope",
            title="AgentScope Docs",
            summary="AgentScope provides ReAct agents, toolkits, and orchestration patterns.",
            source_ids=[source.source_id],
            confidence=0.81,
        )
        citation = Citation(
            source_id=source.source_id,
            label="AgentScope Docs",
            excerpt="ReAct agents, toolkits, and orchestration patterns.",
            url=source.location,
        )
        return EvidencePack(
            summary="Web evidence confirmed the runtime primitives available in AgentScope.",
            sources=[source],
            web_findings=[finding],
            confidence=0.81,
            citations=[citation],
        )

    async def fake_plan_content(*, user_query, evidence_summary, artifact_spec, requirements, hitl_answers=None):
        class _Brief:
            def model_dump(self_inner):
                return {
                    "title": user_query,
                    "family": getattr(getattr(artifact_spec, "family", None), "value", "custom"),
                    "template_name": "default",
                    "narrative": evidence_summary,
                    "section_plan": [],
                    "distribution_notes": [],
                    "handoff_notes": [],
                }

        return _Brief()

    async def fake_generate(user_query, evidence, content_brief=None):
        return VisualArtifact(
            artifact_id="artifact-e2e-1",
            title="AgentScope-BLAIQ Hybrid Workflow",
            sections=[
                ArtifactSection(
                    section_id="hero",
                    section_index=0,
                    title="Hero",
                    summary="High-level architecture view.",
                    html_fragment="<section><h1>AgentScope-BLAIQ Hybrid Workflow</h1></section>",
                    section_data={"kind": "hero"},
                ),
                ArtifactSection(
                    section_id="evidence",
                    section_index=1,
                    title="Evidence",
                    summary="Merged web and document evidence.",
                    html_fragment="<section><p>Merged evidence</p></section>",
                    section_data={"citations": str(len(evidence.citations))},
                ),
            ],
            theme={"palette": "sandstone", "mood": "executive"},
            evidence_refs=[citation.source_id for citation in evidence.citations],
            html="<!doctype html><html><body><section>Hybrid workflow</section></body></html>",
            css="body{font-family:system-ui;}",
            preview_metadata=PreviewMetadata(theme_notes=["E2E test artifact"]),
        )

    async def fake_review(artifact, evidence):
        return GovernanceReport(
            approved=True,
            issues=[],
            readiness_score=0.96,
            notes=["Ready for review."],
        )

    monkeypatch.setattr(main.registry.strategist, "build_plan", fake_build_plan)
    monkeypatch.setattr(main.registry.research, "gather", fake_gather)
    monkeypatch.setattr(main.registry.content_director, "plan_content", fake_plan_content)
    monkeypatch.setattr(main.registry.vangogh, "generate", fake_generate)
    monkeypatch.setattr(main.registry.governance, "review", fake_review)

    thread_id = "thread-e2e-001"
    tenant_id = "tenant-e2e"

    with TestClient(main.app) as client:
        upload_response = client.post(
            "/api/v1/upload",
            data={"tenant_id": tenant_id, "thread_id": thread_id},
            files={"file": ("brief.txt", b"Internal architecture notes for AgentScope-BLAIQ.", "text/plain")},
        )
        assert upload_response.status_code == 200
        upload_payload = upload_response.json()
        assert upload_payload["research_validation"]["ready"] is True

        with client.stream(
            "POST",
            "/api/v1/workflows/submit",
            json={
                "user_query": "Build a hybrid architecture visual for AgentScope-BLAIQ.",
                "workflow_mode": "hybrid",
                "tenant_id": tenant_id,
                "session_id": "session-e2e-001",
                "thread_id": thread_id,
                "artifact_type": "visual_html",
                "source_scope": "web_and_docs",
            },
        ) as response:
            assert response.status_code == 200
            stream_text = "".join(response.iter_text())

        events = _parse_sse_payloads(stream_text)
        event_types = [event["type"] for event in events]
        assert event_types[0] == "workflow_submitted"
        assert "planning_complete" in event_types
        assert event_types.count("parallel_branch_started") >= 2
        assert "fanin_completed" in event_types
        assert "artifact_ready" in event_types
        assert event_types.count("artifact_section_ready") == 2
        assert "governance_complete" in event_types
        assert event_types[-1] == "workflow_complete"

        final_event = events[-1]
        assert final_event["data"]["final_artifact"]["title"] == "AgentScope-BLAIQ Hybrid Workflow"
        assert final_event["data"]["governance_report"]["approved"] is True

        status_response = client.get(f"/api/v1/workflows/{thread_id}/status")
        assert status_response.status_code == 200
        status_payload = status_response.json()
        assert status_payload["status"] == "complete"
        assert status_payload["latest_event"] == "workflow_complete"
        assert status_payload["final_artifact"]["governance_status"] == "approved"

        artifact_response = client.get(f"/api/v1/artifacts/{thread_id}")
        assert artifact_response.status_code == 200
        artifact_payload = artifact_response.json()
        assert artifact_payload["title"] == "AgentScope-BLAIQ Hybrid Workflow"
        assert artifact_payload["evidence_refs"]

        artifact_html = artifact_dir / thread_id / "artifact.html"
        artifact_css = artifact_dir / thread_id / "artifact.css"
        assert artifact_html.exists()
        assert artifact_css.exists()
        assert "Hybrid workflow" in artifact_html.read_text(encoding="utf-8")


def test_resume_workflow_retries_after_transient_error(monkeypatch, tmp_path):
    db_path = tmp_path / "agentscope-e2e-resume.db"
    upload_dir = tmp_path / "uploads"
    artifact_dir = tmp_path / "artifacts"
    log_dir = tmp_path / "logs"

    monkeypatch.setattr(main.settings, "database_url", f"sqlite+aiosqlite:///{db_path}")
    monkeypatch.setattr(main.settings, "upload_dir", upload_dir)
    monkeypatch.setattr(main.settings, "artifact_dir", artifact_dir)
    monkeypatch.setattr(main.settings, "log_dir", log_dir)
    monkeypatch.setattr(main.settings, "redis_url", "redis://127.0.0.1:6399/15")

    database_module._engine = None
    database_module._session_local = None
    main.engine_runner.session_factory = database_module.get_session_local()

    async def fake_build_plan(request):
        return WorkflowPlan(
            workflow_mode=WorkflowMode.hybrid,
            summary="Hybrid research then artifact generation",
            tasks=[
                AgentRunPayload(agent_type=AgentType.research, purpose="Research web", branch_key="web"),
                AgentRunPayload(agent_type=AgentType.research, purpose="Research docs", branch_key="docs"),
                AgentRunPayload(agent_type=AgentType.vangogh, purpose="Generate visual"),
                AgentRunPayload(agent_type=AgentType.governance, purpose="Review"),
            ],
            fan_in_required=True,
        )

    call_state = {"web_calls": 0}

    async def fake_gather(session, tenant_id, query, scope):
        if scope == "docs":
            stored_path = upload_dir / tenant_id / "brief.txt"
            assert stored_path.exists()
            source = SourceRecord(source_id="upload:brief.txt", source_type="upload", title="brief.txt", location=str(stored_path))
            finding = EvidenceFinding(
                finding_id="doc:brief.txt",
                title="brief.txt",
                summary="Uploaded document provided enterprise architecture notes.",
                source_ids=[source.source_id],
                confidence=0.72,
            )
            citation = Citation(source_id=source.source_id, label="brief.txt", excerpt="Enterprise architecture notes.")
            return EvidencePack(
                summary="Document evidence confirmed internal architecture constraints.",
                sources=[source],
                doc_findings=[finding],
                confidence=0.72,
                citations=[citation],
            )

        call_state["web_calls"] += 1
        if call_state["web_calls"] == 1:
            raise RuntimeError("transient web outage")

        source = SourceRecord(
            source_id="https://docs.agentscope.io/",
            source_type="web",
            title="AgentScope Docs",
            location="https://docs.agentscope.io/",
        )
        finding = EvidenceFinding(
            finding_id="web:agentscope",
            title="AgentScope Docs",
            summary="AgentScope provides ReAct agents, toolkits, and orchestration patterns.",
            source_ids=[source.source_id],
            confidence=0.81,
        )
        citation = Citation(
            source_id=source.source_id,
            label="AgentScope Docs",
            excerpt="ReAct agents, toolkits, and orchestration patterns.",
            url=source.location,
        )
        return EvidencePack(
            summary="Web evidence confirmed the runtime primitives available in AgentScope.",
            sources=[source],
            web_findings=[finding],
            confidence=0.81,
            citations=[citation],
        )

    async def fake_plan_content(*, user_query, evidence_summary, artifact_spec, requirements, hitl_answers=None):
        class _Brief:
            def model_dump(self_inner):
                return {
                    "title": user_query,
                    "family": getattr(getattr(artifact_spec, "family", None), "value", "custom"),
                    "template_name": "default",
                    "narrative": evidence_summary,
                    "section_plan": [],
                    "distribution_notes": [],
                    "handoff_notes": [],
                }

        return _Brief()

    async def fake_generate(user_query, evidence, content_brief=None):
        return VisualArtifact(
            artifact_id="artifact-e2e-1",
            title="AgentScope-BLAIQ Hybrid Workflow",
            sections=[
                ArtifactSection(
                    section_id="hero",
                    section_index=0,
                    title="Hero",
                    summary="High-level architecture view.",
                    html_fragment="<section><h1>AgentScope-BLAIQ Hybrid Workflow</h1></section>",
                    section_data={"kind": "hero"},
                ),
                ArtifactSection(
                    section_id="evidence",
                    section_index=1,
                    title="Evidence",
                    summary="Merged web and document evidence.",
                    html_fragment="<section><p>Merged evidence</p></section>",
                    section_data={"citations": str(len(evidence.citations))},
                ),
            ],
            theme={"palette": "sandstone", "mood": "executive"},
            evidence_refs=[citation.source_id for citation in evidence.citations],
            html="<!doctype html><html><body><section>Hybrid workflow</section></body></html>",
            css="body{font-family:system-ui;}",
            preview_metadata=PreviewMetadata(theme_notes=["Resume test artifact"]),
        )

    async def fake_review(artifact, evidence):
        return GovernanceReport(
            approved=True,
            issues=[],
            readiness_score=0.96,
            notes=["Ready for review."],
        )

    monkeypatch.setattr(main.registry.strategist, "build_plan", fake_build_plan)
    monkeypatch.setattr(main.registry.research, "gather", fake_gather)
    monkeypatch.setattr(main.registry.content_director, "plan_content", fake_plan_content)
    monkeypatch.setattr(main.registry.vangogh, "generate", fake_generate)
    monkeypatch.setattr(main.registry.governance, "review", fake_review)

    thread_id = "thread-e2e-resume-001"
    tenant_id = "tenant-e2e"

    with TestClient(main.app) as client:
        upload_response = client.post(
            "/api/v1/upload",
            data={"tenant_id": tenant_id, "thread_id": thread_id},
            files={"file": ("brief.txt", b"Internal architecture notes for AgentScope-BLAIQ.", "text/plain")},
        )
        assert upload_response.status_code == 200

        with client.stream(
            "POST",
            "/api/v1/workflows/submit",
            json={
                "user_query": "Build a hybrid architecture visual for AgentScope-BLAIQ.",
                "workflow_mode": "hybrid",
                "tenant_id": tenant_id,
                "session_id": "session-e2e-resume-001",
                "thread_id": thread_id,
                "artifact_type": "visual_html",
                "source_scope": "web_and_docs",
            },
        ) as response:
            assert response.status_code == 200
            first_stream = "".join(response.iter_text())

        first_events = _parse_sse_payloads(first_stream)
        first_types = [event["type"] for event in first_events]
        assert "workflow_error" in first_types
        assert first_types[-1] == "workflow_error"

        failed_status = client.get(f"/api/v1/workflows/{thread_id}/status")
        assert failed_status.status_code == 200
        assert failed_status.json()["status"] == "error"

        with client.stream(
            "POST",
            "/api/v1/workflows/resume",
            json={
                "thread_id": thread_id,
                "tenant_id": tenant_id,
                "resume_reason": "transient upstream outage cleared",
            },
        ) as response:
            assert response.status_code == 200
            resume_stream = "".join(response.iter_text())

        resume_events = _parse_sse_payloads(resume_stream)
        resume_types = [event["type"] for event in resume_events]
        assert resume_types[0] == "workflow_resumed"
        assert "planning_complete" in resume_types
        assert "workflow_complete" in resume_types
        assert resume_types[-1] == "workflow_complete"

        completed_status = client.get(f"/api/v1/workflows/{thread_id}/status")
        assert completed_status.status_code == 200
        completed_payload = completed_status.json()
        assert completed_payload["status"] == "complete"
        assert completed_payload["latest_event"] == "workflow_complete"

        artifact_response = client.get(f"/api/v1/artifacts/{thread_id}")
        assert artifact_response.status_code == 200
        assert artifact_response.json()["title"] == "AgentScope-BLAIQ Hybrid Workflow"


def test_resume_after_hitl_continues_without_replaying_planning_or_research(monkeypatch, tmp_path):
    db_path = tmp_path / "agentscope-e2e-hitl-resume.db"
    upload_dir = tmp_path / "uploads"
    artifact_dir = tmp_path / "artifacts"
    log_dir = tmp_path / "logs"

    monkeypatch.setattr(main.settings, "database_url", f"sqlite+aiosqlite:///{db_path}")
    monkeypatch.setattr(main.settings, "upload_dir", upload_dir)
    monkeypatch.setattr(main.settings, "artifact_dir", artifact_dir)
    monkeypatch.setattr(main.settings, "log_dir", log_dir)
    monkeypatch.setattr(main.settings, "redis_url", "redis://127.0.0.1:6399/15")

    database_module._engine = None
    database_module._session_local = None
    main.engine_runner.session_factory = database_module.get_session_local()

    async def fake_build_plan(request):
        return WorkflowPlan(
            workflow_mode=WorkflowMode.hybrid,
            summary="Hybrid research then HITL then artifact generation",
            artifact_family=ArtifactFamily.custom,
            artifact_spec=ArtifactSpec(family=ArtifactFamily.custom, title=request.user_query, required_sections=["Hero", "Evidence"]),
            requirements_checklist=RequirementsChecklist(
                items=[
                    RequirementItem(
                        requirement_id="section:hero",
                        text="Provide the Hero for the custom artifact.",
                        category="section",
                        source="artifact_family",
                        priority=1,
                        must_have=True,
                        owner_task_id="content_director",
                        blocking_stage=RequirementStage.evidence_informed,
                    ),
                    RequirementItem(
                        requirement_id="field:must_have_sections",
                        text="Collect must have sections after research context is available.",
                        category="clarification",
                        source="hitl",
                        priority=2,
                        must_have=True,
                        owner_task_id="hitl_evidence",
                        blocking_stage=RequirementStage.evidence_informed,
                    ),
                ],
                missing_required_ids=["section:hero", "field:must_have_sections"],
            ),
            tasks=[
                AgentRunPayload(agent_type=AgentType.research, purpose="Research web", branch_key="web"),
                AgentRunPayload(agent_type=AgentType.research, purpose="Research docs", branch_key="docs"),
                AgentRunPayload(agent_type=AgentType.content_director, purpose="Plan content"),
                AgentRunPayload(agent_type=AgentType.vangogh, purpose="Generate visual"),
                AgentRunPayload(agent_type=AgentType.governance, purpose="Review"),
            ],
            fan_in_required=True,
        )

    async def fake_gather(session, tenant_id, query, scope):
        if scope == "docs":
            source = SourceRecord(source_id="upload:brief.txt", source_type="upload", title="brief.txt", location=str(upload_dir / tenant_id / "brief.txt"))
            finding = EvidenceFinding(
                finding_id="doc:brief.txt",
                title="brief.txt",
                summary="Uploaded document provided company and product notes.",
                source_ids=[source.source_id],
                confidence=0.72,
            )
            citation = Citation(source_id=source.source_id, label="brief.txt", excerpt="Company and product notes.")
            return EvidencePack(
                summary="Document evidence confirmed company and product notes.",
                sources=[source],
                doc_findings=[finding],
                confidence=0.72,
                citations=[citation],
            )

        source = SourceRecord(
            source_id="https://bundb.de/",
            source_type="web",
            title="bundb.de",
            location="https://bundb.de/",
        )
        finding = EvidenceFinding(
            finding_id="web:bundb",
            title="bundb.de",
            summary="The website describes the company and its market positioning.",
            source_ids=[source.source_id],
            confidence=0.66,
        )
        citation = Citation(source_id=source.source_id, label="bundb.de", excerpt="Company and market positioning.", url=source.location)
        return EvidencePack(
            summary="Web evidence added external company context.",
            sources=[source],
            web_findings=[finding],
            confidence=0.66,
            citations=[citation],
        )

    async def deterministic_hitl_prompt(
        *,
        user_query,
        artifact_family,
        requirements,
        missing_requirement_ids,
        evidence_summary=None,
        target_audience=None,
        delivery_channel=None,
        brand_context=None,
        evidence=None,
    ):
        from agentscope_blaiq.agents.clarification import ClarificationPrompt, ClarificationQuestion

        questions = [
            ClarificationQuestion(
                requirement_id=requirement.requirement_id,
                question=requirement.text,
                why_it_matters="Needed before final rendering.",
                answer_hint=requirement.text,
            )
            for requirement in requirements.items
            if requirement.requirement_id in missing_requirement_ids
        ]
        return ClarificationPrompt(
            headline="Clarification needed",
            intro="Please answer the remaining questions.",
            questions=questions,
            blocked_question=" ".join(question.question for question in questions),
            expected_answer_schema={question.requirement_id: question.question for question in questions},
            family=artifact_family,
        )

    async def fake_plan_content(*, user_query, evidence_summary, artifact_spec, requirements, hitl_answers=None):
        class _Brief:
            def model_dump(self_inner):
                return {
                    "title": user_query,
                    "family": getattr(getattr(artifact_spec, "family", None), "value", "custom"),
                    "template_name": "default",
                    "narrative": evidence_summary,
                    "section_plan": [],
                    "distribution_notes": [],
                    "handoff_notes": [f"Answered fields: {', '.join(sorted((hitl_answers or {}).keys()))}"],
                }

        return _Brief()

    async def fake_generate(user_query, evidence, content_brief=None):
        return VisualArtifact(
            artifact_id="artifact-hitl-resume-1",
            title="Resume Without Replay",
            sections=[
                ArtifactSection(
                    section_id="hero",
                    section_index=0,
                    title="Hero",
                    summary="Hero section.",
                    html_fragment="<section><h1>Resume Without Replay</h1></section>",
                )
            ],
            theme={"palette": "sandstone", "mood": "executive"},
            evidence_refs=[citation.source_id for citation in evidence.citations],
            html="<!doctype html><html><body><section>Resume Without Replay</section></body></html>",
            css="body{font-family:system-ui;}",
            preview_metadata=PreviewMetadata(theme_notes=["Resume without replay"]),
        )

    async def fake_review(artifact, evidence):
        return GovernanceReport(
            approved=True,
            issues=[],
            readiness_score=1.0,
            notes=["Ready after HITL resume."],
        )

    monkeypatch.setattr(main.registry.strategist, "build_plan", fake_build_plan)
    monkeypatch.setattr(main.registry.research, "gather", fake_gather)
    monkeypatch.setattr(main.registry.hitl, "generate_prompt", deterministic_hitl_prompt)
    monkeypatch.setattr(main.registry.content_director, "plan_content", fake_plan_content)
    monkeypatch.setattr(main.registry.vangogh, "generate", fake_generate)
    monkeypatch.setattr(main.registry.governance, "review", fake_review)

    thread_id = "thread-e2e-hitl-resume-001"
    tenant_id = "tenant-e2e"

    with TestClient(main.app) as client:
        upload_response = client.post(
            "/api/v1/upload",
            data={"tenant_id": tenant_id, "thread_id": thread_id},
            files={"file": ("brief.txt", b"Company and product notes.", "text/plain")},
        )
        assert upload_response.status_code == 200

        with client.stream(
            "POST",
            "/api/v1/workflows/submit",
            json={
                "user_query": "Create a professional pitch deck presentation for bundb.de",
                "workflow_mode": "hybrid",
                "tenant_id": tenant_id,
                "session_id": "session-e2e-hitl-resume-001",
                "thread_id": thread_id,
                "artifact_type": "visual_html",
                "source_scope": "web_and_docs",
            },
        ) as response:
            assert response.status_code == 200
            first_stream = "".join(response.iter_text())

        first_events = _parse_sse_payloads(first_stream)
        first_types = [event["type"] for event in first_events]
        assert "workflow_blocked" in first_types
        blocked_event = next(event for event in first_events if event["type"] == "workflow_blocked")
        assert blocked_event["data"]["pending_node"] == "hitl_evidence"

        answers = {
            "section:hero": "A strong enterprise-ready positioning",
            "field:must_have_sections": "Hero, Evidence",
        }

        with client.stream(
            "POST",
            "/api/v1/workflows/resume",
            json={
                "thread_id": thread_id,
                "tenant_id": tenant_id,
                "resume_reason": "answered clarification questions",
                "answers": answers,
            },
        ) as response:
            assert response.status_code == 200
            resume_stream = "".join(response.iter_text())

        resume_events = _parse_sse_payloads(resume_stream)
        resume_types = [event["type"] for event in resume_events]
        assert resume_types[0] == "workflow_resumed"
        assert "resume_accepted" in resume_types
        assert "content_director_started" in resume_types
        assert "workflow_complete" in resume_types
        assert "planning_complete" not in resume_types
        assert "requirements_check_completed" not in resume_types
        assert "agent_catalog_snapshot" not in resume_types
        assert "fanin_completed" not in resume_types
        assert not any(event["type"] == "parallel_branch_started" and event.get("phase") == "research" for event in resume_events)
        assert not any(event["type"] == "parallel_branch_completed" and event.get("phase") == "research" for event in resume_events)
