from __future__ import annotations

import re

from pydantic import BaseModel, Field

from agentscope_blaiq.contracts.evidence import EvidencePack
from agentscope_blaiq.contracts.workflow import ArtifactFamily, RequirementsChecklist, WorkflowNode
from agentscope_blaiq.runtime.agent_base import BaseAgent


class ClarificationQuestion(BaseModel):
    requirement_id: str
    question: str
    why_it_matters: str | None = None
    answer_hint: str | None = None
    answer_options: list[str] = Field(default_factory=list)


class ClarificationPrompt(BaseModel):
    headline: str
    intro: str
    questions: list[ClarificationQuestion] = Field(default_factory=list)
    blocked_question: str
    expected_answer_schema: dict[str, str] = Field(default_factory=dict)
    family: ArtifactFamily = ArtifactFamily.custom


class ClarificationDraft(BaseModel):
    headline: str
    intro: str
    questions: list[ClarificationQuestion] = Field(default_factory=list)


class ClarificationAgent(BaseAgent):
    def __init__(self, **kwargs) -> None:
        super().__init__(
            name="HITL Agent",
            role="hitl",
            sys_prompt=(
                "You are the HITL clarification agent for BLAIQ. Your job is to turn missing requirements into short, "
                "human-friendly clarification questions. Never ask fill-in-the-blank prompts. Write like a product "
                "specialist helping the user make the output stronger. Keep questions grounded in the request, concise, "
                "and action-oriented. Prefer grouped questions that feel natural to answer."
            ),
            **kwargs,
        )

    @staticmethod
    def _generic_options_for_family(family: ArtifactFamily, requirement_id: str, request_text: str) -> list[str]:
        section = requirement_id.split(":", 1)[1].replace("_", " ") if ":" in requirement_id else requirement_id
        lower_section = section.lower()
        family_label = family.value.replace("_", " ")
        if requirement_id.startswith("field:target_audience"):
            return ["Leadership team", "External customers", "Investors / partners"]
        if requirement_id.startswith("field:delivery_channel"):
            return ["Live presentation", "PDF deck", "Web page / digital"]
        if requirement_id.startswith("field:must_have_sections"):
            return ["Hero + narrative", "Problem / solution / proof", "I’ll specify the exact sections"]
        if requirement_id.startswith("field:brand_context"):
            return ["Use current brand system", "Follow a lighter executive style", "I’ll share brand guidance"]
        section_options = {
            "hero": [
                f"A strong opening for the {family_label}",
                "A bold headline and value proposition",
                "A concise executive summary lead-in",
            ],
            "problem": [
                "The business pain / market gap",
                "The customer challenge",
                "The risk of doing nothing",
            ],
            "solution": [
                "The proposed solution",
                "The differentiating approach",
                "The operating model or product direction",
            ],
            "proof": [
                "Evidence from research",
                "Customer traction / metrics",
                "Credible market validation",
            ],
            "cta": [
                "Request a meeting / follow-up",
                "Approve next steps",
                "Move to implementation",
            ],
            "opening": [
                "A sharp opening statement",
                "A story-led introduction",
                "A metric-led introduction",
            ],
            "narrative": [
                "Problem → solution → proof",
                "Current state → future state",
                "Challenge → opportunity → action",
            ],
            "closing": [
                "A decisive call to action",
                "A memorable closing statement",
                "A summary with next steps",
            ],
            "headline": [
                "A bold short headline",
                "A clear executive headline",
                "A benefit-led headline",
            ],
            "benefits": [
                "Efficiency and speed",
                "Revenue and growth",
                "Trust and credibility",
            ],
            "evidence": [
                "Customer proof points",
                "Market data and insights",
                "Internal source-backed evidence",
            ],
            "offer": [
                "Product value proposition",
                "A service or package offer",
                "A conversion-focused offer",
            ],
            "details": [
                "Operational specifics",
                "Product specifics",
                "Audience-specific details",
            ],
            "summary": [
                "Executive summary",
                "Key takeaways",
                "One-paragraph overview",
            ],
            "recommendations": [
                "Recommended next steps",
                "Priority actions",
                "Decision-oriented guidance",
            ],
            "visual hook": [
                "Minimal and elegant",
                "Bold and energetic",
                "Analytical and clean",
            ],
        }
        fallback = [
            f"A concise answer for the {family_label}",
            f"A stronger version of {section}",
            f"I’ll type my own answer",
        ]
        return section_options.get(lower_section, fallback)

    @staticmethod
    def _evidence_context(evidence: EvidencePack | None) -> dict[str, object]:
        if evidence is None:
            return {
                "text": "",
                "supporting_sources": 0,
                "has_supporting_sources": False,
                "upload_only": False,
                "weak": True,
            }
        snippets = [evidence.summary, *evidence.open_questions, *evidence.recommended_followups]
        for finding in [*evidence.memory_findings, *evidence.web_findings, *evidence.doc_findings]:
            snippets.extend([finding.title, finding.summary])
        text = " ".join(str(part or "") for part in snippets).lower()
        supporting_sources = len(evidence.memory_findings) + len(evidence.web_findings)
        upload_only = supporting_sources == 0 and len(evidence.doc_findings) > 0
        weak = supporting_sources == 0 and evidence.confidence < 0.65
        return {
            "text": text,
            "supporting_sources": supporting_sources,
            "has_supporting_sources": supporting_sources > 0,
            "upload_only": upload_only,
            "weak": weak,
        }

    @staticmethod
    def _requirement_covered_by_context(
        requirement_id: str,
        request_text: str,
        evidence: EvidencePack | None,
        *,
        target_audience: str | None = None,
        delivery_channel: str | None = None,
        brand_context: str | None = None,
    ) -> bool:
        request_lower = str(request_text or "").lower()
        context = ClarificationAgent._evidence_context(evidence)
        evidence_text = str(context["text"])
        if requirement_id == "field:target_audience":
            if str(target_audience or "").strip():
                return True
            audience_markers = ("investor", "buyer", "customer", "leadership", "executive", "partner", "board", "procurement")
            return any(marker in request_lower or marker in evidence_text for marker in audience_markers)
        if requirement_id == "field:delivery_channel":
            if str(delivery_channel or "").strip():
                return True
            return any(marker in request_lower for marker in ("pdf", "web", "landing page", "poster", "brochure", "presentation", "deck"))
        if requirement_id == "field:brand_context":
            if str(brand_context or "").strip():
                return True
            return any(marker in request_lower or marker in evidence_text for marker in ("brand", "visual identity", "style guide"))
        if requirement_id == "field:must_have_sections":
            section_markers = ("hero", "problem", "solution", "proof", "cta", "agenda", "summary", "recommendation")
            return sum(1 for marker in section_markers if marker in request_lower) >= 2
        if not requirement_id.startswith("section:"):
            return False

        section_name = requirement_id.split(":", 1)[1].replace("_", " ")
        section_keywords = {
            "hero": ("headline", "hook", "opening", "positioning", "value proposition"),
            "problem": ("problem", "pain", "challenge", "gap", "risk"),
            "solution": ("solution", "approach", "platform", "product", "offer", "direction"),
            "proof": ("proof", "traction", "evidence", "metric", "validation", "reference", "customer"),
            "cta": ("cta", "next step", "follow-up", "call to action", "meeting", "decision"),
        }
        keywords = section_keywords.get(section_name, (section_name,))
        keyword_hits = sum(1 for keyword in keywords if keyword in request_lower or keyword in evidence_text)
        return bool(context["has_supporting_sources"]) and keyword_hits >= 2 and not bool(context["weak"])

    @staticmethod
    def _question_priority(requirement_id: str, evidence: EvidencePack | None) -> tuple[int, int]:
        context = ClarificationAgent._evidence_context(evidence)
        if requirement_id == "field:target_audience":
            return (0, 0)
        if requirement_id == "field:must_have_sections":
            return (0, 1)
        if requirement_id.startswith("section:proof") and bool(context["upload_only"]):
            return (0, 2)
        if requirement_id.startswith("section:hero"):
            return (1, 0)
        if requirement_id.startswith("section:problem"):
            return (1, 1)
        if requirement_id.startswith("section:solution"):
            return (1, 2)
        if requirement_id.startswith("section:proof"):
            return (1, 3)
        if requirement_id.startswith("section:cta"):
            return (1, 4)
        return (2, 0)

    @staticmethod
    def _question_from_requirement(
        requirement_id: str,
        requirement_text: str,
        family: ArtifactFamily,
        request_text: str,
        evidence: EvidencePack | None = None,
    ) -> ClarificationQuestion:
        cleaned = requirement_text.rstrip(".")
        context = ClarificationAgent._evidence_context(evidence)
        if requirement_id.startswith("section:"):
            section_name = requirement_id.split(":", 1)[1].replace("_", " ")
            question = {
                "hero": f"What should be the main hook for the opening of this {family.value.replace('_', ' ')}?",
                "problem": "What problem should the audience immediately recognize?",
                "solution": "What solution or direction should we emphasize?",
                "proof": "What proof point or evidence should we highlight?",
                "cta": "What action should we want the audience to take next?",
                "opening": "How should we open to capture attention?",
                "narrative": "What story arc should the middle of the deck follow?",
                "closing": "How should we close the piece?",
                "headline": "What is the headline message we should lead with?",
                "benefits": "Which benefits matter most for this audience?",
                "evidence": "What evidence should we foreground to make this convincing?",
                "offer": "What offer or value should be emphasized?",
                "details": "What details are necessary to make this complete?",
                "summary": "What summary should the audience remember?",
                "recommendations": "What recommendations should this artifact leave the user with?",
                "visual_hook": "What visual or motif should anchor the design?",
            }.get(section_name, f"What should we emphasize for the {section_name} section?")
            if section_name == "proof" and bool(context["upload_only"]):
                question = "The current evidence is mostly internal uploads. Which proof point should we elevate so this deck still feels credible?"
            elif section_name == "hero" and bool(context["weak"]):
                question = f"The current material does not yet establish a strong angle. What should be the main hook for the opening of this {family.value.replace('_', ' ')}?"
            return ClarificationQuestion(
                requirement_id=requirement_id,
                question=question,
                why_it_matters=f"It helps us shape the {section_name} section for the {family.value.replace('_', ' ')}.",
                answer_hint=cleaned,
                answer_options=ClarificationAgent._generic_options_for_family(family, requirement_id, request_text),
            )
        if requirement_id.startswith("field:target_audience"):
            return ClarificationQuestion(
                requirement_id=requirement_id,
                question="Who is this really for, and what do they already care about?",
                why_it_matters="The audience changes the tone, proof points, and structure.",
                answer_hint=cleaned,
                answer_options=ClarificationAgent._generic_options_for_family(family, requirement_id, request_text),
            )
        if requirement_id.startswith("field:must_have_sections"):
            return ClarificationQuestion(
                requirement_id=requirement_id,
                question="Are there any sections, slides, or blocks that must be included no matter what?",
                why_it_matters="We need to protect the must-have structure before rendering.",
                answer_hint=cleaned,
                answer_options=ClarificationAgent._generic_options_for_family(family, requirement_id, request_text),
            )
        if requirement_id.startswith("field:delivery_channel"):
            return ClarificationQuestion(
                requirement_id=requirement_id,
                question="Where will this artifact be used: live presentation, PDF, web page, print, or something else?",
                why_it_matters="The delivery channel affects layout, pacing, and export constraints.",
                answer_hint=cleaned,
                answer_options=ClarificationAgent._generic_options_for_family(family, requirement_id, request_text),
            )
        if requirement_id.startswith("field:brand_context"):
            return ClarificationQuestion(
                requirement_id=requirement_id,
                question="Are there brand or style rules we need to respect?",
                why_it_matters="Brand context keeps the output aligned with the organization.",
                answer_hint=cleaned,
                answer_options=ClarificationAgent._generic_options_for_family(family, requirement_id, request_text),
            )
        return ClarificationQuestion(
            requirement_id=requirement_id,
            question=f"What should we know about {cleaned.lower()}?",
            why_it_matters=f"It affects how we frame the {family.value.replace('_', ' ')}.",
            answer_hint=cleaned,
            answer_options=ClarificationAgent._generic_options_for_family(family, requirement_id, request_text),
        )

    async def generate_prompt(
        self,
        *,
        user_query: str,
        artifact_family: ArtifactFamily,
        requirements: RequirementsChecklist,
        missing_requirement_ids: list[str],
        evidence: EvidencePack | None = None,
        evidence_summary: str | None = None,
        target_audience: str | None = None,
        delivery_channel: str | None = None,
        brand_context: str | None = None,
    ) -> ClarificationPrompt:
        await self.log(
            "Drafting a human-friendly clarification prompt for the missing requirements.",
            kind="thought",
            detail={"artifact_family": artifact_family.value, "missing_requirement_count": len(missing_requirement_ids)},
        )

        unresolved_ids = [
            requirement_id
            for requirement_id in missing_requirement_ids
            if not self._requirement_covered_by_context(
                requirement_id,
                user_query,
                evidence,
                target_audience=target_audience,
                delivery_channel=delivery_channel,
                brand_context=brand_context,
            )
        ]
        prioritized_ids = sorted(
            unresolved_ids,
            key=lambda requirement_id: self._question_priority(requirement_id, evidence),
        )
        questions = [
            self._question_from_requirement(item.requirement_id, item.text, artifact_family, user_query, evidence)
            for item in requirements.items
            if item.requirement_id in prioritized_ids and item.must_have
        ]

        if not questions:
            questions = [
                ClarificationQuestion(
                    requirement_id="clarification:default",
                    question="What are the most important details I should lock in before I generate the final artifact?",
                    why_it_matters="That lets me shape the final output to your real intent.",
                    answer_hint="Provide the key details, constraints, and priorities.",
                )
            ]

        question_payload = [
            {
                "requirement_id": question.requirement_id,
                "question": question.question,
                "why_it_matters": question.why_it_matters,
                "answer_hint": question.answer_hint,
                "answer_options": question.answer_options,
            }
            for question in questions
        ]
        evidence_context = {
            "summary": evidence.summary if evidence is not None else evidence_summary,
            "memory_findings": [finding.model_dump() for finding in (evidence.memory_findings if evidence is not None else [])][:5],
            "web_findings": [finding.model_dump() for finding in (evidence.web_findings if evidence is not None else [])][:5],
            "doc_findings": [finding.model_dump() for finding in (evidence.doc_findings if evidence is not None else [])][:5],
            "open_questions": list((evidence.open_questions if evidence is not None else [])[:5]),
            "contradictions": [item.model_dump() for item in (evidence.contradictions if evidence is not None else [])][:5],
            "freshness": evidence.freshness.model_dump() if evidence is not None else None,
            "provenance": evidence.provenance.model_dump() if evidence is not None else None,
            "confidence": evidence.confidence if evidence is not None else None,
        }

        headline = {
            ArtifactFamily.pitch_deck: "Let me lock the story before I draft the deck",
            ArtifactFamily.keynote: "I need a few speaking and pacing details",
            ArtifactFamily.poster: "I need a few design choices before I lay this out",
            ArtifactFamily.brochure: "I need a few structure details before I build the brochure",
            ArtifactFamily.one_pager: "I need a few framing choices before I condense this",
            ArtifactFamily.landing_page: "I need a few conversion details before I structure the page",
            ArtifactFamily.report: "I need a few context details before I write the report",
            ArtifactFamily.custom: "I need a few clarifications before I continue",
        }.get(artifact_family, "I need a few clarifications before I continue")

        intro_parts = [
            f"I can keep this moving, but I need a few details to make the {artifact_family.value.replace('_', ' ')} feel complete and relevant.",
        ]
        if target_audience:
            intro_parts.append(f"Current audience direction: {target_audience}.")
        if delivery_channel:
            intro_parts.append(f"Planned delivery channel: {delivery_channel}.")
        if brand_context:
            intro_parts.append(f"Brand context: {brand_context}.")
        if evidence_summary:
            intro_parts.append(f"Evidence so far: {evidence_summary}.")
        if evidence is not None and evidence.open_questions:
            intro_parts.append(f"The research still leaves these gaps open: {'; '.join(evidence.open_questions[:2])}.")

        draft: ClarificationDraft | None = None
        try:
            await self.log(
                "Synthesizing clarification questions from the request, checklist, and research evidence.",
                kind="thought",
                detail={"question_count": len(question_payload), "uses_model": True},
            )
            draft = await self.complete_json(
                ClarificationDraft,
                user_content=(
                    "Create the final human-facing clarification prompt.\n"
                    "Use the candidate questions as raw material, but improve them using the research evidence.\n"
                    "Requirements:\n"
                    "- Ask only the most useful unresolved questions.\n"
                    "- Keep the tone natural and product-strategic.\n"
                    "- Reference the evidence context in the intro when useful.\n"
                    "- Do not ask redundant questions that the evidence already answers.\n"
                    "- Prefer 1 to 5 questions; only ask more if truly necessary.\n"
                    "- Preserve each question's requirement_id.\n"
                    "- Return concise, answerable questions with why_it_matters and answer_options.\n"
                ),
                extra_context={
                    "user_query": user_query,
                    "artifact_family": artifact_family.value,
                    "target_audience": target_audience,
                    "delivery_channel": delivery_channel,
                    "brand_context": brand_context,
                    "candidate_questions": question_payload,
                    "evidence_context": evidence_context,
                    "fallback_headline": headline,
                    "fallback_intro": " ".join(intro_parts),
                },
            )
            if not draft.questions:
                draft = None
        except Exception:
            draft = None

        final_questions = draft.questions if draft is not None else questions
        for question in final_questions:
            if not question.answer_options:
                question.answer_options = self._generic_options_for_family(artifact_family, question.requirement_id, user_query)
        expected_answer_schema = {question.requirement_id: question.question for question in final_questions}
        blocked_question = " ".join([question.question for question in final_questions]).strip()
        prompt = ClarificationPrompt(
            headline=draft.headline if draft is not None else headline,
            intro=draft.intro if draft is not None else " ".join(intro_parts),
            questions=final_questions,
            blocked_question=blocked_question,
            expected_answer_schema=expected_answer_schema,
            family=artifact_family,
        )

        await self.log(
            f"Prepared {len(final_questions)} clarification question(s) for the user.",
            kind="decision",
            detail={"headline": prompt.headline, "question_count": len(final_questions), "uses_model": draft is not None},
        )
        return prompt
