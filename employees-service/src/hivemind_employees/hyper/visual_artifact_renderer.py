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
    # The governed renderer owns the current house system. Model-selected modes
    # may influence narrative choices, but cannot silently replace the product's
    # visual language with a dark dashboard or neon template.
    normalized["visual_mode"] = "editorial"
    normalized["accent"] = "cobalt"
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
            f'<article data-lane="{_esc(item["lane"])}"><span class="item-index">{index + 1:02}</span>'
            f'<div class="item-copy"><small>{_esc(item["label"])}</small><strong>{_esc(item["value"])}</strong>'
            f'<p>{_esc(item["detail"])}</p></div><em>{_esc(item["lane"])}</em></article>'
        )
    return f'<figure class="visual visual-{_esc(composition)}" data-count="{len(articles)}">{"".join(articles)}</figure>'


def render_presentation(spec: dict[str, Any]) -> str:
    spec = normalize_presentation_spec(spec)
    accent = {
        "lime": "#caff45", "cobalt": "#4165ff", "emerald": "#35b985",
        "vermilion": "#ef5b42", "gold": "#f1bd52",
    }[spec["accent"]]
    palettes = {
        "editorial": ("#0a0a0a", "#faf9f6", "#ffffff", "#62635f", "#dedbd4"),
        "cinematic": ("#f5f4ef", "#0c0d0c", "#171916", "#a8aca2", "#32352f"),
        "data-room": ("#e9f1ee", "#101716", "#17201e", "#9cacA6", "#33413d"),
        "technical": ("#e8edf4", "#0b1018", "#111925", "#9ba8b8", "#2d3949"),
        "minimal-luxury": ("#1b1a17", "#f4f0e7", "#fffdf8", "#777168", "#d9d1c4"),
    }
    ink, paper, surface, muted, line = palettes[spec["visual_mode"]]
    slides = []
    for index, slide in enumerate(spec["slides"]):
        sources = " · ".join(_esc(ref) for ref in slide["source_refs"]) or "Evidence lanes reflect supplied room context"
        slides.append(
            f'<section class="slide composition-{_esc(slide["composition"])}{' active' if index == 0 else ''}" '
            f'data-slide="{index + 1}" aria-label="Slide {index + 1}: {_esc(slide["headline"])}">'
            f'<header><span>{_esc(slide["eyebrow"])}</span><b>{index + 1:02} / {len(spec["slides"]):02}</b></header>'
            f'<div class="slide-copy"><h{"1" if index == 0 else "2"}>{_esc(slide["headline"])}</h{"1" if index == 0 else "2"}>'
            f'<p>{_esc(slide["body"])}</p></div>{_items_markup(slide["items"], slide["composition"])}'
            f'<footer><span>{sources}</span><i aria-hidden="true"></i></footer></section>'
        )
    raw_spec = json.dumps(spec, ensure_ascii=True).replace("</", "<\\/")
    return f'''<!doctype html><html lang="en" data-mode="{_esc(spec["visual_mode"])}" data-house-style="hivemind-editorial-v1"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{_esc(spec["title"])}</title><style>
:root{{--ink:{ink};--paper:{paper};--surface:{surface};--muted:{muted};--line:{line};--accent:{accent};--shadow:0 22px 55px #17140d18}}*{{box-sizing:border-box}}html,body{{margin:0;min-height:100%;background:var(--paper);color:var(--ink);font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;letter-spacing:0}}body{{overflow:hidden}}.deck{{height:100vh;display:grid;place-items:center;padding:18px}}.slide{{display:none;width:min(151vh,calc(100vw - 36px));height:min(84.9vw,calc(100vh - 36px));aspect-ratio:16/9;background:var(--paper);border:1px solid var(--line);padding:clamp(28px,4vw,68px);position:relative;overflow:hidden;grid-template-columns:repeat(12,minmax(0,1fr));grid-template-rows:auto minmax(0,1fr) auto;gap:clamp(18px,2vw,34px);box-shadow:var(--shadow)}}.slide.active{{display:grid}}.slide:before{{content:attr(data-slide);position:absolute;right:.04em;bottom:-.22em;font-size:clamp(220px,28vw,440px);line-height:1;font-weight:800;color:color-mix(in srgb,var(--ink) 2.5%,transparent);pointer-events:none}}.slide>header{{grid-column:1/-1;display:flex;justify-content:space-between;align-items:center;text-transform:uppercase;font-size:9px;font-weight:750;letter-spacing:1.7px;color:var(--muted);border-bottom:1px solid var(--line);padding-bottom:12px;z-index:2}}.slide>header span{{color:var(--accent)}}.slide-copy{{position:relative;z-index:2;align-self:center}}h1,h2{{font-size:clamp(42px,5.5vw,86px);line-height:.94;margin:0 0 22px;letter-spacing:0;font-weight:800;text-wrap:balance}}.slide-copy>p{{font-size:clamp(15px,1.28vw,20px);line-height:1.55;color:var(--muted);max-width:620px;margin:0}}.slide>footer{{grid-column:1/-1;display:flex;align-items:center;gap:16px;border-top:1px solid var(--line);padding-top:11px;color:var(--muted);font-size:9px;text-transform:uppercase;letter-spacing:.7px;white-space:nowrap;overflow:hidden;z-index:2}}.slide>footer span{{overflow:hidden;text-overflow:ellipsis}}.slide>footer i{{height:2px;background:var(--accent);flex:1;min-width:40px}}.visual{{align-self:center;margin:0;display:grid;position:relative;z-index:2;min-width:0}}.visual article{{position:relative;min-width:0}}.item-index{{font-size:10px;color:var(--accent);font-weight:800}}.visual article small{{display:block;text-transform:uppercase;font-size:9px;letter-spacing:1.15px;color:var(--muted)}}.visual article strong{{display:block;font-size:clamp(22px,2.65vw,42px);line-height:1;margin:8px 0 10px}}.visual article p{{font-size:12px;line-height:1.48;color:var(--muted);margin:0}}.visual article em{{font-style:normal;text-transform:uppercase;font-size:8px;letter-spacing:.8px;color:var(--muted)}}
.composition-hero{{background:var(--paper);color:var(--ink)}}.composition-hero .slide-copy{{grid-column:1/7;grid-row:2;align-self:center}}.composition-hero h1{{font-size:clamp(58px,7.4vw,116px);max-width:820px}}.composition-hero .slide-copy>p{{color:var(--muted);max-width:560px}}.composition-hero .visual{{grid-column:8/-1;grid-row:2;display:grid;align-self:center;background:var(--surface);border:1px solid var(--line);border-radius:7px;padding:clamp(20px,2.5vw,38px);box-shadow:var(--shadow)}}.composition-hero .visual:before{{content:"●  ●  ●";position:absolute;left:14px;right:14px;top:0;height:28px;padding-top:8px;border-bottom:1px solid var(--line);color:#ff746d;font-size:8px;letter-spacing:4px}}.composition-hero .visual article{{padding:20px 0 10px;color:var(--ink)}}.composition-hero .visual article+article{{border-top:1px solid var(--line)}}.composition-hero .visual article p,.composition-hero .visual article em{{color:var(--muted)}}
.composition-thesis .slide-copy{{grid-column:2/11;grid-row:2;align-self:start;padding-top:4vh}}.composition-thesis h2{{font-size:clamp(54px,6.8vw,104px)}}.composition-thesis .visual{{grid-column:2/12;grid-row:2;align-self:end;grid-template-columns:repeat(3,1fr);border-top:2px solid var(--ink)}}.visual-thesis article{{padding:18px 22px 0 0}}.visual-thesis article+article{{border-left:1px solid var(--line);padding-left:22px}}
.composition-comparison .slide-copy{{grid-column:1/5;grid-row:2}}.composition-comparison .visual{{grid-column:6/-1;grid-row:2;grid-template-columns:repeat(3,1fr);align-self:stretch;gap:1px;background:var(--line)}}.visual-comparison article{{background:var(--surface);padding:clamp(18px,2vw,30px);display:flex;flex-direction:column;justify-content:space-between}}.visual-comparison article:nth-child(2){{transform:translateY(-18px);border-top:5px solid var(--accent)}}
.composition-process .slide-copy{{grid-column:1/-1;grid-row:2;align-self:start}}.composition-process .slide-copy>p{{max-width:760px}}.composition-process .visual{{grid-column:1/-1;grid-row:2;align-self:end;grid-template-columns:repeat(4,1fr);gap:clamp(18px,3vw,48px);padding-top:34px;border-top:1px solid var(--line)}}.visual-process:before{{content:"";position:absolute;left:0;right:0;top:34px;border-top:3px solid var(--accent)}}.visual-process article{{padding-top:30px}}.visual-process .item-index{{position:absolute;top:-44px;width:22px;height:22px;background:var(--ink);color:var(--accent);display:grid;place-items:center}}
.composition-matrix .slide-copy{{grid-column:1/6;grid-row:2}}.composition-matrix .visual{{grid-column:7/-1;grid-row:2;align-self:center;border-top:2px solid var(--ink)}}.visual-matrix article{{display:grid;grid-template-columns:28px 1fr auto;gap:14px;padding:14px 0;border-bottom:1px solid var(--line);align-items:start}}.visual-matrix article strong{{font-size:18px;margin:4px 0}}.visual-matrix article em{{text-align:right}}
.composition-timeline .slide-copy{{grid-column:1/7;grid-row:2;align-self:start}}.composition-timeline .visual{{grid-column:1/-1;grid-row:2;align-self:end;grid-template-columns:repeat(4,1fr);border-top:2px solid var(--ink)}}.visual-timeline article{{padding:30px 24px 0 0;border-right:1px solid var(--line);min-height:190px}}.visual-timeline article:before{{content:"";position:absolute;top:-8px;width:14px;height:14px;border:3px solid var(--accent);background:var(--paper)}}
.composition-decision{{background:var(--paper);color:var(--ink)}}.composition-decision .slide-copy{{grid-column:2/10;grid-row:2;align-self:center}}.composition-decision h2{{font-size:clamp(58px,7vw,108px)}}.composition-decision .slide-copy>p{{color:var(--muted);max-width:700px}}.composition-decision .visual{{grid-column:10/-1;grid-row:2;align-self:center;border-top:2px solid var(--accent)}}.visual-decision article{{padding:15px 0;border-bottom:1px solid var(--line)}}.composition-decision .visual article strong{{font-size:22px}}.composition-decision .visual article p,.composition-decision .visual article em,.composition-decision .visual article small{{color:var(--muted)}}
.controls{{position:fixed;right:28px;bottom:24px;display:flex;align-items:center;gap:8px;z-index:20}}.controls button{{width:44px;height:44px;border:1px solid var(--line);background:var(--surface);color:var(--ink);cursor:pointer;font-size:19px;box-shadow:0 8px 24px #17140d12}}.controls button:hover,.controls button:focus-visible{{border-color:var(--accent);color:var(--accent);outline:2px solid var(--accent);outline-offset:2px}}.position{{color:var(--muted);font-size:10px;text-transform:uppercase;margin-right:8px;letter-spacing:1px}}
@media(max-width:680px){{body{{overflow:auto;background:var(--paper)}}.deck{{height:auto;display:block;padding:0}}.slide,.slide.active{{display:grid;width:100%;height:auto;min-height:100svh;aspect-ratio:auto;padding:25px 20px;grid-template-columns:1fr;grid-template-rows:auto auto 1fr auto;gap:26px;box-shadow:none;border:0;border-bottom:1px solid var(--line)}}.slide:before{{font-size:180px;bottom:-.1em}}.slide>header{{grid-column:1;grid-row:1}}.slide-copy,.composition-hero .slide-copy,.composition-thesis .slide-copy,.composition-comparison .slide-copy,.composition-process .slide-copy,.composition-matrix .slide-copy,.composition-timeline .slide-copy,.composition-decision .slide-copy{{grid-column:1;grid-row:2;align-self:end;padding:0}}h1,h2,.composition-hero h1,.composition-thesis h2,.composition-decision h2{{font-size:clamp(40px,12vw,58px)}}.slide-copy>p{{font-size:15px}}.visual,.composition-hero .visual,.composition-thesis .visual,.composition-comparison .visual,.composition-process .visual,.composition-matrix .visual,.composition-timeline .visual,.composition-decision .visual{{grid-column:1;grid-row:3;align-self:start;width:100%;display:grid;grid-template-columns:1fr;transform:none;border:1px solid var(--line);border-radius:6px;background:var(--surface);gap:0;padding:14px;box-shadow:0 14px 34px #17140d10}}.visual article,.composition-hero .visual article,.visual-comparison article{{min-height:0;padding:14px 0;border:0;border-bottom:1px solid var(--line);transform:none;background:transparent}}.visual-process:before,.composition-hero .visual:before{{display:none}}.visual-process .item-index{{position:static;width:auto;height:auto;display:inline;background:transparent}}.visual-timeline article:before{{display:none}}.slide>footer{{grid-column:1;grid-row:4;white-space:normal}}.composition-hero .visual article{{color:var(--ink)}}.composition-hero .visual article p,.composition-hero .visual article em{{color:var(--muted)}}.controls{{display:none}}}}
@media(prefers-reduced-motion:reduce){{*{{scroll-behavior:auto!important;animation:none!important;transition:none!important}}}}@media print{{body{{background:#fff;overflow:visible}}.deck{{display:block;height:auto;padding:0}}.slide,.slide.active{{display:grid;width:100%;height:auto;aspect-ratio:16/9;break-after:page;page-break-after:always}}.controls{{display:none}}}}
</style></head><body><main class="deck">{"".join(slides)}</main><nav class="controls" aria-label="Presentation controls"><span class="position" id="position">1 / {len(slides)}</span><button class="previous-slide" data-previous aria-label="Previous slide">←</button><button class="next-slide" data-next aria-label="Next slide">→</button></nav><script id="artifact-spec" type="application/json">{raw_spec}</script><script>
const slides=[...document.querySelectorAll('.slide')],pos=document.getElementById('position');let current=0,startX=0;function show(n){{current=(n+slides.length)%slides.length;slides.forEach((s,i)=>s.classList.toggle('active',i===current));pos.textContent=(current+1)+' / '+slides.length}}document.querySelector('[data-next]').onclick=()=>show(current+1);document.querySelector('[data-previous]').onclick=()=>show(current-1);document.addEventListener('keydown',e=>{{if(e.key==='ArrowRight'||e.key==='PageDown'||e.key===' ')show(current+1);if(e.key==='ArrowLeft'||e.key==='PageUp')show(current-1)}});document.addEventListener('touchstart',e=>{{startX=e.changedTouches[0].clientX}},{{passive:true}});document.addEventListener('touchend',e=>{{const d=e.changedTouches[0].clientX-startX;if(Math.abs(d)>60)show(current+(d<0?1:-1))}},{{passive:true}});show(0);
</script></body></html>'''


def presentation_spec_sha256(spec: dict[str, Any]) -> str:
    return hashlib.sha256(json.dumps(spec, sort_keys=True, ensure_ascii=True).encode()).hexdigest()
