"""Room METHOD skills — progressive-disclosure skill registry for HyperAgents.

Skills live as versioned markdown files in this package, one folder per room
kind (market / content / business / outreach / strategy / general):

    skills/<kind>/<skill-name>.md
    ---
    when: <one-liner the planner sees in the catalog>
    ---
    <full method body, loaded on demand>

Distinct from engine._SKILLS (output-FORMAT contracts). These are METHOD
contracts: how the room investigates and reasons. The planner pays only for
the CATALOG (name + when, tens of tokens); a body lands on the blackboard
only when the plan (or the task-tag heuristic) selects it. Every body is
EVIDENCE-FORCING (recall → connector → web sequence, source-per-claim,
UNVERIFIED flags) — skills are the bridge that makes agents actually use
hivemind/web/connectors in a disciplined order.

Files are parsed once at import and cached; a malformed file is skipped with
a warning, never fatal. Adding a skill = dropping a new .md file.
"""
from __future__ import annotations

import logging
import os
import re
from typing import Dict, List, Tuple

from ..domains import (
    default_domain_skill,
    domain_skill_catalog,
    get_domain_pack,
    load_domain_skill,
)

log = logging.getLogger("hyper.skills")

_DIR = os.path.dirname(__file__)
_FM_RE = re.compile(r"^---\s*\nwhen:\s*(?P<when>.+?)\s*\n---\s*\n(?P<body>.*)$", re.S)

# room_kind -> skill_name -> (when_one_liner, body)
METHOD_SKILLS: Dict[str, Dict[str, Tuple[str, str]]] = {}


def _load() -> None:
    for kind in sorted(os.listdir(_DIR)):
        kdir = os.path.join(_DIR, kind)
        if not os.path.isdir(kdir) or kind.startswith("_"):
            continue
        for fn in sorted(os.listdir(kdir)):
            if not fn.endswith(".md"):
                continue
            name = fn[:-3]
            try:
                with open(os.path.join(kdir, fn), encoding="utf-8") as f:
                    raw = f.read()
                m = _FM_RE.match(raw)
                if not m:
                    log.warning("[skills] %s/%s missing 'when:' frontmatter — skipped", kind, fn)
                    continue
                METHOD_SKILLS.setdefault(kind, {})[name] = (
                    m.group("when").strip(), m.group("body").strip())
            except Exception as exc:  # noqa: BLE001 — one bad file never breaks the engine
                log.warning("[skills] failed to load %s/%s: %s", kind, fn, exc)


_load()

# task_tag -> room_kind (sidecar task tags: RESEARCH|FEATURE|MARKETING|OUTREACH|STRATEGY|…)
_TAG_TO_KIND = {
    "HQ": "hq",
    "CAMPAIGN": "campaign",
    "ROOM_SEO": "seo",
    "ROOM_MARKETING": "marketing",
    "ROOM_OUTREACH": "outreach",
    "ROOM_BRANDING": "branding",
    "ROOM_FUNDRAISING": "fundraising",
    "ROOM_RESEARCH": "research",
    "ROOM_PRODUCT": "product",
    "ROOM_DESIGN": "design",
    "ROOM_LEGAL_FINANCE": "legal_finance",
    "RESEARCH": "market",
    "MARKETING": "content",
    "OUTREACH": "outreach",
    "STRATEGY": "strategy",
    "FEATURE": "business",
}

_KIND_KEYWORDS = [
    ("campaign", ("campaign id", "campaign goal", "multichannel campaign", "multi-channel campaign")),
    ("outreach", ("outreach", "cold email", "prospect", "lead gen", "sales call", "book meeting")),
    ("market", ("competitor", "market research", "landscape", "icp", "market size", "segment")),
    ("content", ("content", "blog", "social", "post", "campaign", "newsletter", "seo")),
    ("business", ("pricing", "revenue", "unit econom", "business model", "cost", "budget")),
    ("strategy", ("strategy", "roadmap", "prioriti", "decision", "invest", "pivot")),
]


def resolve_room_kind(task_tag: str, goal: str, message: str) -> str:
    """Map a turn to a room kind: explicit task tag first, then goal/message keywords."""
    raw_tag = str(task_tag or "").strip()
    # Permanent rooms persist the canonical domain slug (for example `seo`),
    # while older task callers send aliases such as `ROOM_SEO` or `RESEARCH`.
    # A canonical slug is already authoritative and must not fall through to a
    # keyword such as "content" in the active message.
    canonical = raw_tag.lower().replace("-", "_")
    if canonical and get_domain_pack(canonical):
        return canonical
    kind = _TAG_TO_KIND.get(raw_tag.upper())
    if kind and (kind in METHOD_SKILLS or get_domain_pack(kind)):
        return kind
    # The TURN MESSAGE outranks the room goal: an HQ/task room's goal often
    # embeds the whole onboarding task list (e.g. contains "Outreach"), which
    # mis-typed a competitor question as an outreach turn. Two passes.
    for hay in (str(message or "").lower(), str(goal or "").lower()):
        for k, words in _KIND_KEYWORDS:
            if (k in METHOD_SKILLS or get_domain_pack(k)) and any(w in hay for w in words):
                return k
    return "general"


def skill_catalog(room_kind: str) -> List[Tuple[str, str]]:
    """(name, when) pairs for the kind + the general fallbacks — the ONLY part
    the planner prompt pays for."""
    out: List[Tuple[str, str]] = list(domain_skill_catalog(room_kind))
    for name, (when, _body) in METHOD_SKILLS.get(room_kind, {}).items():
        out.append((name, when))
    if room_kind != "general":
        for name, (when, _body) in METHOD_SKILLS.get("general", {}).items():
            out.append((name, when))
    return out


def load_method_skill(name: str) -> str:
    """Full body by name, searched across all kinds. '' when unknown."""
    for skills in METHOD_SKILLS.values():
        if name in skills:
            return skills[name][1]
    return load_domain_skill(name)


def default_skill_for(room_kind: str) -> str:
    """Auto-load pick when the plan selects none: first kind skill, else evidence-first."""
    domain_default = default_domain_skill(room_kind)
    if domain_default:
        return domain_default
    kind_skills = METHOD_SKILLS.get(room_kind) or {}
    return next(iter(kind_skills), "evidence-first")
