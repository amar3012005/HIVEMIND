import pytest

from agentscope_blaiq.agents.clarification import ClarificationAgent
from agentscope_blaiq.contracts.evidence import EvidenceFinding, EvidencePack, SourceRecord
from agentscope_blaiq.contracts.workflow import ArtifactFamily, RequirementItem, RequirementStage, RequirementsChecklist


@pytest.mark.asyncio
async def test_clarification_filters_requirements_already_covered_by_context():
    agent = ClarificationAgent()
    requirements = RequirementsChecklist(
        items=[
            RequirementItem(
                requirement_id="field:target_audience",
                text="Collect target audience.",
                category="clarification",
                must_have=True,
                blocking_stage=RequirementStage.before_render,
            ),
            RequirementItem(
                requirement_id="section:hero",
                text="Provide the Hero for the pitch_deck artifact.",
                category="section",
                must_have=True,
                blocking_stage=RequirementStage.evidence_informed,
            ),
        ]
    )
    evidence = EvidencePack(
        summary="Research confirms the deck should lead with an industrial decarbonization value proposition for manufacturing executives.",
        memory_findings=[
            EvidenceFinding(
                finding_id="mem:1",
                title="Executive deck brief",
                summary="Audience is manufacturing executives and the opening should emphasize decarbonization ROI and operational efficiency.",
                source_ids=["mem:1"],
                confidence=0.82,
            )
        ],
        sources=[
            SourceRecord(
                source_id="mem:1",
                source_type="memory",
                title="Executive deck brief",
                location="memory://mem:1",
            )
        ],
        confidence=0.82,
    )

    prompt = await agent.generate_prompt(
        user_query="Create a professional pitch deck presentation for manufacturing executives",
        artifact_family=ArtifactFamily.pitch_deck,
        requirements=requirements,
        missing_requirement_ids=["field:target_audience", "section:hero"],
        evidence=evidence,
        evidence_summary=evidence.summary,
        target_audience="Manufacturing executives",
    )

    requirement_ids = [question.requirement_id for question in prompt.questions]
    assert "field:target_audience" not in requirement_ids
    assert "section:hero" not in requirement_ids
    assert prompt.questions[0].requirement_id == "clarification:default"


@pytest.mark.asyncio
async def test_clarification_uses_evidence_conditioned_proof_question_for_upload_only_evidence():
    agent = ClarificationAgent()
    requirements = RequirementsChecklist(
        items=[
            RequirementItem(
                requirement_id="section:proof",
                text="Provide the Proof for the pitch_deck artifact.",
                category="section",
                must_have=True,
                blocking_stage=RequirementStage.evidence_informed,
            ),
        ]
    )
    evidence = EvidencePack(
        summary="Collected 3 uploaded document findings. No supporting evidence was found yet.",
        doc_findings=[
            EvidenceFinding(
                finding_id="doc:1",
                title="Internal PDF",
                summary="Internal sales PDF with preliminary messaging only.",
                source_ids=["doc:1"],
                confidence=0.55,
            )
        ],
        sources=[
            SourceRecord(
                source_id="doc:1",
                source_type="upload",
                title="Internal PDF",
                location="/tmp/doc1.pdf",
            )
        ],
        confidence=0.55,
    )

    prompt = await agent.generate_prompt(
        user_query="Create a professional pitch deck presentation",
        artifact_family=ArtifactFamily.pitch_deck,
        requirements=requirements,
        missing_requirement_ids=["section:proof"],
        evidence=evidence,
        evidence_summary=evidence.summary,
    )

    assert prompt.questions[0].requirement_id == "section:proof"
    assert "current evidence is mostly internal uploads" in prompt.questions[0].question.lower()
