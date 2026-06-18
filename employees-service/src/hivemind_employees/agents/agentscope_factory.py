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
from typing import Any, Optional

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

from .agentscope_tools import build_hivemind_toolkit

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


def _resolve_openai_compatible_target(
    provider: str,
    model: str,
    llm_api_key: Optional[str] = None,
) -> tuple[str, str, str]:
    openrouter_key = llm_api_key or os.environ.get("OPENROUTER_API_KEY")
    if openrouter_key:
        routed_model = model
        if provider == "anthropic" and "/" not in model:
            routed_model = f"anthropic/{model}"
        elif provider == "groq" and "/" not in model:
            routed_model = f"groq/{model}"
        base_url = os.environ.get("OPENROUTER_BASE_URL", OPENROUTER_BASE)
        return routed_model, openrouter_key, base_url

    groq_key = llm_api_key or os.environ.get("GROQ_API_KEY") or os.environ.get("LLM_API_KEY", "")
    groq_model = model
    # Groq-hosted Llama-3.x models emit Llama-tag <function=NAME{...}> format
    # under strict-mode tool validation → tool_use_failed (400). Force a
    # tool-call-reliable model (openai/gpt-oss-20b by default, overridable
    # via GROQ_INFERENCE_MODEL). Applies whenever we fall back to Groq AND
    # the requested model is a known-broken Llama family.
    env_default = os.environ.get("GROQ_INFERENCE_MODEL", "")
    # If the env-provided default is itself a Llama-3 (known broken for
    # OpenAI tool_calls under Groq strict validation), drop it.
    if not env_default or "llama-3" in env_default.lower() or "llama3" in env_default.lower():
        fallback_default = "openai/gpt-oss-20b"
    else:
        fallback_default = env_default
    if provider != "groq" or "/" in model:
        groq_model = fallback_default
    elif "llama-3" in model.lower() or "llama3" in model.lower():
        log.info("Swapping Groq tool-unreliable model %s -> %s", model, fallback_default)
        groq_model = fallback_default
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
    model = employee_row.get("model") or "claude-haiku-4-5"

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
    routed_model, api_key, base_url = _resolve_openai_compatible_target(
        provider,
        model,
        llm_api_key=llm_api_key,
    )
    # max_retries gives the OpenAI SDK its built-in exponential backoff with
    # jitter on 429 (Groq rate limits) and 5xx — without it a single 429
    # silently drops a swarm speaker. timeout bounds each call.
    # reasoning_effort="low": gpt-oss on Groq otherwise burns large reasoning
    # token budgets ("medium" default) → each swarm speaker takes seconds and a
    # full R1-R5 turn stacks ~15 calls → very slow first chat. Low effort keeps
    # the grounded answer quality while cutting per-call latency sharply.
    return OpenAIChatModel(
        model_name=routed_model,
        api_key=api_key,
        stream=False,
        reasoning_effort="low",
        client_kwargs={"base_url": base_url, "max_retries": 3, "timeout": 60.0},
    )


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


def build_react_agent(
    employee_row: dict,
    hivemind_api_key: str,
    user_id: Optional[str] = None,
    org_id: Optional[str] = None,
    project_id: Optional[str] = None,
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
            _conn_lines.append("- group `gmail` → gmail_search(query, max), gmail_get(id) — read the team's email for live context.")
        if "google_docs" in _conns:
            _conn_lines.append("- group `google_docs` → docs_create(title, content), docs_append(documentId, text) — write a real doc when the output is a document.")
        for _c in _conns:
            if _c not in ("gmail", "google_docs"):
                _g = _c.replace("-", "_")
                _conn_lines.append(f"- group `{_g}` → {_g}_list_tools() then {_g}_call(tool_name, arguments).")
        persona = (
            persona
            + "\n\nLIVE CONNECTOR GROUPS (enabled for this room — activate before use):\n"
            + "\n".join(_conn_lines)
            + "\nThese groups are INACTIVE by default. When the task needs one, FIRST call "
              "reset_equipped_tools(['<group>']) to equip it (e.g. reset_equipped_tools(['gmail'])), "
              "then call its tools. Use them the same way you use memory recall and web search — pull "
              "real third-party context, or produce the output (doc/sheet/etc). Don't just talk about "
              "them; activate and call. No need to ask permission or for IDs."
        )
    # Default fallback is wider than before — gives a fresh employee
    # the full HIVEMIND reach. Hyper-room agents override via merged_emp.
    requested_tools = employee_row.get("tools") or [
        "hivemind_recall",
        "hivemind_list_memories",
        "hivemind_get_memory",
        "hivemind_traverse_graph",
        "hivemind_query_with_ai",
        "hivemind_save_memory",
    ]
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

    agent = ReActAgent(
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
