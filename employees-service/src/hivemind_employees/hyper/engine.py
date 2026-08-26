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
import hashlib
import json
import logging
import os
import re
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple
from urllib.parse import urlsplit

import httpx

from ..ai_gateway import post as gateway_post

from ..config import get_settings
from ..db import (
    create_hyper_work_order,
    start_hyper_work_order,
    complete_hyper_work_order,
    pause_hyper_work_order,
    get_room_journal,
)
from .skills import default_skill_for, load_method_skill, resolve_room_kind, skill_catalog, work_skill_catalog
from .domains import get_domain_pack
from .model_policy import HYPER_FAST_MODEL, canonical_hyper_model
from .visual_artifact_renderer import (
    PRESENTATION_SPEC_SCHEMA,
    normalize_presentation_spec,
    render_presentation,
)
from ..hivemind_client import (
    campaign_create_emulated,
    connector_exec_emulated,
    connector_inspect_emulated,
    google_exec_emulated,
    get_tara_call_emulated,
    list_prospects_emulated,
    org_members_emulated,
    recall_emulated,
    report_llm_usage,
    save_prospects_bulk_emulated,
    seo_audit_emulated,
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
    (os.environ.get("HYPER_CEREBRAS_DIRECT_MODELS", "zai-glm-4.7,gpt-oss-120b")).split(",") if m.strip()}
_EMAIL_RE = re.compile(r"[\w.+-]+@[\w.-]+\.\w+")


def _visual_artifacts_enabled() -> bool:
    """Return whether the additive HyperRoom artifact path is enabled."""
    value = os.environ.get(
        "Visual_path_In_Hyperrooms",
        os.environ.get("VISUAL_PATH_IN_HYPERROOMS", "false"),
    )
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


_HTML_ARTIFACT_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "title": {"type": "string"},
        "summary": {"type": "string"},
        "html": {"type": "string"},
        "source_refs": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["title", "summary", "html", "source_refs"],
}
_VISUAL_DIRECTION_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "visual_thesis": {"type": "string"},
        "experience": {"type": "string"},
        "layout_system": {"type": "string"},
        "art_direction": {"type": "string"},
        "palette": {"type": "array", "items": {"type": "string"}},
        "narrative_flow": {"type": "array", "items": {"type": "string"}},
        "visual_explanations": {"type": "array", "items": {"type": "string"}},
        "interaction": {"type": "string"},
        "avoid": {"type": "array", "items": {"type": "string"}},
    },
    "required": [
        "visual_thesis", "experience", "layout_system", "art_direction", "palette",
        "narrative_flow", "visual_explanations", "interaction", "avoid",
    ],
}
_VISUAL_SKILL_PATH = Path(__file__).with_name("visual_artifact_skill.md")


def _normalize_work_step_wait(value: Any) -> Dict[str, Any]:
    """Keep only a bounded, data-declared pause contract from a Work Room plan."""
    if not isinstance(value, dict):
        return {}
    kind = str(value.get("kind") or "").strip().lower()
    reason = str(value.get("reason") or "").strip()[:1000]
    if kind not in {"input", "approval", "capability", "event"} or not reason:
        return {}
    prompt = value.get("prompt")
    resume_key = value.get("resume_key")
    return {
        "kind": kind,
        "reason": reason,
        "prompt": str(prompt).strip()[:600] if isinstance(prompt, str) and prompt.strip() else None,
        "resume_key": str(resume_key).strip()[:120] if isinstance(resume_key, str) and resume_key.strip() else None,
    }


def _normalize_work_step_handoff(value: Any) -> Dict[str, Any]:
    """Persist a proposal for the next owner without invoking that owner."""
    if not isinstance(value, dict):
        return {}
    owner = str(value.get("owner") or "").strip()[:80]
    if owner.lower() in {"runtime", "hq", "hq runtime"}:
        owner = "runtime"
    objective = str(value.get("objective") or "").strip()[:600]
    rationale = str(value.get("rationale") or "").strip()[:1000]
    if not owner or not objective or not rationale:
        return {}
    return {"owner": owner, "objective": objective, "rationale": rationale}

# Groq model id → OpenRouter slug. None (or a NO_FALLBACK / unknown bare id) means
# "no OpenRouter text equivalent" → no fallback, the Groq failure is surfaced.
_OR_MODEL_MAP: Dict[str, str] = {
    "openai/gpt-oss-120b": "openai/gpt-oss-120b",
    "openai/gpt-oss-20b": HYPER_FAST_MODEL,
    HYPER_FAST_MODEL: HYPER_FAST_MODEL,
    "gpt-oss-120b": "openai/gpt-oss-120b",
    "gpt-oss-20b": HYPER_FAST_MODEL,
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
    # 2026-08-12: Groq re-added as a candidate (owner instruction) — our DIRECT
    # Groq key is confirmed delinquent (billing-dead, causing repeated 400s on
    # every call site that still hits api.groq.com raw, see _select_execution_
    # profile in api_hyper_rooms.py). "Groq" here is OpenRouter's OWN hosted
    # Groq capacity, billed through OpenRouter — unaffected by our dead key.
    # Cerebras stays first per the 2026-07-14 measured finding (wafer-scale
    # ~3000 tok/s vs Groq under load 12-18s for the same call); Groq is an
    # explicit fallback candidate instead of being excluded outright.
    "openai/gpt-oss-120b": ["Cerebras", "Groq", "Together"],
    # Fireworks dropped from the 20b pin — measured 13.5s and 39.3s per call live
    # (2026-07-07) vs Groq ~1.6-2.5s on the same calls; it was the plan-phase spike.
    "openai/gpt-oss-20b": ["novita"],
    HYPER_FAST_MODEL: ["novita"],
    "openai/gpt-oss": ["Cerebras"],
    "qwen/": ["Alibaba"],
    "moonshotai/": ["Moonshot AI", "Novita"],
    # Verified live 2026-08-12: nvidia/nemotron-3.5-lightning has only two
    # OpenRouter hosts (DeepInfra, CoreWeave). The global HYPER_OR_IGNORE
    # default blacklists DeepInfra — reproduced exactly: sending its ignore
    # list alone against this model returned 404 "All providers have been
    # ignored" (not an account-level privacy block as first suspected — a
    # collision with our OWN default blacklist, since this model has too few
    # hosts to survive it). Pinning both here is necessary but not
    # sufficient by itself — see the ignore-list filter right below, which
    # keeps a pinned provider from also being ignored.
    "nvidia/nemotron-3.5-lightning": ["DeepInfra", "CoreWeave"],
}

# Models that default to reasoning ON with no way to ask for it off implicitly —
# OpenRouter sends chain-of-thought unless the request explicitly disables it.
# Verified live 2026-08-12 (curl against the real endpoint): nvidia/nemotron-
# 3.5-lightning burned its ENTIRE token budget on `reasoning` and returned
# content=null/finish_reason="length" at our real profile-selector budget (300
# tok) AND our real synth budget (2200 tok) — it never reached the answer.
# Explicitly setting reasoning.enabled=false fixed both: 300-tok profile
# selection succeeded in 1.0s/62 tokens, 2200-tok synthesis in 5.7s/872 tokens,
# both well under budget. Prefix-matched so any future nemotron variant is
# covered without a code change.
_REASONING_OFF_MODEL_PREFIXES = ("nvidia/nemotron-",)


def _needs_reasoning_disabled(model: str) -> bool:
    return str(model or "").lower().startswith(_REASONING_OFF_MODEL_PREFIXES)


# Experimental candidate models fall back to the proven default on ANY failure
# — a flaky/unavailable experimental host must never take an already-working
# step down with it. nvidia/nemotron-3.5-lightning's own OpenRouter endpoints
# measured 94.8%/98.9% 24h uptime (2026-08-12) — good, not prod-grade-solid —
# so a single retry against the known-good model is cheap insurance, not
# over-engineering.
_EXPERIMENTAL_MODEL_FALLBACK = {"nvidia/nemotron-": "openai/gpt-oss-120b"}


def _fallback_model_for(model: str) -> Optional[str]:
    low = str(model or "").lower()
    for prefix, fallback in _EXPERIMENTAL_MODEL_FALLBACK.items():
        if low.startswith(prefix):
            return fallback
    return None


# Set True the first time Groq returns a billing-block error → gpt-oss/llama then
# route DIRECT to OpenRouter→Cerebras (skip the wasted Groq 400 round-trips). Resets
# on process restart (re-probes Groq once), so funding Groq self-heals.
_GROQ_DEAD = False
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


def _work_order_activity(title: Any, text: str, *, limit: Optional[int] = None) -> str:
    """Return the complete bounded worker note for the visible discussion.

    Worker generation is already capped to a compact note. Clipping that note a
    second time hid the evidence and disagreement users asked the Room to show.
    """
    clean = str(text or "").strip()
    clean = re.sub(r"^(?:[-*#]+\s*)+", "", clean)
    if not clean:
        return f"Completed {str(title or 'assigned work').strip()}."
    prefix = f"Completed {str(title or 'assigned work').strip()}: "
    return prefix + clean


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


def _or_provider_routing(model: str) -> Tuple[Optional[List[str]], List[str]]:
    """(order, ignore) for one OpenRouter request. A provider explicitly
    pinned for THIS model is dropped from the global ignore list — sending
    both order+ignore naming the same host 404s with "All providers have
    been ignored" when no other host survives. Verified live 2026-08-12
    against nvidia/nemotron-3.5-lightning: it has only two OpenRouter hosts
    (DeepInfra, CoreWeave), and DeepInfra sits in the global HYPER_OR_IGNORE
    default — reproduced the exact 404 by sending that ignore list alone.
    ignore: measured-slow hosts that keep winning price-ranked fallbacks
    (DekaLLM served 20-60 tok/s twice). Env-overridable; empty string
    disables the blacklist. SiliconFlow/Phala added 2026-07-07: fallback-
    pool leaks measured 9-36s per 20b debate call."""
    pin = _or_provider_pin(model)
    ignore = [s.strip() for s in os.environ.get(
        "HYPER_OR_IGNORE", "DekaLLM,WandB,DeepInfra,Novita,Mancer,SiliconFlow,Phala"
    ).split(",") if s.strip()]
    if pin:
        pinned = {p.lower() for p in pin}
        ignore = [p for p in ignore if p.lower() not in pinned]
    return pin, ignore


def _normalize_openrouter_parameters(body: Dict[str, Any]) -> Dict[str, Any]:
    """Translate OpenAI reasoning aliases before strict provider matching.

    OpenRouter providers advertise ``max_tokens``. Leaving Groq's
    ``max_completion_tokens`` alias in a request with ``require_parameters``
    eliminates every otherwise-compatible Nitro endpoint.
    """
    normalized = dict(body)
    if "max_completion_tokens" in normalized and "max_tokens" not in normalized:
        normalized["max_tokens"] = normalized.pop("max_completion_tokens")
    return normalized


async def _openrouter_chat(body: Dict[str, Any], *, timeout: httpx.Timeout) -> Optional[Dict[str, Any]]:
    """Replay a Groq chat body against OpenRouter when Groq is unavailable.

    Groq stays PRIMARY: this is invoked ONLY after Groq's own retries are spent
    (zero added latency on the healthy path). Returns the parsed response JSON
    (Groq/OpenAI shape, `reasoning` coalesced into `content`/`reasoning_content`)
    or None when no fallback is possible.
    """
    or_key = os.environ.get("OPENROUTER_API_KEY", "")
    or_model = _or_model(canonical_hyper_model(str(body.get("model") or "")))
    if not or_key or not or_model:
        return None
    or_body = _normalize_openrouter_parameters(body)
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
    _pin, _ignore = _or_provider_routing(or_model)
    or_body["provider"] = {**({"order": _pin} if _pin else {}),
                           **({"ignore": _ignore} if _ignore else {}),
                           "sort": "throughput", "allow_fallbacks": True, "require_parameters": True}
    or_body.pop("stream", None)
    _t0 = time.time()
    try:
        async with httpx.AsyncClient(timeout=timeout) as c:
            r = await gateway_post(c,
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
    # Cerebras strict output supports the structural JSON Schema subset but
    # rejects validation-only array constraints such as maxItems. Keep the
    # planner schema small and portable instead of paying for a failed request
    # and provider retry.
    if isinstance(cb.get("response_format"), dict):
        def _portable_schema(value: Any) -> Any:
            if isinstance(value, dict):
                return {
                    key: _portable_schema(item)
                    for key, item in value.items()
                    if key not in {"maxItems", "minItems", "uniqueItems"}
                }
            if isinstance(value, list):
                return [_portable_schema(item) for item in value]
            return value
        cb["response_format"] = _portable_schema(cb["response_format"])
    cb.pop("stream", None)
    if cache_key and os.environ.get("HYPER_CEREBRAS_PROMPT_CACHE_KEY", "").lower() in ("1", "true", "yes", "on"):
        cb["prompt_cache_key"] = str(cache_key)[:1024]
    _t0 = time.time()
    try:
        async with httpx.AsyncClient(timeout=timeout) as c:
            r = await gateway_post(c, _CEREBRAS_URL, headers={"Authorization": f"Bearer {key}"}, json=cb)
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

# Connected write capabilities exposed to the Director as an action catalog.
# The Director selects these after understanding the active message; the
# centralized producer remains the only code allowed to execute the action.
_POST_OUTPUT_CAPABILITIES: Dict[str, Dict[str, Any]] = {
    "gmail.create_draft": {
        "connector": "gmail", "artifact_kind": "email",
        "operation": "draft_email",
        "description": "Create the completed email as a Gmail draft for review.",
        "aliases": ("gmail", "google", "google-mail"),
    },
    "gmail.send_email": {
        "connector": "gmail", "artifact_kind": "email",
        "operation": "send_email",
        "description": "Create a Gmail draft and request approval to send it.",
        "aliases": ("gmail", "google", "google-mail"),
    },
    "google_docs.create_document": {
        "connector": "google-docs", "artifact_kind": "doc",
        "operation": "create_document",
        "description": "Create the completed output as a Google Doc.",
        "aliases": ("google-docs", "google-drive", "google"),
        "request_pattern": r"\bgoogle\s+docs?\b",
    },
    "google_sheets.create_spreadsheet": {
        "connector": "google-sheets", "artifact_kind": "sheet",
        "operation": "create_spreadsheet",
        "description": "Create the completed tabular output as a Google Sheet.",
        "aliases": ("google-sheets", "google-drive", "google"),
        "request_pattern": r"\bgoogle\s+sheets?\b",
    },
    "notion.create_page": {
        "connector": "notion", "artifact_kind": "notion",
        "operation": "create_page",
        "description": "Create the completed output as a Notion page.",
        "aliases": ("notion",),
        "request_pattern": r"\bnotion\b",
    },
}

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
_SIM_AGENT_MODEL = canonical_hyper_model(os.environ.get("HYPER_SIM_AGENT_MODEL", HYPER_FAST_MODEL))
_SIM_FALLBACKS = [m.strip() for m in os.environ.get(
    "HYPER_SIM_FALLBACKS", f"{HYPER_FAST_MODEL},openai/gpt-oss-120b").split(",") if m.strip()]
_SIM_FALLBACKS = [canonical_hyper_model(m) for m in _SIM_FALLBACKS]
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
_EVO_REFLECT_MODEL = canonical_hyper_model(os.environ.get("HYPER_EVOLVE_REFLECT_MODEL", HYPER_FAST_MODEL))
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
_DIGEST_MODEL = canonical_hyper_model(os.environ.get("HYPER_DIGEST_MODEL", HYPER_FAST_MODEL))
_DIGEST_MIN_CHARS = max(1500, int(os.environ.get("HYPER_DIGEST_MIN_CHARS", "2500") or "2500"))  # gate: engage on a moderately-full board (spike: +21% even at ~2k chars)
_DIGEST_MAX_CHARS = max(800, int(os.environ.get("HYPER_DIGEST_MAX_CHARS", "2400") or "2400"))   # bound the digest
_DIGEST_READ_CAP = max(4000, int(os.environ.get("HYPER_DIGEST_READ_CAP", "12000") or "12000"))  # cap the digester's own input

# ── Swarm journal (episodic continuity) ────────────────────────────────────
# A compact, ordered, per-turn log injected at the START of plan + synth so a turn RECALLS prior
# turns ("as we decided…"). Proven (scripts/swarm_spike/journal_spike.py): journal arm recalls a
# prior-turn figure 0.45 vs blank arm 0.00 (blank FABRICATES). Bounded (last N entries) → no token
# regression. Distinct from evo_playbooks (skills) — this is episodic memory of WHAT HAPPENED.
_JOURNAL_ENABLED = (os.environ.get("HYPER_JOURNAL_ENABLED", "true").strip().lower() not in ("0", "false", "no", "off"))
_JOURNAL_MODEL = canonical_hyper_model(os.environ.get("HYPER_JOURNAL_MODEL", HYPER_FAST_MODEL))
_JOURNAL_KEEP = max(2, min(20, int(os.environ.get("HYPER_JOURNAL_KEEP", "6") or "6")))  # entries injected/kept
_JOURNAL_SCHEMA = {
    "type": "object",
    "properties": {
        "asked": {"type": "string"},
        "swarm_summary": {"type": "string"},
        "agents": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "contribution": {"type": "string"},
                },
                "required": ["name", "contribution"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["asked", "swarm_summary", "agents"],
    "additionalProperties": False,
}

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


def _journal_verdict_slice(verdict: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Real gap (2026-08-23): the journal recorded a coarse `status` but threw
    away WHAT was wrong — gaps, unsupported claims, whether the verifier even
    ran. Two rooms in a row can invent the same unbacked numbers because the
    next turn's Director only ever saw the PRIOR DRAFT, never the prior
    critique. Keep this small and additive — capped, optional, never blocks
    journal writes when verdict is missing/malformed."""
    if not isinstance(verdict, dict) or not verdict:
        return None
    slice_ = {
        "grounded_ok": bool(verdict.get("grounded_ok", True)),
        "verification_available": bool(verdict.get("verification_available", True)),
        "gaps": [str(g)[:200] for g in (verdict.get("gaps") or [])][:5],
        "unsupported_claims": [str(c)[:200] for c in (verdict.get("unsupported_claims") or [])][:5],
    }
    if not slice_["gaps"] and not slice_["unsupported_claims"] and slice_["grounded_ok"] and slice_["verification_available"]:
        return None  # nothing wrong last time — no need to carry an empty block forward
    return slice_


async def make_journal_entry(user_message: str, final_text: str, *,
                             transcript: Optional[List[Dict[str, Any]]] = None,
                             participants: Optional[List[Dict[str, Any]]] = None,
                             turn_id: str = "", status: str = "complete",
                             model: Optional[str] = None,
                             verdict: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
    """Distill one run into structured episodic memory: each agent's contribution and
    the swarm result. It is intentionally separate from reusable operating lessons."""
    if not _JOURNAL_ENABLED:
        return None
    _verification = _journal_verdict_slice(verdict)
    def _fallback() -> Optional[Dict[str, Any]]:
        latest: Dict[str, str] = {}
        for item in (transcript or []):
            if isinstance(item, dict) and item.get("agent") and item.get("text"):
                latest[str(item["agent"])] = str(item["text"])
        agents = []
        for p in (participants or [])[:5]:
            name = str(p.get("name") or p.get("slug") or "")
            if name in latest:
                agents.append({
                    "slug": str(p.get("slug") or p.get("id") or ""),
                    "name": name,
                    "contribution": latest[name].strip()[:260],
                })
        summary = re.sub(r"\s+", " ", str(final_text or "")).strip()[:520]
        if not summary:
            return None
        entry = {
            "turn_id": str(turn_id or ""),
            "created_at": datetime.now(timezone.utc).isoformat(),
            "status": str(status or "complete"),
            "asked": re.sub(r"\s+", " ", str(user_message or "")).strip()[:240],
            "swarm_summary": summary,
            "agents": agents,
            "final_report_excerpt": str(final_text or "").strip()[:1800],
        }
        if _verification:
            entry["verification"] = _verification
        return entry
    try:
        pos = _journal_positions(transcript)
        names = [str(p.get("name") or p.get("slug") or "") for p in (participants or []) if p]
        sysp = (
            "Create compact episodic memory for a multi-agent Room. Summarize what the user asked, "
            "what the swarm actually delivered, and one concrete sentence for each agent who contributed. "
            "Preserve important figures, dates, and decisions exactly. Do not invent work or describe generic roles. "
            "asked <= 18 words; swarm_summary <= 45 words; each contribution <= 24 words. Output only the schema."
        )
        usr = (f"ROOM PARTICIPANTS: {', '.join(names)}\nUSER ASKED: {user_message[:500]}\n\n"
               f"FINAL DELIVERABLE:\n{final_text[:1800]}{pos}")
        out = await _evo_groq([{"role": "system", "content": sysp}, {"role": "user", "content": usr}],
                              model=(model or _JOURNAL_MODEL), schema=_JOURNAL_SCHEMA)
        data = json.loads(out or "{}")
        known = {name for name in names if name}
        agents = []
        for row in data.get("agents") or []:
            name = str(row.get("name") or "").strip()
            contribution = str(row.get("contribution") or "").strip()
            if name and contribution and (not known or name in known):
                slug = next((str(p.get("slug") or p.get("id") or "") for p in (participants or [])
                             if str(p.get("name") or p.get("slug") or "") == name), "")
                agents.append({"slug": slug, "name": name, "contribution": contribution[:260]})
        # A truthy check alone let a degenerate LLM response ("...", "N/A", a
        # single word) through untouched — confirmed live 2026-08-12: this
        # exact call returned swarm_summary="..." for a "what did we learn"
        # turn, permanently writing a content-free entry that then polluted
        # every later turn's journal context (the compounding failure: once
        # one entry is garbage, the room's own history looks empty even
        # though the write itself "succeeded"). Require a real minimum
        # length — not a content check (too fragile), just enough to reject
        # ellipsis/placeholder-shaped non-answers.
        _summary = str(data.get("swarm_summary") or "").strip()
        if len(_summary) < 15:
            _summary = ""
        entry = {
            "turn_id": str(turn_id or ""),
            "created_at": datetime.now(timezone.utc).isoformat(),
            "status": str(status or "complete"),
            "asked": str(data.get("asked") or user_message).strip()[:240],
            "swarm_summary": (_summary or str(final_text or "")).strip()[:520],
            "agents": agents[:5],
            "final_report_excerpt": str(final_text or "").strip()[:1800],
        }
        if _verification:
            entry["verification"] = _verification
        return entry if len(entry["swarm_summary"]) >= 15 else _fallback()
    except Exception as exc:  # noqa: BLE001
        log.warning("[hyper-engine] journal entry failed (non-fatal): %s", exc)
        return _fallback()


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
                        r = await gateway_post(c, GROQ_URL, headers={"Authorization": f"Bearer {key}"}, json=body)
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
                r = await gateway_post(c, GROQ_URL, headers={"Authorization": f"Bearer {key}"}, json=body)
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
        emit: Callable[[Dict[str, Any]], Awaitable[Any]],
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
        execution_context: str = "",
        intended_output: str = "answer",
        room_kind: str = "",
        room_mode: str = "runtime",
        room_playbook: Optional[List[str]] = None,
        room_journal: Optional[List[Dict[str, Any]]] = None,
        room_instructions: str = "",
        sender_email: str = "",
        out_language: str = "",
        campaign_brief: Optional[Dict[str, Any]] = None,
        room_id: str = "",
        turn_id: str = "",
        direct_answer_hook: Optional[Callable[[str, str], Awaitable[Optional[str]]]] = None,
        agentic_task_hook: Optional[Callable[[str, str], Awaitable[Optional[str]]]] = None,
    ) -> None:
        # Run-wide output language from the FE navbar toggle (locale code/name →
        # language NAME, '' for English). Drives a strict "write in X only" directive.
        self.out_lang = _resolve_language(out_language)
        self.user_message = user_message
        self.user_id = user_id
        self.org_id = org_id
        self.project_id = project_id
        self.room_id = str(room_id or "")
        self.turn_id = str(turn_id or "")
        # Direct-answer via a real tool-using agent, instead of this Director's own
        # tool-less _synthesize() — only exercised for response_depth=="direct" +
        # a plain-answer turn (see run()). None (default) preserves today's
        # behavior completely: every turn's synth is unaffected unless the caller
        # explicitly supplies this hook. Callable(user_message, board_context) ->
        # the agent's answer, or None to fall through to normal synth.
        self.direct_answer_hook = direct_answer_hook
        # Agentic multi-step task engine — a genuinely autonomous ReAct loop
        # (real tool-calling, dynamic tool-group equipping, native plan/
        # subtask decomposition) instead of the fixed plan-once gather→debate
        # →synth pipeline. Only exercised when the planner sets
        # execution_engine=="agentic" (see _plan_gather / run()); None
        # preserves today's behavior completely for every other turn.
        # Callable(user_message, board_context) -> the agent's final answer,
        # or None to fall through to the normal pipeline.
        self.agentic_task_hook = agentic_task_hook
        self.participants = participants
        self.roster = {(p.get("slug") or p.get("id")): p for p in participants}
        self.room_template = room_template or "debate"
        self.room_goal = room_goal or ""
        # Standing org identity (name + what the company does/sells + customers/market),
        # recalled once before the turn. Injected into PLAN + SYNTH so the director grounds
        # queries + the deliverable in THIS company — not a generic industry. '' = no brief.
        self.company_brief = str(company_brief or "")
        # Runtime phase envelopes carry bounded company, evidence, lifecycle, and
        # artifact references. Keep the complete JSON contract parseable.
        self.execution_context = str(execution_context or "")[:64000]
        self.room_phase = self._parse_room_phase_envelope(self.execution_context)
        self.runtime_stage = self._parse_runtime_stage_envelope(self.execution_context)
        self.work_order = (self._parse_work_order_envelope(self.execution_context)
                           or self._work_order_from_room_phase(self.room_phase))
        self.work_room_resume = self._parse_work_room_resume_envelope(self.execution_context)
        # What the turn must DELIVER (answer/decision/email/doc/sheet/notion), derived from the user
        # message BEFORE the run so SYNTH writes the right FORMAT (a ready email, not a generic report).
        self.intended_output = str(intended_output or "answer").strip().lower()
        self.post_output_actions: List[Dict[str, Any]] = []
        self.artifact_intent: Optional[Dict[str, Any]] = None
        self.work_results: List[Dict[str, Any]] = []
        # The persisted room kind is authoritative. Legacy callers without one use
        # the compatibility resolver; active turn intent is still decided by the
        # structured Director below rather than lexical routing.
        self.room_kind = (str(room_kind or "").strip().lower()
                          or resolve_room_kind("", room_goal or "", user_message or ""))
        self.room_mode = str(room_mode or "runtime").strip().lower()
        self.is_work_room = self.room_mode == "work"
        self.domain_pack = get_domain_pack(self.room_kind)
        self.campaign_brief = campaign_brief if isinstance(campaign_brief, dict) else {}
        self.skills_used: List[str] = []
        # Room-type learned lessons ("previously effective: X→Y"), written by the
        # post-turn reflection, primed into the planner catalog block. [] = none yet.
        self.room_playbook: List[str] = [str(x) for x in (room_playbook or []) if str(x).strip()][:6]
        self.room_journal: List[Dict[str, Any]] = [x for x in (room_journal or []) if isinstance(x, dict)][-_JOURNAL_KEEP:]
        self._journal_block = self._room_journal_context()
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
        domain_models = self.domain_pack.models if self.domain_pack else {}
        self.director_model = domain_models.get("director") or director_model or os.environ.get("HYPER_DIRECTOR_MODEL", "openai/gpt-oss-120b")
        self.persona_model = domain_models.get("persona") or persona_model or os.environ.get("HYPER_PERSONA_MODEL", "openai/gpt-oss-120b")
        # Dedicated model for the FINAL deliverable. The gather loop + debate can run
        # on a cheap model (orchestration), but the synthesis is the product — so a
        # strong model writes it. When equal to director_model, no extra call (the
        # loop's own final IS the deliverable). Multi-model "Auto" = cheap gather + strong synth.
        # P4: route ONLY the final-report synth call to a frontier writer via env
        # (HYPER_SYNTH_MODEL). A Cerebras-hosted id (zai-glm-4.7) → _cerebras_chat DIRECT;
        # a namespaced slug (deepseek/…, google/…) → _openrouter_chat direct. Default =
        # director model (gpt-oss-120b) so unset = no behavior change.
        self.synth_model = domain_models.get("synthesis") or synth_model or os.environ.get("HYPER_SYNTH_MODEL") or self.director_model
        self.strict_model_provider = bool(self.domain_pack and self.domain_pack.strict_model_provider)
        # Live public-web search uses Groq's built-in web search (only on the
        # `groq/compound*` systems — gpt-oss can't run it directly). compound-mini is
        # cheaper/faster and fine for in-room gathering; env-tunable.
        self.web_model = os.environ.get("HYPER_WEB_MODEL", "")  # UNUSED: web goes via _web_search → HIVEMIND (no groq)
        self.max_iters = max_iters
        self.debate_max_rounds = max(1, min(3, debate_max_rounds))
        # per-turn state (NOT module globals)
        self.blackboard: List[str] = []
        self._retained_prospect_rows: List[Dict[str, Any]] = []
        self.transcript: List[Dict[str, Any]] = []
        self._debate_disagreement_note: str = ""
        self.tokens = 0
        self.gather_count = 0
        self._round_seq = 0
        self._web_calls = 0
        self._exec_counts: Counter[str] = Counter()
        phase_lifecycle = self.room_phase.get("lifecycle") if isinstance(self.room_phase, dict) else {}
        phase_config = phase_lifecycle.get("execution_config") if isinstance(phase_lifecycle, dict) else {}
        self._runtime_tool_limits = {
            str(name): max(0, int(value))
            for name, value in ((phase_config or {}).get("tool_limits") or {}).items()
            if str(name).strip() and str(value).lstrip("-").isdigit()
        }
        self._runtime_result_limits = {
            str(name): max(1, int(value))
            for name, value in ((phase_config or {}).get("result_limits") or {}).items()
            if str(name).strip() and str(value).isdigit()
        }
        self._work_order_records_created = 0
        self._work_order_successful_tools = 0
        self._outreach_metrics: Dict[str, int] = {
            "prospects_discovered": 0,
            "prospects_persisted": 0,
            "verified_recipients": 0,
        }
        self._web_budget = max(0, int(os.environ.get("HYPER_WEB_BUDGET", "3") or "3"))
        # Connector routes (toggled on the room) registered dynamically at run()
        # start: name -> (bridge, provider, tool), what _exec()/_connector_read()
        # dispatch a planner-named connector_calls entry through.
        self._connector_routes: Dict[str, tuple] = {}
        # Token accounting by pipeline phase (for cost analysis). director = the
        # gpt-oss-120b agentic loop (gather decisions + reading tool results +
        # synthesis — grows as context accumulates); debate = persona sub-calls;
        # web = compound web-search sub-calls. director_iters = per-loop-call totals.
        self.tok_by: Dict[str, int] = {"director": 0, "debate": 0, "web": 0}
        self.model_usage: Dict[str, Dict[str, int]] = {}
        self.director_iters: List[int] = []
        self._last_tok = 0
        # Population-Sim (additional, opt-in). Default off — the main flow is untouched.
        self.sim_mode = str(sim_mode or "off").strip().lower()
        # How many synthetic voices to simulate (FE slider 10-100; 0 → env default). Clamped.
        self.sim_agents = max(10, min(100, int(sim_agents or _SIM_PERSONAS)))
        self._sim_report: Optional[str] = None       # folded into the synthesis when present
        self._sim_payload: Optional[Dict[str, Any]] = None  # emitted to the FE as sim_report
        self._seo_audit_evidence: Optional[Dict[str, Any]] = None
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
        # The planner sets this per turn. It changes how much work the Room does,
        # while keeping one Director and one set of SEO capabilities.
        self.response_depth = "operating"
        self.collaboration_intensity = "deep"
        self.evidence_mode = "standard"
        self.seo_task = "none"

    def _source_evidence_snapshot(self) -> List[str]:
        """Return durable inputs and tool observations, never agent assertions."""
        excluded = ("WORK_RESULT[", "SKILL[")
        evidence = [
            str(item) for item in self.blackboard
            if str(item).strip()
            and not str(item).startswith(excluded)
            and "NOT AUTHORIZED" not in str(item)
        ]
        if self.company_brief.strip():
            evidence.insert(0, "COMPANY CONTEXT[authoritative]: " + self.company_brief[:8000])
        return evidence

    def _synthesis_context(self, source_limit: int) -> str:
        """Expose only factual sources and method guidance to final synthesis.

        Worker prose remains in the visible discussion and durable board, but
        it is not an evidence transport. The final model re-derives its answer
        from the same authoritative inputs instead of copying worker claims.
        """
        sources = "\n".join(self._source_evidence_snapshot())[:source_limit]
        methods = "\n".join(
            str(item) for item in self.blackboard if str(item).startswith("SKILL[")
        )[:4000]
        return (
            "SOURCE EVIDENCE (the only factual authority):\n"
            f"{sources or '(no source evidence was gathered)'}\n\n"
            "METHOD GUIDANCE (instructions only; never evidence):\n"
            f"{methods or '(none)'}\n\n"
            "The team's unverified candidate prose is intentionally omitted. Re-derive the answer from SOURCE EVIDENCE."
        )

    @staticmethod
    def _parse_work_order_envelope(raw: str) -> Optional[Dict[str, Any]]:
        if "hq-work-order.v2" not in str(raw or ""):
            return None
        try:
            parsed = json.loads(raw)
        except (TypeError, ValueError):
            return None
        return parsed if isinstance(parsed, dict) and parsed.get("contract") == "hq-work-order.v2" else None

    @staticmethod
    def _parse_work_room_resume_envelope(raw: str) -> Optional[Dict[str, Any]]:
        """Recognize a control-plane resume envelope without turning it into HQ work.

        The envelope identifies an already-persisted human Work Room step. It is
        transport metadata only: the Director executes the stored step once and
        does not re-plan the user's original request or create Runtime work.
        """
        if "work-room-resume.v1" not in str(raw or ""):
            return None
        try:
            parsed = json.loads(raw)
        except (TypeError, ValueError):
            return None
        if not isinstance(parsed, dict) or parsed.get("contract") != "work-room-resume.v1":
            return None
        step = parsed.get("step")
        if not isinstance(step, dict) or not str(parsed.get("work_order_id") or "").strip():
            return None
        return parsed

    @staticmethod
    def _parse_runtime_stage_envelope(raw: str) -> Optional[Dict[str, Any]]:
        if "runtime-stage.v1" not in str(raw or ""):
            return None
        try:
            parsed = json.loads(raw)
        except (TypeError, ValueError):
            return None
        return parsed if isinstance(parsed, dict) and parsed.get("contract") == "runtime-stage.v1" else None

    @staticmethod
    def _parse_room_phase_envelope(raw: str) -> Optional[Dict[str, Any]]:
        if "room-phase.v1" not in str(raw or "") and "room-phase.v2" not in str(raw or ""):
            return None
        try:
            parsed = json.loads(raw)
        except (TypeError, ValueError):
            return None
        return parsed if isinstance(parsed, dict) and parsed.get("contract") in {"room-phase.v1", "room-phase.v2"} else None

    @staticmethod
    def _work_order_from_room_phase(phase: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        """Run a coarse Runtime phase through the Room's proven Director pipeline.

        The playbook controls the outer lifecycle. Inside this envelope the Room
        owns decomposition, methods, skills, and tools exactly as it does for a
        human request. This compatibility view is private to the Room executor.
        """
        if not isinstance(phase, dict):
            return None
        is_v2 = phase.get("contract") == "room-phase.v2"
        context = phase.get("context") if isinstance(phase.get("context"), dict) else {}
        lifecycle = phase.get("lifecycle") if isinstance(phase.get("lifecycle"), dict) else {}
        inputs = (context.get("prior_artifacts") if is_v2 else phase.get("inputs"))
        inputs = inputs if isinstance(inputs, dict) else {}
        target = context.get("target") if isinstance(context.get("target"), dict) else {}
        if not target:
            target = inputs.get("context.target") if isinstance(inputs.get("context.target"), dict) else {}
        constraints = context.get("request") if isinstance(context.get("request"), dict) else {}
        if not constraints:
            constraints = inputs.get("context.constraints") if isinstance(inputs.get("context.constraints"), dict) else {}
        authority = lifecycle.get("authority") if is_v2 else phase.get("authority")
        authority = authority if isinstance(authority, dict) else {}
        expected = lifecycle.get("expected_artifacts") if is_v2 else phase.get("expected_artifacts")
        expected = [str(value) for value in (expected or [])]
        execution_config = lifecycle.get("execution_config") if isinstance(lifecycle.get("execution_config"), dict) else {}
        phase_guidance = str(lifecycle.get("guidance") or phase.get("objective") or "").strip()
        return {
            "contract": "hq-work-order.v2",
            "work_order_id": f"room-phase:{phase.get('run_id')}:{phase.get('phase_id')}",
            # The original instruction remains available in constraints/context,
            # but the Director must execute the current checkpoint instead of
            # re-planning the whole request at every phase.
            "objective": phase_guidance or str(phase.get("instruction") or "Complete the assigned Runtime phase."),
            "location": target.get("location") or target.get("geography"),
            "target": target,
            "completion_requirements": [],
            "upstream_result": None,
            "room_checkpoint": None,
            "authority": {
                "mode": "EXECUTE" if authority.get("external_writes") is True else "PREPARE",
                "external_writes": authority.get("external_writes") is True,
            },
            "selected_skills": [str(value) for value in (execution_config.get("required_skills") or []) if str(value).strip()],
            "required_evidence": ["Use the supplied company, baseline, prior artifacts, and exact targets only when relevant to the instruction."],
            "acceptance_criteria": [
                "Complete the natural instruction using the Room Director's normal skills and tools.",
                "Return only real persisted artifacts that match the private lifecycle return contract.",
                "Return exact unresolved gaps instead of presenting unfinished work as complete.",
            ],
            "evidence_refs": [],
            "constraints": constraints,
            "runtime_support": {
                "company": context.get("company"),
                "baseline": context.get("baseline"),
                "admin_current_status": context.get("admin_current_status"),
                "lifecycle_catalog": context.get("lifecycle_catalog"),
                "prior_artifacts": inputs,
                "phase_guidance": phase_guidance,
                "expected_artifacts": expected,
                "completion_checks": lifecycle.get("completion_checks") if is_v2 else phase.get("completion_checks"),
                # Core DERIVES these from the very predicates it will run, so the Room is
                # never told one shape in prose while a check demands another. They were
                # being generated and then dropped here — the Room only ever saw the prose
                # objective, never the machine contract. That is how `channel_mix` came back
                # as JSON null five attempts in a row.
                "artifact_requirements": lifecycle.get("artifact_requirements") if is_v2 else None,
                "artifact_schemas": lifecycle.get("artifact_schemas") if is_v2 else None,
                "strict_response_schema": lifecycle.get("strict_response_schema") if is_v2 else None,
                # REPAIR FEEDBACK. Core already ships the exact predicates that rejected
                # the previous attempt in `unmet`, but nothing here ever read it — so a
                # retry received the identical instruction and failed identically. That is
                # why form_strategy failed the same predicate on every attempt until its
                # objective was hand-edited. Surface the unmet checks (and the attempt
                # number) so the phase can correct the specific field instead of redoing
                # the whole turn blind.
                "unmet_checks": [row for row in (lifecycle.get("unmet") or phase.get("unmet") or []) if row],
                "attempt": lifecycle.get("attempt") if is_v2 else None,
                # The rejected draft ITSELF, not just the verdict. Core now ships it under
                # `prior_attempt.<key>`; naming it separately makes the carry-forward
                # explicit rather than something the model has to notice among the inputs.
                "prior_attempt_draft": {
                    key[len("prior_attempt."):]: value
                    for key, value in (inputs or {}).items()
                    if isinstance(key, str) and key.startswith("prior_attempt.")
                } if isinstance(inputs, dict) else {},
                "repair_instruction": (
                    "A previous attempt was REJECTED by these exact checks. `prior_attempt_draft` "
                    "is YOUR OWN previous draft. Copy every populated field of it forward verbatim "
                    "unless you are actively improving that field, then fix precisely what the "
                    "unmet checks name and return the COMPLETE artifact again. Do not restart the "
                    "investigation. Returning fewer populated fields than your previous draft is a "
                    "failed retry even if the prose is better."
                    if (lifecycle.get("unmet") or phase.get("unmet")) else None
                ),
                "execution_config": lifecycle.get("execution_config") if is_v2 else {},
            },
        }

    # ── LLM ───────────────────────────────────────────────────────────
    def _record_model_usage(self, model: Any, usage: Dict[str, Any], bucket: str) -> int:
        prompt = int(usage.get("prompt_tokens", 0) or 0)
        completion = int(usage.get("completion_tokens", 0) or 0)
        total = int(usage.get("total_tokens", 0) or (prompt + completion))
        cached = int(((usage.get("prompt_tokens_details") or {}).get("cached_tokens", 0)) or 0)
        self.tokens += total
        self.tok_by[bucket] = self.tok_by.get(bucket, 0) + total
        self._last_tok = total
        self.io["input"] += prompt
        self.io["output"] += completion
        self.io["cached"] += cached
        key = str(model or "unknown")[:128]
        row = self.model_usage.setdefault(key, {
            "model": key, "total_tokens": 0, "prompt_tokens": 0,
            "completion_tokens": 0, "cached_tokens": 0, "requests": 0,
        })
        row["total_tokens"] += total
        row["prompt_tokens"] += prompt
        row["completion_tokens"] += completion
        row["cached_tokens"] += cached
        row["requests"] += 1
        return total

    async def _groq(
        self, messages: List[Dict[str, Any]], *, tools: Optional[List[Dict[str, Any]]] = None,
        model: Optional[str] = None, temp: float = 0.4, force_text: bool = False,
        bucket: str = "director", schema: Optional[Dict[str, Any]] = None,
        schema_name: str = "gather_plan",
        uncapped: bool = False, json_object: bool = False,
        max_tokens: Optional[int] = None,
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
        if max_tokens is not None:
            body["max_tokens"] = max(1, int(max_tokens))
        if tools and not force_text:
            body["tools"] = tools
            body["tool_choice"] = "auto"
        elif schema is not None:
            # Structured output (the gather PLAN): a JSON-schema response, NOT native
            # tool-calling — sidesteps the gpt-oss harmony tool-call glitch entirely.
            body["response_format"] = {"type": "json_schema",
                                       "json_schema": {"name": schema_name, "schema": schema, "strict": True}}
        elif json_object:
            body["response_format"] = {"type": "json_object"}
        if _needs_reasoning_disabled(body["model"]):
            body["reasoning"] = {"enabled": False}
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
        if bucket == "synth" and not uncapped and "max_tokens" not in body:
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
        cerebras_direct = _route_cerebras_direct(body.get("model"))
        if self.strict_model_provider and not cerebras_direct:
            log.error(
                "[hyper-engine] strict provider route unavailable model=%s room_kind=%s",
                body.get("model"), self.room_kind,
            )
            return None
        if cerebras_direct:
            _ck = f"hyper:{self.org_id or 'x'}:{getattr(self, 'project_id', None) or 'x'}:{bucket}"
            j = await _cerebras_chat(body, timeout=httpx.Timeout(_to, connect=5.0), cache_key=_ck)
            if j is not None:
                u = j.get("usage") or {}
                self._record_model_usage(body.get("model"), u, bucket)
                return (j.get("choices") or [{}])[0].get("message") or None
            if self.strict_model_provider:
                log.error("[hyper-engine] strict provider unavailable model=%s room_kind=%s", body.get("model"), self.room_kind)
                return None
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
            if j is None:
                _fallback = _fallback_model_for(body.get("model"))
                if _fallback:
                    log.warning("[hyper-engine] experimental model %s unavailable — falling back to %s",
                                body.get("model"), _fallback)
                    body["model"] = _fallback
                    body.pop("reasoning", None)  # the fallback model doesn't need/want this override
                    j = await _openrouter_chat(body, timeout=httpx.Timeout(_to, connect=5.0))
            if j is not None:
                u = j.get("usage") or {}
                self._record_model_usage(body.get("model"), u, bucket)
                return (j.get("choices") or [{}])[0].get("message") or None
            return None
        max_attempts = 3
        _nudged = False
        for attempt in range(max_attempts):
            try:
                async with httpx.AsyncClient(timeout=httpx.Timeout(max(45.0, _to), connect=5.0)) as c:
                    r = await gateway_post(c, GROQ_URL, headers={"Authorization": f"Bearer {key}"}, json=body)
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
                self._record_model_usage(body.get("model"), u, bucket)
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
            self._record_model_usage(body.get("model"), u, bucket)
            return j["choices"][0]["message"]
        return None

    async def _init_connector_tools(self) -> None:
        """Register the room's toggled connectors as READ-only director tools —
        builds self._connector_routes, the name -> (bridge, provider, real_tool)
        map _exec()/_connector_read() dispatch through (the planner names a tool
        by string in its plan JSON; this is what makes that string executable).
        Google connectors use a curated read surface; other Nango/MCP connectors
        are discovered via the bridge inspect (best-effort, only tools with a
        real input schema). Capped + read-only — writes stay with the
        centralized producer + HITL. Never raises.

        Note: this does NOT build an OpenAI-function-schema tool list — Director
        never does native tool-calling for connectors (that's AgentScope's job,
        for the lead's own real tool-using agent — see agentscope_tools.py's
        _register_connector_tools, sourced from the SAME get_room_enabled_
        connectors() call as this one, so both paths already see identical
        connector data). A `self._connector_tools` schema list used to be built
        here too; removed 2026-08-12 — confirmed via a whole-repo grep that
        nothing ever read it, only self._connector_routes."""
        routes: Dict[str, tuple] = {}
        seen: set = set()

        def _add(tname: str, tdesc: str, props: Dict[str, Any], req: List[str], bridge: str, provider: str, real_tool: str) -> None:
            if tname in seen or len(routes) >= _CONNECTOR_TOOL_CAP:
                return
            seen.add(tname)
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
            if len(routes) >= _CONNECTOR_TOOL_CAP:
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
                if count >= _MCP_TOOLS_PER_CONNECTOR or len(routes) >= _CONNECTOR_TOOL_CAP:
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
        self._connector_routes = routes
        if routes:
            log.info("[hyper-engine] connector tools registered: %s", list(routes.keys()))

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
        limit = self._runtime_tool_limits.get(str(name))
        if limit is not None and self._exec_counts[str(name)] >= limit:
            return json.dumps({"error": f"{name} call limit reached for this lifecycle phase.",
                               "limit": limit, "is_error": True})
        self._exec_counts[str(name)] += 1
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
                if self.room_kind == "campaign":
                    facts = [f for f in facts if self._campaign_recall_fact_is_grounded(f)]
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

            if name == "seo_audit":
                return await self._seo_audit(str(args.get("url", "")), int(args.get("page_limit", 25) or 25))

            if name == "places_search":
                return await self._places_search(str(args.get("query", "")))

            if name == "debate":
                return await self._debate(str(args.get("topic", "")), int(args.get("rounds", self.debate_max_rounds) or self.debate_max_rounds))

            if name == "load_skill":
                return _SKILLS.get(str(args.get("skill_name", "")),
                                   "unknown skill — choose one of: " + ", ".join(_SKILLS.keys()))

            if name == "load_room_history":
                return await self._load_room_history(int(args.get("turns_back", 20) or 20))

            return json.dumps({"error": f"unknown tool {name}"})
        except Exception as exc:  # noqa: BLE001 — surface as a tool error so the director adapts
            log.warning("[hyper-engine] tool %s failed: %s", name, exc)
            return json.dumps({"error": str(exc)[:200], "is_error": True})

    async def _browser_search_fallback(self, content: str, key: str) -> str:
        """gpt-oss browser_search retry — used when the deep compound web call returns empty content.
        Exa-powered interactive browse, reliably returns its result inline. '' on failure; never raises."""
        try:
            # Groq's browser_search tool is provider-specific and has no Nitro
            # equivalent. Keep this emergency web-only path isolated from the
            # canonical HyperAgent text-model policy.
            body = {"model": "openai/gpt-oss-20b", "messages": [{"role": "user", "content": content}],
                    "tools": [{"type": "browser_search"}], "tool_choice": "required",
                    "temperature": 1, "top_p": 1, "max_completion_tokens": 4096, "reasoning_effort": "low"}
            async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=5.0)) as c:
                r = await gateway_post(c, GROQ_URL, headers={"Authorization": f"Bearer {key}"}, json=body)
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
            target = ((self.work_order or {}).get("target") or {}) if self.work_order else {}
            result_limit = self._runtime_result_limits.get("places_search", 20)
            requested_count = max(1, min(20, result_limit, int(target.get("quantity") or result_limit)))
            body = {"textQuery": query, "maxResultCount": requested_count}
            headers = {"Content-Type": "application/json", "X-Goog-Api-Key": key,
                       "X-Goog-FieldMask": "places.id,places.googleMapsUri,places.displayName,places.internationalPhoneNumber,"
                                           "places.websiteUri,places.formattedAddress,places.primaryTypeDisplayName,"
                                           "places.businessStatus,places.rating,places.userRatingCount"}
            async with httpx.AsyncClient(timeout=httpx.Timeout(25.0, connect=5.0)) as c:
                r = await c.post("https://places.googleapis.com/v1/places:searchText",
                                 headers=headers, json=body)
            if r.status_code != 200:
                return json.dumps({"error": f"places {r.status_code}: {r.text[:160]}", "is_error": True})
            places = (r.json() or {}).get("places") or []
        except Exception as exc:  # noqa: BLE001
            log.warning("[hyper-engine] places_search failed: %s", exc)
            return json.dumps({"error": str(exc)[:200], "is_error": True})
        requirements = [
            row for row in ((self.work_order or {}).get("completion_requirements") or [])
            if isinstance(row, dict)
        ]
        needs_verified_recipient = any(
            str(row.get("type") or "") == "email_drafts" and int(row.get("minimum") or 0) > 0
            for row in requirements
        )
        # A requested output count is not a candidate-search limit. When the
        # active Room contract also requires personalized drafts, inspect a
        # bounded candidate pool and prefer rows with a verified public contact.
        # This preserves the requested output count without accepting the first
        # uncontactable Places result and then abandoning the same Room phase.
        candidate_limit = min(20, max(requested_count, 10 if needs_verified_recipient else requested_count))
        rows = []
        for pl in places[:candidate_limit]:
            rows.append({
                "company": (pl.get("displayName") or {}).get("text", ""),
                "place_id": pl.get("id", ""),
                "source_url": pl.get("googleMapsUri", ""),
                "phone": pl.get("internationalPhoneNumber", ""),
                "website": pl.get("websiteUri", ""),
                "address": pl.get("formattedAddress", ""),
                "category": (pl.get("primaryTypeDisplayName") or {}).get("text", ""),
                "business_status": pl.get("businessStatus", ""),
                "rating": pl.get("rating"),
                "review_count": pl.get("userRatingCount"),
            })
        rows = [x for x in rows if x["company"]]
        # Impressum/contact enrichment — for firms with a website, fetch the
        # legally-mandated Impressum/Kontakt page and attach a real email (named
        # person preferred). Concurrent + bounded; a failure just leaves email "".
        await self._enrich_impressum(rows)
        await self._qualify_prospect_rows(rows, query)
        if needs_verified_recipient:
            rows.sort(key=lambda row: (not bool(str(row.get("email") or "").strip()),))
        rows = rows[:requested_count]
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
        # Every sourced prospect belongs in the shared lead book, including rows that
        # still need contact enrichment. This keeps discovery, qualification, Rooms,
        # and Your Leads on one tenant-scoped source of truth.
        discovered = rows[:requested_count]
        persisted_count = 0
        if discovered:
            payload = [{**x,
                        "note": (f"Discovered for “{query[:80]}”. {x.get('fit_reason') or ''} "
                                 f"Recommended angle: {x.get('outreach_angle') or 'validate need before outreach.'}"),
                        "source": "places-discovery"} for x in discovered]
            persisted = await save_prospects_bulk_emulated(
                prospects=payload, user_id=self.user_id, org_id=self.org_id,
                turn_id=self.turn_id,
            )
            persisted_count = int(persisted.get("persisted") or 0) if isinstance(persisted, dict) else 0
            persisted_rows = persisted.get("records") if isinstance(persisted, dict) else []
            persisted_by_company = {
                str(item.get("company") or "").strip().casefold(): str(
                    item.get("record_id") or item.get("memory_id") or item.get("lead_id") or ""
                ).strip()
                for item in (persisted_rows or []) if isinstance(item, dict)
            }
            for item in discovered:
                memory_id = persisted_by_company.get(str(item.get("company") or "").strip().casefold())
                if memory_id:
                    item["memory_id"] = memory_id
        self._outreach_metrics["prospects_discovered"] += len(discovered)
        self._outreach_metrics["prospects_persisted"] += persisted_count
        self._outreach_metrics["verified_recipients"] += sum(
            1 for item in discovered if str(item.get("email") or "").strip()
        )
        log.info("[hyper-engine] places_search '%s' → %d firms, %d with email (%d saved to lead book)",
                 query[:60], len(rows), sum(1 for x in rows if x.get('email')), persisted_count)
        return json.dumps({"found": len(rows), "prospects": rows,
                           "persisted": persisted_count,
                           "note": (
                               "Contactable leads saved to the shared lead book — use list_prospects to reuse them."
                               if persisted_count else
                               "Prospects were returned, but lead-book persistence did not complete."
                           )})

    async def _qualify_prospect_rows(self, rows: List[Dict[str, Any]], query: str) -> None:
        """Attach source-derived qualification without inventing prospect facts."""
        for row in rows:
            reachable = bool(row.get("email") or row.get("phone") or row.get("website"))
            category = str(row.get("category") or "organization").strip()
            address = str(row.get("address") or "the target market").strip()
            row["fit_reason"] = (
                f"Google Places classifies {row['company']} as {category} at {address}, "
                f"which directly matches the requested “{query}” segment."
            )[:500]
            rating = row.get("rating"); reviews = row.get("review_count")
            listing_signal = (f"Its active listing has a {rating}/5 rating across {reviews} review(s)"
                              if rating is not None and reviews is not None
                              else "Its active Google Places listing is source-verified")
            contact_signal = ("and provides a direct contact route."
                              if reachable else "but its contact route still needs enrichment.")
            row["distinctive_signal"] = f"{listing_signal} {contact_signal}"[:400]
            row["outreach_angle"] = (
                f"Open with {row['company']}'s verified {category} presence in {address}. "
                f"Ask how its team currently handles the workflow relevant to the requested {query} segment, "
                "and validate the need before presenting an offer."
            )[:500]

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
                mailto = re.findall(r'''href=["']mailto:([^"'?\s]+)''', r.text, flags=re.I)
                raw = [*mailto, *self._EMAIL_RE.findall(r.text)]
                cands = []
                for email in raw:
                    email = email.strip().strip(".,;:()[]<>")
                    domain = email.rsplit("@", 1)[-1]
                    tld = domain.rsplit(".", 1)[-1]
                    # Minified pages can concatenate the next label to a plain
                    # text address (for example `.deVerantwortlich`). Explicit
                    # mailto links win; fallback domains must remain lowercase
                    # with a plausible DNS suffix.
                    if (self._EMAIL_BAD.search(email.lower()) or domain != domain.lower()
                            or not 2 <= len(tld) <= 13):
                        continue
                    if email not in cands:
                        cands.append(email)
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
        prospect = self.evidence_mode == "prospecting"
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

    async def _seo_audit(self, url: str, page_limit: int = 25) -> str:
        """Place deterministic website evidence on the SEO Room board."""
        target = (url or "").strip()
        if not target:
            return json.dumps({"error": "website URL is required", "is_error": True})
        async def emit_capability_stage(stage: Dict[str, Any]) -> None:
            await self.emit({
                "t": "seo_capability_stage",
                "capability": "seo.site-intelligence@1.0.0",
                "stage": stage.get("stage"),
                "status": stage.get("status"),
                "details": {key: value for key, value in stage.items() if key not in {"stage", "status", "at"}},
            })

        result = await seo_audit_emulated(
            target, user_id=self.user_id, org_id=self.org_id,
            page_limit=max(1, min(page_limit, 50)), timeout_s=180.0,
            on_progress=emit_capability_stage,
        )
        if result.get("error") or result.get("status") == "failed":
            return json.dumps({"error": result.get("error") or "seo audit failed", "is_error": True})
        audit = ((result.get("results") or [{}])[0]) if isinstance(result.get("results"), list) else {}
        if not isinstance(audit, dict) or audit.get("schema") != "seo-audit-v1":
            return json.dumps({"error": "SEO audit returned no structured evidence", "is_error": True})
        self._seo_audit_evidence = audit
        # Put compact deterministic evidence first so the bounded synthesis board
        # cannot lose it behind recall chatter. Full evidence remains in the web job.
        board_audit = {key: audit.get(key) for key in (
            "schema", "seed_url", "scanned_at", "score", "coverage", "severity",
        )}
        capability = audit.get("capability") or {}
        board_audit["capability"] = {key: capability.get(key) for key in (
            "schema", "id", "version", "artifact_id", "worker_class",
        )}
        # Page-level answers are the common direct-query path. Keep their exact
        # DOM values ahead of bulky template/site-file metadata so the direct
        # synthesis context cannot truncate the evidence it was asked for.
        page_keys = (
            "url", "status", "title", "description", "canonical", "word_count", "template",
            "internal_inlinks", "orphan_candidate", "issue_count",
        )
        board_audit["pages"] = [
            {key: page.get(key) for key in page_keys if key in page}
            for page in (audit.get("pages") or [])[:8]
            if isinstance(page, dict)
        ]
        finding_keys = (
            "id", "category", "severity", "title", "description", "url", "template",
            "instances", "evidence", "recommendation",
        )
        board_audit["findings"] = [
            {key: finding.get(key) for key in finding_keys if key in finding}
            for finding in (audit.get("findings") or [])[:8]
            if isinstance(finding, dict)
        ]
        board_audit.update({key: audit.get(key) for key in (
            "evidence_quality", "maturity", "categories", "templates", "architecture",
            "site_files", "crawl_errors", "limitations",
        )})
        board_audit["optimization_procedure"] = [
            {key: phase.get(key) for key in (
                "order", "status", "id", "phase", "objective", "verification",
            ) if key in phase}
            for phase in (audit.get("optimization_procedure") or [])
            if isinstance(phase, dict)
        ]
        search_console = audit.get("search_console") or {}
        board_audit["search_console"] = {
            key: search_console.get(key) for key in (
                "schema", "capability", "status", "connected", "site_url", "permission_level",
                "fetched_at", "data_state", "periods", "totals", "limitations",
            )
        }
        board_audit["search_console"]["opportunities"] = (search_console.get("opportunities") or [])[:20]
        board_audit["search_console"]["queries"] = (search_console.get("queries") or [])[:20]
        board_audit["search_console"]["query_pages"] = (search_console.get("query_pages") or [])[:20]
        board_audit["search_console"]["pages"] = (search_console.get("pages") or [])[:20]
        board_audit["search_console"]["daily"] = (search_console.get("daily") or [])[-35:]
        self.blackboard.insert(0, "SEO_AUDIT_EVIDENCE:\n" + json.dumps(board_audit, ensure_ascii=False))
        self.gather_count += 1
        await self.emit({
            "t": "seo_audit",
            "url": audit.get("seed_url"),
            "score": audit.get("score"),
            "pages": (audit.get("coverage") or {}).get("pages_scanned", 0),
            "discovered": (audit.get("coverage") or {}).get("pages_discovered", 0),
            "capability": (audit.get("capability") or {}).get("id"),
            "capability_version": (audit.get("capability") or {}).get("version"),
            "artifact_id": (audit.get("capability") or {}).get("artifact_id"),
            "critical": (audit.get("severity") or {}).get("critical", 0),
            "high": (audit.get("severity") or {}).get("high", 0),
            "search_console_status": (audit.get("search_console") or {}).get("status", "not_connected"),
            "search_opportunities": len((audit.get("search_console") or {}).get("opportunities") or []),
        })
        return json.dumps(board_audit, ensure_ascii=False)

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
        campaign_contract = ""
        if self.room_kind == "campaign":
            from .campaign_contract import campaign_system_contract
            campaign_contract = campaign_system_contract(self._campaign_allowed_urls())
        domain_guard = ""
        if self.room_kind == "seo":
            domain_guard = (
                " SEO EVIDENCE FIREWALL: discuss only the active SEO task. "
                "SEO_AUDIT_EVIDENCE is authoritative for current website state. Company context may establish "
                "the product and audience, but ignore recalled prospects, contacts, outreach, campaigns, and "
                "unrelated legal work. Do not invent issue types, rankings, traffic, volume, lift, or numeric "
                "targets absent from the board."
            )
        _messages = [
            {"role": "system", "content": (
                _now_block() +
                f"You are {name}, a {lane} on this team.{bias} {sysp}{evo_block}{self._room_instr_block}"
                f"\nRespond IN CHARACTER, CONCISELY "
                f"(3-5 sentences), grounded ONLY in the CONTEXT. If you disagree, challenge with specifics; "
                f"mark anything unverifiable as UNVERIFIED; never invent facts.{skill_line}{need_line}{domain_guard}"
                f"{campaign_contract}")},
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

    def _work_order_owner(self, lane: str) -> Dict[str, Any]:
        """Resolve a planned lane to an actual Room participant, never an invented agent."""
        wanted = str(lane or "").strip().lower()
        aliases = {"researcher": "investigator", "investigator": "researcher"}
        for participant in self.participants:
            actual = str(participant.get("_lane") or participant.get("lane") or "").lower()
            if actual == wanted or aliases.get(actual) == wanted or aliases.get(wanted) == actual:
                return participant
        return (self.participants or [{}])[0]

    def _work_order_context(self, required_evidence: List[str]) -> str:
        """Give a worker only a compact evidence slice, never the raw tool transcript."""
        needles = [str(item).lower() for item in required_evidence if str(item).strip()]
        selected = []
        for item in self.blackboard:
            text = str(item)
            if not needles or any(needle in text.lower() for needle in needles):
                selected.append(text[:900])
        if not selected:
            selected = [str(item)[:700] for item in self.blackboard[-6:]]
        return "\n\n".join(selected[-7:])[:5000]

    def _prospect_count(self) -> int:
        return sum(1 for row in self.blackboard if "PROSPECT:" in str(row))

    async def _prefetch_runtime_prospects(self) -> None:
        """Load reusable CRM records when the versioned Room phase requests reuse-first execution."""
        phase = self.room_phase if isinstance(self.room_phase, dict) else {}
        lifecycle = phase.get("lifecycle") if isinstance(phase.get("lifecycle"), dict) else {}
        config = lifecycle.get("execution_config") if isinstance(lifecycle.get("execution_config"), dict) else {}
        if self.room_kind != "outreach" or config.get("reuse_existing_records") is not True:
            return
        context = phase.get("context") if isinstance(phase.get("context"), dict) else {}
        target = context.get("target") if isinstance(context.get("target"), dict) else {}
        query = str(target.get("location") or target.get("sector") or "").strip()
        payload = await list_prospects_emulated(
            user_id=self.user_id, org_id=self.org_id, query=query, limit=100,
        )
        rows = [row for row in (payload.get("records") or []) if isinstance(row, dict)]
        self._retained_prospect_rows = [
            row for row in rows
            if str(row.get("company") or "").strip()
            and str(row.get("fit_reason") or "").strip()
            and str(row.get("outreach_angle") or "").strip()
            and (row.get("source_url") or row.get("website"))
        ]
        for row in self._retained_prospect_rows:
            self.blackboard.append(
                f"- RETAINED PROSPECT: {row.get('company')} | contact {row.get('email') or '—'} "
                f"| {row.get('phone') or '—'} | {row.get('website') or '—'} | {row.get('address') or '—'} "
                f"| fit {row.get('fit_reason')} | angle {row.get('outreach_angle')}"
            )
        await self.emit({
            "t": "gather", "sources": ["your-leads"], "tool": "list_prospects",
            "query": query or "accepted leads", "connector_hits": ["list_prospects"],
            "memory_hits": len(self._retained_prospect_rows),
        })

    async def _compose_outreach_email(
        self, record: Dict[str, Any], sender_company: str,
    ) -> Dict[str, Any]:
        """Use the canonical per-prospect Outreach Intelligence composer."""
        from ..api_outreach import GenerateRequest, _Prospect, generate

        return await generate(GenerateRequest(
            channel="email",
            turn_id=self.turn_id,
            sender_email=self.sender_email,
            sender_company=sender_company,
            company_context=self.company_brief[:6000],
            user_id=self.user_id,
            org_id=self.org_id,
            prospect=_Prospect(
                lead_id=str(record.get("memory_id") or "") or None,
                company=str(record.get("company") or ""),
                email=str(record.get("email") or "") or None,
                phone=str(record.get("phone") or "") or None,
                website=str(record.get("website") or "") or None,
                address=str(record.get("address") or "") or None,
                source_url=str(record.get("source_url") or record.get("website") or "") or None,
                fit_reason=str(record.get("fit_reason") or "") or None,
                outreach_angle=str(record.get("outreach_angle") or "") or None,
                notes=str(record.get("note") or record.get("notes") or "") or None,
            ),
        ))

    async def _compose_outreach_call(
        self, record: Dict[str, Any], sender_company: str,
    ) -> Dict[str, Any]:
        """Use the same call planner as the human START OUTREACH CALLS action."""
        from ..api_outreach import GenerateRequest, _Prospect, generate

        return await generate(GenerateRequest(
            channel="call",
            turn_id=self.turn_id,
            sender_email=self.sender_email,
            sender_company=sender_company,
            company_context=self.company_brief[:6000],
            user_id=self.user_id,
            org_id=self.org_id,
            prospect=_Prospect(
                lead_id=str(record.get("memory_id") or "") or None,
                company=str(record.get("company") or record.get("prospect") or ""),
                email=str(record.get("email") or "") or None,
                phone=str(record.get("phone") or "") or None,
                website=str(record.get("website") or "") or None,
                address=str(record.get("address") or "") or None,
                source_url=str(record.get("source_url") or record.get("website") or "") or None,
                fit_reason=str(record.get("fit_reason") or "") or None,
                outreach_angle=str(record.get("outreach_angle") or "") or None,
                notes=str(record.get("note") or record.get("notes") or "") or None,
            ),
        ))

    @staticmethod
    def _tool_result_succeeded(output: str) -> bool:
        text = str(output or "").strip()
        if not text:
            return False
        try:
            parsed = json.loads(text)
        except (TypeError, ValueError):
            return True
        return not (isinstance(parsed, dict) and (parsed.get("error") or parsed.get("is_error") is True))

    async def _run_work_order_subtasks(self, plan: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Execute a Room Director plan under the HQ machine-result contract."""
        envelope = self.work_order or {}
        upstream = envelope.get("upstream_result") if isinstance(envelope.get("upstream_result"), dict) else {}
        upstream_records = [*self._retained_prospect_rows, *[
            record
            for artifact in (upstream.get("deliverables") or []) if isinstance(artifact, dict)
            and artifact.get("kind") == "prospect_records"
            for record in (artifact.get("records") or []) if isinstance(record, dict)
        ]]
        requirements = [
            requirement for requirement in (envelope.get("completion_requirements") or [])
            if isinstance(requirement, dict)
        ]
        envelope_criteria = [str(x) for x in (envelope.get("acceptance_criteria") or []) if str(x).strip()][:8]
        # A keystone STRATEGY assignment needs more than four method rungs: the ladder is
        # diagnosis → wedge → positioning → offer → channels → motions → measures, and a
        # rung is not guessable without the one above it. Capping strategy work at 4 was
        # part of why the artifact churned instead of converging.
        expects_strategy = any(
            "strategy" in str(key).lower()
            for key in (envelope.get("expected_artifacts") or [])
        ) or "keystone" in str(envelope.get("objective") or "").lower()
        skill_budget = 7 if expects_strategy else 4
        declared_skills = [str(x) for x in (envelope.get("selected_skills") or []) if str(x).strip()]
        planned_skills = [str(x) for x in (plan.get("method_skills") or []) if str(x).strip()]
        selected_skills = list(dict.fromkeys([*declared_skills, *planned_skills]))[:skill_budget]
        # HQ Outreach work progressively loads one lifecycle skill around the
        # Director's own selected methods. It describes checkpoint semantics but
        # never prescribes a fixed tool sequence or replaces Room planning.
        if self.room_kind == "outreach" and "outreach-operating-loop" not in selected_skills:
            selected_skills = [*selected_skills, "outreach-operating-loop"][:skill_budget]
        # Same shape for strategy: pin the lifecycle skill that enforces the MONOTONIC
        # rule (carry every already-good field forward, spend the retry only on unmet
        # ones). Without it each attempt rewrote the artifact from scratch and regressed —
        # attempt 2 produced a full channel_mix, attempt 3 dropped it again.
        if expects_strategy and "strategy-operating-loop" not in selected_skills:
            selected_skills = ["strategy-operating-loop", *selected_skills][:skill_budget]
        # The normal Room Director owns decomposition, method selection, and tool
        # selection. HQ changes only the audience and result contract. A bounded
        # HQ assignment is one machine subtask, even if the human-facing planner
        # proposed a larger programme.
        orders = [row for row in (plan.get("work_orders") or []) if isinstance(row, dict)][:1]
        if not orders:
            orders = [{
                "kind": "analysis", "owner_lane": "Strategist", "title": str(envelope.get("objective") or "HQ work order")[:180],
                "objective": str(envelope.get("objective") or self.user_message)[:600],
                "required_evidence": list(envelope.get("required_evidence") or [])[:4],
                "acceptance_criteria": list(envelope.get("acceptance_criteria") or [])[:4],
            }]
        covered = {str(x) for row in orders for x in (row.get("acceptance_criteria") or [])}
        missing = [criterion for criterion in envelope_criteria if criterion not in covered]
        if missing:
            orders[-1]["acceptance_criteria"] = [
                *list(orders[-1].get("acceptance_criteria") or []), *missing,
            ][:8]
        for skill in selected_skills:
            body = load_method_skill(skill)
            if body:
                self.skills_used.append(skill)
                self.blackboard.append(f"SKILL[{skill}]:\n{body[:5000]}")
                await self.emit({"t": "skill_used", "skill": skill, "agent": "director", "room_kind": self.room_kind})

        planned_calls: List[Dict[str, str]] = []
        for query in (plan.get("recall_queries") or [])[:3]:
            planned_calls.append({"name": "recall", "args_json": json.dumps(
                {"query": str(query), "max": 6}, ensure_ascii=False)})
        for call in (plan.get("connector_calls") or [])[:4]:
            if not (isinstance(call, dict) and str(call.get("name") or "") in self._connector_routes):
                continue
            planned_calls.append({
                "name": str(call["name"]),
                "args_json": json.dumps(dict(call.get("args") or {}), ensure_ascii=False),
            })
        if plan.get("web_query"):
            planned_calls.append({"name": "web_search", "args_json": json.dumps({"query": str(plan["web_query"])}, ensure_ascii=False)})
        if plan.get("seo_audit_url"):
            planned_calls.append({"name": "seo_audit", "args_json": json.dumps({
                "url": str(plan["seo_audit_url"]),
                "page_limit": int(plan.get("seo_audit_page_limit") or 25),
            }, ensure_ascii=False)})
        if plan.get("places_query"):
            planned_calls.append({"name": "places_search", "args_json": json.dumps({"query": str(plan["places_query"])}, ensure_ascii=False)})
        if self.room_kind == "campaign" and not self._allows_places_discovery():
            planned_calls = [call for call in planned_calls if call.get("name") != "places_search"]
            plan["places_query"] = None
        phase_lifecycle = self.room_phase.get("lifecycle") if isinstance((self.room_phase or {}).get("lifecycle"), dict) else {}
        phase_expected = {
            str(value) for value in (phase_lifecycle.get("expected_artifacts") or [])
        }
        outreach = dict(plan.get("outreach_request")) if isinstance(plan.get("outreach_request"), dict) else {}
        if self.room_kind == "outreach" and self.room_phase:
            target = (self.work_order or {}).get("target") if isinstance((self.work_order or {}).get("target"), dict) else {}
            phase_context = self.room_phase.get("context") if isinstance(self.room_phase.get("context"), dict) else {}
            prior_phase_artifacts = phase_context.get("prior_artifacts") if isinstance(phase_context.get("prior_artifacts"), dict) else {}
            retained_stage_leads = prior_phase_artifacts.get("prior_attempt_all.lead_record")
            retained_stage_leads = retained_stage_leads if isinstance(retained_stage_leads, list) else []
            # The phase declares outcomes, not a fixed tool sequence. Preserve
            # the Director's approach while preventing omitted Room work and
            # model-invented quotas.
            outreach["discover"] = not retained_stage_leads and (outreach.get("discover") is True or "lead_record" in phase_expected)
            outreach["persist"] = not retained_stage_leads and (outreach.get("persist") is True or "lead_record" in phase_expected)
            outreach["draft"] = outreach.get("draft") is True or "message_record" in phase_expected
            outreach["requested_count"] = target.get("quantity")
            outreach["geography"] = outreach.get("geography") or target.get("location") or target.get("geography")
            outreach["sector"] = outreach.get("sector") or target.get("sector")
            outreach["audience"] = outreach.get("audience") or target.get("audience")
            contactable_retained = sum(1 for row in self._retained_prospect_rows if str(row.get("email") or "").strip())
            requested_count = outreach.get("requested_count")
            if retained_stage_leads or (isinstance(requested_count, int) and requested_count > 0 and contactable_retained >= requested_count):
                planned_calls = [call for call in planned_calls if call.get("name") != "places_search"]
                plan["places_query"] = None
        prospect_work = bool(outreach.get("discover") or outreach.get("persist") or plan.get("places_query"))
        # The immutable phase contract is authoritative even when the Director's
        # semantic plan omitted an internal checkpoint. This does not prescribe
        # a tool sequence: it tells the Outreach Room to keep operating until its
        # declared deliverable exists.
        draft_work = "message_record" in phase_expected or bool(outreach.get("draft")) or any(
            str(row.get("type") or "") == "email_drafts" and int(row.get("minimum") or 0) > 0
            for row in requirements
        )
        call_brief_work = "call_brief" in phase_expected
        call_analysis_work = "call_analysis" in phase_expected
        if prospect_work and not plan.get("places_query") and not any(
            str(call.get("name") or "") == "places_search"
            for call in planned_calls if isinstance(call, dict)
        ):
            queries = await self._compose_places_queries()
            for query in queries[:3]:
                planned_calls.append({"name": "places_search", "args_json": json.dumps({"query": query}, ensure_ascii=False)})
        action = {
            "tool_calls": planned_calls,
            "requires_tool": bool(planned_calls),
            "requires_records": prospect_work or bool(plan.get("places_query")),
            "output_kind": "rows" if prospect_work or plan.get("places_query") else "analysis",
        }

        results: List[Dict[str, Any]] = []
        for index, order in enumerate(orders):
            subtask_id = f"subtask_{index + 1}"
            owner = self._work_order_owner(str(order.get("owner_lane") or "Strategist"))
            owner_name, lane, persona = _persona_fields(owner)
            await self.emit({"t": "work_order", "id": subtask_id, "status": "running",
                             "title": order.get("title"), "agent": owner.get("slug"), "name": owner_name})
            before_counts = Counter(self._exec_counts)
            before_records = self._prospect_count()
            tool_outputs: List[Dict[str, Any]] = []
            grounded_artifacts: List[Dict[str, Any]] = []
            persisted_records = 0
            successful_tools: Counter[str] = Counter()
            for call in (action.get("tool_calls") or []):
                name = str(call.get("name") or "")
                if name not in {"recall", "org_directory", "web_search", "places_search", "seo_audit", "load_skill", *self._connector_routes.keys()}:
                    continue
                try:
                    args = json.loads(str(call.get("args_json") or "{}"))
                except (TypeError, ValueError):
                    args = {}
                if not isinstance(args, dict):
                    args = {}
                if name == "places_search":
                    location = str(envelope.get("location") or "").strip()
                    query = str(args.get("query") or "").strip()
                    location_name = location.split(",", 1)[0].strip().casefold()
                    if location and location_name not in query.casefold():
                        args["query"] = f"{query} in {location}".strip()
                await self._emit_tool_start(name, args)
                output = await self._exec(name, args)
                succeeded = self._tool_result_succeeded(output)
                if succeeded:
                    successful_tools[name] += 1
                    if name == "places_search":
                        try:
                            payload = json.loads(str(output))
                        except (TypeError, ValueError):
                            payload = {}
                        records = payload.get("prospects") if isinstance(payload, dict) else None
                        if isinstance(records, list) and records:
                            persisted_records += int(payload.get("persisted") or 0)
                            grounded_artifacts.append({
                                "kind": "prospect_records",
                                "source": "google_places",
                                "query": str(args.get("query") or ""),
                                "records": records,
                                "record_count": len(records),
                                "persisted_count": int(payload.get("persisted") or 0),
                            })
                tool_outputs.append({"name": name, "succeeded": succeeded, "output": str(output)[:5000]})
            current_records = [
                record
                for artifact in grounded_artifacts if artifact.get("kind") == "prospect_records"
                for record in (artifact.get("records") or []) if isinstance(record, dict)
            ]
            worker_record_index: Dict[str, Dict[str, Any]] = {}
            for record in [*upstream_records, *current_records]:
                company = str(record.get("company") or "").strip()
                if company:
                    worker_record_index[company.casefold()] = record
            worker_records = list(worker_record_index.values())
            # A Runtime assignment may intentionally reuse a qualified result from
            # an earlier Room checkpoint instead of paying for discovery again.
            # When the Director selects the persist phase, reconcile every complete
            # source-backed record through the same tenant Leads boundary used by
            # Places discovery. Governance must see durable IDs, not model prose.
            persisted_companies = {
                str(record.get("company") or "").strip().casefold()
                for record in worker_records if str(record.get("memory_id") or "").strip()
            }
            # The Places boundary also returns an aggregate provider receipt. Keep
            # compatibility with older receipts that predate per-record memory IDs.
            if persisted_records and not persisted_companies:
                persisted_companies.update(
                    str(record.get("company") or "").strip().casefold()
                    for record in current_records[:persisted_records]
                    if str(record.get("company") or "").strip()
                )
            if outreach.get("persist") and worker_records:
                pending_records = [
                    record for record in worker_records
                    if str(record.get("company") or "").strip().casefold() not in persisted_companies
                    and str(record.get("company") or "").strip()
                    and str(record.get("fit_reason") or "").strip()
                    and str(record.get("outreach_angle") or "").strip()
                    and (record.get("source_url") or record.get("place_id") or record.get("website"))
                ]
                if pending_records:
                    await self.emit({
                        "t": "typing", "agent": owner.get("slug"),
                        "note": "Saving qualified records to Your Leads…",
                    })
                    persisted = await save_prospects_bulk_emulated(
                        prospects=[{
                            **record,
                            "source": str(record.get("source") or "room-intelligence"),
                            "note": str(record.get("note") or (
                                f"Qualified for this Room assignment. "
                                f"{record.get('fit_reason') or ''} Recommended angle: "
                                f"{record.get('outreach_angle') or ''}"
                            )),
                        } for record in pending_records],
                        user_id=self.user_id,
                        org_id=self.org_id,
                        turn_id=self.turn_id,
                    )
                    persisted_rows = persisted.get("records") if isinstance(persisted, dict) else []
                    persisted_by_company = {
                        str(row.get("company") or "").strip().casefold(): str(
                            row.get("record_id") or row.get("memory_id") or row.get("lead_id") or ""
                        ).strip()
                        for row in (persisted_rows or []) if isinstance(row, dict)
                    }
                    for record in worker_records:
                        company_key = str(record.get("company") or "").strip().casefold()
                        memory_id = persisted_by_company.get(company_key)
                        if memory_id:
                            record["memory_id"] = memory_id
                            persisted_companies.add(company_key)
                    if persisted_by_company:
                        successful_tools["leads_persist"] += 1
                        await self.emit({
                            "t": "gather", "sources": ["your-leads"], "tool": "leads_persist",
                            "query": str(order.get("title") or "")[:160],
                            "connector_hits": ["leads_persist"], "memory_hits": len(persisted_by_company),
                        })
            persisted_records = max(persisted_records, len(persisted_companies))
            if worker_records:
                grounded_artifacts = [
                    artifact for artifact in grounded_artifacts
                    if artifact.get("kind") != "prospect_records"
                ]
                grounded_artifacts.insert(0, {
                    "kind": "prospect_records",
                    "source": "room_intelligence",
                    "records": worker_records,
                    "record_count": len(worker_records),
                    "persisted_count": len(persisted_companies),
                })
                current_records = worker_records
            context = self._work_order_context(list(order.get("required_evidence") or []))
            prior = "\n\n".join(str(row.get("output", {}).get("text") or "") for row in results)[-4000:]
            prompt = (
                f"WORK ORDER SUBTASK: {order.get('title')}\nOBJECTIVE: {order.get('objective')}\n"
                f"ACCEPTANCE CRITERIA:\n" + "\n".join(f"- {x}" for x in (order.get("acceptance_criteria") or [])) +
                "\nProduce the actual bounded work product. Cite only supplied evidence. State concrete gaps; "
                "never describe future work as completed. Return useful detail, not process narration."
            )
            generated_email_drafts: List[Dict[str, str]] = []
            generated_call_briefs: List[Dict[str, Any]] = []
            generated_call_analyses: List[Dict[str, Any]] = []
            if draft_work:
                # Runtime uses the same per-prospect Outreach Intelligence composer
                # as the human-facing Email Campaign action. HQ never authors copy:
                # it supplies the lifecycle envelope, while this Room applies the
                # cold-email and polished-email skills to each retained lead.
                company_match = re.search(
                    r"(?:^|\n)Company:\s*([^\n—–]+)", self.company_brief or "", re.I,
                )
                sender_company = (company_match.group(1).strip(" .,-") if company_match else "")
                verified_records = [
                    record for record in worker_records
                    if str(record.get("company") or "").strip()
                    and str(record.get("email") or "").strip()
                ]
                phase_context = self.room_phase.get("context") if isinstance((self.room_phase or {}).get("context"), dict) else {}
                phase_request = phase_context.get("request") if isinstance(phase_context.get("request"), dict) else {}
                supplied_inputs = phase_context.get("supplied_inputs") if isinstance(phase_context.get("supplied_inputs"), dict) else {}
                prior_phase_artifacts = phase_context.get("prior_artifacts") if isinstance(phase_context.get("prior_artifacts"), dict) else {}
                exact_recipients = list(dict.fromkeys(
                    str(row.get("value") or "").strip().casefold()
                    for row in (phase_request.get("exact_targets") or [])
                    if isinstance(row, dict)
                    and str(row.get("type") or "").strip().casefold() == "email"
                    and str(row.get("value") or "").strip()
                ))
                supplied_email = str(supplied_inputs.get("verified_email") or "").strip().casefold()
                if supplied_email and _EMAIL_RE.fullmatch(supplied_email):
                    exact_recipients.append(supplied_email)
                for artifact in (prior_phase_artifacts.get("artifacts.call_brief") or []):
                    data = artifact.get("data") if isinstance(artifact, dict) and isinstance(artifact.get("data"), dict) else {}
                    retained_email = str(data.get("verified_email") or "").strip().casefold()
                    if retained_email and _EMAIL_RE.fullmatch(retained_email):
                        exact_recipients.append(retained_email)
                exact_recipients = list(dict.fromkeys(exact_recipients))
                # Exact addresses are capability data, not lifecycle routing.
                # Retain them from the natural instruction when an upstream
                # semantic interpreter omitted the optional exact_targets field.
                if not exact_recipients:
                    exact_recipients = list(dict.fromkeys(
                        match.casefold() for match in re.findall(
                            r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b",
                            str((self.room_phase or {}).get("instruction") or self.user_message),
                            re.I,
                        )
                    ))
                if not verified_records and exact_recipients:
                    response = await self._groq([
                        {"role": "system", "content": (
                            _now_block()
                            + "You are the Outreach Room's message composer. Return one JSON object with "
                              "email_drafts, an array containing exactly one object per supplied recipient. "
                              "Each object has to, subject, and body. Follow the natural instruction and "
                              "company evidence. Do not claim delivery, invent attachments, or add placeholders."
                        )},
                        {"role": "user", "content": json.dumps({
                            "instruction": str((self.room_phase or {}).get("instruction") or self.user_message),
                            "recipients": exact_recipients,
                            "company_context": self.company_brief[:8000],
                            "supporting_context": (self.work_order or {}).get("runtime_support") or {},
                        }, ensure_ascii=False, default=str)[:24000]},
                    ], model=self.persona_model, temp=0.2, bucket="worker", force_text=True,
                       schema={
                           "type": "object",
                           "properties": {
                               "email_drafts": {
                                   "type": "array",
                                   "items": {
                                       "type": "object",
                                       "properties": {
                                           "to": {"type": "string"},
                                           "subject": {"type": "string"},
                                           "body": {"type": "string"},
                                       },
                                       "required": ["to", "subject", "body"],
                                       "additionalProperties": False,
                                   },
                               },
                           },
                           "required": ["email_drafts"],
                           "additionalProperties": False,
                       }, max_tokens=1600)
                    direct_payload = _first_json_object(str((response or {}).get("content") or "")) or {}
                    for draft in (direct_payload.get("email_drafts") or []):
                        if not isinstance(draft, dict):
                            continue
                        recipient = str(draft.get("to") or "").strip().casefold()
                        subject = str(draft.get("subject") or "").strip()
                        body = str(draft.get("body") or "").strip()
                        if recipient not in exact_recipients or not subject or not body:
                            continue
                        generated_email_drafts.append({
                            "to": recipient,
                            "subject": subject[:500],
                            "body": body[:6000],
                            "rationale": "Prepared for the exact recipient in the Runtime instruction.",
                            "source_url": "runtime-request:exact-recipient",
                        })
                for record in verified_records:
                    await self.emit({
                        "t": "typing", "agent": owner.get("slug"),
                        "note": f"Writing a personalized email for {str(record.get('company'))[:120]}…",
                    })
                    try:
                        generated = await self._compose_outreach_email(record, sender_company)
                    except Exception as exc:  # noqa: BLE001 — one failed prospect must not discard the batch
                        log.warning("[hyper-engine] outreach email compose failed for %s: %s",
                                    record.get("company"), exc)
                        continue
                    if generated.get("error") or not generated.get("subject") or not generated.get("body"):
                        continue
                    generated_email_drafts.append({
                        "prospect_company": str(record.get("company") or "").strip(),
                        "to": str(record.get("email") or "").strip().casefold(),
                        "subject": str(generated.get("subject") or "").strip()[:500],
                        "body": str(generated.get("body") or "").strip()[:6000],
                        "rationale": str(record.get("outreach_angle") or record.get("fit_reason") or "").strip()[:1000],
                        "source_url": str(record.get("source_url") or record.get("website") or "")[:1000],
                    })
                if generated_email_drafts:
                    successful_tools["outreach_email_compose"] += len(generated_email_drafts)
                    await self.emit({
                        "t": "gather", "sources": ["your-leads", "company-memory"],
                        "tool": "outreach_email_compose",
                        "query": str(order.get("title") or "")[:160],
                        "connector_hits": [], "memory_hits": len(generated_email_drafts),
                    })
                text = json.dumps({"email_drafts": generated_email_drafts}, ensure_ascii=False)
            elif call_brief_work:
                phase_context = self.room_phase.get("context") if isinstance((self.room_phase or {}).get("context"), dict) else {}
                phase_request = phase_context.get("request") if isinstance(phase_context.get("request"), dict) else {}
                instruction = str((self.room_phase or {}).get("instruction") or self.user_message)
                exact_targets = [row for row in (phase_request.get("exact_targets") or []) if isinstance(row, dict)]
                supplied_inputs = phase_context.get("supplied_inputs") if isinstance(phase_context.get("supplied_inputs"), dict) else {}
                phones = list(dict.fromkeys(
                    re.sub(r"[\s()/-]", "", str(row.get("value") or "").strip())
                    for row in exact_targets
                    if re.fullmatch(r"\+[1-9]\d{6,14}", re.sub(r"[\s()/-]", "", str(row.get("value") or "").strip()))
                ))
                phones.extend(
                    normalized for normalized in (
                        re.sub(r"[\s()/-]", "", str(value or ""))
                        for value in supplied_inputs.values()
                    ) if re.fullmatch(r"\+[1-9]\d{6,14}", normalized) and normalized not in phones
                )
                if not phones:
                    phones = list(dict.fromkeys(
                        re.sub(r"[\s()/-]", "", match)
                        for match in re.findall(r"\+[1-9][\d\s()/-]{6,20}", instruction)
                        if re.fullmatch(r"\+[1-9]\d{6,14}", re.sub(r"[\s()/-]", "", match))
                    ))
                labels = {
                    re.sub(r"[\s()/-]", "", str(row.get("value") or "").strip()): str(row.get("label") or "").strip()
                    for row in exact_targets if isinstance(row, dict)
                }
                company_match = re.search(
                    r"(?:^|\n)Company:\s*([^\n—–]+)", self.company_brief or "", re.I,
                )
                sender_company = company_match.group(1).strip(" .,-") if company_match else "Our company"
                retained_by_phone = {
                    re.sub(r"[\s()/-]", "", str(row.get("phone") or "")): row
                    for row in self._retained_prospect_rows if str(row.get("phone") or "").strip()
                }
                for phone in phones:
                    retained = retained_by_phone.get(phone) or {}
                    prospect = {
                        **retained,
                        "company": retained.get("company") or labels.get(phone) or phone,
                        "phone": phone,
                        "notes": "\n".join(filter(None, [str(retained.get("notes") or "").strip(), instruction])).strip(),
                    }
                    brief = await self._compose_outreach_call(prospect, sender_company)
                    if brief.get("error") or not str(brief.get("goal") or "").strip():
                        continue
                    generated_call_briefs.append({
                        "phone": phone,
                        "prospect": str(prospect.get("company") or phone).strip()[:300],
                        "goal": str(brief.get("goal") or "").strip()[:300],
                        "opener": str(brief.get("opener") or "").strip()[:400],
                        "context": str(brief.get("context") or "").strip()[:800],
                        "language": str(brief.get("language") or "en").strip()[:8],
                        "strategy": str(brief.get("strategy") or "").strip()[:200],
                        "voice_style": str(brief.get("voice_style") or "").strip()[:40],
                        "personal_notes": str(prospect.get("notes") or "").strip()[:800],
                        "lead_ref": str(prospect.get("id") or prospect.get("lead_id") or "").strip() or None,
                        "verified_email": str(prospect.get("email") or "").strip() or None,
                        "instruction": instruction[:5000],
                        "source_ref": "runtime-request:exact-phone",
                    })
                if generated_call_briefs:
                    successful_tools["outreach_call_compose"] += len(generated_call_briefs)
                    grounded_artifacts.append({
                        "kind": "call_briefs", "source": "room_worker",
                        "record_count": len(generated_call_briefs), "records": generated_call_briefs,
                    })
                    await self.emit({
                        "t": "gather", "sources": ["your-leads", "company-memory"],
                        "tool": "outreach_call_compose", "query": str(order.get("title") or "")[:160],
                        "connector_hits": [], "memory_hits": len(generated_call_briefs),
                    })
                text = json.dumps({"call_briefs": generated_call_briefs}, ensure_ascii=False)
            elif call_analysis_work:
                phase_context = self.room_phase.get("context") if isinstance((self.room_phase or {}).get("context"), dict) else {}
                prior_artifacts = phase_context.get("prior_artifacts") if isinstance(phase_context.get("prior_artifacts"), dict) else {}
                call_event = prior_artifacts.get("event") if isinstance(prior_artifacts.get("event"), dict) else {}
                call_event_data = call_event.get("data") if isinstance(call_event.get("data"), dict) else call_event
                transcript_ref = str(call_event_data.get("transcript_ref") or call_event_data.get("call_id") or call_event_data.get("correlation_ref") or "").strip()
                exact_call = await get_tara_call_emulated(
                    reference=transcript_ref,
                    user_id=self.user_id,
                    org_id=self.org_id,
                ) if transcript_ref else {"found": False}
                exact_call_ref = str((exact_call or {}).get("call", {}).get("id") or "").strip()
                exact_insight_ref = str((exact_call or {}).get("insight", {}).get("id") or "").strip()
                response = await self._groq([
                    {"role": "system", "content": (
                        _now_block()
                        + "You are the responsible Company Room reviewing a completed TARA call. Return JSON only with call_analyses. "
                          "Use only the supplied provider event, transcript summary, insight, and retained call context. Each analysis "
                          "must contain terminal_state (call_completed or call_failed), summary, outcome, sentiment, objections, "
                          "tara_learnings, lead_notes, safe_generalized_learning, and a structured next_action. Read the exact turns, "
                          "not just the callback summary. If the recipient requests a written summary, next_action.action_type must be "
                          "send_summary and requires_authority must be true. Do not claim a meeting, lead, or success unless the provider evidence says so."
                    )},
                    {"role": "user", "content": json.dumps({
                        "instruction": str((self.room_phase or {}).get("instruction") or self.user_message),
                        "company_context": self.company_brief[:6000],
                        "provider_event": call_event,
                        "exact_call": exact_call,
                        "prior_artifacts": prior_artifacts,
                    }, ensure_ascii=False, default=str)[:28000]},
                ], model=self.persona_model, temp=0.15, bucket="worker", force_text=True,
                   schema={
                       "type": "object", "properties": {"call_analyses": {"type": "array", "items": {
                           "type": "object", "properties": {
                               "terminal_state": {"type": "string", "enum": ["call_completed", "call_failed"]},
                               "summary": {"type": "string"}, "outcome": {"type": "string"},
                               "sentiment": {"type": "string"}, "objections": {"type": "array", "items": {"type": "string"}},
                               "tara_learnings": {"type": "array", "items": {"type": "string"}},
                               "lead_notes": {"type": "string"},
                               "safe_generalized_learning": {"type": "array", "items": {"type": "string"}},
                               "next_action": {"type": "object", "properties": {
                                   "action_type": {"type": "string"}, "reason": {"type": "string"},
                                   "requires_authority": {"type": "boolean"}, "requires_information": {"type": "boolean"},
                                   "requested_information": {"type": "array", "items": {"type": "string"}},
                               }, "required": ["action_type", "reason", "requires_authority", "requires_information", "requested_information"], "additionalProperties": False},
                           },
                           "required": ["terminal_state", "summary", "outcome", "sentiment", "objections", "tara_learnings", "lead_notes", "safe_generalized_learning", "next_action"],
                           "additionalProperties": False,
                       }}}, "required": ["call_analyses"], "additionalProperties": False,
                   }, max_tokens=1400)
                parsed = _first_json_object(str((response or {}).get("content") or "")) or {}
                generated_call_analyses = [row for row in (parsed.get("call_analyses") or []) if isinstance(row, dict)][:20]
                call_brief_inputs = prior_artifacts.get("artifacts.call_brief")
                call_brief_inputs = call_brief_inputs if isinstance(call_brief_inputs, list) else []
                has_verified_email = any(
                    str((brief.get("data") if isinstance(brief.get("data"), dict) else brief).get("verified_email") or "").strip()
                    for brief in call_brief_inputs if isinstance(brief, dict)
                )
                for analysis in generated_call_analyses:
                    next_action = analysis.get("next_action") if isinstance(analysis.get("next_action"), dict) else {}
                    if str(next_action.get("action_type") or "").strip() == "send_summary" and not has_verified_email:
                        next_action["requires_information"] = True
                        requested = [str(value).strip() for value in (next_action.get("requested_information") or []) if str(value).strip()]
                        next_action["requested_information"] = list(dict.fromkeys([*requested, "verified_email"]))
                        analysis["next_action"] = next_action
                if generated_call_analyses:
                    analysis_source_refs = [
                        str(call_event.get("id") or call_event.get("event_id") or "tara-call-event"),
                        f"tara-call:{exact_call_ref}" if exact_call_ref else "",
                        f"tara-insight:{exact_insight_ref}" if exact_insight_ref else "",
                    ]
                    grounded_artifacts.append({
                        "kind": "call_analyses", "source": "room_worker",
                        "record_count": len(generated_call_analyses), "records": generated_call_analyses,
                        "source_refs": list(dict.fromkeys(filter(None, analysis_source_refs))),
                    })
                text = json.dumps({"call_analyses": generated_call_analyses}, ensure_ascii=False)
            else:
                response = await self._groq([
                    {"role": "system", "content": _now_block() + f"You are {owner_name}, {lane}. {persona}"},
                    {"role": "user", "content": f"{prompt}\n\nVERIFIED RECORDS FOR THIS WORK PRODUCT:\n{json.dumps(worker_records, ensure_ascii=False)[:20000]}\n\nPRIOR SUBTASK OUTPUT:\n{prior}\n\nTOOL RESULTS:\n{json.dumps(tool_outputs, ensure_ascii=False)}\n\nEVIDENCE BOARD:\n{context}"},
                ], model=self.persona_model, temp=0.25, bucket="worker", force_text=True,
                   max_tokens=1200)
                text = _strip_cot(str((response or {}).get("content") or "")).strip()
            tool_attempts = sum(self._exec_counts.values()) - sum(before_counts.values())
            tool_delta = sum(successful_tools.values())
            self._work_order_successful_tools += tool_delta
            prospect_artifacts = [
                artifact for artifact in grounded_artifacts
                if artifact.get("kind") == "prospect_records"
            ]
            artifact_records = sum(int(artifact.get("record_count") or 0)
                                   for artifact in prospect_artifacts)
            # Structured Places artifacts are the authoritative record boundary.
            # Blackboard text may contain web/recall lines with "PROSPECT:" and
            # must never inflate the persistence denominator.
            records_delta = (artifact_records if prospect_artifacts
                             else max(0, self._prospect_count() - before_records))
            self._work_order_records_created += records_delta
            checks: List[Dict[str, Any]] = []
            criteria = list(order.get("acceptance_criteria") or []) or list(envelope.get("acceptance_criteria") or [])
            exact_records = current_records
            email_drafts: List[Dict[str, str]] = []
            if draft_work and text:
                parsed_drafts = _first_json_object(text) or {}
                draft_sources = worker_records
                source_by_company = {
                    str(record.get("company") or "").strip().casefold(): record
                    for record in draft_sources if str(record.get("company") or "").strip()
                }
                for draft in generated_email_drafts:
                    supplied_to = str(draft.get("to") or "").strip().casefold()
                    subject = str(draft.get("subject") or "").strip()
                    body = str(draft.get("body") or "").strip()
                    signature = re.search(
                        r"\n(?:best regards|kind regards|regards|sincerely|thank you|thanks|mit freundlichen gr(?:ü|u)ßen)[,\s]*\n",
                        body, re.I,
                    )
                    if signature:
                        body = body[:signature.start()].rstrip()
                    if (not str(draft.get("prospect_company") or "").strip()
                            and supplied_to in exact_recipients and subject and body):
                        email_drafts.append({
                            "prospect_company": "",
                            "to": supplied_to,
                            "subject": subject[:500],
                            "body": body[:6000],
                            "rationale": str(draft.get("rationale") or "").strip()[:1000],
                            "source_url": "runtime-request:exact-recipient",
                        })
                def accept_draft(draft: Any) -> Optional[Dict[str, str]]:
                    if not isinstance(draft, dict):
                        return None
                    company = str(draft.get("prospect_company") or "").strip()
                    source = source_by_company.get(company.casefold())
                    verified_to = str((source or {}).get("email") or "").strip().casefold()
                    supplied_to = str(draft.get("to") or "").strip().casefold()
                    subject = str(draft.get("subject") or "").strip()
                    body = str(draft.get("body") or "").strip()
                    signature = re.search(
                        r"\n(?:best regards|kind regards|regards|sincerely|thank you|thanks|mit freundlichen gr(?:ü|u)ßen)[,\s]*\n",
                        body, re.I)
                    if signature:
                        body = body[:signature.start()].rstrip()
                    direct_recipient = supplied_to in exact_recipients
                    if ((not direct_recipient and (not source or not verified_to or supplied_to != verified_to))
                            or not subject or not body):
                        return None
                    if re.search(r"\[[^\]]+\]|<[^>]+>|\{\{[^}]+\}\}", subject + "\n" + body):
                        return None
                    # Sender identity is attached by the authenticated mailbox.
                    # A Room must not invent an employee name/address in the copy.
                    if re.search(r"\bguarantee(?:d|s|ing)?\b", body, re.I):
                        return None
                    return {
                        "prospect_company": company,
                        "to": supplied_to if direct_recipient else verified_to,
                        "subject": subject[:500], "body": body[:6000],
                        "rationale": str(draft.get("rationale") or "").strip()[:1000],
                        "source_url": (
                            "runtime-request:exact-recipient" if direct_recipient
                            else str((source or {}).get("source_url") or (source or {}).get("website") or "")[:1000]
                        ),
                    }

                for draft in (parsed_drafts.get("email_drafts") or []):
                    accepted_draft = accept_draft(draft)
                    if accepted_draft and not any(
                        row.get("to") == accepted_draft.get("to")
                        and row.get("subject") == accepted_draft.get("subject")
                        for row in email_drafts
                    ):
                        email_drafts.append(accepted_draft)

                if email_drafts:
                    grounded_artifacts.append({
                        "kind": "email_drafts", "source": "room_worker",
                        "record_count": len(email_drafts), "records": email_drafts,
                        "upstream_record_count": len(draft_sources),
                    })
            source_backed = sum(1 for record in exact_records if record.get("place_id") or record.get("source_url"))
            distinct_complete = sum(1 for record in exact_records
                                    if str(record.get("fit_reason") or "").strip()
                                    and str(record.get("outreach_angle") or "").strip())
            unique_angles = len({str(record.get("outreach_angle") or "").strip()
                                 for record in exact_records if str(record.get("outreach_angle") or "").strip()})
            machine_checks: List[Dict[str, Any]] = []
            for requirement in requirements:
                check_type = str(requirement.get("type") or "").strip()
                minimum = max(0, int(requirement.get("minimum") or 0))
                maximum = requirement.get("maximum")
                observed_count = {
                    "records_persisted": persisted_records,
                    "source_evidence": source_backed,
                    "distinct_fields": min(distinct_complete, unique_angles),
                    "evidence_refs": len([row for row in self.blackboard if str(row).strip()]),
                    "deliverables": len(grounded_artifacts) or (1 if text else 0),
                    "email_drafts": len(email_drafts),
                    "external_actions": 0,
                    "delivery_receipts": 0,
                }.get(check_type, 0)
                passed = observed_count >= minimum and (maximum is None or observed_count <= int(maximum))
                machine_checks.append({
                    "criterion": f"machine:{check_type}", "type": check_type,
                    "expected": f"minimum={minimum}" + (f"; maximum={maximum}" if maximum is not None else ""),
                    "observed": f"count={observed_count}", "passed": passed,
                })
            if self.room_kind == "outreach" and outreach:
                from .domains.outreach.governance import lifecycle_checks
                machine_checks.extend(lifecycle_checks(
                    outreach,
                    discovered=records_delta,
                    persisted=persisted_records,
                    drafted=len(email_drafts),
                    proposed_actions=len(self.post_output_actions),
                ))
            invariant_passed = bool(text) and (tool_delta > 0 or bool(email_drafts)) and all(
                check["passed"] for check in machine_checks)
            checks.extend(machine_checks)
            for criterion in criteria:
                checks.append({
                    "criterion": str(criterion), "type": "contract_coverage",
                    "expected": "all deterministic completion requirements passed",
                    "observed": (f"successful_tool_calls={tool_delta}; records_created={records_delta}; "
                                 f"records_persisted={persisted_records}; source_backed={source_backed}; "
                                 f"distinct_fit_and_angle={min(distinct_complete, unique_angles)}"),
                    "passed": invariant_passed,
                })
            if not checks:
                checks.append({"criterion": "Return a concrete evidence-backed result", "type": "tool_used",
                               "expected": "at least one real tool call and non-empty output",
                               "observed": f"successful_tool_calls={tool_delta}; attempted_tool_calls={tool_attempts}; output_chars={len(text)}", "passed": bool(text) and tool_delta > 0})
            failed = [check for check in checks if not check["passed"]]
            gaps = [{"subtask_id": subtask_id, "criterion": check["criterion"],
                     "why": check["observed"], "what_would_unblock": "Run the required capability and return its concrete evidence."}
                    for check in failed]
            status = "completed" if not failed else "blocked" if not text else "partial"
            evidence_refs = sorted({
                *[row[:240] for row in self.blackboard[-12:] if row.strip()],
                *[str(record.get("source_url") or f"google-places:{record.get('place_id')}")
                  for record in exact_records if record.get("source_url") or record.get("place_id")],
            })
            result = {"id": subtask_id, "title": str(order.get("title") or "Work order"),
                      "objective": str(order.get("objective") or ""), "skills": selected_skills,
                      "status": status, "checks": checks, "output": {
                          "kind": action.get("output_kind"), "text": text,
                          "artifacts": grounded_artifacts,
                      },
                      "evidence_refs": evidence_refs, "tool_calls": [
                          {"name": name, "count": count, "succeeded": True}
                          for name, count in successful_tools.items()
                      ], "tool_attempts": [
                          {"name": name, "count": self._exec_counts[name] - before_counts[name]}
                          for name in self._exec_counts if self._exec_counts[name] > before_counts[name]
                      ], "gaps": gaps, "owner": owner_name, "owner_slug": owner.get("slug")}
            results.append(result)
            if text:
                self.blackboard.append(f"WORK_RESULT[{owner_name} | {order.get('title')}]:\n{text}")
            await self.emit({"t": "work_order", "id": subtask_id, "status": status,
                             "title": order.get("title"), "owner": owner_name,
                             "summary": text, "checks": checks, "gaps": gaps})
            if status == "blocked":
                break
        return results

    def _compile_room_phase_result(self, work_order_result: Dict[str, Any]) -> Dict[str, Any]:
        """Compile verified Room deliverables into append-only playbook artifacts."""
        phase = self.room_phase or {}
        lifecycle = phase.get("lifecycle") if isinstance(phase.get("lifecycle"), dict) else {}
        expected = {str(value) for value in (lifecycle.get("expected_artifacts") or phase.get("expected_artifacts") or [])}
        deliverables = [row for row in (work_order_result.get("deliverables") or []) if isinstance(row, dict)]
        if not deliverables:
            # The synthesis wrapper may omit a machine deliverable while
            # shortening its report. Verified subtask artifacts remain the
            # authoritative Room evidence and are safe to compile directly.
            deliverables = [
                artifact
                for result in self.work_results if isinstance(result, dict)
                for artifact in ((result.get("output") or {}).get("artifacts") or [])
                if isinstance(artifact, dict)
            ]
        prospect_records = [
            record for artifact in deliverables if artifact.get("kind") == "prospect_records"
            for record in (artifact.get("records") or []) if isinstance(record, dict)
        ]
        draft_records = [
            record for artifact in deliverables if artifact.get("kind") == "email_drafts"
            for record in (artifact.get("records") or []) if isinstance(record, dict)
        ]
        call_brief_records = [
            record for artifact in deliverables if artifact.get("kind") == "call_briefs"
            for record in (artifact.get("records") or []) if isinstance(record, dict)
        ]
        call_analysis_records = [
            record for artifact in deliverables if artifact.get("kind") == "call_analyses"
            for record in (artifact.get("records") or []) if isinstance(record, dict)
        ]
        drafts_by_company = {
            str(record.get("prospect_company") or "").strip().casefold(): record
            for record in draft_records if str(record.get("prospect_company") or "").strip()
        }
        direct_drafts = [record for record in draft_records if str(record.get("to") or "").strip()]
        context = phase.get("context") if isinstance(phase.get("context"), dict) else {}
        inputs = context.get("prior_artifacts") if isinstance(context.get("prior_artifacts"), dict) else phase.get("inputs")
        inputs = inputs if isinstance(inputs, dict) else {}
        request = context.get("request") if isinstance(context.get("request"), dict) else {}
        constraints = inputs.get("context.constraints") if isinstance(inputs.get("context.constraints"), dict) else {}
        delivery_requested = request.get("external_action_requested") is True or constraints.get("delivery_requested") is True
        artifacts: List[Dict[str, Any]] = []
        lead_by_company: Dict[str, str] = {}

        def artifact_id(key: str, identity: str) -> str:
            material = "\0".join([
                str(phase.get("run_id") or ""), str(phase.get("phase_id") or ""), key, identity,
            ])
            return hashlib.sha256(material.encode()).hexdigest()[:32]

        if "lead_record" in expected:
            for record in prospect_records:
                company = str(record.get("company") or "").strip()
                company_key = company.casefold()
                persistence_ref = str(record.get("memory_id") or "").strip()
                draft = drafts_by_company.get(company_key)
                recipient = str((draft or {}).get("to") or record.get("email") or "").strip()
                # Lead persistence is independently useful evidence. Do not erase
                # a completed lead artifact merely because contact enrichment or
                # message composition is still incomplete; Core will retain it and
                # evaluate the missing message predicate separately.
                if not company or not persistence_ref:
                    continue
                lead_id = artifact_id("lead_record", persistence_ref)
                source_ref = str(record.get("source_url") or record.get("website") or "").strip()
                place_ref = str(record.get("place_id") or "").strip()
                refs = [value for value in [source_ref, f"google-places:{place_ref}" if place_ref else "",
                                            f"tenant-lead:{persistence_ref}"] if value]
                artifacts.append({
                    "id": lead_id,
                    "key": "lead_record",
                    "status": "READY",
                    "data": {
                        "organization_key": company_key,
                        "company": company,
                        "persistence_ref": persistence_ref,
                        "recipient": recipient,
                        "phone": str(record.get("phone") or "").strip(),
                        "website": str(record.get("website") or "").strip(),
                        "address": str(record.get("address") or "").strip(),
                        "fit_rationale": str(record.get("fit_reason") or record.get("fit_rationale") or "").strip(),
                        "outreach_angle": str(record.get("outreach_angle") or "").strip(),
                        "personal_notes": str(record.get("note") or record.get("notes") or "").strip(),
                    },
                    "source_refs": list(dict.fromkeys(refs)),
                    "external_ref": persistence_ref,
                })
                lead_by_company[company_key] = lead_id

        if "message_record" in expected:
            used_draft_ids = set()
            for company_key, draft in drafts_by_company.items():
                lead_ref = lead_by_company.get(company_key)
                recipient = str(draft.get("to") or "").strip()
                subject = str(draft.get("subject") or "").strip()
                body = str(draft.get("body") or "").strip()
                if not lead_ref or not recipient or not subject or not body:
                    continue
                message_id = artifact_id("message_record", lead_ref)
                artifacts.append({
                    "id": message_id,
                    "key": "message_record",
                    "status": "READY",
                    "data": {
                        "lead_ref": lead_ref,
                        "recipient": recipient,
                        "subject": subject,
                        "body": body,
                        "delivery_requested": delivery_requested,
                    },
                    "source_refs": [lead_ref],
                    "external_ref": None,
                })
                used_draft_ids.add(id(draft))
            # Exact-recipient requests do not require artificial prospect
            # discovery. Preserve the Room's real composed draft as a message
            # artifact even when no lead record is part of this lifecycle.
            for draft in direct_drafts:
                if id(draft) in used_draft_ids:
                    continue
                recipient = str(draft.get("to") or "").strip()
                subject = str(draft.get("subject") or "").strip()
                body = str(draft.get("body") or "").strip()
                if not recipient or not subject or not body:
                    continue
                message_id = artifact_id("message_record", recipient.casefold())
                artifacts.append({
                    "id": message_id,
                    "key": "message_record",
                    "status": "READY",
                    "data": {
                        "recipient": recipient,
                        "subject": subject,
                        "body": body,
                        "delivery_requested": delivery_requested,
                    },
                    "source_refs": ["runtime-request:exact-recipient"],
                    "external_ref": None,
                })

        if "call_brief" in expected:
            for record in call_brief_records:
                phone = re.sub(r"[\s()/-]", "", str(record.get("phone") or ""))
                goal = str(record.get("goal") or "").strip()
                if not re.fullmatch(r"\+[1-9]\d{6,14}", phone) or not goal:
                    continue
                call_id = artifact_id("call_brief", phone)
                artifacts.append({
                    "id": call_id,
                    "key": "call_brief",
                    "status": "READY",
                    "data": {
                        "phone": phone,
                        "prospect": str(record.get("prospect") or phone).strip()[:300],
                        "goal": goal[:300],
                        "opener": str(record.get("opener") or "").strip()[:400],
                        "context": str(record.get("context") or "").strip()[:800],
                        "language": str(record.get("language") or "en").strip()[:8],
                        "strategy": str(record.get("strategy") or "").strip()[:200],
                        "voice_style": str(record.get("voice_style") or "").strip()[:40],
                        "personal_notes": str(record.get("personal_notes") or "").strip()[:800],
                        "lead_ref": str(record.get("lead_ref") or "").strip() or None,
                        "verified_email": str(record.get("verified_email") or "").strip() or None,
                        "instruction": str(record.get("instruction") or request.get("instruction") or "").strip()[:5000],
                        "room_turn_id": str(getattr(self, "turn_id", "") or "") or None,
                    },
                    "source_refs": [str(record.get("source_ref") or "runtime-request:exact-phone")],
                    "external_ref": None,
                })

        if "call_analysis" in expected:
            event = inputs.get("event") if isinstance(inputs.get("event"), dict) else {}
            event_ref = str(event.get("id") or event.get("event_id") or "tara-call-event")
            analysis_refs = list(dict.fromkeys(
                str(ref).strip()
                for artifact in deliverables if artifact.get("kind") == "call_analyses"
                for ref in (artifact.get("source_refs") or [])
                if str(ref).strip()
            ))
            for index, record in enumerate(call_analysis_records):
                terminal_state = str(record.get("terminal_state") or "").strip()
                if terminal_state not in {"call_completed", "call_failed"}:
                    continue
                artifacts.append({
                    "id": artifact_id("call_analysis", f"{event_ref}:{index}"),
                    "key": "call_analysis",
                    "status": "READY",
                    "data": {
                        "terminal_state": terminal_state,
                        "summary": str(record.get("summary") or "").strip()[:4000],
                        "outcome": str(record.get("outcome") or "").strip()[:500],
                        "sentiment": str(record.get("sentiment") or "").strip()[:120],
                        "objections": [str(value)[:500] for value in (record.get("objections") or [])[:20]],
                        "tara_learnings": [str(value)[:500] for value in (record.get("tara_learnings") or [])[:20]],
                        "lead_notes": str(record.get("lead_notes") or "").strip()[:2000],
                        "safe_generalized_learning": [str(value)[:500] for value in (record.get("safe_generalized_learning") or [])[:20]],
                        "next_action": record.get("next_action") if isinstance(record.get("next_action"), dict) else {
                            "action_type": "review", "reason": str(record.get("next_action") or "")[:1000],
                            "requires_authority": False, "requires_information": False, "requested_information": [],
                        },
                    },
                    "source_refs": list(dict.fromkeys([event_ref, *analysis_refs])),
                    "external_ref": None,
                })
        gaps = [str((gap or {}).get("why") or (gap or {}).get("criterion") or gap)
                for gap in (work_order_result.get("gaps") or []) if gap]
        produced_keys = {artifact["key"] for artifact in artifacts}
        for key in sorted(expected - produced_keys):
            gaps.append(f"The Room did not return a verified {key} artifact for this phase.")
        return {
            "contract": "room-phase-result.v1",
            "run_id": str(phase.get("run_id") or ""),
            "phase_id": str(phase.get("phase_id") or ""),
            "artifacts": artifacts,
            "gaps": list(dict.fromkeys(value for value in gaps if value)),
            "summary": str(work_order_result.get("report_markdown") or "").strip()[:4000],
            "checkpoint": work_order_result.get("checkpoint") or {},
        }

    async def _synthesize_runtime_stage_result(
        self, supplied_envelope: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Compile one Room turn into the generic artifact contract.

        The model may structure work already present on the evidence board, but
        it cannot create artifact kinds or evidence references outside the
        versioned stage envelope. Core remains the sole predicate evaluator.
        """
        envelope = supplied_envelope or self.runtime_stage or {}
        expected = [str(value) for value in (envelope.get("expected_artifacts") or []) if str(value).strip()]
        evidence: List[Dict[str, str]] = []
        inputs = envelope.get("inputs") if isinstance(envelope.get("inputs"), dict) else {}
        for input_ref, input_value in inputs.items():
            values = input_value if isinstance(input_value, list) else [input_value]
            for index, value in enumerate(values, start=1):
                if value is None:
                    continue
                evidence_id = f"input:{input_ref}:{index}"
                content = json.dumps(value, ensure_ascii=False, default=str)
                evidence.append({"id": evidence_id, "content": content[:5000]})
        for index, value in enumerate(self.blackboard[-30:], start=1):
            text = str(value or "").strip()
            if text:
                evidence.append({"id": f"board:{index}", "content": text[:3000]})
        # Keep the LAST 12 deliverables, plus every earlier one whose text serves a field the
        # contract will be judged on. A required field's material must never be truncated away.
        contract_fields = self._contract_field_names(envelope)
        field_material = self._material_for_fields(contract_fields)
        needed_refs = {hit["work_ref"] for hits in field_material.values() for hit in hits}
        all_rows = [row for row in self.work_results if isinstance(row, dict)]
        tail_start = max(0, len(all_rows) - 12)
        keep = [(position, row) for position, row in enumerate(all_rows, start=1)
                if position > tail_start or f"work:{position}" in needed_refs]
        for index, row in keep:
            output = row.get("output") if isinstance(row.get("output"), dict) else {}
            text = str(output.get("text") or row.get("summary") or "").strip()
            if text:
                evidence.append({"id": f"work:{index}", "content": text[:4000]})
        stage_contract = {key: value for key, value in envelope.items() if key != "inputs"}
        synth_messages = [
            {"role": "system", "content": (
                _now_block() + "Return JSON only for runtime-stage-result.v1. Use exactly these fields: "
                "contract, run_id, stage_id, artifacts, gaps, summary. Each artifact has id, key, status, "
                "data, source_refs, external_ref. key must be one of expected_artifacts. source_refs may only "
                "contain evidence IDs supplied below. Never claim a provider write, persistence, publication, "
                "or completed external action unless the evidence explicitly contains its durable reference. "
                "Treat supplied input artifacts as authoritative evidence. When a completion check compares "
                "output count with an input collection, return one supported output for every relevant input; "
                "preserve its entity identity and cite that input evidence ID. Never substitute or invent an "
                "entity that is absent from the supplied inputs. Analytical fields explicitly requested by the "
                "stage objective are the Room's work product: derive them from the cited input and company "
                "evidence instead of treating their prior absence as a blocker. This never permits inventing a "
                "provider action, contact fact, metric, source, or durable identifier. "
                "If the work is incomplete, return the supported artifacts and exact gaps. Never fabricate a "
                "FACT: no invented metric, source, contact detail, durable identifier, provider action or named "
                "third party. That prohibition covers facts ONLY. A field the stage requires which is a "
                "judgement — positioning, channel mix, offer framing, recommended motions, measures, risks — is "
                "the Room's own work product, and withholding it is a failed turn, not caution. Author it from "
                "the cited evidence and mark a low-confidence call as an assumption to test. A required field "
                "must never come back as null, an empty string, an empty list or an empty object: if you can "
                "reason about it at all, write your best judgement; a gap note is not a substitute for a "
                "required judgement field.")},
            {"role": "user", "content": json.dumps({
                "stage": stage_contract,
                "evidence": evidence,
                "room_work": self.work_results,
                # The Room's own completed work, indexed BY the field it serves, so a
                # deliverable that already answers a required field cannot be overlooked.
                "material_for_required_fields": field_material,
            }, ensure_ascii=False)},
        ]
        # CONSTRAINED DECODING for the contract step. Core derives this schema from the very
        # predicates it will run; a `required` check becomes a NON-NULLABLE typed field, a
        # `preferred` check becomes nullable-but-present. Measured on the live synth model:
        # json_object left the required field null 5/5 times even after the prompt was fixed,
        # while the typed strict schema returned 0 nulls and 0 wrong shapes in 10 runs.
        # `strict_response_schema` is null when strict cannot apply (multi-key stage, or an
        # unregistered artifact key) — then this keeps the original json_object path.
        strict = envelope.get("strict_response_schema") if isinstance(envelope.get("strict_response_schema"), dict) else None
        strict_schema = strict.get("schema") if isinstance(strict, dict) and isinstance(strict.get("schema"), dict) else None
        response = None
        if strict_schema:
            response = await self._groq(
                synth_messages, model=self.synth_model, temp=0.1, bucket="synth", force_text=True,
                schema=strict_schema, schema_name=str(strict.get("name") or "runtime_stage_result"),
                uncapped=True, max_tokens=8000)
        parsed = _first_json_object(str((response or {}).get("content") or "")) or {}
        # The residual failure under strict output is not a null field any more — it is an
        # empty or unparseable ENVELOPE (measured ~2/10, degenerate repetition or a truncated
        # object). Retry ONCE on the unconstrained path rather than returning empty artifacts
        # and letting Core spend a whole extra Room run rediscovering it.
        if not parsed.get("artifacts"):
            if strict_schema:
                log.warning("[hyper-engine] runtime stage %s: strict synth returned no artifact; retrying unconstrained",
                            envelope.get("stage_id"))
            response = await self._groq(synth_messages, model=self.synth_model, temp=0.1, bucket="synth",
                                        force_text=True, json_object=True, uncapped=True, max_tokens=8000)
            parsed = _first_json_object(str((response or {}).get("content") or "")) or parsed
        allowed_refs = {row["id"] for row in evidence}
        artifacts: List[Dict[str, Any]] = []
        seen_ids = set()
        for index, raw in enumerate(parsed.get("artifacts") or []):
            if not isinstance(raw, dict):
                continue
            key = str(raw.get("key") or "").strip()
            data = raw.get("data") if isinstance(raw.get("data"), dict) else {}
            if key not in expected:
                continue
            refs = [str(ref) for ref in (raw.get("source_refs") or []) if str(ref) in allowed_refs]
            material = json.dumps({"run": envelope.get("run_id"), "stage": envelope.get("stage_id"),
                                   "key": key, "index": index, "data": data}, sort_keys=True,
                                  ensure_ascii=False)
            artifact_id = str(raw.get("id") or "").strip() or hashlib.sha256(material.encode()).hexdigest()[:32]
            if artifact_id in seen_ids:
                continue
            seen_ids.add(artifact_id)
            artifacts.append({
                "id": artifact_id,
                "key": key,
                "status": str(raw.get("status") or "READY").strip().upper(),
                "data": data,
                "source_refs": refs,
                "external_ref": (str(raw.get("external_ref")) if raw.get("external_ref") is not None else None),
            })
        # BOUNDED SELF-REPAIR. Core derives `artifact_schemas.<key>.schema.properties.data.required`
        # from the very predicates it is about to run, so the Room can check its OWN output
        # before handing it back. Without this, a single null judgement field cost a whole
        # extra Room run — director + debate + workers + synth, ~18k tokens — to rediscover
        # what was knowable here for one ~6k synth call. Measured: five consecutive attempts
        # rejected on nothing but `data.channel_mix` being JSON null.
        schemas = envelope.get("artifact_schemas") if isinstance(envelope.get("artifact_schemas"), dict) else {}
        def _missing_required(rows: List[Dict[str, Any]]) -> Dict[str, List[str]]:
            out: Dict[str, List[str]] = {}
            for row in rows:
                spec = schemas.get(str(row.get("key") or "")) or {}
                required = (((spec.get("schema") or {}).get("properties") or {}).get("data") or {}).get("required") or []
                payload = row.get("data") if isinstance(row.get("data"), dict) else {}
                blank = [f for f in required if payload.get(f) in (None, "", [], {})]
                if blank:
                    out[str(row.get("key"))] = blank
            return out

        blanks = _missing_required(artifacts) if schemas else {}
        if blanks:
            log.info("[hyper-engine] runtime stage %s: repairing blank required fields %s",
                          envelope.get("stage_id"), blanks)
            repair = await self._groq([
                {"role": "system", "content": (
                    "Return JSON only: {\"artifacts\":[{\"key\":...,\"data\":{...}}]}. You already produced this "
                    "artifact but left REQUIRED judgement fields empty. Those fields are the Room's own work "
                    "product, not facts to look up, so their absence from the evidence is not a reason to omit "
                    "them. Author each named field now from the evidence already gathered, marking a "
                    "low-confidence call as an assumption to test. Return the COMPLETE data object for each "
                    "artifact — every field you already had, verbatim, plus the named ones filled. Do not invent "
                    "a metric, source, contact detail, identifier, provider action or named third party.")},
                {"role": "user", "content": json.dumps({
                    "fill_these_required_fields": blanks,
                    "your_current_artifacts": [{"key": row.get("key"), "data": row.get("data")} for row in artifacts],
                    "requirements": {key: (schemas.get(key) or {}).get("requirements") for key in blanks},
                    "evidence": evidence,
                }, ensure_ascii=False)},
            ], model=self.synth_model, temp=0.2, bucket="synth", force_text=True,
               json_object=True, uncapped=True, max_tokens=6000)
            repaired = _first_json_object(str((repair or {}).get("content") or "")) or {}
            by_key = {str(row.get("key")): row for row in (repaired.get("artifacts") or []) if isinstance(row, dict)}
            for row in artifacts:
                patch = by_key.get(str(row.get("key")))
                fixed = patch.get("data") if isinstance(patch, dict) and isinstance(patch.get("data"), dict) else None
                if not fixed:
                    continue
                current = row.get("data") if isinstance(row.get("data"), dict) else {}
                # MONOTONIC: only ever fill a blank. A repair pass must never overwrite or
                # drop a field that was already good.
                for field, value in fixed.items():
                    if current.get(field) in (None, "", [], {}) and value not in (None, "", [], {}):
                        current[field] = value
                row["data"] = current
            still = _missing_required(artifacts)
            if still:
                log.warning("[hyper-engine] runtime stage %s: still blank after repair %s",
                                 envelope.get("stage_id"), still)

        gaps = [str(value).strip() for value in (parsed.get("gaps") or []) if str(value).strip()][:20]
        if not evidence:
            artifacts = []
            gaps = [*gaps, "No evidence-backed Room output was produced for this stage."]
        if not artifacts and not gaps:
            gaps = ["The Room did not produce an expected evidence-backed artifact."]
        return {
            "contract": "runtime-stage-result.v1",
            "run_id": str(envelope.get("run_id") or ""),
            "stage_id": str(envelope.get("stage_id") or ""),
            "artifacts": artifacts,
            "gaps": list(dict.fromkeys(gaps)),
            "summary": str(parsed.get("summary") or "").strip()[:4000],
        }

    async def _synthesize_room_phase_result(
        self, work_order_result: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Return provider-backed special artifacts plus generic contract artifacts.

        The legacy compiler remains authoritative for records created by Room tools
        (leads, drafts and calls). Any other playbook artifact is shaped through the
        same strict, evidence-bound contract synthesizer used by runtime-stage.v1.
        This keeps Room intelligence adaptive while making room-phase.v2 genuinely
        generic instead of silently degrading unknown artifact keys into prose.
        """
        compiled = self._compile_room_phase_result(work_order_result)
        phase = self.room_phase or {}
        lifecycle = phase.get("lifecycle") if isinstance(phase.get("lifecycle"), dict) else {}
        expected = [str(value) for value in (lifecycle.get("expected_artifacts") or []) if str(value).strip()]
        produced = {str(row.get("key") or "") for row in (compiled.get("artifacts") or []) if isinstance(row, dict)}
        missing = [key for key in expected if key not in produced]
        if not missing or phase.get("contract") != "room-phase.v2":
            return compiled

        context = phase.get("context") if isinstance(phase.get("context"), dict) else {}
        prior = context.get("prior_artifacts") if isinstance(context.get("prior_artifacts"), dict) else {}
        inputs: Dict[str, Any] = {
            "context.company": context.get("company"),
            "context.baseline": context.get("baseline"),
            "context.request": context.get("request"),
            "context.target": context.get("target"),
            "context.admin_current_status": context.get("admin_current_status"),
            "context.lifecycle_catalog": context.get("lifecycle_catalog"),
            **prior,
        }
        inputs = {key: value for key, value in inputs.items() if value is not None}
        requirements = lifecycle.get("artifact_requirements")
        requirements = requirements if isinstance(requirements, dict) else {}
        schemas = lifecycle.get("artifact_schemas")
        schemas = schemas if isinstance(schemas, dict) else {}
        strict_response_schema = lifecycle.get("strict_response_schema")
        strict_response_schema = strict_response_schema if isinstance(strict_response_schema, dict) else None
        generic_envelope = {
            "contract": "runtime-stage.v1",
            "run_id": phase.get("run_id"),
            "stage_id": phase.get("phase_id"),
            "objective": phase.get("instruction") or lifecycle.get("guidance"),
            "inputs": inputs,
            "expected_artifacts": missing,
            "completion_checks": [
                row for row in (lifecycle.get("completion_checks") or [])
                if isinstance(row, dict) and str(row.get("select") or "") in missing
            ],
            "artifact_requirements": {
                key: value for key, value in requirements.items()
                if key in missing
            },
            "artifact_schemas": {
                key: value for key, value in schemas.items()
                if key in missing
            },
            "strict_response_schema": strict_response_schema,
        }
        generic = await self._synthesize_runtime_stage_result(generic_envelope)
        generic_artifacts = [
            row for row in (generic.get("artifacts") or [])
            if isinstance(row, dict) and str(row.get("key") or "") in missing
        ]
        all_artifacts = [*(compiled.get("artifacts") or []), *generic_artifacts]
        final_keys = {str(row.get("key") or "") for row in all_artifacts if isinstance(row, dict)}
        retained_gaps = [
            str(gap) for gap in (compiled.get("gaps") or [])
            if not any(str(gap) == f"The Room did not return a verified {key} artifact for this phase."
                       for key in final_keys)
        ]
        return {
            **compiled,
            "artifacts": all_artifacts,
            "gaps": list(dict.fromkeys([*retained_gaps, *(generic.get("gaps") or [])])),
            "summary": str(generic.get("summary") or compiled.get("summary") or "")[:4000],
        }

    async def _synthesize_work_order_result(self) -> Dict[str, Any]:
        from .work_order_contract import assemble_work_order_result, govern_work_order_result
        subtask_view = []
        grounded_artifacts: List[Dict[str, Any]] = []
        for row in self.work_results:
            view = {k: v for k, v in row.items() if k not in {"evidence_refs"}}
            output = dict(view.get("output") or {})
            artifacts = output.pop("artifacts", [])
            if isinstance(artifacts, list):
                grounded_artifacts.extend(x for x in artifacts if isinstance(x, dict))
                output["artifact_summary"] = [
                    {"kind": x.get("kind"), "source": x.get("source"),
                     "record_count": x.get("record_count"), "query": x.get("query")}
                    for x in artifacts if isinstance(x, dict)
                ]
            view["output"] = output
            subtask_view.append(view)
        response = await self._groq([
            {"role": "system", "content": (
                _now_block() + "Synthesize a machine-consumed HQ work-order result. Return JSON with "
                "report_markdown, deliverables, needs_input, blockers, and checkpoint. Keep report_markdown compact "
                "but decision-useful: outcome, concrete work completed, prepared actions, evidence, actual counts, "
                "and exact gaps. checkpoint must contain "
                "stage, completed, next, disposition, reason, requires. disposition is one of complete, "
                "continue_room, wait_event, wait_capability, request_hq. Use the progressively loaded Room "
                "operating-loop skill and actual artifacts to choose it. Never change statuses, checks, metrics, "
                "or claim missing work happened.")},
            {"role": "user", "content": json.dumps({"objective": (self.work_order or {}).get("objective"),
                                                     "subtasks": subtask_view}, ensure_ascii=False)},
        ], model=self.synth_model, temp=0.15, bucket="synth", force_text=True, json_object=True, uncapped=True, max_tokens=1800)
        semantic = _first_json_object(str((response or {}).get("content") or "")) or {}
        # Subtask checks are the execution authority. A formatter may describe
        # unresolved work, but it must not invent a blocker or human-input gate
        # after every machine requirement has passed. External authority remains
        # represented separately by proposed_actions for HQ to govern.
        subtasks_complete = bool(self.work_results) and all(
            row.get("status") == "completed"
            and all(check.get("passed") is True for check in (row.get("checks") or []))
            for row in self.work_results if isinstance(row, dict)
        )
        if subtasks_complete:
            semantic["needs_input"] = []
            semantic["blockers"] = []
            checkpoint = semantic.get("checkpoint") if isinstance(semantic.get("checkpoint"), dict) else {}
            checkpoint["completed"] = [
                str(row.get("title") or row.get("id") or "work order")[:120]
                for row in self.work_results if isinstance(row, dict)
            ]
            checkpoint["disposition"] = "complete"
            checkpoint["requires"] = []
            semantic["checkpoint"] = checkpoint
        if grounded_artifacts:
            # Structured tool artifacts are authoritative. Models may explain them,
            # but may not recreate rows, add placeholders, or silently drop records.
            semantic["deliverables"] = grounded_artifacts
            prospect_artifacts = [x for x in grounded_artifacts if x.get("kind") == "prospect_records"]
            draft_artifacts = [x for x in grounded_artifacts if x.get("kind") == "email_drafts"]
            prospect_count = sum(int(x.get("record_count") or 0) for x in prospect_artifacts)
            persisted_count = sum(int(x.get("persisted_count") or 0) for x in prospect_artifacts)
            draft_count = sum(int(x.get("record_count") or 0) for x in draft_artifacts)
            facts = []
            if prospect_artifacts:
                facts.append(f"- {prospect_count} source-backed prospect record(s) found")
                facts.append(f"- {persisted_count} lead record(s) confirmed persisted")
            if draft_artifacts:
                facts.append(f"- {draft_count} verified-recipient draft(s) prepared")
                facts.append("- 0 external messages sent by the Room")
            authored_report = str(semantic.get("report_markdown") or "").strip()
            if facts:
                semantic["report_markdown"] = (
                    (authored_report + "\n\n" if authored_report else "## Room result\n\n")
                    + "### Verified execution facts\n\n" + "\n".join(facts)
                )
            semantic["proposed_actions"] = [
                {
                    "capability": action.get("capability"),
                    "operation": action.get("operation"),
                    "target_hint": action.get("target_hint"),
                    "connected": bool(action.get("connected")),
                    "authority_required": True,
                    "status": "prepared" if draft_count else "requested",
                }
                for action in self.post_output_actions if isinstance(action, dict)
            ]
            semantic["actual_counts"] = {
                "records_discovered": prospect_count,
                "records_persisted": persisted_count,
                "drafts_prepared": draft_count,
                "external_actions_executed": 0,
            }
        semantic.setdefault("proposed_actions", [
            {
                "capability": action.get("capability"),
                "operation": action.get("operation"),
                "target_hint": action.get("target_hint"),
                "connected": bool(action.get("connected")),
                "authority_required": True,
                "status": "requested",
            }
            for action in self.post_output_actions if isinstance(action, dict)
        ])
        semantic.setdefault("actual_counts", {"external_actions_executed": 0})
        if not semantic.get("report_markdown"):
            semantic["report_markdown"] = "\n\n".join(
                str(row.get("output", {}).get("text") or "") for row in self.work_results if row.get("output"))
        result = assemble_work_order_result(semantic, envelope=self.work_order or {}, subtasks=self.work_results,
                                            metrics={"tool_calls_total": self._work_order_successful_tools,
                                                     "records_created": self._work_order_records_created,
                                                     "records_persisted": sum(
                                                         int(x.get("persisted_count") or 0)
                                                         for x in grounded_artifacts if x.get("kind") == "prospect_records"),
                                                     "source_backed_records": sum(
                                                         1 for x in grounded_artifacts if x.get("kind") == "prospect_records"
                                                         for record in (x.get("records") or [])
                                                         if record.get("place_id") or record.get("source_url")),
                                                     "distinct_records": sum(
                                                         1 for x in grounded_artifacts if x.get("kind") == "prospect_records"
                                                         for record in (x.get("records") or [])
                                                         if record.get("fit_reason") and record.get("outreach_angle")),
                                                     "recall_hits": self.gather_count, "web_calls": self._web_calls})
        return govern_work_order_result(result)["result"]

    async def _run_work_orders(self, plan: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Run Director-planned work as independent, attributable agent jobs.

        Workers are intentionally read/prepare-only. They create durable outputs
        for synthesis and verification; the existing producer remains the sole
        path for sending, publishing, or other external writes.
        """
        plan_steps = [row for row in (plan.get("turn_plan") or []) if isinstance(row, dict)] if self.is_work_room else []
        orders = plan_steps or [row for row in (plan.get("work_orders") or []) if isinstance(row, dict)]
        if not orders or not self.participants:
            return []
        completed_by_step: Dict[str, Dict[str, Any]] = {}

        async def execute(index: int, order: Dict[str, Any]) -> Dict[str, Any]:
            owner = self._work_order_owner(str(order.get("owner_lane") or "Strategist"))
            owner_name = str(owner.get("name") or owner.get("slug") or "Director")
            owner_slug = str(owner.get("slug") or "director")
            step_id = str(order.get("id") or f"work-{index + 1}")[:80]
            dependencies = [str(value)[:80] for value in (order.get("depends_on") or []) if str(value)]
            order_key = f"{step_id}-{str(order.get('kind') or 'analysis')[:20]}"[:80]
            evidence = list(order.get("required_evidence") or [])
            criteria = list(order.get("acceptance_criteria") or [])
            wait_for = _normalize_work_step_wait(order.get("wait"))
            handoff = _normalize_work_step_handoff(order.get("handoff"))
            existing_work_id = str(order.get("_work_order_id") or "").strip()
            persisted = None
            if not existing_work_id:
                persisted = await create_hyper_work_order(
                    org_id=self.org_id, room_id=self.room_id or "", turn_id=self.turn_id or "",
                    order_key=order_key, kind=str(order.get("kind") or "analysis"),
                    title=str(order.get("title") or "Work order"), objective=str(order.get("objective") or ""),
                    owner=owner, selected_skills=list(self.skills_used), required_evidence=evidence,
                    acceptance_criteria=criteria,
                    input_snapshot={"room_kind": self.room_kind, "room_mode": self.room_mode,
                                    "user_message": self.user_message[:1000], "turn_plan": bool(plan_steps)},
                    plan_step_id=step_id,
                    depends_on=dependencies,
                    wait_for=wait_for,
                    handoff=handoff,
                )
            work_id = existing_work_id or str((persisted or {}).get("id") or "")
            if wait_for:
                waiting_status = {
                    "input": "waiting_for_input",
                    "approval": "waiting_for_approval",
                    "capability": "waiting_for_capability",
                    "event": "waiting_for_event",
                }[wait_for["kind"]]
                if work_id:
                    await pause_hyper_work_order(
                        work_order_id=work_id, org_id=self.org_id, status=waiting_status,
                        wait_for=wait_for, handoff=handoff,
                    )
                result = {
                    "id": work_id or order_key, "step_id": step_id, "depends_on": dependencies,
                    "order_key": order_key, "status": waiting_status, "kind": order.get("kind"),
                    "title": order.get("title"), "owner": owner_name, "owner_slug": owner_slug,
                    "text": wait_for["reason"], "acceptance_criteria": criteria,
                    "wait_for": wait_for, "handoff": handoff,
                }
                await self.emit({"t": "work_order", **result})
                return result
            if work_id:
                await start_hyper_work_order(work_id, self.org_id)
            await self.emit({"t": "work_order", "id": work_id or order_key, "status": "running",
                             "kind": order.get("kind"), "title": order.get("title"),
                             "agent": owner_slug, "name": owner_name,
                             "acceptance_criteria": criteria})
            await self.emit({"t": "typing", "agent": owner_slug,
                             "note": f"{owner_name} — working on {str(order.get('title') or 'the assigned deliverable').lower()}…"})
            persona_name, lane, persona = _persona_fields(owner)
            context = self._work_order_context(evidence)
            predecessor_notes = [completed_by_step[dependency].get("text", "")
                                 for dependency in dependencies if dependency in completed_by_step]
            if predecessor_notes:
                context += "\n\nCOMPLETED PREREQUISITES:\n" + "\n".join(predecessor_notes)
            prompt = (
                f"WORK ORDER: {order.get('title')}\nOBJECTIVE: {order.get('objective')}\n"
                f"ACCEPTANCE CRITERIA:\n" + "\n".join(f"- {item}" for item in criteria) +
                "\n\nReturn one compact working note, at most 120 words. Include only: the recommendation "
                "or key finding, the evidence used, and any unresolved gap. Use short bullets, no tables, no "
                "implementation plan, and no repeated brief. The final synthesizer produces the requested response or artifact. Do not "
                "discuss process, do not claim external actions were taken, and mark unsupported statements UNVERIFIED."
                # Confirmed live 2026-08-13: a "Discover GDPR-sensitive prospects"
                # work order invented two named people (with fabricated emails)
                # and cited a nonexistent "ECB supervisory contacts list (public
                # PDF, 2026-07)" — "mark unsupported UNVERIFIED" did not stop a
                # specific fake person + fake source from being written as fact.
                " NEVER invent a named person, job title, email address, phone number, or a specific "
                "document/registry/list as a source unless that EXACT contact or document is present in "
                "the EVIDENCE BOARD below. If the evidence board does not contain a real contact, say plainly "
                "'no verified contact found in gathered evidence' — do not manufacture one, even hedged."
            )
            try:
                response = await self._groq([
                    {"role": "system", "content": (
                        _now_block() + f"You are {persona_name}, a {lane}. {persona}\n"
                        "You are completing one bounded work order for your Room. Work from the supplied evidence "
                        "and selected methods only — never invent a fact, contact, or source not present in that "
                        "evidence. Be concise, concrete, and produce the actual work product.")},
                    {"role": "user", "content": f"{prompt}\n\nEVIDENCE BOARD:\n{context}"},
                ], model=self.persona_model, temp=0.35, bucket="worker", max_tokens=220)
                text = _strip_cot((response or {}).get("content") or "").strip()
                if not text:
                    raise RuntimeError("worker returned no usable result")
                activity = _work_order_activity(order.get("title"), text)
                result = {"id": work_id or order_key, "step_id": step_id, "depends_on": dependencies, "order_key": order_key, "status": "completed",
                          "kind": order.get("kind"), "title": order.get("title"), "owner": owner_name,
                          "owner_slug": owner_slug, "text": text, "acceptance_criteria": criteria}
                self.blackboard.append(f"WORK_RESULT[{owner_name} | {order.get('title')}]:\n{text}")
                await self.emit({"t": "work_order", "id": result["id"], "order_key": order_key,
                                 "status": "completed", "kind": order.get("kind"), "title": order.get("title"),
                                 "owner": owner_name, "owner_slug": owner_slug, "summary": activity,
                                 "acceptance_criteria": criteria})
                await self.emit({"t": "react", "agent": owner_slug, "name": owner_name, "lane": lane,
                                 "agreement": "contribute", "content": activity, "line": activity, "confidence": 0.8,
                                 "work_order_id": work_id or order_key})
                if work_id:
                    await complete_hyper_work_order(
                        work_order_id=work_id, org_id=self.org_id, status="completed", summary=text[:1000],
                        output={"text": text, "title": order.get("title")}, evidence=evidence, artifacts=[],
                        usage={"tokens": int(self._last_tok or 0)},
                    )
                return result
            except Exception as exc:  # a worker failure is a visible, bounded result, never a dead Room
                message = str(exc)[:500]
                result = {"id": work_id or order_key, "step_id": step_id, "depends_on": dependencies, "order_key": order_key, "status": "failed",
                          "kind": order.get("kind"), "title": order.get("title"), "owner": owner_name,
                          "owner_slug": owner_slug, "text": message, "acceptance_criteria": criteria}
                await self.emit({"t": "work_order", **result})
                if work_id:
                    await complete_hyper_work_order(
                        work_order_id=work_id, org_id=self.org_id, status="failed", summary=message,
                        output={}, evidence=evidence, artifacts=[],
                        usage={"tokens": int(self._last_tok or 0)}, error=message,
                    )
                return result

        if not plan_steps:
            return list(await asyncio.gather(*(execute(index, order) for index, order in enumerate(orders))))

        pending = list(enumerate(orders))
        results: List[Dict[str, Any]] = []
        while pending:
            ready = [(index, order) for index, order in pending
                     if all(dependency in completed_by_step and completed_by_step[dependency].get("status") == "completed"
                            for dependency in (order.get("depends_on") or []))]
            if not ready:
                for index, order in pending:
                    step_id = str(order.get("id") or f"work-{index + 1}")[:80]
                    dependencies = list(order.get("depends_on") or [])
                    owner = self._work_order_owner(str(order.get("owner_lane") or "Strategist"))
                    persisted = await create_hyper_work_order(
                        org_id=self.org_id, room_id=self.room_id or "", turn_id=self.turn_id or "",
                        order_key=f"{step_id}-{str(order.get('kind') or 'analysis')[:20]}"[:80],
                        kind=str(order.get("kind") or "analysis"), title=str(order.get("title") or "Work step"),
                        objective=str(order.get("objective") or ""), owner=owner,
                        selected_skills=list(self.skills_used),
                        required_evidence=list(order.get("required_evidence") or []),
                        acceptance_criteria=list(order.get("acceptance_criteria") or []),
                        input_snapshot={"room_kind": self.room_kind, "room_mode": self.room_mode,
                                        "user_message": self.user_message[:1000], "turn_plan": True},
                        plan_step_id=step_id, depends_on=dependencies,
                    )
                    work_id = str((persisted or {}).get("id") or step_id)
                    waiting_dependencies = [
                        dependency for dependency in dependencies
                        if str((completed_by_step.get(dependency) or {}).get("status") or "").startswith("waiting_for_")
                    ]
                    if waiting_dependencies:
                        wait_for = {
                            "kind": "event",
                            "reason": "Waiting for prerequisite step: " + ", ".join(waiting_dependencies),
                            "prompt": None,
                            "resume_key": None,
                        }
                        message = wait_for["reason"]
                        if persisted:
                            await pause_hyper_work_order(
                                work_order_id=work_id, org_id=self.org_id, status="waiting_for_dependency",
                                wait_for=wait_for,
                            )
                        result_status = "waiting_for_dependency"
                    else:
                        message = "Dependencies were not completed; this step was not started."
                        if persisted:
                            await complete_hyper_work_order(
                                work_order_id=work_id, org_id=self.org_id, status="blocked", summary=message,
                                output={}, evidence=[], artifacts=[], usage={}, error=message,
                            )
                        result_status = "needs_attention"
                    result = {"id": work_id, "step_id": step_id, "depends_on": dependencies,
                              "status": result_status, "kind": order.get("kind"), "title": order.get("title"),
                              "text": message}
                    completed_by_step[step_id] = result
                    results.append(result)
                    await self.emit({"t": "work_order", **result})
                break
            wave = await asyncio.gather(*(execute(index, order) for index, order in ready))
            for result in wave:
                completed_by_step[str(result.get("step_id") or result.get("id"))] = result
                results.append(result)
            ready_ids = {id(order) for _, order in ready}
            pending = [(index, order) for index, order in pending if id(order) not in ready_ids]
        return results

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

        campaign_channels, _ = self._campaign_requirements() if self.room_kind == "campaign" else ([], [])
        if self.room_kind == "campaign" and not self._uses_prospect_debate(campaign_channels):
            # Existing-audience recall can return CRM prospect rows even for a
            # brand campaign. They are irrelevant evidence for organic awareness
            # and previously pulled the whole debate toward named-firm outreach.
            self.blackboard = [line for line in self.blackboard if "PROSPECT:" not in str(line)]

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
        if _prospect_lines and self._uses_prospect_debate(campaign_channels):
            _plist = "\n".join(_prospect_lines)
            r1_prompt = (f"The team found these PROSPECTS on the board:\n{_plist}\n\n"
                         f"Objective: {topic}\nDiscuss THESE specific firms — which to prioritize and why, "
                         f"the sharpest why-now hook for each, the objection each is likely to raise, and how "
                         f"the outreach should open. Be concrete about the named firms; no generic theory.")
        else:
            # Confirmed live 2026-08-13: a fundraising-room debater invented a
            # named "internal product-risk audit (Q3 2026)" and three named
            # competitor startups (PrivAI/SecureMind/DataGuardAI) wholesale —
            # none were on the board. Labeling it "UNVERIFIED" did not stop the
            # model from dressing up a guess with a specific fake source; the
            # campaign-only guard below never reached this room_kind. Made
            # universal: every room kind gets the same explicit ban.
            r1_prompt = (
                f"What is your stance on: {topic}? Give your view + your single biggest concern. "
                "Use only facts in the CONTEXT above. Do not invent named entities: competitor names, "
                "internal documents, audits, logs, customer results, testimonials, case studies, dates, "
                "or metrics that are not present in the CONTEXT. When proof is missing, say so plainly and "
                "name the gap — never dress up an unverifiable guess with a specific fabricated source "
                "(e.g. a named 'audit' or 'log') to make it sound real."
            )
            if self.room_kind == "campaign":
                r1_prompt += (
                    " Do not supply a hypothetical performance number as if it were real."
                )
        r1 = await asyncio.gather(*[
            _consult_and_emit(m, r1_prompt, self._round_seq, ("challenge", "contribute"))
            for m in members
        ])
        for c in r1:
            if c.get("empty"):
                continue
            self.transcript.append({"round": 1, "agent": c["name"], "text": c["text"]})

        # Round 2 gate — a REAL moderator judgment, not a fixed count. This used
        # to run round 2 unconditionally whenever the caller allowed up to 2
        # rounds; now a lightweight structured judge (AgentScope multi-agent-
        # debate pattern: a moderator scores each round and decides whether more
        # debate would change the outcome) checks round 1 first. Fail-open: any
        # judge error or unparseable reply defaults to running round 2 exactly
        # like the old behavior — a judge outage can only ADD a round, never
        # silently skip real debate.
        _judge = {"sufficient": False, "disagreement_note": "", "judged": False}
        _skip_round_2 = False
        if rounds >= 2:
            _judge = await self._judge_debate_round(topic, r1)
            _skip_round_2 = bool(_judge.get("judged") and _judge.get("sufficient"))

        # Round 2 — react/challenge each other on the shared board
        if rounds >= 2 and not _skip_round_2:
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
                                      f"If a teammate cited a named source, document, or entity not in the original "
                                      f"CONTEXT, treat it as unverified and say so — do not build on it as if it were "
                                      f"real. Do you change your view on '{topic}'?"),
                                  self._round_seq, ("challenge", "support"))
                for m in members
            ])
            for c in r2:
                if c.get("empty"):
                    continue
                self.transcript.append({"round": 2, "agent": c["name"], "text": c["text"]})

        self._debate_disagreement_note = _judge.get("disagreement_note") or ""
        await self.emit({
            "t": "swarm_verdict", "round": self._round_seq, "converged": True,
            "skipped_round_2": _skip_round_2,
            "disagreement_note": self._debate_disagreement_note,
        })
        return json.dumps({
            "rounds": rounds,
            "transcript": [{"r": x["round"], "agent": x["agent"], "said": x["text"][:400]} for x in self.transcript],
        })

    async def _judge_debate_round(self, topic: str, round_transcript: List[Dict[str, Any]]) -> Dict[str, Any]:
        """Moderator-style structured judge (AgentScope multi-agent-debate
        pattern), run once after round 1. Decides whether the stances already
        converge or clearly diverge enough that a second peer-rebuttal round
        would not change the outcome, and captures the real disagreement for
        the aggregator to cite — replacing the old hardcoded converged=True
        that carried no actual signal. Fail-open on any error: caller treats
        judged=False as "run round 2", matching the pre-existing behavior."""
        lines = "\n".join(f"{c['name']}: {c['text'][:600]}" for c in round_transcript if not c.get("empty"))
        if not lines:
            return {"sufficient": False, "disagreement_note": "", "judged": False}
        prompt = (
            "You are the room's debate moderator. The team just gave independent stances "
            f"on: {topic}\n\nSTANCES:\n{lines}\n\n"
            "Decide: do these stances already converge (broad agreement), or is any "
            "disagreement already clearly articulated — such that a second round of "
            "direct peer rebuttal would NOT change the outcome? Or is there a live, "
            "unresolved disagreement worth one more round of rebuttal?\n"
            "Reply with STRICT JSON only, no prose:\n"
            '{"sufficient": <true if a second round would not change the outcome>, '
            '"disagreement_note": "<one sentence: what they agree or disagree on, for the report writer>"}'
        )
        try:
            reply = await self._groq(
                [{"role": "user", "content": prompt}],
                model=self.director_model, temp=0.1, bucket="director",
                force_text=True, json_object=True, max_tokens=200,
            )
            obj = _first_json_object(str((reply or {}).get("content") or "")) or {}
            if "sufficient" in obj:
                return {
                    "sufficient": bool(obj.get("sufficient")),
                    "disagreement_note": str(obj.get("disagreement_note") or "")[:300],
                    "judged": True,
                }
        except Exception as exc:  # noqa: BLE001
            log.warning("[debate] round judge failed, defaulting to round 2: %s", exc)
        return {"sufficient": False, "disagreement_note": "", "judged": False}

    def _uses_prospect_debate(self, campaign_channels: List[str]) -> bool:
        if self.room_kind != "campaign":
            return True
        return any(channel in {"gmail", "tara"} for channel in campaign_channels) or getattr(self, "evidence_mode", "") == "prospecting"

    def _allows_places_discovery(self) -> bool:
        if self.room_kind != "campaign":
            return True
        brief = self.campaign_brief if isinstance(self.campaign_brief, dict) else {}
        policy = brief.get("audiencePolicy") if isinstance(brief.get("audiencePolicy"), dict) else brief.get("audience_policy")
        if isinstance(policy, dict) and policy.get("discover_if_insufficient") is False:
            return False
        channels, _ = self._campaign_requirements()
        evidence_mode = str(brief.get("evidence_mode") or getattr(self, "evidence_mode", "")).strip().lower()
        return evidence_mode == "prospecting" or self._uses_prospect_debate(channels)

    def _campaign_recall_query_is_grounded(self, query: str) -> bool:
        # The broad company brief can contain imported client/project memories.
        # Treat only the active campaign contract and current request as the
        # identity allowlist, otherwise legacy brands can authorize themselves.
        active_context = (self.user_message or "").casefold()
        common_terms = {"AI", "API", "B2B", "B2C", "CRM", "GDPR", "ICP", "SEO", "X"}
        identifiers = set(re.findall(r"\b[A-Z][A-Z0-9_-]{3,}\b", query or ""))
        return all(token in common_terms or token.casefold() in active_context for token in identifiers)

    def _campaign_recall_fact_is_grounded(self, fact: str) -> bool:
        match = re.search(r"(?:^|\n)Company:\s*([^\n—–]+)", self.company_brief or "", re.I)
        if not match:
            return False
        company_name = match.group(1).strip(" .,-")
        tokens = [
            token.casefold()
            for token in re.findall(r"[A-Za-zÀ-ÖØ-öø-ÿ0-9&.-]+", company_name)
            if len(token.strip("&.-")) >= 3
        ]
        haystack = (fact or "").casefold()
        return bool(tokens) and any(token in haystack for token in tokens)

    def _debate_topic(self) -> str:
        return (self.user_message or self.room_goal or "")[:400]

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
            m = re.search(r"(?:^|\n)Company:\s*([^\n—–]+)", self.company_brief or "", re.I)
            name = (m.group(1).strip(" .,-") if m else "").strip()
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
        prompt = (
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
        if self.room_kind == "campaign":
            from .campaign_contract import campaign_system_contract
            prompt += campaign_system_contract(self._campaign_allowed_urls())
        return prompt

    # ── plan → parallel-gather → synth (the fast path) ────────────────
    @staticmethod
    def _contract_field_names(envelope: Dict[str, Any]) -> List[str]:
        """Fields the stage will actually be judged on, required first then preferred."""
        strict = envelope.get("strict_response_schema")
        if isinstance(strict, dict) and isinstance(strict.get("fields"), dict):
            fields = strict["fields"]
            return [*(fields.get("required") or []), *(fields.get("preferred") or [])]
        schemas = envelope.get("artifact_schemas") if isinstance(envelope.get("artifact_schemas"), dict) else {}
        out: List[str] = []
        for spec in schemas.values():
            data = (((spec or {}).get("schema") or {}).get("properties") or {}).get("data") or {}
            out.extend(str(name) for name in (data.get("properties") or {}))
        return list(dict.fromkeys(out))

    def _material_for_fields(self, fields: List[str]) -> Dict[str, List[Dict[str, str]]]:
        """Index the Room's OWN completed deliverables against the contract's fields.

        The failure this removes: a worker completed a "Channel Mix Blueprint" and the synth
        step still returned channel_mix null. The deliverable reached synth only as an
        anonymous work:N blob among dozens, and self.work_results was additionally sliced to
        the last 12 — so material the contract required could be dropped outright before the
        model ever saw it. Matching is deterministic token overlap on the field name; a false
        positive merely shows the model one extra deliverable, while a false negative is the
        bug. No extra model call.
        """
        index: Dict[str, List[Dict[str, str]]] = {}
        rows = [row for row in self.work_results if isinstance(row, dict)]
        for field in fields:
            tokens = [tok for tok in str(field).lower().split("_") if len(tok) > 3]
            if not tokens:
                continue
            hits: List[Dict[str, str]] = []
            for position, row in enumerate(rows, start=1):
                output = row.get("output") if isinstance(row.get("output"), dict) else {}
                title = str(row.get("title") or row.get("objective") or "")
                text = str(output.get("text") or row.get("summary") or "").strip()
                if not text:
                    continue
                haystack = (title + " " + text).lower()
                if any(tok in haystack for tok in tokens):
                    hits.append({"work_ref": f"work:{position}", "title": title[:160], "deliverable": text[:3000]})
            if hits:
                index[field] = hits[:3]
        return index

    def _campaign_allowed_urls(self) -> List[str]:
        """The exact link set the contract validator will accept, read from the SAME brief
        keys it reads. Derived here so the producer and the checker cannot drift."""
        brief = self.campaign_brief or {}
        payload = brief.get("brief") if isinstance(brief.get("brief"), dict) else brief
        # An explicit preflight decision wins over inference. The runtime decides linkless
        # BEFORE dispatch when the company has no website on record, so the Room is told the
        # policy instead of discovering it through five rejected actions.
        if str(payload.get("link_policy") or "") == "linkless":
            return []
        return [str(value).strip() for value in (
            payload.get("destination_url"), payload.get("destinationUrl"), payload.get("website_url"),
        ) if str(value or "").strip()]

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
        work_target = ((self.work_order or {}).get("target") or {}) if self.work_order else {}
        user = (f"TASK: {(self.user_message or '')[:500]}\n"
                f"ASSIGNMENT TARGET: {json.dumps(work_target, ensure_ascii=False)[:900]}\n"
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
        # Tool choice must work in every language. Expose the complete bounded
        # connector catalog and let the structured Director choose up to four;
        # lexical overlap silently hid valid tools for non-English requests.
        conn = conn_all
        if _CONNECTION_SEARCH and len(conn) < len(conn_all):
            log.info("[hyper-engine] connection_search: surfaced %d/%d connector tools", len(conn), len(conn_all))
        conn_line = (f"Connector READ tools available (use these EXACT names): {conn}."
                     if conn else "No external connectors are connected.")
        web_line = ("Web search IS available (external/public facts only)." if self._web_budget > 0
                    else "Web search is NOT available.")
        connected = {_norm_connector(connector) for connector in self.connectors}
        action_catalog = [
            {
                "capability": capability,
                "connector": spec["connector"],
                "status": ("connected" if any(_norm_connector(alias) in connected for alias in spec["aliases"])
                           else "not_connected"),
                "description": spec["description"],
            }
            for capability, spec in _POST_OUTPUT_CAPABILITIES.items()
        ]
        action_line = "POST-OUTPUT ACTION CATALOG: " + json.dumps(action_catalog, ensure_ascii=False)
        schema = {
            "type": "object",
            "properties": {
                "recall_queries": {"type": "array", "items": {"type": "string"}},
                "history_turns_back": {"type": "integer", "minimum": 0, "maximum": 50},
                "connector_calls": {"type": "array", "items": {
                    "type": "object",
                    "properties": {"name": {"type": "string"}, "args_json": {"type": "string"}},
                    "required": ["name", "args_json"], "additionalProperties": False}},
                "web_query": {"type": ["string", "null"]},
                "seo_audit_url": {"type": ["string", "null"]},
                "seo_audit_scope": {"type": "string", "enum": ["none", "page", "sample", "site"]},
                "seo_task": {"type": "string", "enum": ["none", "inspect", "audit", "remediate", "rescan", "strategy"]},
                "places_query": {"type": ["string", "null"]},
                "needs_debate": {"type": "boolean"},
                "method_skills": {"type": "array", "items": {"type": "string"}},
                "campaign_method_assignments": {"type": "array", "items": {
                    "type": "object",
                    "properties": {
                        "role": {"type": "string"},
                        "task": {"type": "string"},
                        "query": {"type": "string"},
                    },
                    "required": ["role", "task", "query"], "additionalProperties": False}},
                "work_orders": {"type": "array", "items": {"type": "object", "properties": {
                    "kind": {"type": "string", "enum": ["research", "analysis", "creative", "decision"]},
                    "owner_lane": {"type": "string", "enum": ["Strategist", "Researcher", "Skeptic", "Builder", "Communicator"]},
                    "title": {"type": "string"},
                    "objective": {"type": "string"},
                    "required_evidence": {"type": "array", "items": {"type": "string"}},
                    "acceptance_criteria": {"type": "array", "items": {"type": "string"}},
                }, "required": ["kind", "owner_lane", "title", "objective", "required_evidence", "acceptance_criteria"], "additionalProperties": False}},
                "turn_plan": {"type": "array", "items": {"type": "object", "properties": {
                    "id": {"type": "string"},
                    "depends_on": {"type": "array", "items": {"type": "string"}},
                    "kind": {"type": "string", "enum": ["research", "analysis", "creative", "decision"]},
                    "owner_lane": {"type": "string", "enum": ["Strategist", "Researcher", "Skeptic", "Builder", "Communicator"]},
                    "title": {"type": "string"},
                    "objective": {"type": "string"},
                    "required_evidence": {"type": "array", "items": {"type": "string"}},
                    "acceptance_criteria": {"type": "array", "items": {"type": "string"}},
                    "wait": {"type": ["object", "null"], "properties": {
                        "kind": {"type": "string", "enum": ["input", "approval", "capability", "event"]},
                        "reason": {"type": "string"},
                        "prompt": {"type": ["string", "null"]},
                        "resume_key": {"type": ["string", "null"]},
                    }, "required": ["kind", "reason", "prompt", "resume_key"], "additionalProperties": False},
                    "handoff": {"type": ["object", "null"], "properties": {
                        "owner": {"type": "string", "enum": ["runtime", "hq"]},
                        "objective": {"type": "string"},
                        "rationale": {"type": "string"},
                    }, "required": ["owner", "objective", "rationale"], "additionalProperties": False},
                }, "required": ["id", "depends_on", "kind", "owner_lane", "title", "objective", "required_evidence", "acceptance_criteria"], "additionalProperties": False}},
                "turn_mode": {"type": "string", "enum": ["chat", "task"]},
                "execution_engine": {"type": "string", "enum": ["debate", "agentic"]},
                "collaboration_intensity": {"type": "string", "enum": ["light", "standard", "deep"]},
                "response_depth": {"type": "string", "enum": ["direct", "focused", "operating"]},
                "evidence_mode": {"type": "string", "enum": ["standard", "prospecting"]},
                "post_output_actions": {"type": "array", "items": {"type": "object", "properties": {
                    "capability": {"type": "string"},
                    "explicit": {"type": "boolean"},
                    "target_hint": {"type": ["string", "null"]},
                }, "required": ["capability", "explicit", "target_hint"], "additionalProperties": False}},
                "outreach_request": {"type": ["object", "null"], "properties": {
                    "requested_count": {"type": ["integer", "null"], "minimum": 1, "maximum": 50},
                    "geography": {"type": ["string", "null"]},
                    "sector": {"type": ["string", "null"]},
                    "audience": {"type": ["string", "null"]},
                    "offer": {"type": ["string", "null"]},
                    "discover": {"type": "boolean"},
                    "persist": {"type": "boolean"},
                    "draft": {"type": "boolean"},
                    "deliver": {"type": "boolean"},
                    "monitor": {"type": "boolean"},
                }, "required": ["requested_count", "geography", "sector", "audience", "offer", "discover", "persist", "draft", "deliver", "monitor"], "additionalProperties": False},
                "campaign_request": {"type": ["object", "null"], "properties": {
                    "goal": {"type": "string"},
                    "name": {"type": ["string", "null"]},
                    "objective": {"type": "string", "enum": ["AWARENESS", "PRODUCT_LAUNCH", "LEAD_GENERATION", "WEBSITE_TRAFFIC", "THOUGHT_LEADERSHIP", "EVENT_PROMOTION", "RE_ENGAGEMENT", "CUSTOM"]},
                    "channels": {"type": "array", "items": {"type": "string", "enum": ["x_organic", "linkedin", "instagram", "facebook", "tiktok", "youtube", "pinterest", "reddit", "threads", "bluesky", "google_business", "gmail", "tara", "x_ads", "google_ads", "meta", "linkedin_ads", "youtube_ads", "tiktok_ads", "microsoft_ads", "apple_ads", "amazon_ads", "reddit_ads", "pinterest_ads", "snapchat_ads"]}},
                    "duration_days": {"type": "integer", "minimum": 1, "maximum": 365},
                    "intensity": {"type": "string", "enum": ["LIGHT", "FOCUSED", "HIGH"]},
                    "autonomy_mode": {"type": "string", "enum": ["APPROVE_PLAN_ONCE", "REVIEW_EVERY_ACTION"]},
                }, "required": ["goal", "name", "objective", "channels", "duration_days", "intensity", "autonomy_mode"], "additionalProperties": False},
            },
            "required": ["recall_queries", "history_turns_back", "connector_calls", "web_query", "seo_audit_url", "seo_audit_scope", "seo_task", "places_query", "needs_debate", "method_skills", "campaign_method_assignments", "work_orders", "turn_mode", "execution_engine", "collaboration_intensity", "response_depth", "evidence_mode", "post_output_actions", "outreach_request", "campaign_request"],
            "additionalProperties": False,
        }
        if _visual_artifacts_enabled():
            schema["properties"]["artifact_intent"] = {
                "type": ["object", "null"],
                "properties": {
                    "kind": {"type": "string", "enum": [
                        "presentation", "interactive_document", "dashboard"
                    ]},
                    "medium": {"type": "string", "enum": ["html"]},
                    "purpose": {"type": "string"},
                    "audience": {"type": "string"},
                    "quality_profile": {"type": "string", "enum": [
                        "executive", "analytical", "editorial", "operational", "educational"
                    ]},
                    "creative_freedom": {"type": "string", "enum": ["high", "guided"]},
                    "requirements": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["kind", "medium", "purpose", "audience", "quality_profile", "creative_freedom", "requirements"],
                "additionalProperties": False,
            }
            schema["required"].append("artifact_intent")
        sysp = (
            _now_block() +
            "You plan the GATHER and ACTION stages for a HIVEMIND room turn. "
            + conn_line + " " + web_line + " " + action_line + " "
            "Output a JSON gather plan:\n"
            "- turn_mode: FIRST decide what the user's MESSAGE actually is. 'chat' = a greeting, smalltalk, "
            "thanks, a question about the team/room itself, or any conversational message with NO work "
            "deliverable ('hallo', 'who are you?', 'thanks!', 'what can you do?') — the room just REPLIES "
            "as people; every other field must then be empty/null/false. 'task' = real work is requested. "
            "The ROOM GOAL does NOT make a greeting a task — judge the MESSAGE, not the goal.\n"
            "- execution_engine: 'agentic' when the ask needs a real actor working the problem step by step "
            "with tools — building or generating a concrete asset (an image, a file, a multi-part deliverable "
            "assembled from several tool calls), executing a real multi-step workflow where later steps depend "
            "on what earlier tool calls returned, or open-ended work where the right sequence of tools can't be "
            "decided upfront. 'debate' (default) for everything the current team already does well: answering "
            "a question, producing a report/recommendation/decision from a discussion, drafting one email or "
            "doc from already-gathered context. When in doubt, default to 'debate' — 'agentic' is for tasks "
            "that genuinely need to discover-then-act in a loop, not just any request that uses a tool.\n"
            "- collaboration_intensity: FIRST size how much of the team this ACTIVE MESSAGE needs, never from "
            "the standing Room goal. light = greeting, capability question, quick answer, small copy change, "
            "or tentative/exploratory request; standard = bounded planning, diagnosis, research, or a decision "
            "that benefits from a few specialist views; deep = explicit launch, broad audit, multi-channel plan, "
            "scheduling, analytics, major strategy, or an operating program. A specialist Room does not make a "
            "simple message deep. Evidence breadth is independent from collaboration intensity: a concise request "
            "may need a broad crawl or connector read while still producing a Standard answer with no debate. "
            "Chat is light. Canonical examples: 'Can we run a campaign for law firms?' is light; 'Resolve 4 "
            "critical and 0 high finding(s)' is standard, uses the current/fresh SEO artifact, and needs no debate; "
            "'Launch a 14-day multichannel campaign in France' is deep.\n"
            "- response_depth: the matching deliverable size. light maps to direct, standard maps to focused, "
            "and deep maps to operating. Use that mapping exactly.\n"
            "- evidence_mode: prospecting only when this turn must discover or verify real organisations, "
            "people, or contact coordinates; standard for every other task. Decide from meaning in the user's "
            "language, not from English keywords. Chat always uses standard.\n"
            "- post_output_actions: act like a coding agent selecting tools. After understanding the requested "
            "deliverable, choose zero or more capabilities from POST-OUTPUT ACTION CATALOG below, in execution "
            "order. A content verb such as create, build, prepare, design, write, or produce describes the answer, "
            "not a provider write. Select an action only when the ACTIVE MESSAGE explicitly names the external "
            "destination or provider effect: a stated recipient, workspace, document destination, publication "
            "destination, or save/export target. Discussing a channel or requesting a blueprint, report, persona, "
            "strategy, or plan selects no action by itself. Set explicit=true. target_hint must quote the recipient, "
            "workspace, or destination exactly as it appears in the ACTIVE MESSAGE; use null and select no action "
            "when there is no exact target. A disconnected capability may still be selected when explicitly requested: the UI will offer "
            "connection while the Room finishes the output. For email, choose gmail.create_draft only when the "
            "user explicitly asks to draft, compose, or prepare a draft without delivery. Choose gmail.send_email "
            "for send/reply/forward/deliver requests and for requests to write/email/message a stated recipient; "
            "the centralized write gate will still require approval before delivery.\n"
            "- outreach_request: in an Outreach Room, represent the COMPLETE requested lifecycle instead of treating "
            "a compound request as one report. Set discover when new prospects are requested, persist whenever accepted "
            "prospects must enter the shared lead book, draft when personalized copy is requested, deliver only when the "
            "user explicitly asks to send, and monitor whenever delivery requires reply/follow-up tracking. Preserve an "
            "exact count only when the assignment explicitly states one; otherwise requested_count must be null and the "
            "Room should return every relevant result it can verify plus the actual count. Preserve geography, sector, "
            "audience, and offer. Use null outside Outreach Rooms or for non-operational "
            "questions. This contract is checked deterministically; a sample email or shorter prospect list cannot finish "
            "a larger request.\n"
            "- campaign_request: when this is NOT already a Campaign Room and the user explicitly asks to CREATE, "
            "RUN, START, or SET UP an operational campaign, return its complete brief here. This delegates to a "
            "dedicated Campaign Room, so every gather field must be empty/null and needs_debate=false. Map X to "
            "x_organic, paid X to x_ads, email/Gmail to gmail, calls/TARA to tara, and map explicit paid or organic platforms to their matching channel ID. Use channels=[] when the user did not specify "
            "a channel; Core will select only channels that are connected and executable. Defaults: 14 days, "
            "FOCUSED, APPROVE_PLAN_ONCE. Use null for discussions, analysis, status questions, or when this is "
            "already a Campaign Room. Starting a campaign NEVER means publishing it.\n"
            "- seo_audit_url: ONLY in an SEO Room when live page evidence is needed. For a direct question about "
            "a page's current tag, redirect, heading, rendered content, or status, provide its URL; the runtime "
            "will inspect one page. For focused analysis it inspects a small sample. For an operating audit or "
            "optimization plan it performs the broader crawl. Use a URL VERBATIM from TASK or COMPANY CONTEXT; "
            "never invent or append a path such as /seo-audit. Use null for conceptual questions, outside SEO "
            "Rooms, or when no website is known. A command referring to current finding counts, blockers, fixes, "
            "remediation, or a rescan requires the current/fresh audit URL even when collaboration_intensity is "
            "standard; do not guess issue types from severity counts.\n"
            "- seo_audit_scope: none when seo_audit_url is null; page for one exact-page answer; sample for a "
            "bounded page/template diagnosis; site for a broad audit OR a remediation/rescan command referring "
            "to site-wide finding counts. Audit scope controls evidence breadth, not collaboration intensity.\n"
            "- seo_task: none outside SEO work; inspect for one page/template question; audit for a new health "
            "assessment; remediate for a command to fix/resolve measured findings; rescan to verify changes; "
            "strategy for an explicit SEO growth program. 'Resolve 4 critical and 0 high finding(s)' is remediate.\n"
            "- recall_queries: 1-3 SHORT focused company-brain searches, one per distinct entity/topic in the "
            "task (fewer, sharper beats many). HIVEMIND is the company's memory — if the task NAMES a "
            "specific existing product, feature, decision, or person (even when the user also lists context "
            "inline, e.g. 'prioritize these 4 requests: X, Y, Z'), that name IS a distinct entity worth a "
            "recall query — do not skip recall just because the task looks self-contained on its face. "
            "Empty recall_queries should be rare, not the default.\n"
            "- history_turns_back: the ROOM JOURNAL block below already shows this room's last few real "
            "turns — treat those as settled fact, not a hint. If the CURRENT request is asking what this "
            "room already learned/decided/discussed (\"what did we learn\", \"what did we decide about X\", "
            "\"remind me what we found\"), and the journal window shown does not go back far enough to "
            "answer it, set history_turns_back to how many turns back you actually need (e.g. 15, 30) so "
            "the room's real older history loads before you answer — do NOT re-run gather+debate from "
            "scratch for something this room already settled. Set 0 when the journal already covers it or "
            "the request needs fresh evidence instead.\n"
            "- connector_calls: reads from the listed connector tools. Each item is {name, args_json} where "
            "args_json is a JSON STRING of the tool's arguments, e.g. {\"name\":\"notion__notion-search\","
            "\"args_json\":\"{\\\"query\\\":\\\"HIVEMIND Amar\\\"}\"}. ONLY listed names; [] if none help.\n"
            "- places_query: a Google-Maps business search — set it whenever THIS turn asks to FIND, "
            "DISCOVER, or SOURCE new real firms/prospects/contacts, EVEN WHEN the same request ALSO asks "
            "to draft/send outreach for them. 'Find leads in Hannover and email them' or 'discover "
            "prospects near Hannover and draft personalized emails' are BOTH discovery+drafting in one "
            "request — set places_query for the discovery half; do NOT skip it just because email/outreach "
            "is mentioned in the same sentence. Confirmed live 2026-08-12: this exact confusion made the "
            "room fabricate plausible-sounding company names and emails (e.g. invented 'cfo@db.com') as if "
            "they were recalled real prospects, then drafted a real Gmail send to that fabricated address — "
            "skipping real discovery is what caused it, not a policy that was working correctly. "
            "FORMAT IS STRICT: '<business category> in <city/region>', 3-6 words, nothing else — 'law firms "
            "in Hannover', 'private banks in Frankfurt', 'insurance companies in Amsterdam'. NO verbs, NO "
            "sentences, NO '(e.g. …)', NO 'with contact details' (Maps returns phone+website automatically; "
            "prose queries return junk and waste the API call). Return NULL ONLY when the turn does NOT ask "
            "to find/discover/source any new prospect at all — e.g. it only drafts/reasons over targets "
            "ALREADY identified this turn or already in the lead book, or is a pure strategy/analysis/"
            "decision task with zero new-prospect-finding component. REUSE-FIRST still applies within that: "
            "the company keeps a shared LEAD BOOK — assume existing leads are already in recall context; "
            "don't re-discover leads the company already has UNLESS the user explicitly asks to find NEW/"
            "more ones. When in doubt about whether new discovery is being asked for, prefer setting "
            "places_query — a wasted Maps call is cheap; a fabricated contact is not.\n"
            "- web_query: a single query ONLY for genuinely EXTERNAL/public facts the company brain would not "
            "hold; otherwise null.\n"
            "- needs_debate: false for light work. For standard work, true only when independent specialist "
            "judgment or a material trade-off improves the answer; mechanical remediation of an already measured "
            "issue does not need debate. For deep work, true when strategy, sequencing, budget, channel, risk, or "
            "priority choices must be challenged. A new multi-channel launch, major strategy, or operating plan "
            "therefore uses debate; only execution of an already approved, complete contract may skip it. Debate "
            "is never a ritual.\n"
            "- campaign_method_assignments: ONLY in a Campaign Room, assign up to four bounded jobs to "
            "Strategist, Builder, Skeptic, or Final Synthesizer. Each query describes the advertising method "
            "needed, such as 'organic X copy framework', 'campaign measurement', 'source verification', or "
            "'campaign report'. The Campaign-only claude_ads_load tool searches the complete method library "
            "and loads at most two matching resources per assignment. Use [] outside Campaign Rooms. Do not "
            "request paid-platform methods for an organic-only channel.\n"
            "- work_orders: for a TASK, create the actual bounded work employees must complete AFTER evidence "
            "gathering and BEFORE synthesis. Use [] for chat or a direct answer that needs no independent work. "
            "Standard work gets 1-3 orders; deep work gets 2-5. Each order has ONE owner lane, a concrete "
            "artifact-oriented objective, evidence it must use, and clear acceptance criteria. Do not create "
            "orders for external writes: workers prepare work; the controlled producer performs writes later. "
            "Use a decision order when a genuine trade-off needs a subsequent visible debate.\n"
            "GROUND recall_queries AND web_query in the COMPANY CONTEXT when one is given — reference the company's "
            "own name, products, customers, and market (e.g. 'Acme competitors in <region>', 'prospects for "
            "<product> in <market>'), NEVER a generic industry query."
        )
        if _visual_artifacts_enabled():
            sysp += (
                "\n\nARTIFACT CAPABILITY: artifact_intent may select a designed HTML artifact when "
                "a presentation, explorable document, or dashboard materially "
                "completes the ACTIVE request better than prose. This capability belongs to every Room; decide "
                "from the requested outcome, never the Room name. Use null for normal answers, greetings, email, "
                "or external Docs/Sheets/Notion writes. Preserve the requested medium exactly: use kind=presentation "
                "for a deck, pitch deck, slides, briefing presentation, or slide-by-slide request; use kind=dashboard "
                "only when the user asks for monitoring, a dashboard, console, or recurring metric exploration; "
                "otherwise use kind=interactive_document. Never turn a presentation into a scrolling report or "
                "dashboard. Describe purpose and audience without choosing a theme "
                "or fixed layout. Use creative_freedom=high unless supplied brand constraints require guided."
                " When artifact_intent is not null, choose execution_engine=debate so the governed final-output "
                "adapter receives the complete evidence board instead of returning early through agentic execution."
            )
        if self.domain_pack:
            sysp += (
                f"\n\nDEDICATED ROOM: {self.domain_pack.display_name} "
                f"(pack v{self.domain_pack.version}). These are standing Director instructions:\n"
                f"{self.domain_pack.director_prompt}\n\n"
                f"AVAILABLE DOMAIN TOOLKIT AND TOOL-CALL POLICY:\n{self.domain_pack.toolkit_prompt}\n"
                "Select tools because they close a named evidence gap. The toolkit describes preferred "
                "capabilities, but never claim a connector is available unless it appears in the available list."
            )
        if self.is_work_room:
            sysp += (
                "\n\nWORK ROOM BOUNDARY: This is a human-facing, neutral workspace. "
                "The ROOM GOAL and any historical task label are context, not a domain assignment. "
                "First decide whether the active message is best answered directly, needs targeted evidence, "
                "benefits from independent challenge, needs an internal artifact, or should become a proposed "
                "Runtime lifecycle. Use the smallest useful approach. Do not manufacture a report, a debate, "
                "or employee work orders merely because a room exists. Select method skills from the catalog "
                "by their stated applicability, then load their full bodies only when they improve this request. "
                "For nontrivial work, use turn_plan for up to five bounded steps. Each step has a stable id and "
                "only names prerequisites that must finish before it can start. Independent steps may run together; "
                "omit turn_plan for a direct answer. Keep work_orders empty when turn_plan is present. "
                "Use a step's optional wait only when the step cannot honestly continue without a specific input, "
                "approval, capability, or external event. State the exact reason, an optional concise prompt, and "
                "a stable resume key. A wait pauses the same step; it is not a failure or a completed result. "
                "Use optional handoff only to record a proposed next owner with objective and rationale. A handoff "
                "never invokes another system or authorizes action. "
                "When the active human message explicitly requests a handoff, represent that reviewable decision "
                "as a bounded turn_plan step with handoff metadata rather than an untracked direct answer. "
                "A proposed Runtime lifecycle is a recommendation with its evidence and boundary; it is not an "
                "executed external action.\n"
            )
        if self.room_kind == "campaign":
            from .campaign_contract import campaign_system_contract
            sysp += campaign_system_contract()
        # Progressive-disclosure skill catalog: the planner pays only for names +
        # one-liners; a chosen skill's full method body loads during gather.
        if _METHOD_SKILLS_ENABLED:
            cat = work_skill_catalog() if self.is_work_room else skill_catalog(self.room_kind)
            if cat:
                skill_pick_instruction = (
                    "pick 2-4 METHOD SKILLS" if self.room_kind == "campaign"
                    else "pick 1-2 METHOD SKILLS"
                )
                lessons = ("\nPreviously effective in this room type: "
                           + " | ".join(self.room_playbook)) if self.room_playbook else ""
                sysp += (
                    f"\n- method_skills: {skill_pick_instruction} from this catalog that fit the task "
                    "(their full method loads for the room); [] if none fit:\n"
                    + "\n".join(f"  • {n} — {w}" for n, w in cat) + lessons
                )
        _org = (self.company_brief or "").strip()
        _org_block = (
            "COMPANY CONTEXT — the organisation you are planning for. Ground every query in its identity, "
            "products, customers, and market; do NOT emit generic industry queries:\n" + _org[:1200] + "\n\n"
        ) if _org else ""
        _campaign_policy = ""
        if self.room_kind == "campaign" and self.campaign_brief:
            _campaign_policy = (
                "CAMPAIGN CONTRACT — authoritative structured input; never infer the opposite from TASK prose:\n"
                + json.dumps(self.campaign_brief, ensure_ascii=False)[:4000] + "\n\n")
        _growth_policy = ""
        if self.room_kind == "hq" and "growth-stage-context.v1" in self.execution_context:
            _growth_policy = (
                "AUTHORITATIVE STAGE 2 CONTEXT — plan directly from this evidence. Do not replace its metrics with recall, "
                "invent missing causes, or ask workers to estimate the baseline:\n"
                + self.execution_context[:12000] + "\n\n")
        _work_order_policy = ""
        if self.work_order:
            _work_order_policy = (
                "HQ WORK ORDER — this is a complete assignment from the company control plane. Interpret it with the "
                "same semantic Director used for a human request: choose the relevant domain methods, progressive skills, "
                "company memory, existing durable records, and available tools. HQ defines the outcome and authority; "
                "the Room owns how the specialist work is performed. Work-order mode changes the final audience and "
                "evidence contract, not the Room intelligence. Create one bounded executable work_order that can complete "
                "all safe internal checkpoints in this run. Do not debate operational execution merely for ceremony. "
                "Do not turn the assignment into advice or repeat its wording as a report. If the requested lifecycle "
                "includes an external write, prepare a verified proposed action and stop at the authority boundary; never "
                "claim it executed without a provider receipt. Reuse accepted upstream artifacts and room_checkpoint state "
                "before doing new discovery. Return concrete artifacts, actual counts, evidence, proposed actions, and exact "
                "gaps. Do not invent a quantity when none was supplied:\n"
                + json.dumps(self.work_order, ensure_ascii=False)[:12000] + "\n\n")
        _runtime_stage_policy = ""
        if self.runtime_stage:
            _runtime_stage_policy = (
                "RUNTIME STAGE — this is one checkpointed stage inside a versioned playbook. Use the Room's "
                "normal Director, domain methods, progressive skills, evidence gathering, tools, workers, and "
                "debate when useful. Complete only this stage objective. Do not broaden it into a company-wide "
                "report or invent a future step. The expected artifact names are opaque contract keys, not "
                "instructions to hard-code a domain workflow. Produce evidence-backed work now; the caller will "
                "apply the supplied predicates and choose the next stage:\n"
                + json.dumps(self.runtime_stage, ensure_ascii=False)[:12000] + "\n\n")
        user = f"{_org_block}{_campaign_policy}{_growth_policy}{_work_order_policy}{_runtime_stage_policy}{self._journal_block}{self._room_instr_block}ROOM GOAL: {self.room_goal or '(none)'}\nTASK: {self.user_message}"
        msg = await self._groq([{"role": "system", "content": sysp}, {"role": "user", "content": user}],
                               model=self.director_model, temp=0.3, schema=schema, bucket="director")
        self.director_iters.append(self._last_tok)
        try:
            plan = json.loads((msg or {}).get("content") or "{}")
        except Exception:  # noqa: BLE001
            plan = {}
        if not isinstance(plan, dict):
            plan = {}
        if _visual_artifacts_enabled() and isinstance(plan.get("artifact_intent"), dict):
            raw_intent = plan["artifact_intent"]
            artifact_kind = str(raw_intent.get("kind") or "interactive_document").strip()
            if artifact_kind not in {"presentation", "interactive_document", "dashboard"}:
                artifact_kind = "interactive_document"
            self.artifact_intent = {
                "contract": "artifact-intent.v1",
                "kind": artifact_kind,
                "medium": "html",
                "purpose": str(raw_intent.get("purpose") or "visual deliverable").strip()[:240],
                "audience": str(raw_intent.get("audience") or "intended reader").strip()[:160],
                "quality_profile": str(raw_intent.get("quality_profile") or "editorial").strip(),
                "creative_freedom": str(raw_intent.get("creative_freedom") or "high").strip(),
                "requirements": [
                    str(item).strip()[:240]
                    for item in (raw_intent.get("requirements") or [])
                    if str(item).strip()
                ][:12],
            }
        else:
            self.artifact_intent = None
        intensity = str(plan.get("collaboration_intensity") or "").strip().lower()
        if intensity not in {"light", "standard", "deep"}:
            legacy_depth = str(plan.get("response_depth") or "focused").strip().lower()
            intensity = {"direct": "light", "focused": "standard", "operating": "deep"}.get(
                legacy_depth, "standard")
        depth = {"light": "direct", "standard": "focused", "deep": "operating"}[intensity]
        plan["collaboration_intensity"] = intensity
        if depth not in {"direct", "focused", "operating"}:
            depth = "focused"
        plan["response_depth"] = depth
        evidence_mode = str(plan.get("evidence_mode") or "standard").strip().lower()
        plan["evidence_mode"] = evidence_mode if evidence_mode in {"standard", "prospecting"} else "standard"
        actions: List[Dict[str, Any]] = []
        connected = {_norm_connector(connector) for connector in self.connectors}
        for action in (plan.get("post_output_actions") or [])[:4]:
            if not isinstance(action, dict) or action.get("explicit") is not True:
                continue
            capability = str(action.get("capability") or "").strip()
            spec = _POST_OUTPUT_CAPABILITIES.get(capability)
            if not spec:
                continue
            target_hint = str(action.get("target_hint") or "").strip()
            if spec["artifact_kind"] in {"doc", "sheet", "notion"}:
                message = str(self.user_message or "")
                if (
                    not target_hint
                    or target_hint.casefold() not in message.casefold()
                    or not re.search(str(spec.get("request_pattern") or r"(?!)"), message, re.IGNORECASE)
                ):
                    continue
            actions.append({
                "capability": capability,
                "connector": spec["connector"],
                "operation": spec["operation"],
                "artifact_kind": spec["artifact_kind"],
                "target_hint": target_hint or None,
                "explicit": True,
                "connected": any(_norm_connector(alias) in connected for alias in spec["aliases"]),
            })
        plan["post_output_actions"] = actions
        outreach = plan.get("outreach_request") if self.room_kind == "outreach" else None
        if isinstance(outreach, dict):
            raw_requested_count = outreach.get("requested_count")
            requested_count = (
                max(1, min(50, int(raw_requested_count)))
                if raw_requested_count is not None else None
            )
            plan["outreach_request"] = {
                "requested_count": requested_count,
                "geography": str(outreach.get("geography") or "").strip()[:160] or None,
                "sector": str(outreach.get("sector") or "").strip()[:240] or None,
                "audience": str(outreach.get("audience") or "").strip()[:240] or None,
                "offer": str(outreach.get("offer") or "").strip()[:240] or None,
                "discover": bool(outreach.get("discover")),
                "persist": bool(outreach.get("persist")),
                "draft": bool(outreach.get("draft")),
                "deliver": bool(outreach.get("deliver")),
                "monitor": bool(outreach.get("monitor")),
            }
        else:
            plan["outreach_request"] = None
        rq = [q for q in (plan.get("recall_queries") or []) if isinstance(q, str) and q.strip()][:3]
        if self.room_kind == "campaign":
            rq = [q for q in rq if self._campaign_recall_query_is_grounded(q)]
        # An empty list is a valid Director decision. Company context is already
        # present in the synthesis prompt, so a fixed recall here only adds latency,
        # tokens, and stale-memory risk to Light turns.
        plan["recall_queries"] = rq
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
        if self.room_kind == "campaign" and plan["web_query"]:
            if not self._campaign_recall_query_is_grounded(plan["web_query"]):
                plan["web_query"] = None
        audit_url = plan.get("seo_audit_url") if self.room_kind == "seo" else None
        audit_scope = str(plan.get("seo_audit_scope") or "none").strip().lower()
        if audit_scope not in {"none", "page", "sample", "site"}:
            audit_scope = "none"
        context_urls = re.findall(
            r"https?://[^\s<>\]\[\)\(\"']+",
            f"{self.user_message or ''}\n{self.company_brief or ''}", re.I,
        )
        context_urls = [value.rstrip(".,;") for value in context_urls]
        if isinstance(audit_url, str) and audit_url.strip() and context_urls:
            requested = audit_url.strip().rstrip(".,;")
            if requested not in context_urls:
                # The Director selected the SEO capability but invented a path.
                # Resolve it to supplied context instead of crawling guessed URLs.
                audit_url = context_urls[0]
            if audit_scope == "site":
                parsed = urlsplit(str(audit_url))
                audit_url = f"{parsed.scheme}://{parsed.netloc}/" if parsed.scheme and parsed.netloc else audit_url
        # The Director selects the audit lane semantically in the user's language.
        # Runtime only supplies the canonical onboarded URL for an operating audit.
        if (self.room_kind == "seo" and audit_scope == "site"
                and not (isinstance(audit_url, str) and audit_url.strip())):
            candidate = f"{self.user_message or ''}\n{self.company_brief or ''}"
            match = re.search(r"https?://[^\s<>\]\[\)\(\"']+", candidate, re.I)
            audit_url = match.group(0).rstrip(".,;") if match else None
        plan["seo_audit_url"] = audit_url if isinstance(audit_url, str) and audit_url.startswith(("http://", "https://")) else None
        plan["seo_audit_scope"] = audit_scope if plan["seo_audit_url"] else "none"
        seo_task = str(plan.get("seo_task") or "none").strip().lower()
        plan["seo_task"] = seo_task if seo_task in {
            "none", "inspect", "audit", "remediate", "rescan", "strategy",
        } else "none"
        plan["seo_audit_page_limit"] = {"none": 0, "page": 1, "sample": 8, "site": 25}[
            plan["seo_audit_scope"]
        ]
        # Recall and external research remain exactly what the structured Director
        # selected; runtime does not reinterpret multilingual intent with keywords.
        pq = plan.get("places_query")
        _places_on = bool(os.environ.get("GOOGLE_MAPS_API_KEY") or os.environ.get("HYPER_PLACES_KEY"))
        # The structured Director is the sole semantic gate. Runtime code only
        # enforces availability and shape; it never reclassifies multilingual intent.
        plan["places_query"] = pq if isinstance(pq, str) and pq.strip() and _places_on else None
        if self.room_kind == "seo":
            plan["places_query"] = None
        # Method skills: keep only real catalog names; auto-load the kind default
        # when the plan picked none (mirrors the polished-email auto-load).
        skill_limit = 4 if self.room_kind == "campaign" else 2
        ms = [s for s in (plan.get("method_skills") or [])
              if isinstance(s, str) and load_method_skill(s)][:skill_limit]
        if self.room_kind == "campaign" and "campaign-operating-system" not in ms:
            ms = ["campaign-operating-system", *ms][:skill_limit]
        if self.work_order and not ms:
            typed_defaults = {
                "outreach": "prospect-qualification",
                "outreach_growth": "prospect-qualification",
            }
            fallback_skill = typed_defaults.get(
                str((self.work_order or {}).get("kind") or "").strip().lower(),
                default_skill_for(self.room_kind),
            )
            if fallback_skill and load_method_skill(fallback_skill):
                ms = [fallback_skill]
        # Skills are event-driven. Campaign keeps its mandatory operating method
        # above. HQ work orders use the typed room default only when the Director
        # selected none, so specialist execution is never method-free.
        plan["method_skills"] = ms if _METHOD_SKILLS_ENABLED else []
        assignments: List[Dict[str, str]] = []
        if self.room_kind == "campaign":
            for row in (plan.get("campaign_method_assignments") or [])[:4]:
                if not isinstance(row, dict):
                    continue
                role = str(row.get("role") or "Specialist").strip()[:40]
                task = str(row.get("task") or "").strip()[:240]
                query = str(row.get("query") or task).strip()[:240]
                if task and query:
                    assignments.append({"role": role, "task": task, "query": query})
            if not assignments:
                assignments = [
                    {"role": "Strategist", "task": "Select the campaign strategy", "query": "campaign strategy media plan"},
                    {"role": "Builder", "task": "Build the channel-ready content", "query": "organic social copy framework"},
                    {"role": "Skeptic", "task": "Verify campaign evidence", "query": "source verification campaign"},
                    {"role": "Final Synthesizer", "task": "Define measurement and the operating report", "query": "campaign measurement report"},
                ]
        plan["campaign_method_assignments"] = assignments
        work_orders: List[Dict[str, Any]] = []
        limit = 5 if intensity == "deep" else 3 if intensity == "standard" else 1
        valid_lanes = {"Strategist", "Researcher", "Skeptic", "Builder", "Communicator"}
        valid_kinds = {"research", "analysis", "creative", "decision"}
        for row in (plan.get("work_orders") or [])[:limit]:
            if not isinstance(row, dict):
                continue
            title = str(row.get("title") or "").strip()[:180]
            objective = str(row.get("objective") or "").strip()[:600]
            if not title or not objective:
                continue
            kind = str(row.get("kind") or "analysis").strip().lower()
            lane = str(row.get("owner_lane") or "Strategist").strip().title()
            work_orders.append({
                "kind": kind if kind in valid_kinds else "analysis",
                "owner_lane": lane if lane in valid_lanes else "Strategist",
                "title": title,
                "objective": objective,
                "required_evidence": [str(x)[:160] for x in (row.get("required_evidence") or []) if str(x).strip()][:4],
                "acceptance_criteria": [str(x)[:180] for x in (row.get("acceptance_criteria") or []) if str(x).strip()][:4],
            })
        plan["work_orders"] = work_orders
        turn_plan: List[Dict[str, Any]] = []
        if self.is_work_room:
            seen_step_ids = set()
            for index, row in enumerate(plan.get("turn_plan") or []):
                if not isinstance(row, dict):
                    continue
                step_id = str(row.get("id") or "").strip().lower()[:80]
                if not re.fullmatch(r"[a-z][a-z0-9_-]{0,79}", step_id) or step_id in seen_step_ids:
                    continue
                title = str(row.get("title") or "").strip()[:180]
                objective = str(row.get("objective") or "").strip()[:600]
                if not title or not objective:
                    continue
                dependencies = [str(value).strip().lower()[:80] for value in (row.get("depends_on") or [])
                                if str(value).strip()][:4]
                turn_plan.append({
                    "id": step_id,
                    "depends_on": dependencies,
                    "kind": str(row.get("kind") or "analysis").strip().lower(),
                    "owner_lane": str(row.get("owner_lane") or "Strategist").strip().title(),
                    "title": title,
                    "objective": objective,
                    "required_evidence": [str(x)[:160] for x in (row.get("required_evidence") or []) if str(x).strip()][:4],
                    "acceptance_criteria": [str(x)[:180] for x in (row.get("acceptance_criteria") or []) if str(x).strip()][:4],
                    "wait": _normalize_work_step_wait(row.get("wait")),
                    "handoff": _normalize_work_step_handoff(row.get("handoff")),
                })
                seen_step_ids.add(step_id)
                if len(turn_plan) == 5:
                    break
            # A plan cannot wait on an absent step or itself. Invalid dependencies
            # become explicit no-ops rather than silently creating a deadlocked Room.
            valid_ids = {step["id"] for step in turn_plan}
            for step in turn_plan:
                step["depends_on"] = [item for item in step["depends_on"]
                                      if item in valid_ids and item != step["id"]]
            if turn_plan:
                plan["work_orders"] = []
        plan["turn_plan"] = turn_plan
        plan["needs_debate"] = bool(plan.get("needs_debate"))
        if intensity == "deep":
            plan["needs_debate"] = True
        if intensity == "light":
            # Direct is a product contract, not a suggestion to the model. One
            # bounded question never convenes a committee or fans out a broad
            # evidence plan. The planner still chooses the one relevant source.
            plan["recall_queries"] = plan["recall_queries"][:1]
            plan["connector_calls"] = plan["connector_calls"][:1]
            plan["method_skills"] = plan["method_skills"][:1]
            plan["places_query"] = None
            plan["needs_debate"] = False
            if plan.get("seo_audit_url"):
                plan["web_query"] = None
            plan["work_orders"] = plan["work_orders"][:1]
        if self.work_order:
            # HQ execution is a separate envelope-gated mode. Human turns never
            # reach this branch and retain their existing plan verbatim.
            plan["turn_mode"] = "task"
            plan["needs_debate"] = False
            plan["response_depth"] = "focused"
            plan["collaboration_intensity"] = "standard"
            plan["campaign_request"] = None
            # Runtime assignments keep the semantic lifecycle and action intent
            # selected by the Room Director. HQ does not dictate a tool sequence,
            # and the Room does not execute external writes without authority.
            plan["work_orders"] = plan["work_orders"][:1]
        log.info("[hyper-engine] plan intensity=%s recalls=%d connectors=%d web=%s debate=%s",
                 intensity,
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
        if fn == "seo_audit":
            site = str(args.get("url") or "")[:80]
            return (f"auditing the website evidence for “{site}”…",
                    f"Completed the deterministic SEO scan for “{site}”.")
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
            result = await self._exec(fn, args)
            if self.runtime_stage and str(result or "").strip():
                # A checkpointed stage must compile from the actual tool payload,
                # not from the human-friendly activity bubble emitted above it.
                self.blackboard.append(f"TOOL_RESULT[{fn}]:\n{str(result)[:12000]}")
            if fn == "seo_audit":
                try:
                    audit_result = json.loads(result or "{}")
                except Exception:
                    audit_result = {}
                if audit_result.get("is_error"):
                    raise RuntimeError(str(audit_result.get("error") or "SEO audit did not complete"))
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
        # Progressive room-history load: the eager journal window (_JOURNAL_KEEP,
        # already in every prompt) covers only the last few turns. When the
        # planner recognizes a direct "what did we learn/decide" question that
        # needs to go further back, this pulls real older turns on demand —
        # same progressive pattern as method_skills, storage no longer
        # destructively capped at the eager window (see append_room_journal_entry).
        _history_back = int(plan.get("history_turns_back") or 0)
        if _history_back > 0:
            _hist_json = await self._load_room_history(_history_back)
            try:
                _hist = json.loads(_hist_json)
            except Exception:
                _hist = {}
            for entry in (_hist.get("history") or [])[:_history_back]:
                agent_notes = "; ".join(
                    f"{a.get('name')}: {a.get('contribution')}" for a in (entry.get("agents") or [])
                    if isinstance(a, dict) and a.get("name")
                )
                row = f"- ROOM HISTORY — Asked: {entry.get('asked', '')} | Swarm: {entry.get('swarm_summary', '')}"
                if agent_notes:
                    row += f" | Agents: {agent_notes}"
                self.blackboard.append(row[:900])
            await self.emit({"t": "gather", "sources": ["room_history"],
                             "memory_hits": len(_hist.get("history") or []),
                             "connector_hits": [], "contacts": 0, "correspondence": 0})
        campaign_method_count = 0
        if self.room_kind == "campaign" and plan.get("campaign_method_assignments"):
            from .claude_ads_toolkit import load_assignments
            for loaded in load_assignments(plan["campaign_method_assignments"]):
                self.blackboard.append(
                    f"CAMPAIGN_METHOD[{loaded['role']} | {loaded['task']} | {loaded['resource']}]:\n{loaded['body']}"
                )
                await self.emit({
                    "t": "campaign_method_used",
                    "role": loaded["role"],
                    "task": loaded["task"],
                    "resource": loaded["resource"],
                })
                await self.emit({
                    "t": "skill_used",
                    "skill": loaded["task"] or loaded["description"],
                    "agent_role": loaded["role"],
                    "room_kind": "campaign",
                    "source": "campaign_toolkit",
                })
                campaign_method_count += 1
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
        if plan.get("seo_audit_url"):
            tasks.append(self._gather_one("seo_audit", {
                "url": plan["seo_audit_url"],
                "page_limit": int(plan.get("seo_audit_page_limit") or 25),
            },
                                          owner=self._gather_owner(_i, "web_search"))); _i += 1
        if plan.get("places_query"):
            tasks.append(self._gather_one("places_search", {"query": plan["places_query"]},
                                          owner=self._gather_owner(_i, "web_search")))
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        return len(tasks) + campaign_method_count

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

    def _room_journal_context(self) -> str:
        """Eager continuity window for planning and synthesis — the last
        _JOURNAL_KEEP entries, unconditionally injected every turn. These ARE
        this room's real prior decisions, not a soft consistency hint: a
        question asking what the room already learned/decided should be
        answered FROM this directly, not treated as secondary to a fresh
        gather. If a question needs more history than fits here, the
        load_room_history tool pulls further back on demand — this block is
        the near-term window, not the room's only memory of itself."""
        if not _JOURNAL_ENABLED or not self.room_journal:
            return ""
        rows = []
        for entry in self.room_journal:
            agent_notes = "; ".join(
                f"{a.get('name')}: {a.get('contribution')}"
                for a in (entry.get("agents") or [])[:5] if isinstance(a, dict)
            )
            row = (f"- Asked: {entry.get('asked', '')} | Swarm: {entry.get('swarm_summary', '')}"
                   + (f" | Agents: {agent_notes}" if agent_notes else ""))
            rows.append(row[:900])
        latest_entry = self.room_journal[-1]
        latest = str(latest_entry.get("final_report_excerpt") or "").strip()[:1800]
        # Real gap (2026-08-23): this journal used to carry only what the room SAID
        # last time, never what was WRONG with it — so a fresh turn on the same
        # topic repeated the same unbacked numbers and hit the same dead verifier.
        # Surfacing the last verdict explicitly turns "what did we say" into "what
        # must this turn actually fix."
        _last_verification = latest_entry.get("verification") if isinstance(latest_entry.get("verification"), dict) else None
        verification_block = ""
        if _last_verification:
            _bits = []
            if not _last_verification.get("verification_available", True):
                _bits.append("quality verification could NOT run last turn (verifier failure) — treat its output as unconfirmed")
            if not _last_verification.get("grounded_ok", True):
                _bits.append("the last turn's claims were flagged as NOT grounded")
            for g in _last_verification.get("gaps") or []:
                _bits.append(f"gap: {g}")
            for c in _last_verification.get("unsupported_claims") or []:
                _bits.append(f"unsupported claim: {c}")
            if _bits:
                verification_block = (
                    "\n\nWHAT WAS WRONG LAST TURN (fix this, do not repeat it):\n"
                    + "\n".join(f"- {b}" for b in _bits[:8])
                )
        return (
            "\nROOM JOURNAL — this room's actual prior turns, most recent last. These are "
            "REAL decisions this room already made, not background color: if the current "
            "request is asking what the room learned/decided/discussed before, ANSWER FROM "
            "THIS DIRECTLY — do not re-run a fresh gather+debate for something already "
            "settled here. Only gather fresh evidence for what this journal does NOT cover. "
            f"If this window doesn't go back far enough, call load_room_history for more:\n"
            + "\n".join(rows)
            + (f"\n\nLATEST FINAL REPORT EXCERPT:\n{latest}" if latest else "")
            + verification_block + "\n"
        )

    async def _load_room_history(self, turns_back: int) -> str:
        """On-demand progressive load of room history beyond the eager
        _JOURNAL_KEEP window — the same pattern as load_method_skill: a small
        summary is always present, the full depth is fetched only when a
        question actually needs it. Storage itself is no longer destructively
        capped at the eager window (see append_room_journal_entry) — real
        older turns exist to load."""
        if not self.room_id or not self.org_id:
            return json.dumps({"error": "no room to load history from"})
        bounded = max(1, min(200, int(turns_back or 20)))
        try:
            entries = await get_room_journal(self.room_id, self.org_id, limit=bounded)
        except Exception as exc:  # noqa: BLE001
            return json.dumps({"error": str(exc)[:200]})
        rows = [
            {
                "asked": entry.get("asked", ""),
                "swarm_summary": entry.get("swarm_summary", ""),
                "agents": [
                    {"name": a.get("name"), "contribution": a.get("contribution")}
                    for a in (entry.get("agents") or [])[:5] if isinstance(a, dict)
                ],
            }
            for entry in entries if isinstance(entry, dict)
        ]
        return json.dumps({"turns_returned": len(rows), "history": rows}, ensure_ascii=False)

    def _campaign_requirements(self) -> Tuple[List[str], List[str]]:
        source = self.campaign_brief.get("channels") or self.campaign_brief.get("requestedChannels") or []
        channels = [str(value).strip().lower() for value in source if str(value).strip()] if isinstance(source, list) else []
        # Compatibility for non-control-plane campaign callers during rollout.
        if not channels:
            match = re.search(r"^CHANNELS:\s*(.+)$", self.user_message or "", re.M | re.I)
            if match:
                channels = [x.strip().lower() for x in match.group(1).split(",") if x.strip()]
        # Confirmed live 2026-08-13: a campaign room whose brief never carried
        # `channels` (created outside the channel-picker flow, e.g. a free-text
        # "Launch X Campaign" ask) reached the compiler with channels=[]. The
        # compiler correctly produced an empty actions/media_plan for zero
        # requested channels, governance correctly rejected it, and the repair
        # loop's guard (`_repair_campaign_actions`) has nothing to key off when
        # NO action/field/channel-deficit signal exists — an empty bundle isn't
        # a few broken actions, it's a missing precondition repair can't fix.
        # Infer a real channel instead of asking the compiler to build a plan
        # for zero channels: prefer whatever this room actually has connected,
        # else default to x_organic — the one channel the contract can validate
        # with no connector/token at all (publish is still gated by the room's
        # own approval flow downstream; this only unblocks PLANNING).
        if not channels:
            _connector_channel = {
                "gmail": "gmail", "google-mail": "gmail",
                "x": "x_organic", "x-twitter": "x_organic", "twitter": "x_organic",
                "linkedin": "linkedin", "instagram": "instagram", "facebook": "facebook",
                "tiktok": "tiktok", "youtube": "youtube",
            }
            inferred = list(dict.fromkeys(
                _connector_channel[c] for c in (self.connectors or []) if c in _connector_channel
            ))
            channels = inferred or ["x_organic"]
            log.info("[hyper-engine] campaign brief carried no channels — inferred %s", channels)
        return channels, ["goal"] + [f"channel:{channel}" for channel in channels]

    @staticmethod
    def _campaign_bundle_errors(bundle: Any, channels: List[str], requirements: List[str]) -> List[str]:
        from .campaign_contract import campaign_bundle_errors
        return campaign_bundle_errors(bundle, channels, requirements)

    @staticmethod
    def _campaign_action_ids_from_errors(errors: List[str], actions: List[Dict[str, Any]]) -> List[str]:
        """Return only action IDs explicitly implicated by governance errors."""
        action_ids = [str(action.get("id") or "").strip() for action in actions if isinstance(action, dict)]
        return [
            action_id
            for action_id in action_ids
            if action_id and any(re.search(rf"\b{re.escape(action_id)}\b", str(error)) for error in errors)
        ]

    def _campaign_action_deficits(self, actions: List[Dict[str, Any]]) -> Dict[str, int]:
        """Return only cadence minimum shortfalls declared by the campaign brief."""
        brief = self.campaign_brief if isinstance(self.campaign_brief, dict) else {}
        payload = brief.get("brief") if isinstance(brief.get("brief"), dict) else brief
        cadence = payload.get("cadence") if isinstance(payload.get("cadence"), dict) else {}
        expected = cadence.get("expected_actions_by_channel")
        expected = expected if isinstance(expected, dict) else {}
        deficits: Dict[str, int] = {}
        for channel, bounds in expected.items():
            if not isinstance(bounds, dict):
                continue
            minimum = max(0, int(bounds.get("minimum") or 0))
            actual = sum(
                1 for action in actions
                if str(action.get("channel") or "").strip().lower() == str(channel).strip().lower()
            )
            if actual < minimum:
                deficits[str(channel)] = minimum - actual
        return deficits

    async def _repair_campaign_actions(
        self,
        *,
        semantic: Dict[str, Any],
        report: str,
        errors: List[str],
        system_contract: str,
    ) -> Optional[Dict[str, Any]]:
        """Repair only named invalid actions or semantic fields.

        Governance may reject a complete action sequence because one bounded
        top-level evidence field is absent. Treating that as terminal made the
        Room fail despite having the required facts on its board. The patch call
        can see and replace only fields named by the unmet criteria; the full
        assembled bundle is then governed again.
        """
        actions = [action for action in (semantic.get("actions") or []) if isinstance(action, dict)]
        action_ids = self._campaign_action_ids_from_errors(errors, actions)
        action_deficits = self._campaign_action_deficits(actions)
        semantic_fields = {
            "strategy", "strategy_options", "selected_strategy_id", "company_grounding",
            "positioning", "audience", "content_pillars", "kpis", "evidence",
            "creative_system", "measurement", "debate_conflicts_present",
            "debate_decisions", "assumptions", "risks",
        }
        relevant_fields = {
            name: semantic.get(name)
            for name in semantic_fields
            if any(name in str(error).lower() or name.replace("_", " ") in str(error).lower() for error in errors)
        }
        if not action_ids and not relevant_fields and not action_deficits:
            return None
        invalid_actions = [action for action in actions if str(action.get("id") or "") in action_ids]
        repair_prompt = (
            system_contract
            + "\n\nYou are repairing only named parts of a Campaign Contract after deterministic governance. "
            'Return JSON only as {"actions":[<complete replacement action objects>],"added_actions":[<new complete action objects>],"fields":{<named top-level field>:<replacement>}}. '
            "Return exactly one complete replacement for each requested action ID and no other actions. In fields, "
            "return every supplied field and no field that was not supplied. "
            "In added_actions, return exactly the declared missing count for each supplied channel, with new unique IDs; "
            "return an empty list when no additions are requested. "
            "Keep each action ID, channel, schedule position, hypothesis, and strategic job unchanged unless an unmet "
            "criterion explicitly requires changing that field. Build missing proof/fact lists only from VERIFIED CONTEXT "
            "and EVIDENCE BOARD below. Correct only the stated unmet criteria. Do not add facts, claims, URLs, recipients, "
            "channels, actions, performance, or provider state."
        )
        repair_user = (
            f"UNMET CRITERIA:\n{json.dumps(errors, ensure_ascii=False)}\n\n"
            f"ACTIONS TO REPAIR:\n{json.dumps(invalid_actions, ensure_ascii=False)}\n\n"
            f"FIELDS TO REPAIR:\n{json.dumps(relevant_fields, ensure_ascii=False)}\n\n"
            f"EXACT ACTIONS TO ADD BY CHANNEL:\n{json.dumps(action_deficits, ensure_ascii=False)}\n\n"
            f"ACCEPTED PLAN CONTEXT (read only):\n"
            f"{json.dumps({k: v for k, v in semantic.items() if k not in {'actions', *relevant_fields}}, ensure_ascii=False)[:6000]}\n\n"
            f"VERIFIED COMPANY CONTEXT:\n{self.company_brief[:2500]}\n\n"
            f"EVIDENCE BOARD:\n{'\n'.join(self.blackboard)[:5000]}"
        )
        repaired_message = await self._groq(
            [{"role": "system", "content": repair_prompt}, {"role": "user", "content": repair_user}],
            force_text=True,
            model=self.synth_model,
            bucket="synth_repair",
            temp=0.1,
            uncapped=True,
            json_object=True,
        )
        repaired_payload = _first_json_object(str((repaired_message or {}).get("content") or "").strip())
        replacements = repaired_payload.get("actions") if isinstance(repaired_payload, dict) else None
        added_actions = repaired_payload.get("added_actions", []) if isinstance(repaired_payload, dict) else None
        patched_fields = repaired_payload.get("fields", {}) if isinstance(repaired_payload, dict) else None
        if not isinstance(replacements, list) or not isinstance(added_actions, list) or not isinstance(patched_fields, dict):
            return None
        replacement_by_id = {
            str(action.get("id") or ""): action
            for action in replacements
            if isinstance(action, dict) and str(action.get("id") or "") in action_ids
        }
        if set(replacement_by_id) != set(action_ids) or set(patched_fields) != set(relevant_fields):
            return None
        added_by_channel: Dict[str, int] = {}
        existing_ids = {str(action.get("id") or "") for action in actions}
        for action in added_actions:
            if not isinstance(action, dict):
                return None
            action_id = str(action.get("id") or "").strip()
            channel = str(action.get("channel") or "").strip().lower()
            if not action_id or action_id in existing_ids or channel not in action_deficits:
                return None
            existing_ids.add(action_id)
            added_by_channel[channel] = added_by_channel.get(channel, 0) + 1
        if added_by_channel != {str(channel).lower(): count for channel, count in action_deficits.items()}:
            return None
        repaired_semantic = dict(semantic)
        repaired_semantic["actions"] = [
            replacement_by_id.get(str(action.get("id") or ""), action)
            for action in actions
        ] + added_actions
        repaired_semantic.update({name: patched_fields[name] for name in relevant_fields})
        return repaired_semantic

    @staticmethod
    def _campaign_semantic_plan(envelope: Any) -> Dict[str, Any]:
        """Read the compiler's semantic plan without throwing valid work away.

        JSON-object mode guarantees an object, not a particular wrapper. Some
        supported models follow ``{"plan": {...}}`` literally while others
        return the requested plan fields at the top level. Both are the same
        Campaign Contract input; accepting either shape keeps model formatting
        variance outside lifecycle governance.
        """
        if not isinstance(envelope, dict):
            return {}
        wrapped = envelope.get("plan")
        if isinstance(wrapped, dict) and wrapped:
            return wrapped
        semantic_fields = {
            "objective", "strategy", "strategy_options", "selected_strategy_id",
            "company_grounding", "positioning", "audience", "content_pillars",
            "kpis", "actions", "measurement", "debate_conflicts_present",
            "debate_decisions", "evidence", "creative_system", "assumptions", "risks",
        }
        if semantic_fields.intersection(envelope):
            return {key: value for key, value in envelope.items() if key in semantic_fields}
        return {}

    async def _synthesize_campaign_bundle(self, forced_debate: bool, transcript_json: str) -> Tuple[Optional[Dict[str, Any]], List[str]]:
        channels, requirements = self._campaign_requirements()
        board = "\n".join(self.blackboard)[:6000] or "(no grounded facts were gathered)"
        brief_payload = self.campaign_brief.get("brief") if isinstance(self.campaign_brief.get("brief"), dict) else self.campaign_brief
        duration_days = max(1, int(brief_payload.get("duration_days") or 14))
        last_action_minimum = max(0, (duration_days - 2) * 1440)
        last_action_maximum = max(0, (duration_days - 1) * 1440)
        from .campaign_contract import (
            CAMPAIGN_CONTRACT_VERSION,
            assemble_campaign_bundle,
            campaign_system_contract,
        )
        system = (
            campaign_system_contract() + "\n\n"
            "You are the final Campaign Intelligence compiler. Return one compact JSON object with exactly plan. "
            "The structured Campaign dashboard is the operating report; do not generate a second prose report. "
            "Provide only the semantic campaign judgment needed to operate it. Never publish. Product code adds identifiers, timeline "
            "rows, payload mirrors, safety scaffolding, launch controls, and requirement coverage; it does not repair "
            "missing strategy, evidence, copy, timing, hypotheses, or action controls. "
            "Do not repeat internal prompts, method names, or IDs. "
            "Required plan shape: {objective:string,strategy:string,"
            "strategy_options:[{id:string,name:string,thesis:string,tradeoff:string}],selected_strategy_id:string,"
            "company_grounding:{company_name:string,facts_used:string[],unknowns:string[]},"
            "positioning:{statement:string,proof_points:string[]},"
            "audience:{rationale:string,segments:array,safety_notes:array},"
            "content_pillars:string[],kpis:[{name:string,target:string,source:string,target_type:baseline|proposed|verified,evidence_ids:string[]}],"
            "actions:[{id:string,channel:string,title:string,format:string,final_copy:string,payload:object,scheduled_offset_minutes:integer,rationale:string,"
            "creative_brief:{required:boolean,concept:string,alt_text:string},"
            "claim_status:verified|no_claim,evidence_ids:string[],hypothesis_id:string,dependencies:string[],"
            "success_measure:string,rollback_or_exit:string}],"
            "measurement:{primary_kpi:string,attribution_limit:string,review_cadence:string},debate_conflicts_present:boolean,"
            "debate_decisions:[{conflict:string,decision:string,rationale:string,dissent:string}],"
            "evidence:[{id:string,claim:string,source:string,status:verified|assumption|missing,url:string,source_type:string,confidence:string}],"
            "creative_system:{approved_claim_ids:string[],hypotheses:[{id:string,insight:string,promise:string,hook:string,cta:string,channels:string[],experiment_hypothesis:string}]},"
            "assumptions:string[],risks:string[]}. "
            "Record material debate decisions. Generate the full action range for every selected channel. Every action "
            "must reference a declared hypothesis and contain rationale, dependencies, success_measure, and rollback_or_exit. "
            "Executable actions may use only claim_status verified or no_claim: verified requires directly supporting "
            "verified evidence_ids; no_claim copy must contain no customer, performance, numerical, compliance, or outcome "
            "claim and must avoid outcome verbs such as help, deliver, drive, improve, increase, reduce, achieve, or accelerate. "
            "Keep assumptions in plan.assumptions, never in final_copy. Every KPI must label its target_type. "
            "No placeholders or invented URLs. "
            "NON-NEGOTIABLE COMPLETENESS: include at least three genuinely different strategy_options, set selected_strategy_id "
            "to one of them, give every creative hypothesis a CTA, and include every required action before returning. "
            "For Gmail payload include verified to, subject, and recipient_policy. For TARA include verified E.164 to, "
            "opening, goal, context, language, lawful_basis, country, timezone, and calling_window; TARA speaks first. "
            "Generate the full action range in the normalized brief for every selected channel. Prefer a coherent "
            "sequence with distinct jobs over repetitive variants. Never copy company facts from another organisation. "
            f"For this {duration_days}-day campaign, scheduled_offset_minutes starts at 0 and the final action must be "
            f"between {last_action_minimum} and {last_action_maximum} inclusive so the sequence spans the promised horizon. "
            "Targets without verified historical evidence must be labeled proposed, never described as expected results. "
            f"Selected channels: {channels}. Required requirement ids: {requirements}."
        )
        user = (f"USER CAMPAIGN BRIEF:\n{self.user_message}\n\nNORMALIZED BRIEF:\n{json.dumps(self.campaign_brief, ensure_ascii=False)[:3500]}\n\nCOMPANY CONTEXT:\n{self.company_brief[:2000]}\n{self._journal_block}\n"
                f"GATHERED BOARD:\n{board}\n\nDEBATE:\n{transcript_json[:3000] if forced_debate else '(not forced)'}")
        msg = await self._groq(
            [{"role": "system", "content": system}, {"role": "user", "content": user}],
            force_text=True,
            model=self.synth_model,
            bucket="synth",
            temp=0.2,
            uncapped=True,
            json_object=True,
        )
        envelope = _first_json_object(str((msg or {}).get("content") or "").strip())
        # Campaign v5 has one output: the structured dashboard bundle. There is
        # deliberately no parallel prose report to drift from its final copy.
        report = ""
        semantic = self._campaign_semantic_plan(envelope)
        for index, action in enumerate(semantic.get("actions") or []):
            if isinstance(action, dict):
                action["id"] = str(action.get("id") or f"action_{index + 1}")
        candidate = assemble_campaign_bundle(
            semantic, channels=channels, requirements=requirements, campaign_brief=self.campaign_brief,
        )
        candidate["report_markdown"] = report
        from .campaign_contract import campaign__govern_delivery
        accepted, governance = campaign__govern_delivery(
            candidate,
            channels=channels,
            requirements=requirements,
            minimum_contract_version=CAMPAIGN_CONTRACT_VERSION,
            campaign_brief=self.campaign_brief,
        )
        errors = governance["unmet_deliverables"]
        await self.emit({
            "t": "campaign_governance",
            "tool": "campaign__govern_delivery",
            "status": governance["status"],
            "verdict": governance,
        })
        if errors:
            await self.emit({"t": "campaign_stage", "stage": "validation", "status": "active",
                             "title": "Governance found unmet deliverables",
                             "detail": f"The Room is repairing {len(errors)} unmet criterion/criteria without repeating accepted work."})
            current_semantic = semantic
            current_candidate = candidate
            for repair_attempt in range(1, 4):
                repaired_semantic = await self._repair_campaign_actions(
                    semantic=current_semantic,
                    report=report,
                    errors=errors,
                    system_contract=campaign_system_contract(),
                )
                if repaired_semantic is None:
                    break
                current_semantic = repaired_semantic
                current_candidate = assemble_campaign_bundle(
                    current_semantic,
                    channels=channels,
                    requirements=requirements,
                    campaign_brief=self.campaign_brief,
                )
                current_candidate["report_markdown"] = report
                accepted, governance = campaign__govern_delivery(
                    current_candidate,
                    channels=channels,
                    requirements=requirements,
                    minimum_contract_version=CAMPAIGN_CONTRACT_VERSION,
                    campaign_brief=self.campaign_brief,
                )
                errors = governance["unmet_deliverables"]
                await self.emit({
                    "t": "campaign_governance",
                    "tool": "campaign__govern_delivery",
                    "status": governance["status"],
                    "verdict": governance,
                    "repair": {"scope": "affected_actions", "attempt": repair_attempt, "maximum": 3},
                })
                if not errors:
                    break
            if errors:
                # A rejected field is local to its action. Keep the compiled dashboard
                # and all accepted actions visible; Core persists this append-only attempt.
                return current_candidate, errors
        await self.emit({"t": "campaign_tool", "tool": "campaign__govern_delivery", "status": "accepted"})
        return accepted, []

    @staticmethod
    def _render_campaign_report(bundle: Dict[str, Any]) -> str:
        report = str(bundle.get("report_markdown") or "").strip()
        if report:
            return report
        actions = bundle.get("actions") or []
        action_lines = [f"- **{a.get('title') or a.get('id')}** ({a.get('channel')}): {a.get('rationale')}" for a in actions]
        kpi_lines = [f"- **{k.get('name')}**: {k.get('target')} ({k.get('source')})" for k in bundle.get("kpis") or []]
        return (f"## Campaign Strategy\n{bundle.get('strategy', '')}\n\n## Channel Plan\n" + "\n".join(action_lines) +
                f"\n\n## Audience & Safety\n{(bundle.get('audience') or {}).get('rationale', '')}\n\n"
                "## Measurement\n" + "\n".join(kpi_lines) +
                "\n\n## Gaps to confirm\n" + ("\n".join(f"- {x}" for x in bundle.get("risks") or []) or "- None identified."))

    async def _synthesize_growth_plan(self, forced_debate: bool, transcript_json: str) -> Tuple[str, Optional[Dict[str, Any]], List[str]]:
        """Produce HQ's user report and its durable Stage 2 operating contract once."""
        board = "\n".join(self.blackboard)[:5000] or "(no additional room evidence)"
        system = (
            "You are the Company HQ Growth Director. Return one JSON object with exactly report_markdown and contract. "
            "Use only the server-sourced Stage 2 context, company memory, and gathered evidence. Never invent a metric, "
            "budget, customer result, connector result, or profile fact. Choose the single biggest evidenced constraint, "
            "create one bounded 7-30 day stage, and delegate exactly one work order to an available Company Room. "
            "The report must explain current position, chosen constraint, rejected alternatives, stage objective, hypotheses, "
            "measurement checkpoint, stop condition, and delegated work in polished Markdown. "
            "Contract shape: {contract_version:'growth-plan.v1',baseline_ref:{resource_id:string,captured_at:string},"
            "goal:{title:string,objective:string},constraint:{type:'positioning|reach|conversion|qualified_pipeline|retention|measurement',"
            "statement:string,evidence_refs:string[]},stage:{name:string,objective:string,duration_days:integer,checkpoint_day:integer,"
            "measurement:{primary_signal:string,source:string,decision_rule:string,stop_condition:string}},"
            "hypotheses:[{statement:string,confidence:'LOW|MEDIUM|HIGH',evidence_refs:string[],expected_signal:string,falsification:string}],"
            "delegation:{room_tag:string,objective:string,deliverable:string,success_measure:string,skills:string[],acceptance_criteria:string[]},"
            "policy:{autonomy_mode:'MANUAL_REVIEW|AUTO',channel_policy:object,claim_constraints:string[]}}. "
            "Every evidence_refs entry must be a real resource ID or explicit source reference present in context. "
            "Use the exact baseline resource_id. Do not delegate to general or HQ."
        )
        user = (
            f"USER REQUEST:\n{self.user_message}\n\nCOMPANY MEMORY:\n{self.company_brief[:2500]}\n\n"
            f"{self.execution_context}\n\nROOM BOARD:\n{board}\n\n"
            f"VISIBLE DEBATE:\n{transcript_json[:3000] if forced_debate else '(not required)'}"
        )
        msg = await self._groq(
            [{"role": "system", "content": system}, {"role": "user", "content": user}],
            force_text=True, model=self.synth_model, bucket="synth", temp=0.2,
            uncapped=True, json_object=True,
        )
        envelope = _first_json_object(str((msg or {}).get("content") or "").strip())
        report = str((envelope or {}).get("report_markdown") or "").strip() if isinstance(envelope, dict) else ""
        contract = (envelope or {}).get("contract") if isinstance((envelope or {}).get("contract"), dict) else None
        errors: List[str] = []
        if not report:
            errors.append("The HQ report is missing")
        if not contract or contract.get("contract_version") != "growth-plan.v1":
            errors.append("The growth plan contract is missing or invalid")
        if contract:
            if not (contract.get("baseline_ref") or {}).get("resource_id"):
                errors.append("The plan does not reference the saved baseline")
            if not (contract.get("constraint") or {}).get("evidence_refs"):
                errors.append("The selected constraint has no evidence references")
            if len(contract.get("hypotheses") or []) not in (1, 2, 3):
                errors.append("The plan must contain one to three hypotheses")
            if not (contract.get("delegation") or {}).get("room_tag"):
                errors.append("The plan does not delegate one Company Room")
        return report, contract, errors

    async def _try_direct_answer_hook(self) -> Optional[str]:
        """A real tool-using agent answers directly, instead of this Director's
        own tool-less synth — only for response_depth=="direct" plain-answer
        turns, and only when the caller supplied direct_answer_hook (None by
        default; today's every other turn is completely unaffected). The
        agent gets LIVE tool access (recall, connectors) while composing the
        answer, progressive and on-demand, not limited to whatever gather
        pre-fetched upfront — the same reach a produce/artifact turn's agent
        already gets. Ask 2026-08-12: route direct-classified queries to an
        agent with progressive skills/tools "exactly like" the @mention and
        implicit-direct-agent routing already shipped this session, instead
        of Director's own synth writing the answer.

        Returns None to mean "fall through to normal synth" — either the
        gate condition isn't met, or the hook itself failed/returned nothing.
        Whatever text DOES come back flows through the exact same final_text
        the caller's existing verify/governance pass already checks — no
        separate safety net needed here.
        """
        if not (self.response_depth == "direct" and self.intended_output in ("answer", "")
                and self.direct_answer_hook is not None):
            return None
        try:
            answer = await self.direct_answer_hook(self.user_message, self._synthesis_context(3000))
        except Exception as exc:  # noqa: BLE001
            log.warning("[hyper-engine] direct_answer_hook failed, falling back to synth: %s", exc)
            return None
        return answer.strip() if isinstance(answer, str) and answer.strip() else None

    async def _plan_visual_direction(
        self,
        forced_debate: bool,
        transcript_json: str,
    ) -> Dict[str, Any]:
        """Turn evidence into a concrete art direction before writing markup."""
        board = self._synthesis_context(10000)
        debate = (
            "\n\nTEAM ANALYSIS (composition and objections only; never factual authority):\n"
            f"{transcript_json[:8000]}"
            if forced_debate else ""
        )
        system = (
            "You are an exacting digital art director. Create a concrete visual direction for one "
            "self-contained HTML artifact. Choose a distinctive composition that serves the evidence, "
            "audience, and decision. Do not write HTML. Do not invent facts, metrics, sources, or brand "
            "constraints. Reject generic dashboards, slide-template chrome, stacked report cards, and "
            "decoration without explanatory value. Return JSON only."
        )
        if (self.artifact_intent or {}).get("kind") == "presentation":
            system += (
                " This artifact is a PRESENTATION: design a deliberate slide-by-slide narrative, not a "
                "dashboard, console, report page, document outline, or stack of cards. Each slide has one "
                "communicative job and a composed visual idea. Define the slide sequence, pacing, and how "
                "desktop navigation and mobile vertical reading preserve that sequence."
            )
        user = (
            f"ARTIFACT INTENT:\n{json.dumps(self.artifact_intent, ensure_ascii=False)}\n\n"
            f"TASK:\n{self.user_message}\n\n{board}{debate}\n\n"
            "Define the visual thesis, reading experience, responsive layout system, art direction, "
            "palette, narrative flow, evidence-backed visual explanations, useful interaction, and "
            "specific patterns to avoid."
        )
        try:
            msg = await self._groq(
                [{"role": "system", "content": system}, {"role": "user", "content": user}],
                force_text=True,
                model=canonical_hyper_model(os.environ.get("HYPER_VISUAL_DIRECTION_MODEL", HYPER_FAST_MODEL)),
                bucket="synth",
                schema=_VISUAL_DIRECTION_SCHEMA,
                schema_name="visual_art_direction",
                temp=0.7,
                max_tokens=1800,
            )
            self.director_iters.append(self._last_tok)
            direction = json.loads((msg or {}).get("content") or "{}")
            if isinstance(direction, dict) and direction.get("visual_thesis"):
                return direction
        except Exception as exc:  # noqa: BLE001
            log.warning("[hyper-engine] visual art direction failed, using local fallback: %s", exc)
        return {
            "visual_thesis": str((self.artifact_intent or {}).get("purpose") or self.user_message)[:500],
            "experience": "A clear, evidence-led visual narrative tailored to the stated audience.",
            "layout_system": "Responsive editorial composition with varied section geometry.",
            "art_direction": "Distinctive, restrained, and specific to the subject matter.",
            "palette": [],
            "narrative_flow": [],
            "visual_explanations": ["Choose one evidence-backed figure that clarifies the central decision."],
            "interaction": "Use interaction only when it improves comparison or exploration.",
            "avoid": ["generic dashboard", "stacked report cards", "unsupported metrics"],
        }

    async def _synthesize_visual(
        self,
        forced_debate: bool,
        transcript_json: str,
        direction: Dict[str, Any],
        repair_errors: Optional[List[str]] = None,
        prior_html: str = "",
        prior_spec: Optional[Dict[str, Any]] = None,
    ) -> Optional[Dict[str, Any]]:
        """Generate one governed HTML artifact directly from evidence and debate."""
        if not (_visual_artifacts_enabled() and self.artifact_intent):
            return None
        try:
            skill = _VISUAL_SKILL_PATH.read_text(encoding="utf-8")
        except OSError:
            skill = "Create a polished, self-contained, responsive HTML artifact from the supplied evidence."
        board = self._synthesis_context(10000)
        debate = (
            "\n\nTEAM ANALYSIS (narrative options and objections only; never copy claims, numbers, "
            f"dates, or sources unless independently present in SOURCE EVIDENCE):\n{transcript_json[:10000]}"
            if forced_debate else ""
        )
        if (self.artifact_intent or {}).get("kind") == "presentation":
            repair = ""
            if repair_errors:
                repair = (
                    "\n\nRENDERED PRESENTATION REVIEW: Repair the typed specification, not HTML. "
                    "Return the complete corrected specification and address every observed defect:\n- "
                    + "\n- ".join(str(item)[:500] for item in repair_errors[:10])
                    + (f"\n\nPRIOR SPECIFICATION:\n{json.dumps(prior_spec, ensure_ascii=False)[:30000]}"
                       if prior_spec else "")
                )
            system = (
                self._system_prompt()
                + "\n\nYou are the final presentation creative director. Return only the typed "
                  "visual-presentation.v1 specification matching the schema. A governed renderer owns HTML, "
                  "CSS, responsive behavior, navigation, and safety. You own the narrative, art direction, "
                  "slide purposes, composition choices, concise copy, and evidence mapping. Use at least three "
                  "materially different compositions. The first slide must be composition=hero and the final "
                  "slide composition=decision. Never invent a metric, date, source, market claim, milestone, "
                  "legal conclusion, or completed result. Unknown inputs remain lane=unknown; proposals and "
                  "scenarios use lane=target or assumption. source_refs must copy only compact source labels "
                  "that appear verbatim in SOURCE EVIDENCE."
                + self._room_instr_block
                + self._lang_directive()
            )
            user = (
                f"ARTIFACT INTENT:\n{json.dumps(self.artifact_intent, ensure_ascii=False)}\n\n"
                f"ART DIRECTION BRIEF:\n{json.dumps(direction, ensure_ascii=False)}\n\n"
                f"TASK:\n{self.user_message}\n\n{board}{debate}{repair}\n\n"
                "Create the complete presentation specification now. Each slide has one communicative job. "
                "Choose compositions that make the evidence visually legible rather than filling fields."
            )
            msg = await self._groq(
                [{"role": "system", "content": system}, {"role": "user", "content": user}],
                force_text=True,
                model=canonical_hyper_model(os.environ.get("HYPER_VISUAL_SPEC_MODEL", HYPER_FAST_MODEL)),
                bucket="synth",
                schema=PRESENTATION_SPEC_SCHEMA,
                schema_name="visual_presentation",
                temp=0.5 if not repair_errors else 0.35,
                max_tokens=7000,
            )
            self.director_iters.append(self._last_tok)
            try:
                spec = normalize_presentation_spec(json.loads((msg or {}).get("content") or "{}"))
                html = render_presentation(spec)
            except (TypeError, ValueError, KeyError) as exc:
                log.warning("[hyper-engine] typed presentation render failed: %s", exc)
                return None
            source_refs = []
            for slide in spec.get("slides") or []:
                for ref in slide.get("source_refs") or []:
                    if ref and ref not in source_refs:
                        source_refs.append(ref)
            return {
                "contract": "artifact-candidate.v1",
                "intent": dict(self.artifact_intent),
                "title": spec["title"],
                "summary": spec["summary"],
                "html": html,
                "source_refs": source_refs[:24],
                "_visual_spec": spec,
            }
        repair = ""
        if repair_errors:
            repair = (
                "\n\nRENDER REPAIR: Return a complete corrected artifact. Preserve factual evidence, but "
                "redesign any art direction, layout, typography, interaction, or composition that caused these "
                "verified defects. This is a full visual repair, not a narrow patch:\n- "
                + "\n- ".join(str(item)[:400] for item in repair_errors[:12])
                + (f"\n\nPRIOR HTML:\n{prior_html[:180000]}" if prior_html else "")
            )
        system = (
            self._system_prompt()
            + "\n\nYou are the final artifact designer. Return JSON only, matching the schema. "
              "The html field is the finished artifact, not a specification or explanation.\n\n"
            + skill
            + self._room_instr_block
            + self._lang_directive()
        )
        if (self.artifact_intent or {}).get("kind") == "presentation":
            system += (
                "\n\nPRESENTATION CONTRACT: Produce a real slide deck in HTML. Use a sequence of semantic "
                "slide sections with stable presentation proportions on desktop, deliberate next/previous and "
                "keyboard navigation, a visible slide position indicator, and print-friendly page breaks. The "
                "opening slide establishes the thesis visually; subsequent slides advance a narrative through "
                "evidence, model, risk, and action. Do not output a dashboard, console, navigation bar with report "
                "sections, or one long card-based memo. On 390px mobile, preserve the slide sequence as readable "
                "vertical compositions without horizontal overflow."
            )
        user = (
            f"ARTIFACT INTENT:\n{json.dumps(self.artifact_intent, ensure_ascii=False)}\n\n"
            f"ART DIRECTION BRIEF:\n{json.dumps(direction, ensure_ascii=False)}\n\n"
            f"TASK:\n{self.user_message}\n\n{board}{debate}{repair}\n\n"
            "Create the complete artifact now. Treat the quality floor as acceptance criteria. Before "
            "returning, remove drafting residue and verify that every number is evidence-backed or visibly "
            "labeled as an assumption/scenario. summary is a concise in-room handoff, not a second report. "
            "source_refs lists only compact source labels actually present in SOURCE EVIDENCE."
        )
        msg = await self._groq(
            [{"role": "system", "content": system}, {"role": "user", "content": user}],
            force_text=True,
            model=canonical_hyper_model(os.environ.get("HYPER_VISUAL_SYNTH_MODEL") or self.synth_model),
            bucket="synth",
            schema=_HTML_ARTIFACT_SCHEMA,
            schema_name="interactive_artifact",
            temp=0.55,
            max_tokens=9000,
        )
        self.director_iters.append(self._last_tok)
        try:
            artifact = json.loads((msg or {}).get("content") or "{}")
        except (TypeError, ValueError):
            return None
        if not isinstance(artifact, dict):
            return None
        html = str(artifact.get("html") or "").strip()
        if not html.lower().startswith("<!doctype html") or len(html) < 800 or len(html) > 200000:
            return None
        return {
            "contract": "artifact-candidate.v1",
            "intent": dict(self.artifact_intent),
            "title": str(artifact.get("title") or "Interactive artifact").strip()[:180],
            "summary": str(artifact.get("summary") or "The interactive artifact is ready.").strip()[:1200],
            "html": html,
            "source_refs": [str(item).strip()[:240] for item in (artifact.get("source_refs") or []) if str(item).strip()][:24],
        }

    async def _produce_visual_artifact(
        self,
        forced_debate: bool,
        transcript_json: str,
    ) -> Optional[Dict[str, Any]]:
        """Render, validate, and at most once repair the selected artifact."""
        direction = await self._plan_visual_direction(forced_debate, transcript_json)
        candidate = await self._synthesize_visual(forced_debate, transcript_json, direction)
        if not candidate:
            return None
        public_candidate = {key: value for key, value in candidate.items() if not key.startswith("_")}
        delivery = await self.emit({"t": "artifact_candidate", "candidate": public_candidate})
        result = (delivery or {}).get("artifact") if isinstance(delivery, dict) else None
        if isinstance(result, dict) and result.get("ok") is False:
            candidate = await self._synthesize_visual(
                forced_debate,
                transcript_json,
                direction,
                repair_errors=[str(item) for item in (result.get("errors") or [])],
                prior_html=str(candidate.get("html") or ""),
                prior_spec=candidate.get("_visual_spec") if isinstance(candidate.get("_visual_spec"), dict) else None,
            )
            if not candidate:
                return None
            public_candidate = {key: value for key, value in candidate.items() if not key.startswith("_")}
            delivery = await self.emit({"t": "artifact_candidate", "candidate": public_candidate})
            result = (delivery or {}).get("artifact") if isinstance(delivery, dict) else None
        if isinstance(result, dict) and result.get("ok") is True:
            return {"candidate": public_candidate, "receipt": result}
        return None

    async def _synthesize(self, forced_debate: bool, transcript_json: str) -> str:
        """Write the final deliverable from the gathered board (+ debate). Clean context
        on the synth model — no tool-call transcript → no harmony glitch, full quality."""
        if self.room_kind == "campaign":
            raise RuntimeError("Campaign Rooms may complete only through campaign__govern_delivery")
        depth = self.response_depth if self.response_depth in {"direct", "focused", "operating"} else "focused"
        board_limit = {"direct": 3000, "focused": 4500, "operating": 8000}[depth]
        board = self._synthesis_context(board_limit)
        debate_ctx = (f"\n\nThe room DEBATED this — transcript:\n{transcript_json}\nCite who argued what."
                      + (f"\nMODERATOR NOTE: {self._debate_disagreement_note}" if self._debate_disagreement_note else "")
                      if forced_debate else "")
        # Additional: a population simulation's report (if it ran) is folded in so the final
        # deliverable reflects the simulated stakeholder population — not just the room.
        sim_ctx = (f"\n\nA POPULATION SIMULATION of synthetic stakeholder voices produced this report — "
                   f"incorporate its consensus + fault lines where relevant:\n{self._sim_report[:2500]}"
                   if self._sim_report else "")
        # The deliverable FORMAT is driven by the intended output — so an "email" turn writes a
        # ready-to-send email (Subject + body), NOT a generic strategy report the producer can't send.
        _io = self.intended_output
        _is_prospecting = self.evidence_mode == "prospecting"
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
        if depth != "direct" and _io in ("doc", "notion", "answer", "report", ""):
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
                "flag anything unverifiable as UNVERIFIED.\nEVIDENCE PRECEDENCE: only direct RECALL, "
                "WEB, CONNECTOR, or deterministic domain-artifact entries on the board establish facts. "
                "WORK_RESULT entries are employees' analysis and recommendations, never independent evidence: "
                "use them to shape the answer only when their factual premise is independently present on the board. "
                "Never copy a number, result, source, current asset, owner, customer, budget, timeline, or capability "
                "from TEAM ANALYSIS unless the same claim appears in SOURCE EVIDENCE. In requested fact-versus-assumption "
                "formats, the observed/fact column may contain SOURCE EVIDENCE only; place plausible but unverified ideas "
                "in the assumption column without presenting them as current company or market facts. "
                "An absence of a competitor, proof, source, metric, or capability in the current material is a "
                "gap, not proof that none exists.\nCLAIM SAFETY: never state or imply guarantees, legal compliance "
                "approval, certification, exclusivity, market white space, performance improvement, a date, an owner, "
                "or a numeric target unless the exact supporting fact is on the board. Do not turn a recommendation "
                "into a measured outcome. Where a target is useful, label it 'proposed validation target'; where a "
                "positioning or compliance claim needs substantiation, label it 'subject to legal and technical validation'."
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
        if depth == "direct":
            sysp += (
                "\nDIRECT ANSWER MODE: answer only the user's bounded question in at most 6 short paragraphs or "
                "bullets. Lead with the answer, cite the measured evidence used, distinguish current observation "
                "from general guidance, and give only the verification steps needed. Do not write an executive "
                "summary, roadmap, maturity report, broad audit, or unrelated recommendations."
            )
        elif depth == "focused":
            sysp += (
                "\nFOCUSED ANALYSIS MODE: solve only the named diagnosis or decision. Use only headings that "
                "directly help that task; do not expand into a complete operating audit or roadmap."
            )
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
        _skeleton = (((self.domain_pack.report_contract if self.domain_pack else None)
                      or self._REPORT_SKELETON.get(self.room_kind))
                     if depth == "operating" and _io in ("answer", "doc", "notion") else None)
        if _skeleton:
            sysp += (
                f"\n\nREPORT CONTRACT ({self.room_kind.upper()} room — this is a "
                f"{self.room_kind} specialist's deliverable): structure the report under EXACTLY "
                f"these '## ' headings, in this order. Fenced interactive elements requested by the "
                f"contract are part of the deliverable and must contain real output, never placeholders:\n"
                f"{_skeleton}\n"
                f"Open with a 2-3 sentence executive summary BEFORE the first heading; close with "
                f"'## Gaps to confirm' when anything is UNVERIFIED."
            )
        if self.room_kind == "seo" and self._seo_audit_evidence:
            sysp += (
                "\n\nSEO FINAL EVIDENCE LOCK:\n"
                "- The completed SEO_AUDIT_EVIDENCE object is the only authority for current site state. "
                "Copy its maturity stage, measurements, artifact ID, findings, templates, and limitations exactly.\n"
                "- A declared canonical mismatch does NOT prove a page is unindexed, poorly indexed, hidden, or "
                "de-indexed. Public crawl evidence never proves Google index status.\n"
                "- Recommend ONLY defect types explicitly present in findings. If structured data, metadata, "
                "Core Web Vitals, duplicates, robots blocks, or noindex are absent from findings, do not claim or fix them.\n"
                "- Never create a second audit ID, source, role, benchmark, target, threshold, time window, word-count "
                "standard, page-count goal, ranking goal, traffic goal, or expected lift. Use only measured numbers on "
                "the board. Process dates may come from the user's requested 7/30/90-day horizon.\n"
                "- Owners are the named participants as planning owners only. Do not invent their job titles or "
                "unnamed teams. Mark an implementation owner as 'confirm' when the board does not identify one.\n"
                "- Search opportunity demand remains UNKNOWN until connected evidence exists. Roadmap gates verify "
                "implementation and rescans, not rankings, indexation, impressions, or traffic."
                "\n- A request to resolve, fix, or repair a finding is not proof that any change was applied. Claim "
                "resolution only when a write-capable tool returned success and a post-change rescan verified it; "
                "otherwise state the measured finding and the exact next executable action."
            )

        _org = (self.company_brief or "").strip()
        _org_block = (f"COMPANY CONTEXT (write FOR this organisation — in its voice, about its products, customers, "
                      f"and market; make every specific concrete to this company, not generic):\n{_org[:1500]}\n\n"
                      if _org else "")
        user = (f"{_org_block}{self._journal_block}TASK: {self.user_message}\n\nGATHERED CONTEXT (the room's shared board):\n{board}{debate_ctx}{sim_ctx}\n\n"
                "Write the final, publish-ready deliverable now.")
        msg = await self._groq([{"role": "system", "content": sysp}, {"role": "user", "content": user}],
                               force_text=True, model=self.synth_model, bucket="synth",
                               max_tokens={"direct": 900, "focused": 2200}.get(depth))
        self.director_iters.append(self._last_tok)
        return (msg or {}).get("content") or ""

    async def _synthesize_seo_recommendation(self, transcript_json: str) -> str:
        """Resolve the visible debate without asking the model to restate audit data."""
        audit = self._seo_audit_evidence or {}
        maturity = audit.get("maturity") or {}
        findings = audit.get("findings") or []
        compact = {
            "stage": maturity.get("stage"),
            "label": maturity.get("label"),
            "blockers": maturity.get("blockers") or [],
            "top_findings": [
                {key: row.get(key) for key in ("id", "severity", "title", "template", "instances")}
                for row in findings[:6] if isinstance(row, dict)
            ],
        }
        prompt = (
            "Write one concise sentence that resolves the SEO agents' recommendation. "
            "Use no numbers, dates, IDs, rankings, traffic claims, search-demand claims, job titles, or new facts. "
            "State the immediate operating priority and why the next decision waits for measured evidence. "
            "Return only the sentence, with no label or quotation marks."
        )
        msg = await self._groq(
            [{"role": "system", "content": prompt},
             {"role": "user", "content": f"EVIDENCE: {json.dumps(compact, ensure_ascii=False)}\nDEBATE: {transcript_json[:3500]}"}],
            force_text=True, model=self.synth_model, bucket="synth", max_tokens=120, temp=0.2,
        )
        return ((msg or {}).get("content") or "").strip()

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
                         "kind": "synthesis", "content": reply, "conversational": True})
        log.info("[hyper-engine] chat turn — %d tokens, %dms", self.tokens, int((time.time() - t0) * 1000))
        return {"cost_tokens": self.tokens, "final_text": reply, "transcript": self.transcript,
                "gather_count": 0, "tool_calls": 0, "sim_report": None, "turn_mode": "chat"}

    async def _emit_work_brief(self, plan: Dict[str, Any]) -> None:
        """Give the user one immediate, natural-language account of the work ahead.

        The structured plan remains an internal execution contract. This event is
        deliberately short and deterministic so it arrives before gather/debate
        without spending another model call or exposing orchestration jargon.
        """
        lead = self.participants[0] if self.participants else {}
        specialists = [
            str(p.get("name") or p.get("slug") or "").strip()
            for p in (self.participants or [])[1:3]
        ]
        specialists = [name for name in specialists if name]
        evidence_work = bool(
            plan.get("recall_queries") or plan.get("connector_calls")
            or plan.get("web_query") or plan.get("seo_audit_url") or plan.get("places_query")
        )
        needs_debate = bool(plan.get("needs_debate"))
        report_expected = (
            self.response_depth == "operating"
            or self.intended_output in {"report", "doc", "notion"}
        )
        opening = (
            "I’ll start by grounding this in the relevant company and market evidence."
            if evidence_work else
            "I’ll start by narrowing this to the outcome you asked for."
        )
        if specialists:
            names = specialists[0] if len(specialists) == 1 else f"{specialists[0]} and {specialists[1]}"
            collaboration = (
                f" {names} will challenge the strongest options and help resolve the recommendation."
                if needs_debate else
                f" {names} will contribute the specialist checks needed to keep the answer useful and grounded."
            )
        else:
            collaboration = ""
        closing = (
            " We’ll bring that together in one polished report with the decision, evidence, and next actions."
            if report_expected else
            " I’ll bring that back as one concise, ready-to-use answer."
        )
        await self.emit({
            "t": "work_brief",
            "agent": lead.get("slug") or "director",
            "content": opening + collaboration + closing,
            "report_expected": report_expected,
        })

    async def _emit_light_collaboration(self, plan: Dict[str, Any]) -> None:
        """Show the crew's bounded Light-turn assignments without persona calls.

        These are status notes, not fabricated specialist conclusions. The actual
        answer still comes from the Director after any selected evidence tool runs.
        """
        if str(plan.get("turn_mode") or "task").lower() == "chat":
            return
        has_evidence_work = bool(
            plan.get("recall_queries") or plan.get("connector_calls")
            or plan.get("web_query") or plan.get("seo_audit_url")
        )
        notes = (
            "I’m narrowing this to the decision the user actually asked for.",
            "I’m checking the relevant evidence before the room answers." if has_evidence_work
            else "I’m checking whether any additional evidence is actually needed.",
            "I’m keeping the response concise and ready to act on.",
        )
        for participant, note in zip((self.participants or [])[:3], notes):
            await self.emit({
                "t": "react",
                "agent": participant.get("slug"),
                "name": participant.get("name") or participant.get("slug"),
                "lane": participant.get("_lane") or "Communicator",
                "agreement": "contribute",
                "content": note,
                "line": note,
                "confidence": 1.0,
                "activity_only": True,
            })

    async def _run_resumed_work_step(self, started_at: float) -> Dict[str, Any]:
        """Execute one previously-paused Work Room step under its existing ID."""
        envelope = self.work_room_resume or {}
        raw_step = envelope.get("step") if isinstance(envelope.get("step"), dict) else {}
        work_order_id = str(envelope.get("work_order_id") or "").strip()
        if not raw_step or not work_order_id:
            raise RuntimeError("invalid work-room resume envelope")
        step = {
            "id": str(raw_step.get("id") or "resume")[:80],
            # The control plane only exposes a step for resume after its prior
            # dependencies let it reach the persisted wait. Re-checking those
            # dependencies in a new transport turn would create a second order.
            "depends_on": [],
            "kind": str(raw_step.get("kind") or "analysis")[:40],
            "owner_lane": str(raw_step.get("owner_lane") or "Strategist")[:40],
            "title": str(raw_step.get("title") or "Resumed work")[:180],
            "objective": str(raw_step.get("objective") or self.user_message)[:600],
            "required_evidence": [str(value)[:160] for value in (raw_step.get("required_evidence") or []) if str(value)][:4],
            "acceptance_criteria": [str(value)[:180] for value in (raw_step.get("acceptance_criteria") or []) if str(value)][:4],
            "_work_order_id": work_order_id,
        }
        resolution = envelope.get("resolution") if isinstance(envelope.get("resolution"), dict) else {}
        if self.company_brief:
            self.blackboard.append("COMPANY CONTEXT[authoritative]: " + self.company_brief[:8000])
        self.blackboard.append("RESUMPTION INPUT[authoritative]: " + json.dumps(resolution, ensure_ascii=False)[:6000])
        prior_dependencies = [str(value)[:80] for value in (raw_step.get("depends_on") or []) if str(value)][:4]
        if prior_dependencies:
            self.blackboard.append("COMPLETED PREREQUISITES[authoritative]: " + json.dumps(prior_dependencies))
        await self.emit({
            "t": "work_order", "id": work_order_id, "status": "active", "title": step["title"],
            "resumed": True, "resume_key": str(envelope.get("resume_key") or "")[:120],
        })
        self.work_results = await self._run_work_orders({"turn_plan": [step]})
        final_text = "\n\n".join(
            str(row.get("text") or "") for row in self.work_results if isinstance(row, dict)
        ).strip()
        return {
            "cost_tokens": int(self.tokens or 0),
            "final_text": final_text,
            "transcript": list(self.transcript),
            "gather_count": self.gather_count,
            "io": dict(self.io), "tok_by": dict(self.tok_by),
            "intended_output": "work_step_resume",
            "turn_mode": "task",
            "work_orders": [], "work_results": list(self.work_results),
            "post_output_actions": [],
            "duration_ms": int((time.time() - started_at) * 1000),
        }

    async def _run_agentic_task(self, plan: Dict[str, Any], t0: float) -> Optional[Dict[str, Any]]:
        """Delegate this ENTIRE turn to the agentic task engine (a real
        multi-step ReAct loop + delegate_to specialists — see
        api_hyper_rooms._build_lead_task_agent) instead of this Director's
        own fixed gather→debate→synth pipeline.

        Returns None on ANY failure or empty result so `run()` falls through
        to the normal pipeline unchanged — this path can only ADD behavior,
        never break a turn that would otherwise have worked. The returned
        text still flows through the SAME `_verify_turn` safety net as every
        other turn (unchanged) — no separate grounding logic here.
        """
        if self.agentic_task_hook is None:
            return None
        try:
            board_context = self._synthesis_context(4000)
            final_text = await self.agentic_task_hook(self.user_message, board_context)
        except Exception as exc:  # noqa: BLE001 — never fail the turn over this engine
            log.warning("[hyper-engine] agentic_task_hook failed, falling back to normal pipeline: %s", exc)
            return None
        if not final_text or not str(final_text).strip():
            return None
        await self.emit({"t": "line", "agent": (self.participants[0].get("slug") if self.participants else "director"),
                         "kind": "synthesis", "content": final_text})
        log.info("[hyper-engine] agentic task done — %d tokens, %dms",
                 self.tokens, int((time.time() - t0) * 1000))
        # HQ CONTRACT BRIDGE — an HQ-dispatched work order (routine/hyper-cycle)
        # goes through this SAME Director.run() (work-dispatcher.js posts to
        # /internal/hyper/room-turn, the identical route every turn uses), so
        # execution_engine=="agentic" can fire for HQ work exactly like any
        # other turn. But core's roomVerdict() only accepts a
        # work-order-result.v2 contract (self.work_results-derived, built by
        # _synthesize_work_order_result) — this engine has no equivalent
        # per-subtask deterministic checks yet. Without this bridge, HQ would
        # mark genuinely completed agentic work "blocked" for want of a
        # contract it never produced. Deliberately conservative: the subtask
        # is never marked "completed" (no deterministic check backs that claim
        # yet) — checkpoint disposition defaults to request_hq, so a human/HQ
        # reviews the real output rather than either silently trusting an
        # unverified completion or discarding real work as a false failure.
        work_order_result = None
        if self.work_order:
            try:
                from .work_order_contract import assemble_work_order_result, govern_work_order_result
                subtask = {
                    "id": "agentic-engine", "title": "Agentic task engine execution",
                    "status": "partial",
                    "output": {"report_markdown": final_text},
                    "checks": [],
                    "gaps": [{"why": "The agentic task engine has no deterministic per-check verification "
                                     "bridge yet — route this for HQ/human review before treating it as complete."}],
                }
                semantic = {"report_markdown": final_text, "deliverables": [], "needs_input": [], "blockers": []}
                assembled = assemble_work_order_result(
                    semantic, envelope=self.work_order, subtasks=[subtask],
                    metrics={"tool_calls_total": 0},
                )
                work_order_result = govern_work_order_result(assembled)["result"]
                await self.emit({"t": "work_order_result", "result": work_order_result})
            except Exception as exc:  # noqa: BLE001 — never fail the turn over the HQ contract bridge
                log.warning("[hyper-engine] HQ contract bridge failed, returning without a contract: %s", exc)
                work_order_result = None
        return {
            "cost_tokens": self.tokens,
            "final_text": final_text,
            "transcript": self.transcript,
            "gather_count": self.gather_count,
            "tool_calls": 0,
            "tok_by": dict(self.tok_by),
            "io": dict(self.io),
            "gather_facts": self._source_evidence_snapshot(),
            "sim_report": None,
            "evo_playbooks": self.evo_playbooks,
            "skills_used": list(self.skills_used),
            "room_kind": self.room_kind,
            "collaboration_intensity": self.collaboration_intensity,
            "intended_output": self.intended_output,
            "post_output_actions": list(self.post_output_actions),
            "outreach_request": plan.get("outreach_request"),
            "outreach_metrics": dict(self._outreach_metrics),
            "work_orders": [],
            "work_results": [],
            "work_order_result": work_order_result,
            "turn_mode": "task",
            "execution_engine": "agentic",
            "duration_ms": int((time.time() - t0) * 1000),
        }

    async def run(self) -> Dict[str, Any]:
        t0 = time.time()
        # Instant feedback from t=0: connector-tool init + the first model call run
        # with no event of their own, so without this the FE sits idle (only the
        # router showing) until the first tool fires. One typing note so the room
        # never looks frozen right after the query is sent.
        _lead = self.participants[0].get("slug") if self.participants else "director"
        await self.emit({"t": "typing", "agent": _lead, "note": "Reading the goal and gathering context…"})
        if self.domain_pack:
            await self.emit({
                "t": "domain_pack",
                "room_kind": self.domain_pack.slug,
                "display_name": self.domain_pack.display_name,
                "pack_version": self.domain_pack.version,
                "skills_available": [name for name, _when in self.domain_pack.skill_catalog()],
                "capabilities_available": list(self.domain_pack.capabilities),
                "report_contract": True,
            })
        await self._init_connector_tools()  # register toggled connectors as read tools
        if self.work_room_resume:
            return await self._run_resumed_work_step(t0)
        await self._prefetch_runtime_prospects()
        if self.room_kind == "hq" and "growth-stage-context.v1" in self.execution_context:
            self.blackboard.append("GROWTH_CONTEXT[authoritative]: " + self.execution_context[:12000])
        # PHASE 1 — STRUCTURED GATHER PLAN. One JSON-schema call (NOT native tool-calling)
        # decides what to recall / which connectors to read / web + debate. Replaces the
        # old 15-round sequential agentic loop: one round-trip, no harmony tool glitch.
        plan = await self._plan_gather()
        log.info("[hyper-engine] planner picked execution_engine=%s turn_mode=%s room_kind=%s",
                 plan.get("execution_engine"), plan.get("turn_mode"), self.room_kind)
        self.post_output_actions = list(plan.get("post_output_actions") or [])
        if self.post_output_actions:
            self.intended_output = str(self.post_output_actions[-1].get("artifact_kind") or "answer")
        for action in self.post_output_actions:
            await self.emit({"t": "action_intent", **action})
            if not action.get("connected"):
                await self.emit({
                    "t": "connection_required",
                    "connector": action.get("connector"),
                    "capability": action.get("capability"),
                    "operation": action.get("operation"),
                    "explicit": True,
                    "resume_on_connect": True,
                    "message": (f"Connect {action.get('connector')} to complete this action. "
                                "The Room will still finish the output if you continue without connecting."),
                })
        self.response_depth = str(plan.get("response_depth") or "focused")
        self.collaboration_intensity = str(plan.get("collaboration_intensity") or "standard")
        self.evidence_mode = str(plan.get("evidence_mode") or "standard")
        self.seo_task = str(plan.get("seo_task") or "none")
        await self.emit({
            "t": "work_scope",
            "room_kind": self.room_kind,
            "intensity": self.collaboration_intensity,
            "depth": self.response_depth,
            "seo_task": self.seo_task,
            "audit_page_limit": plan.get("seo_audit_page_limit") if plan.get("seo_audit_url") else 0,
            "debate": bool(plan.get("needs_debate")),
        })
        # EVENT-DRIVEN TURN ROUTER — the planner (an LLM, not a regex) classified the
        # MESSAGE. 'chat' = conversational: the room replies as people — no gather, no
        # web/Maps spend, no debate, no report. 'hallo' used to burn a 27k-token full
        # pipeline ending in a fabricated report.
        if str(plan.get("turn_mode") or "task").lower() == "chat":
            return await self._chat_turn(t0)
        # AGENTIC TASK ENGINE — a genuinely autonomous multi-step ReAct loop
        # (real tool-calling, dynamic tool-group equipping, native plan/
        # subtask decomposition) instead of this Director's own fixed
        # plan-once gather→debate→synth pipeline. Only when the planner
        # picked it AND the caller wired a hook; any failure falls through
        # to the normal pipeline below rather than failing the turn.
        # Campaign rooms are EXCLUDED: their own structured contract/bundle
        # governance (_synthesize_campaign_bundle) has no analogue here, and
        # skipping it silently would be a real governance gap, not a safe
        # fallthrough.
        if (str(plan.get("execution_engine") or "debate").lower() == "agentic"
                and self.agentic_task_hook is not None and self.room_kind != "campaign"):
            agentic_result = await self._run_agentic_task(plan, t0)
            if agentic_result is not None:
                return agentic_result
        await self._emit_work_brief(plan)
        if self.collaboration_intensity == "light":
            await self._emit_light_collaboration(plan)
        if self.room_kind == "campaign":
            await self.emit({"t": "campaign_stage", "stage": "brief", "status": "complete",
                             "title": "Campaign brief understood", "detail": "Objective, channels, horizon, pace, and operating constraints are set."})
        campaign_request = plan.get("campaign_request")
        # Human Work Room turns now select their specialist engine deterministically,
        # BEFORE this Director ever runs (api_hyper_rooms._select_execution_profile).
        # A campaign.contract.v1-profiled turn already has self.room_kind == "campaign"
        # and is dispatched through _build_campaign_director, the correct existing path —
        # this generic escape hatch existed for turns whose room_kind was frozen at
        # "general" with no other way to reach Campaign. For room_mode == "work" that
        # reason no longer applies: only profile_id == campaign.contract.v1 may invoke
        # the Campaign compiler, never a planner freelancing a campaign_request object
        # after already doing generic work under a different profile.
        if isinstance(campaign_request, dict) and self.room_kind != "campaign" and self.room_mode != "work":
            await self.emit({"t": "typing", "agent": _lead,
                             "note": "Creating the dedicated Campaign Room…"})
            response = await campaign_create_emulated(
                campaign_request, user_id=self.user_id, org_id=self.org_id,
                room_id=self.room_id or "room",
                turn_id=self.turn_id or str(int(t0 * 1000)),
            )
            campaign = response.get("campaign") if isinstance(response, dict) else None
            if isinstance(campaign, dict) and campaign.get("id"):
                campaign_id = str(campaign["id"])
                room_id = str(campaign.get("roomId") or "")
                handoff = {
                    "campaign_id": campaign_id,
                    "room_id": room_id,
                    "status": str(campaign.get("status") or "GENERATING"),
                    "name": str(campaign.get("name") or campaign_request.get("name") or "Campaign"),
                    "campaign_url": f"/hivemind/app/employees/campaigns?campaign={campaign_id}",
                    "room_url": f"/hivemind/app/employees/rooms/{room_id}?campaignReturn={campaign_id}" if room_id else None,
                }
                final_text = (f"The dedicated Campaign Room is now building **{handoff['name']}**. "
                              "Nothing has been published; the finished plan will return to Your Campaigns for approval.")
                await self.emit({"t": "campaign_handoff", **handoff})
                await self.emit({"t": "line", "agent": _lead, "kind": "synthesis", "content": final_text})
                await report_llm_usage(
                    user_id=self.user_id, org_id=self.org_id, model="hyperagents-director",
                    total_tokens=int(self.tokens or 0), prompt_tokens=int(self.io.get("input", 0) or 0),
                    completion_tokens=int(self.io.get("output", 0) or 0), feature="hyperagents-room",
                    entries=list(self.model_usage.values()),
                    idempotency_key=f"hyper-room:{self.turn_id or 'unknown'}",
                )
                return {"cost_tokens": self.tokens, "final_text": final_text, "transcript": self.transcript,
                        "gather_count": 0, "tool_calls": 1, "sim_report": None,
                        "campaign_handoff": handoff, "io": self.io, "tok_by": self.tok_by}
            error = str((response or {}).get("error") or "The campaign could not be created.")
            await self.emit({"t": "campaign_handoff_failed", "message": error,
                             "code": (response or {}).get("code")})
            await self.emit({"t": "line", "agent": _lead, "kind": "dead_end", "content": error})
            await report_llm_usage(
                user_id=self.user_id, org_id=self.org_id, model="hyperagents-director",
                total_tokens=int(self.tokens or 0), prompt_tokens=int(self.io.get("input", 0) or 0),
                completion_tokens=int(self.io.get("output", 0) or 0), feature="hyperagents-room",
                entries=list(self.model_usage.values()),
                idempotency_key=f"hyper-room:{self.turn_id or 'unknown'}",
            )
            return {"cost_tokens": self.tokens, "final_text": error, "transcript": self.transcript,
                    "gather_count": 0, "tool_calls": 1, "sim_report": None,
                    "campaign_handoff_error": error, "io": self.io, "tok_by": self.tok_by}
        # PHASE 2 — PARALLEL GATHER. Every recall + connector read + web runs CONCURRENTLY.
        if self.room_kind == "campaign":
            await self.emit({"t": "campaign_stage", "stage": "evidence", "status": "active",
                             "title": "Gathering campaign evidence", "detail": "Agents are reading company memory, audience context, provider capabilities, and relevant market sources."})
        # HQ work-order subtasks own their tool calls sequentially so later work
        # can consume earlier results and the same expensive discovery is not run
        # once in gather and again in execution.
        tool_calls_made = 0 if self.work_order else await self._run_gather(plan)
        if self.room_kind == "campaign":
            await self.emit({"t": "campaign_stage", "stage": "evidence", "status": "complete",
                             "title": "Evidence board assembled", "detail": f"The team completed {tool_calls_made} bounded research and capability tasks."})
        # PHASE 2.2 — REAL AGENT WORK. The Director's plan becomes bounded,
        # independently executed work orders. Their compact results are added to
        # the board before any decision debate or final synthesis.
        self.work_results = (await self._run_work_order_subtasks(plan)) if self.work_order else (await self._run_work_orders(plan))
        # PHASE 2.5 — POPULATION SIM (ADDITIONAL, opt-in). Runs on the gathered context, emits a
        # report the FE shows as a hideable popup, and feeds that report into the synthesis. Fully
        # wrapped — a failure just skips it; the main turn (debate + synth) is never affected.
        if self.collaboration_intensity != "light" and self.sim_mode in _SIM_ON:
            self._sim_payload = await self._population_sim(self.room_goal or self.user_message or "")
            if self._sim_payload:
                self._sim_report = self._sim_payload.get("report")
                await self.emit({"t": "sim_report", **self._sim_payload})
        # PHASE 3 — DEBATE (the multi-agent product). Convene only when the plan judges the
        # task needs a decision/judgment/discussion — a pure lookup skips it (faster, on-point).
        forced_debate = False
        transcript_json = ""
        if not self.work_order and len(self.participants) >= 2 and plan.get("needs_debate"):
            try:
                if self.room_kind == "campaign":
                    await self.emit({"t": "campaign_stage", "stage": "debate", "status": "active",
                                     "title": "Campaign specialists are debating", "detail": "Strategy, audience, creative direction, claims, channel roles, and timing are being challenged in the Room."})
                # Permanent domain rooms keep a standing room_goal. The active
                # user message is the run-specific objective and must lead every
                # debate; using room_goal first made unrelated campaigns debate
                # the same generic room mission and reuse stale prospect context.
                topic = self._debate_topic()
                transcript_json = await self._debate(
                    topic, 1 if self.room_kind in {"campaign", "seo"} else self.debate_max_rounds
                )
                forced_debate = True
                if self.room_kind == "campaign":
                    await self.emit({"t": "campaign_stage", "stage": "debate", "status": "complete",
                                     "title": "Strategic decisions resolved", "detail": "Material disagreements and the selected recommendation are recorded for the final contract."})
            except Exception as exc:  # noqa: BLE001
                log.warning("[hyper-engine] debate failed: %s", exc)
        # PHASE 3.5 — TASK-COMPLETION PASS. If the task's deliverable is prospects/
        # contacts and the board is thin, the room FINISHES the job itself instead of
        # sealing a report full of "[to be sourced]" and fictional research assignees:
        #   a) org names surfaced by web/debate get looked up on Maps for REAL contacts;
        #   b) a sharpened company-oriented Places query runs when discovery was weak.
        try:
            # Event-driven gate: the planner asking for a places_query is the sole
            # discovery signal and works in any language.
            _wants_contacts = bool(plan.get("places_query")) and not self.work_order
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
        growth_plan_contract = None
        campaign_bundle_errors: List[str] = []
        work_order_result = None
        runtime_stage_result = None
        room_phase_result = None
        artifact_receipt = None
        if self.room_phase:
            work_order_result = await self._synthesize_work_order_result()
            room_phase_result = await self._synthesize_room_phase_result(work_order_result)
            final_text = str(room_phase_result.get("summary") or "")
            await self.emit({"t": "room_phase_result", "result": room_phase_result})
        elif self.runtime_stage:
            runtime_stage_result = await self._synthesize_runtime_stage_result()
            final_text = str(runtime_stage_result.get("summary") or "")
            await self.emit({"t": "runtime_stage_result", "result": runtime_stage_result})
        elif self.work_order:
            work_order_result = await self._synthesize_work_order_result()
            final_text = str(work_order_result.get("report_markdown") or "")
            await self.emit({"t": "work_order_result", "result": work_order_result})
        elif self.room_kind == "campaign":
            await self.emit({"t": "campaign_stage", "stage": "build", "status": "active",
                             "title": "Building the campaign contract", "detail": "The lead is compiling final posts, visuals, schedule, evidence, measurement, and launch controls."})
            campaign_bundle, campaign_bundle_errors = await self._synthesize_campaign_bundle(forced_debate, transcript_json)
            if campaign_bundle and not campaign_bundle_errors:
                await self.emit({"t": "campaign_stage", "stage": "build", "status": "complete",
                                 "title": "Campaign contract accepted", "detail": "Every required action, visual brief, timing decision, claim, and measurement field passed validation."})
                await self.emit({"t": "campaign_bundle", "bundle": campaign_bundle})
                final_text = self._render_campaign_report(campaign_bundle)
            elif campaign_bundle:
                await self.emit({"t": "campaign_bundle_partial", "bundle": campaign_bundle,
                                 "errors": campaign_bundle_errors, "repair_exhausted": True})
                final_text = self._render_campaign_report(campaign_bundle)
            else:
                await self.emit({"t": "campaign_bundle_invalid", "errors": campaign_bundle_errors})
                final_text = "Campaign evidence could not be compiled into a dashboard.\n\n" + "\n".join(
                    f"- {error}" for error in campaign_bundle_errors)
        elif self.room_kind == "hq" and "growth-stage-context.v1" in self.execution_context:
            await self.emit({"t": "growth_stage", "stage": "plan", "status": "active",
                             "title": "Choosing the next growth stage", "detail": "HQ is comparing company memory, the saved baseline, and connector signals."})
            final_text, growth_plan_contract, growth_errors = await self._synthesize_growth_plan(forced_debate, transcript_json)
            if growth_errors:
                await self.emit({"t": "growth_plan_invalid", "errors": growth_errors})
                growth_plan_contract = None
                final_text = final_text or "HQ could not produce an evidence-backed growth stage.\n\n" + "\n".join(f"- {x}" for x in growth_errors)
            else:
                await self.emit({"t": "growth_plan_contract", "contract": growth_plan_contract})
                await self.emit({"t": "growth_stage", "stage": "plan", "status": "complete",
                                 "title": "Growth stage selected", "detail": "One bounded stage and one specialist work order are ready to persist."})
        else:
            if self.artifact_intent:
                # The visual producer is the final synthesizer for ordinary Room
                # turns; do not pay for a prose report that would be rendered again.
                final_text = ""
            elif (self.room_kind == "seo" and self._seo_audit_evidence
                    and self.seo_task in {"remediate", "rescan"}
                    and self.response_depth != "operating"):
                from .domains.seo.reporting import render_remediation_report
                final_text = render_remediation_report(self._seo_audit_evidence)
                await self.emit({
                    "t": "seo_report_governance",
                    "status": "accepted",
                    "mode": "remediation_compiled",
                    "artifact_id": ((self._seo_audit_evidence.get("capability") or {}).get("artifact_id")),
                    "finding_count": len(self._seo_audit_evidence.get("findings") or []),
                    "message": "Remediation status was compiled from the deterministic SEO artifact.",
                })
            elif self.room_kind == "seo" and self.response_depth == "operating" and self._seo_audit_evidence:
                from .domains.seo.reporting import render_operating_report
                recommendation = await self._synthesize_seo_recommendation(transcript_json)
                final_text = render_operating_report(self._seo_audit_evidence, recommendation)
                await self.emit({
                    "t": "seo_report_governance",
                    "status": "accepted",
                    "mode": "evidence_compiled",
                    "artifact_id": ((self._seo_audit_evidence.get("capability") or {}).get("artifact_id")),
                    "finding_count": len(self._seo_audit_evidence.get("findings") or []),
                    "message": "Measured sections were compiled from the deterministic SEO artifact.",
                })
            else:
                agent_answer = await self._try_direct_answer_hook()
                final_text = agent_answer or await self._synthesize(forced_debate, transcript_json)
        if self.artifact_intent:
            visual = await self._produce_visual_artifact(forced_debate, transcript_json)
            if visual:
                artifact_receipt = visual["receipt"]
                final_text = str(visual["candidate"].get("summary") or "The interactive artifact is ready.")
            else:
                if not final_text:
                    final_text = await self._synthesize(forced_debate, transcript_json)
                await self.emit({
                    "t": "warning",
                    "code": "artifact_render_failed",
                    "note": "The visual artifact did not pass rendering checks; the grounded text deliverable was retained.",
                })
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
                entries=list(self.model_usage.values()),
                idempotency_key=f"hyper-room:{self.turn_id or 'unknown'}",
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
            "model_usage": list(self.model_usage.values()),
            "gathered_emails": sorted(self.gathered_emails),
            # Work results and debate claims are candidates, not evidence. The
            # verifier may ground claims only in retained inputs or actual tool
            # observations from this source-only snapshot.
            "gather_facts": self._source_evidence_snapshot(),
            "sim_report": self._sim_payload,  # the population-sim dashboard (None unless sim_mode on)
            "evo_playbooks": self.evo_playbooks,  # the playbooks injected this turn (api reflects on these)
            "skills_used": list(self.skills_used),  # METHOD skills applied (reflection + FE chips)
            "room_kind": self.room_kind,
            "collaboration_intensity": self.collaboration_intensity,
            "seo_evidence_governed": bool(self.room_kind == "seo" and self._seo_audit_evidence),
            "seo_artifact_id": (
                ((self._seo_audit_evidence or {}).get("capability") or {}).get("artifact_id")
            ),
            "campaign_bundle": campaign_bundle,
            "campaign_bundle_errors": campaign_bundle_errors,
            "growth_plan_contract": growth_plan_contract,
            "intended_output": self.intended_output,
            "post_output_actions": list(self.post_output_actions),
            "outreach_request": plan.get("outreach_request"),
            "outreach_metrics": dict(self._outreach_metrics),
            "work_orders": list(plan.get("work_orders") or []),
            "work_results": list(self.work_results),
            "work_order_result": None if self.room_phase else work_order_result,
            "runtime_stage_result": runtime_stage_result,
            "room_phase_result": room_phase_result,
            "artifact_intent": dict(self.artifact_intent) if self.artifact_intent else None,
            "artifact_receipt": artifact_receipt,
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
    emit: Callable[[Dict[str, Any]], Awaitable[Any]],
    director_model: Optional[str] = None,
    persona_model: Optional[str] = None,
    synth_model: Optional[str] = None,
    max_iters: int = 16,
    sim_mode: str = "off",
    sim_agents: int = 0,
    evo_mode: str = "off",
    evo_playbooks: Optional[Dict[str, List[str]]] = None,
    company_brief: str = "",
    execution_context: str = "",
    intended_output: str = "answer",
    room_kind: str = "",
    room_mode: str = "runtime",
    room_playbook: Optional[List[str]] = None,
    room_journal: Optional[List[Dict[str, Any]]] = None,
    room_instructions: str = "",
    sender_email: str = "",
    out_language: str = "",
    campaign_brief: Optional[Dict[str, Any]] = None,
    room_id: str = "",
    turn_id: str = "",
    direct_answer_hook: Optional[Callable[[str, str], Awaitable[Optional[str]]]] = None,
    agentic_task_hook: Optional[Callable[[str, str], Awaitable[Optional[str]]]] = None,
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
        execution_context=execution_context,
        intended_output=intended_output,
        room_kind=room_kind, room_mode=room_mode, room_playbook=room_playbook, room_journal=room_journal,
        room_instructions=room_instructions,
        sender_email=sender_email,
        out_language=out_language,
        campaign_brief=campaign_brief,
        room_id=room_id, turn_id=turn_id,
        direct_answer_hook=direct_answer_hook,
        agentic_task_hook=agentic_task_hook,
    )
    return await director.run()
