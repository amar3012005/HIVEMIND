from __future__ import annotations

from pydantic import BaseModel, Field
from agentscope.tool import Toolkit

from agentscope_blaiq.contracts.artifact import VisualArtifact
from agentscope_blaiq.contracts.evidence import EvidencePack
from agentscope_blaiq.runtime.agent_base import BaseAgent
from agentscope_blaiq.tools.validation import validate_visual_artifact


class GovernanceReport(BaseModel):
    approved: bool
    issues: list[str] = Field(default_factory=list)
    readiness_score: float = 0.0
    notes: list[str] = Field(default_factory=list)


class GovernanceAgent(BaseAgent):
    def __init__(self, **kwargs) -> None:
        super().__init__(
            name="GovernanceAgent",
            role="governance",
            sys_prompt=(
                "You are the governance agent. Approve only when the artifact is complete, evidence-linked, and ready to ship. "
                "Otherwise emit explicit revision feedback."
            ),
            **kwargs,
        )

    def build_toolkit(self) -> Toolkit:
        toolkit = Toolkit()
        toolkit.register_tool_function(
            self._validate_artifact_contract,
            func_name="validate_visual_artifact",
            func_description="Run the platform's deterministic validation rules against a visual artifact payload.",
        )
        return toolkit

    def _validate_artifact_contract(self, artifact_payload: dict):
        artifact = VisualArtifact.model_validate(artifact_payload)
        return self.tool_response(validate_visual_artifact(artifact))

    @staticmethod
    def _fallback_report(*, validation: dict, evidence: EvidencePack, issues: list[str]) -> GovernanceReport:
        approved = not issues
        notes = ["Fallback governance path used after non-JSON model output."]
        if evidence.citations:
            notes.append(f"Evidence linked to {len(evidence.citations)} citations.")
        else:
            notes.append("Evidence coverage is incomplete.")
        return GovernanceReport(
            approved=approved,
            issues=issues,
            readiness_score=float(validation["readiness_score"]) if approved else max(0.0, float(validation["readiness_score"]) - 0.2),
            notes=notes,
        )

    async def review(self, artifact: VisualArtifact, evidence: EvidencePack) -> GovernanceReport:
        await self.log(
            f"Starting governance review for \"{artifact.title}\". Checking {len(artifact.sections)} sections against evidence.",
            kind="status",
        )

        validation = validate_visual_artifact(artifact)
        issues = list(validation["issues"])

        await self.log(
            f"Deterministic checks complete. Readiness score: {validation['readiness_score']}, issues: {len(issues)}.",
            kind="review",
            detail={"readiness_score": validation["readiness_score"], "issues": issues},
        )

        if not evidence.citations:
            issues.append("citations_missing")
            await self.log("Warning: No citations found in the evidence pack.", kind="review")

        if not issues:
            await self.log(
                f"All checks passed. Approving artifact with readiness score {validation['readiness_score']}.",
                kind="decision",
            )
            return GovernanceReport(
                approved=True,
                issues=[],
                readiness_score=float(validation["readiness_score"]),
                notes=["Artifact validated against deterministic governance checks."],
            )

        await self.log(f"Issues detected: {', '.join(issues)}. Running model-backed review for nuanced assessment.", kind="thought")
        try:
            model_report = await self.complete_json(
                GovernanceReport,
                user_content="Review the artifact for readiness and return explicit approval or revision feedback. Respond with valid JSON only.",
                extra_context={
                    "artifact_title": artifact.title,
                    "artifact_type": artifact.artifact_type,
                    "section_count": len(artifact.sections),
                    "evidence_refs": artifact.evidence_refs,
                    "evidence_count": len(evidence.citations),
                    "local_validation": validation,
                },
                temperature=0.0,
                max_tokens=300,
            )
        except Exception:
            model_report = self._fallback_report(validation=validation, evidence=evidence, issues=sorted(set(issues)))

        approved = model_report.approved and not issues
        final_report = GovernanceReport(
            approved=approved,
            issues=sorted(set([*issues, *model_report.issues])),
            readiness_score=max(
                float(model_report.readiness_score),
                float(validation["readiness_score"]),
            )
            if approved
            else max(0.0, min(float(model_report.readiness_score), float(validation["readiness_score"])) - 0.2),
            notes=[*model_report.notes, "Artifact validated against v1 governance checks."],
        )

        verdict = "Approved" if final_report.approved else "Revision required"
        await self.log(
            f"{verdict}. Final readiness: {final_report.readiness_score}.",
            kind="decision",
            detail={"approved": final_report.approved, "readiness_score": final_report.readiness_score},
        )
        return final_report
