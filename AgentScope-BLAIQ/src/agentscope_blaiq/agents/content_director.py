from __future__ import annotations

from pydantic import BaseModel, Field
from agentscope.tool import Toolkit

from agentscope_blaiq.contracts.workflow import ArtifactFamily, ArtifactSpec, RequirementsChecklist
from agentscope_blaiq.runtime.agent_base import BaseAgent


class ContentSectionPlan(BaseModel):
    section_id: str
    title: str
    purpose: str
    source_refs: list[str] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)


class ContentBrief(BaseModel):
    title: str
    family: str
    template_name: str = "default"
    narrative: str
    section_plan: list[ContentSectionPlan] = Field(default_factory=list)
    distribution_notes: list[str] = Field(default_factory=list)
    handoff_notes: list[str] = Field(default_factory=list)


class ContentDirectorAgent(BaseAgent):
    def __init__(self, **kwargs) -> None:
        super().__init__(
            name="ContentDirectorAgent",
            role="content_director",
            sys_prompt=(
                "You are the content director. Convert strategy, evidence, and user requirements into a content plan "
                "that decides section distribution, template usage, and handoff instructions for the renderer."
            ),
            **kwargs,
        )

    def build_toolkit(self) -> Toolkit:
        toolkit = Toolkit()
        toolkit.register_tool_function(
            self._tool_content_distribution,
            func_name="content_distribution",
            func_description="Decide how content should be distributed across sections.",
        )
        toolkit.register_tool_function(
            self._tool_section_planning,
            func_name="section_planning",
            func_description="Produce a section-by-section plan from requirements and evidence.",
        )
        toolkit.register_tool_function(
            self._tool_template_selection,
            func_name="template_selection",
            func_description="Select a template direction for the renderer.",
        )
        toolkit.register_tool_function(
            self._tool_render_brief_generation,
            func_name="render_brief_generation",
            func_description="Generate the renderer handoff brief.",
        )
        return toolkit

    def _tool_content_distribution(self, artifact_spec: dict | None = None, requirements: dict | None = None):
        return self.tool_response(
            {
                "artifact_spec": artifact_spec or {},
                "requirements": requirements or {},
                "distribution": "Match sections to the required narrative and evidence hierarchy.",
            }
        )

    def _tool_section_planning(self, section_plan: list[dict] | None = None):
        return self.tool_response({"section_plan": section_plan or []})

    def _tool_template_selection(self, artifact_spec: dict | None = None):
        family = (artifact_spec or {}).get("family", "custom")
        template_name = f"{family}-executive" if family != "custom" else "default"
        return self.tool_response({"template_name": template_name})

    def _tool_render_brief_generation(self, brief: dict | None = None):
        return self.tool_response({"brief": brief or {}})

    async def plan_content(
        self,
        *,
        user_query: str,
        evidence_summary: str,
        artifact_spec: ArtifactSpec,
        requirements: RequirementsChecklist,
        hitl_answers: dict[str, str] | None = None,
    ) -> ContentBrief:
        await self.log(
            f"Planning content distribution for {artifact_spec.family.value}.",
            kind="thought",
            detail={"family": artifact_spec.family.value, "requirement_count": len(requirements.items)},
        )
        section_names = artifact_spec.required_sections or ["Hero", "Evidence"]
        section_plan = [
            ContentSectionPlan(
                section_id=f"section-{index + 1}",
                title=section_title,
                purpose=f"Cover {section_title.lower()} for {artifact_spec.family.value}.",
                source_refs=[item.requirement_id for item in requirements.items if item.must_have][:2],
                notes=[],
            )
            for index, section_title in enumerate(section_names)
        ]
        brief = ContentBrief(
            title=artifact_spec.title or user_query,
            family=artifact_spec.family.value,
            template_name=f"{artifact_spec.family.value}-executive" if artifact_spec.family != ArtifactFamily.custom else "default",
            narrative=evidence_summary or user_query,
            section_plan=section_plan,
            distribution_notes=[
                "Use the strongest evidence first.",
                "Keep the renderer prompt page-by-page and section-aware.",
            ],
            handoff_notes=[
                "Final render should reflect the accepted HITL answers.",
                f"Answered fields: {', '.join(sorted(hitl_answers or {})) or 'none'}",
            ],
        )
        await self.log(
            f"Content plan ready for {len(section_plan)} sections.",
            kind="decision",
            detail={"template_name": brief.template_name, "section_count": len(section_plan)},
        )
        return brief
