from __future__ import annotations

import asyncio
import hashlib
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel, Field
from agentscope.tool import Toolkit

from agentscope_blaiq.contracts.evidence import (
    Citation,
    EvidenceContradiction,
    EvidenceFinding,
    EvidenceFreshness,
    EvidencePack,
    EvidenceProvenance,
    SourceRecord,
)
from agentscope_blaiq.runtime.agent_base import BaseAgent
from agentscope_blaiq.runtime.config import settings
from agentscope_blaiq.runtime.hivemind_mcp import HivemindMCPClient, HivemindMCPError
from agentscope_blaiq.tools.docs import load_uploaded_doc_findings, validate_uploaded_document
from agentscope_blaiq.tools.deduplication import deduplicate_sources_and_findings
from agentscope_blaiq.tools.web import fetch_url_summary


class ResearchDigest(BaseModel):
    summary: str
    open_questions: list[str] = Field(default_factory=list)
    confidence: float = Field(default=0.5, ge=0.0, le=1.0)
    recommended_followups: list[str] = Field(default_factory=list)


class MemoryQueryPlan(BaseModel):
    optimized_query: str
    alternate_queries: list[str] = Field(default_factory=list)
    focus_terms: list[str] = Field(default_factory=list)
    avoid_terms: list[str] = Field(default_factory=list)


class MemorySelectionDecision(BaseModel):
    memory_ids: list[str] = Field(default_factory=list)


class ResearchAgent(BaseAgent):
    URL_PATTERN = re.compile(r"https?://[^\s)>\]]+")
    DOMAIN_PATTERN = re.compile(r"https?://(?:www\.)?([^/\s]+)")
    BARE_DOMAIN_PATTERN = re.compile(r"\b(?:www\.)?([a-z0-9-]+\.[a-z]{2,})\b", re.IGNORECASE)
    PLANNER_TIMEOUT_SECONDS = 4.0
    SELECTOR_TIMEOUT_SECONDS = 3.0

    def __init__(self, *, hivemind: HivemindMCPClient | None = None, **kwargs) -> None:
        super().__init__(
            name="ResearchAgent",
            role="research",
            sys_prompt=(
                "You are the BLAIQ research agent. HIVE-MIND memory is the primary ground truth. "
                "Use live web only when memory is insufficient, stale, or external freshness is required. "
                "Return explicit provenance, contradictions, and source-backed findings."
            ),
            **kwargs,
        )
        self.hivemind = hivemind or HivemindMCPClient(
            rpc_url=settings.hivemind_mcp_rpc_url,
            api_key=settings.hivemind_api_key,
            timeout_seconds=settings.hivemind_timeout_seconds,
            poll_interval_seconds=settings.hivemind_web_poll_interval_seconds,
            poll_attempts=settings.hivemind_web_poll_attempts,
        )

    def build_toolkit(self) -> Toolkit:
        toolkit = Toolkit()
        toolkit.register_tool_function(self._tool_hivemind_recall, func_name="hivemind_recall", func_description="Recall enterprise memories relevant to the current request.")
        toolkit.register_tool_function(self._tool_hivemind_query_with_ai, func_name="hivemind_query_with_ai", func_description="Run synthesis over enterprise memory when direct recall is insufficient.")
        toolkit.register_tool_function(self._tool_hivemind_get_memory, func_name="hivemind_get_memory", func_description="Fetch a known memory record by id.")
        toolkit.register_tool_function(self._tool_hivemind_traverse_graph, func_name="hivemind_traverse_graph", func_description="Traverse related memories and linked decisions.")
        toolkit.register_tool_function(self._tool_hivemind_web_search, func_name="hivemind_web_search", func_description="Search the live web through HIVE-MIND when freshness is needed.")
        toolkit.register_tool_function(self._tool_hivemind_web_crawl, func_name="hivemind_web_crawl", func_description="Crawl URLs through HIVE-MIND for extraction.")
        toolkit.register_tool_function(self._tool_hivemind_web_job_status, func_name="hivemind_web_job_status", func_description="Resolve async HIVE-MIND web jobs.")
        toolkit.register_tool_function(self._tool_hivemind_web_usage, func_name="hivemind_web_usage", func_description="Inspect HIVE-MIND web quota and usage.")
        toolkit.register_tool_function(self._tool_validate_document, func_name="validate_document_path", func_description="Validate an uploaded document path before using it for research.")
        return toolkit

    async def _complete_structured_without_tools(
        self,
        model: type[BaseModel],
        *,
        user_content: str,
        extra_context: dict[str, Any] | None = None,
    ) -> BaseModel:
        planner = BaseAgent(
            name=f"{self.name}Planner",
            role=self.role,
            sys_prompt=self.sys_prompt,
            resolver=self.resolver,
            toolkit=Toolkit(),
        )
        return await planner.complete_json(
            model,
            user_content=user_content,
            extra_context=extra_context,
        )

    async def _tool_hivemind_recall(self, query: str, limit: int = 20, mode: str = "insight"):
        return self.tool_response(await self.hivemind.recall(query=query, limit=limit, mode=mode))

    async def _tool_hivemind_query_with_ai(self, question: str, context_limit: int = 8):
        return self.tool_response(await self.hivemind.query_with_ai(question=question, context_limit=context_limit))

    async def _tool_hivemind_get_memory(self, memory_id: str):
        return self.tool_response(await self.hivemind.get_memory(memory_id=memory_id))

    async def _tool_hivemind_traverse_graph(self, memory_id: str, depth: int = 2):
        return self.tool_response(await self.hivemind.traverse_graph(memory_id=memory_id, depth=depth))

    async def _tool_hivemind_web_search(self, query: str, domains: list[str] | None = None, limit: int = 5):
        return self.tool_response(await self.hivemind.web_search(query=query, domains=domains, limit=limit))

    async def _tool_hivemind_web_crawl(self, urls: list[str], depth: int = 1, page_limit: int = 5):
        return self.tool_response(await self.hivemind.web_crawl(urls=urls, depth=depth, page_limit=page_limit))

    async def _tool_hivemind_web_job_status(self, job_id: str):
        return self.tool_response(await self.hivemind.web_job_status(job_id=job_id))

    async def _tool_hivemind_web_usage(self):
        return self.tool_response(await self.hivemind.web_usage())

    def _tool_validate_document(self, path: str):
        return self.tool_response(validate_uploaded_document(Path(path)))

    @staticmethod
    def _now_iso() -> str:
        return datetime.now(timezone.utc).isoformat()

    @staticmethod
    def _normalize_memories(payload: dict[str, Any]) -> list[dict[str, Any]]:
        for key in ("memories", "results", "items", "data"):
            value = payload.get(key)
            if isinstance(value, list):
                return [item for item in value if isinstance(item, dict)]
        if isinstance(payload.get("memory"), dict):
            return [payload["memory"]]
        return []

    @staticmethod
    def _normalize_injection_text(payload: dict[str, Any]) -> str | None:
        candidates = [
            payload.get("injection_text"),
            payload.get("injectionText"),
        ]
        metadata = payload.get("metadata")
        if isinstance(metadata, dict):
            candidates.extend(
                [
                    metadata.get("injection_text"),
                    metadata.get("injectionText"),
                ]
            )
        for candidate in candidates:
            if isinstance(candidate, str) and candidate.strip():
                return candidate.strip()
        return None

    @staticmethod
    def _clean_injection_line(line: str) -> str:
        cleaned = re.sub(r"<[^>]+>", " ", line)
        cleaned = re.sub(r"^\s*(?:[-*•]|\d+[.)])\s*", "", cleaned)
        cleaned = re.sub(r"\s+", " ", cleaned).strip()
        return cleaned.strip(" :;-")

    @classmethod
    def _injection_memories(cls, injection_text: str) -> list[dict[str, Any]]:
        lines: list[str] = []
        seen: set[str] = set()
        for raw_line in injection_text.splitlines():
            cleaned = cls._clean_injection_line(raw_line)
            lowered = cleaned.lower()
            if not cleaned or len(cleaned) < 18:
                continue
            if cleaned == lowered:
                tokens = re.findall(r"[a-z0-9'-]+", lowered)
                if len(tokens) <= 10 and not any(token in {"i", "you", "user", "my"} for token in tokens):
                    continue
            if lowered in {
                "retrieved memories",
                "key facts",
                "observation log",
                "user profile",
                "session context",
                "chain of note",
            }:
                continue
            if lowered in seen:
                continue
            seen.add(lowered)
            lines.append(cleaned)

        memories: list[dict[str, Any]] = []
        for index, line in enumerate(lines, start=1):
            digest = hashlib.sha1(line.encode("utf-8")).hexdigest()[:12]
            title = line[:72].strip()
            if len(line) > 72:
                title = f"{title}..."
            memories.append(
                {
                    "memory_id": f"injection:{digest}",
                    "title": title or f"HIVE-MIND context {index}",
                    "content": line,
                    "summary": line,
                    "snippet": line,
                    "score": 0.68,
                    "source_type": "injection_text",
                    "project": "",
                }
            )
        return memories

    @staticmethod
    def _normalize_web_results(payload: dict[str, Any]) -> list[dict[str, Any]]:
        for key in ("results", "items", "pages", "content"):
            value = payload.get(key)
            if isinstance(value, list):
                return [item for item in value if isinstance(item, dict)]
        return []

    @staticmethod
    def _memory_source(memory: dict[str, Any]) -> SourceRecord:
        memory_id = str(memory.get("memory_id") or memory.get("id") or memory.get("uuid") or "memory:unknown")
        title = str(memory.get("title") or memory.get("name") or memory_id)
        return SourceRecord(
            source_id=memory_id,
            source_type="memory",
            title=title,
            location=memory_id,
            metadata={
                "project": str(memory.get("project") or ""),
                "source_type": str(memory.get("source_type") or ""),
            },
        )

    @staticmethod
    def _memory_finding(memory: dict[str, Any], source_id: str) -> EvidenceFinding:
        memory_id = str(memory.get("memory_id") or memory.get("id") or source_id)
        summary = str(memory.get("content") or memory.get("summary") or memory.get("snippet") or "").strip()
        return EvidenceFinding(
            finding_id=f"memory:{memory_id}",
            title=str(memory.get("title") or memory.get("name") or "Memory result"),
            summary=summary[:800],
            source_ids=[source_id],
            confidence=float(memory.get("score") or memory.get("confidence") or 0.72),
        )

    @staticmethod
    def _memory_citation(memory: dict[str, Any], source_id: str) -> Citation:
        excerpt = str(memory.get("snippet") or memory.get("summary") or memory.get("content") or "").strip()
        title = str(memory.get("title") or memory.get("name") or source_id)
        return Citation(source_id=source_id, label=title, excerpt=excerpt[:240] or None, url=None)

    @staticmethod
    def _web_source_from_result(result: dict[str, Any], fallback_index: int) -> SourceRecord:
        url = str(result.get("url") or result.get("link") or f"web-result:{fallback_index}")
        title = str(result.get("title") or url)
        return SourceRecord(
            source_id=url,
            source_type="web",
            title=title,
            location=url,
            metadata={"origin": "hivemind_web"},
        )

    @staticmethod
    def _web_finding_from_result(result: dict[str, Any], source_id: str, fallback_index: int) -> EvidenceFinding:
        summary = str(result.get("summary") or result.get("snippet") or result.get("content") or "").strip()
        return EvidenceFinding(
            finding_id=str(result.get("id") or f"web:{fallback_index}:{source_id}"),
            title=str(result.get("title") or source_id),
            summary=summary[:800],
            source_ids=[source_id],
            confidence=float(result.get("confidence") or result.get("score") or 0.62),
        )

    @staticmethod
    def _web_citation_from_result(result: dict[str, Any], source_id: str) -> Citation:
        excerpt = str(result.get("snippet") or result.get("summary") or result.get("content") or "").strip()
        return Citation(source_id=source_id, label=str(result.get("title") or source_id), excerpt=excerpt[:240] or None, url=source_id)

    @staticmethod
    def _should_use_memory_synthesis(query: str, memory_findings: list[EvidenceFinding]) -> bool:
        lowered = query.lower()
        return len(memory_findings) > 3 or any(token in lowered for token in ("summarize", "synthes", "recommend", "compare", "decision", "strategy"))

    @staticmethod
    def _should_use_graph(query: str) -> bool:
        lowered = query.lower()
        return any(token in lowered for token in ("related", "history", "decision", "dependency", "connected"))

    @staticmethod
    def _needs_web_freshness(query: str, scope: str, memory_findings: list[EvidenceFinding]) -> bool:
        lowered = query.lower()
        if ResearchAgent._is_personal_memory_query(query):
            freshness_terms = ("latest", "current", "recent", "today", "this year", "pricing", "docs", "release", "hannover messe")
            return any(term in lowered for term in freshness_terms)
        if scope == "web":
            return True
        freshness_terms = ("latest", "current", "recent", "today", "this year", "pricing", "docs", "release", "hannover messe")
        return not memory_findings or any(term in lowered for term in freshness_terms)

    @staticmethod
    def _is_personal_memory_query(query: str) -> bool:
        lowered = query.lower().strip()
        personal_markers = (
            "what do you know about me",
            "what do u know about me",
            "tell me about me",
            "who am i",
            "about myself",
            "about me",
            "my projects",
            "what projects am i working on",
            "what am i working on",
            "my company",
            "my work",
        )
        return any(marker in lowered for marker in personal_markers)

    @classmethod
    def _recall_mode_for_query(cls, query: str) -> str:
        lowered = query.lower()
        if cls._is_personal_memory_query(query):
            return "quick"
        if any(token in lowered for token in ("history", "timeline", "everything related", "panorama", "all decisions")):
            return "panorama"
        if any(token in lowered for token in ("pattern", "patterns", "insight", "compare", "decision", "strategy")):
            return "insight"
        return "quick"

    @staticmethod
    def _optimize_memory_query(query: str) -> str:
        lowered = query.lower().strip()
        rewrites = [
            ("create me a hiveind about myself", "what do you know about me"),
            ("create me a hivemind about myself", "what do you know about me"),
            ("tell me everything about myself", "what do you know about me"),
            ("about myself", "what do you know about me"),
            ("about me", "what do you know about me"),
            ("my projects", "what projects am i working on"),
            ("my work", "what am i working on"),
        ]
        for raw, optimized in rewrites:
            if raw in lowered:
                return optimized
        return query.strip()

    @classmethod
    def _is_natural_personal_memory_prompt(cls, query: str) -> bool:
        lowered = query.lower().strip()
        if not cls._is_personal_memory_query(query):
            return False
        starters = ("what", "who", "tell", "summarize", "explain", "do you know")
        return lowered.startswith(starters)

    async def _plan_memory_queries(self, query: str) -> tuple[list[str], list[str], list[str], str]:
        domains = self._extract_domains(query)
        fallback_plan = self._research_query_plan(query)
        if self._is_natural_personal_memory_prompt(query):
            direct_query = query.strip()
            return [direct_query], [], [], direct_query
        try:
            draft = await asyncio.wait_for(
                self._complete_structured_without_tools(
                    MemoryQueryPlan,
                    user_content=(
                        "Turn the user's request into the best possible HIVE-MIND memory-retrieval query plan.\n"
                        "Return retrieval queries only, not an answer.\n"
                        "Preserve the user's real intent while removing awkward wording that would hurt recall.\n"
                        "Prioritize internal-memory phrasing over artifact-generation phrasing when the user is asking about themselves, "
                        "their work, their projects, their company, or prior conversations.\n"
                        "If the user's wording is already a strong first-person memory query, preserve it as the primary query.\n"
                        "Keep the primary query concise and semantically faithful.\n"
                        "Add only a few alternate queries that materially increase recall coverage.\n"
                        "Return focus terms that good memories should contain.\n"
                        "Return avoid terms that indicate likely off-topic memories.\n"
                        "Do not invent facts, entities, or domains that are not grounded in the request.\n"
                        "Do not emit more than 5 total queries."
                    ),
                    extra_context={
                        "user_query": query,
                        "detected_domains": domains,
                        "fallback_query_plan": fallback_plan,
                    },
                ),
                timeout=self.PLANNER_TIMEOUT_SECONDS,
            )
            planned: list[str] = []
            for candidate in [draft.optimized_query, *draft.alternate_queries]:
                normalized = candidate.strip()
                if normalized and normalized not in planned:
                    planned.append(normalized)
            if not planned:
                raise ValueError("empty query plan")
            return planned[:5], draft.focus_terms, draft.avoid_terms, draft.optimized_query
        except Exception:
            return fallback_plan, [], [], fallback_plan[0] if fallback_plan else query.strip()

    @staticmethod
    def _intent_keywords(query: str) -> tuple[set[str], set[str]]:
        lowered = query.lower()
        include: set[str] = set()
        exclude: set[str] = set()

        if any(token in lowered for token in ("project", "working on", "work on", "initiative", "build", "company", "startup")):
            include.update({
                "project", "projects", "working", "work", "initiative", "initiatives", "company", "startup",
                "team", "product", "products", "blaiq", "hive-mind", "hivemind",
            })
            exclude.update({
                "founder", "role", "job", "internship", "architect", "lead", "siemens",
                "browsing", "apple", "iphone", "macbook", "watch", "shopping", "trade-in",
                "trip", "tokyo", "flight", "car", "tesla", "accident", "cat", "pottery", "apartment", "wedding",
            })
        elif any(token in lowered for token in ("what do you know about me", "what do u know about me", "tell me about me", "who am i")):
            include.update({
                "founder", "role", "job", "team", "project", "projects", "company", "startup", "education",
                "language", "salary", "office", "move", "architect", "lead", "internship", "work",
            })
        return include, exclude

    @classmethod
    def _memory_relevance_score(cls, query: str, memory: dict[str, Any]) -> float:
        include, exclude = cls._intent_keywords(query)
        if not include and not exclude:
            return 1.0

        haystack = " ".join(
            str(memory.get(key) or "")
            for key in ("title", "content", "summary", "snippet", "parent_chunk")
        ).lower()
        score = 0.0
        for token in include:
            if token in haystack:
                score += 1.0
        for token in exclude:
            if token in haystack:
                score -= 1.5
        return score

    @classmethod
    def _filter_memories_for_query(cls, query: str, memories: list[dict[str, Any]]) -> list[dict[str, Any]]:
        include, exclude = cls._intent_keywords(query)
        if not include and not exclude:
            return memories

        scored = [(cls._memory_relevance_score(query, memory), memory) for memory in memories]
        filtered = [memory for score, memory in scored if score > 0]
        if filtered:
            filtered.sort(key=lambda item: cls._memory_relevance_score(query, item), reverse=True)
            return filtered
        return memories

    async def _select_memories_for_query(
        self,
        query: str,
        memories: list[dict[str, Any]],
        *,
        focus_terms: list[str],
        avoid_terms: list[str],
    ) -> tuple[list[dict[str, Any]], str]:
        if not memories:
            return memories, "no_candidates"

        candidates: list[dict[str, Any]] = []
        id_map: dict[str, dict[str, Any]] = {}
        for index, memory in enumerate(memories, start=1):
            memory_id = str(memory.get("memory_id") or memory.get("id") or memory.get("uuid") or f"memory-{index}")
            haystack = " ".join(
                str(memory.get(key) or "")
                for key in ("title", "content", "summary", "snippet", "parent_chunk")
            )
            candidate = {
                "memory_id": memory_id,
                "title": str(memory.get("title") or memory.get("name") or memory_id),
                "excerpt": haystack[:400],
            }
            candidates.append(candidate)
            id_map[memory_id] = memory

        if self._is_personal_memory_query(query):
            return self._filter_memories_for_query(query, memories), "fallback"

        try:
            decision = await asyncio.wait_for(
                self._complete_structured_without_tools(
                    MemorySelectionDecision,
                    user_content=(
                        "Select the memories that are materially relevant to the user's request.\n"
                        "Keep memories that directly help answer the request.\n"
                        "Discard generic personal facts that do not match the user's current intent.\n"
                        "Be strict about project/work/company intent versus unrelated life events.\n"
                        "Return only the memory_ids to keep."
                    ),
                    extra_context={
                        "user_query": query,
                        "focus_terms": focus_terms,
                        "avoid_terms": avoid_terms,
                        "memory_candidates": candidates,
                    },
                ),
                timeout=self.SELECTOR_TIMEOUT_SECONDS,
            )
            selected = [id_map[memory_id] for memory_id in decision.memory_ids if memory_id in id_map]
            if selected:
                return selected, "llm"
        except Exception:
            pass

        return self._filter_memories_for_query(query, memories), "fallback"

    @classmethod
    def _extract_domains(cls, query: str) -> list[str]:
        domains: list[str] = []
        for match in cls.DOMAIN_PATTERN.findall(query):
            cleaned = match.strip().lower()
            if cleaned and cleaned not in domains:
                domains.append(cleaned)
        for match in cls.BARE_DOMAIN_PATTERN.findall(query):
            cleaned = match.strip().lower()
            if cleaned and cleaned not in domains:
                domains.append(cleaned)
        return domains

    @classmethod
    def _research_query_plan(cls, query: str) -> list[str]:
        optimized_query = cls._optimize_memory_query(query)
        lowered = optimized_query.lower().strip()
        planned: list[str] = []

        def add(candidate: str) -> None:
            normalized = candidate.strip()
            if normalized and normalized not in planned:
                planned.append(normalized)

        add(optimized_query)

        domains = cls._extract_domains(query)
        for domain in domains[:2]:
            add(f"{domain} company overview")
            add(f"{domain} product positioning")

        if any(token in lowered for token in ("pitch deck", "presentation", "pitch", "deck")):
            add(f"{optimized_query} audience value proposition")
            add(f"{optimized_query} proof points and credibility")

        if any(token in lowered for token in ("about myself", "about my company", "about my projects", "about bundb", "bundb.de")):
            add(f"{optimized_query} company background and offerings")

        if any(token in lowered for token in ("pricing", "latest", "current", "recent", "launch", "release")):
            add(f"{optimized_query} current status and latest updates")

        return planned[:5]

    @staticmethod
    def _detect_contradictions(memory_findings: list[EvidenceFinding], web_findings: list[EvidenceFinding]) -> list[EvidenceContradiction]:
        contradictions: list[EvidenceContradiction] = []
        memory_titles = {finding.title.lower(): finding for finding in memory_findings}
        for finding in web_findings:
            key = finding.title.lower()
            if key in memory_titles and finding.summary and memory_titles[key].summary and finding.summary[:180] != memory_titles[key].summary[:180]:
                contradictions.append(
                    EvidenceContradiction(
                        topic=finding.title,
                        description="Memory and web evidence differ on the same topic and should be reviewed before finalizing.",
                        source_ids=[*memory_titles[key].source_ids, *finding.source_ids],
                        severity="medium",
                    )
                )
        return contradictions

    @staticmethod
    def _classify_deduplicated_findings(
        deduplicated_findings: list[EvidenceFinding],
        original_memory_findings: list[EvidenceFinding],
        original_web_findings: list[EvidenceFinding],
        original_doc_findings: list[EvidenceFinding],
    ) -> tuple[list[EvidenceFinding], list[EvidenceFinding], list[EvidenceFinding]]:
        """
        Classify deduplicated findings back to their original types based on
        which original findings they most closely match.
        """
        memory_findings = []
        web_findings = []
        doc_findings = []

        for dedup_finding in deduplicated_findings:
            # Find the original finding this mostly came from
            # by matching on source_ids
            memory_score = sum(
                1 for orig in original_memory_findings
                if any(sid in dedup_finding.source_ids for sid in orig.source_ids)
            )
            web_score = sum(
                1 for orig in original_web_findings
                if any(sid in dedup_finding.source_ids for sid in orig.source_ids)
            )
            doc_score = sum(
                1 for orig in original_doc_findings
                if any(sid in dedup_finding.source_ids for sid in orig.source_ids)
            )

            # Classify to the source type with highest overlap
            if memory_score >= web_score and memory_score >= doc_score:
                memory_findings.append(dedup_finding)
            elif web_score >= doc_score:
                web_findings.append(dedup_finding)
            else:
                doc_findings.append(dedup_finding)

        return memory_findings, web_findings, doc_findings

    @staticmethod
    def _build_digest(
        query: str,
        *,
        memory_findings: list[EvidenceFinding],
        web_findings: list[EvidenceFinding],
        doc_findings: list[EvidenceFinding],
        contradictions: list[EvidenceContradiction],
    ) -> ResearchDigest:
        finding_count = len(memory_findings) + len(web_findings) + len(doc_findings)
        if finding_count == 0:
            return ResearchDigest(
                summary=f"No supporting evidence was found yet for '{query}'.",
                open_questions=["No supporting sources found yet."],
                confidence=0.25,
                recommended_followups=["Add internal memory context or uploaded documents before rendering."],
            )

        parts: list[str] = []
        if memory_findings:
            parts.append(f"{len(memory_findings)} memory finding{'s' if len(memory_findings) != 1 else ''}")
        if web_findings:
            parts.append(f"{len(web_findings)} web finding{'s' if len(web_findings) != 1 else ''}")
        if doc_findings:
            parts.append(f"{len(doc_findings)} uploaded document finding{'s' if len(doc_findings) != 1 else ''}")
        summary = f"Collected {' + '.join(parts)} for '{query}'."
        open_questions = []
        if contradictions:
            open_questions.append("Review contradictions between memory and web evidence before finalizing the artifact.")
        confidence_basis = [0.55, *[f.confidence for f in [*memory_findings, *web_findings, *doc_findings]]]
        confidence = min(0.97, max(confidence_basis))
        followups = []
        if not web_findings:
            followups.append("No live web verification was added to this run.")
        if not memory_findings:
            followups.append("No enterprise memory was available for this query.")
        return ResearchDigest(summary=summary, open_questions=open_questions, confidence=confidence, recommended_followups=followups)

    async def _gather_memory(self, query: str) -> tuple[list[SourceRecord], list[EvidenceFinding], list[Citation], str | None]:
        if not self.hivemind.enabled:
            return [], [], [], None
        planned_queries, focus_terms, avoid_terms, optimized_query = await self._plan_memory_queries(query)
        await self.log("Starting HIVE-MIND memory recall before any live web verification.", kind="status")
        if optimized_query.strip().lower() != query.strip().lower():
            await self.log(
                "Optimized the raw request into a memory-search prompt before recall.",
                kind="decision",
                detail={"raw_query": query, "optimized_query": optimized_query},
            )
        await self.log(
            f"Strategically broke the request into {len(planned_queries)} memory-first query pass{'es' if len(planned_queries) != 1 else ''}.",
            kind="thought",
            detail={"queries": planned_queries},
        )
        memories: list[dict[str, Any]] = []
        seen_memory_ids: set[str] = set()
        recall_mode = self._recall_mode_for_query(query)
        await self.log(f"Using HIVE-MIND recall mode: {recall_mode}.", kind="decision")
        for index, planned_query in enumerate(planned_queries, start=1):
            await self.log(
                f"Running HIVE-MIND recall pass {index}/{len(planned_queries)}.",
                kind="tool_call",
                detail={"query": planned_query, "mode": recall_mode},
            )
            recall_result = await self.hivemind.recall(query=planned_query, limit=20, mode=recall_mode)
            payload = self.hivemind._extract_tool_payload(recall_result)
            normalized_memories = self._normalize_memories(payload)
            injection_text = self._normalize_injection_text(payload)
            if injection_text:
                injection_memories = self._injection_memories(injection_text)
                if injection_memories:
                    await self.log(
                        f"Expanded recall pass {index} with {len(injection_memories)} injection-text evidence lines.",
                        kind="decision",
                    )
                    normalized_memories = [*normalized_memories, *injection_memories]
            for memory in normalized_memories:
                memory_id = str(memory.get("memory_id") or memory.get("id") or memory.get("uuid") or "")
                dedupe_key = memory_id or str(memory)
                if dedupe_key in seen_memory_ids:
                    continue
                seen_memory_ids.add(dedupe_key)
                memories.append(memory)
        filtered_memories, filter_mode = await self._select_memories_for_query(
            query,
            memories,
            focus_terms=focus_terms,
            avoid_terms=avoid_terms,
        )
        if len(filtered_memories) != len(memories):
            await self.log(
                f"Filtered recalled memories for query intent. Kept {len(filtered_memories)} of {len(memories)} candidates.",
                kind="decision",
                detail={"mode": filter_mode},
            )
        memories = filtered_memories
        sources: list[SourceRecord] = []
        findings: list[EvidenceFinding] = []
        citations: list[Citation] = []
        for memory in memories:
            source = self._memory_source(memory)
            finding = self._memory_finding(memory, source.source_id)
            citation = self._memory_citation(memory, source.source_id)
            sources.append(source)
            findings.append(finding)
            citations.append(citation)
        await self.log(f"Memory recall complete. Found {len(findings)} memory-backed findings.", kind="status")
        synthesis_summary: str | None = None
        if findings and self._should_use_memory_synthesis(query, findings):
            await self.log("Running HIVE-MIND synthesis over the recalled memory set.", kind="thought")
            synthesis = await self.hivemind.query_with_ai(question=query, context_limit=min(8, len(findings)))
            normalized = self.hivemind._extract_tool_payload(synthesis)
            synthesis_summary = str(normalized.get("answer") or normalized.get("summary") or normalized.get("content") or "").strip() or None
            if synthesis_summary:
                await self.log("Memory synthesis completed and added to the research brief.", kind="decision")
        if findings and self._should_use_graph(query):
            first_memory = memories[0]
            memory_id = str(first_memory.get("memory_id") or first_memory.get("id") or "")
            if memory_id:
                await self.log("Traversing related memories to pull in linked enterprise context.", kind="thought")
                graph = await self.hivemind.traverse_graph(memory_id=memory_id, depth=2)
                normalized = self.hivemind._extract_tool_payload(graph)
                related_count = len(self._normalize_memories(normalized))
                if related_count:
                    await self.log(f"Graph traversal found {related_count} linked memories worth considering.", kind="status")
        return sources, findings, citations, synthesis_summary

    async def _gather_web(self, query: str) -> tuple[list[SourceRecord], list[EvidenceFinding], list[Citation], bool]:
        await self.log("Verifying freshness with HIVE-MIND web intelligence.", kind="status")
        if self.hivemind.enabled:
            try:
                await self.log("Checking HIVE-MIND web quota before issuing a search.", kind="tool_call")
                await self.hivemind.web_usage()
            except Exception:
                pass
            domains = self._extract_domains(query)
            search_result = await self.hivemind.web_search(query=query, domains=domains or None, limit=5)
            normalized = self.hivemind._extract_tool_payload(search_result)
            job_id = str(normalized.get("job_id") or normalized.get("id") or "")
            payload = normalized
            if job_id:
                await self.log("Polling HIVE-MIND web job until results are ready.", kind="tool_call", detail={"job_id": job_id})
                payload = (await self.hivemind.poll_web_job(job_id=job_id)).payload
            results = self._normalize_web_results(payload)
            sources: list[SourceRecord] = []
            findings: list[EvidenceFinding] = []
            citations: list[Citation] = []
            for index, result in enumerate(results, start=1):
                source = self._web_source_from_result(result, index)
                finding = self._web_finding_from_result(result, source.source_id, index)
                citation = self._web_citation_from_result(result, source.source_id)
                sources.append(source)
                findings.append(finding)
                citations.append(citation)
            await self.log(f"Web verification complete. Found {len(findings)} live web findings.", kind="status")
            return sources, findings, citations, True

        await self.log("HIVE-MIND MCP is unavailable. Falling back to direct web fetch for freshness.", kind="decision")
        web_sources = []
        web_findings = []
        citations = []
        explicit_urls = self.URL_PATTERN.findall(query)
        for url in explicit_urls:
            await self.log(f"Fetching: {url}", kind="tool_call", detail={"url": url})
            source, finding, citation = await fetch_url_summary(url)
            web_sources.append(source)
            web_findings.append(finding)
            citations.append(citation)
        if explicit_urls:
            await self.log(f"Fallback web pass complete. Found {len(web_findings)} explicit web sources from the request.", kind="status")
            return web_sources, web_findings, citations, True
        await self.log("No explicit URLs were provided and HIVE-MIND web intelligence is unavailable, so I am skipping direct web verification.", kind="decision")
        return [], [], [], False

    async def gather(self, session: AsyncSession, tenant_id: str, query: str, scope: str) -> EvidencePack:
        memory_sources: list[SourceRecord] = []
        memory_findings: list[EvidenceFinding] = []
        memory_citations: list[Citation] = []
        synthesis_summary: str | None = None
        web_sources: list[SourceRecord] = []
        web_findings: list[EvidenceFinding] = []
        web_citations: list[Citation] = []
        doc_sources: list[SourceRecord] = []
        doc_findings: list[EvidenceFinding] = []
        doc_citations: list[Citation] = []
        used_web = False

        if scope in {"web", "web_and_docs"}:
            try:
                memory_sources, memory_findings, memory_citations, synthesis_summary = await self._gather_memory(query)
            except HivemindMCPError as exc:
                await self.log(f"HIVE-MIND memory retrieval failed: {exc}", kind="decision")
            if self._needs_web_freshness(query, scope, memory_findings):
                try:
                    web_sources, web_findings, web_citations, used_web = await self._gather_web(query)
                except HivemindMCPError as exc:
                    await self.log(f"HIVE-MIND web verification failed: {exc}", kind="decision")

        if scope in {"docs", "web_and_docs"}:
            await self.log("Scanning uploaded documents for tenant-specific evidence.", kind="status")
            doc_sources, doc_findings, doc_citations = await load_uploaded_doc_findings(session, tenant_id)
            if doc_findings:
                await self.log(f"Found {len(doc_findings)} findings from {len(doc_sources)} uploaded documents.", kind="status")
            else:
                await self.log("No uploaded documents found for this tenant.", kind="status")

        # Deduplicate sources and findings across all sources
        all_sources = [*memory_sources, *web_sources, *doc_sources]
        all_findings = [*memory_findings, *web_findings, *doc_findings]
        all_citations = [*memory_citations, *web_citations, *doc_citations]

        # Store original findings for classification after dedup
        original_memory_findings = memory_findings.copy()
        original_web_findings = web_findings.copy()
        original_doc_findings = doc_findings.copy()
        original_source_count = len(all_sources)

        # Apply deduplication
        if all_sources and all_findings:
            try:
                dedup_sources, dedup_findings, dedup_citations = deduplicate_sources_and_findings(
                    all_sources, all_findings, all_citations
                )
                dedup_count = original_source_count - len(dedup_sources)
                if dedup_count > 0:
                    await self.log(
                        f"Source deduplication reduced sources from {original_source_count} to {len(dedup_sources)} "
                        f"({dedup_count} merged, confidence scores boosted).",
                        kind="decision",
                        detail={"sources_merged": dedup_count, "final_sources": len(dedup_sources)},
                    )

                # Reclassify findings back to their source types
                memory_findings, web_findings, doc_findings = self._classify_deduplicated_findings(
                    dedup_findings, original_memory_findings, original_web_findings, original_doc_findings
                )
                all_sources = dedup_sources
                all_citations = dedup_citations
            except Exception as e:
                await self.log(f"Deduplication encountered an error (proceeding without it): {e}", kind="decision")

        contradictions = self._detect_contradictions(memory_findings, web_findings)
        if contradictions:
            await self.log("Contradictions detected between enterprise memory and live web evidence.", kind="review")
        digest = self._build_digest(
            query,
            memory_findings=memory_findings,
            web_findings=web_findings,
            doc_findings=doc_findings,
            contradictions=contradictions,
        )
        freshness = EvidenceFreshness(
            memory_is_fresh=bool(memory_findings),
            web_verified=used_web,
            freshness_summary="Live web verification added." if used_web else "Using enterprise memory and uploaded documents without live web verification.",
            checked_at=self._now_iso(),
        )
        provenance = EvidenceProvenance(
            memory_sources=len(memory_sources),
            web_sources=len(web_sources),
            upload_sources=len(doc_sources),
            graph_traversals=1 if self._should_use_graph(query) and memory_findings else 0,
            primary_ground_truth="memory" if memory_findings else ("uploads" if doc_findings else "web"),
            save_back_eligible=bool((memory_findings or doc_findings or web_findings) and not contradictions),
        )
        summary = synthesis_summary or digest.summary
        await self.log(
            f"Evidence assembled: memory={len(memory_findings)}, web={len(web_findings)}, uploads={len(doc_findings)}, confidence={digest.confidence:.2f}.",
            kind="decision",
            detail={
                "confidence": digest.confidence,
                "memory_findings": len(memory_findings),
                "web_findings": len(web_findings),
                "doc_findings": len(doc_findings),
                "contradictions": len(contradictions),
            },
        )
        return EvidencePack(
            summary=summary,
            sources=all_sources,
            memory_findings=memory_findings,
            web_findings=web_findings,
            doc_findings=doc_findings,
            open_questions=digest.open_questions,
            confidence=digest.confidence,
            citations=all_citations,
            contradictions=contradictions,
            freshness=freshness,
            provenance=provenance,
            recommended_followups=digest.recommended_followups,
        )

    async def answer_question(self, query: str, evidence: EvidencePack) -> str:
        await self.log("Synthesizing the final answer from HIVE-MIND recall and gathered evidence.", kind="thought")

        if not (evidence.memory_findings or evidence.web_findings or evidence.doc_findings):
            return "I don't have that in my memory."

        answer = await self.complete_text(
            user_content=(
                "SYSTEM:\n"
                "You are BLAIQ, a multi-agent memory and research system built by B&B.\n"
                "You are generating the final user-facing answer after the research agent has already gathered evidence.\n\n"
                "Rules:\n"
                "- Answer the user's question directly using only the evidence provided below.\n"
                "- Be concise: 1-3 sentences for simple questions, longer only when the question is genuinely complex.\n"
                "- If the evidence supports the answer, answer confidently.\n"
                "- If the evidence conflicts, prefer the most recent and clearly supported memory.\n"
                "- If the evidence is insufficient, say exactly: \"I don't have that in my memory.\"\n"
                "- Distinguish between things the user said, did, decided, or worked on versus things the user merely received, read, or was sent.\n"
                "- An email or note from someone else is not automatically the user's project, decision, or action.\n"
                "- When needed, make attribution explicit with natural phrasing like \"You mentioned...\" or \"From something you received...\"\n"
                "- Do not list every memory.\n"
                "- Do not include a 'Sources consulted' section, source list, citations block, or memory dump in the final answer.\n"
                "- Do not say \"Based on my memories\", \"According to my records\", or similar framing.\n"
                "- Do not invent names, timelines, projects, or relationships that are not supported by the evidence.\n"
                "- Prefer a natural answer over a forensic summary.\n\n"
                "USER QUESTION:\n"
                f"{query}\n\n"
                "Now answer the user."
            ),
            extra_context={
                "query": query,
                "evidence_summary": evidence.summary,
                "memory_findings": [finding.model_dump() for finding in evidence.memory_findings],
                "web_findings": [finding.model_dump() for finding in evidence.web_findings],
                "doc_findings": [finding.model_dump() for finding in evidence.doc_findings],
                "citations": [citation.model_dump() for citation in evidence.citations[:5]],
            },
        )
        await self.log("LLM answer synthesis completed from the current evidence pack.", kind="decision")
        return answer.strip()
