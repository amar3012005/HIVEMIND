#!/usr/bin/env python3
"""Generate a governed, high-fidelity HTML deck from completed Room context.

The model authors a typed editorial specification. A deterministic renderer owns
layout, responsiveness, interaction, escaping, and evidence labels.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import html
import json
import mimetypes
import os
import re
from pathlib import Path
from typing import Any

import httpx

from hivemind_employees.ai_gateway import enabled as gateway_enabled
from hivemind_employees.hyper.engine import _openrouter_chat
from hivemind_employees.hyper.model_policy import HYPER_FAST_MODEL


ROOT = Path(__file__).resolve().parent
SKILL = ROOT / "fundraising_visual_skill.md"

SPEC_SCHEMA: dict[str, Any] = {
    "name": "visual_investor_deck",
    "strict": True,
    "schema": {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "brand": {"type": "string"},
            "desk_label": {"type": "string"},
            "title": {"type": "string"},
            "subtitle": {"type": "string"},
            "thesis": {"type": "string"},
            "thesis_support": {"type": "string"},
            "visual_mode": {"type": "string", "enum": ["capital-desk", "cinematic", "data-room", "minimal-luxury"]},
            "accent": {"type": "string", "enum": ["cobalt", "vermilion", "emerald"]},
            "kpis": {"type": "array", "minItems": 3, "maxItems": 3, "items": {"$ref": "#/$defs/kpi"}},
            "pillars": {"type": "array", "minItems": 3, "maxItems": 3, "items": {"$ref": "#/$defs/pillar"}},
            "scenario": {"$ref": "#/$defs/scenario"},
            "market_headline": {"type": "string"},
            "market_value": {"type": "string"},
            "market_context": {"type": "string"},
            "roadmap": {"type": "array", "minItems": 4, "maxItems": 4, "items": {"$ref": "#/$defs/phase"}},
            "risks": {"type": "array", "minItems": 3, "maxItems": 3, "items": {"$ref": "#/$defs/risk"}},
            "decision_ask": {"type": "string"},
            "decision_support": {"type": "string"},
            "next_milestone": {"type": "string"},
            "source_note": {"type": "string"},
        },
        "required": ["brand", "desk_label", "title", "subtitle", "thesis", "thesis_support", "visual_mode", "accent", "kpis", "pillars", "scenario", "market_headline", "market_value", "market_context", "roadmap", "risks", "decision_ask", "decision_support", "next_milestone", "source_note"],
        "$defs": {
            "lane": {"type": "string", "enum": ["verified", "benchmark", "target", "unverified"]},
            "kpi": {"type": "object", "additionalProperties": False, "properties": {"value": {"type": "string"}, "label": {"type": "string"}, "lane": {"$ref": "#/$defs/lane"}}, "required": ["value", "label", "lane"]},
            "pillar": {"type": "object", "additionalProperties": False, "properties": {"name": {"type": "string"}, "headline": {"type": "string"}, "description": {"type": "string"}}, "required": ["name", "headline", "description"]},
            "scenario": {"type": "object", "additionalProperties": False, "properties": {"audience": {"type": "integer", "minimum": 1000}, "conversion_pct": {"type": "number", "minimum": 0.01, "maximum": 25}, "value_per_conversion": {"type": "number", "minimum": 0.01, "maximum": 100}, "currency": {"type": "string", "enum": ["USD", "EUR"]}, "lane": {"$ref": "#/$defs/lane"}}, "required": ["audience", "conversion_pct", "value_per_conversion", "currency", "lane"]},
            "phase": {"type": "object", "additionalProperties": False, "properties": {"period": {"type": "string"}, "name": {"type": "string"}, "action": {"type": "string"}, "gate": {"type": "string"}}, "required": ["period", "name", "action", "gate"]},
            "risk": {"type": "object", "additionalProperties": False, "properties": {"name": {"type": "string"}, "mitigation": {"type": "string"}, "lane": {"$ref": "#/$defs/lane"}}, "required": ["name", "mitigation", "lane"]},
        },
    },
}


def esc(value: Any) -> str:
    return html.escape(str(value or ""), quote=True)


def parse_json_message(payload: dict[str, Any]) -> dict[str, Any]:
    message = ((payload.get("choices") or [{}])[0].get("message") or {})
    text = str(message.get("content") or "").strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.I)
    return json.loads(text)


def enforce_evidence_contract(spec: dict[str, Any]) -> dict[str, Any]:
    """Apply cheap invariants that must not depend on model obedience."""
    modes = {"capital-desk", "cinematic", "data-room", "minimal-luxury"}
    if str(spec.get("brand", "")).lower() in modes:
        title = str(spec.get("title") or "")
        spec["brand"] = title.split(" Investor", 1)[0].split(" –", 1)[0].strip() or "Company"
    lanes = {str(k.get("lane")) for k in spec.get("kpis", [])}
    if lanes and lanes != {"verified"}:
        spec["scenario"]["lane"] = "target" if "target" in lanes else "unverified"
    scenario = spec["scenario"]
    calculated = scenario["audience"] * scenario["conversion_pct"] / 100 * scenario["value_per_conversion"]
    calculated_text = money(calculated, scenario["currency"])
    for kpi in spec.get("kpis", []):
        if "revenue" in str(kpi.get("label", "")).lower():
            kpi["value"] = calculated_text
            kpi["lane"] = scenario["lane"]
    symbol = "$" if scenario["currency"] == "USD" else "€"
    spec["source_note"] = (
        f"Scenario arithmetic: {scenario['audience']:,} × {scenario['conversion_pct']}% × "
        f"{symbol}{scenario['value_per_conversion']:g} = {calculated_text}. "
        "Targets and benchmarks remain labeled until validated."
    )
    return spec


def image_data_uri(path: Path | None) -> str:
    if not path:
        return ""
    mime = mimetypes.guess_type(path.name)[0] or "image/jpeg"
    return f"data:{mime};base64,{base64.b64encode(path.read_bytes()).decode('ascii')}"


def money(amount: float, currency: str) -> str:
    symbol = "$" if currency == "USD" else "€"
    if amount >= 1_000_000:
        return f"{symbol}{amount / 1_000_000:.2f}M".replace(".00", "")
    if amount >= 1_000:
        return f"{symbol}{amount / 1_000:.0f}K"
    return f"{symbol}{amount:,.0f}"


def render(spec: dict[str, Any], hero_uri: str) -> str:
    accent = {"cobalt": "#4165ff", "vermilion": "#ef5b42", "emerald": "#00a878"}[spec["accent"]]
    signal = "#caff45"
    sc = spec["scenario"]
    revenue = sc["audience"] * sc["conversion_pct"] / 100 * sc["value_per_conversion"]
    kpis = "".join(f'<div><strong>{esc(k["value"])}</strong><span>{esc(k["label"])}</span><small>{esc(k["lane"])}</small></div>' for k in spec["kpis"])
    pillars = "".join(f'<article><small>{esc(p["name"])}</small><h3>{esc(p["headline"])}</h3><p>{esc(p["description"])}</p></article>' for p in spec["pillars"])
    phases = "".join(f'<article><small>{esc(p["period"])}</small><h3>{esc(p["name"])}</h3><p>{esc(p["action"])}</p><b>Gate · {esc(p["gate"])}</b></article>' for p in spec["roadmap"])
    risks = "".join(f'<article><span>{i:02}</span><div><h3>{esc(r["name"])}</h3><p>{esc(r["mitigation"])}</p></div><small>{esc(r["lane"])}</small></article>' for i, r in enumerate(spec["risks"], 1))
    background = f"linear-gradient(100deg,rgba(0,0,0,.2),rgba(0,0,0,.7)),url('{hero_uri}') center/cover" if hero_uri else "#11130f"
    raw_spec = json.dumps(spec, ensure_ascii=True).replace("</", "<\\/")
    return f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{esc(spec["brand"])} Investor Deck</title><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Manrope:wght@500;600;700&display=swap" rel="stylesheet"><style>
:root{{--ink:#171713;--paper:#f4f2eb;--muted:#6d6b64;--line:#d7d4ca;--accent:{accent};--signal:{signal}}}*{{box-sizing:border-box}}html{{scroll-behavior:smooth}}body{{margin:0;background:var(--paper);color:var(--ink);font-family:"DM Sans",sans-serif;letter-spacing:0}}.hero{{min-height:86vh;padding:45px 6vw 52px;color:#fff;display:flex;flex-direction:column;position:relative;background:{background}}}.hero:after{{content:"";position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,.06) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.06) 1px,transparent 1px);background-size:60px 60px;mask-image:linear-gradient(black,transparent)}}.hero>*{{position:relative;z-index:1}}.top{{display:flex;justify-content:space-between;text-transform:uppercase;font-size:10px;letter-spacing:1.5px}}.copy{{margin:auto 0;max-width:1050px}}.eyebrow{{color:var(--signal);text-transform:uppercase;font-size:11px;font-weight:700;letter-spacing:2px}}h1{{font:700 clamp(52px,8vw,116px)/.91 Manrope;margin:22px 0;max-width:1050px}}.copy p{{font-size:clamp(16px,1.6vw,22px);line-height:1.5;max-width:680px;color:#dadbd4}}.hero-kpis{{display:grid;grid-template-columns:repeat(3,minmax(150px,220px));width:max-content;max-width:100%;background:#ffffff3a;gap:1px}}.hero-kpis div{{background:#11120dcf;padding:18px 22px}}.hero-kpis strong{{display:block;font:700 27px Manrope}}.hero-kpis span,.hero-kpis small{{display:block;font-size:10px;text-transform:uppercase;margin-top:3px}}.hero-kpis small{{color:var(--signal)}}section{{padding:88px max(6vw,40px);border-bottom:1px solid var(--line)}}.head{{display:grid;grid-template-columns:150px 1fr;gap:28px;margin-bottom:44px}}.head span{{color:var(--accent);font-size:11px;text-transform:uppercase}}.head h2{{font:700 clamp(34px,5vw,64px)/1 Manrope;margin:0;max-width:950px}}.thesis{{display:grid;grid-template-columns:1.3fr .7fr;border:1px solid var(--line)}}.thesis>div{{padding:36px;background:#fff}}.thesis p{{font:500 clamp(22px,3vw,40px)/1.2 Manrope;margin:0}}.thesis aside{{padding:34px;background:var(--signal);display:flex;flex-direction:column;justify-content:space-between}}.thesis aside b{{font:700 50px Manrope}}.pillars{{display:grid;grid-template-columns:repeat(3,1fr);border:1px solid var(--line)}}.pillars article{{background:#fff;padding:30px;border-right:1px solid var(--line)}}.pillars article:last-child{{border:0}}.pillars small{{color:var(--accent);text-transform:uppercase}}.pillars h3{{font:700 26px Manrope;margin:28px 0 12px}}.pillars p,.roadmap p{{color:var(--muted);line-height:1.55}}.lab{{display:grid;grid-template-columns:340px 1fr;gap:50px}}.controls{{background:#191a17;color:#fff;padding:28px}}label{{display:flex;justify-content:space-between;font-size:12px;margin:18px 0 10px}}input{{width:100%;accent-color:var(--signal)}}.presets{{display:grid;grid-template-columns:repeat(3,1fr);margin-top:28px}}button{{border:0;padding:12px;cursor:pointer}}button.active{{background:var(--signal);font-weight:700}}.result{{display:flex;justify-content:center;flex-direction:column}}.result output{{font:700 clamp(62px,10vw,130px)/.9 Manrope;color:var(--accent)}}.result p{{color:var(--muted)}}.market{{background:#181916;color:#fff}}.market .head span{{color:var(--signal)}}.market-box{{border:1px solid #41413c;padding:40px;min-height:330px;position:relative;overflow:hidden}}.market-box b{{font:700 80px Manrope;color:var(--signal)}}.market-box p{{max-width:600px;color:#aaa;font-size:17px}}.rings{{position:absolute;width:520px;height:520px;border:1px solid #444;border-radius:50%;right:-120px;bottom:-330px}}.rings:before,.rings:after{{content:"";position:absolute;inset:70px;border:1px solid #444;border-radius:50%}}.rings:after{{inset:145px}}.roadmap{{display:grid;grid-template-columns:repeat(4,1fr);border-top:1px solid}}.roadmap article{{min-height:245px;padding:28px 22px;border-right:1px solid var(--line);position:relative}}.roadmap article:before{{content:"";position:absolute;top:-7px;width:12px;height:12px;background:var(--paper);border:2px solid var(--accent);border-radius:50%}}.roadmap small{{color:var(--accent);text-transform:uppercase}}.roadmap h3{{font:700 20px Manrope;margin-top:28px}}.roadmap b{{font-size:11px}}.risks article{{display:grid;grid-template-columns:55px 1fr 100px;gap:20px;align-items:start;border-top:1px solid var(--line);padding:25px 0}}.risks article>span{{font:700 24px Manrope;color:var(--accent)}}.risks h3{{margin:0 0 7px;font:700 19px Manrope}}.risks p{{margin:0;color:var(--muted)}}.risks small{{text-transform:uppercase;text-align:right}}.ask{{background:var(--accent);color:#fff;display:grid;grid-template-columns:1fr 320px;gap:50px}}.ask h2{{font:700 clamp(45px,7vw,86px)/.96 Manrope;margin:0}}.ask p{{font-size:17px;max-width:680px}}.ask aside{{border-left:1px solid #ffffff55;padding-left:30px}}.ask aside span{{display:block;font-size:11px;text-transform:uppercase;color:#ffffffbb}}.ask aside b{{display:block;margin:10px 0 32px}}footer{{padding:25px 6vw;display:flex;justify-content:space-between;color:var(--muted);font-size:10px;text-transform:uppercase}}
@media(max-width:760px){{.hero{{padding:25px 20px 35px;min-height:80vh}}h1{{font-size:51px}}.hero-kpis{{width:100%;grid-template-columns:repeat(3,1fr)}}.hero-kpis div{{padding:12px 8px}}.hero-kpis strong{{font-size:19px}}section{{padding:60px 20px}}.head{{grid-template-columns:1fr;gap:12px}}.thesis,.lab,.ask{{grid-template-columns:1fr}}.pillars{{grid-template-columns:1fr}}.pillars article{{border-right:0;border-bottom:1px solid var(--line)}}.controls{{order:2}}.roadmap{{grid-template-columns:1fr 1fr}}.roadmap article:nth-child(2){{border-right:0}}.risks article{{grid-template-columns:35px 1fr}}.risks small{{grid-column:2;text-align:left}}.ask aside{{border-left:0;border-top:1px solid #ffffff55;padding:25px 0 0}}footer span:last-child{{display:none}}}}
</style></head><body><header class="hero"><div class="top"><span>{esc(spec["brand"])} / {esc(spec["desk_label"])}</span><span>{esc(spec["visual_mode"])}</span></div><div class="copy"><span class="eyebrow">Investor operating deck</span><h1>{esc(spec["title"])}</h1><p>{esc(spec["subtitle"])}</p></div><div class="hero-kpis">{kpis}</div></header><main><section><div class="head"><span>01 / Investment thesis</span><h2>{esc(spec["thesis"])}</h2></div><div class="thesis"><div><p>{esc(spec["thesis_support"])}</p></div><aside><span>Current scenario</span><b>{money(revenue, sc["currency"])}</b><small>{esc(sc["lane"])} · monthly potential</small></aside></div></section><section><div class="head"><span>02 / Operating model</span><h2>One journey. Three value surfaces.</h2></div><div class="pillars">{pillars}</div></section><section><div class="head"><span>03 / Scenario laboratory</span><h2>Pressure-test the revenue logic.</h2></div><div class="lab"><div class="controls"><label>Monthly audience <output id="audOut"></output></label><input id="aud" type="range" min="10000" max="3000000" step="10000" value="{sc["audience"]}"><label>Conversion rate <output id="rateOut"></output></label><input id="rate" type="range" min="0.1" max="10" step="0.1" value="{sc["conversion_pct"]}"><label>Value per conversion <output id="valOut"></output></label><input id="val" type="range" min="1" max="30" step="1" value="{sc["value_per_conversion"]}"><div class="presets"><button data-p="bear">Bear</button><button class="active" data-p="base">Base</button><button data-p="bull">Bull</button></div></div><div class="result"><span class="eyebrow">Projected monthly revenue</span><output id="revenue"></output><p id="formula"></p></div></div></section><section class="market"><div class="head"><span>04 / Market context</span><h2>{esc(spec["market_headline"])}</h2></div><div class="market-box"><b>{esc(spec["market_value"])}</b><p>{esc(spec["market_context"])}</p><div class="rings"></div></div></section><section><div class="head"><span>05 / Execution roadmap</span><h2>Evidence before scale.</h2></div><div class="roadmap">{phases}</div></section><section><div class="head"><span>06 / Risk register</span><h2>Make uncertainty visible and actionable.</h2></div><div class="risks">{risks}</div></section><section class="ask"><div><span class="eyebrow">Decision request</span><h2>{esc(spec["decision_ask"])}</h2><p>{esc(spec["decision_support"])}</p></div><aside><span>Next milestone</span><b>{esc(spec["next_milestone"])}</b><span>Evidence policy</span><b>Benchmarks and targets remain labeled until verified.</b></aside></section></main><footer><span>{esc(spec["brand"])} · confidential</span><span>{esc(spec["source_note"])}</span></footer><script id="deck-spec" type="application/json">{raw_spec}</script><script>
const s=JSON.parse(document.querySelector('#deck-spec').textContent),q=id=>document.getElementById(id),sym=s.scenario.currency==='EUR'?'€':'$';function cash(n){{return n>=1e6?sym+(n/1e6).toFixed(2).replace(/0+$/,'').replace(/\\.$/,'')+'M':sym+Math.round(n/1000)+'K'}}function update(){{let a=+q('aud').value,r=+q('rate').value,v=+q('val').value;q('audOut').value=(a/1e6).toFixed(2)+'M';q('rateOut').value=r.toFixed(1)+'%';q('valOut').value=sym+v;q('revenue').value=cash(a*r/100*v);q('formula').textContent=a.toLocaleString()+' audience × '+r.toFixed(1)+'% × '+sym+v}}['aud','rate','val'].forEach(x=>q(x).oninput=update);const base=[s.scenario.audience,s.scenario.conversion_pct,s.scenario.value_per_conversion],sets={{bear:[base[0]*.4,base[1]*.55,base[2]*.7],base,bull:[base[0]*1.8,Math.min(10,base[1]*1.5),base[2]*1.25]}};document.querySelectorAll('[data-p]').forEach(b=>b.onclick=()=>{{document.querySelectorAll('[data-p]').forEach(x=>x.classList.remove('active'));b.classList.add('active');['aud','rate','val'].forEach((x,i)=>q(x).value=sets[b.dataset.p][i]);update()}});update();
</script></body></html>'''


async def model_spec(messages: list[dict[str, str]]) -> tuple[dict[str, Any], dict[str, Any]]:
    response = await _openrouter_chat({
        "model": HYPER_FAST_MODEL,
        "messages": messages,
        "temperature": 0.35,
        "max_tokens": 5200,
        "response_format": {"type": "json_schema", "json_schema": SPEC_SCHEMA},
    }, timeout=httpx.Timeout(150, connect=10))
    if not response:
        raise RuntimeError("Model generation failed through the governed Gateway route")
    return parse_json_message(response), response


async def generate(context: str) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    if not gateway_enabled():
        raise RuntimeError("Cloudflare AI Gateway is not enabled; refusing direct-provider generation")
    prompt = SKILL.read_text() + "\n\n## Completed Room Context\n\n" + context
    draft, draft_response = await model_spec([
            {"role": "system", "content": "You create evidence-governed visual artifact specifications. Return JSON only."},
            {"role": "user", "content": prompt},
    ])
    repair_prompt = f"""Review and repair this candidate deck specification against the Room context.
Return the complete corrected JSON object. Preserve strong editorial choices, but fix every issue below:
- company/brand identity must be exact;
- verified, benchmark, target, and unverified lanes must remain distinct;
- target inputs can never produce a verified scenario;
- all revenue arithmetic must be internally consistent;
- claims of benchmark alignment require support in the context;
- legal statements must not claim completed compliance when review is pending;
- copy must remain concise enough for a visual deck.

CANDIDATE SPECIFICATION:
{json.dumps(draft, ensure_ascii=False)}

ROOM CONTEXT:
{context}
"""
    repaired, repair_response = await model_spec([
        {"role": "system", "content": "You are the final evidence and visual-quality gate for an investor deck. Return JSON only."},
        {"role": "user", "content": repair_prompt},
    ])
    return enforce_evidence_contract(repaired), [draft_response, repair_response]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--context", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--hero-image", type=Path)
    args = parser.parse_args()
    context = args.context.read_text(encoding="utf-8")
    spec, responses = asyncio.run(generate(context))
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "deck-spec.json").write_text(json.dumps(spec, indent=2, ensure_ascii=False), encoding="utf-8")
    (args.output / "index.html").write_text(render(spec, image_data_uri(args.hero_image)), encoding="utf-8")
    receipt = {
        "model_requested": HYPER_FAST_MODEL,
        "model_served": responses[-1].get("model"),
        "provider": responses[-1].get("provider"),
        "gateway": "cloudflare",
        "model_calls": len(responses),
        "context_chars": len(context),
        "spec_sha256": __import__("hashlib").sha256(json.dumps(spec, sort_keys=True).encode()).hexdigest(),
    }
    (args.output / "generation-receipt.json").write_text(json.dumps(receipt, indent=2), encoding="utf-8")
    print(json.dumps(receipt))


if __name__ == "__main__":
    main()
