"""Single-director HyperAgent engine (Groq native local tool-calling).

ONE director agent runs a room turn end-to-end:
  gather (recall / org_directory / drive_search / docs_get → a per-turn shared
  blackboard) → when a decision/discussion is warranted it calls the `debate`
  tool (the room's personas as INDEPENDENT sub-LLM-calls: stance → challenge /
  support, real skepticism) → conclude with a grounded synthesis.

The loop is the canonical Groq agentic pattern (tools=[…], tool_choice=auto →
parse tool_calls → execute locally → append role:tool → repeat until no
tool_calls). Genuinely multi-agent AT the debate; one cheap session elsewhere.
The blackboard is a per-instance list (NOT a module global) so concurrent turns
across tenants never share state.

This module imports NOTHING from `api_hyper_rooms` — it takes the resolved
tenant scope + an async `emit(event)` callable and returns a result dict the
orchestrator folds into the existing produce / verify / seal pipeline.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from collections import Counter
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Dict, List, Optional

import httpx

from ..config import get_settings
from .skills import default_skill_for, load_method_skill, resolve_room_kind, skill_catalog
from ..hivemind_client import (
    connector_exec_emulated,
    connector_inspect_emulated,
    google_exec_emulated,
    org_members_emulated,
    recall_emulated,
    report_llm_usage,
    save_prospect_emulated,
    web_search_emulated,
)

log = logging.getLogger(__name__)

GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
_OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
# Cerebras' OWN inference API. Models it hosts natively (GLM synth) route DIRECT here
# with CEREBRAS_API_KEY — NOT via OpenRouter's Cerebras provider (owner policy 2026-07-23:
# "use GLM from Cerebras, not from OpenRouter"; also keeps synth off the OpenRouter bill).
_CEREBRAS_URL = (os.environ.get("CEREBRAS_BASE_URL") or "https://api.cerebras.ai/v1").rstrip("/") + "/chat/completions"
# Bare (slash-less) ids Cerebras serves on its own API. Env-overridable CSV. The GLM
# final-report synth writer (zai-glm-4.7, measured ~4s/2.8k-char report) lives here.
_CEREBRAS_DIRECT_MODELS = {m.strip() for m in
    (os.environ.get("HYPER_CEREBRAS_DIRECT_MODELS", "zai-glm-4.7")).split(",") if m.strip()}
_EMAIL_RE = re.compile(r"[\w.+-]+@[\w.-]+\.\w+")

# Groq model id → OpenRouter slug. None (or a NO_FALLBACK / unknown bare id) means
# "no OpenRouter text equivalent" → no fallback, the Groq failure is surfaced.
_OR_MODEL_MAP: Dict[str, str] = {
    "openai/gpt-oss-120b": "openai/gpt-oss-120b",
    "openai/gpt-oss-20b": "openai/gpt-oss-20b",
    "gpt-oss-120b": "openai/gpt-oss-120b",
    "gpt-oss-20b": "openai/gpt-oss-20b",
    "llama-3.3-70b-versatile": "meta-llama/llama-3.3-70b-instruct",
    "llama-3.1-8b-instant": "meta-llama/llama-3.1-8b-instruct",
    "llama-3.1-70b-versatile": "meta-llama/llama-3.1-70b-instruct",
    "zai-glm-4.7": "z-ai/glm-4.7",  # emergency failover only — primary is Cerebras-direct
}
# Agentic web-search / audio / vision / safety — never fall back to OpenRouter.
_OR_NO_FALLBACK = re.compile(r"compound|whisper|playai|tts|guard|vision|parakeet|moderation", re.I)


def _or_model(model: str) -> Optional[str]:
    """Map a Groq model id to its OpenRouter slug, or None when there is no safe
    text equivalent (→ caller keeps the Groq failure)."""
    if not model:
        return None
    if _OR_NO_FALLBACK.search(model):
        return None
    if model in _OR_MODEL_MAP:
        return _OR_MODEL_MAP[model]
    if "/" in model:  # already-namespaced slug (anthropic/*, google/*, …) is a valid OpenRouter id
        return model
    return None


# Groq-native models (Groq direct, or gpt-oss via OpenRouter→Cerebras failover).
# A vendor-namespaced, non-native model (google/, anthropic/, deepseek/, …) routes
# DIRECT to OpenRouter — no wasted Groq round-trip. Driven by HYPER_DIRECTOR_MODEL.
_GROQ_NATIVE_RE = re.compile(r"^(openai/gpt-oss|gpt-oss|llama-|llama3|mixtral|gemma|groq/|whisper)", re.I)
# Pin the OpenRouter provider per vendor → consistent low latency (avoids
# require_parameters routing to a slow-but-capable provider, e.g. WandB/StreamLake).
_OR_PROVIDER_PIN = {
    "google/": ["Google", "Google AI Studio"],
    "anthropic/": ["Anthropic"],
    "deepseek/": ["DeepSeek", "Fireworks"],
    # Model-SPECIFIC: Cerebras hosts 120b but NOT 20b — a bare "openai/gpt-oss" pin made
    # every 20b call (plan + debate personas) fall to a slow provider (measured: DekaLLM
    # ~60 tok/s, 3-25s/call = the room's latency gap) while 120b flew on Cerebras
    # (1.9k tok in 1.5s). 20b pins to OpenRouter's own Groq capacity (~1000 tok/s;
    # OpenRouter's account — unaffected by our dead Groq key).
    # Deep fast tier: a single-provider pin meant one hiccup dumped the call into the
    # open pool (measured: synth on DeepInfra 44 tok/s = 55s; debate on DekaLLM 20 tok/s).
    # Groq FIRST for both — cheapest that's also fast (120b: Groq $0.60 < Cerebras $0.75;
    # 20b: Groq $0.30, proven 695ms live). Fast alternates follow for when a parallel burst
    # throttles OpenRouter's Groq capacity. Our DIRECT Groq key is delinquent — this is
    # OpenRouter's Groq host; paying the Groq bill + HYPER_OPENROUTER_PRIMARY=0 = direct (no margin).
    # Cerebras FIRST for 120b: wafer-scale serving measured ~3000 tok/s (synth
    # 2.4k tok ≈ 2s) while Groq under load served the same call in 12-18s
    # (logged "SLOW — fell off the fast-provider pin" on 2026-07-14). Groq stays
    # the immediate fallback.
    "openai/gpt-oss-120b": ["Cerebras", "Together"],  # canonical 2026-07-23: Groq dropped (owner no-groq)
    # Fireworks dropped from the 20b pin — measured 13.5s and 39.3s per call live
    # (2026-07-07) vs Groq ~1.6-2.5s on the same calls; it was the plan-phase spike.
    "openai/gpt-oss-20b": ["Together", "Cerebras"],  # canonical: no Groq (Cerebras lacks 20b)
    "openai/gpt-oss": ["Cerebras"],
    "qwen/": ["Alibaba"],
    "moonshotai/": ["Moonshot AI", "Novita"],
}


# Set True the first time Groq returns a billing-block error → gpt-oss/llama then
# route DIRECT to OpenRouter→Cerebras (skip the wasted Groq 400 round-trips). Resets
# on process restart (re-probes Groq once), so funding Groq self-heals.
_GROQ_DEAD = False
# Judgment-shaped tasks (plans/strategy/recommendations/priorities/trade-offs) must
# convene the room even when the model-judged gate says "lookup" — deterministic backstop.
_JUDGMENT_RE = re.compile(
    r"\b(plan|plans|planning|strateg\w*|recommend\w*|priorit\w*|roadmap|budget\w*|"
    r"should we|what should|decide|decision|trade.?off|compare|versus|\bvs\b|"
    r"campaign|approach|proposal|options?)\b", re.IGNORECASE)

_BILLING_RE = re.compile(r"organization_delinquent|overdue payment|payment method|insufficient.*(quota|credit)|quota.*exceeded", re.I)

# Leading meta-planning cues that mark reasoning-model chain-of-thought
# ("We need to respond as Theo...", "The user asks:", "We must answer...").
_COT_PREAMBLE_RE = re.compile(
    r"^\s*(we (?:need|must|should|have|will|are asked)\b|"
    r"the user (?:asks|wants|is asking)\b|"
    r"let(?:'|’)?s\b|let me\b|first,? (?:i|we)\b|"
    r"okay,? (?:so|let)|i (?:need|should|must|will) (?:to )?)",
    re.IGNORECASE,
)


def _strip_cot(text: str) -> str:
    """Sanitise leaked reasoning so only a final humanised answer remains.

    Handles: Harmony channel markers (prefer the `final` channel), <think> tags,
    and marker-less analysis text that opens with planning cues. Last-resort
    guard behind reasoning.exclude — should rarely fire."""
    t = str(text or "").strip()
    if not t:
        return ""
    # Prefer an explicit Harmony final channel if present.
    m = re.search(r"<\|channel\|>final<\|message\|>([\s\S]*?)(?:<\|end\|>|<\|return\|>|$)", t)
    if m:
        return m.group(1).strip()
    t = re.sub(r"<think>[\s\S]*?</think>", "", t, flags=re.IGNORECASE).strip()
    t = re.sub(r"<\|channel\|>analysis<\|message\|>[\s\S]*?(?=<\||$)", "", t)
    t = re.sub(r"<\|[^>]*\|>", "", t).strip()
    # Marker-less CoT: drop leading planning sentences. If a blank-line break
    # exists, the final answer is usually the last block.
    if _COT_PREAMBLE_RE.match(t):
        blocks = [b.strip() for b in re.split(r"\n\s*\n", t) if b.strip()]
        if len(blocks) > 1 and not _COT_PREAMBLE_RE.match(blocks[-1]):
            return blocks[-1]
        # No clean break — drop the leading planning sentence run.
        sents = re.split(r"(?<=[.!?])\s+", t)
        kept = [s for i, s in enumerate(sents) if not (i < 3 and _COT_PREAMBLE_RE.match(s))]
        return " ".join(kept).strip() or t
    return t


def _route_direct_openrouter(model: str) -> bool:
    """A vendor-namespaced, non-Groq-native model → route DIRECT to OpenRouter.
    Once Groq is observed dead (_GROQ_DEAD), gpt-oss/llama also route direct (skip the
    wasted Groq 400s). compound has no OpenRouter equivalent → never direct-routed."""
    m = str(model or "")
    if not m or not os.environ.get("OPENROUTER_API_KEY"):
        return False
    if "compound" in m.lower():
        return False
    if _GROQ_NATIVE_RE.search(m):
        # OpenRouter-PRIMARY for the director: native gpt-oss/llama route DIRECT to OpenRouter from
        # call 1 (skip the wasted Groq probe) by default. Reversible per-process via
        # HYPER_OPENROUTER_PRIMARY=0 → revert to Groq-primary-with-failover (direct only once Groq dead).
        if os.environ.get("HYPER_OPENROUTER_PRIMARY", "1").lower() not in ("0", "false", "no", "off"):
            return True
        return _GROQ_DEAD
    return "/" in m


def _route_cerebras_direct(model: str) -> bool:
    """Model is hosted on Cerebras' OWN API → route DIRECT with CEREBRAS_API_KEY,
    bypassing OpenRouter entirely (owner policy: GLM synth comes from Cerebras, and
    keeps synth spend off the OpenRouter key). Bare slash-less ids in the allow-set."""
    m = str(model or "")
    return bool(m) and m in _CEREBRAS_DIRECT_MODELS and bool(os.environ.get("CEREBRAS_API_KEY"))


def _or_provider_pin(model: str) -> Optional[List[str]]:
    """OpenRouter provider order to pin for a model vendor (consistent latency)."""
    m = str(model or "")
    for pfx, order in _OR_PROVIDER_PIN.items():
        if m.startswith(pfx):
            return order
    return None


async def _openrouter_chat(body: Dict[str, Any], *, timeout: httpx.Timeout) -> Optional[Dict[str, Any]]:
    """Replay a Groq chat body against OpenRouter when Groq is unavailable.

    Groq stays PRIMARY: this is invoked ONLY after Groq's own retries are spent
    (zero added latency on the healthy path). Returns the parsed response JSON
    (Groq/OpenAI shape, `reasoning` coalesced into `content`/`reasoning_content`)
    or None when no fallback is possible.
    """
    or_key = os.environ.get("OPENROUTER_API_KEY", "")
    or_model = _or_model(str(body.get("model") or ""))
    if not or_key or not or_model:
        return None
    or_body = dict(body)
    or_body["model"] = or_model
    # Exclude reasoning from the response. gpt-oss (Harmony) returns its private
    # analysis channel in `reasoning`; with a thin/empty `content` the coalesce
    # below would otherwise dump that raw chain-of-thought ("We need to respond
    # as Theo, concise, 3-5 sentences...") straight into the room bubble. This
    # OpenRouter-layer flag makes the model reason internally but return ONLY the
    # final answer in `content`. Merges with any caller-supplied reasoning opts.
    or_body["reasoning"] = {**(or_body.get("reasoning") or {}), "exclude": True, "effort": "low"}  # effort=low → gpt-oss emits clean content for extractive tasks
    # Fastest provider that supports the request's params (tools / response_format),
    # with OpenRouter's own cross-provider fallback enabled.
    _pin = _or_provider_pin(or_model)
    # ignore: measured-slow hosts that keep winning price-ranked fallbacks (DekaLLM
    # served 20-60 tok/s twice). Env-overridable; empty string disables the blacklist.
    # SiliconFlow/Phala added 2026-07-07: fallback-pool leaks measured 9-36s per
    # 20b debate call (the room's remaining latency gap after the pin fix).
    _ignore = [s.strip() for s in os.environ.get("HYPER_OR_IGNORE", "DekaLLM,WandB,DeepInfra,Novita,Mancer,SiliconFlow,Phala").split(",") if s.strip()]
    or_body["provider"] = {**({"order": _pin} if _pin else {}),
                           **({"ignore": _ignore} if _ignore else {}),
                           "sort": "throughput", "allow_fallbacks": True, "require_parameters": True}
    or_body.pop("stream", None)
    _t0 = time.time()
    try:
        async with httpx.AsyncClient(timeout=timeout) as c:
            r = await c.post(
                _OPENROUTER_URL,
                headers={
                    "Authorization": f"Bearer {or_key}",
                    "HTTP-Referer": "https://hivemind.davinciai.eu",
                    "X-Title": "HIVEMIND",
                },
                json=or_body,
            )
        if r.status_code != 200:
            log.warning("[hyper-engine] OpenRouter fallback %s: %s", r.status_code, r.text[:200])
            return None
        j = r.json()
        msg = (j.get("choices") or [{}])[0].get("message") or {}
        if msg.get("reasoning") and not msg.get("reasoning_content"):
            msg["reasoning_content"] = msg["reasoning"]
        # Last-resort ONLY: if reasoning.exclude was honoured, `content` is the
        # final answer and this never fires. If a provider ignored exclude and
        # left content empty, fall back to reasoning — but sanitise it so raw
        # chain-of-thought planning never surfaces verbatim in the bubble.
        if not msg.get("content") and (msg.get("reasoning_content") or msg.get("reasoning")):
            msg["content"] = _strip_cot(msg.get("reasoning_content") or msg.get("reasoning") or "")
        # NOTE: this fires for the INTENDED OpenRouter-primary direct route too, not just
        # Groq failover — info-level + neutral wording (the old "Groq unavailable" text
        # spammed WARNs and misread as an outage on every healthy direct-routed call).
        # WHICH provider actually served + generation time = the latency truth. A live
        # 45s synth meant the call fell off the Cerebras pin onto a slow fallback —
        # invisible without this line.
        _ms = int((time.time() - _t0) * 1000)
        _prov = j.get("provider") or "?"
        _ctok = int(((j.get("usage") or {}).get("completion_tokens", 0)) or 0)
        (log.warning if _ms > 15000 else log.info)(
            "[hyper-engine] OpenRouter served model=%s provider=%s ms=%d out_tok=%d%s",
            or_model, _prov, _ms, _ctok,
            " SLOW — fell off the fast-provider pin?" if _ms > 15000 else "")
        return j
    except (httpx.TimeoutException, httpx.TransportError) as exc:
        log.warning("[hyper-engine] OpenRouter fallback transport error: %s", exc)
        return None
    except Exception as exc:  # noqa: BLE001
        log.warning("[hyper-engine] OpenRouter fallback failed: %s", exc)
        return None


async def _cerebras_chat(body: Dict[str, Any], *, timeout: httpx.Timeout,
                         cache_key: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """POST a chat body to Cerebras' OWN API (api.cerebras.ai) with CEREBRAS_API_KEY.
    OpenAI-compatible. Strips OpenRouter-only fields (provider / reasoning-exclude).

    Prompt caching: Cerebras caches prompt PREFIXES automatically (128-token blocks,
    5-min+ TTL) — no flag needed; our synth prompts are already static-first
    (system+skills prefix, dynamic task last) so repeat turns of a room hit the cache.
    The optional `prompt_cache_key` (a routing hint that keeps one workflow's turns on
    the same cache backend) is account-gated → only sent when HYPER_CEREBRAS_PROMPT_CACHE_KEY
    is truthy, else Cerebras 400s. cached_tokens are metered so the savings are visible.
    Returns parsed JSON (OpenAI shape) or None (→ caller may failover)."""
    key = os.environ.get("CEREBRAS_API_KEY", "")
    if not key:
        return None
    cb = {k: v for k, v in body.items() if k not in ("provider", "reasoning")}
    cb.pop("stream", None)
    if cache_key and os.environ.get("HYPER_CEREBRAS_PROMPT_CACHE_KEY", "").lower() in ("1", "true", "yes", "on"):
        cb["prompt_cache_key"] = str(cache_key)[:1024]
    _t0 = time.time()
    try:
        async with httpx.AsyncClient(timeout=timeout) as c:
            r = await c.post(_CEREBRAS_URL, headers={"Authorization": f"Bearer {key}"}, json=cb)
        if r.status_code != 200:
            log.warning("[hyper-engine] Cerebras-direct %s: %s", r.status_code, (r.text or "")[:200])
            return None
        j = r.json()
        msg = (j.get("choices") or [{}])[0].get("message") or {}
        # GLM emits its analysis in a side channel; the final answer is in `content`.
        # Coalesce reasoning into content ONLY if content came back empty (defensive —
        # mirrors _openrouter_chat), sanitising raw chain-of-thought.
        if msg.get("reasoning") and not msg.get("reasoning_content"):
            msg["reasoning_content"] = msg["reasoning"]
        if not msg.get("content") and (msg.get("reasoning_content") or msg.get("reasoning")):
            msg["content"] = _strip_cot(msg.get("reasoning_content") or msg.get("reasoning") or "")
        _ms = int((time.time() - _t0) * 1000)
        _u = j.get("usage") or {}
        _ctok = int(_u.get("completion_tokens", 0) or 0)
        _cached = int(((_u.get("prompt_tokens_details") or {}).get("cached_tokens", 0)) or 0)
        (log.warning if _ms > 15000 else log.info)(
            "[hyper-engine] Cerebras-direct served model=%s ms=%d out_tok=%d cached=%d%s",
            cb.get("model"), _ms, _ctok, _cached, " SLOW" if _ms > 15000 else "")
        return j
    except (httpx.TimeoutException, httpx.TransportError) as exc:
        log.warning("[hyper-engine] Cerebras-direct transport error: %s", exc)
        return None
    except Exception as exc:  # noqa: BLE001
        log.warning("[hyper-engine] Cerebras-direct failed: %s", exc)
        return None

# Quality skills loaded WITHIN the call (model-driven, not pre-inserted) — the
# functional equivalent of a Claude skill for the gpt-oss director. Each is a
# concrete authoring CONTRACT the director writes to AFTER it calls load_skill;
# the producer then renders the markdown into the real connector artifact (Google
# Doc / Sheet / Gmail draft), so the markdown shape here drives the final quality.
_SKILLS: Dict[str, str] = {
    "polished-doc": (
        "POLISHED DOC — write a publish-ready Google Doc in markdown:\n"
        "• Open with '# <specific, descriptive Title>' (NOT the room goal), then a 2-3 sentence "
        "executive summary that states the answer/recommendation up front.\n"
        "• Structure with '## <Section>' (and '### ' sub-sections); lead each section with its point.\n"
        "• **Bold** every key term, name, figure, date, and decision.\n"
        "• For ANY numeric / comparative / cost / schedule / options data, USE A MARKDOWN TABLE — it "
        "is drawn as a REAL Google Docs table. Syntax: a header row, then a '|---|---|' rule line, "
        "then data rows. Prefer a table over inline figures.\n"
        "• '- ' bullets for lists, '1. ' for ordered steps/timelines.\n"
        "• Ground every specific in a recall/web/connector result; give a range if a figure is "
        "uncertain; mark anything you could not confirm 'UNVERIFIED' inline and gather the open "
        "items into a short '## Gaps to confirm' section.\n"
        "• End with a concrete '## Next steps' checklist (owner + action). NO process narration, "
        "NO placeholders, NO fabricated links — paste only REAL urls a tool returned."
    ),
    "polished-email": (
        "POLISHED EMAIL — write a tight, professional email:\n"
        "• 'Subject:' line — specific and informative (not generic like 'Update').\n"
        "• One-line greeting addressing the recipient BY NAME.\n"
        "• Body: 2-4 short sentences following context → value → the single ask. One clear CTA.\n"
        "• Professional sign-off.\n"
        "• Inline only REAL urls a tool returned — never invent a link, attachment, or 'see doc' "
        "reference that does not exist.\n"
        "• Do not state UNVERIFIED facts as certain; if a number is unconfirmed, soften or omit it. "
        "Keep it skimmable — no walls of text, no process narration."
    ),
    "decision-brief": (
        "DECISION BRIEF (DACI) — write a crisp decision memo in markdown:\n"
        "• '# <Decision title>' then a one-line **DECISION:** statement up top.\n"
        "• '## Context' — 1-2 sentences on why this decision, now.\n"
        "• '## Options considered' — a markdown TABLE: | Option | Pros | Cons | Cost / risk | (one row "
        "per real option, grounded).\n"
        "• '## Rationale' — 3-5 grounded bullets citing the debate + recall/web evidence (name who "
        "argued what when a debate happened).\n"
        "• '## Risks & UNVERIFIED' — honest open items / assumptions, each flagged.\n"
        "• '## Owners & next steps' — a TABLE: | Step | Owner | Timeline |. "
        "No fabrication; ground or flag every figure."
    ),
    "polished-sheet": (
        "POLISHED SHEET — output ONLY a single markdown table, nothing else:\n"
        "• First row = column headers chosen to directly answer the ask; then a '|---|' rule line; "
        "then one data row per item.\n"
        "• One fact per cell; keep cells short; no prose, no commentary around the table.\n"
        "• Ground every cell in a tool result; write '(UNVERIFIED)' in a cell you could not confirm "
        "rather than inventing a value."
    ),
    "status-update": (
        "STATUS UPDATE — concise, scannable, grounded:\n"
        "• Group by area or by DONE / IN PROGRESS / BLOCKED (or YESTERDAY / TODAY / BLOCKERS for a "
        "standup).\n"
        "• One '- ' bullet per item, each with the concrete fact + owner where relevant.\n"
        "• **Bold** blockers and dates. Flag anything UNVERIFIED. No filler, no narration."
    ),
    "notion-page": (
        "NOTION PAGE — write publish-ready content the producer will create as a Notion page:\n"
        "• Do NOT write a title line or '# Heading' first — the page title is set separately, so a "
        "leading title would duplicate. Open with a 1-2 sentence summary that states the answer up front.\n"
        "• Structure with '## <Section>' headings; lead each section with its point.\n"
        "• '- ' bullets for lists, '1. ' for ordered steps; **bold** key terms, names, figures, dates.\n"
        "• For ANY comparative / cost / options / schedule data, USE A MARKDOWN TABLE (header row, a "
        "'|---|---|' rule, then data rows) — Notion renders it as a real table.\n"
        "• Ground every specific in a recall/web/connector result; mark anything unconfirmed "
        "'(UNVERIFIED)' inline and collect open items under a short '## Gaps to confirm'.\n"
        "• NO process narration, NO placeholders, NO fabricated links — paste only REAL urls a tool returned."
    ),
}

_GOOGLE_CONNECTORS = ("google-docs", "google_docs", "googledrive", "google-drive", "gmail", "google")

# Curated READ tools per Google connector (the native google bridge has no param
# schemas, so we hand-spec the read surface). Writes (docs_create/gmail_send/…)
# are intentionally excluded — the centralized producer + HITL own those.
_GOOGLE_READ_TOOLS: Dict[str, List[tuple]] = {
    "gmail": [
        ("gmail_search", "Search the room owner's live Gmail. Gmail query syntax (e.g. 'from:rama after:2026/01/01').",
         {"query": {"type": "string"}, "max": {"type": "integer"}}, ["query"]),
        ("gmail_get", "Read one Gmail message (full body + headers) by its id.", {"id": {"type": "string"}}, ["id"]),
        ("gmail_get_thread", "Read a full Gmail thread by threadId.", {"threadId": {"type": "string"}}, ["threadId"]),
    ],
    "google-docs": [
        ("drive_search", "Find Google Drive files (docs/sheets) by name or content.", {"query": {"type": "string"}}, ["query"]),
        ("docs_get", "Read an existing Google Doc's text by documentId.", {"documentId": {"type": "string"}}, ["documentId"]),
    ],
    "google-drive": [
        ("drive_search", "Find Google Drive files (docs/sheets) by name or content.", {"query": {"type": "string"}}, ["query"]),
        ("docs_get", "Read an existing Google Doc's text by documentId.", {"documentId": {"type": "string"}}, ["documentId"]),
    ],
    "google-sheets": [
        ("sheets_get", "Read a Google Sheet's cell values by spreadsheetId (optional A1 range).",
         {"spreadsheetId": {"type": "string"}, "range": {"type": "string"}}, ["spreadsheetId"]),
    ],
    "google-calendar": [
        ("calendar_search", "Search the room owner's Google Calendar events.", {"query": {"type": "string"}}, ["query"]),
    ],
}
_GOOGLE_TOOL_NAMES = {n for tools in _GOOGLE_READ_TOOLS.values() for (n, *_rest) in tools}
# Tool-count discipline (Groq best-practice: keep the action space small). Total
# connector tools exposed to the director, and per-connector cap for MCP discovery.
_CONNECTOR_TOOL_CAP = max(0, int(os.environ.get("HYPER_CONNECTOR_TOOL_CAP", "8") or "8"))
_MCP_TOOLS_PER_CONNECTOR = max(1, int(os.environ.get("HYPER_MCP_TOOLS_PER_CONNECTOR", "4") or "4"))
# connection_search (eve's lazy connector-tool discovery, adapted): instead of listing EVERY
# registered connector tool in the gather-plan prompt, surface only the ones lexically relevant
# to this task + one entry-point tool per connector (so none becomes unreachable). Deterministic
# — NO extra LLM call, because an LLM "search" call would cost more tokens than the compact
# name-list (~60-120 tok) it saves at this scale. The win scales with connector count / a raised
# HYPER_CONNECTOR_TOOL_CAP. Flag-gated, default OFF. Full routes stay reachable if named.
_CONNECTION_SEARCH = os.environ.get("HYPER_CONNECTION_SEARCH", "0").strip().lower() not in ("0", "false", "no", "off")
_CONN_SEARCH_KEEP = max(2, int(os.environ.get("HYPER_CONN_SEARCH_KEEP", "6") or "6"))
_READ_TOOL_HINTS = ("search", "list", "get", "read", "fetch", "query", "find", "lookup", "describe", "recent", "view", "history")

# ── Population-Sim (ADDITIONAL, opt-in) — a cheap many-voice social simulation that runs
# AFTER gather and feeds its report into the synthesis. Modeled on MiroFish CSI. Bursts on
# the cheap model with a fallback chain; the report on the strong synth model. All bounded +
# wrapped so a failure NEVER breaks the main turn.
_SIM_AGENT_MODEL = os.environ.get("HYPER_SIM_AGENT_MODEL", "openai/gpt-oss-20b")  # canonical: no llama
_SIM_FALLBACKS = [m.strip() for m in os.environ.get(
    "HYPER_SIM_FALLBACKS", "openai/gpt-oss-20b,openai/gpt-oss-120b").split(",") if m.strip()]
_SIM_PERSONAS = max(4, min(150, int(os.environ.get("HYPER_SIM_PERSONAS", "24") or "24")))
_SIM_TYPES = max(3, min(20, int(os.environ.get("HYPER_SIM_TYPES", "8") or "8")))
_SIM_CONCURRENCY = max(2, int(os.environ.get("HYPER_SIM_CONCURRENCY", "10") or "10"))
_SIM_ON = {"on", "simulation", "additional", "true", "1", "yes"}

# ── Self-evolving employees (Loop 1: episodic playbook memory) ──────────────
# Proven before wiring (scripts/swarm_spike/self_evolve_spike.py): a weak 8B employee
# that reflects each turn's outcome into a playbook and recalls it next turn lifted
# UNSEEN held-out decisions from 0.354 → 0.669 (+0.315), closing 81% of the gap to being
# told the rules outright. Fully ADDITIVE + flag-gated + wrapped: a failure is a no-op.
_EVO_ON = {"on", "evolve", "true", "1", "yes"}
_EVO_ENABLED = (os.environ.get("HYPER_EVOLVE_ENABLED", "true").strip().lower() not in ("0", "false", "no", "off"))
_EVO_REFLECT_MODEL = os.environ.get("HYPER_EVOLVE_REFLECT_MODEL", "openai/gpt-oss-20b")  # cheap coach call
_EVO_RECALL_K = max(2, min(8, int(os.environ.get("HYPER_EVOLVE_RECALL_K", "5") or "5")))  # lessons injected
_EVO_CAP = max(4, min(30, int(os.environ.get("HYPER_EVOLVE_CAP", "12") or "12")))          # max lessons/employee
_EVO_WORD = re.compile(r"[a-z0-9]{4,}")

# ── Room METHOD skills (progressive disclosure) ─────────────────────────────
# Catalog (name + one-liner) always visible to the planner; bodies loaded onto
# the blackboard only when selected. Distinct from _SKILLS (output FORMAT).
_METHOD_SKILLS_ENABLED = (os.environ.get("HYPER_SKILLS_ENABLED", "true").strip().lower()
                          not in ("0", "false", "no", "off"))
# Reactor reach (NEED: protocol in debate round 2) — off until observed live.
_REACTOR_REACH = (os.environ.get("HYPER_REACTOR_REACH", "false").strip().lower()
                  in ("1", "true", "yes", "on"))

# ── Board digest (debate-context compression) ──────────────────────────────
# The debate fan-out re-pays the gathered blackboard N×2 times. Compress it ONCE into a
# goal-scoped, fact-preserving digest fed to the DEBATE only; synth keeps the raw board.
# Proven (scripts/swarm_spike/digest_board_spike.py): ~47% less debate input on a fat board
# with NO quality loss (digest strips noise → debaters ground cleaner). Compressing the synth
# too (the deliverable's source) craters grounding — so synth ALWAYS keeps raw.
_DIGEST_ENABLED = (os.environ.get("HYPER_DIGEST_ENABLED", "true").strip().lower() not in ("0", "false", "no", "off"))
# Was llama (gpt-oss could route plain text to the analysis channel → empty content). Now
# gpt-oss-20b + reasoning.effort=low + the reasoning→content coalesce → clean extractive content,
# honoring the "no llama" rule without regressing.
_DIGEST_MODEL = os.environ.get("HYPER_DIGEST_MODEL", "openai/gpt-oss-20b")
_DIGEST_MIN_CHARS = max(1500, int(os.environ.get("HYPER_DIGEST_MIN_CHARS", "2500") or "2500"))  # gate: engage on a moderately-full board (spike: +21% even at ~2k chars)
_DIGEST_MAX_CHARS = max(800, int(os.environ.get("HYPER_DIGEST_MAX_CHARS", "2400") or "2400"))   # bound the digest
_DIGEST_READ_CAP = max(4000, int(os.environ.get("HYPER_DIGEST_READ_CAP", "12000") or "12000"))  # cap the digester's own input

# ── Swarm journal (episodic continuity) ────────────────────────────────────
# A compact, ordered, per-turn log injected at the START of plan + synth so a turn RECALLS prior
# turns ("as we decided…"). Proven (scripts/swarm_spike/journal_spike.py): journal arm recalls a
# prior-turn figure 0.45 vs blank arm 0.00 (blank FABRICATES). Bounded (last N entries) → no token
# regression. Distinct from evo_playbooks (skills) — this is episodic memory of WHAT HAPPENED.
_JOURNAL_ENABLED = (os.environ.get("HYPER_JOURNAL_ENABLED", "true").strip().lower() not in ("0", "false", "no", "off"))
_JOURNAL_MODEL = os.environ.get("HYPER_JOURNAL_MODEL", "openai/gpt-oss-20b")  # canonical: no llama (effort=low returns content)
_JOURNAL_KEEP = max(2, min(20, int(os.environ.get("HYPER_JOURNAL_KEEP", "6") or "6")))  # entries injected/kept

# ── Self-revision (reflexion on the final deliverable) ─────────────────────
# ONE bounded critique→revise pass after synth: the synth model re-reads its OWN draft against the
# GATHERED BOARD (the only ground-truth — works for ANY room/tenant, zero hardcoded rules) and
# corrects three GENERAL failure classes before the turn seals:
#   (1) FABRICATION — any concrete specific (date/number/%/metric/price/person/contact/product-capability)
#       not traceable to the board → omit or [placeholder] + surface under Gaps; never assert as fact.
#   (2) INTERNAL-PROCESS LEAK — when the ask is an external artifact (email/copy/post/talking-points),
#       strip facilitator/agent names, "the debate", "who argued what", inline (UNVERIFIED); no invented signatory.
#   (3) FORMAT MISFIT — a diagram (mermaid/ascii) only where the medium renders it; never in an email/spoken script.
# Catches synth-level defects BEFORE the (expensive) goalkeeper re-runs the whole turn → higher quality
# AND cheaper. Bounded to 1 pass, skipped on the direct fast-path + tiny drafts (nothing to revise),
# flag-gated (reversible). Composes with — does NOT replace — the P6 goalkeeper outer net.
_SELF_REVISE = (os.environ.get("HYPER_SELF_REVISE", "true").strip().lower() not in ("0", "false", "no", "off"))
_SELF_REVISE_MIN_CHARS = max(200, int(os.environ.get("HYPER_SELF_REVISE_MIN_CHARS", "400") or "400"))
_SELF_REVISE_MAX_CYCLES = max(1, min(4, int(os.environ.get("HYPER_SELF_REVISE_MAX_CYCLES", "2") or "2")))

# ── Gather deepening (recall-sufficiency recursion) ─────────────────────────
# After the first gather, a cheap judge asks: is there enough GROUNDED company-specific material
# to answer the task SPECIFICALLY, or is the board too thin (→ the synth would pad with generic
# scaffolding)? If thin, it proposes new-angle recall queries (decompose the task, name each
# entity, try synonyms) and re-gathers ONCE. No magic thresholds — an LLM judges sufficiency, same
# shape as the synth self-revise. General for any room/agent; skipped on the direct fast-path;
# bounded to one extra round; flag-gated. Fixes "thin recall → generic answer" at the SOURCE.
_GATHER_DEEPEN = (os.environ.get("HYPER_GATHER_DEEPEN", "true").strip().lower() not in ("0", "false", "no", "off"))
_GATHER_DEEPEN_MAX_Q = max(1, min(6, int(os.environ.get("HYPER_GATHER_DEEPEN_MAX_Q", "4") or "4")))

# Web PROSPECTING: a query needing real-world contacts/businesses/people gets the strict
# verbatim-or-NOT-VERIFIED extraction contract on the deep compound crawl (web_search + visit_website).
# The regex picks prospecting intent — prompt selection only, never an output gate → general for any room.
_PROSPECT_RE = re.compile(
    r"\b(e-?mail|contact|reach\s*out|outreach|prospect|lead|client|customer|compan(y|ies)|"
    r"business(es)?|firm|gym|clinic|practice|phone|impressum|kontakt|recipient|address)\w*", re.I)

# Run-wide output language (FE navbar toggle). locale code → language NAME; "" / English → no directive.
_LANG_NAMES = {"en": "English", "de": "German", "fr": "French", "es": "Spanish", "it": "Italian",
               "pt": "Portuguese", "nl": "Dutch", "pl": "Polish", "tr": "Turkish", "ru": "Russian",
               "ja": "Japanese", "zh": "Chinese", "ar": "Arabic", "hi": "Hindi", "ko": "Korean",
               "sv": "Swedish", "da": "Danish", "no": "Norwegian", "fi": "Finnish", "cs": "Czech"}


def _now_block() -> str:
    """TIME CONTEXT prepended to every prompt site (plan, director/synth system,
    debate consults). Without it the model defaults to its training-era timeline —
    a live run produced a 'Q1 2025' calendar in July 2026 because a memory-only
    gather had no date anchor and recalled facts mentioned 2025. Recalled memory
    CONTENT may reference past dates; agents must reason from TODAY."""
    now = datetime.now(timezone.utc)
    q = (now.month - 1) // 3 + 1
    nq, ny = (q % 4 + 1, now.year + (1 if q == 4 else 0))
    return (f"TIME CONTEXT: today is {now.strftime('%A, %d %B %Y')} (UTC). The current quarter is "
            f"Q{q} {now.year}; the NEXT quarter is Q{nq} {ny}. Anchor ALL dates, timelines, quarters "
            f"and schedules to this — dates found in recalled memories may be historical.\n\n")


def _resolve_language(lang: str) -> str:
    """Map a locale code or name ('fr' / 'French' / 'fr-FR') to a language NAME. '' or English → ''
    (no directive → default English behavior, zero overhead)."""
    s = (lang or "").strip().lower()
    if not s or s.split("-")[0] in ("en", "english"):
        return ""
    name = _LANG_NAMES.get(s.split("-")[0]) or (lang.strip().title() if lang.strip().isalpha() else "")
    return "" if name.lower() == "english" else name


# Maps/Places discovery is EXPENSIVE and pollutes the board when unwanted — run it
# ONLY when THIS turn actually asks to find NEW real-world orgs/contacts. A turn that
# drafts emails, writes a sequence, or reasons over already-known targets must NOT
# re-run discovery. Verb-of-finding + a discoverable object; drafting verbs veto it.
# Verbs that mean "source something new". `generate|build|create|compile|assemble`
# were missing, so even the literal "generate leads" failed the gate and Maps
# never ran.
_DISCOVERY_VERBS = (
    r"(?:find|get|source|sources?|list|give\s+me|need|pull|gather|identif\w+|show\s+me|"
    r"look\s+up|search\s+for|discover|reach\s+out|prospect\w*|scrape|generate|build|"
    r"create|compile|assemble|put\s+together)"
)
# Discoverable objects. The original list held only GENERIC nouns, so the most
# natural way to ask for Maps prospects — naming the actual business type
# ("dental clinics in Munich", "restaurants near Cologne") — was blocked.
_DISCOVERY_NOUNS = (
    r"(?:prospects?|leads?|clients?|customers?|contacts?|companies|compan\w+|firms?|"
    r"institutions?|organi[sz]ations?|partners?|niches?|decision[-\s]?makers?|buyers?|"
    r"accounts?|buisness\w*|businesses|business|venues?|practices?|clinics?|surgeries|"
    r"shops?|stores?|agencies|agency|studios?|restaurants?|cafes?|hotels?|dealers?|"
    r"dealerships?|suppliers?|manufacturers?|distributors?|retailers?|wholesalers?|"
    r"contractors?|providers?|offices?|centers?|centres?|schools?|gyms?|salons?|"
    r"pharmacies|hospitals?|labs?|laboratories|startups?|vendors?)"
)
_DISCOVERY_RE = re.compile(
    rf"\b{_DISCOVERY_VERBS}\b[^.\n]{{0,60}}?\b{_DISCOVERY_NOUNS}\b", re.I)
# Geo-anchored fallback: a find-verb plus an explicit PLACE is a Maps query even
# when the business type isn't in the noun list ("find Steuerberater in Hamburg").
# The negative lookahead keeps "leads in our pipeline" / "in the market" out.
_DISCOVERY_GEO_RE = re.compile(
    rf"\b{_DISCOVERY_VERBS}\b[^.\n]{{0,80}}?\b(?:in|near|around|within|across)\s+"
    r"(?!our\b|the\b|this\b|that\b|these\b|those\b|your\b|my\b|their\b|its\b|it\b|"
    r"order\b|general\b|mind\b|total\b|time\b|advance\b|house\b|scope\b|charge\b)"
    r"[A-Za-zÄÖÜäöüß][\w\-]{2,}",
    re.I)
_DRAFTING_RE = re.compile(
    r"\b(draft|write|compose|rewrite|edit|revise|sequence|template|email\s+copy|"
    r"subject\s+line|follow[-\s]?up|cadence|send\s+(?:the|this|these|it|them)|"
    r"summari[sz]e|translate|explain|analy[sz]e|compare|plan\b|strategy|roadmap)\b", re.I)


def _wants_discovery(user_message: str) -> bool:
    """True only when THIS turn's message asks to source NEW real-world orgs/contacts."""
    msg = str(user_message or "")
    if not (_DISCOVERY_RE.search(msg) or _DISCOVERY_GEO_RE.search(msg)):
        return False
    # A drafting/analysis turn with NO explicit find-verb-on-contacts stays off, but
    # an explicit "find/give me contacts" wins even if drafting words co-occur.
    if _DRAFTING_RE.search(msg) and not re.search(
            rf"\b{_DISCOVERY_VERBS}\b[^.\n]{{0,40}}?\b{_DISCOVERY_NOUNS}\b", msg, re.I):
        return False
    return True


def _first_json_object(text: str) -> Optional[Dict[str, Any]]:
    """Extract the first JSON object from a model reply (handles plain JSON, fenced, or prose-wrapped).
    Returns the parsed dict, or None when nothing valid parses (caller treats None as fail-safe)."""
    if not text:
        return None
    try:
        obj = json.loads(text)
        return obj if isinstance(obj, dict) else None
    except Exception:  # noqa: BLE001
        pass
    m = re.search(r"\{.*\}", text, re.S)
    if m:
        try:
            obj = json.loads(m.group(0))
            return obj if isinstance(obj, dict) else None
        except Exception:  # noqa: BLE001
            return None
    return None


def _journal_positions(transcript: Optional[List[Dict[str, Any]]]) -> str:
    """Compact 'what each agent argued this turn' from the debate transcript — the per-agent slice.
    Latest contribution per agent, trimmed. Empty when there was no debate (direct/fast-path turn)."""
    if not transcript:
        return ""
    latest: Dict[str, str] = {}
    for x in transcript:
        if isinstance(x, dict) and x.get("agent") and x.get("text"):
            latest[str(x["agent"])] = str(x["text"])  # later rounds overwrite → keep the agent's final stance
    if not latest:
        return ""
    rows = "\n".join(f"- {name}: {text[:240]}" for name, text in list(latest.items())[:5])
    return f"\n\nWHAT EACH AGENT ARGUED:\n{rows}"


async def make_journal_entry(user_message: str, final_text: str, *,
                             transcript: Optional[List[Dict[str, Any]]] = None,
                             model: Optional[str] = None) -> Optional[str]:
    """Compact this turn into ONE figure-preserving journal line for future turns (the Claude-Code
    compaction model). Keeps the decision + key numbers verbatim (the spike showed dropping figures
    halves recall) AND a per-agent positions slice when a debate happened (so agents stay consistent
    with their own prior stance). Returns the line or None on failure. Called by the api AFTER seal."""
    if not _JOURNAL_ENABLED:
        return None
    try:
        pos = _journal_positions(transcript)
        fmt = ("\"asked: <≤10 words> | decided: <decision + EVERY key figure/amount/%/date verbatim, ≤28 words>"
               + (" | positions: <≤6 words per agent, 'Name: stance; …', ONLY agents who took a clear stance>\""
                  if pos else "\""))
        sysp = ("Summarize this room turn into ONE compact journal line for future turns. Format EXACTLY: "
                + fmt + " Preserve numbers exactly; never round or drop them. No preamble, one line.")
        usr = f"USER ASKED: {user_message[:400]}\n\nTEAM DELIVERABLE:\n{final_text[:1500]}{pos}"
        out = await _evo_groq([{"role": "system", "content": sysp}, {"role": "user", "content": usr}],
                              model=(model or _JOURNAL_MODEL), schema=None)
        line = (out or "").strip().split("\n")[0].strip()
        return line[:420] or None
    except Exception as exc:  # noqa: BLE001
        log.warning("[hyper-engine] journal entry failed (non-fatal): %s", exc)
        return None


def _evo_keywords(s: str) -> set:
    return set(_EVO_WORD.findall((s or "").lower()))


def _evo_recall(playbook: List[str], topic: str, k: int = _EVO_RECALL_K) -> List[str]:
    """Lexical top-k playbook lessons for this topic + a recency floor (newest 2 always).
    Mirror of the proven spike recall_playbook. Pure + safe — returns [] on empty."""
    if not playbook:
        return []
    tk = _evo_keywords(topic)
    scored = sorted(((len(tk & _evo_keywords(les)), -i, les) for i, les in enumerate(playbook)), reverse=True)
    picked = [les for _, _, les in scored[:k]]
    for les in playbook[-2:]:
        if les not in picked:
            picked.append(les)
    return picked[:k + 2]


def _evo_merge(playbook: List[str], new_lessons: List[str], cap: int = _EVO_CAP) -> List[str]:
    """Append only non-duplicate lessons (Jaccard > 0.6 on keywords = dup → skip), bounded
    by cap (drop oldest). Mirror of the proven spike dedupe_into. Returns the new list."""
    out = list(playbook)
    for les in new_lessons:
        les = (les or "").strip()
        if not les:
            continue
        lk = _evo_keywords(les)
        if any(len(lk & _evo_keywords(ex)) / max(1, len(lk | _evo_keywords(ex))) > 0.6 for ex in out):
            continue
        out.append(les)
    return out[-cap:]


async def run_mention_reply(messages: List[Dict[str, Any]], *, model: Optional[str] = None,
                            temp: float = 0.4) -> tuple:
    """One plain chat call for the @mention fast-path (a single employee answering a
    direct tag in the room — no director, no debate, no tools). Honors the same
    OpenRouter-primary routing as the Director; returns (content, total_tokens) so the
    seal reports honest spend. ("", 0) on total failure — the caller seals gracefully."""
    m = model or os.environ.get("HYPER_DIRECTOR_MODEL", "openai/gpt-oss-120b")
    body: Dict[str, Any] = {"model": m, "messages": messages, "temperature": temp}
    j = None
    if not _route_direct_openrouter(m):
        key = _groq_key()
        if key:
            for attempt in range(2):
                try:
                    async with httpx.AsyncClient(timeout=httpx.Timeout(45.0, connect=5.0)) as c:
                        r = await c.post(GROQ_URL, headers={"Authorization": f"Bearer {key}"}, json=body)
                    if r.status_code == 200:
                        j = r.json()
                        break
                    if r.status_code in (429, 500, 502, 503) and attempt < 1:
                        await asyncio.sleep(2)
                        continue
                    break
                except Exception:  # noqa: BLE001
                    await asyncio.sleep(2)
    if j is None:
        j = await _openrouter_chat(body, timeout=httpx.Timeout(60.0, connect=5.0))
    if j is None:
        return "", {"total": 0, "in": 0, "out": 0, "cached": 0}
    content = str((j.get("choices") or [{}])[0].get("message", {}).get("content") or "").strip()
    _u = j.get("usage") or {}
    return content, {
        "total": int(_u.get("total_tokens", 0) or 0),
        "in": int(_u.get("prompt_tokens", 0) or 0),
        "out": int(_u.get("completion_tokens", 0) or 0),
        "cached": int(((_u.get("prompt_tokens_details") or {}).get("cached_tokens", 0)) or 0),
    }


async def _evo_groq(messages: List[Dict[str, Any]], *, model: str, schema: Optional[Dict[str, Any]],
                    temp: float = 0.3) -> Optional[str]:
    """Minimal standalone Groq call for api-layer helpers (post-verify reflection + journal entry),
    decoupled from the Director instance. With a schema → strict json_schema output; schema=None →
    plain text. Short backoff on 429/5xx. Returns content or None."""
    key = _groq_key()
    if not key:
        return None
    body: Dict[str, Any] = {"model": model, "messages": messages, "temperature": temp}
    if schema is not None:
        body["response_format"] = {"type": "json_schema",
                                   "json_schema": {"name": "evo_out", "schema": schema, "strict": True}}
    for attempt in range(3):
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=5.0)) as c:
                r = await c.post(GROQ_URL, headers={"Authorization": f"Bearer {key}"}, json=body)
            if r.status_code == 200:
                return (r.json()["choices"][0]["message"].get("content") or "").strip()
            if r.status_code in (429, 500, 502, 503) and attempt < 2:
                await asyncio.sleep(min(2 ** attempt, 6))
                continue
            break  # non-retryable Groq status → fall through to OpenRouter
        except Exception:  # noqa: BLE001
            await asyncio.sleep(min(2 ** attempt, 6))
    # Groq exhausted/unavailable → OpenRouter failover (Groq stays primary above).
    j = await _openrouter_chat(body, timeout=httpx.Timeout(30.0, connect=5.0))
    if j is not None:
        return (j["choices"][0]["message"].get("content") or "").strip()
    return None


def _evo_outcome_brief(outcome: Optional[Dict[str, Any]]) -> str:
    """Render the turn's REAL outcome (verifier verdict + status + whether a write was held for
    approval) into a short prompt block — the richer signal the coach scores against. Empty when
    no outcome is available (falls back to deliverable-only scoring)."""
    if not isinstance(outcome, dict) or not outcome:
        return ""
    v = outcome.get("verdict") if isinstance(outcome.get("verdict"), dict) else {}
    parts = []
    if v:
        flags = ", ".join(f"{k}={v.get(k)}" for k in ("met", "grounded_ok", "artifact_ok") if k in v)
        if flags:
            parts.append(flags)
        gaps = v.get("gaps") or []
        if isinstance(gaps, list) and gaps:
            parts.append("open gaps: " + "; ".join(str(g)[:120] for g in gaps[:3]))
    if outcome.get("status"):
        parts.append(f"turn status: {outcome.get('status')}")
    if outcome.get("pending_writes"):
        parts.append("a side-effectful action was proposed and HELD for human approval")
    if outcome.get("user_signal"):
        parts.append(f"user signal on a recent turn: {outcome.get('user_signal')}")
    if not parts:
        return ""
    return ("\n\nHOW THE TEAM'S DELIVERABLE ACTUALLY SCORED (the real outcome — weight your "
            "critique by this, reward what led to a met+grounded result, correct what led to gaps/"
            "escalation):\n- " + "\n- ".join(parts))


# Batched reflection output: lessons per employee from ONE coach call (not N). Cuts the per-turn
# evo cost ~Nx. Strict-schema friendly (array of flat objects).
_EVO_BATCH_SCHEMA = {
    "type": "object",
    "properties": {
        "employees": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "slug": {"type": "string"},
                    "lessons": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["slug", "lessons"],
                "additionalProperties": False,
            },
        },
        "room_lessons": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["employees", "room_lessons"],
    "additionalProperties": False,
}

# Skip reflection entirely on a STRONG turn (verdict met + grounded, completed, no rerun/HITL
# signal) — there's nothing to learn, so spend 0 tokens. Env-tunable: set HYPER_EVOLVE_REFLECT_ALWAYS
# to reflect on every turn regardless (costs more). Default: skip strong turns.
_EVO_REFLECT_ALWAYS = (os.environ.get("HYPER_EVOLVE_REFLECT_ALWAYS", "").strip().lower() in ("1", "true", "yes", "on"))


def _evo_skip_strong(outcome: Optional[Dict[str, Any]]) -> bool:
    """True when the turn clearly succeeded → no lesson to learn → skip the coach call(s)."""
    if _EVO_REFLECT_ALWAYS or not isinstance(outcome, dict):
        return False
    if outcome.get("user_signal"):
        return False  # an explicit user/HITL signal always warrants reflection
    if str(outcome.get("status") or "").lower() not in ("", "complete"):
        return False  # escalated/blocked → learn from it
    v = outcome.get("verdict") if isinstance(outcome.get("verdict"), dict) else {}
    gaps = v.get("gaps") or []
    return bool(v.get("met")) and bool(v.get("grounded_ok")) and not gaps


async def evo_reflect_and_merge(
    *, evo_playbooks: Dict[str, List[str]], transcript: List[Dict[str, Any]],
    participants: List[Dict[str, Any]], final_text: str,
    outcome: Optional[Dict[str, Any]] = None, reflect_model: Optional[str] = None,
    skills_used: Optional[List[str]] = None, room_kind: str = "",
    room_playbook: Optional[List[str]] = None,
) -> tuple:
    """Loop 1 reflection, run by the api layer AFTER verification so it sees the real outcome.
    Reflects each debating employee's contribution (conditioned on the verifier verdict) into its
    slug-scoped playbook. Returns (employee_playbooks_or_None, room_lessons_or_None):
    the FULL merged per-employee map (only when changed) + method-level ROOM lessons (which
    skill sequences worked/failed for this room kind). ONE batched coach call (not N) + skips
    strong turns → bounded token cost. Fully wrapped — any failure returns (None, None)."""
    if not transcript or not participants:
        return (None, None)
    # COST GUARD: a clearly-good turn has nothing to teach → spend nothing.
    if _evo_skip_strong(outcome):
        log.info("[hyper-engine] evo: strong turn (met+grounded) — reflection skipped (0 tokens)")
        return (None, None)
    try:
        model = reflect_model or _EVO_REFLECT_MODEL
        playbooks = {str(k): [str(x) for x in v] for k, v in (evo_playbooks or {}).items() if isinstance(v, list)}

        def _contrib(nm: str) -> str:
            return "\n".join(str(x.get("text") or "") for x in transcript
                             if isinstance(x, dict) and x.get("agent") == nm).strip()

        targets = []  # (slug, name, lane, contribution)
        for emp in participants[:5]:
            name, lane, _ = _persona_fields(emp)
            slug = str(emp.get("slug") or emp.get("id"))
            c = _contrib(name)
            if c:
                targets.append((slug, name, lane, c))
        if not targets:
            return (None, None)

        # ONE batched coach call scores+coaches ALL contributing employees at once.
        roster = "\n\n".join(
            f"[{i+1}] slug={slug} ({name}, {lane})\nCONTRIBUTION:\n{c[:1100]}"
            for i, (slug, name, lane, c) in enumerate(targets))
        sysp = (
            "You are a performance coach for a team of employees. For EACH employee below, judge their "
            "contribution this turn against the team's final deliverable and how it actually scored, on these "
            "dims: grounded (only given context, flagged unverifiable), specific (concrete + named next step), "
            "risk_aware (surfaced the key risk), on_goal (addressed the question), concise (no filler). For each "
            "employee return 0-2 SHORT, GENERAL, reusable operating rules (imperative, <=18 words) that would "
            "make THEM better on FUTURE, DIFFERENT questions — transferable principles, never specific to this "
            "turn's facts. Return an EMPTY lessons list for any employee already strong on every dim. Echo each "
            "employee's exact slug. ALSO return room_lessons: 0-2 METHOD-level rules for this ROOM TYPE "
            "(which investigation methods/skill sequences helped or were missing, <=18 words each, "
            "transferable, [] if nothing method-shaped to learn). Output ONLY the schema.")
        _skl = (f"\nMETHOD SKILLS APPLIED THIS TURN ({room_kind or 'general'} room): "
                f"{', '.join(skills_used)}" if skills_used else "")
        usr = (f"TEAM EMPLOYEES + CONTRIBUTIONS:\n{roster}\n\nTHE TEAM'S FINAL DELIVERABLE:\n"
               f"{final_text[:1500]}" + _evo_outcome_brief(outcome) + _skl)
        content = await _evo_groq(
            [{"role": "system", "content": sysp}, {"role": "user", "content": usr}],
            model=model, schema=_EVO_BATCH_SCHEMA)
        data = json.loads(content or "{}")
        valid_slugs = {t[0] for t in targets}
        by_slug: Dict[str, List[str]] = {}
        for row in (data.get("employees") or []):
            if not isinstance(row, dict):
                continue
            slug = str(row.get("slug") or "")
            if slug not in valid_slugs:
                continue
            lessons = [str(x).strip() for x in (row.get("lessons") or []) if str(x).strip()][:2]
            if lessons:
                by_slug[slug] = lessons

        updates: Dict[str, List[str]] = {}
        learned = 0
        for slug, lessons in by_slug.items():
            merged = _evo_merge(playbooks.get(slug, []), lessons)
            if merged != playbooks.get(slug, []):
                updates[slug] = merged
                learned += len(lessons)
        # ROOM-level method lessons: merged against the room's existing playbook with the
        # same dedup/cap discipline as per-agent lessons. None when nothing new.
        room_merged = None
        rl = [str(x).strip() for x in (data.get("room_lessons") or []) if str(x).strip()][:2]
        if rl:
            prior = [str(x) for x in (room_playbook or [])]
            merged_room = _evo_merge(prior, rl)
            if merged_room != prior:
                room_merged = merged_room
        if not updates and room_merged is None:
            return (None, None)
        full = None
        if updates:
            full = dict(playbooks)
            full.update(updates)
            log.info("[hyper-engine] evo: %d employees updated, %d lessons learned", len(updates), learned)
        if room_merged is not None:
            log.info("[hyper-engine] evo: room playbook updated (%d lessons)", len(room_merged))
        return (full, room_merged)
    except Exception as exc:  # noqa: BLE001
        log.warning("[hyper-engine] evo reflection pass failed (non-fatal): %s", exc)
        return (None, None)


def _norm_connector(cid: str) -> str:
    return str(cid or "").strip().lower().replace("_", "-")


def _is_read_tool(name: str) -> bool:
    n = (name or "").lower()
    return any(h in n for h in _READ_TOOL_HINTS)


def _groq_key() -> str:
    s = get_settings()
    return (s.groq_api_key or os.environ.get("GROQ_API_KEY") or os.environ.get("LLM_API_KEY") or "")


def _tool(name: str, desc: str, props: Dict[str, Any], required: List[str]) -> Dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": desc,
            "parameters": {"type": "object", "properties": props, "required": required},
        },
    }


def _parse_json_loose(text: str) -> Any:
    """Best-effort JSON from a model message (handles ```json fences + surrounding prose).
    Used by the Population-Sim where 8b returns JSON without strict-schema enforcement."""
    if not text:
        return None
    t = text.strip()
    if t.startswith("```"):
        t = re.sub(r"^```(?:json)?\s*|\s*```$", "", t, flags=re.MULTILINE).strip()
    try:
        return json.loads(t)
    except Exception:  # noqa: BLE001
        m = re.search(r"(\{.*\}|\[.*\])", t, re.DOTALL)
        if m:
            try:
                return json.loads(m.group(1))
            except Exception:  # noqa: BLE001
                return None
    return None


def _flatten_for_text(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Convert tool-call STRUCTURE (assistant.tool_calls + role:tool) into plain text.
    A force_text synthesis fed the raw tool-call transcript primes gpt-oss's harmony
    decoder to keep emitting tool calls → repeated 400 'Tool choice is none, but model
    called a tool', which no prose instruction overrides. Flattening keeps the
    information (results as context) but removes the structure that triggers the tool
    channel, so the model writes the deliverable as prose."""
    out: List[Dict[str, Any]] = []
    for m in messages:
        role = m.get("role")
        if role == "tool":
            out.append({"role": "user",
                        "content": f"[tool result · {m.get('name') or 'tool'}] {str(m.get('content') or '')[:1600]}"})
        elif role == "assistant" and m.get("tool_calls"):
            names = ", ".join((tc.get("function") or {}).get("name", "?") for tc in (m.get("tool_calls") or []))
            txt = (m.get("content") or "").strip()
            out.append({"role": "assistant", "content": (txt + "\n" if txt else "") + f"[called: {names}]"})
        else:
            out.append(m)
    return out


# Connector tool-schema inspect is the SAME across tenants (it's the MCP server's tool
# list, not tenant data) and rarely changes — but a COLD inspect (a fresh mcp.notion.com
# connection from hm-core) can block ~20s at run() start, stalling the whole turn before
# any gathering. Cache the tool list per connector so only the first turn pays it;
# every later turn (within the TTL) skips the inspect entirely and starts instantly.
_INSPECT_CACHE: Dict[str, tuple] = {}
# Tool lists change ~never — 1h TTL so sporadic rooms (turns >15min apart) stay warm.
_INSPECT_TTL = float(os.environ.get("HYPER_CONNECTOR_INSPECT_TTL", "3600") or "3600")


async def _inspect_connector_tools(norm: str, *, user_id: str, org_id: str) -> List[Dict[str, Any]]:
    """Cached connector tool-list inspect. Returns the raw tools list. Caches only a
    non-empty success (an empty/failed inspect — e.g. a not-connected connector or a
    cold timeout — is retried next turn rather than cached as 'no tools')."""
    now = time.time()
    cached = _INSPECT_CACHE.get(norm)
    if cached and cached[0] > now:
        return cached[1]
    try:
        insp = await connector_inspect_emulated(norm, user_id=user_id, org_id=org_id)
    except Exception:  # noqa: BLE001
        insp = {}
    raw = (((insp or {}).get("inspection") or {}).get("tools")
           or (insp or {}).get("tools") or [])
    if isinstance(raw, list) and raw:
        _INSPECT_CACHE[norm] = (now + _INSPECT_TTL, raw)
    return raw if isinstance(raw, list) else []


def _persona_fields(emp: Dict[str, Any]) -> tuple[str, str, str]:
    name = emp.get("name") or emp.get("slug") or "Teammate"
    lane = emp.get("_lane") or emp.get("role_archetype") or "Communicator"
    apv = emp.get("active_prompt_version") or {}
    sysp = (apv.get("system_prompt") if isinstance(apv, dict) else None) or emp.get("persona") or ""
    return name, str(lane), str(sysp)[:1000]


class Director:
    """One director session for a single room turn. Stateful (blackboard +
    transcript) but instance-scoped — safe for concurrent multi-tenant turns."""

    def __init__(
        self,
        *,
        user_message: str,
        user_id: str,
        org_id: str,
        project_id: Optional[str],
        participants: List[Dict[str, Any]],
        room_template: str,
        room_goal: Optional[str],
        enabled_connectors: List[str],
        emit: Callable[[Dict[str, Any]], Awaitable[None]],
        director_model: Optional[str] = None,
        persona_model: Optional[str] = None,
        max_iters: int = 16,
        debate_max_rounds: int = 2,
        synth_model: Optional[str] = None,
        sim_mode: str = "off",
        sim_agents: int = 0,
        evo_mode: str = "off",
        evo_playbooks: Optional[Dict[str, List[str]]] = None,
        company_brief: str = "",
        intended_output: str = "answer",
        room_kind: str = "",
        room_playbook: Optional[List[str]] = None,
        room_instructions: str = "",
        sender_email: str = "",
        out_language: str = "",
    ) -> None:
        # Run-wide output language from the FE navbar toggle (locale code/name →
        # language NAME, '' for English). Drives a strict "write in X only" directive.
        self.out_lang = _resolve_language(out_language)
        self.user_message = user_message
        self.user_id = user_id
        self.org_id = org_id
        self.project_id = project_id
        self.participants = participants
        self.roster = {(p.get("slug") or p.get("id")): p for p in participants}
        self.room_template = room_template or "debate"
        self.room_goal = room_goal or ""
        # Standing org identity (name + what the company does/sells + customers/market),
        # recalled once before the turn. Injected into PLAN + SYNTH so the director grounds
        # queries + the deliverable in THIS company — not a generic industry. '' = no brief.
        self.company_brief = str(company_brief or "")
        # What the turn must DELIVER (answer/decision/email/doc/sheet/notion), derived from the user
        # message BEFORE the run so SYNTH writes the right FORMAT (a ready email, not a generic report).
        self.intended_output = str(intended_output or "answer").strip().lower()
        # Room METHOD skills: kind resolved from goal/message keywords unless the
        # caller passed one; catalog goes to the planner, bodies load on demand.
        self.room_kind = (str(room_kind or "").strip().lower()
                          or resolve_room_kind("", room_goal or "", user_message or ""))
        self.skills_used: List[str] = []
        # Room-type learned lessons ("previously effective: X→Y"), written by the
        # post-turn reflection, primed into the planner catalog block. [] = none yet.
        self.room_playbook: List[str] = [str(x) for x in (room_playbook or []) if str(x).strip()][:6]
        # Owner-set Swarm Instructions for this room — MANDATORY on every run.
        # Injected into the director plan, every persona turn, and the synthesis
        # so the room can never "forget" its standing orders.
        self.room_instructions = str(room_instructions or "").strip()[:4000]
        self._room_instr_block = (
            "\nROOM INSTRUCTIONS — set by the owner, MANDATORY, follow on EVERY run "
            "(they override defaults but never safety):\n" + self.room_instructions + "\n"
        ) if self.room_instructions else ""
        # The real connected Gmail — used as the email's From/signature so the
        # synth never invents a placeholder address.
        self.sender_email = str(sender_email or "").strip()
        self.connectors = [str(c).lower() for c in (enabled_connectors or [])]
        self.has_google = any(c in self.connectors for c in _GOOGLE_CONNECTORS)
        self.emit = emit
        self.director_model = director_model or os.environ.get("HYPER_DIRECTOR_MODEL", "openai/gpt-oss-120b")
        self.persona_model = persona_model or os.environ.get("HYPER_PERSONA_MODEL", "openai/gpt-oss-120b")
        # Dedicated model for the FINAL deliverable. The gather loop + debate can run
        # on a cheap model (orchestration), but the synthesis is the product — so a
        # strong model writes it. When equal to director_model, no extra call (the
        # loop's own final IS the deliverable). Multi-model "Auto" = cheap gather + strong synth.
        # P4: route ONLY the final-report synth call to a frontier writer via env
        # (HYPER_SYNTH_MODEL). A Cerebras-hosted id (zai-glm-4.7) → _cerebras_chat DIRECT;
        # a namespaced slug (deepseek/…, google/…) → _openrouter_chat direct. Default =
        # director model (gpt-oss-120b) so unset = no behavior change.
        self.synth_model = synth_model or os.environ.get("HYPER_SYNTH_MODEL") or self.director_model
        # Live public-web search uses Groq's built-in web search (only on the
        # `groq/compound*` systems — gpt-oss can't run it directly). compound-mini is
        # cheaper/faster and fine for in-room gathering; env-tunable.
        self.web_model = os.environ.get("HYPER_WEB_MODEL", "")  # UNUSED: web goes via _web_search → HIVEMIND (no groq)
        self.max_iters = max_iters
        self.debate_max_rounds = max(1, min(3, debate_max_rounds))
        # per-turn state (NOT module globals)
        self.blackboard: List[str] = []
        self.transcript: List[Dict[str, Any]] = []
        self.tokens = 0
        self.gather_count = 0
        self._round_seq = 0
        self._web_calls = 0
        self._web_budget = max(0, int(os.environ.get("HYPER_WEB_BUDGET", "3") or "3"))
        # Connector tools (toggled on the room) registered dynamically at run() start:
        # JSON schemas the director sees + a route map name -> (bridge, provider, tool).
        self._connector_tools: List[Dict[str, Any]] = []
        self._connector_routes: Dict[str, tuple] = {}
        # Token accounting by pipeline phase (for cost analysis). director = the
        # gpt-oss-120b agentic loop (gather decisions + reading tool results +
        # synthesis — grows as context accumulates); debate = persona sub-calls;
        # web = compound web-search sub-calls. director_iters = per-loop-call totals.
        self.tok_by: Dict[str, int] = {"director": 0, "debate": 0, "web": 0}
        self.director_iters: List[int] = []
        self._last_tok = 0
        # Population-Sim (additional, opt-in). Default off — the main flow is untouched.
        self.sim_mode = str(sim_mode or "off").strip().lower()
        # How many synthetic voices to simulate (FE slider 10-100; 0 → env default). Clamped.
        self.sim_agents = max(10, min(100, int(sim_agents or _SIM_PERSONAS)))
        self._sim_report: Optional[str] = None       # folded into the synthesis when present
        self._sim_payload: Optional[Dict[str, Any]] = None  # emitted to the FE as sim_report
        # Self-evolving employees (Loop 1, additional + opt-in). evo_playbooks = each participant's
        # GLOBAL learned playbook (lessons across ALL rooms, keyed by slug) injected before it speaks.
        # The WRITE (reflection) happens in the api layer post-verification. Dormant unless the
        # global env flag AND the room toggle are both on. Default off → turn untouched.
        self.evo_mode = str(evo_mode or "off").strip().lower()
        self.evo_active = _EVO_ENABLED and self.evo_mode in _EVO_ON
        self.evo_playbooks: Dict[str, List[str]] = {
            str(k): [str(x) for x in v] for k, v in (evo_playbooks or {}).items() if isinstance(v, list)
        }
        # Input/output split + Groq prompt-cache hits. cached = the slice of input
        # billed at 50% (auto on gpt-oss; the re-sent director-loop prefix caches).
        self.io: Dict[str, int] = {"input": 0, "output": 0, "cached": 0}
        # Email addresses the director encountered in connector (Gmail) reads — used to
        # resolve the recipient for a "send to <name>" task when the org/recall lookup
        # is empty (the director already searched to:<addr>, so it knows it).
        self.gathered_emails: set = set()

    # ── LLM ───────────────────────────────────────────────────────────
    async def _groq(
        self, messages: List[Dict[str, Any]], *, tools: Optional[List[Dict[str, Any]]] = None,
        model: Optional[str] = None, temp: float = 0.4, force_text: bool = False,
        bucket: str = "director", schema: Optional[Dict[str, Any]] = None,
    ) -> Optional[Dict[str, Any]]:
        """One Groq chat call. Retries a 400 (malformed tool-call generation) once
        at a lower temperature per Groq's guidance. Returns the message dict or
        None on a hard failure (the caller treats None as 'stop')."""
        key = _groq_key()
        if not key:
            log.error("[hyper-engine] no Groq API key configured")
            return None
        # force_text: OMIT tools AND flatten the tool-call transcript to plain text.
        # gpt-oss's harmony decoder, primed by assistant.tool_calls/role:tool messages,
        # keeps emitting tool calls on a no-tools call → repeated 400 "Tool choice is
        # none, but model called a tool"; removing the structure (not just the tools) is
        # what actually stops it.
        msgs = _flatten_for_text(messages) if force_text else messages
        body: Dict[str, Any] = {"model": model or self.director_model, "messages": msgs, "temperature": temp}
        if tools and not force_text:
            body["tools"] = tools
            body["tool_choice"] = "auto"
        elif schema is not None:
            # Structured output (the gather PLAN): a JSON-schema response, NOT native
            # tool-calling — sidesteps the gpt-oss harmony tool-call glitch entirely.
            body["response_format"] = {"type": "json_schema",
                                       "json_schema": {"name": "gather_plan", "schema": schema, "strict": True}}
        # Provider-aware routing: a non-Groq-native model (gemini/claude/deepseek…)
        # goes DIRECT to OpenRouter (provider-pinned) — skip the Groq round-trip.
        # gpt-oss/llama stay Groq-primary below + the OpenRouter failover. Non-
        # regressing: the default gpt-oss director path is unchanged.
        # Debate consults are short persona takes (3-5 sentences): cap generation
        # so a slow provider can't stretch a round (each round = slowest member),
        # and cut the call at 25s — a timed-out voice degrades to "(no reply)"
        # instead of holding the whole debate hostage (measured 26-36s stragglers).
        if bucket == "debate" and "max_tokens" not in body:
            body["max_tokens"] = int(os.getenv("HYPER_DEBATE_MAX_TOKENS", "700") or 700)
        # The final report (synth) must never truncate mid-table: give it a large
        # generation budget + a long deadline. Without an explicit cap the provider
        # default clipped long markdown tables; the 60s deadline also cut long runs.
        if bucket == "synth" and "max_tokens" not in body:
            body["max_tokens"] = int(os.getenv("HYPER_SYNTH_MAX_TOKENS", "4096") or 4096)
        if bucket == "debate":
            _to = 40.0
        elif bucket == "synth":
            _to = float(os.getenv("HYPER_SYNTH_TIMEOUT_S", "90") or 90)
        else:
            _to = 60.0
        # Cerebras-direct FIRST (bypasses OpenRouter): the GLM synth writer bills to
        # Cerebras + hits its automatic prompt cache. A stable per-room+bucket cache_key
        # routes a room's repeat turns to the same cache backend (sent only when the
        # account has prompt_cache_key enabled — see _cerebras_chat).
        if _route_cerebras_direct(body.get("model")):
            _ck = f"hyper:{self.org_id or 'x'}:{getattr(self, 'project_id', None) or 'x'}:{bucket}"
            j = await _cerebras_chat(body, timeout=httpx.Timeout(_to, connect=5.0), cache_key=_ck)
            if j is not None:
                u = j.get("usage") or {}
                t = int(u.get("total_tokens", 0) or 0)
                self.tokens += t
                self.tok_by[bucket] = self.tok_by.get(bucket, 0) + t
                self._last_tok = t
                self.io["input"] += int(u.get("prompt_tokens", 0) or 0)
                self.io["output"] += int(u.get("completion_tokens", 0) or 0)
                self.io["cached"] += int(((u.get("prompt_tokens_details") or {}).get("cached_tokens", 0)) or 0)
                return (j.get("choices") or [{}])[0].get("message") or None
            # Cerebras-direct unavailable → emergency failover to the SAME model on
            # OpenRouter (still GLM, other host) so the room still produces a report.
            _or = _or_model(body.get("model"))
            if _or:
                log.warning("[hyper-engine] Cerebras-direct miss → OpenRouter failover %s", _or)
                body["model"] = _or
            else:
                return None
        if _route_direct_openrouter(body.get("model")):
            j = await _openrouter_chat(body, timeout=httpx.Timeout(_to, connect=5.0))
            if j is not None:
                u = j.get("usage") or {}
                t = int(u.get("total_tokens", 0) or 0)
                self.tokens += t
                self.tok_by[bucket] = self.tok_by.get(bucket, 0) + t
                self._last_tok = t
                self.io["input"] += int(u.get("prompt_tokens", 0) or 0)
                self.io["output"] += int(u.get("completion_tokens", 0) or 0)
                # Provider prompt-cache hits (OpenRouter passes prompt_tokens_details
                # through). Prod runs OpenRouter-PRIMARY, so without this the seal's
                # tokens_cached was always 0 — cache savings were invisible.
                self.io["cached"] += int(((u.get("prompt_tokens_details") or {}).get("cached_tokens", 0)) or 0)
                return (j.get("choices") or [{}])[0].get("message") or None
            return None
        max_attempts = 3
        _nudged = False
        for attempt in range(max_attempts):
            try:
                async with httpx.AsyncClient(timeout=httpx.Timeout(max(45.0, _to), connect=5.0)) as c:
                    r = await c.post(GROQ_URL, headers={"Authorization": f"Bearer {key}"}, json=body)
                if r.status_code == 400 and _BILLING_RE.search(r.text or ""):
                    # Groq billing block: mark dead (gpt-oss routes direct to OpenRouter
                    # from now) and break straight to the OpenRouter failover below — no
                    # point burning the 400-retries on a delinquent account.
                    global _GROQ_DEAD
                    _GROQ_DEAD = True
                    log.warning("[hyper-engine] Groq billing block → gpt-oss now routes direct to OpenRouter/Cerebras")
                    break
                if r.status_code == 400 and attempt < max_attempts - 1:
                    body["temperature"] = max(0.1, float(body.get("temperature", temp)) - 0.2)
                    # gpt-oss harmony glitch: on a force_text (no-tools) call the decoder
                    # can still emit a spurious tool-call token → 400 "Tool choice is none,
                    # but model called a tool" / "tool_use_failed". Lowering temp alone often
                    # doesn't stop it — inject a hard prose-only directive once so the model
                    # writes the deliverable instead of (mis)calling a tool. (Only for
                    # force_text: the gather loop WANTS tools, so it just retries cooler.)
                    _txt = (r.text or "").lower()
                    if (force_text and not _nudged and
                            ("tool_use_failed" in _txt or "tool choice is none" in _txt
                             or "was not in request.tools" in _txt)):
                        body["messages"] = list(body["messages"]) + [{
                            "role": "system",
                            "content": ("Respond with the final deliverable as PLAIN TEXT only. "
                                        "Do NOT call any tool or function and do NOT emit an "
                                        "analysis/commentary channel — write the answer directly."),
                        }]
                        _nudged = True
                    log.warning("[hyper-engine] groq 400, retrying lower temp%s: %s",
                                " + prose-only nudge" if _nudged else "", r.text[:200])
                    continue
                if r.status_code in (429, 500, 502, 503) and attempt < max_attempts - 1:
                    ra = (r.headers.get("retry-after") or "").strip()
                    delay = float(ra) if ra.replace(".", "", 1).isdigit() else float(min(2 ** attempt, 8))
                    log.warning("[hyper-engine] groq %s — backoff %.1fs (attempt %d)", r.status_code, delay, attempt)
                    await asyncio.sleep(min(delay, 10.0))
                    continue
                if r.status_code != 200:
                    log.warning("[hyper-engine] groq %s: %s", r.status_code, r.text[:200])
                    break  # non-retryable Groq status → fall through to OpenRouter
                j = r.json()
                u = j.get("usage") or {}
                t = int(u.get("total_tokens", 0) or 0)
                self.tokens += t
                self.tok_by[bucket] = self.tok_by.get(bucket, 0) + t
                self._last_tok = t
                self.io["input"] += int(u.get("prompt_tokens", 0) or 0)
                self.io["output"] += int(u.get("completion_tokens", 0) or 0)
                self.io["cached"] += int(((u.get("prompt_tokens_details") or {}).get("cached_tokens", 0)) or 0)
                return j["choices"][0]["message"]
            except (httpx.TimeoutException, httpx.TransportError) as exc:
                log.warning("[hyper-engine] groq transport error (attempt %d): %s", attempt, exc)
                if attempt < max_attempts - 1:
                    await asyncio.sleep(float(min(2 ** attempt, 8)))
                    continue
                break  # Groq unreachable → fall through to OpenRouter
            except Exception as exc:  # noqa: BLE001
                log.warning("[hyper-engine] groq call failed (attempt %d): %s", attempt, exc)
                break  # fall through to OpenRouter
        # Groq exhausted/unavailable → OpenRouter failover. Groq stays primary;
        # this runs only after Groq's own 400/429/5xx retries above are spent, so
        # the healthy path is unchanged. `body` carries the same tools/schema.
        j = await _openrouter_chat(body, timeout=httpx.Timeout(max(45.0, _to), connect=5.0))
        if j is not None:
            u = j.get("usage") or {}
            t = int(u.get("total_tokens", 0) or 0)
            self.tokens += t
            self.tok_by[bucket] = self.tok_by.get(bucket, 0) + t
            self._last_tok = t
            self.io["input"] += int(u.get("prompt_tokens", 0) or 0)
            self.io["output"] += int(u.get("completion_tokens", 0) or 0)
            self.io["cached"] += int(((u.get("prompt_tokens_details") or {}).get("cached_tokens", 0)) or 0)
            return j["choices"][0]["message"]
        return None

    async def _init_connector_tools(self) -> None:
        """Register the room's toggled connectors as READ-only director tools (the
        local-tool-calling pattern: schema → bridge exec → loop). Google connectors
        use a curated read surface; other Nango/MCP connectors are discovered via the
        bridge inspect (best-effort, only tools with a real input schema). Capped +
        read-only — writes stay with the centralized producer + HITL. Never raises."""
        registered: List[Dict[str, Any]] = []
        routes: Dict[str, tuple] = {}
        seen: set = set()

        def _add(tname: str, tdesc: str, props: Dict[str, Any], req: List[str], bridge: str, provider: str, real_tool: str) -> None:
            if tname in seen or len(registered) >= _CONNECTOR_TOOL_CAP:
                return
            seen.add(tname)
            registered.append(_tool(tname, tdesc, props, req))
            routes[tname] = (bridge, provider, real_tool)

        # Prefetch every non-Google inspect CONCURRENTLY. Each cold MCP inspect is ~20s
        # and they ran SEQUENTIALLY — N cold connectors = N×20s of dead air before the
        # first gather (measured 25-66s on a slack+notion room). Wall-time is now the
        # slowest single inspect, and the warm path (TTL cache) is unchanged.
        _need = [n for n in dict.fromkeys(_norm_connector(c) for c in self.connectors)
                 if n not in _GOOGLE_READ_TOOLS]
        _pre: Dict[str, list] = {}
        if _need:
            _res = await asyncio.gather(
                *[_inspect_connector_tools(n, user_id=self.user_id, org_id=self.org_id) for n in _need],
                return_exceptions=True)
            _pre = {n: (r if isinstance(r, list) else []) for n, r in zip(_need, _res)}

        for cid in self.connectors:
            if len(registered) >= _CONNECTOR_TOOL_CAP:
                break
            norm = _norm_connector(cid)
            google = _GOOGLE_READ_TOOLS.get(norm)
            if google:
                for (n, d, p, rq) in google:
                    _add(n, d, p, rq, "google", norm, n)
                continue
            raw = _pre.get(norm) or []
            count = 0
            for tspec in (raw if isinstance(raw, list) else []):
                if count >= _MCP_TOOLS_PER_CONNECTOR or len(registered) >= _CONNECTOR_TOOL_CAP:
                    break
                tname = str((tspec or {}).get("name") or "")
                if not tname or not _is_read_tool(tname):
                    continue
                schema = (tspec or {}).get("inputSchema") or (tspec or {}).get("input_schema") or {}
                if not isinstance(schema, dict) or not isinstance(schema.get("properties"), dict):
                    continue  # need a real schema to call the tool safely
                props = schema.get("properties") or {}
                req = schema.get("required") if isinstance(schema.get("required"), list) else []
                public = f"{norm.replace('-', '_')}__{tname}"
                desc = (str((tspec or {}).get("description") or tname)[:180]
                        + f" (live read from the {norm} connector).")
                _add(public, desc, props, req, "mcp", norm, tname)
                count += 1
        self._connector_tools = registered
        self._connector_routes = routes
        if registered:
            log.info("[hyper-engine] connector tools registered: %s",
                     [t["function"]["name"] for t in registered])

    async def _connector_read(self, name: str, args: Dict[str, Any]) -> str:
        bridge, provider, tool = self._connector_routes[name]
        try:
            if bridge == "google":
                r = await google_exec_emulated(tool, args or {}, user_id=self.user_id, org_id=self.org_id)
            else:
                r = await connector_exec_emulated(provider, tool, args or {}, user_id=self.user_id, org_id=self.org_id)
        except Exception as exc:  # noqa: BLE001
            return json.dumps({"error": str(exc)[:200], "is_error": True})
        res = r.get("result") if isinstance(r, dict) and isinstance(r.get("result"), dict) else (r or {})
        out = json.dumps(res)[:1500] if isinstance(res, (dict, list)) else str(res)[:1500]
        # Connector AUTH failure (expired/revoked token → 401/403). Surface a clean
        # "reconnect" signal instead of feeding the raw error to the agents as if it were
        # data — otherwise the room debates "API error logs" pointlessly. Tell the director
        # the connector is unavailable + emit a warning the FE renders as "reconnect X".
        _low = out.lower()
        _status = res.get("status") if isinstance(res, dict) else None
        if _status in (401, 403) or any(k in _low for k in (
                "unauthorized", "api token is invalid", "invalid_grant", "insufficient",
                "\"status\":401", "\"status\":403", "not authorized",
                "missing access token", "missing refresh token", "reconnect required",
                "reconnect it", "reauthorize", "re-authorize", "re-authenticate",
                "token expired", "token has expired")):
            await self.emit({"t": "warning", "code": "connector_reauth", "connector": provider,
                             "message": f"{provider} is not authorized — reconnect it in Connectors to use it here."})
            self.blackboard.append(
                f"- {provider}: NOT AUTHORIZED — its connection token is invalid/expired. The user "
                f"must RECONNECT {provider}. Do NOT treat this error as data or debate it; just note "
                f"{provider} is unavailable this turn.")
            self.gather_count += 1
            return json.dumps({"error": f"{provider} not authorized — reconnect required", "reconnect": provider})
        self.blackboard.append(f"- {provider}/{tool}: {out[:300]}")
        self.gather_count += 1
        # Harvest email addresses from gmail reads (result + the search args) so a
        # "send to <name>" task can resolve a real recipient the director already found.
        if "gmail" in provider:
            for blob in (out, json.dumps(args or {})):
                for addr in _EMAIL_RE.findall(blob or ""):
                    low = addr.lower()
                    if "noreply" not in low and "no-reply" not in low:
                        self.gathered_emails.add(low)
        q = ""
        for k in ("query", "id", "documentId", "spreadsheetId", "threadId"):
            if (args or {}).get(k):
                q = str(args[k]); break
        await self.emit({"t": "gather", "sources": [provider], "tool": tool, "query": q[:160],
                         "connector_hits": [tool], "memory_hits": 0})
        return out

    async def _emit_tool_start(self, fn: str, args: Dict[str, Any]) -> None:
        """Emit a 'what the room is doing right now' indicator the INSTANT a tool
        fires — BEFORE the (often 2–12s) network call — so the FE shows live activity
        instead of an idle gap while gather runs. Skips tools that emit their own
        progress (debate → round_start) or are instant (load_skill)."""
        if fn in ("debate", "load_skill"):
            return
        note = {
            "recall": "Recalling the company brain…",
            "org_directory": "Reading the org directory…",
            "web_search": "Searching the web…",
            "fetch_detail": "Fetching detail…",
        }.get(fn)
        if not note and fn in self._connector_routes:
            _, provider, _tool = self._connector_routes[fn]
            q = ""
            for k in ("query", "id", "documentId", "spreadsheetId", "threadId"):
                if (args or {}).get(k):
                    q = str(args[k])[:60]; break
            note = f"Reading {provider}" + (f" · “{q}”" if q else "…")
        if not note:
            return
        agent = self.participants[0].get("slug") if self.participants else "director"
        await self.emit({"t": "typing", "agent": agent, "note": note})

    async def _exec(self, name: str, args: Dict[str, Any]) -> str:
        try:
            if name == "recall":
                r = await recall_emulated(
                    str(args.get("query", "")), user_id=self.user_id, org_id=self.org_id,
                    project_id=self.project_id, max_memories=int(args.get("max", 6) or 6))
                mems = (r or {}).get("memories") or (r or {}).get("results") or (r or {}).get("context") or []
                facts = [
                    f"- {m.get('title') or m.get('name') or ''}: {str(m.get('content') or m.get('summary') or m.get('text') or '')[:200]}".strip(" -:")
                    for m in (mems if isinstance(mems, list) else [])[:6] if isinstance(m, dict)
                ]
                facts = [f for f in facts if f]
                self.blackboard.extend(facts)
                self.gather_count += 1
                await self.emit({"t": "gather", "sources": ["hivemind"], "memory_hits": len(facts),
                                 "connector_hits": [], "contacts": 0, "correspondence": 0})
                return json.dumps({"found": len(facts), "facts": facts})

            if name == "org_directory":
                r = await org_members_emulated(str(args.get("query", "")), user_id=self.user_id, org_id=self.org_id)
                members = (r or {}).get("members") or []
                trimmed = [{"name": m.get("name"), "email": m.get("email"), "role": m.get("role")}
                           for m in members[:25] if isinstance(m, dict)]
                if trimmed:
                    self.blackboard.append(f"- ORG MEMBERS: {json.dumps(trimmed)[:400]}")
                return json.dumps({"org_name": (r or {}).get("org_name"), "members": trimmed})

            if name in self._connector_routes:
                return await self._connector_read(name, args or {})

            if name == "web_search":
                return await self._web_search(str(args.get("query", "")))

            if name == "places_search":
                return await self._places_search(str(args.get("query", "")))

            if name == "debate":
                return await self._debate(str(args.get("topic", "")), int(args.get("rounds", self.debate_max_rounds) or self.debate_max_rounds))

            if name == "load_skill":
                return _SKILLS.get(str(args.get("skill_name", "")),
                                   "unknown skill — choose one of: " + ", ".join(_SKILLS.keys()))

            return json.dumps({"error": f"unknown tool {name}"})
        except Exception as exc:  # noqa: BLE001 — surface as a tool error so the director adapts
            log.warning("[hyper-engine] tool %s failed: %s", name, exc)
            return json.dumps({"error": str(exc)[:200], "is_error": True})

    async def _browser_search_fallback(self, content: str, key: str) -> str:
        """gpt-oss browser_search retry — used when the deep compound web call returns empty content.
        Exa-powered interactive browse, reliably returns its result inline. '' on failure; never raises."""
        try:
            body = {"model": "openai/gpt-oss-20b", "messages": [{"role": "user", "content": content}],
                    "tools": [{"type": "browser_search"}], "tool_choice": "required",
                    "temperature": 1, "top_p": 1, "max_completion_tokens": 4096, "reasoning_effort": "low"}
            async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=5.0)) as c:
                r = await c.post(GROQ_URL, headers={"Authorization": f"Bearer {key}"}, json=body)
            if r.status_code != 200:
                return ""
            j = r.json()
            wt = int((j.get("usage") or {}).get("total_tokens", 0) or 0)
            self.tokens += wt
            self.tok_by["web"] = self.tok_by.get("web", 0) + wt
            return str(j["choices"][0]["message"].get("content") or "")
        except Exception as exc:  # noqa: BLE001
            log.warning("[hyper-engine] browser_search fallback failed: %s", exc)
            return ""

    # ── Google Places (New) — local-business prospect discovery ──────────────
    async def _places_search(self, query: str) -> str:
        """Find REAL local businesses via Google Places API (New) Text Search: name,
        phone, website, address per result — dial-ready prospects for outreach rooms.
        Key from GOOGLE_MAPS_API_KEY (deployment env). Writes prospect rows to the
        blackboard + emits a `prospects` gather event so the FE can list them. Bounded
        by the web budget so a room can't burn the API."""
        # SANITIZE — Places Text Search wants "<business category> in <place>", not
        # prose. Real failures this guards: a full planner PARAGRAPH ("Find regulated
        # institutions in Germany (e.g., banks…) Return real firms with contact name…"
        # → 1 junk hit), method-skill names leaking in ("PROSPECT QUALIFICATION
        # Germany" → 0 hits), and mangled fragments ("Germany (source Germany").
        # Every API call costs money — reject junk instead of spending on it.
        query = re.sub(r"\((?:e\.g\.|eg |source|i\.e\.)[^)]*\)?", " ", (query or ""), flags=re.I)
        query = re.sub(r"[()\[\]{}\"“”]", " ", query)
        query = re.split(r"\b(?:with|that|which|who|return(?:ing)?|includ\w+|plus)\b|[.;:\n]",
                         query, maxsplit=1, flags=re.I)[0]
        query = re.sub(r"^\s*(?:find|search(?:\s+for)?|get|list|give\s+me|look\s+up|locate)\b", "",
                       query, flags=re.I)
        query = re.sub(r"\s+", " ", query).strip(" ,—–-")
        words = query.split()
        if len(words) > 8:
            query = " ".join(words[:8]).strip(" ,—–-")
            words = query.split()
        _method_junk = re.compile(
            r"^(prospect qualification|cold[- ]email|call[- ]opening|evidence[- ]first|"
            r"decision[- ]hygiene|polished[- ]email)\b", re.I)
        if len(words) < 2 or _method_junk.match(query) or not re.search(r"[a-zäöüß]", query):
            return json.dumps({"error": f"query too vague for Places ('{query[:60]}') — give a "
                               "'<business category> in <city/region>' query, e.g. 'law firms in Hannover'"})
        key = os.environ.get("GOOGLE_MAPS_API_KEY") or os.environ.get("HYPER_PLACES_KEY") or ""
        if not query:
            return json.dumps({"error": "empty query"})
        if not key:
            return json.dumps({"error": "places search unavailable — no GOOGLE_MAPS_API_KEY configured"})
        if self._web_calls >= self._web_budget:
            return json.dumps({"error": "discovery budget for this turn is used."})
        self._web_calls += 1
        try:
            body = {"textQuery": query, "maxResultCount": 20}
            headers = {"Content-Type": "application/json", "X-Goog-Api-Key": key,
                       "X-Goog-FieldMask": "places.displayName,places.internationalPhoneNumber,"
                                           "places.websiteUri,places.formattedAddress"}
            async with httpx.AsyncClient(timeout=httpx.Timeout(25.0, connect=5.0)) as c:
                r = await c.post("https://places.googleapis.com/v1/places:searchText",
                                 headers=headers, json=body)
            if r.status_code != 200:
                return json.dumps({"error": f"places {r.status_code}: {r.text[:160]}", "is_error": True})
            places = (r.json() or {}).get("places") or []
        except Exception as exc:  # noqa: BLE001
            log.warning("[hyper-engine] places_search failed: %s", exc)
            return json.dumps({"error": str(exc)[:200], "is_error": True})
        rows = []
        for pl in places[:20]:
            rows.append({
                "company": (pl.get("displayName") or {}).get("text", ""),
                "phone": pl.get("internationalPhoneNumber", ""),
                "website": pl.get("websiteUri", ""),
                "address": pl.get("formattedAddress", ""),
            })
        rows = [x for x in rows if x["company"]]
        # Impressum/contact enrichment — for firms with a website, fetch the
        # legally-mandated Impressum/Kontakt page and attach a real email (named
        # person preferred). Concurrent + bounded; a failure just leaves email "".
        await self._enrich_impressum(rows)
        # Onto the blackboard as sourced prospect facts (synth cites Google Places;
        # email cites the Impressum so the outreach send has a real recipient).
        for x in rows:
            self.blackboard.append(
                f"- PROSPECT: {x['company']} | contact {x.get('email') or '—'} | phone {x['phone'] or '—'} "
                f"| {x['website'] or '—'} | {x['address']} (source: Google Places"
                + ("; email: Impressum" if x.get('email') else "") + ")")
        self.gather_count += 1
        await self.emit({"t": "prospects", "query": query, "count": len(rows),
                         "with_email": sum(1 for x in rows if x.get('email')), "prospects": rows})
        # Persist CONTACTABLE discoveries to the company's shared LEAD BOOK (prospect memories)
        # with a note capturing WHY + WHEN they were found — so other rooms reuse them via
        # list_prospects instead of re-running this (expensive) search. Best-effort, bounded,
        # concurrent; memory claim-key dedups re-discovery. The memory's createdAt records WHEN.
        contactable = [x for x in rows if x.get("phone") or x.get("email")][:15]
        if contactable:
            _note = f"Discovered via prospect search “{query[:80]}” — dial/email-ready lead; consider for outreach."
            try:
                await asyncio.gather(*[
                    save_prospect_emulated(
                        company=x["company"], note=_note, phone=x.get("phone", "") or "",
                        email=x.get("email", "") or "", website=x.get("website", "") or "",
                        user_id=self.user_id, org_id=self.org_id, project_id=self.project_id,
                        source="places-discovery")
                    for x in contactable
                ], return_exceptions=True)
            except Exception as exc:  # noqa: BLE001
                log.info("[hyper-engine] lead-book persist skipped: %s", exc)
        log.info("[hyper-engine] places_search '%s' → %d firms, %d with email (%d saved to lead book)",
                 query[:60], len(rows), sum(1 for x in rows if x.get('email')), len(contactable))
        return json.dumps({"found": len(rows), "prospects": rows,
                           "note": "Contactable leads saved to the shared lead book — use list_prospects to reuse them."})

    # Role-address ranking: a named person beats a role inbox beats nothing.
    _IMPRESSUM_PATHS = ("/impressum", "/impressum/", "/de/impressum", "/kontakt", "/imprint", "/contact", "")
    _EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}")
    _EMAIL_BAD = re.compile(r"\.(png|jpe?g|gif|svg|webp)$|sentry|example|wixpress|@2x|godaddy|\.gov", re.I)

    async def _enrich_one_impressum(self, row: Dict[str, Any]) -> None:
        site = (row.get("website") or "").strip().rstrip("/")
        if not site:
            return
        for path in self._IMPRESSUM_PATHS:
            try:
                async with httpx.AsyncClient(timeout=httpx.Timeout(10.0, connect=5.0),
                                             follow_redirects=True, verify=False) as c:
                    r = await c.get(site + path, headers={"User-Agent": "Mozilla/5.0"})
                if r.status_code != 200:
                    continue
                cands = [e for e in self._EMAIL_RE.findall(r.text) if not self._EMAIL_BAD.search(e.lower())]
                if not cands:
                    continue
                # Prefer an email on the firm's own domain; then a named-looking one;
                # then a role inbox — never a third-party/CDN address.
                dom = site.split("//")[-1].split("/")[0].replace("www.", "")
                same = [e for e in cands if dom.split(".")[0] in e.lower()]
                pool = same or cands
                weak = re.compile(r"^(datenschutz|webmaster|privacy|noreply|no-reply|admin|postmaster|abuse)@", re.I)
                role = re.compile(r"^(info|kontakt|contact|office|mail|hello|hallo|kanzlei|team|zentrale)@", re.I)
                strong = [e for e in pool if not weak.match(e)]
                p2 = strong or pool
                named = [e for e in p2 if not role.match(e) and not weak.match(e)]
                row["email"] = (named or p2)[0]
                return
            except Exception:  # noqa: BLE001 — enrichment is best-effort
                continue

    async def _enrich_impressum(self, rows: List[Dict[str, Any]]) -> None:
        targets = [x for x in rows if x.get("website")][:12]
        if not targets:
            return
        sem = asyncio.Semaphore(6)
        async def _guard(x):
            async with sem:
                await self._enrich_one_impressum(x)
        await asyncio.gather(*[_guard(x) for x in targets], return_exceptions=True)

    # ── live web search (HIVEMIND core Tavily-backed) ────────────────────────
    async def _web_search(self, query: str) -> str:
        """Search the live public web using HIVEMIND core's Tavily-backed web-intel — the
        SAME engine behind the hivemind_web_search MCP tool. Provider-independent, survives
        a Groq outage, and inherits core's dedup / rate-limit / quota. Bounded per turn."""
        query = (query or "").strip()
        if not query:
            return json.dumps({"error": "empty query"})
        if self._web_calls >= self._web_budget:
            return json.dumps({"error": "web-search budget for this turn is used — rely on what you already gathered."})
        self._web_calls += 1
        prospect = bool(_PROSPECT_RE.search(query))
        keep = 3000 if prospect else 1500
        # Reuse HIVEMIND core's Tavily-backed web-intel (the SAME engine behind the
        # hivemind_web_search MCP tool) — provider-independent, survives a Groq outage,
        # and inherits core's dedup / rate-limit / quota. No bespoke Tavily client here.
        try:
            res = await web_search_emulated(query, user_id=self.user_id, org_id=self.org_id,
                                            limit=8 if prospect else 5,
                                            timeout_s=120.0 if prospect else 45.0)
        except Exception as exc:  # noqa: BLE001
            log.warning("[hyper-engine] web_search failed: %s", exc)
            return json.dumps({"error": str(exc)[:200], "is_error": True})
        if res.get("error"):
            log.warning("[hyper-engine] web_search: %s", res.get("error"))
            return json.dumps({"error": str(res.get("error"))[:200], "is_error": True})
        results = res.get("results") or []
        sources: List[Dict[str, str]] = [
            {"title": str(x.get("title") or "")[:120], "url": str(x.get("url") or "")}
            for x in results[:5] if x.get("url")
        ]
        parts: List[str] = []
        for x in results[:(8 if prospect else 5)]:
            snip = str(x.get("snippet") or x.get("content") or x.get("raw_content") or "")[:500]
            parts.append(f"- {str(x.get('title') or '')[:120]} | {x.get('url') or ''}\n  {snip}")
        answer = "\n".join(parts)[:keep]
        if prospect and answer:
            # Strict verbatim-or-NOT-VERIFIED contract for prospecting (no invented info@domain).
            answer = ("CONTACTS — quote an email/phone ONLY if it literally appears in a result snippet "
                      "below; cite the source URL; else write NOT VERIFIED. Never invent an address.\n") + answer
        if len(answer.strip()) < 20:
            await self.emit({"t": "web_intel", "query": query[:200], "count": 0, "sources": [], "summary": "no results"})
            return json.dumps({"answer": "No web results found.", "sources": []})
        # Tag web facts EXTERNAL + entity-unverified (a public search can return a DIFFERENT
        # same-named entity) — the synth critic reconciles this against the internal board.
        self.blackboard.append(
            f"- WEB[{query[:60]}] (EXTERNAL/public, entity UNVERIFIED — may describe a different "
            f"same-named entity; do NOT treat as a fact about THIS company unless it matches the "
            f"internal facts): {answer[:keep]}")
        self.gather_count += 1
        await self.emit({"t": "web_intel", "query": query[:200], "count": len(sources),
                         "sources": sources[:5], "summary": answer[:400]})
        return json.dumps({"answer": answer, "sources": sources[:5]})

    # ── debate (the room) ─────────────────────────────────────────────
    async def _consult(self, emp: Dict[str, Any], prompt: str, round_no: int) -> Dict[str, Any]:
        name, lane, sysp = _persona_fields(emp)
        is_skeptic = "skeptic" in lane.lower()
        bias = (" You are the SKEPTIC of this room — find the single weakest claim and challenge it hard "
                "with specifics." if is_skeptic else "")
        ctx = "\n".join(self.blackboard)[:4000]
        # Self-evolving (Loop 1): inject THIS employee's GLOBAL learned playbook (lessons across ALL
        # rooms) so it applies them in this decision. Lexical recall, slug-scoped, bounded. Dormant +
        # empty unless evo is active.
        evo_block = ""
        if self.evo_active:
            slug = emp.get("slug") or emp.get("id")
            topic = f"{self.room_goal} {self.user_message} {prompt}"
            lessons = _evo_recall(self.evo_playbooks.get(str(slug), []), topic)
            if lessons:
                evo_block = ("\nYOUR PLAYBOOK — operating lessons you have learned across ALL your past "
                             "work (every room, every task). Apply every one:\n"
                             + "\n".join(f"- {l}" for l in lessons))
        # Method discipline: when the room loaded METHOD skills, hold every voice to
        # them (bodies are on the board as SKILL[...] entries, already inside ctx).
        skill_line = (" Follow the SKILL[...] methods on the board — evidence per claim, "
                      "UNVERIFIED where ungrounded." if self.skills_used else "")
        # Reactor reach (flag-gated): in round 2+ a voice may request ONE tool fill —
        # first line 'NEED: web_search <query>' or 'NEED: skill <name>' — fulfilled
        # below with a single refill consult. Cheap tool access without a native loop.
        need_line = ""
        if _REACTOR_REACH and round_no >= 2:
            need_line = (" If ONE missing fact or method blocks your take, reply with ONLY a first line "
                         "'NEED: web_search <query>' or 'NEED: skill <name>' and nothing else; "
                         "otherwise answer normally.")
        _messages = [
            {"role": "system", "content": (
                _now_block() +
                f"You are {name}, a {lane} on this team.{bias} {sysp}{evo_block}{self._room_instr_block}"
                f"\nRespond IN CHARACTER, CONCISELY "
                f"(3-5 sentences), grounded ONLY in the CONTEXT. If you disagree, challenge with specifics; "
                f"mark anything unverifiable as UNVERIFIED; never invent facts.{skill_line}{need_line}")},
            {"role": "user", "content": f"CONTEXT (room's shared board):\n{ctx}\n\n[Debate round {round_no}] {prompt}"},
        ]
        _temp = min(0.7, 0.45 + 0.1 * round_no)
        msg = await self._groq(_messages, model=self.persona_model, temp=_temp, bucket="debate")
        text = (msg or {}).get("content") or ""
        if not text.strip():
            # A timed-out / empty voice used to degrade to "(no reply)" and pollute
            # the transcript + the FE. Retry once before giving up.
            msg = await self._groq(_messages, model=self.persona_model, temp=_temp, bucket="debate")
            text = (msg or {}).get("content") or ""
        # Fulfil a NEED request (at most one) and refill the consult with the result.
        m_need = re.match(r"^\s*NEED:\s*(web_search|skill)\s+(.+)$", text.strip()[:400], re.I) if (
            _REACTOR_REACH and round_no >= 2 and text.strip()) else None
        if m_need:
            kind_, arg = m_need.group(1).lower(), m_need.group(2).strip()
            filled = ""
            try:
                if kind_ == "skill":
                    body = load_method_skill(arg)
                    if body:
                        if arg not in self.skills_used:
                            self.skills_used.append(arg)
                            self.blackboard.append(f"SKILL[{arg}]:\n{body}")
                            await self.emit({"t": "skill_used", "skill": arg, "agent": emp.get("slug"),
                                             "room_kind": self.room_kind})
                        filled = f"SKILL[{arg}]:\n{body}"
                elif self._web_budget > self._web_calls:
                    filled = await self._web_search(arg[:200]) or ""
            except Exception as exc:  # noqa: BLE001 — a failed fill never kills the voice
                log.warning("[hyper-engine] reactor NEED fill failed: %s", exc)
            _messages[1]["content"] += (f"\n\nYOUR REQUEST WAS FULFILLED:\n{str(filled)[:1500]}\n"
                                        f"Now give your take (3-5 sentences).")
            msg = await self._groq(_messages, model=self.persona_model, temp=_temp, bucket="debate")
            text = (msg or {}).get("content") or ""
        empty = not text.strip()
        return {"slug": emp.get("slug") or emp.get("id"), "name": name, "lane": lane,
                "is_skeptic": is_skeptic, "text": text, "empty": empty}

    async def _debate(self, topic: str, rounds: int) -> str:
        rounds = max(1, min(self.debate_max_rounds, rounds))
        # Maker kinds (outreach/content/research) + any produce output run a
        # WRITER-LED shape: 1 maker + ≤1 reviewer, not a skeptic tribunal. Panel
        # kinds (strategy/decision) keep the full debate. Fixes the sales-sheet
        # failure where 3 skeptics argued instead of producing the deliverable.
        from .rooms import lead_shape_for, shape_debate_members
        _shape = lead_shape_for(self.room_kind, getattr(self, "intended_output", ""))
        members = shape_debate_members(self.participants, _shape)
        # Maker rooms keep the full round count — the debate must be SUBSTANTIVE
        # (prioritize firms, hooks, objections), just writer-led rather than a
        # skeptic tribunal. Roster shaping alone prevents the pile-on.
        if not members:
            return json.dumps({"error": "no participants to debate"})

        # Round 1 — independent stances (parallel sub-calls = genuine independence)
        self._round_seq += 1
        await self.emit({"t": "round_start", "round": self._round_seq, "max_rounds": rounds})
        # REALTIME: each persona's take streams to the FE the moment it returns —
        # not after the whole round gathers (which batched all reacts into one
        # instant and made the debate look pre-baked). Parallelism unchanged;
        # transcript is appended AFTER the round in stable member order (synth
        # input identical), only the emit moved inside the per-persona task.
        async def _consult_and_emit(m: Dict[str, Any], prompt: str, rn: int, agreement_pair: tuple) -> Dict[str, Any]:
            c = await self._consult(m, prompt, rn)
            # Drop empty voices entirely — no "(no reply)" bubble on the FE.
            if c.get("empty"):
                return c
            await self.emit({"t": "react", "round": rn, "agent": c["slug"],
                             "name": c["name"], "lane": c["lane"],
                             "agreement": agreement_pair[0] if c["is_skeptic"] else agreement_pair[1],
                             "content": c["text"], "line": c["text"], "confidence": 0.7})
            return c

        # Prospect-anchored round 1 for outreach/maker rooms: if the board carries
        # PROSPECT rows, agents debate the ACTUAL firms (who to prioritize, the
        # per-firm hook + likely objection, the sequence) — not generic theory.
        _prospect_lines = [l for l in self.blackboard if "PROSPECT:" in str(l)][:8]
        if _prospect_lines:
            _plist = "\n".join(_prospect_lines)
            r1_prompt = (f"The team found these PROSPECTS on the board:\n{_plist}\n\n"
                         f"Objective: {topic}\nDiscuss THESE specific firms — which to prioritize and why, "
                         f"the sharpest why-now hook for each, the objection each is likely to raise, and how "
                         f"the outreach should open. Be concrete about the named firms; no generic theory.")
        else:
            r1_prompt = f"What is your stance on: {topic}? Give your view + your single biggest concern."
        r1 = await asyncio.gather(*[
            _consult_and_emit(m, r1_prompt, self._round_seq, ("challenge", "contribute"))
            for m in members
        ])
        for c in r1:
            if c.get("empty"):
                continue
            self.transcript.append({"round": 1, "agent": c["name"], "text": c["text"]})

        # Round 2 — react/challenge each other on the shared board
        if rounds >= 2:
            self._round_seq += 1
            await self.emit({"t": "round_start", "round": self._round_seq, "max_rounds": rounds})
            # P7: each expert reacts to the VERBATIM round-1 messages of the OTHERS
            # (exclude self) so rebuttals target real PEER arguments by name — a true
            # round-table hub, not a self-echo or a director summary.
            def _peers_prior(self_slug: str) -> str:
                return "\n".join(f"{c['name']}: {c['text']}" for c in r1
                                 if not c.get("empty") and c.get("slug") != self_slug)[:3500]
            r2 = await asyncio.gather(*[
                _consult_and_emit(m, (f"Your teammates said:\n{_peers_prior(m.get('slug'))}\n\nREACT: name whose "
                                      f"point is weakest and why; challenge or build on THEIR argument — be specific. "
                                      f"Do you change your view on '{topic}'?"),
                                  self._round_seq, ("challenge", "support"))
                for m in members
            ])
            for c in r2:
                if c.get("empty"):
                    continue
                self.transcript.append({"round": 2, "agent": c["name"], "text": c["text"]})

        await self.emit({"t": "swarm_verdict", "round": self._round_seq, "converged": True})
        return json.dumps({
            "rounds": rounds,
            "transcript": [{"r": x["round"], "agent": x["agent"], "said": x["text"][:400]} for x in self.transcript],
        })

    # ── main loop ─────────────────────────────────────────────────────
    def _company_identity_block(self) -> str:
        """Hard identity pin — WHO WE ARE, derived from the onboarded room goal
        ('Company: X — mission…') and the company brief. Recalled memories can
        describe OTHER companies (client/project KB docs live in the same org
        brain); without this pin the synthesis has adopted a client's products
        as ours (a SOLVIS heat-pump report signed by a SINGULANCE room)."""
        m = re.search(r"Company:\s*([A-Z][A-Za-z0-9&.\- ]{1,40}?)(?:\s+[—–-]|\.|,|$)", self.room_goal or "")
        name = (m.group(1).strip() if m else "").strip()
        if not name:
            return ""
        return (
            f"\nCOMPANY IDENTITY — WE ARE {name}. Every plan, prospect list, email and report this room "
            f"produces is BY {name}, selling {name}'s products, in {name}'s industry. Recalled memories may "
            f"describe OTHER companies (client projects, ingested documents); those companies are NEVER us — "
            f"never adopt their products, industry, guarantees, subsidies, or claims as ours. Use another "
            f"company's facts ONLY when the task is explicitly about that company (e.g. as a prospect).\n")

    def _system_prompt(self) -> str:
        roster = ", ".join(f"{p.get('name') or p.get('slug')} ({p.get('_lane') or 'Communicator'})" for p in self.participants)
        goal = f"\nROOM GOAL: {self.room_goal}" if self.room_goal else ""
        goal += self._company_identity_block()
        tmpl = (f"\nThis is a '{self.room_template}' room — frame the discussion and the final output to "
                f"fit that mode (debate=argued conclusion; decision=DACI; brainstorm=options; "
                f"council=vote; lean_coffee=per-topic; retrospective=worked/didn't/change; standup=status).")
        return (
            _now_block() +
            "You are the facilitator of a HIVEMIND hyperagent room — sentinel agents that live inside the "
            "company brain and grow smarter over time. Your team: " + roster + "." + goal + tmpl + "\n"
            "FORMAT THE DELIVERABLE FOR QUALITY:\n"
            "• Lead with the answer / recommendation up front, then support it.\n"
            "• Structure with '## <Section>' headings; '- ' bullets for lists, '1. ' for ordered steps.\n"
            "• **Bold** every key term, name, figure, date, and decision.\n"
            "• For ANY comparative / numeric / cost / options / schedule data, USE A REAL MARKDOWN TABLE "
            "(a header row, a '|---|---|' rule line, then data rows).\n"
            "• VISUALS / INFOGRAPHICS — when a TIMELINE/ROADMAP, FLOW/PROCESS, ARCHITECTURE, SEQUENCE, or "
            "DISTRIBUTION would be clearer as a diagram, include ONE fenced mermaid block. Emit it EXACTLY "
            "as: a line with ```mermaid, then the diagram on ITS OWN lines (gantt | flowchart TD | "
            "sequenceDiagram | pie), then a line with ```. It MUST be valid mermaid with REAL newlines "
            "(never collapse to one line, never use single backticks): quote labels containing spaces/colons, "
            "use 'dateFormat YYYY-MM' for a gantt, 'flowchart TD' with 'A[\"Label\"] --> B[\"Label\"]' for a "
            "flow. Use a diagram ONLY where it genuinely adds clarity (at most one or two), never for prose.\n"
            "• If the deliverable is a document, begin with '# <specific Title>' (NOT the room goal); if an "
            "email, begin with 'Subject:'; if a question, give the direct grounded answer.\n"
            "• Ground EVERY specific in the gathered context; never invent facts, names, numbers, or links; "
            "flag anything you cannot verify as UNVERIFIED and collect open items under a short "
            "'## Gaps to confirm'.\n"
            "• When a debate happened, close with a one-line synthesis citing who argued what.\n"
            "• Publish-ready content only — no process narration, no placeholders, no fabricated URLs.\n"
            "ANALYTICAL DEPTH — this is a high-level executive report, not a list of facts:\n"
            "• Open with a 2-3 sentence '## Executive Summary' stating the single most important takeaway and the "
            "recommended action, in plain language a founder can act on immediately.\n"
            "• Name the ONE sharpest, non-obvious insight explicitly — call it out (e.g. '**Key insight:** …'). "
            "Prefer the second-order implication over the surface observation.\n"
            "• RANK findings and recommendations by impact (highest first), not by the order they were discussed.\n"
            "• Quantify wherever the gathered context allows (size, %, $, timeframe); when you can't, say so rather "
            "than padding with vague adjectives.\n"
            "• For every recommendation give: the lever (what to do), the owner/role, and one measurable signal that "
            "tells you it worked. No recommendation without a way to check it.\n"
            "• State confidence WITH the reason ('high — 3 independent sources' / 'low — single blog, UNVERIFIED').\n"
            "• Cut filler. Every sentence must carry a fact, a judgement, or an action — delete anything that only "
            "restates the goal or narrates process."
        )

    # ── plan → parallel-gather → synth (the fast path) ────────────────
    def _relevant_connector_names(self, all_names: List[str], topic: str) -> List[str]:
        """connection_search: rank registered connector tools by lexical relevance to the
        task and keep the top-K, ALWAYS keeping one entry-point (search/list/fetch/query)
        tool per connector so no connector becomes unreachable. Deterministic — no extra
        LLM call. Flag OFF (or a small list) → returns all_names unchanged."""
        if not _CONNECTION_SEARCH or len(all_names) <= _CONN_SEARCH_KEEP:
            return all_names
        toks = {w for w in re.split(r"\W+", (topic or "").lower()) if len(w) > 2}
        def _score(n: str) -> int:
            parts = {p for p in re.split(r"[_\-]+", n.lower()) if len(p) > 2}
            return len(parts & toks)
        by_conn: Dict[str, List[str]] = {}
        for n in all_names:
            c = n.split("__")[0] if "__" in n else n.split("_")[0]
            by_conn.setdefault(c, []).append(n)
        keep = set()
        for _c, names in by_conn.items():
            entry = next((n for n in names if any(k in n.lower() for k in ("search", "list", "fetch", "query"))), names[0])
            keep.add(entry)
        for n in sorted(all_names, key=_score, reverse=True):
            if len(keep) >= _CONN_SEARCH_KEEP:
                break
            keep.add(n)
        return [n for n in all_names if n in keep]

    async def _compose_places_queries(self) -> List[str]:
        """Compose the best Google Places queries for THIS turn — an LLM call with
        the task + board context, not a deterministic pattern. Returns [] when Maps
        adds nothing (already-rich board, no geography, no org angle)."""
        prospects = len([l for l in self.blackboard if "PROSPECT:" in str(l)])
        board_ctx = "\n".join(str(l)[:200] for l in self.blackboard[-14:])[:2200]
        schema = {"type": "object",
                  "properties": {"queries": {"type": "array", "items": {"type": "string"}, "maxItems": 3}},
                  "required": ["queries"], "additionalProperties": False}
        sysp = (
            _now_block() + self._company_identity_block() +
            "You compose Google Places TEXT SEARCH queries to source REAL prospect firms for the task. "
            "Places indexes local BUSINESSES; it returns name, phone, website, address.\n"
            "RULES:\n"
            "- Two query shapes ONLY: '<Organisation name> <city>' to look up a SPECIFIC organisation the "
            "context already names, or '<business category> in <city/region>' for discovery (3-6 words).\n"
            "- Use the task's REAL geography and industry — any country, any language local to that market "
            "(a German market query may be German, a French one French: local-language categories rank better).\n"
            "- Prefer named-org lookups for organisations the board already identified but lacks contacts for.\n"
            "- Government/regulatory bodies are poorly indexed — prefer the businesses that serve or are "
            "regulated in that sector.\n"
            "- NEVER: verbs, full sentences, 'with contact details', method names, or queries unrelated to "
            "the task. Fewer, sharper queries beat many — each costs money.\n"
            "- Return {\"queries\": []} when the board already has enough prospects or Maps cannot help."
        )
        user = (f"TASK: {(self.user_message or '')[:500]}\n"
                f"PROSPECTS ALREADY ON BOARD: {prospects}\n"
                f"BOARD (latest context):\n{board_ctx}")
        try:
            msg = await self._groq([{"role": "system", "content": sysp},
                                    {"role": "user", "content": user}],
                                   schema=schema, temp=0.2, bucket="plan")
            plan = json.loads((msg or {}).get("content") or "{}")
            out = [str(q).strip() for q in (plan.get("queries") or []) if str(q).strip()]
            return out[:3]
        except Exception as exc:  # noqa: BLE001
            log.warning("[hyper-engine] places query composer failed: %s", exc)
            return []

    async def _plan_gather(self) -> Dict[str, Any]:
        """ONE structured-output call that plans the gather: which company-brain recalls,
        which connector reads, whether web + debate are needed. JSON schema, NOT native
        tool-calling — reliable on gpt-oss + a single round-trip (replaces the old 15-call
        sequential agentic loop). connection_search (flag) trims the surfaced tool list."""
        conn_all = list(self._connector_routes.keys())
        conn = self._relevant_connector_names(conn_all, f"{self.user_message or ''} {self.room_goal or ''}")
        if _CONNECTION_SEARCH and len(conn) < len(conn_all):
            log.info("[hyper-engine] connection_search: surfaced %d/%d connector tools", len(conn), len(conn_all))
        conn_line = (f"Connector READ tools available (use these EXACT names): {conn}."
                     if conn else "No external connectors are connected.")
        web_line = ("Web search IS available (external/public facts only)." if self._web_budget > 0
                    else "Web search is NOT available.")
        schema = {
            "type": "object",
            "properties": {
                "recall_queries": {"type": "array", "items": {"type": "string"}},
                "connector_calls": {"type": "array", "items": {
                    "type": "object",
                    "properties": {"name": {"type": "string"}, "args_json": {"type": "string"}},
                    "required": ["name", "args_json"], "additionalProperties": False}},
                "web_query": {"type": ["string", "null"]},
                "places_query": {"type": ["string", "null"]},
                "needs_debate": {"type": "boolean"},
                "method_skills": {"type": "array", "items": {"type": "string"}},
                "turn_mode": {"type": "string", "enum": ["chat", "task"]},
            },
            "required": ["recall_queries", "connector_calls", "web_query", "places_query", "needs_debate", "method_skills", "turn_mode"],
            "additionalProperties": False,
        }
        sysp = (
            _now_block() +
            "You plan the GATHER step for a HIVEMIND room turn. " + conn_line + " " + web_line + " "
            "Output a JSON gather plan:\n"
            "- turn_mode: FIRST decide what the user's MESSAGE actually is. 'chat' = a greeting, smalltalk, "
            "thanks, a question about the team/room itself, or any conversational message with NO work "
            "deliverable ('hallo', 'who are you?', 'thanks!', 'what can you do?') — the room just REPLIES "
            "as people; every other field must then be empty/null/false. 'task' = real work is requested. "
            "The ROOM GOAL does NOT make a greeting a task — judge the MESSAGE, not the goal.\n"
            "- recall_queries: 1-3 SHORT focused company-brain searches, one per distinct entity/topic in the "
            "task (fewer, sharper beats many).\n"
            "- connector_calls: reads from the listed connector tools. Each item is {name, args_json} where "
            "args_json is a JSON STRING of the tool's arguments, e.g. {\"name\":\"notion__notion-search\","
            "\"args_json\":\"{\\\"query\\\":\\\"HIVEMIND Amar\\\"}\"}. ONLY listed names; [] if none help.\n"
            "- places_query: a Google-Maps business search, ONLY when THIS turn asks to FIND or SOURCE "
            "NEW real firms/prospects/contacts. FORMAT IS STRICT: '<business category> in <city/region>', "
            "3-6 words, nothing else — 'law firms in Hannover', 'private banks in Frankfurt', 'insurance "
            "companies in Amsterdam'. NO verbs, NO sentences, NO '(e.g. …)', NO 'with contact details' "
            "(Maps returns phone+website automatically; prose queries return junk and waste the API call). "
            "Return NULL when the turn drafts/writes emails or a sequence, reasons over already-identified "
            "targets, or is a strategy/analysis/decision task. REUSE-FIRST: the company keeps a shared "
            "LEAD BOOK — assume existing leads are already in recall context; set places_query ONLY for "
            "genuinely NEW prospects the lead book lacks, or when the user explicitly asks for new/more. "
            "Do NOT re-discover leads the company already has. When in doubt, null.\n"
            "- web_query: a single query ONLY for genuinely EXTERNAL/public facts the company brain would not "
            "hold; otherwise null.\n"
            "- needs_debate: true when the task needs a decision, judgment, trade-off, or genuine discussion — "
            "and PLANS, STRATEGIES, RECOMMENDATIONS, prioritisations, budget splits, and 'what should we do' "
            "deliverables ALWAYS qualify (they are judgment, not lookup). false ONLY for a pure factual "
            "lookup or a mechanical retrieval/formatting task.\n"
            "GROUND recall_queries AND web_query in the COMPANY CONTEXT when one is given — reference the company's "
            "own name, products, customers, and market (e.g. 'Acme competitors in <region>', 'prospects for "
            "<product> in <market>'), NEVER a generic industry query."
        )
        # Progressive-disclosure skill catalog: the planner pays only for names +
        # one-liners; a chosen skill's full method body loads during gather.
        if _METHOD_SKILLS_ENABLED:
            cat = skill_catalog(self.room_kind)
            if cat:
                lessons = ("\nPreviously effective in this room type: "
                           + " | ".join(self.room_playbook)) if self.room_playbook else ""
                sysp += (
                    "\n- method_skills: pick 1-2 METHOD SKILLS from this catalog that fit the task "
                    "(their full method loads for the room); [] if none fit:\n"
                    + "\n".join(f"  • {n} — {w}" for n, w in cat) + lessons
                )
        _org = (self.company_brief or "").strip()
        _org_block = (
            "COMPANY CONTEXT — the organisation you are planning for. Ground every query in its identity, "
            "products, customers, and market; do NOT emit generic industry queries:\n" + _org[:1200] + "\n\n"
        ) if _org else ""
        user = f"{_org_block}{self._room_instr_block}ROOM GOAL: {self.room_goal or '(none)'}\nTASK: {self.user_message}"
        msg = await self._groq([{"role": "system", "content": sysp}, {"role": "user", "content": user}],
                               model=self.director_model, temp=0.3, schema=schema, bucket="director")
        self.director_iters.append(self._last_tok)
        try:
            plan = json.loads((msg or {}).get("content") or "{}")
        except Exception:  # noqa: BLE001
            plan = {}
        if not isinstance(plan, dict):
            plan = {}
        rq = [q for q in (plan.get("recall_queries") or []) if isinstance(q, str) and q.strip()][:3]
        plan["recall_queries"] = rq or [(self.user_message or self.room_goal or "")[:200]]
        ccs: List[Dict[str, Any]] = []
        for c in (plan.get("connector_calls") or []):
            if not (isinstance(c, dict) and c.get("name") in self._connector_routes):
                continue
            try:
                a = json.loads(c.get("args_json") or "{}")
            except Exception:  # noqa: BLE001
                a = {}
            ccs.append({"name": c["name"], "args": a if isinstance(a, dict) else {}})
        plan["connector_calls"] = ccs[:4]
        wq = plan.get("web_query")
        plan["web_query"] = wq if (isinstance(wq, str) and wq.strip() and self._web_budget > 0) else None
        pq = plan.get("places_query")
        _places_on = bool(os.environ.get("GOOGLE_MAPS_API_KEY") or os.environ.get("HYPER_PLACES_KEY"))
        if (not (isinstance(pq, str) and pq.strip())) and _places_on and _wants_discovery(self.user_message):
            try:
                composed = await self._compose_places_queries()
                pq = composed[0] if composed else None
                if pq:
                    log.info("[hyper-engine] places query FORCED by explicit prospect/lead request: %s", str(pq)[:80])
            except Exception as exc:  # noqa: BLE001
                log.warning("[hyper-engine] places query backstop failed: %s", exc)
        # Deterministic backstop: even if the planner emits a query, only run Maps
        # when THIS turn genuinely asks to source new prospects (not a drafting/
        # strategy turn). Stops the "20 firms every run" noise the user flagged.
        plan["places_query"] = (pq if (isinstance(pq, str) and pq.strip() and _places_on
                                       and _wants_discovery(self.user_message)) else None)
        # Method skills: keep only real catalog names; auto-load the kind default
        # when the plan picked none (mirrors the polished-email auto-load).
        ms = [s for s in (plan.get("method_skills") or [])
              if isinstance(s, str) and load_method_skill(s)][:2]
        if _METHOD_SKILLS_ENABLED and not ms:
            ms = [default_skill_for(self.room_kind)]
        plan["method_skills"] = ms if _METHOD_SKILLS_ENABLED else []
        plan["needs_debate"] = bool(plan.get("needs_debate"))
        # Deterministic backstop — the model-judged gate misclassified judgment tasks as
        # lookups twice in live use ("marketing plan", "social media plan" → no debate,
        # the room's core feature silently skipped). A judgment-shaped task with a real
        # team ALWAYS convenes the room; the LLM gate now only decides the ambiguous rest.
        if not plan["needs_debate"] and len(self.participants) >= 2 and _JUDGMENT_RE.search(
                f"{self.user_message or ''} {self.room_goal or ''}"):
            plan["needs_debate"] = True
            log.info("[hyper-engine] debate FORCED by judgment backstop (model gate said lookup)")
        log.info("[hyper-engine] plan recalls=%d connectors=%d web=%s debate=%s",
                 len(plan["recall_queries"]), len(plan["connector_calls"]),
                 bool(plan["web_query"]), plan["needs_debate"])
        return plan

    # What each gather task reads as, in a teammate's voice — start note + done line.
    # Attribution is TRUTHFUL: the task genuinely ran under that agent's name; only the
    # phrasing is human. Zero extra LLM calls (pure string building).
    def _task_phrase(self, fn: str, args: Dict[str, Any]) -> tuple:
        q = str(args.get("query") or args.get("q") or "")[:80]
        if fn == "recall":
            return (f"searching the company brain for “{q}”…",
                    f"Pulled what we know on “{q}” onto the board.")
        if fn == "web_search":
            return (f"running a live web search for “{q}”…",
                    f"Brought back live web findings on “{q}” (sources on the board).")
        if fn == "places_search":
            return (f"scouting local businesses for “{q}”…",
                    f"Found real firms for “{q}” — names, phones, sites on the board.")
        prov = fn.split("__")[0].replace("_", " ")
        return (f"reading {prov} ({fn.split('__')[-1]})…",
                f"Checked {prov} — result is on the board.")

    async def _gather_one(self, fn: str, args: Dict[str, Any],
                          owner: Optional[Dict[str, Any]] = None) -> None:
        try:
            start, done = self._task_phrase(fn, args)
            if owner:
                # The crew visibly at work: this task runs under a REAL participant's
                # name — typing while it runs, a persistent contribution bubble when it
                # lands. Without this, a no-debate turn (needs_debate=false) showed ZERO
                # agent activity — the room looked like background magic, not employees.
                nm = owner.get("name") or owner.get("slug")
                await self.emit({"t": "typing", "agent": owner.get("slug"), "note": f"{nm} — {start}"})
            else:
                await self._emit_tool_start(fn, args)
            await self._exec(fn, args)
            if owner:
                await self.emit({"t": "react", "agent": owner.get("slug"),
                                 "name": owner.get("name") or owner.get("slug"),
                                 "lane": owner.get("_lane") or "Communicator",
                                 "agreement": "contribute", "content": done,
                                 "line": done, "confidence": 0.8})
        except Exception as exc:  # noqa: BLE001 — one failed gather never fails the turn
            log.warning("[hyper-engine] gather %s failed: %s", fn, exc)

    def _gather_owner(self, idx: int, fn: str) -> Optional[Dict[str, Any]]:
        """Deterministic task→participant assignment. Lane-aware where it reads
        naturally (web → an investigator/strategist if the room has one), else
        round-robin so every teammate visibly carries part of the work."""
        ps = self.participants or []
        if not ps:
            return None
        if fn == "web_search":
            for p in ps:
                if str(p.get("_lane") or "").lower() in ("investigator", "strategist"):
                    return p
        return ps[idx % len(ps)]

    async def _run_gather(self, plan: Dict[str, Any]) -> int:
        """Run every planned recall / connector read / web search CONCURRENTLY — gather
        wall-time is the slowest single call, not the sum of 7 sequential ones."""
        # Method skills load first (instant, no I/O): bodies land on the blackboard
        # so gather owners, the debate, and the synth all reason under the method.
        for sname in (plan.get("method_skills") or []):
            body = load_method_skill(sname)
            if body and sname not in self.skills_used:
                self.skills_used.append(sname)
                self.blackboard.append(f"SKILL[{sname}]:\n{body}")
                await self.emit({"t": "skill_used", "skill": sname, "room_kind": self.room_kind})
        tasks: List[Awaitable[None]] = []
        _i = 0
        for q in plan["recall_queries"]:
            tasks.append(self._gather_one("recall", {"query": q, "max": 6},
                                          owner=self._gather_owner(_i, "recall"))); _i += 1
        for c in plan["connector_calls"]:
            tasks.append(self._gather_one(c["name"], dict(c.get("args") or {}),
                                          owner=self._gather_owner(_i, c["name"]))); _i += 1
        if plan["web_query"]:
            tasks.append(self._gather_one("web_search", {"query": plan["web_query"]},
                                          owner=self._gather_owner(_i, "web_search"))); _i += 1
        if plan.get("places_query"):
            tasks.append(self._gather_one("places_search", {"query": plan["places_query"]},
                                          owner=self._gather_owner(_i, "web_search")))
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        return len(tasks)

    # Room-kind report SKELETONS: each kind seals under FIXED headings so the
    # report reads like that domain specialist's signed deliverable AND the FE
    # can render known row-cards (known-heading parse — synth stays text-only,
    # no JSON contract). general = today's structure, untouched fallback.
    _REPORT_SKELETON = {
        "campaign": (
            "## Campaign Strategy — objective, audience, offer, proof, and CTA\n"
            "## Channel Plan — ready actions and coordinated timing by channel\n"
            "## Audience & Safety — selection rationale, consent constraints, and exclusions\n"
            "## Measurement — baseline, KPIs, guardrails, and attribution limits"),
        "market": (
            "## Competitive Landscape — ranked competitor rows (one per REAL competitor), source per row\n"
            "## Where We Win — the 2-4 sharpest asymmetries, each tied to evidence\n"
            "## Threats & Gaps — what hurts us + what we could not verify\n"
            "## Recommended Moves — lever + owner + measurable signal per move"),
        "content": (
            "## Content Pillars — 3-4 pillars, each mapped to an ICP pain\n"
            "## Editorial Calendar — a table: week × piece × channel × success signal\n"
            "## Hooks & Angles — real customer language, proof asset per angle\n"
            "## Distribution — channels the company actually has, with reach"),
        "outreach": (
            "## Ideal Customer Profile — who we target and the disqualifiers\n"
            "## Prospect List — ranked table, why-fit + contact + source per row\n"
            "## Sequence — a table: touch × timing × message essence × CTA\n"
            "## Success Metrics — reply/booking signals to track"),
        "business": (
            "## Unit Economics — table: metric × value/range × source or assumption\n"
            "## Pricing & Positioning — anchor + packaging, tied to ICP budget trigger\n"
            "## Key Risks — top risks with likelihood, impact, early signal, owner\n"
            "## The One Thing That Kills This — the single fatal metric + cheap test"),
        "strategy": (
            "## Decision — the one-line DACI decision statement\n"
            "## Options Considered — scored table incl. do-nothing\n"
            "## Rationale — grounded bullets citing debate + evidence\n"
            "## Tripwire — what would flip this decision, and who watches it"),
    }

    def _lang_directive(self) -> str:
        """Strict output-language directive for the FE navbar locale (mirrors /chat).
        Empty when English/unset. The report — every heading, table, and email —
        must be written entirely in this language regardless of the input language."""
        if not self.out_lang:
            return ""
        return (
            f"\n\nOUTPUT LANGUAGE — MANDATORY: write the ENTIRE deliverable in {self.out_lang} ONLY. "
            f"Every heading, sentence, table cell, list item, and email (subject + body) must be in "
            f"{self.out_lang}, even though the task, context, and gathered facts are in another language. "
            f"Do NOT mix languages. Keep proper nouns, brand names (SINGULANCE, TARA, HIVEMIND, "
            f"HYPERAGENTS), URLs, and email addresses verbatim.")

    def _campaign_requirements(self) -> Tuple[List[str], List[str]]:
        channels: List[str] = []
        match = re.search(r"^CHANNELS:\s*(.+)$", self.user_message or "", re.M | re.I)
        if match:
            channels = [x.strip().lower() for x in match.group(1).split(",") if x.strip()]
        return channels, ["goal"] + [f"channel:{channel}" for channel in channels]

    @staticmethod
    def _campaign_bundle_errors(bundle: Any, channels: List[str], requirements: List[str]) -> List[str]:
        if not isinstance(bundle, dict):
            return ["bundle must be an object"]
        errors: List[str] = []
        if not str(bundle.get("strategy") or "").strip(): errors.append("strategy is required")
        if not isinstance(bundle.get("audience"), dict) or not str(bundle["audience"].get("rationale") or "").strip():
            errors.append("audience.rationale is required")
        if not isinstance(bundle.get("content_pillars"), list) or not bundle.get("content_pillars"):
            errors.append("content_pillars must not be empty")
        if not isinstance(bundle.get("kpis"), list) or not bundle.get("kpis"):
            errors.append("kpis must not be empty")
        actions = bundle.get("actions")
        if not isinstance(actions, list) or not actions:
            errors.append("actions must not be empty")
            actions = []
        seen_ids, action_channels = set(), set()
        for index, action in enumerate(actions):
            if not isinstance(action, dict):
                errors.append(f"action {index + 1} must be an object"); continue
            action_id = str(action.get("id") or "").strip()
            channel = str(action.get("channel") or "").strip().lower()
            if not action_id or action_id in seen_ids: errors.append(f"action {index + 1} needs a unique id")
            seen_ids.add(action_id)
            if channel not in channels: errors.append(f"action {action_id or index + 1} has an unrequested channel")
            action_channels.add(channel)
            if not str(action.get("final_copy") or "").strip(): errors.append(f"action {action_id or index + 1} needs final_copy")
            if not isinstance(action.get("payload"), dict): errors.append(f"action {action_id or index + 1} needs payload")
            offset = action.get("scheduled_offset_minutes")
            if not isinstance(offset, int) or offset < 0: errors.append(f"action {action_id or index + 1} needs a non-negative schedule offset")
            if not str(action.get("rationale") or "").strip(): errors.append(f"action {action_id or index + 1} needs rationale")
            if channel == "gmail" and not str((action.get("payload") or {}).get("subject") or "").strip():
                errors.append(f"Gmail action {action_id or index + 1} needs payload.subject")
            if channel == "gmail" and not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", str((action.get("payload") or {}).get("to") or "")):
                errors.append(f"Gmail action {action_id or index + 1} needs a verified payload.to email")
            if channel == "tara" and not str((action.get("payload") or {}).get("opening") or "").strip():
                errors.append(f"TARA action {action_id or index + 1} needs a speak-first payload.opening")
            if channel == "tara" and not re.match(r"^\+[1-9]\d{6,14}$", str((action.get("payload") or {}).get("to") or "")):
                errors.append(f"TARA action {action_id or index + 1} needs a verified E.164 payload.to")
        for channel in channels:
            if channel not in action_channels: errors.append(f"selected channel {channel} has no action")
        coverage = bundle.get("requirement_coverage")
        covered = {str(x.get("requirement_id") or "") for x in coverage or [] if isinstance(x, dict) and x.get("action_ids")}
        for requirement in requirements:
            if requirement not in covered: errors.append(f"requirement {requirement} is not covered by actions")
        return errors

    async def _synthesize_campaign_bundle(self, forced_debate: bool, transcript_json: str) -> Tuple[Optional[Dict[str, Any]], List[str]]:
        channels, requirements = self._campaign_requirements()
        board = "\n".join(self.blackboard)[:8000] or "(no grounded facts were gathered)"
        system = (
            "You are the final campaign plan compiler. Return one JSON object only. The room may research and draft, "
            "but it must never send. Preserve the user's goal, use only selected channels, and provide complete final "
            "content. Required shape: {strategy:string,audience:{rationale:string,segments:array,safety_notes:array},"
            "content_pillars:string[],kpis:[{name:string,target:string,source:string}],actions:[{id:string,channel:string,"
            "title:string,final_copy:string,payload:object,scheduled_offset_minutes:integer,rationale:string,evidence:string[]}],"
            "risks:string[],requirement_coverage:[{requirement_id:string,strategy_sections:string[],action_ids:string[]}]}. "
            "For Gmail payload include a verified to email, subject, and recipient_policy. For TARA include a verified "
            "E.164 to number, opening, goal, context, language, "
            "objections, and strategy; TARA must speak first. For X Organic payload include text. No placeholders. "
            f"Selected channels: {channels}. Required requirement ids: {requirements}."
        )
        user = (f"USER CAMPAIGN BRIEF:\n{self.user_message}\n\nCOMPANY CONTEXT:\n{self.company_brief[:2000]}\n\n"
                f"GATHERED BOARD:\n{board}\n\nDEBATE:\n{transcript_json[:5000] if forced_debate else '(not forced)'}")
        errors = ["bundle was not generated"]
        bundle: Optional[Dict[str, Any]] = None
        for attempt in range(2):
            messages = [{"role": "system", "content": system}, {"role": "user", "content": user}]
            if attempt:
                messages.append({"role": "user", "content": "Repair every validation error and return the full JSON object again:\n- " + "\n- ".join(errors)})
            msg = await self._groq(messages, force_text=True, model=self.synth_model, bucket="synth", temp=0.2)
            raw = str((msg or {}).get("content") or "").strip()
            try:
                raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw, flags=re.I | re.S)
                bundle = json.loads(raw)
            except Exception:
                bundle = None
            errors = self._campaign_bundle_errors(bundle, channels, requirements)
            if not errors:
                return bundle, []
        return bundle, errors

    @staticmethod
    def _render_campaign_report(bundle: Dict[str, Any]) -> str:
        actions = bundle.get("actions") or []
        action_lines = [f"- **{a.get('title') or a.get('id')}** ({a.get('channel')}): {a.get('rationale')}" for a in actions]
        kpi_lines = [f"- **{k.get('name')}**: {k.get('target')} ({k.get('source')})" for k in bundle.get("kpis") or []]
        return (f"## Campaign Strategy\n{bundle.get('strategy', '')}\n\n## Channel Plan\n" + "\n".join(action_lines) +
                f"\n\n## Audience & Safety\n{(bundle.get('audience') or {}).get('rationale', '')}\n\n"
                "## Measurement\n" + "\n".join(kpi_lines) +
                "\n\n## Gaps to confirm\n" + ("\n".join(f"- {x}" for x in bundle.get("risks") or []) or "- None identified."))

    async def _synthesize(self, forced_debate: bool, transcript_json: str) -> str:
        """Write the final deliverable from the gathered board (+ debate). Clean context
        on the synth model — no tool-call transcript → no harmony glitch, full quality."""
        board = "\n".join(self.blackboard)[:6000] or "(no grounded facts were gathered)"
        debate_ctx = (f"\n\nThe room DEBATED this — transcript:\n{transcript_json}\nCite who argued what."
                      if forced_debate else "")
        # Additional: a population simulation's report (if it ran) is folded in so the final
        # deliverable reflects the simulated stakeholder population — not just the room.
        sim_ctx = (f"\n\nA POPULATION SIMULATION of synthetic stakeholder voices produced this report — "
                   f"incorporate its consensus + fault lines where relevant:\n{self._sim_report[:2500]}"
                   if self._sim_report else "")
        # The deliverable FORMAT is driven by the intended output — so an "email" turn writes a
        # ready-to-send email (Subject + body), NOT a generic strategy report the producer can't send.
        _io = self.intended_output
        _is_prospecting = bool(re.search(
            r"\b(?:prospects?|leads?|potential clients?|new clients?|outreach|reach out|find clients?)\b",
            (self.user_message or "").lower()))
        if _io == "email":
            # Auto-load the polished-email skill (the director rarely calls load_skill itself) +
            # email-medium rules: an email is read in an inbox — minimal markdown (bold + simple
            # lists only), no headings/tables/diagrams in the BODY, one screen max.
            _fmt = ("\n\nThe deliverable is an EMAIL. Write it ready to send: a 'Subject:' line, then the body. "
                    "NOT a report or doc.\n" + _SKILLS.get("polished-email", "") +
                    "\nEMAIL MEDIUM RULES: keep the BODY inbox-native — short paragraphs, bold sparingly, "
                    "simple '-' lists only; NO markdown headings (#), NO tables, NO code fences, NO mermaid "
                    "inside the email body. If a table/diagram genuinely helps, put it AFTER the email under "
                    "'--- SUPPORTING MATERIAL ---' (the producer attaches/links it; it is not the email). "
                    + ("This is OUTREACH to prospects — open by naming the prospect and why they fit; if you "
                       "identified specific companies, write the email so it can be personalised per prospect, "
                       "and list the prospects (name + why + how to reach) under SUPPORTING MATERIAL. "
                       if _is_prospecting else ""))
        elif _io in ("doc", "notion"):
            _fmt = "\n\nThe deliverable is a DOCUMENT — structured, publish-ready prose with headings + tables."
        elif _io == "sheet":
            _fmt = "\n\nThe deliverable is a SPREADSHEET — output the rows/columns the producer will create as a sheet."
        else:
            _fmt = ""
        # Rich room-report elements — the FE renders these as first-class visuals
        # (styled tables, mermaid, timeline, charts, callouts). Offer them to the
        # room report (doc/answer) + the SUPPORTING MATERIAL of an outreach email —
        # never inside the email body. Use ONLY when they add clarity; keep to
        # grounded facts.
        _RICH = (
            "\n\nRICH REPORT ELEMENTS (use when they genuinely aid clarity — the UI renders each specially):"
            "\n- Tables: normal markdown tables (prospect lists, comparisons)."
            "\n- Callouts: a line starting `> [!important]`, `> [!insight]`, or `> [!risk]` for the one thing that matters."
            "\n- Timeline: a fenced ```timeline block, one `YYYY-MM-DD or label — event` per line (deadlines, project schedule)."
            "\n- Stats: a fenced ```stats block of JSON [{\"label\":\"\",\"value\":\"\",\"delta\":\"+x%\"}] for the report's 3-5 headline numbers."
            "\n- Steps: a fenced ```steps block, one `Title — detail` per line, for a real ordered SEQUENCE (rollout, pilot phases)."
            "\n- Chart: a fenced ```chart block of JSON {\"type\":\"bar|line|donut\",\"title\":\"\",\"data\":[{\"label\":\"\",\"value\":n}]} — ONLY for quantitative comparisons of real numbers (never for a list of steps or a cadence)."
            "\n- Mermaid: a fenced ```mermaid block ONLY for a genuinely BRANCHING flow (a decision tree / funnel with splits). NEVER for a linear list — no straight A→B→C chain, and NEVER for an outreach/email cadence."
            "\nOUTREACH CADENCE RULE: a touch/email sequence (Touch 1 → Touch 2 …) is ALWAYS a markdown TABLE "
            "(columns: Touch · Timing · Channel · Message essence · CTA) or a ```steps block — NEVER a mermaid "
            "diagram and NEVER a chart. Tables are the default; reach for a diagram only when structure truly needs it."
            "\nDon't force them; a crisp report of clean TABLES + one callout beats five half-empty widgets or a gratuitous diagram."
            "\nPROSPECT GROUNDING: when the board carries PROSPECT rows (real firms from Maps/Impressum), any"
            " prospect/target/partner list in the report MUST be built from THOSE rows (real names, phones,"
            " emails, websites) — never invent institutions or write placeholder contacts when real ones exist."
        )
        if _io in ("doc", "notion", "answer", "report", ""):
            _fmt += _RICH
        elif _io == "email" and _is_prospecting:
            _fmt += ("\n\nUnder '--- SUPPORTING MATERIAL ---' you MAY use the rich elements below "
                     "(prospect table, a timeline of the outreach cadence, an [!important] callout).") + _RICH
        # Real sender identity: the email signs off as the connected Gmail; never
        # invent a placeholder like email@company.com. Robust-email contract too.
        if _io == "email" and self.sender_email:
            _fmt += (f"\n\nSENDER IDENTITY: this email is sent from {self.sender_email}. Sign off with "
                     f"the sender's real name/role and this exact address — NEVER invent a placeholder "
                     f"email, phone, or link. Write a tight, specific, non-generic email grounded in the "
                     f"team's discussion: one clear why-now hook tied to the prospect, one concrete value "
                     f"point, one single ask. No filler, no [brackets] left unfilled except the recipient's "
                     f"first name.")
        sysp = (self._system_prompt() + "\n\nYou are now WRITING THE FINAL DELIVERABLE from the gathered "
                "context below — publish-ready content only, plain text, no tool calls, no process narration, "
                "no placeholders. Real markdown tables where they help. Ground every specific in the context; "
                "flag anything unverifiable as UNVERIFIED."
                "\nFINISH-THE-TASK CONTRACT: the report must COMPLETE the user's ask with what the room "
                "gathered — you ARE the research team. NEVER write '[to be sourced]', 'TBD', or assign "
                "work to staff, analysts, or future dates for something the room's tools could do or "
                "already did this turn. If a specific datum genuinely isn't on the board after the tools "
                "ran, state plainly what IS known (e.g. 'no public direct contact — general inbox: "
                "info@x.de, +49 …') and move on. Every deliverable list must be complete and usable as-is."
                "\nNO-FABRICATION CONTRACT (customer-facing deliverables): NEVER invent prices, fees, "
                "percentages, benchmarks, guarantees, certifications, names, email addresses, phone numbers "
                "or links that are not in the gathered context. A fabricated specific tagged UNVERIFIED is "
                "still fabricated — omit it or write [confirm with sales] / [confirm with legal] instead. "
                "Contact details: use ONLY the company's real sender identity from context."
                + self._room_instr_block + _fmt + self._lang_directive())
        # Evidence contract: the report must show its grounding. Skills applied +
        # per-lane evidence counts feed a citation requirement — each major section
        # names the lane (recall/web/connector/debate) that grounded it.
        skills_block = ""
        if self.skills_used:
            _lanes = Counter()
            for line in self.blackboard:
                if line.startswith("SKILL["):
                    continue
                low = line[:60].lower()
                _lanes["web" if "web" in low else "recall" if ("recall" in low or "memory" in low)
                       else "connector"] += 1
            _idx = ", ".join(f"{k}×{v}" for k, v in _lanes.items()) or "none"
            skills_block = (
                f"\n\nMETHODS APPLIED: {', '.join(self.skills_used)} — the deliverable must visibly "
                f"follow these methods.\nEVIDENCE INDEX: {_idx}. Each major section states in-line which "
                f"evidence lane grounded it (recall / web / connector / debate); every recommendation "
                f"ties to a lever + owner + measurable signal."
            )
        sysp += skills_block
        # Kind-specific report skeleton — report-shaped deliverables only (an
        # email/sheet keeps its own format contract). Existing discipline
        # (citations, UNVERIFIED, Gaps to confirm, owner+metric) still applies
        # inside each section.
        _skeleton = self._REPORT_SKELETON.get(self.room_kind) if _io in ("answer", "doc", "notion") else None
        if _skeleton:
            sysp += (
                f"\n\nREPORT STRUCTURE ({self.room_kind.upper()} room — this is a "
                f"{self.room_kind} specialist's deliverable): structure the report under EXACTLY "
                f"these '## ' headings, in this order (each line = heading + its content contract):\n"
                f"{_skeleton}\n"
                f"Open with a 2-3 sentence executive summary BEFORE the first heading; close with "
                f"'## Gaps to confirm' when anything is UNVERIFIED."
            )

        _org = (self.company_brief or "").strip()
        _org_block = (f"COMPANY CONTEXT (write FOR this organisation — in its voice, about its products, customers, "
                      f"and market; make every specific concrete to this company, not generic):\n{_org[:1500]}\n\n"
                      if _org else "")
        user = (f"{_org_block}TASK: {self.user_message}\n\nGATHERED CONTEXT (the room's shared board):\n{board}{debate_ctx}{sim_ctx}\n\n"
                "Write the final, publish-ready deliverable now.")
        msg = await self._groq([{"role": "system", "content": sysp}, {"role": "user", "content": user}],
                               force_text=True, model=self.synth_model, bucket="synth")
        self.director_iters.append(self._last_tok)
        return (msg or {}).get("content") or ""

    # ── Population-Sim (ADDITIONAL, opt-in) ───────────────────────────
    async def _groq_fb(self, messages: List[Dict[str, Any]], models: List[str], **kw: Any) -> Optional[Dict[str, Any]]:
        """Try each model until one returns usable content — the sim's rate-limit fallback
        (8b → gpt-oss-20b → 70b). Metered under bucket 'sim'."""
        msg = None
        for m in models:
            msg = await self._groq(messages, model=m, bucket="sim", **kw)
            if msg and ((msg.get("content") or "").strip()):
                return msg
        return msg

    async def _sim_ontology(self, topic: str, ctx: str) -> List[Dict[str, str]]:
        sysp = ("Design the ONTOLOGY for a social-opinion simulation: the distinct TYPES of voices that "
                "would realistically weigh in on the topic (stakeholders/archetypes — supporters, skeptics, "
                "domain experts, investors, regulators, builders, journalists, affected end-users, "
                "competitors). Maximize coverage of the opinion space; ground in the context. "
                'Return ONLY JSON: {"entity_types":[{"name":str,"description":str,"typical_stance":str}]}')
        user = f"TOPIC: {topic}\n\nCONTEXT:\n{ctx}\n\nDesign {_SIM_TYPES} distinct voice-types."
        msg = await self._groq_fb([{"role": "system", "content": sysp}, {"role": "user", "content": user}],
                                  [_SIM_AGENT_MODEL] + _SIM_FALLBACKS, temp=0.7)
        data = _parse_json_loose((msg or {}).get("content") or "") or {}
        raw = data.get("entity_types") if isinstance(data, dict) else (data if isinstance(data, list) else [])
        types = [{"name": str(t.get("name"))[:50], "description": str(t.get("description") or "")[:160],
                  "typical_stance": str(t.get("typical_stance") or "")[:120]}
                 for t in (raw or []) if isinstance(t, dict) and t.get("name")]
        return types[:_SIM_TYPES] or [{"name": "Stakeholder", "description": "a general participant", "typical_stance": "mixed"}]

    async def _sim_cast(self, topic: str, ctx: str, ontology: List[Dict[str, str]], total: int) -> List[Dict[str, str]]:
        n_types = max(1, len(ontology))
        per, rem = divmod(total, n_types)

        async def batch(etype: Dict[str, str], k: int) -> List[Dict[str, str]]:
            if k <= 0:
                return []
            sysp = (f"Create {k} DISTINCT personas of the voice-type \"{etype['name']}\" "
                    f"({etype['description']}; tends to: {etype['typical_stance']}) for a social simulation. "
                    "They share the type but DIFFER (names, background, stance shade, voice). "
                    'Return ONLY JSON: {"personas":[{"name":str,"stance":str,"background":str,"voice":str,'
                    '"memory":str(prior take on this topic)}]}')
            user = f"TOPIC: {topic}\n\nCONTEXT:\n{ctx[:1800]}\n\nCreate {k} distinct '{etype['name']}' personas."
            msg = await self._groq_fb([{"role": "system", "content": sysp}, {"role": "user", "content": user}],
                                      [_SIM_AGENT_MODEL] + _SIM_FALLBACKS, temp=0.9)
            data = _parse_json_loose((msg or {}).get("content") or "") or {}
            raw = data.get("personas") if isinstance(data, dict) else (data if isinstance(data, list) else [])
            return [{"name": str(p["name"])[:40], "role": etype["name"], "stance": str(p.get("stance") or "")[:120],
                     "background": str(p.get("background") or "")[:240], "voice": str(p.get("voice") or "")[:120],
                     "memory": str(p.get("memory") or "")[:240]}
                    for p in (raw or []) if isinstance(p, dict) and p.get("name")]

        quotas = [per + (1 if i < rem else 0) for i in range(n_types)]
        batches = await asyncio.gather(*[batch(t, q) for t, q in zip(ontology, quotas)], return_exceptions=True)
        cast: List[Dict[str, str]] = []
        for res in batches:
            if isinstance(res, list):
                cast.extend(res)
        return cast

    async def _sim_burst(self, topic: str, ctx: str, cast: List[Dict[str, str]], sem: asyncio.Semaphore
                         ) -> List[Dict[str, Any]]:
        async def one(p: Dict[str, str]) -> Optional[Dict[str, Any]]:
            sysp = (f"You are {p['name']}, a {p['role']}. Background: {p['background']} Stance: {p['stance']}. "
                    f"Voice: {p['voice']}. Your prior take: {p['memory']}. Stay fully IN CHARACTER.")
            user = (f"TOPIC: {topic}\n\nSHARED CONTEXT (ground your take in it):\n{ctx[:2000]}\n\n"
                    "Post your view in-character — one sharp, specific, grounded take (2-3 sentences), then on a "
                    "NEW final line exactly: SENTIMENT: positive | negative | neutral (your overall sentiment "
                    "toward the proposal/topic). No preamble.")
            async with sem:
                msg = await self._groq_fb([{"role": "system", "content": sysp}, {"role": "user", "content": user}],
                                          [_SIM_AGENT_MODEL] + _SIM_FALLBACKS, temp=0.7)
            txt = (msg or {}).get("content") or ""
            if not txt.strip():
                return None
            m = re.search(r"sentiment:\s*(positive|negative|neutral)", txt, re.IGNORECASE)
            sentiment = m.group(1).lower() if m else "neutral"
            clean = re.sub(r"\n*\s*sentiment:\s*(positive|negative|neutral)\s*$", "", txt,
                           flags=re.IGNORECASE).strip() or txt
            return {"name": p["name"], "role": p["role"], "stance": p["stance"],
                    "text": clean, "sentiment": sentiment}

        results = await asyncio.gather(*[one(p) for p in cast], return_exceptions=True)
        return [r for r in results if isinstance(r, dict) and r.get("text")]

    async def _sim_report_call(self, topic: str, ontology: List[Dict[str, str]], posts: List[Dict[str, Any]]) -> str:
        roles = Counter(p["role"] for p in posts)
        sample = "\n".join(f"- [{p['name']} · {p['role']} · {p['stance']}] {p['text'][:200]}" for p in posts[:50])
        digest = {"n_voices": len(posts), "role_distribution": dict(roles.most_common(12)),
                  "voice_types": [t["name"] for t in ontology]}
        sysp = ("You are the lead analyst writing the report on a large-scale opinion simulation — a synthetic "
                "population debated a question. Write a HIGH-LEVEL, decision-grade report:\n"
                "1. **Executive read** — the net of what the population thinks.\n"
                "2. **Consensus** — where they converge (+ which factions).\n"
                "3. **Fault lines** — the real disagreements (a markdown table: faction vs position).\n"
                "4. **Strongest argument per major faction.**\n"
                "5. **Net signal + open gaps.**\nBe specific, no fluff, no process narration.")
        user = (f"QUESTION: {topic}\n\nDIGEST: {json.dumps(digest, ensure_ascii=False)}\n\n"
                f"REPRESENTATIVE VOICES ({min(50, len(posts))} of {len(posts)}):\n{sample}\n\nWrite the report.")
        msg = await self._groq_fb([{"role": "system", "content": sysp}, {"role": "user", "content": user}],
                                  [self.synth_model] + _SIM_FALLBACKS, temp=0.4, force_text=True)
        return ((msg or {}).get("content") or "").strip()

    async def _population_sim(self, topic: str) -> Optional[Dict[str, Any]]:
        """ontology → population → parallel burst → strong-model report. Bounded + fully wrapped —
        any failure returns None and the MAIN turn proceeds untouched (additive guarantee)."""
        try:
            ctx = "\n".join(self.blackboard)[:3000] or (self.room_goal or topic)
            sem = asyncio.Semaphore(_SIM_CONCURRENCY)
            await self.emit({"t": "typing", "agent": "swarm",
                             "note": f"Simulating a population of ~{self.sim_agents} voices…"})
            ontology = await self._sim_ontology(topic, ctx)
            cast = await self._sim_cast(topic, ctx, ontology, self.sim_agents)
            if len(cast) < 3:
                log.warning("[hyper-engine] population-sim: too few personas (%d) — skipping", len(cast))
                return None
            posts = await self._sim_burst(topic, ctx, cast, sem)
            if not posts:
                return None
            report = await self._sim_report_call(topic, ontology, posts)
            if not report:
                return None
            payload = {"report": report, "ontology": [t["name"] for t in ontology],
                       "n_personas": len(cast), "n_posts": len(posts),
                       "role_mix": dict(Counter(p["role"] for p in posts).most_common(12)),
                       # sentiment tally (positive/negative/neutral) → FE gauge + distribution.
                       "sentiment_tally": dict(Counter(p.get("sentiment", "neutral") for p in posts)),
                       # ALL posts (capped) so the FE popup shows the whole simulation, not a teaser.
                       "posts": [{"name": p["name"], "role": p["role"], "stance": p.get("stance", ""),
                                  "sentiment": p.get("sentiment", "neutral"), "text": p["text"][:400]}
                                 for p in posts[:120]],
                       "sample": [{"name": p["name"], "role": p["role"], "text": p["text"][:240]} for p in posts[:8]]}
            log.info("[hyper-engine] population-sim ok: %d personas, %d posts, report %d chars",
                     len(cast), len(posts), len(report))
            return payload
        except Exception as exc:  # noqa: BLE001 — additive: never break the main turn
            log.warning("[hyper-engine] population-sim failed (skipped): %s", exc)
            return None

    async def _chat_turn(self, t0: float) -> Dict[str, Any]:
        """Conversational short-circuit: the lead replies as a person — introduces the
        team when greeted, answers meta-questions about the room, asks what to work
        on. One small LLM call; no gather/web/Maps/debate/synthesis."""
        lead = self.participants[0] if self.participants else {}
        roster = ", ".join(
            f"{p.get('name') or p.get('slug')} ({p.get('_lane') or 'Communicator'})"
            for p in self.participants)
        sysp = (
            _now_block() + self._company_identity_block() +
            f"You are {lead.get('name') or 'the room lead'}, lead of this HIVEMIND room. "
            f"Your team: {roster}. The user said something CONVERSATIONAL — reply as a warm, "
            "concise colleague (2-5 sentences, no headings, no tables, no report). If greeted, "
            "greet back, briefly introduce the team and what this room works on"
            + (f" (room goal: {self.room_goal[:200]})" if self.room_goal else "") +
            ", and ask what they'd like the team to tackle. Match the user's language."
            + self._lang_directive())
        msg = await self._groq(
            [{"role": "system", "content": sysp},
             {"role": "user", "content": (self.user_message or "")[:1500]}],
            force_text=True, temp=0.6, bucket="chat")
        reply = ((msg or {}).get("content") or "").strip() or (
            f"Hi! We're the {lead.get('name') or 'room'} team — tell us what you'd like us to work on.")
        await self.emit({"t": "line", "agent": lead.get("slug") or "director",
                         "kind": "synthesis", "content": reply})
        log.info("[hyper-engine] chat turn — %d tokens, %dms", self.tokens, int((time.time() - t0) * 1000))
        return {"cost_tokens": self.tokens, "final_text": reply, "transcript": self.transcript,
                "gather_count": 0, "tool_calls": 0, "sim_report": None}

    async def run(self) -> Dict[str, Any]:
        t0 = time.time()
        # Instant feedback from t=0: connector-tool init + the first model call run
        # with no event of their own, so without this the FE sits idle (only the
        # router showing) until the first tool fires. One typing note so the room
        # never looks frozen right after the query is sent.
        _lead = self.participants[0].get("slug") if self.participants else "director"
        await self.emit({"t": "typing", "agent": _lead, "note": "Reading the goal and gathering context…"})
        await self._init_connector_tools()  # register toggled connectors as read tools
        # PHASE 1 — STRUCTURED GATHER PLAN. One JSON-schema call (NOT native tool-calling)
        # decides what to recall / which connectors to read / web + debate. Replaces the
        # old 15-round sequential agentic loop: one round-trip, no harmony tool glitch.
        plan = await self._plan_gather()
        # EVENT-DRIVEN TURN ROUTER — the planner (an LLM, not a regex) classified the
        # MESSAGE. 'chat' = conversational: the room replies as people — no gather, no
        # web/Maps spend, no debate, no report. 'hallo' used to burn a 27k-token full
        # pipeline ending in a fabricated report.
        if str(plan.get("turn_mode") or "task").lower() == "chat":
            return await self._chat_turn(t0)
        # PHASE 2 — PARALLEL GATHER. Every recall + connector read + web runs CONCURRENTLY.
        tool_calls_made = await self._run_gather(plan)
        # PHASE 2.5 — POPULATION SIM (ADDITIONAL, opt-in). Runs on the gathered context, emits a
        # report the FE shows as a hideable popup, and feeds that report into the synthesis. Fully
        # wrapped — a failure just skips it; the main turn (debate + synth) is never affected.
        if self.sim_mode in _SIM_ON:
            self._sim_payload = await self._population_sim(self.room_goal or self.user_message or "")
            if self._sim_payload:
                self._sim_report = self._sim_payload.get("report")
                await self.emit({"t": "sim_report", **self._sim_payload})
        # PHASE 3 — DEBATE (the multi-agent product). Convene only when the plan judges the
        # task needs a decision/judgment/discussion — a pure lookup skips it (faster, on-point).
        forced_debate = False
        transcript_json = ""
        if len(self.participants) >= 2 and plan.get("needs_debate"):
            try:
                topic = (self.room_goal or self.user_message or "")[:400]
                transcript_json = await self._debate(topic, self.debate_max_rounds)
                forced_debate = True
            except Exception as exc:  # noqa: BLE001
                log.warning("[hyper-engine] debate failed: %s", exc)
        # PHASE 3.5 — TASK-COMPLETION PASS. If the task's deliverable is prospects/
        # contacts and the board is thin, the room FINISHES the job itself instead of
        # sealing a report full of "[to be sourced]" and fictional research assignees:
        #   a) org names surfaced by web/debate get looked up on Maps for REAL contacts;
        #   b) a sharpened company-oriented Places query runs when discovery was weak.
        try:
            # Event-driven gate: the planner (LLM) asking for a places_query IS the
            # discovery signal — works in any language; the regex is only a fallback.
            _wants_contacts = bool(plan.get("places_query")) or _wants_discovery(self.user_message)
            _prospect_rows = [l for l in self.blackboard if "PROSPECT:" in str(l)]
            if _wants_contacts and len(_prospect_rows) < 3:
                await self.emit({"t": "typing", "agent": "director",
                                 "note": "Completing the task — sourcing real contacts for the named organisations…"})
                # LLM QUERY COMPOSER — global, context-driven (no locale-specific
                # regexes). One small structured call sees the task + what the board
                # already surfaced and emits the OPTIMAL Google Places text queries:
                # named-org lookups ("<Org name> <city>") for organisations the web/
                # debate already identified, plus category discovery ("<business
                # category> in <city/region>") matching the task's real geography and
                # industry. 0-3 queries; empty when Maps can't help. The _places_search
                # sanitizer stays as the final cost guard.
                queries = await self._compose_places_queries()
                for q in queries[:3]:
                    try:
                        await self._places_search(q)
                    except Exception:  # noqa: BLE001
                        pass
        except Exception as exc:  # noqa: BLE001 — completion pass must never sink the turn
            log.warning("[hyper-engine] completion pass failed: %s", exc)

        # PHASE 4 — STRONG-MODEL SYNTHESIS from the gathered board + debate. Clean context
        # (no tool-call transcript) on the synth model → no harmony glitch, full quality.
        _lead_p = self.participants[0] if self.participants else {}
        await self.emit({"t": "typing", "agent": _lead_p.get("slug") or "director",
                         "note": f"{_lead_p.get('name') or 'The lead'} — drafting the final deliverable from the team's board…"})
        campaign_bundle = None
        campaign_bundle_errors: List[str] = []
        if self.room_kind == "campaign":
            campaign_bundle, campaign_bundle_errors = await self._synthesize_campaign_bundle(forced_debate, transcript_json)
            if campaign_bundle and not campaign_bundle_errors:
                await self.emit({"t": "campaign_bundle", "bundle": campaign_bundle})
                final_text = self._render_campaign_report(campaign_bundle)
            else:
                await self.emit({"t": "campaign_bundle_invalid", "errors": campaign_bundle_errors})
                final_text = "The campaign plan needs input before it can be approved.\n\n" + "\n".join(
                    f"- {error}" for error in campaign_bundle_errors)
        else:
            final_text = await self._synthesize(forced_debate, transcript_json)
        if not final_text:
            # Every synthesis attempt failed — never return empty at the emit boundary.
            final_text = ("(The room could not produce a grounded answer this turn — "
                          "the model was unreachable. Please retry, or add more context.)")

        await self.emit({"t": "line", "agent": (self.participants[0].get("slug") if self.participants else "director"),
                         "kind": "synthesis", "content": final_text})
        log.info("[hyper-engine] done plan+gather=%d rounds=%d tokens=%d ms=%d gather=%d tok_by=%s iters=%s",
                 tool_calls_made, self._round_seq, self.tokens, int((time.time() - t0) * 1000),
                 self.gather_count, self.tok_by, self.director_iters)
        # Report this turn's director LLM spend to core so it records against the org's HIVEMIND API key
        # (the director runs in this Python service, off core's JS metering chokepoint). Fire-and-forget.
        try:
            await report_llm_usage(
                user_id=self.user_id, org_id=self.org_id,
                api_key=getattr(self, "api_key", "") or "",
                model="hyperagents-director",
                total_tokens=int(self.tokens or 0),
                prompt_tokens=int(self.io.get("input", 0) or 0),
                completion_tokens=int(self.io.get("output", 0) or 0),
                feature="hyperagents-room",
            )
        except Exception:
            pass
        return {
            "cost_tokens": self.tokens,
            "final_text": final_text,
            "transcript": self.transcript,
            "gather_count": self.gather_count,
            "tool_calls": tool_calls_made,
            "tok_by": dict(self.tok_by),
            "director_iters": list(self.director_iters),
            "debate_rounds": self._round_seq,
            "web_calls": self._web_calls,
            "io": dict(self.io),
            "gathered_emails": sorted(self.gathered_emails),
            "gather_facts": list(self.blackboard),
            "sim_report": self._sim_payload,  # the population-sim dashboard (None unless sim_mode on)
            "evo_playbooks": self.evo_playbooks,  # the playbooks injected this turn (api reflects on these)
            "skills_used": list(self.skills_used),  # METHOD skills applied (reflection + FE chips)
            "room_kind": self.room_kind,
            "campaign_bundle": campaign_bundle,
            "campaign_bundle_errors": campaign_bundle_errors,
        }


async def run_director(
    *,
    user_message: str,
    user_id: str,
    org_id: str,
    project_id: Optional[str],
    participants: List[Dict[str, Any]],
    room_template: str,
    room_goal: Optional[str],
    enabled_connectors: List[str],
    emit: Callable[[Dict[str, Any]], Awaitable[None]],
    director_model: Optional[str] = None,
    persona_model: Optional[str] = None,
    synth_model: Optional[str] = None,
    max_iters: int = 16,
    sim_mode: str = "off",
    sim_agents: int = 0,
    evo_mode: str = "off",
    evo_playbooks: Optional[Dict[str, List[str]]] = None,
    company_brief: str = "",
    intended_output: str = "answer",
    room_kind: str = "",
    room_playbook: Optional[List[str]] = None,
    room_instructions: str = "",
    sender_email: str = "",
    out_language: str = "",
) -> Dict[str, Any]:
    """Run one room turn through the single-director engine. Returns
    {cost_tokens, final_text, transcript, gather_count, tool_calls, sim_report}."""
    director = Director(
        user_message=user_message, user_id=user_id, org_id=org_id, project_id=project_id,
        participants=participants, room_template=room_template, room_goal=room_goal,
        enabled_connectors=enabled_connectors, emit=emit,
        director_model=director_model, persona_model=persona_model, synth_model=synth_model,
        max_iters=max_iters, sim_mode=sim_mode, sim_agents=sim_agents,
        evo_mode=evo_mode, evo_playbooks=evo_playbooks,
        company_brief=company_brief,
        intended_output=intended_output,
        room_kind=room_kind, room_playbook=room_playbook,
        room_instructions=room_instructions,
        sender_email=sender_email,
        out_language=out_language,
    )
    return await director.run()
