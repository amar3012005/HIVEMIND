"""Versioned domain packs for dedicated HyperAgents Rooms.

Domain packs parameterize the existing Director pipeline. They never introduce
their own control flow: general rooms keep the existing behavior, while a
tagged room adds domain instructions, progressively disclosed skills, a tool
policy, and a final-report contract.
"""
from __future__ import annotations

from dataclasses import dataclass
import json
import logging
import os
import re
from typing import Dict, List, Optional, Tuple

log = logging.getLogger("hyper.domains")

_DIR = os.path.dirname(__file__)
_SLUG_RE = re.compile(r"^[a-z][a-z0-9_]{1,39}$")
_SKILL_RE = re.compile(r"^---\s*\nwhen:\s*(?P<when>.+?)\s*\n---\s*\n(?P<body>.*)$", re.S)


@dataclass(frozen=True)
class DomainPack:
    slug: str
    version: int
    display_name: str
    description: str
    lead_shape: str
    director_prompt: str
    toolkit_prompt: str
    report_contract: str
    skills: Dict[str, Tuple[str, str]]
    default_skill: str
    capabilities: Tuple[Dict[str, str], ...]

    def skill_catalog(self) -> List[Tuple[str, str]]:
        return [(name, when) for name, (when, _body) in self.skills.items()]


def _read(path: str) -> str:
    with open(path, encoding="utf-8") as handle:
        return handle.read().strip()


def _load_pack(path: str) -> Optional[DomainPack]:
    try:
        manifest = json.loads(_read(os.path.join(path, "pack.json")))
        slug = str(manifest.get("slug") or "").strip().lower()
        version = int(manifest.get("version") or 0)
        if not _SLUG_RE.match(slug) or version < 1 or os.path.basename(path) != slug:
            raise ValueError("invalid slug, folder, or version")
        lead_shape = str(manifest.get("lead_shape") or "maker").strip().lower()
        if lead_shape not in {"maker", "panel", "auto"}:
            raise ValueError("lead_shape must be maker, panel, or auto")

        skills: Dict[str, Tuple[str, str]] = {}
        skills_dir = os.path.join(path, "skills")
        if os.path.isdir(skills_dir):
            for filename in sorted(os.listdir(skills_dir)):
                if not filename.endswith(".md"):
                    continue
                match = _SKILL_RE.match(_read(os.path.join(skills_dir, filename)))
                if not match:
                    log.warning("[domains] %s/%s has invalid skill frontmatter", slug, filename)
                    continue
                skills[filename[:-3]] = (match.group("when").strip(), match.group("body").strip())

        default_skill = str(manifest.get("default_skill") or "").strip()
        if default_skill and default_skill not in skills:
            raise ValueError("default_skill must name a skill in this pack")
        capabilities = []
        for capability in manifest.get("capabilities") or []:
            capability_id = str(capability.get("id") or "").strip()
            capability_version = str(capability.get("version") or "").strip()
            if not re.match(r"^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$", capability_id):
                raise ValueError("invalid capability id")
            if not re.match(r"^\d+\.\d+\.\d+$", capability_version):
                raise ValueError("invalid capability version")
            capabilities.append({
                "id": capability_id,
                "version": capability_version,
                "when": str(capability.get("when") or "").strip(),
            })

        return DomainPack(
            slug=slug,
            version=version,
            display_name=str(manifest.get("display_name") or slug.replace("_", " ").title()),
            description=str(manifest.get("description") or "").strip(),
            lead_shape=lead_shape,
            director_prompt=_read(os.path.join(path, "director.md")),
            toolkit_prompt=_read(os.path.join(path, "toolkit.md")),
            report_contract=_read(os.path.join(path, "report.md")),
            skills=skills,
            default_skill=default_skill or next(iter(skills), ""),
            capabilities=tuple(capabilities),
        )
    except Exception as exc:  # noqa: BLE001 - one pack must never break general Rooms
        log.warning("[domains] skipped %s: %s", os.path.basename(path), exc)
        return None


def _load() -> Dict[str, DomainPack]:
    packs: Dict[str, DomainPack] = {}
    for name in sorted(os.listdir(_DIR)):
        path = os.path.join(_DIR, name)
        if name.startswith("_") or not os.path.isdir(path):
            continue
        pack = _load_pack(path)
        if pack:
            packs[pack.slug] = pack
    return packs


DOMAIN_PACKS = _load()


def get_domain_pack(slug: str) -> Optional[DomainPack]:
    return DOMAIN_PACKS.get(str(slug or "").strip().lower())


def domain_slugs() -> List[str]:
    return sorted(DOMAIN_PACKS)


def load_domain_skill(name: str) -> str:
    for pack in DOMAIN_PACKS.values():
        if name in pack.skills:
            return pack.skills[name][1]
    return ""


def domain_skill_catalog(slug: str) -> List[Tuple[str, str]]:
    pack = get_domain_pack(slug)
    return pack.skill_catalog() if pack else []


def default_domain_skill(slug: str) -> str:
    pack = get_domain_pack(slug)
    return pack.default_skill if pack else ""
