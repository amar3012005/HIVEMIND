from __future__ import annotations

from uuid import uuid4

from pydantic import BaseModel, Field
from agentscope.tool import Toolkit

from agentscope_blaiq.contracts.artifact import ArtifactSection, PreviewMetadata, VisualArtifact
from agentscope_blaiq.contracts.evidence import EvidencePack
from agentscope_blaiq.runtime.agent_base import BaseAgent


class VisualDraft(BaseModel):
    title: str
    theme: str = "sandstone"
    mood: str = "executive"
    hero_summary: str
    evidence_summary: str
    section_titles: list[str] = Field(default_factory=lambda: ["Hero", "Evidence"])


class VangoghAgent(BaseAgent):
    def __init__(self, **kwargs) -> None:
        super().__init__(
            name="VangoghAgent",
            role="vangogh",
            sys_prompt=(
                "You are the Vangogh agent. Turn strategic direction and evidence into presentation-grade HTML/CSS artifacts. "
                "Favor bold hierarchy, clear sections, and evidence-aware copy."
            ),
            **kwargs,
        )

    def build_toolkit(self) -> Toolkit:
        toolkit = Toolkit()
        toolkit.register_tool_function(
            self._artifact_contract,
            func_name="artifact_contract",
            func_description="Return the required visual artifact contract for AgentScope-BLAIQ.",
        )
        return toolkit

    def _artifact_contract(self):
        return self.tool_response(
            {
                "required_fields": ["artifact_id", "artifact_type", "title", "sections", "theme", "evidence_refs", "html", "css"],
                "section_fields": ["section_id", "section_index", "title", "summary", "html_fragment", "section_data"],
            }
        )

    @staticmethod
    def _fallback_draft(user_query: str, evidence: EvidencePack) -> VisualDraft:
        title = user_query.strip().rstrip(".") if user_query.strip() else "Visual Artifact"
        if len(title) > 96:
            title = f"{title[:93].rstrip()}..."
        hero_summary = evidence.summary or "A high-level executive view grounded in the available evidence."
        evidence_labels = [citation.label for citation in evidence.citations[:4]]
        evidence_summary = (
            f"Evidence comes from {len(evidence.sources)} sources: {', '.join(evidence_labels)}."
            if evidence_labels
            else "Evidence comes from the uploaded brief and public documentation."
        )
        return VisualDraft(
            title=title,
            theme="sandstone",
            mood="executive",
            hero_summary=hero_summary,
            evidence_summary=evidence_summary,
            section_titles=["Hero", "Evidence"],
        )

    async def generate(self, user_query: str, evidence: EvidencePack, content_brief: dict | None = None) -> VisualArtifact:
        await self.log(
            f"Designing the visual artifact. Working with {len(evidence.citations)} evidence sources.",
            kind="status",
            detail={"source_count": len(evidence.citations), "has_content_brief": bool(content_brief)},
        )
        try:
            await self.log("Generating the artifact layout and theme from the evidence brief.", kind="thought")
            draft = await self.complete_json(
                VisualDraft,
                user_content="Design the high-level visual artifact. Respond with valid JSON only.",
                extra_context={
                    "user_query": user_query,
                    "evidence_summary": evidence.summary,
                    "source_labels": [citation.label for citation in evidence.citations],
                    "section_count": max(2, len(evidence.citations) // 2),
                    "content_brief": content_brief or {},
                },
                temperature=0.7,
                max_tokens=700,
            )
            await self.log(
                f"Layout decided: \"{draft.title}\" with {len(draft.section_titles)} sections, theme '{draft.theme}', mood '{draft.mood}'.",
                kind="decision",
                detail={"title": draft.title, "sections": draft.section_titles, "theme": draft.theme},
            )
        except Exception:
            draft = self._fallback_draft(user_query, evidence)
            await self.log(
                f"Model output was not structured. Using deterministic layout: \"{draft.title}\".",
                kind="status",
            )

        artifact_id = str(uuid4())

        # Build sections
        await self.log(f"Rendering section 1: {draft.section_titles[0] if draft.section_titles else 'Hero'}", kind="status")
        sections = [
            ArtifactSection(
                section_id="hero",
                section_index=0,
                title=draft.section_titles[0] if draft.section_titles else "Hero",
                summary=(content_brief or {}).get("narrative") or draft.hero_summary,
                html_fragment=f"<section class='hero'><h1>{draft.title}</h1><p>{(content_brief or {}).get('narrative') or draft.hero_summary}</p></section>",
                section_data={"tone": draft.mood, "source_count": str(len(evidence.sources))},
            ),
        ]

        evidence_title = draft.section_titles[1] if len(draft.section_titles) > 1 else "Evidence"
        await self.log(f"Rendering section 2: {evidence_title}", kind="status")
        sections.append(
            ArtifactSection(
                section_id="evidence",
                section_index=1,
                title=evidence_title,
                summary=(content_brief or {}).get("narrative") or draft.evidence_summary,
                html_fragment="<section class='evidence'><ul>" + "".join(f"<li>{citation.label}</li>" for citation in evidence.citations[:5]) + "</ul></section>",
                section_data={"citations": str(len(evidence.citations))},
            ),
        )

        html = "\n".join(
            [
                "<!doctype html>",
                f"<html><head><meta charset='utf-8'><title>{draft.title}</title><style>body{{font-family:system-ui;background:#f3efe7;color:#101010;padding:40px}}.hero{{padding:32px;border-radius:24px;background:#fff7e8}}.evidence{{margin-top:24px;padding:24px;border-radius:20px;background:#ffffff}}</style></head>",
                "<body>",
                *(section.html_fragment for section in sections),
                "</body></html>",
            ]
        )
        css = "body{margin:0} h1{font-size:48px;line-height:1.05} p,li{font-size:18px;line-height:1.6}"

        await self.log(
            f"Artifact composed: {len(sections)} sections, HTML and CSS generated.",
            kind="artifact",
            detail={"artifact_id": artifact_id, "section_count": len(sections)},
        )
        return VisualArtifact(
            artifact_id=artifact_id,
            title=draft.title,
            sections=sections,
            theme={"palette": draft.theme, "mood": draft.mood},
            evidence_refs=[citation.source_id for citation in evidence.citations],
            html=html,
            css=css,
            preview_metadata=PreviewMetadata(theme_notes=["Warm editorial palette", "Presentation-friendly hierarchy"]),
        )
