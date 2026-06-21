#!/usr/bin/env python3
"""
social_sim.py — Groq llama-8b multi-perspective personified social simulation (CSI spike).

Mirrors the MiroFish CSI behavior (CSI_MIROFISH.md) on the CHEAPEST model
(llama-3.1-8b-instant):

    context pool ─▶ personas (multi-perspective) ─▶ multi-round simulation
    (recall → propose → peer-review → revise → synthesize) with NATIVE tool-calling
    (internal recall over the context pool + web_search via groq/compound-mini),
    producing grounded, provenance-linked claim / trial / recall artifacts (JSONL).

It ALSO runs an A/B harness that measures which prompt strategy makes an 8b persona
most in-character + grounded (scored by a stronger judge model), so we LEARN how to
get accurate personified answers out of the cheap model — to power the swarm.

Env (read from MiroFish/.env or the process env):
    LLM_API_KEY      Groq key (gsk_...)
    LLM_BASE_URL     https://api.groq.com/openai/v1   (default if unset)

Usage:
    python3 social_sim.py --topic "Should SINGULANCE raise a seed round now?"
    python3 social_sim.py --topic "..." --context notes.txt --agents 6 --rounds 2
    python3 social_sim.py --topic "..." --ab          # run the personification A/B study
    python3 social_sim.py --topic "..." --ab --no-sim  # A/B only (fast/cheap)
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
import time
from collections import Counter
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import httpx

# ── config ────────────────────────────────────────────────────────────────
AGENT_MODEL = os.environ.get("SWARM_AGENT_MODEL", "llama-3.1-8b-instant")   # the cheap model under test
WEB_MODEL = os.environ.get("SWARM_WEB_MODEL", "groq/compound-mini")          # web-search-enabled
JUDGE_MODEL = os.environ.get("SWARM_JUDGE_MODEL", "openai/gpt-oss-120b")     # reliable scorer (not under test)
REPORT_MODEL = os.environ.get("SWARM_REPORT_MODEL", "openai/gpt-oss-120b")   # high-quality final report (MiroFish ReportAgent analog)
# On a 429 the primary is rate-limited; fall back to a DIFFERENT model family (separate
# rate-limit bucket) so the burst keeps going instead of dropping posts. Env-tunable.
FALLBACK_CHAIN = [m.strip() for m in os.environ.get(
    "SWARM_FALLBACKS", "openai/gpt-oss-20b,llama-3.3-70b-versatile").split(",") if m.strip()]
BASE_URL = os.environ.get("LLM_BASE_URL", "https://api.groq.com/openai/v1").rstrip("/")
MAX_TOOL_ITERS = 4
HTTP_TIMEOUT = httpx.Timeout(60.0, connect=10.0)

# Bounded concurrency — fire 150 personas in PARALLEL but cap in-flight Groq calls so we
# don't trigger a 429 storm (set in main from --concurrency). None = unbounded.
_SEM: Optional[asyncio.Semaphore] = None
_RATE_429 = 0  # observed rate-limit hits this run


def _load_key() -> str:
    """Groq key — same vars the employees-service uses (GROQ_API_KEY / LLM_API_KEY). Falls back
    to walking UP from the script for any .env that defines one — works from any checkout."""
    key = os.environ.get("GROQ_API_KEY") or os.environ.get("LLM_API_KEY") or ""
    if key:
        return key
    here = Path(__file__).resolve()
    for parent in [here.parent, *here.parents][:8]:
        envf = parent / ".env"
        if not envf.exists():
            continue
        for line in envf.read_text(errors="ignore").splitlines():
            line = line.strip()
            for var in ("GROQ_API_KEY", "LLM_API_KEY"):
                if line.startswith(var + "=") and "your_" not in line:
                    val = line.split("=", 1)[1].strip().strip('"').strip("'")
                    if val:
                        return val
    sys.exit("No GROQ_API_KEY / LLM_API_KEY in env or any parent .env")


# ── token / cost accounting (counts EVERY model, not one) ───────────────────
class Meter:
    def __init__(self) -> None:
        self.by: Dict[str, Dict[str, int]] = {}
        self.fallback = 0  # calls that succeeded on a fallback model (primary was rate-limited)

    def add(self, model: str, usage: Dict[str, Any]) -> None:
        b = self.by.setdefault(model, {"in": 0, "out": 0, "calls": 0})
        b["in"] += int((usage or {}).get("prompt_tokens", 0) or 0)
        b["out"] += int((usage or {}).get("completion_tokens", 0) or 0)
        b["calls"] += 1

    def summary(self) -> Dict[str, Any]:
        tot_in = sum(v["in"] for v in self.by.values())
        tot_out = sum(v["out"] for v in self.by.values())
        return {"total_in": tot_in, "total_out": tot_out, "by_model": self.by, "fallback": self.fallback}


METER = Meter()


# ── Groq client (OpenAI-compatible, async) ──────────────────────────────────
class Groq:
    def __init__(self, key: str) -> None:
        self._key = key

    async def chat(
        self,
        messages: List[Dict[str, Any]],
        *,
        model: str,
        tools: Optional[List[Dict[str, Any]]] = None,
        temperature: float = 0.6,
        json_object: bool = False,
        max_attempts: int = 4,
    ) -> Dict[str, Any]:
        global _RATE_429
        # Model fallback chain: primary first, then DIFFERENT-family fallbacks (separate
        # rate-limit buckets). On a 429 the primary is throttled → escalate to the next
        # model so the work CONTINUES instead of dropping. _served_by records the winner.
        chain = [model] + [f for f in FALLBACK_CHAIN if f != model]
        last = ""
        for mi, m in enumerate(chain):
            body: Dict[str, Any] = {"model": m, "messages": messages, "temperature": temperature}
            if tools:
                body["tools"] = tools
                body["tool_choice"] = "auto"
            if json_object:
                body["response_format"] = {"type": "json_object"}
            for attempt in range(max_attempts):
                try:
                    if _SEM is not None:
                        await _SEM.acquire()
                    try:
                        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as c:
                            r = await c.post(f"{BASE_URL}/chat/completions",
                                             headers={"Authorization": f"Bearer {self._key}"}, json=body)
                    finally:
                        if _SEM is not None:
                            _SEM.release()
                    if r.status_code == 200:
                        j = r.json()
                        METER.add(m, j.get("usage") or {})
                        msg = j["choices"][0]["message"]
                        msg["_served_by"] = m
                        if mi > 0:
                            METER.fallback += 1
                        return msg
                    last = f"{m}:{r.status_code}:{r.text[:200]}"
                    if r.status_code == 429:
                        _RATE_429 += 1
                        break  # rate-limited → don't wait; jump to the next model in the chain
                    if r.status_code in (500, 502, 503) and attempt < max_attempts - 1:
                        await asyncio.sleep(min(2 ** attempt, 6))
                        continue
                    if r.status_code == 400 and json_object and attempt < max_attempts - 1:
                        body.pop("response_format", None)  # model rejects response_format → drop + retry
                        continue
                    break  # other 4xx → try next model in the chain
                except (httpx.TimeoutException, httpx.TransportError) as exc:
                    last = str(exc)
                    if attempt < max_attempts - 1:
                        await asyncio.sleep(min(2 ** attempt, 6))
                        continue
        return {"content": "", "_error": last}


def _parse_json(text: str) -> Any:
    """Best-effort JSON parse from a model message (handles ```json fences + prose)."""
    if not text:
        return None
    t = text.strip()
    if t.startswith("```"):
        t = re.sub(r"^```(?:json)?\s*|\s*```$", "", t, flags=re.MULTILINE).strip()
    try:
        return json.loads(t)
    except Exception:
        pass
    m = re.search(r"(\{.*\}|\[.*\])", t, re.DOTALL)
    if m:
        try:
            return json.loads(m.group(1))
        except Exception:
            return None
    return None


# ── context pool + internal recall (lexical, no deps) ───────────────────────
_WORD = re.compile(r"[a-z0-9]{3,}")
_STOP = set("the and for that with this from have are was were will你 has had not but its their they them then than into over also can may "
            "you your our who what when where which while about more most some such only just very".split())


class ContextPool:
    """The 'huge pool of input context'. Chunked + a lexical recall the agents call."""

    def __init__(self, text: str, chunk_words: int = 90) -> None:
        self.sources: List[Dict[str, str]] = []
        words = text.split()
        for i in range(0, max(1, len(words)), chunk_words):
            chunk = " ".join(words[i:i + chunk_words]).strip()
            if chunk:
                sid = f"S{len(self.sources) + 1}"
                title = chunk[:60].rsplit(" ", 1)[0]
                self.sources.append({"source_id": sid, "title": title, "content": chunk})
        self._toks = [(s, set(_WORD.findall(s["content"].lower())) - _STOP) for s in self.sources]

    def recall(self, query: str, k: int = 4) -> List[Dict[str, Any]]:
        q = set(_WORD.findall((query or "").lower())) - _STOP
        if not q:
            return []
        scored = []
        for s, toks in self._toks:
            overlap = len(q & toks)
            if overlap:
                scored.append((overlap / (len(q) + 1), s))
        scored.sort(key=lambda x: -x[0])
        return [{"source_id": s["source_id"], "title": s["title"],
                 "snippet": s["content"][:280], "score": round(sc, 3)}
                for sc, s in scored[:k]]


# ── web search (internal power, via compound-mini) ──────────────────────────
async def web_search(groq: Groq, query: str) -> Dict[str, Any]:
    msg = await groq.chat([{"role": "user", "content": str(query)[:500]}],
                          model=WEB_MODEL, temperature=0.2)
    answer = str(msg.get("content") or "")[:1200]
    sources: List[Dict[str, str]] = []
    for et in (msg.get("executed_tools") or []):
        sr = et.get("search_results")
        if isinstance(sr, dict):
            sr = sr.get("results") or []
        for s in (sr or [])[:4]:
            if isinstance(s, dict) and s.get("url"):
                sources.append({"title": str(s.get("title") or "")[:120], "url": s["url"]})
    return {"answer": answer, "sources": sources}


# ── personas (multi-perspective, generated from the context) ────────────────
@dataclass
class Persona:
    id: str
    name: str
    role: str          # CSI role / lens
    stance: str        # their angle on the topic
    background: str
    mbti: str
    voice: str         # how they talk
    memory: str        # personal memory / prior take of the event

    def line(self) -> str:
        return f"{self.name} — {self.role} ({self.stance})"


PERSONA_SCHEMA_HINT = (
    '{"personas":[{"name":str,"role":str(distinct lens e.g. Skeptic/Domain Expert/Investor/'
    'Regulator/Builder/Journalist/End-user),"stance":str(their angle),"background":str(1-2 sentences),'
    '"mbti":str,"voice":str(how they talk, 1 sentence),"memory":str(their prior take / personal '
    'memory of this event, 1-2 sentences)}]}'
)


async def generate_personas(groq: Groq, topic: str, pool: ContextPool, n: int) -> List[Persona]:
    ctx = "\n".join(f"[{s['source_id']}] {s['content']}" for s in pool.sources[:18])[:5000]
    sysp = (
        "You design a CAST of distinct, realistic personas for a multi-perspective social "
        "simulation about a topic — like voices that would actually argue this in public. "
        "Maximize PERSPECTIVE DIVERSITY (supporter, skeptic, domain expert, investor, regulator, "
        "builder, journalist, affected end-user — pick the ones that fit). Each persona must be "
        "GROUNDED in the context where possible (real roles/entities it mentions). "
        f"Return ONLY JSON: {PERSONA_SCHEMA_HINT}"
    )
    user = f"TOPIC: {topic}\n\nCONTEXT POOL:\n{ctx}\n\nDesign exactly {n} diverse personas."
    msg = await groq.chat([{"role": "system", "content": sysp}, {"role": "user", "content": user}],
                          model=AGENT_MODEL, temperature=0.8, json_object=True)
    data = _parse_json(msg.get("content") or "") or {}
    raw = data.get("personas") if isinstance(data, dict) else (data if isinstance(data, list) else [])
    personas: List[Persona] = []
    for i, p in enumerate(raw or []):
        if not isinstance(p, dict) or not p.get("name"):
            continue
        personas.append(Persona(
            id=f"A{i + 1}", name=str(p.get("name"))[:40], role=str(p.get("role") or "Participant")[:40],
            stance=str(p.get("stance") or "")[:160], background=str(p.get("background") or "")[:300],
            mbti=str(p.get("mbti") or "")[:8], voice=str(p.get("voice") or "")[:160],
            memory=str(p.get("memory") or "")[:300]))
        if len(personas) >= n:
            break
    return personas


# ── ontology → population at SCALE (MiroFish-style: entity types → many personas) ──
ONTOLOGY_SCHEMA_HINT = (
    '{"entity_types":[{"name":str(a kind of voice that would weigh in, e.g. "Retail Investor",'
    '"Compliance Officer","Frontline Engineer","Skeptical Journalist","Affected Customer"),'
    '"description":str,"typical_stance":str(the angle this type tends to take)}]}'
)


async def generate_ontology(groq: Groq, topic: str, pool: ContextPool, n_types: int) -> List[Dict[str, str]]:
    """MiroFish stage-1: topic + context → an ONTOLOGY of voice/entity TYPES that would
    realistically weigh in. One 8b call. Maximizes coverage of the opinion space."""
    ctx = "\n".join(f"[{s['source_id']}] {s['content']}" for s in pool.sources[:16])[:4500]
    sysp = ("You design the ONTOLOGY for a social/opinion simulation: the distinct TYPES of voices that "
            "would realistically weigh in on a topic (stakeholders, roles, archetypes — supporters, "
            "skeptics, domain experts, investors, regulators, builders, journalists, affected end-users, "
            "competitors). Maximize coverage of the real opinion space; ground in the context where "
            f"possible. Return ONLY JSON: {ONTOLOGY_SCHEMA_HINT}")
    user = f"TOPIC: {topic}\n\nCONTEXT:\n{ctx}\n\nDesign {n_types} distinct entity/voice types."
    msg = await groq.chat([{"role": "system", "content": sysp}, {"role": "user", "content": user}],
                          model=AGENT_MODEL, temperature=0.7, json_object=True)
    data = _parse_json(msg.get("content") or "") or {}
    raw = data.get("entity_types") if isinstance(data, dict) else (data if isinstance(data, list) else [])
    types = [{"name": str(t["name"])[:50], "description": str(t.get("description") or "")[:200],
              "typical_stance": str(t.get("typical_stance") or "")[:120]}
             for t in (raw or []) if isinstance(t, dict) and t.get("name")]
    return types[:n_types]


async def generate_cast_at_scale(groq: Groq, topic: str, pool: ContextPool,
                                 ontology: List[Dict[str, str]], total: int) -> List[Persona]:
    """MiroFish stage-3 at SCALE: spawn `total` personas DISTRIBUTED across the ontology types.
    One batch call per type (for its share), all batches in PARALLEL → 150 personas in seconds."""
    ctx = "\n".join(f"[{s['source_id']}] {s['content'][:160]}" for s in pool.sources[:12])[:2800]
    n_types = max(1, len(ontology))
    per, rem = divmod(total, n_types)

    async def batch(etype: Dict[str, str], k: int) -> List[Tuple[Dict[str, Any], str]]:
        if k <= 0:
            return []
        sysp = (f"Create {k} DISTINCT individual personas, all of the voice-type \"{etype['name']}\" "
                f"({etype['description']}; tends to: {etype['typical_stance']}), for a social simulation "
                f"about the topic. They share the TYPE but must DIFFER (names, backgrounds, stance shades, "
                f"MBTI, voice). Ground in context where possible. Return ONLY JSON: {PERSONA_SCHEMA_HINT}")
        user = f"TOPIC: {topic}\n\nCONTEXT:\n{ctx}\n\nCreate {k} distinct '{etype['name']}' personas."
        msg = await groq.chat([{"role": "system", "content": sysp}, {"role": "user", "content": user}],
                              model=AGENT_MODEL, temperature=0.9, json_object=True)
        data = _parse_json(msg.get("content") or "") or {}
        raw = data.get("personas") if isinstance(data, dict) else (data if isinstance(data, list) else [])
        return [(p, etype["name"]) for p in (raw or []) if isinstance(p, dict) and p.get("name")]

    quotas = [per + (1 if i < rem else 0) for i in range(n_types)]
    batches = await asyncio.gather(*[batch(t, q) for t, q in zip(ontology, quotas)], return_exceptions=True)
    personas: List[Persona] = []
    for res in batches:
        if isinstance(res, Exception):
            continue
        for p, type_name in res:
            i = len(personas)
            personas.append(Persona(
                id=f"A{i + 1}", name=str(p.get("name"))[:40], role=str(p.get("role") or type_name)[:40],
                stance=str(p.get("stance") or "")[:160], background=str(p.get("background") or "")[:300],
                mbti=str(p.get("mbti") or "")[:8], voice=str(p.get("voice") or "")[:160],
                memory=str(p.get("memory") or "")[:300]))
    return personas


async def run_scale(groq: Groq, topic: str, pool: ContextPool, personas: List[Persona],
                    allow_web: bool) -> Dict[str, Any]:
    """The realtime social BURST: ALL personas post a grounded in-character take in PARALLEL
    (bounded by the semaphore), each using the recall tool. Measures realtime feasibility at
    scale — wall-clock, throughput, grounding rate, rate-limit hits."""
    ctx_hint = "\n".join(f"[{s['source_id']}] {s['content'][:160]}" for s in pool.sources[:8])[:2200]
    done = 0
    lock = asyncio.Lock()
    t0 = time.time()

    async def post(p: Persona) -> Dict[str, Any]:
        nonlocal done
        system = persona_system(p, "S2_rich_mem", topic)  # the recipe that won the A/B
        user = (f"TOPIC: {topic}\n\nCONTEXT (use recall for more; cite [S#]):\n{ctx_hint}\n\n"
                "Post your view in-character — one sharp, specific, grounded take (2-4 sentences). "
                "Cite [S#]. Mark UNVERIFIED where needed.")
        out = await agent_turn(groq, p, system, user, pool, allow_web=allow_web, recalls_log=[])
        async with lock:
            done += 1
            if done % 25 == 0 or done == len(personas):
                print(f"    … {done}/{len(personas)} posts · {time.time() - t0:.1f}s", flush=True)
        return {"persona": p.line(), "id": p.id, "text": out.get("text", ""),
                "cites": out.get("source_ids", []), "tool_calls": out.get("tool_calls", 0)}

    results = await asyncio.gather(*[post(p) for p in personas], return_exceptions=True)
    wall = time.time() - t0
    posts = [r for r in results if not isinstance(r, Exception) and r.get("text")]
    grounded = sum(1 for r in posts if r["cites"])
    return {"posts": posts, "wall_s": round(wall, 1), "n_personas": len(personas), "n_posts": len(posts),
            "grounded": grounded, "throughput": round(len(posts) / wall, 2) if wall else 0,
            "role_mix": dict(Counter(p.role for p in personas).most_common(12))}


async def write_report(groq: Groq, topic: str, ontology: List[Dict[str, str]], pool: ContextPool,
                       scale: Dict[str, Any]) -> str:
    """MiroFish ReportAgent analog — a HIGH-QUALITY (120B) decision-grade report over the whole
    simulation: where the population converges, the fault lines, the strongest argument per
    faction, the most-cited evidence, the net read. Grounded in the posts + evidence pool."""
    posts = scale["posts"]
    # representative sample: round-robin across roles, prefer grounded, cap to fit 120B context
    by_role: Dict[str, List[Dict[str, Any]]] = {}
    for p in posts:
        role = p["persona"].split("—")[-1].split("(")[0].strip() if "—" in p["persona"] else p["persona"]
        by_role.setdefault(role, []).append(p)
    pools = {k: sorted(v, key=lambda x: -len(x["cites"])) for k, v in by_role.items()}
    sample: List[Dict[str, Any]] = []
    while len(sample) < 60 and any(pools.values()):
        for k in list(pools):
            if pools[k] and len(sample) < 60:
                sample.append(pools[k].pop(0))
    sample_txt = "\n".join(f"- [{p['persona']}] (cites {','.join(p['cites']) or '—'}) {p['text'][:200]}"
                           for p in sample)
    cited = Counter(c for p in posts for c in p["cites"])
    src_by_id = {s["source_id"]: s for s in pool.sources}
    top_src = "\n".join(f"[{sid}] ({n} cites) {src_by_id.get(sid, {}).get('content', '')[:220]}"
                        for sid, n in cited.most_common(8))
    digest = {"n_voices": scale["n_personas"], "n_posts": scale["n_posts"], "grounded": scale["grounded"],
              "role_distribution": scale["role_mix"], "ontology": [t["name"] for t in ontology]}
    sysp = ("You are the lead research analyst writing the FINAL report on a large-scale opinion "
            "simulation: a synthetic population of voices debated a question, grounded in a shared "
            "evidence pool. Write a HIGH-LEVEL, decision-grade report. Sections:\n"
            "1. **Executive read** — 3-4 sentences: the net of what this population thinks.\n"
            "2. **Consensus** — where the population converges (+ which factions hold it).\n"
            "3. **Fault lines** — the real disagreements + which factions split (markdown table).\n"
            "4. **Strongest argument per major faction**.\n"
            "5. **Most-cited evidence** ([S#]) and what it supports.\n"
            "6. **Net recommendation + open gaps** (mark UNVERIFIED).\n"
            "Be specific, cite [S#], no fluff, no process narration. Ground every claim in the "
            "simulation + evidence below.")
    user = (f"QUESTION: {topic}\n\nSIMULATION DIGEST:\n{json.dumps(digest, ensure_ascii=False)}\n\n"
            f"MOST-CITED EVIDENCE:\n{top_src}\n\nREPRESENTATIVE VOICES ({len(sample)} of {scale['n_posts']}):\n"
            f"{sample_txt}\n\nWrite the report.")
    msg = await groq.chat([{"role": "system", "content": sysp}, {"role": "user", "content": user}],
                          model=REPORT_MODEL, temperature=0.4)
    return str(msg.get("content") or "")


# ── persona prompt strategies (the A/B "what makes 8b personified" study) ───
def persona_system(p: Persona, strategy: str, topic: str) -> str:
    base = f"You are {p.name}, a {p.role}."
    if strategy == "S0_minimal":
        return base + f" Give your view on the topic: {topic}"
    rich = (base + f"\nBackground: {p.background}\nYour stance: {p.stance}\nMBTI: {p.mbti}."
            f"\nYour voice: {p.voice}\nStay fully IN CHARACTER — argue from YOUR lens, in YOUR voice.")
    parts = [rich]
    if "mem" in strategy or strategy == "S5_all":
        parts.append(f"Your personal memory of this event / your prior take: {p.memory}")
    if "few" in strategy or strategy == "S5_all":
        parts.append(f'Example of how you talk: "As a {p.role}, the first thing I look at is whether '
                     f'the claim survives contact with reality — show me the number, not the vibe."')
    if "ground" in strategy or strategy == "S5_all":
        parts.append("GROUND every claim in the provided CONTEXT/recall; cite source ids like [S3]; "
                     "if you cannot ground a point, say (UNVERIFIED) — never invent facts, names, or numbers.")
    return "\n".join(parts)


STRATEGIES = ["S0_minimal", "S1_rich", "S2_rich_mem", "S3_rich_few", "S4_rich_ground", "S5_all"]


# ── agent turn: native tool-calling (recall + web) → grounded in-character claim ─
def _agent_tools(allow_web: bool) -> List[Dict[str, Any]]:
    tools = [{"type": "function", "function": {
        "name": "recall",
        "description": "Search the shared CONTEXT POOL (the company brain / documents) for grounded "
                       "facts. Returns top snippets with source ids you must cite.",
        "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}}}]
    if allow_web:
        tools.append({"type": "function", "function": {
            "name": "web_search",
            "description": "Search the live public web for EXTERNAL facts the context pool would not hold "
                           "(market data, news, public companies). Returns an answer + source links.",
            "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}}})
    return tools


_CITE = re.compile(r"\[(S\d+)\]")


async def agent_turn(groq: Groq, p: Persona, system: str, user: str, pool: ContextPool,
                     *, allow_web: bool, recalls_log: List[Dict[str, Any]]) -> Dict[str, Any]:
    """One persona turn with native tool-calling. Returns {text, source_ids, tool_calls, web_used}."""
    messages = [{"role": "system", "content": system}, {"role": "user", "content": user}]
    tools = _agent_tools(allow_web)
    calls = 0
    web_used = False
    for it in range(MAX_TOOL_ITERS):
        force_text = it == MAX_TOOL_ITERS - 1
        msg = await groq.chat(messages, model=AGENT_MODEL, tools=(None if force_text else tools),
                              temperature=0.6)
        tcs = msg.get("tool_calls") or []
        if not tcs:
            text = str(msg.get("content") or "")
            cited = sorted(set(_CITE.findall(text)))
            return {"text": text, "source_ids": cited, "tool_calls": calls, "web_used": web_used}
        messages.append({"role": "assistant", "content": msg.get("content") or "", "tool_calls": tcs})
        for tc in tcs:
            calls += 1
            fn = (tc.get("function") or {}).get("name") or ""
            try:
                args = json.loads((tc.get("function") or {}).get("arguments") or "{}")
            except Exception:
                args = {}
            q = str((args or {}).get("query") or "")
            if fn == "recall":
                hits = pool.recall(q, k=4)
                recalls_log.append({"agent": p.id, "query": q, "source_ids": [h["source_id"] for h in hits]})
                content = json.dumps({"snippets": hits}) if hits else json.dumps({"snippets": [], "note": "nothing relevant"})
            elif fn == "web_search" and allow_web:
                web_used = True
                res = await web_search(groq, q)
                content = json.dumps(res)[:1500]
            else:
                content = json.dumps({"error": f"unknown tool {fn}"})
            messages.append({"role": "tool", "tool_call_id": tc.get("id"), "name": fn, "content": content})
    # exhausted tool budget → force a final statement
    msg = await groq.chat(messages + [{"role": "user", "content": "Now state your view as your final post. No tool calls."}],
                          model=AGENT_MODEL, temperature=0.6)
    text = str(msg.get("content") or "")
    return {"text": text, "source_ids": sorted(set(_CITE.findall(text))), "tool_calls": calls, "web_used": web_used}


# ── judge (stronger model scores personification + grounding) ───────────────
JUDGE_SCHEMA_HINT = ('{"in_character":0..1,"stance_consistency":0..1,"grounding":0..1,'
                     '"specificity":0..1,"rationale":str}')


async def judge_post(groq: Groq, p: Persona, topic: str, text: str) -> Dict[str, Any]:
    sysp = (
        "You are a strict evaluator of persona simulation quality. Score how well a generated post "
        "embodies the intended persona AND stays grounded. Be calibrated and harsh on generic text.\n"
        "Score 0..1 each: in_character (voice/role/MBTI match), stance_consistency (holds the assigned "
        "stance), grounding (claims tied to evidence / cites [S#] / flags UNVERIFIED, no fabrication), "
        "specificity (concrete, not vague filler).\n"
        f"Return ONLY JSON: {JUDGE_SCHEMA_HINT}"
    )
    user = (f"TOPIC: {topic}\nPERSONA: {p.name} — {p.role}; stance={p.stance}; voice={p.voice}; mbti={p.mbti}\n\n"
            f"GENERATED POST:\n{text[:1400]}")
    msg = await groq.chat([{"role": "system", "content": sysp}, {"role": "user", "content": user}],
                          model=JUDGE_MODEL, temperature=0.0, json_object=True)
    d = _parse_json(msg.get("content") or "") or {}

    def f(k: str) -> float:
        try:
            return max(0.0, min(1.0, float(d.get(k))))
        except Exception:
            return 0.0
    scores = {k: f(k) for k in ("in_character", "stance_consistency", "grounding", "specificity")}
    scores["overall"] = round(sum(scores.values()) / 4, 3)
    scores["rationale"] = str(d.get("rationale") or "")[:200]
    return scores


# ── the simulation (CSI 5-phase, on the cheap model) ────────────────────────
async def run_simulation(groq: Groq, topic: str, pool: ContextPool, personas: List[Persona],
                         rounds: int, strategy: str, allow_web: bool, outdir: Path) -> Dict[str, Any]:
    claims: List[Dict[str, Any]] = []
    trials: List[Dict[str, Any]] = []
    recalls: List[Dict[str, Any]] = []
    relations: List[Dict[str, Any]] = []
    cid = tid = 0

    for rnd in range(1, rounds + 1):
        last_round = rnd == rounds
        print(f"  round {rnd}/{rounds} — propose ({len(personas)} agents, parallel)…", flush=True)
        # PHASE 2 PROPOSAL (investigation is folded in via the recall tool)
        ctx_hint = "\n".join(f"[{s['source_id']}] {s['snippet'] if 'snippet' in s else s['content'][:200]}"
                             for s in pool.sources[:10])[:2500]
        prior = ""
        if claims:
            prior = "\n\nPRIOR CLAIMS THIS SIM (react to/build on/challenge them):\n" + "\n".join(
                f"- {c['agent_name']}: {c['text'][:160]}" for c in claims[-len(personas):])

        async def propose(p: Persona) -> Dict[str, Any]:
            system = persona_system(p, strategy, topic)
            user = (f"TOPIC: {topic}\n\nCONTEXT POOL (use recall for more; cite [S#]):\n{ctx_hint}{prior}\n\n"
                    "Use the recall tool (and web_search if you need external facts) to GROUND yourself, "
                    "then post your view in-character — a sharp, specific, grounded claim (3-6 sentences). "
                    "Cite source ids like [S2]. Mark anything you can't verify (UNVERIFIED).")
            return await agent_turn(groq, p, system, user, pool, allow_web=allow_web, recalls_log=recalls)

        outs = await asyncio.gather(*[propose(p) for p in personas], return_exceptions=True)
        round_claims: List[Dict[str, Any]] = []
        for p, out in zip(personas, outs):
            if isinstance(out, Exception) or not out.get("text"):
                continue
            cid += 1
            claim = {"claim_id": f"C{cid}", "agent_id": p.id, "agent_name": p.name, "role": p.role,
                     "stance": p.stance, "text": out["text"], "source_ids": out["source_ids"],
                     "status": "proposed", "round": rnd, "tool_calls": out["tool_calls"],
                     "web_used": out["web_used"]}
            claims.append(claim)
            round_claims.append(claim)
            for sid in out["source_ids"]:
                relations.append({"type": "derived_from", "from": claim["claim_id"], "to": sid})

        # PHASE 3 PEER REVIEW — 2 diverse reviewers (≠ proposer) per claim, parallel
        print(f"  round {rnd}/{rounds} — peer-review…", flush=True)

        async def review(claim: Dict[str, Any], reviewer: Persona) -> Dict[str, Any]:
            system = persona_system(reviewer, strategy, topic)
            user = (f"You are reviewing a peer's claim on: {topic}\n\nPEER ({claim['agent_name']}, "
                    f"{claim['role']}) CLAIMS:\n{claim['text'][:900]}\n\nAdversarially evaluate it from "
                    "YOUR lens. Is it grounded + sound? Reply with a 2-3 sentence critique IN CHARACTER, "
                    "then end with exactly one verdict line: VERDICT: supports | contradicts | needs_revision")
            msg = await groq.chat([{"role": "system", "content": system}, {"role": "user", "content": user}],
                                  model=AGENT_MODEL, temperature=0.5)
            txt = str(msg.get("content") or "")
            m = re.search(r"verdict:\s*(supports|contradicts|needs_revision)", txt, re.IGNORECASE)
            return {"reviewer": reviewer, "text": txt, "verdict": (m.group(1).lower() if m else "supports")}

        review_tasks = []
        for claim in round_claims:
            others = [q for q in personas if q.id != claim["agent_id"]]
            for reviewer in others[:2]:
                review_tasks.append((claim, reviewer))
        revs = await asyncio.gather(*[review(c, r) for c, r in review_tasks], return_exceptions=True)
        verdicts_by_claim: Dict[str, List[str]] = {}
        for (claim, reviewer), rv in zip(review_tasks, revs):
            if isinstance(rv, Exception):
                continue
            tid += 1
            trials.append({"trial_id": f"T{tid}", "claim_id": claim["claim_id"], "reviewer": reviewer.name,
                           "reviewer_role": reviewer.role, "verdict": rv["verdict"],
                           "critique": rv["text"][:500], "round": rnd})
            relations.append({"type": rv["verdict"], "from": f"T{tid}", "to": claim["claim_id"]})
            verdicts_by_claim.setdefault(claim["claim_id"], []).append(rv["verdict"])

        # PHASE 4 REVISION — proposer rewrites claims that got needs_revision
        to_revise = [c for c in round_claims
                     if "needs_revision" in verdicts_by_claim.get(c["claim_id"], [])]
        if to_revise:
            print(f"  round {rnd}/{rounds} — revise ({len(to_revise)})…", flush=True)

            async def revise(claim: Dict[str, Any]) -> None:
                p = next((x for x in personas if x.id == claim["agent_id"]), None)
                if not p:
                    return
                crit = " ".join(t["critique"] for t in trials
                                if t["claim_id"] == claim["claim_id"])[:600]
                system = persona_system(p, strategy, topic)
                user = (f"Your claim drew a 'needs_revision' verdict. Reviewer feedback:\n{crit}\n\n"
                        f"YOUR ORIGINAL CLAIM:\n{claim['text'][:700]}\n\nRewrite it IN CHARACTER, addressing "
                        "the feedback and tightening the grounding. Keep citations [S#].")
                msg = await groq.chat([{"role": "system", "content": system}, {"role": "user", "content": user}],
                                      model=AGENT_MODEL, temperature=0.5)
                txt = str(msg.get("content") or "")
                if txt:
                    nonlocal cid
                    cid += 1
                    rev = {"claim_id": f"C{cid}", "agent_id": p.id, "agent_name": p.name, "role": p.role,
                           "stance": p.stance, "text": txt, "source_ids": sorted(set(_CITE.findall(txt))),
                           "status": "revised", "revision_of": claim["claim_id"], "round": rnd}
                    claims.append(rev)
                    relations.append({"type": "updates", "from": rev["claim_id"], "to": claim["claim_id"]})
            await asyncio.gather(*[revise(c) for c in to_revise], return_exceptions=True)

        # PHASE 5 SYNTHESIS — last round only: one synthesizer consolidates
        if last_round and claims:
            print(f"  round {rnd}/{rounds} — synthesis…", flush=True)
            synth_p = personas[0]
            board = "\n".join(f"- [{c['agent_name']} · {c['role']}] {c['text'][:200]}" for c in claims[-12:])
            verdict_tally = {}
            for t in trials:
                verdict_tally[t["verdict"]] = verdict_tally.get(t["verdict"], 0) + 1
            system = ("You are the room's SYNTHESIZER. Consolidate the multi-perspective debate into one "
                      "grounded finding: the consensus, the live disagreements, and what survives scrutiny. "
                      "Cite [S#]. Be specific. Mark UNVERIFIED where evidence is thin.")
            user = (f"TOPIC: {topic}\n\nVERDICT TALLY: {verdict_tally}\n\nDEBATE CLAIMS:\n{board}\n\n"
                    "Write the synthesized finding (a tight, grounded conclusion).")
            msg = await groq.chat([{"role": "system", "content": system}, {"role": "user", "content": user}],
                                  model=AGENT_MODEL, temperature=0.4)
            txt = str(msg.get("content") or "")
            cid += 1
            synth = {"claim_id": f"C{cid}", "agent_id": synth_p.id, "agent_name": "SYNTHESIS",
                     "role": "Synthesizer", "stance": "consensus", "text": txt,
                     "source_ids": sorted(set(_CITE.findall(txt))), "status": "synthesized", "round": rnd}
            claims.append(synth)

    # persist artifacts (append-only JSONL, like CSI)
    outdir.mkdir(parents=True, exist_ok=True)
    for name, rows in (("claims", claims), ("trials", trials), ("recalls", recalls), ("relations", relations)):
        (outdir / f"{name}.jsonl").write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows))
    verdict_tally: Dict[str, int] = {}
    for t in trials:
        verdict_tally[t["verdict"]] = verdict_tally.get(t["verdict"], 0) + 1
    grounded = sum(1 for c in claims if c.get("source_ids"))
    return {"claims": claims, "trials": trials, "recalls": recalls, "relations": relations,
            "summary": {"claims": len(claims), "trials": len(trials), "recalls": len(recalls),
                        "verdicts": verdict_tally, "grounded_claims": grounded,
                        "web_calls": sum(1 for c in claims if c.get("web_used"))}}


# ── A/B personification study ───────────────────────────────────────────────
async def run_ab_study(groq: Groq, topic: str, pool: ContextPool, personas: List[Persona]
                       ) -> Dict[str, Any]:
    ctx_hint = "\n".join(f"[{s['source_id']}] {s['content'][:200]}" for s in pool.sources[:10])[:2500]
    user = (f"TOPIC: {topic}\n\nCONTEXT POOL (use recall; cite [S#]):\n{ctx_hint}\n\n"
            "Use recall to ground yourself, then post your view in-character — a sharp, specific, "
            "grounded claim (3-6 sentences). Cite source ids like [S2]. Mark UNVERIFIED where needed.")

    async def one(p: Persona, strat: str) -> Tuple[str, str, Dict[str, Any], str]:
        system = persona_system(p, strat, topic)
        out = await agent_turn(groq, p, system, user, pool, allow_web=False, recalls_log=[])
        scores = await judge_post(groq, p, topic, out.get("text", ""))
        return (strat, p.id, scores, out.get("text", ""))

    tasks = [one(p, s) for p in personas for s in STRATEGIES]
    print(f"  A/B: {len(personas)} personas × {len(STRATEGIES)} strategies = {len(tasks)} posts + judge…",
          flush=True)
    results = await asyncio.gather(*tasks, return_exceptions=True)
    by_strat: Dict[str, List[Dict[str, Any]]] = {s: [] for s in STRATEGIES}
    samples: Dict[str, str] = {}
    for res in results:
        if isinstance(res, Exception):
            continue
        strat, pid, scores, text = res
        by_strat[strat].append(scores)
        samples.setdefault(strat, f"[{pid}] {text[:240]}")
    board = []
    for s in STRATEGIES:
        rows = by_strat[s]
        if not rows:
            continue
        agg = {k: round(sum(r[k] for r in rows) / len(rows), 3)
               for k in ("in_character", "stance_consistency", "grounding", "specificity", "overall")}
        agg["strategy"] = s
        agg["n"] = len(rows)
        board.append(agg)
    board.sort(key=lambda x: -x["overall"])
    return {"scoreboard": board, "samples": samples}


# ── default context (so it runs out of the box) ─────────────────────────────
DEFAULT_CONTEXT = """
SINGULANCE is an AI company (formerly the HIVEMIND project) building a EU-sovereign, single-tenant,
bi-temporal, auditable memory engine for enterprises. Its products are HIVEMIND (the memory + cognitive
layer), Tara (a voice assistant), and OpenSwarm / Cognitive Swarm Intelligence (a multi-agent orchestration
and research framework). The stack is self-hosted on German servers for data sovereignty; the memory engine
has five layers: semantic, episodic, collective, a local knowledge base, and live web search. Amar Sai Gadde
is the founder and CEO; his communication style is concise, direct, and favors challenge over agreement.

Stage and capital: the company is pre-seed / very early, targeting a roughly two million euro seed round on
EU-sovereign-compliant SAFE terms, with talk of a half-million-euro over-allotment for runway. There is no
audited ARR yet; revenue is effectively zero and pilots are unsigned. Internal estimates of cash runway and
the true cost of EU-sovereign compliance (legal review, single-tenant hosting, audit fees) are not yet
quantified and are flagged as open, unverified numbers.

Differentiators: governance via a bi-temporal, audited trail of every decision and its context; strict
single-tenant isolation so no customer data crosses tenants; and the Cognitive Swarm Intelligence engine
that turns documents plus a question into a simulated multi-agent debate producing citation-linked,
provenance-tracked findings. The CSI engine designs an ontology, builds a typed knowledge graph, spawns one
persona-rich agent per entity, and runs multi-round debate (recall, propose, peer-review, revise,
synthesize) gated by claim/verification policies.

Market and comparables: comparable EU AI-SaaS and AI-infrastructure companies trade at high revenue
multiples (often cited around fifteen to twenty-five times ARR) ONLY when they show real, retained
enterprise ARR plus audited security and compliance certifications such as ISO 27001 and SOC 2. Without
revenue, valuation rests on team, technology, and signed design partners, which typically supports single-
digit-million seed valuations, not a hundred-million headline. A hundred-million valuation in five to six
months would require either an exceptional strategic round or genuine multi-million ARR with marquee logos.

Go-to-market: target segments are EU banks needing an auditable memory for regulatory compliance, healthcare
networks wanting voice triage via Tara, and enterprises building custom AI agents on OpenSwarm. The proposed
motion is three flagship enterprise pilots (one per product), each ideally converting to a paid contract of
several hundred thousand euros of annual recurring revenue, plus EU-sovereign compliance certification to
unblock regulated buyers.

Risks flagged internally: unverified ROI for enterprise buyers; the cost of EU-sovereign compliance eating
gross margin; the engineering load and per-customer cost of single-tenant deployments; founder/key-person
concentration; a long enterprise sales cycle that rarely closes material ARR within two quarters; and the
gap between an impressive demo (the swarm debate) and a hardened, certified production deployment. Hidden
costs include penetration testing, data-residency audits, and dedicated infrastructure per tenant.

Open questions the team itself has not answered: the current cash balance and months of runway; the real,
itemized EU-sovereign compliance cost; the technical readiness level of HIVEMIND for a regulated enterprise
pilot; whether any early pilot can reach material recurring revenue within two quarters; and which strategic
or sovereign-fund investors could credibly underwrite an aggressive valuation. All financial multiples and
timelines above are industry-typical assumptions, not verified facts about SINGULANCE.
"""


def md_report(topic: str, personas: List[Persona], sim: Optional[Dict[str, Any]],
              ab: Optional[Dict[str, Any]]) -> str:
    lines = [f"# Social-sim run — {topic}", "", f"Model under test: `{AGENT_MODEL}` · judge: `{JUDGE_MODEL}` · web: `{WEB_MODEL}`", ""]
    lines.append("## Cast (multi-perspective personas)")
    for p in personas:
        lines.append(f"- **{p.name}** — {p.role} · *{p.stance}* · {p.mbti}")
    lines.append("")
    if sim:
        s = sim["summary"]
        lines += ["## Simulation result", "",
                  f"- claims: **{s['claims']}** ({s['grounded_claims']} grounded) · trials: **{s['trials']}** "
                  f"· recalls: **{s['recalls']}** · web calls: {s['web_calls']}",
                  f"- verdicts: `{s['verdicts']}`", ""]
        synth = [c for c in sim["claims"] if c.get("status") == "synthesized"]
        if synth:
            lines += ["### Synthesized finding", "", synth[-1]["text"], ""]
        lines.append("### Sample debate")
        for c in sim["claims"][:min(4, len(sim["claims"]))]:
            if c.get("status") == "synthesized":
                continue
            cites = " ".join(c.get("source_ids") or []) or "—"
            lines.append(f"- **{c['agent_name']}** ({c['role']}): {c['text'][:300]}  _(cites: {cites})_")
        lines.append("")
    if ab:
        lines += ["## A/B — what makes the 8b persona accurate?", "",
                  "| strategy | overall | in_char | stance | grounding | specificity |",
                  "|---|---|---|---|---|---|"]
        for r in ab["scoreboard"]:
            lines.append(f"| `{r['strategy']}` | **{r['overall']}** | {r['in_character']} | "
                         f"{r['stance_consistency']} | {r['grounding']} | {r['specificity']} |")
        lines.append("")
        if ab["scoreboard"]:
            best = ab["scoreboard"][0]
            lines.append(f"**Winner: `{best['strategy']}` (overall {best['overall']}).**")
        lines.append("")
    m = METER.summary()
    lines += ["## Cost (every model counted)",
              f"- total: **{m['total_in']:,} in · {m['total_out']:,} out**",
              "- by model: " + ", ".join(f"`{k}` {v['calls']} calls / {v['in']+v['out']:,} tok"
                                         for k, v in m["by_model"].items())]
    return "\n".join(lines)


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--topic", default="What should SINGULANCE do in the next 6 months to credibly reach a $100M valuation?")
    ap.add_argument("--context", help="path to a context file (else a built-in SINGULANCE seed)")
    ap.add_argument("--agents", type=int, default=5)
    ap.add_argument("--rounds", type=int, default=2)
    ap.add_argument("--ab", action="store_true", help="run the personification A/B study")
    ap.add_argument("--trials", type=int, default=1, help="A/B trials to average (single runs are noisy)")
    ap.add_argument("--no-sim", action="store_true", help="skip the full simulation (A/B only)")
    ap.add_argument("--web", action="store_true", help="allow agents to use web_search during the sim")
    ap.add_argument("--scale", type=int, default=0, help="REALTIME scale test: N personas (e.g. 150) posting in parallel")
    ap.add_argument("--types", type=int, default=14, help="ontology entity-types to spread the scale cast across")
    ap.add_argument("--concurrency", type=int, default=24, help="max in-flight Groq calls (caps the 429 storm)")
    ap.add_argument("--no-report", action="store_true", help="skip the 120B high-level report (scale mode)")
    args = ap.parse_args()

    global _SEM
    _SEM = asyncio.Semaphore(max(1, args.concurrency))
    groq = Groq(_load_key())
    ctx_text = Path(args.context).read_text() if args.context else DEFAULT_CONTEXT
    pool = ContextPool(ctx_text)
    ts = time.strftime("%Y%m%d-%H%M%S")
    outdir = Path(__file__).resolve().parent / "runs" / ts

    # ── SCALE TEST — N personas in realtime (ontology → population → parallel burst) ──
    if args.scale:
        print(f"▶ SCALE TEST: {args.scale} personas · concurrency={args.concurrency} · model={AGENT_MODEL}")
        print(f"▶ context pool: {len(pool.sources)} sources · topic: {args.topic}")
        t_all = time.time()
        print(f"▶ ontology ({args.types} voice-types)…", flush=True)
        ontology = await generate_ontology(groq, args.topic, pool, args.types)
        print("   types: " + ", ".join(f"{t['name']}" for t in ontology))
        print(f"▶ spawning {args.scale} personas across {len(ontology)} types (batched-parallel)…", flush=True)
        t_cast = time.time()
        personas = await generate_cast_at_scale(groq, args.topic, pool, ontology, args.scale)
        print(f"   ✓ {len(personas)} personas in {time.time() - t_cast:.1f}s")
        if not personas:
            sys.exit("scale persona generation failed")
        print(f"▶ realtime burst: {len(personas)} parallel grounded in-character posts…", flush=True)
        res = await run_scale(groq, args.topic, pool, personas, allow_web=args.web)
        outdir.mkdir(parents=True, exist_ok=True)
        (outdir / "scale_posts.jsonl").write_text(
            "\n".join(json.dumps(r, ensure_ascii=False) for r in res["posts"]))
        m = METER.summary()
        total_wall = time.time() - t_all
        print("\n══════ SCALE RESULT ══════")
        print(f"  personas spawned : {res['n_personas']}")
        print(f"  posts produced   : {res['n_posts']}  ({res['grounded']} grounded / cited [S#])")
        print(f"  burst wall-clock : {res['wall_s']}s   → {res['throughput']} posts/sec")
        print(f"  end-to-end       : {round(total_wall,1)}s (ontology+cast+burst)")
        print(f"  rate-limit (429) : {_RATE_429} hits → {m.get('fallback', 0)} calls saved by fallback")
        print(f"  models served    : " + ", ".join(f"{k.split('/')[-1]}×{v['calls']}" for k, v in m["by_model"].items()))
        print(f"  tokens           : {m['total_in']:,} in · {m['total_out']:,} out")
        print(f"  role coverage    : {res['role_mix']}")
        print("  sample posts:")
        for r in res["posts"][:3]:
            print(f"    • {r['persona']} (cites {r['cites'] or '—'}): {r['text'][:150].strip()}")
        if not args.no_report:
            print(f"\n▶ writing high-level report ({REPORT_MODEL})…", flush=True)
            report = await write_report(groq, args.topic, ontology, pool, res)
            (outdir / "report.md").write_text(report or "(report generation failed)")
            print("\n══════ HIGH-LEVEL REPORT (120B) ══════\n")
            print((report or "(failed)")[:2200])
        print(f"\n▶ artifacts (+report.md) → {outdir}")
        return

    print(f"▶ topic: {args.topic}")
    print(f"▶ context pool: {len(pool.sources)} sources · model: {AGENT_MODEL}")
    print("▶ generating personas…", flush=True)
    personas = await generate_personas(groq, args.topic, pool, args.agents)
    if not personas:
        sys.exit("persona generation failed (check the model/key)")
    for p in personas:
        print(f"   • {p.line()}")

    sim = None
    if not args.no_sim:
        print("▶ running simulation…", flush=True)
        sim = await run_simulation(groq, args.topic, pool, personas, args.rounds,
                                   strategy="S5_all", allow_web=args.web, outdir=outdir)
        print(f"   ✓ {sim['summary']}")

    ab = None
    if args.ab:
        trials = max(1, args.trials)
        print(f"▶ running personification A/B study ({trials} trial(s), averaged)…", flush=True)
        acc: Dict[str, List[Dict[str, Any]]] = {s: [] for s in STRATEGIES}
        samples: Dict[str, str] = {}
        for t in range(trials):
            if trials > 1:
                print(f"   trial {t + 1}/{trials}…", flush=True)
            one = await run_ab_study(groq, args.topic, pool, personas)
            for row in one["scoreboard"]:
                acc[row["strategy"]].append(row)
            samples.update(one["samples"])
        board = []
        for s in STRATEGIES:
            rows = acc[s]
            if not rows:
                continue
            agg = {k: round(sum(r[k] for r in rows) / len(rows), 3)
                   for k in ("in_character", "stance_consistency", "grounding", "specificity", "overall")}
            agg.update({"strategy": s, "trials": len(rows)})
            board.append(agg)
        board.sort(key=lambda x: -x["overall"])
        ab = {"scoreboard": board, "samples": samples, "trials": trials}
        print(f"   ✓ scoreboard (avg of {trials}):")
        for r in board:
            print(f"     {r['strategy']:<16} overall={r['overall']}  "
                  f"(char={r['in_character']} stance={r['stance_consistency']} "
                  f"ground={r['grounding']} spec={r['specificity']})")

    outdir.mkdir(parents=True, exist_ok=True)
    report = md_report(args.topic, personas, sim, ab)
    (outdir / "report.md").write_text(report)
    print(f"\n▶ artifacts + report.md → {outdir}")
    m = METER.summary()
    print(f"▶ tokens (ALL models): {m['total_in']:,} in · {m['total_out']:,} out")
    for k, v in m["by_model"].items():
        print(f"    {k}: {v['calls']} calls · {v['in']+v['out']:,} tok")


if __name__ == "__main__":
    asyncio.run(main())
