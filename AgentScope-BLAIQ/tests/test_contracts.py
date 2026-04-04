from agentscope_blaiq.contracts.artifact import ArtifactSection, VisualArtifact
from agentscope_blaiq.contracts.evidence import EvidencePack
from agentscope_blaiq.contracts.workflow import SubmitWorkflowRequest, WorkflowMode


def test_submit_workflow_defaults():
    request = SubmitWorkflowRequest(user_query="Build a launch visual")
    assert request.workflow_mode == WorkflowMode.hybrid
    assert request.tenant_id == "default"
    assert request.artifact_type == "visual_html"
    assert request.source_scope == "web_and_docs"


def test_visual_artifact_contract():
    artifact = VisualArtifact(
        artifact_id="artifact-1",
        title="Artifact",
        sections=[
            ArtifactSection(
                section_id="hero",
                section_index=0,
                title="Hero",
                summary="Summary",
                html_fragment="<section>Hero</section>",
            )
        ],
        evidence_refs=["source-1"],
        html="<html></html>",
        css="body{}",
    )
    assert artifact.sections[0].section_id == "hero"
    assert artifact.evidence_refs == ["source-1"]
