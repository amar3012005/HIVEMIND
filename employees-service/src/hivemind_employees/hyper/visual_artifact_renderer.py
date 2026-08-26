"""Typed visual artifact specifications and governed HTML renderers."""
from __future__ import annotations

import hashlib
import html
import json
import re
from typing import Any


EVIDENCE_LANES = {"verified", "benchmark", "target", "assumption", "unknown"}
COMPOSITIONS = {"hero", "thesis", "comparison", "process", "matrix", "timeline", "decision"}

PRESENTATION_SPEC_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "contract": {"type": "string", "enum": ["visual-presentation.v1"]},
        "title": {"type": "string"},
        "summary": {"type": "string"},
        "visual_mode": {
            "type": "string",
            "enum": ["editorial", "cinematic", "data-room", "technical", "minimal-luxury"],
        },
        "accent": {"type": "string", "enum": ["lime", "cobalt", "emerald", "vermilion", "gold"]},
        "slides": {
            "type": "array",
            "minItems": 5,
            "maxItems": 10,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "composition": {"type": "string", "enum": sorted(COMPOSITIONS)},
                    "eyebrow": {"type": "string"},
                    "headline": {"type": "string"},
                    "body": {"type": "string"},
                    "items": {
                        "type": "array",
                        "maxItems": 6,
                        "items": {
                            "type": "object",
                            "additionalProperties": False,
                            "properties": {
                                "label": {"type": "string"},
                                "value": {"type": "string"},
                                "detail": {"type": "string"},
                                "lane": {"type": "string", "enum": sorted(EVIDENCE_LANES)},
                            },
                            "required": ["label", "value", "detail", "lane"],
                        },
                    },
                    "source_refs": {"type": "array", "maxItems": 4, "items": {"type": "string"}},
                },
                "required": ["composition", "eyebrow", "headline", "body", "items", "source_refs"],
            },
        },
    },
    "required": ["contract", "title", "summary", "visual_mode", "accent", "slides"],
}


def _esc(value: Any) -> str:
    return html.escape(str(value or ""), quote=True)


def _plain(value: Any, limit: int) -> str:
    text = re.sub(r"<[^>]+>", " ", str(value or ""))
    text = re.sub(r"(?:\*\*|__|`)", "", text)
    return re.sub(r"\s+", " ", text).strip()[:limit]


def normalize_presentation_spec(spec: dict[str, Any]) -> dict[str, Any]:
    """Apply invariants that cannot depend on model obedience."""
    normalized = dict(spec or {})
    normalized["contract"] = "visual-presentation.v1"
    normalized["title"] = _plain(normalized.get("title") or "Visual presentation", 180)
    normalized["summary"] = _plain(normalized.get("summary") or "The presentation is ready.", 1200)
    if normalized.get("visual_mode") not in {"editorial", "cinematic", "data-room", "technical", "minimal-luxury"}:
        normalized["visual_mode"] = "editorial"
    if normalized.get("accent") not in {"lime", "cobalt", "emerald", "vermilion", "gold"}:
        normalized["accent"] = "lime"
    slides = []
    middle_compositions = ["thesis", "comparison", "process", "matrix", "timeline"]
    raw_slides = normalized.get("slides") or []
    for index, raw in enumerate(raw_slides):
        if not isinstance(raw, dict):
            continue
        items = []
        for item in (raw.get("items") or [])[:6]:
            if not isinstance(item, dict):
                continue
            lane = str(item.get("lane") or "unknown").lower()
            value = _plain(item.get("value") or "", 80)
            if value.lower() in {"n/a", "na", "not available", "tbd", "?"}:
                value = "Unknown"
            items.append({
                "label": _plain(item.get("label") or "", 80),
                "value": value,
                "detail": _plain(item.get("detail") or "", 240),
                "lane": lane if lane in EVIDENCE_LANES else "unknown",
            })
        composition = str(raw.get("composition") or "thesis").lower()
        if index == 0:
            composition = "hero"
        elif index == len(raw_slides) - 1:
            composition = "decision"
        elif composition not in middle_compositions:
            composition = middle_compositions[(index - 1) % len(middle_compositions)]
        slides.append({
            "composition": composition if composition in COMPOSITIONS else "thesis",
            "eyebrow": _plain(raw.get("eyebrow") or f"{index + 1:02}", 80),
            "headline": _plain(raw.get("headline") or "", 180),
            "body": _plain(raw.get("body") or "", 600),
            "items": items,
            "source_refs": [_plain(ref, 180) for ref in (raw.get("source_refs") or [])[:4] if _plain(ref, 180)],
        })
    if len(slides) < 5:
        raise ValueError("presentation_requires_at_least_five_slides")
    normalized["slides"] = slides[:10]
    return normalized


def _items_markup(items: list[dict[str, Any]], composition: str) -> str:
    articles = []
    for index, item in enumerate(items):
        articles.append(
            f'<article data-lane="{_esc(item["lane"])}"><span>{index + 1:02}</span>'
            f'<div><small>{_esc(item["label"])}</small><strong>{_esc(item["value"])}</strong>'
            f'<p>{_esc(item["detail"])}</p></div><em>{_esc(item["lane"])}</em></article>'
        )
    return f'<figure class="visual visual-{_esc(composition)}">{"".join(articles)}</figure>'


def render_presentation(spec: dict[str, Any]) -> str:
    spec = normalize_presentation_spec(spec)
    accent = {
        "lime": "#caff45", "cobalt": "#4165ff", "emerald": "#35b985",
        "vermilion": "#ef5b42", "gold": "#f1bd52",
    }[spec["accent"]]
    slides = []
    for index, slide in enumerate(spec["slides"]):
        sources = " · ".join(_esc(ref) for ref in slide["source_refs"]) or "Evidence lanes reflect supplied room context"
        slides.append(
            f'<section class="slide composition-{_esc(slide["composition"])}{' active' if index == 0 else ''}" '
            f'data-slide="{index + 1}" aria-label="Slide {index + 1}: {_esc(slide["headline"])}">'
            f'<header><span>{_esc(slide["eyebrow"])}</span><b>{index + 1:02} / {len(spec["slides"]):02}</b></header>'
            f'<div class="slide-copy"><h{"1" if index == 0 else "2"}>{_esc(slide["headline"])}</h{"1" if index == 0 else "2"}>'
            f'<p>{_esc(slide["body"])}</p></div>{_items_markup(slide["items"], slide["composition"])}'
            f'<footer>{sources}</footer></section>'
        )
    raw_spec = json.dumps(spec, ensure_ascii=True).replace("</", "<\\/")
    return f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{_esc(spec["title"])}</title><style>
:root{{--ink:#161713;--paper:#f3f1e9;--night:#10120f;--muted:#6f716b;--line:#d7d4c9;--accent:{accent};--white:#fff}}*{{box-sizing:border-box}}html,body{{margin:0;min-height:100%;background:#080908;color:var(--ink);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:0}}body{{overflow:hidden}}.deck{{height:100vh;display:grid;place-items:center;padding:18px}}.slide{{display:none;width:min(151vh,calc(100vw - 36px));height:min(84.9vw,calc(100vh - 36px));aspect-ratio:16/9;background:var(--paper);padding:clamp(28px,4vw,68px);position:relative;overflow:hidden;grid-template-columns:minmax(0,.88fr) minmax(0,1.12fr);grid-template-rows:auto 1fr auto;column-gap:clamp(30px,5vw,86px)}}.slide.active{{display:grid}}.slide:before{{content:"";position:absolute;inset:0;pointer-events:none;background:linear-gradient(90deg,transparent 49.85%,rgba(24,26,22,.055) 50%,transparent 50.15%)}}.slide>header{{grid-column:1/-1;display:flex;justify-content:space-between;align-items:center;text-transform:uppercase;font-size:11px;font-weight:700;letter-spacing:1.4px;color:var(--muted);border-bottom:1px solid var(--line);padding-bottom:14px}}.slide>header span{{color:var(--accent);background:var(--night);padding:7px 10px}}.slide-copy{{align-self:center;position:relative;z-index:1}}h1,h2{{font-family:Arial,Helvetica,sans-serif;font-size:clamp(45px,5.3vw,84px);line-height:.96;margin:0 0 24px;letter-spacing:0;font-weight:800;max-width:850px}}.slide-copy>p{{font-size:clamp(16px,1.35vw,22px);line-height:1.5;color:var(--muted);max-width:620px;margin:0}}.slide>footer{{grid-column:1/-1;border-top:1px solid var(--line);padding-top:12px;color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}}.visual{{align-self:center;margin:0;display:grid;position:relative;z-index:1}}.visual article{{position:relative}}.visual article>span{{font-size:11px;color:var(--accent);font-weight:800}}.visual article small{{display:block;text-transform:uppercase;font-size:10px;letter-spacing:1.1px;color:var(--muted)}}.visual article strong{{display:block;font-size:clamp(22px,2.6vw,40px);line-height:1.05;margin:8px 0}}.visual article p{{font-size:13px;line-height:1.45;color:var(--muted);margin:0}}.visual article em{{font-style:normal;text-transform:uppercase;font-size:9px;color:var(--muted)}}.visual-hero,.visual-thesis{{grid-template-columns:repeat(2,1fr);border:1px solid var(--line)}}.visual-hero article,.visual-thesis article{{padding:24px;background:#fff;border-right:1px solid var(--line)}}.visual-hero article:nth-child(even),.visual-thesis article:nth-child(even){{border-right:0}}.visual-comparison{{grid-template-columns:repeat(3,1fr);gap:1px;background:var(--line)}}.visual-comparison article{{background:#fff;padding:24px;min-height:210px}}.visual-process{{grid-template-columns:repeat(4,1fr);gap:22px}}.visual-process:before{{content:"";position:absolute;left:7%;right:7%;top:25px;border-top:2px solid var(--accent)}}.visual-process article{{padding-top:52px}}.visual-process article>span{{position:absolute;top:13px;width:26px;height:26px;border-radius:50%;background:var(--night);color:var(--accent);display:grid;place-items:center}}.visual-matrix{{border-top:1px solid var(--ink)}}.visual-matrix article{{display:grid;grid-template-columns:34px 1fr 90px;gap:14px;padding:15px 0;border-bottom:1px solid var(--line)}}.visual-matrix article strong{{font-size:19px;margin:3px 0}}.visual-matrix article em{{text-align:right}}.visual-timeline{{grid-template-columns:repeat(4,1fr);border-top:1px solid var(--ink);margin-top:30px}}.visual-timeline article{{padding:34px 20px 0 0;border-right:1px solid var(--line);min-height:220px}}.visual-timeline article:before{{content:"";position:absolute;top:-7px;width:12px;height:12px;border-radius:50%;border:2px solid var(--accent);background:var(--paper)}}.visual-decision{{background:var(--accent);padding:34px;grid-template-columns:repeat(2,1fr);gap:20px}}.visual-decision article{{border-top:1px solid #0004;padding-top:15px}}.composition-hero{{background:var(--night);color:#fff}}.composition-hero:after{{content:"";position:absolute;inset:0;background-image:linear-gradient(#ffffff0b 1px,transparent 1px),linear-gradient(90deg,#ffffff0b 1px,transparent 1px);background-size:54px 54px;mask-image:linear-gradient(90deg,black,transparent 70%)}}.composition-hero .slide-copy>p,.composition-hero .visual article p,.composition-hero>footer{{color:#b7bbb2}}.composition-hero>header{{border-color:#ffffff25;color:#b7bbb2}}.composition-hero .visual{{color:var(--ink)}}.composition-decision{{background:var(--accent)}}.composition-decision .slide-copy>p{{color:#173018}}.controls{{position:fixed;right:30px;bottom:26px;display:flex;align-items:center;gap:8px;z-index:10}}.controls button{{width:42px;height:42px;border:1px solid #ffffff55;background:#121310;color:#fff;cursor:pointer;font-size:18px}}.controls button:hover,.controls button:focus-visible{{background:var(--accent);color:#111;outline:none}}.position{{color:#fff;font-size:11px;text-transform:uppercase;margin-right:8px}}
@media(max-width:680px){{body{{overflow:auto;background:var(--paper)}}.deck{{height:auto;display:block;padding:0}}.slide,.slide.active{{display:grid;width:100%;height:auto;min-height:100svh;aspect-ratio:auto;padding:26px 20px;grid-template-columns:1fr;grid-template-rows:auto auto 1fr auto;gap:28px}}.slide:before{{display:none}}h1,h2{{font-size:clamp(39px,12vw,55px)}}.slide-copy{{align-self:end}}.visual{{align-self:start;width:100%}}.visual-hero,.visual-thesis,.visual-comparison,.visual-process,.visual-timeline,.visual-decision{{grid-template-columns:1fr}}.visual-process:before{{display:none}}.visual-process article{{padding:14px 0 14px 42px;border-top:1px solid var(--line)}}.visual-process article>span{{top:13px;left:0}}.visual-timeline article{{min-height:0;border-right:0;border-bottom:1px solid var(--line);padding:18px 0}}.visual-timeline article:before{{display:none}}.controls{{display:none}}.slide>footer{{white-space:normal}}}}
@media(prefers-reduced-motion:reduce){{*{{scroll-behavior:auto!important;animation:none!important;transition:none!important}}}}@media print{{body{{background:#fff;overflow:visible}}.deck{{display:block;height:auto;padding:0}}.slide,.slide.active{{display:grid;width:100%;height:auto;aspect-ratio:16/9;break-after:page;page-break-after:always}}.controls{{display:none}}}}
</style></head><body><main class="deck">{"".join(slides)}</main><nav class="controls" aria-label="Presentation controls"><span class="position" id="position">1 / {len(slides)}</span><button class="previous-slide" data-previous aria-label="Previous slide">←</button><button class="next-slide" data-next aria-label="Next slide">→</button></nav><script id="artifact-spec" type="application/json">{raw_spec}</script><script>
const slides=[...document.querySelectorAll('.slide')],pos=document.getElementById('position');let current=0;function show(n){{current=(n+slides.length)%slides.length;slides.forEach((s,i)=>s.classList.toggle('active',i===current));pos.textContent=(current+1)+' / '+slides.length}}document.querySelector('[data-next]').onclick=()=>show(current+1);document.querySelector('[data-previous]').onclick=()=>show(current-1);document.addEventListener('keydown',e=>{{if(e.key==='ArrowRight'||e.key==='PageDown')show(current+1);if(e.key==='ArrowLeft'||e.key==='PageUp')show(current-1)}});show(0);
</script></body></html>'''


def presentation_spec_sha256(spec: dict[str, Any]) -> str:
    return hashlib.sha256(json.dumps(spec, sort_keys=True, ensure_ascii=True).encode()).hexdigest()
