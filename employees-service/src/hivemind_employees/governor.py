"""P2 Governor — safety caps + kill switch for HyperAgents room turns.

The Governor is the OS's circuit breaker: a master kill switch plus per-turn token and
outbound caps that bound how much a single turn (or a runaway agent) can spend or send.

Every lever is env-driven and defaults to OFF / unlimited, so merely shipping this module
changes NO behavior — enabling a lever is an explicit operator action. The kill switch is
the one to reach for first in an incident; it complements the existing per-org
`pause-all` (control-plane) with an instant, all-orgs stop that needs no DB write.
"""
import os


def _truthy(v: str) -> bool:
    return str(v or "").strip().lower() in ("1", "true", "yes", "on")


def kill_switch_active() -> bool:
    """Master stop for ALL HyperAgents room turns. Set HYPER_KILL_SWITCH=1 to refuse new
    turns immediately — no LLM spend, no debate, no outbound. Reversible by unsetting it
    (no restart needed; read per turn)."""
    return _truthy(os.environ.get("HYPER_KILL_SWITCH"))


def kill_switch_reason() -> str:
    """Operator-facing note surfaced when the kill switch is engaged (optional)."""
    return os.environ.get("HYPER_KILL_SWITCH_REASON", "HyperAgents temporarily paused by an operator").strip()


def turn_token_cap() -> int:
    """Hard per-turn token ceiling summed across goalkeeper rounds. When >0, the turn seals
    as `cost_capped` once total tokens reach it (stops a runaway re-plan loop from burning
    budget). 0 = unlimited (default)."""
    try:
        return max(0, int(os.environ.get("HYPER_TURN_TOKEN_CAP", "0") or "0"))
    except ValueError:
        return 0


def outbound_cap() -> int:
    """Max outward sends (emails, etc.) a single turn may queue for approval. When >0, extra
    queued sends beyond the cap are dropped (and logged) so one turn can't fan out hundreds of
    outbound actions. 0 = unlimited (default). Outward sends remain HITL-approved regardless."""
    try:
        return max(0, int(os.environ.get("HYPER_OUTBOUND_CAP", "0") or "0"))
    except ValueError:
        return 0
