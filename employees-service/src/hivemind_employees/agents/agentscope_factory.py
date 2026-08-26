"""Builds an AgentScope ReActAgent for one DigitalEmployee row.

Used by `orchestration.TeamRoom` to spin up one agent per employee in a
collaborative task. Distinct from `factory.build_assistant()` which
returns a slackagents.Assistant — that path still drives the
single-employee Slack gateway flow.

Provider routing mirrors the slackagents factory:
  - 'openai' → AgentScope's OpenAIChatModel against api.openai.com
  - everything else → OpenAIChatModel against OpenRouter (Anthropic via
    OpenRouter prefix `anthropic/<model>`, Groq via `groq/<model>`, etc.).

This keeps a single OpenAI-compatible client for the multi-agent runner
while letting users keep their existing OpenRouter API keys.
"""
from __future__ import annotations

import logging
import os
import json
from typing import Any, List, Optional

from agentscope.agent import ReActAgent
from agentscope.formatter import (
    AnthropicChatFormatter,
    AnthropicMultiAgentFormatter,
    FormatterBase,
    OpenAIChatFormatter,
    OpenAIMultiAgentFormatter,
)
from agentscope.memory import InMemoryMemory
from agentscope.model import AnthropicChatModel, ChatModelBase, OpenAIChatModel

from ..ai_gateway import sdk_target
from ..hyper.model_policy import HYPER_FAST_MODEL, canonical_hyper_model, requires_openrouter

from .agentscope_tools import build_hivemind_toolkit, register_experience_tool

log = logging.getLogger(__name__)

OPENROUTER_BASE = "https://openrouter.ai/api/v1"
GROQ_BASE = "https://api.groq.com/openai/v1"

ROLE_LANE_MAP = {
    "coordinator": "Strategist",
    "strategist": "Strategist",
    "operator": "Strategist",
    "synthesizer": "Strategist",
    "investigator": "Researcher",
    "researcher": "Researcher",
    "analyst": "Researcher",
    "skeptic": "Skeptic",
    "critic": "Skeptic",
    "challenger": "Skeptic",
    "auditor": "Skeptic",
    "builder": "Builder",
    "engineer": "Builder",
    "developer": "Builder",
    "architect": "Builder",
    "communicator": "Communicator",
    "writer": "Communicator",
    "marketer": "Communicator",
    "advocate": "Communicator",
    "fact_checker": "Researcher",
}

PERSONA_CONTRACTS = {
    "Strategist": {
        "decision_style": "Sequences choices, forces tradeoffs, and keeps the room pointed at a clear next move.",
        "stance": "Keeps direction, sequencing, and execution pressure visible.",
        "blind_spots": ["Can over-smooth dissent", "May privilege alignment over hard risk"],
        "challenge_targets": ["Skeptic", "Builder"],
        "future_skills": ["scenario planning", "portfolio prioritization", "facilitated decision making"],
        "quality_gate": ["Requires a concrete goal, owner, and decision path before committing."],
    },
    "Builder": {
        "decision_style": "Decomposes ideas into shippable steps, dependencies, and implementation risks.",
        "stance": "Pushes the room toward a buildable answer.",
        "blind_spots": ["Can underweight ambiguity", "May compress tradeoffs too early"],
        "challenge_targets": ["Skeptic", "Strategist"],
        "future_skills": ["system design", "delivery planning", "operational hardening"],
        "quality_gate": ["Requires clear scope, interfaces, and the smallest useful next step."],
    },
    "Skeptic": {
        "decision_style": "Red-teams assumptions, hunts for failure modes, and makes hidden risk explicit.",
        "stance": "Challenges weak evidence and pushes back on wishful thinking.",
        "blind_spots": ["Can over-index on failure", "May slow momentum if the room is already aligned"],
        "challenge_targets": ["Strategist", "Builder", "Communicator"],
        "future_skills": ["adversarial review", "risk modeling", "enterprise diligence"],
        "quality_gate": ["Requires a concrete claim to challenge and evidence to support the pushback."],
    },
    "Researcher": {
        "decision_style": "Pulls together context, memory, and evidence before the room commits.",
        "stance": "Anchors discussion in what has already been learned.",
        "blind_spots": ["Can over-collect evidence", "May stall on uncertainty"],
        "challenge_targets": ["Strategist", "Communicator"],
        "future_skills": ["source synthesis", "market analysis", "memory reasoning"],
        "quality_gate": ["Requires a specific question and enough context to compare evidence."],
    },
    "Communicator": {
        "decision_style": "Translates the room into clear language for customers, partners, and the broader org.",
        "stance": "Keeps the answer legible and usable by real people.",
        "blind_spots": ["Can soften hard calls", "May oversimplify the tradeoffs"],
        "challenge_targets": ["Strategist", "Builder"],
        "future_skills": ["executive framing", "customer storytelling", "stakeholder alignment"],
        "quality_gate": ["Requires an audience and an outcome to frame the message correctly."],
    },
}


def _as_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()]
    if isinstance(value, tuple):
        return [str(v).strip() for v in value if str(v).strip()]
    text = str(value).strip()
    return [text] if text else []


def _derive_lane(employee_row: dict) -> str:
    role = str(employee_row.get("role_archetype") or "").strip().lower()
    if role in ROLE_LANE_MAP:
        return ROLE_LANE_MAP[role]
    haystack = " ".join(
        str(employee_row.get(key, "") or "")
        for key in ("name", "slug", "persona", "role_archetype")
    ).lower()
    if any(term in haystack for term in ("finance", "cfo", "margin", "pricing", "runway")):
        return "Strategist"
    if any(term in haystack for term in ("sales", "market", "customer", "support", "story", "copy", "brand")):
        return "Communicator"
    if any(term in haystack for term in ("risk", "security", "compliance", "audit", "challenge", "skeptic")):
        return "Skeptic"
    if any(term in haystack for term in ("research", "evidence", "insight", "study", "data", "market")):
        return "Researcher"
    if any(term in haystack for term in ("build", "ship", "engineer", "code", "infra", "platform", "product")):
        return "Builder"
    return "Strategist"


def _build_persona_contract(employee_row: dict) -> dict[str, Any]:
    lane = _derive_lane(employee_row)
    preset = PERSONA_CONTRACTS.get(lane, PERSONA_CONTRACTS["Strategist"])
    policy_rules = employee_row.get("policy_rules") or {}
    if isinstance(policy_rules, str):
        try:
            policy_rules = json.loads(policy_rules)
        except Exception:
            policy_rules = {}
    if not isinstance(policy_rules, dict):
        policy_rules = {}
    policy_contract = policy_rules.get("persona_contract") or {}
    if not isinstance(policy_contract, dict):
        policy_contract = {}

    peer_review_targets = _as_list(
        employee_row.get("peer_review_targets")
        or policy_rules.get("peer_review_targets")
        or policy_contract.get("challenge_targets"),
    )
    challenge_targets = _as_list(policy_contract.get("challenge_targets") or peer_review_targets)
    allowed_scope = str(policy_contract.get("allowed_scope") or employee_row.get("scope") or "organization").lower()
    context_home = str(policy_contract.get("context_home") or ("org" if allowed_scope == "organization" else allowed_scope)).lower()

    return {
        "persona_name": employee_row.get("name") or employee_row.get("slug") or "employee",
        "role_archetype": employee_row.get("role_archetype") or None,
        "lane": lane,
        "decision_style": policy_contract.get("decision_style") or preset["decision_style"],
        "stance": policy_contract.get("stance") or preset["stance"],
        "blind_spots": _as_list(policy_contract.get("blind_spots") or preset["blind_spots"]),
        "challenge_targets": challenge_targets or preset["challenge_targets"],
        "context_home": context_home,
        "allowed_scope": allowed_scope,
        "future_skills": _as_list(policy_contract.get("future_skills") or preset["future_skills"]),
        "quality_gate": _as_list(policy_contract.get("quality_gate") or preset["quality_gate"]),
        "peer_review_targets": peer_review_targets,
    }


def _format_persona_contract(contract: dict[str, Any]) -> str:
    lines = ["PERSONA CONTRACT"]
    if contract.get("stance"):
        lines.append(f"- Stance: {contract['stance']}")
    if contract.get("decision_style"):
        lines.append(f"- Decision style: {contract['decision_style']}")
    if contract.get("blind_spots"):
        lines.append(f"- Blind spots: {'; '.join(contract['blind_spots'])}")
    if contract.get("challenge_targets"):
        lines.append(f"- Challenge targets: {', '.join(contract['challenge_targets'])}")
    if contract.get("context_home"):
        lines.append(f"- Context home: {contract['context_home']}")
    if contract.get("allowed_scope"):
        lines.append(f"- Allowed scope: {contract['allowed_scope']}")
    if contract.get("quality_gate"):
        lines.append(f"- Quality gate: {' | '.join(contract['quality_gate'])}")
    return "\n".join(lines)


# Model-slug vendor prefixes OpenRouter serves natively. gpt-oss-* and llama-*
# are GROQ models and must go to Groq DIRECT even when an OpenRouter key is set —
# otherwise every Groq model gets mis-routed to OpenRouter (→ 400 / huge latency).
_OPENROUTER_VENDORS = (
    "deepseek/", "anthropic/", "meta-llama/", "mistralai/", "google/", "qwen/",
    "x-ai/", "cohere/", "microsoft/", "nousresearch/", "perplexity/", "openrouter/",
)


def _resolve_openai_compatible_target(
    provider: str,
    model: str,
    llm_api_key: Optional[str] = None,
    has_tools: bool = True,
) -> tuple[str, str, str]:
    """Route a model to the right OpenAI-compatible endpoint, MODEL-AWARE:
      • an EXPLICIT `openrouter` provider → OpenRouter, always (caller opt-in wins);
      • an OpenRouter-native vendor slug (deepseek/…, anthropic/…) or anthropic
        provider → OpenRouter (when a key is present);
      • otherwise gpt-oss-* / llama-* → GROQ DIRECT.
    The Groq llama→gpt-oss-20b swap (llama emits <function=> Llama-tag format → 400
    under strict tool validation) fires ONLY for TOOL-USING agents — tool-less
    agents (debate reactors, planner, verifier) keep llama / llama-3.1-8b-instant.

    An explicit provider request MUST outrank the model-name heuristic. It did not,
    and the failure was silent and total: `_verify_turn` sets llm_provider="openrouter"
    for the grounding judge, but gpt-oss force-routed to Groq anyway — so once the Groq
    account went delinquent EVERY room turn came back met=False/grounded_ok=False
    ("quality verification was unavailable") and the goalkeeper re-planned to its round
    cap on every turn: governance permanently closed, plus the token cost of the rework."""
    ml = (model or "").lower()
    openrouter_key = llm_api_key or os.environ.get("OPENROUTER_API_KEY")
    is_openrouter_model = (
        provider == "openrouter"
        or any(ml.startswith(v) for v in _OPENROUTER_VENDORS)
        or provider == "anthropic"
    )
    if openrouter_key and is_openrouter_model:
        routed_model = model
        if provider == "anthropic" and "/" not in model:
            routed_model = f"anthropic/{model}"
        base_url = os.environ.get("OPENROUTER_BASE_URL", OPENROUTER_BASE)
        return routed_model, openrouter_key, base_url

    # Groq direct. Never use an OpenRouter key here.
    groq_key = (llm_api_key if not openrouter_key else None) or os.environ.get("GROQ_API_KEY") or os.environ.get("LLM_API_KEY", "")
    groq_model = model
    if ml.startswith("openai/gpt-oss") or ml.startswith("gpt-oss"):
        groq_model = model  # respect explicit gpt-oss (20b / 120b)
    elif ("llama-3" in ml or "llama3" in ml) and has_tools:
        env_default = os.environ.get("GROQ_INFERENCE_MODEL", "")
        fallback = env_default if (env_default and "llama-3" not in env_default.lower() and "llama3" not in env_default.lower()) else HYPER_FAST_MODEL
        log.info("Swapping Groq tool-USING llama %s -> %s (tool-call reliability)", model, fallback)
        groq_model = fallback
    # else: tool-less llama / 8b-instant kept as-is (no swap)
    base_url = os.environ.get("GROQ_BASE_URL", GROQ_BASE)
    return groq_model, groq_key, base_url


def _uses_groq_fallback(provider: str) -> bool:
    normalized = (provider or "").lower()
    if normalized in {"openai", "anthropic_direct"}:
        return False
    return not os.environ.get("OPENROUTER_API_KEY") and bool(
        os.environ.get("GROQ_API_KEY") or os.environ.get("LLM_API_KEY")
    )


def _resolve_model(employee_row: dict, llm_api_key: Optional[str] = None) -> ChatModelBase:
    """Map employee.llm_provider + employee.model → AgentScope chat model."""
    provider = (employee_row.get("llm_provider") or "anthropic").lower()
    model = canonical_hyper_model(employee_row.get("model") or "claude-haiku-4-5")
    # Existing employee records may still name Groq. Treat that as a legacy
    # configuration and move the call onto the governed 20B OpenRouter route;
    # no HyperAgent participant may bypass the room-level provider policy.
    if provider == "groq":
        provider = "openrouter"
        model = HYPER_FAST_MODEL
    if requires_openrouter(model):
        provider = "openrouter"

    if provider == "openai":
        api_key = llm_api_key or os.environ.get("OPENAI_API_KEY", "")
        # max_retries enables the SDK's built-in exponential backoff w/ jitter
        # on 429/5xx; timeout bounds each call so a hang can't wedge a turn.
        return OpenAIChatModel(
            model_name=model,
            api_key=api_key,
            stream=False,
            client_kwargs={"max_retries": 3, "timeout": 60.0},
        )

    if provider == "anthropic_direct":
        # Native Anthropic SDK path (skips OpenRouter). Only used when an
        # employee explicitly opts in — the default 'anthropic' path stays
        # on OpenRouter for billing parity with the rest of HIVEMIND.
        api_key = llm_api_key or os.environ.get("ANTHROPIC_API_KEY", "")
        return AnthropicChatModel(
            model_name=model,
            api_key=api_key,
            stream=False,
            client_kwargs={"max_retries": 3, "timeout": 60.0},
        )

    # OpenAI-compatible providers can route through OpenRouter when present,
    # otherwise fall back to the same Groq endpoint used by Talk to HIVE.
    # has_tools = the agent has REAL tools (not just a *_noop placeholder) → the
    # llama→gpt-oss swap applies only here; tool-less agents keep their model.
    _tools = employee_row.get("tools") or []
    _has_tools = any(str(t) and not str(t).endswith("_noop") for t in _tools)
    routed_model, api_key, base_url = _resolve_openai_compatible_target(
        provider,
        model,
        llm_api_key=llm_api_key,
        has_tools=_has_tools,
    )
    base_url, api_key, gateway_default_headers = sdk_target(base_url, api_key)
    # max_retries gives the OpenAI SDK its built-in exponential backoff with
    # jitter on 429 (Groq rate limits) and 5xx — without it a single 429
    # silently drops a swarm speaker. timeout bounds each call.
    # reasoning_effort="low": gpt-oss on Groq otherwise burns large reasoning
    # token budgets ("medium" default) → each swarm speaker takes seconds and a
    # full R1-R5 turn stacks ~15 calls → very slow first chat. Low effort keeps
    # the grounded answer quality while cutting per-call latency sharply.
    _kwargs = dict(
        model_name=routed_model,
        api_key=api_key,
        stream=False,
        client_kwargs={"base_url": base_url, "default_headers": gateway_default_headers,
                       "max_retries": 3, "timeout": 60.0},
    )
    # reasoning_effort is a REASONING-model param: gpt-oss supports it (and "low"
    # cuts Groq latency sharply). llama-3.x (8b-instant / 70b) and other models
    # 400 with "`reasoning_effort` is not supported with this model" — so only
    # send it for gpt-oss.
    if "gpt-oss" in (routed_model or "").lower():
        _kwargs["reasoning_effort"] = "low"
        # Do not pass Groq's reasoning_format extension through AgentScope's
        # OpenAI client. Current openai.AsyncCompletions rejects it as an
        # unexpected keyword and silently disables the verification pass. The
        # response normalizer already strips Harmony analysis-channel markers.
    return OpenAIChatModel(**_kwargs)


def _resolve_formatter(provider: str) -> FormatterBase:
    """Pick the multi-agent formatter matching the provider family.

    Multi-agent formatters preserve speaker identity in prompts (using
    name-tagged turns) instead of collapsing everything to a single
    user/assistant alternation. This is what makes the ReActAgent see
    peer replies as distinct voices when participating in MsgHub.
    """
    p = (provider or "").lower()
    if p == "anthropic_direct":
        return AnthropicMultiAgentFormatter()
    # OpenAIMultiAgentFormatter works for OpenAI direct AND OpenRouter
    # (OpenAI-compatible API surface).
    return OpenAIMultiAgentFormatter()


_DEFAULT_HIVEMIND_TOOLS = [
    "hivemind_recall",
    "hivemind_list_memories",
    "hivemind_get_memory",
    "hivemind_traverse_graph",
    "hivemind_query_with_ai",
    "hivemind_save_memory",
]


def resolve_agent_tool_names(configured_tools: Optional[List[str]]) -> List[str]:
    """Decide which tools an agent gets, given its employee_row['tools'] config.

    HIVEMIND is the company brain — recall is not an opt-in per-employee
    setting, it's core infrastructure. A real employee whose configured
    `tools` list happens to omit hivemind_recall (e.g. a room agent set up
    with just a connector like ["gmail_search"]) was silently losing ALL
    company-memory access, because the old code was a bare `or` that
    discarded the wide default the instant ANY tools list was configured.
    Confirmed live 2026-08-12: a real turn asking to prioritize named
    HIVEMIND/TARA/HYPERAGENTS/RUNTIME features issued zero recall queries and
    the lead agent had no recall tool to reach for as a fallback.

    Sentinel toolless agents (the verifier's ["_verify_noop"], the planner's
    ["_plan_noop"]) are left exactly as configured — they deliberately run
    with NO tools to keep judgment/planning pure; force-injecting recall
    there would reintroduce the tool-call drift they exist to prevent.
    """
    if not configured_tools:
        return list(_DEFAULT_HIVEMIND_TOOLS)
    if any(str(t).startswith("_") for t in configured_tools):
        return list(configured_tools)
    return list(dict.fromkeys(list(configured_tools) + ["hivemind_recall"]))


def build_react_agent(
    employee_row: dict,
    hivemind_api_key: str,
    user_id: Optional[str] = None,
    org_id: Optional[str] = None,
    project_id: Optional[str] = None,
    plan_notebook: Optional[object] = None,
) -> ReActAgent:
    """Construct an AgentScope ReActAgent for one DigitalEmployee.

    employee_row required keys:
      - id, name, slug, persona, model, llm_provider, tools (list[str]).

    The persona becomes the ReActAgent's `sys_prompt` so the ReAct loop
    stays in-character. Tools come from the same HIVEMIND endpoints as
    the slackagents path.
    """
    name = employee_row["slug"]  # unique per org
    persona_contract = (
        (employee_row.get("hyper") or {}).get("persona_contract")
        or employee_row.get("persona_contract")
        or _build_persona_contract(employee_row)
    )
    persona = (
        (employee_row.get("active_prompt_version") or {}).get("system_prompt")
        or employee_row.get("persona")
        or ""
    )
    persona = (
        f"{_format_persona_contract(persona_contract)}\n"
        "Use this contract as the binding operating model for the room. "
        "Keep the base persona, but do not dilute stance, challenge behavior, "
        "or scope discipline.\n\n"
        f"BASE PERSONA\n{persona}"
    ).strip()
    # Surface enabled connectors so the agent reaches for them naturally — the
    # same way it uses memory recall and web. They're just more tools in the
    # action space, used WITHIN the normal room interaction (openswarm style).
    _conns = employee_row.get("connectors") or []
    if _conns:
        _conn_lines = []
        if "gmail" in _conns:
            _conn_lines.append("- group `gmail` (full): read free — gmail_search, gmail_get, gmail_get_thread, gmail_list_drafts, gmail_list_labels; organize (no approval) — gmail_create_draft, gmail_modify (mark-read/archive/label); outward — gmail_send, gmail_reply, gmail_trash are SAVED AS A DRAFT then need the user's approval to actually go.")
        if "google_docs" in _conns:
            _conn_lines.append("- group `google_docs` → docs_create(title, content), docs_append(documentId, text) — produce a real document (report, pitch deck). Internal artifact, no approval.")
        if "google_sheets" in _conns:
            _conn_lines.append("- group `google_sheets` → sheets_create(title, rows_json), sheets_append(spreadsheetId, rows_json) — produce a real spreadsheet (financial plan, tracker). rows_json is a JSON 2-D array string, first row = headers. Internal artifact, no approval.")
        for _c in _conns:
            if _c not in ("gmail", "google_docs", "google_sheets"):
                _g = _c.replace("-", "_")
                _conn_lines.append(f"- group `{_g}` → {_g}_list_tools() then {_g}_call(tool_name, arguments).")
        persona = (
            persona
            + "\n\nLIVE CONNECTOR GROUPS (enabled for this room — activate before use):\n"
            + "\n".join(_conn_lines)
            + "\nThese groups are INACTIVE by default. When the task needs one, FIRST call "
              "reset_equipped_tools(['<group>']) to equip it (e.g. reset_equipped_tools(['google_docs'])), "
              "then call its tools. Use reads (gmail_search, *_list_tools) freely for live context. "
              "But DO NOT produce the OUTPUT (docs_create/sheets_create/gmail_send) until the team has "
              "debated and AGREED — the room only unlocks output at the synthesis step. When it's time, "
              "produce the agreed deliverable ONCE, grounded in recalled facts. Docs/sheets run without "
              "approval; an outward send (gmail_send) is held for the user's one-click approval. "
              "No need to ask for IDs."
        )
    # LEADS & CALLS — tool discipline (list_prospects / save_prospect / propose_call are ALWAYS
    # available). Reuse-first + human-gated calls. This is the "when to trigger" guidance so the
    # agent reaches for the RIGHT tool instead of re-discovering or dialing blindly.
    persona = (
        persona
        + "\n\nLEADS & CALLS (tool discipline — follow exactly):\n"
        "- SEE / REUSE FIRST: any request about 'our leads/prospects', or to contact / reach out to / "
        "email / call an EXISTING lead, MUST start by calling `list_prospects` (optionally with a query) "
        "to read the company's shared lead book — each lead carries a note on why it mattered + its real "
        "contact details. NEVER act on a lead from memory, and never ask the user for details the lead "
        "book already holds.\n"
        "- DISCOVERY of brand-new prospects is a ROOM action (Google Places), not a tool you hold: if the "
        "user asks for NEW/more prospects and the lead book has none that fit, call `list_prospects` "
        "first, then state that a discovery search is needed — NEVER invent firms.\n"
        "- SAVE: when you find or qualify a lead worth keeping, call `save_prospect(company, note, phone, "
        "email, website)` with a short note on WHY it matters right now — so every room reuses it later.\n"
        "- CALL: when a LIVE phone call is the right next step for a SPECIFIC prospect (a warm/qualified "
        "lead, a booked-meeting opening, a time-sensitive follow-up — not routine info), call "
        "`propose_call(company, phone, why)`. It does NOT dial — it queues the call for the user's "
        "one-click approval (voice, language and strategy are auto-selected). If the user GIVES a phone "
        "number (or you already have it), call `propose_call` DIRECTLY — do NOT `list_prospects` first; "
        "only `list_prospects` first when you need a number you don't have. Use a call only when it "
        "clearly beats an email."
    ).strip()
    # Default fallback is wider than before — gives a fresh employee the full
    # HIVEMIND reach; a configured-but-incomplete list still gets recall
    # merged in (see resolve_agent_tool_names). Hyper-room agents override
    # via merged_emp.
    requested_tools = resolve_agent_tool_names(employee_row.get("tools"))
    enabled_tools = list(requested_tools)

    provider = employee_row.get("llm_provider") or "anthropic"
    # Tool calling works on Groq llama-3.3-70b + all OpenRouter providers
    # through the OpenAI-compatible chat completions API. Previously we
    # disabled tools whenever the runtime fell back to Groq — that left
    # swarm agents blind to HIVEMIND. Re-enable; if a specific model
    # turns out to be incompatible, set HYPER_DISABLE_GROQ_TOOLS=true.
    disable_groq_tools = os.environ.get("HYPER_DISABLE_GROQ_TOOLS", "").lower() == "true"
    toolkit = None
    if disable_groq_tools and _uses_groq_fallback(provider):
        enabled_tools = []
        log.info("HYPER_DISABLE_GROQ_TOOLS set; tools disabled for employee=%s", name)
    else:
        toolkit = build_hivemind_toolkit(
            api_key=hivemind_api_key,
            enabled_tool_names=enabled_tools,
            user_id=user_id,
            org_id=org_id,
            project_id=project_id,
            # Per-character connector grants for this room (P3 HyperAgents×Connectors).
            connectors=employee_row.get("connectors") or [],
            # read_only=True (searcher owners): register connector READ tools only
            # (gmail search/get; skip docs/sheets producers) so the small owner model
            # gets context-search without write tools that queue spurious approvals.
            connectors_read_only=bool(employee_row.get("connectors_read_only")),
        )
        # Phase 2: connectors are registered as INACTIVE groups. Pre-equip the
        # ones this agent should have so tool use is reliable (llama doesn't
        # always call the meta-tool itself). The plan's subset narrows this in
        # P3; the meta-tool still lets the agent equip MORE at runtime.
        # `activate_connectors` (plan-driven) takes precedence; else all granted.
        _to_activate = employee_row.get("activate_connectors") or _conns
        if toolkit is not None and _to_activate:
            try:
                toolkit.update_tool_groups(
                    group_names=[str(c).replace("-", "_") for c in _to_activate], active=True,
                )
            except Exception as exc:  # noqa: BLE001
                log.warning("connector group activation failed: %s", exc)

        # GLOBAL learned playbook → lazy `recall_experience` tool + a one-line pointer
        # (not a wholesale inject). The agent loads the relevant lessons on demand, the
        # same way it reaches for recall/web. Read-only: private chat never journalises.
        register_experience_tool(toolkit, org_id, name)
        _pb = employee_row.get("evo_playbook") or []
        _pb_n = len([x for x in _pb if str(x).strip()]) if isinstance(_pb, list) else 0
        if _pb_n:
            persona = (
                persona
                + f"\n\nYou have {_pb_n} learned lesson(s) from your past work across all rooms. "
                  "When a task resembles something you have handled before, call "
                  "recall_experience(topic) to load the relevant lessons and apply them."
            )

    model = _resolve_model(employee_row)
    formatter = _resolve_formatter(provider)

    # Per-agent tool-call counter. post_acting fires once per tool call.
    # Stored on agent instance so the orchestrator can read it after a turn.
    def _make_count_hook(target_agent):
        async def _hook(*args, **kwargs):
            try:
                setattr(target_agent, "tool_call_count",
                        int(getattr(target_agent, "tool_call_count", 0)) + 1)
            except Exception as exc:  # noqa: BLE001
                log.debug("tool_call_count hook tick failed: %s", exc)
        return _hook

    try:
        max_iters = int(employee_row.get("max_iters") or os.environ.get("AGENTSCOPE_MAX_ITERS") or 25)
    except Exception:
        max_iters = 25

    _ra_kwargs = dict(
        name=name,
        sys_prompt=persona,
        model=model,
        formatter=formatter,
        toolkit=toolkit,
        memory=InMemoryMemory(),
        max_iters=max_iters,
        # Phase 2: enable the reset_equipped_tools meta-tool ONLY when this agent
        # has connector groups to activate (AgentScope-native MCPActivate). Off
        # for tool-less agents (e.g. the planner) so they stay clean text.
        enable_meta_tool=bool(_conns),
        # Sequential tool calls keep transcripts deterministic for
        # multi-agent reasoning. Parallel tool calls can be re-enabled
        # per-employee later if we want speedups for trusted roles.
        parallel_tool_calls=False,
        print_hint_msg=False,
    )
    # Agentic orchestrator (flagged): attach a PlanNotebook so this agent gets
    # the native create_plan / update_subtask_state / finish_subtask tools and
    # auto-hints — the lead decomposes + the team drives subtasks themselves.
    if plan_notebook is not None:
        _ra_kwargs["plan_notebook"] = plan_notebook
    agent = ReActAgent(**_ra_kwargs)
    # When the agent has connectors, enable_meta_tool=True puts the PlanNotebook
    # tools (create_plan / update_subtask_state / finish_subtask) into the gated
    # 'plan_related' group — inactive by default → the LLM's create_plan call 400s
    # ("not in request.tools"). Activate that group so the plan tools are usable.
    if plan_notebook is not None:
        try:
            agent.toolkit.update_tool_groups(["plan_related"], True)
        except Exception as exc:  # noqa: BLE001
            log.warning("activate plan_related group failed: %s", exc)
    setattr(agent, "hivemind_enabled_tools", list(requested_tools))
    setattr(agent, "hivemind_use_simulation_actions", _uses_groq_fallback(provider))
    setattr(agent, "tool_call_count", 0)
    # Attach post_acting hook so every tool call ticks the counter.
    try:
        agent.register_instance_hook("post_acting", "tool_call_counter",
                                      _make_count_hook(agent))
    except Exception as exc:  # noqa: BLE001
        log.warning("Failed to attach tool_call_counter hook: %s", exc)
    log.info(
        "Built ReActAgent for employee=%s model=%s tools=%d",
        name, employee_row.get("model"), len(enabled_tools),
    )
    try:
        setattr(agent, "hivemind_persona_contract", persona_contract)
    except Exception:
        pass
    return agent
