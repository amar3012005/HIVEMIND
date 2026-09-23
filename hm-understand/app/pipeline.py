from __future__ import annotations

import hashlib
import json
import time

from app.contracts import AnalyzeRequest, AnalyzeResponse, BlockResult, Candidate, EvidenceRef, Mention
from app.entities import MODEL_ID, MODEL_REVISION, extract_entities, model_status
from app.extractors import extract_candidates, extract_literals, parse_dates
from app.language import detect_language

PIPELINE_VERSION = "hm-understand/0.1.0"
# These languages have only a small labeled smoke fixture, not production-grade
# validation. The set is a lower bound for routing; it is not a quality claim.
SMOKE_TESTED_LANGUAGES = {"en", "de", "es"}


def canonical_hash(request: AnalyzeRequest) -> str:
    canonical = json.dumps([block.model_dump(mode="json") for block in request.blocks],
                           ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _windows(text: str, limit: int = 3_500):
    if len(text) <= limit:
        return [(0, len(text))]
    output = []
    start = 0
    while start < len(text):
        end = min(len(text), start + limit)
        if end < len(text):
            boundary = max(text.rfind("\n", start, end), text.rfind(". ", start, end),
                           text.rfind("! ", start, end), text.rfind("? ", start, end))
            if boundary > start + limit // 2:
                end = boundary + 1
        output.append((start, end))
        if end >= len(text):
            break
        start = max(start + 1, end - 160)
    return output


def analyze(request: AnalyzeRequest) -> AnalyzeResponse:
    started = time.monotonic()
    results = []
    for block in request.blocks:
        block_started = time.monotonic()
        text = block.text
        language = detect_language(text, block.language)
        model_entities = []
        raw_model_entity_count = 0
        for window_start, window_end in _windows(text):
            window_entities = extract_entities(text[window_start:window_end], request.entity_types)
            raw_model_entity_count += len(window_entities)
            for row in window_entities:
                if row.get("start", -1) >= 0 and row.get("end", -1) > row.get("start", -1):
                    row["start"] += window_start
                    row["end"] += window_start
                    model_entities.append(row)
        rows_by_span = {(row["start"], row["end"], row["label"].lower()): row for row in model_entities
                        if 0 <= row["start"] < row["end"] <= len(text)}
        model_spans = {(row["start"], row["end"]) for row in model_entities
                       if row.get("label", "").lower() != "proper_name_candidate"}
        for row in extract_literals(text):
            if row["label"] == "proper_name_candidate" and (row["start"], row["end"]) in model_spans:
                continue
            key = (row["start"], row["end"], row["label"].lower())
            rows_by_span.setdefault(key, row)

        mentions = []
        for row in sorted(rows_by_span.values(), key=lambda item: (item["start"], item["end"], item["label"])):
            start, end = row["start"], row["end"]
            quote = text[start:end]
            if not quote or row.get("text") != quote:
                continue
            mentions.append(Mention(
                text=quote, label=row["label"], score=row.get("score"),
                evidence=EvidenceRef(source_id=request.source.id, source_revision=request.source.revision,
                                     block_id=block.id, quote=quote, start=start, end=end, locator=block.locator),
                extractor=row["extractor"],
                uncertainty_reason="rule_candidate_requires_review" if row["extractor"].startswith("rule:") else None,
            ))

        candidates = []
        if request.include_candidates:
            for row in extract_candidates(text):
                candidates.append(Candidate(
                    kind=row["kind"], text=row["text"], signals=row["signals"], needs_review=True,
                    evidence=EvidenceRef(source_id=request.source.id, source_revision=request.source.revision,
                                         block_id=block.id, quote=text[row["start"]:row["end"]],
                                         start=row["start"], end=row["end"], locator=block.locator),
                ))
        literal_dates = parse_dates(text, request.source.timezone)
        model_info = model_status()
        refinement_reasons = []
        if not model_info["loaded"]:
            refinement_reasons.append("local_entity_model_unavailable")
        primary_language = language.get("primary", "und")
        if primary_language == "und":
            refinement_reasons.append("language_unclassified")
        elif primary_language not in SMOKE_TESTED_LANGUAGES:
            refinement_reasons.append("language_outside_smoke_set")
        if any(candidate.kind == "uncertain" for candidate in candidates):
            refinement_reasons.append("uncertain_or_negated_statement")
        grounded_entity_labels = {"person", "organization", "location", "product", "project"}
        has_model_entity = any(mention.extractor == "gliner" and mention.label.lower() in grounded_entity_labels
                               for mention in mentions)
        if any(candidate.kind in {"fact", "decision", "event", "preference", "task"}
               for candidate in candidates) and not has_model_entity:
            refinement_reasons.append("candidate_without_model_entity_anchor")
        results.append(BlockResult(
            block_id=block.id, language=language, mentions=mentions, candidates=candidates,
            quality={
                "characters": len(text), "word_count": len(text.split()),
                "model_entities": sum(1 for row in rows_by_span.values() if row["extractor"] == "gliner"),
                "raw_model_entity_count": raw_model_entity_count,
                "model_weights_loaded": model_info.get("loaded_tensors", 0),
                "model_checkpoint_tensors": model_info.get("checkpoint_tensors", 0),
                "model_score_is_calibrated_probability": False,
                "rule_mentions": sum(1 for row in rows_by_span.values() if row["extractor"].startswith("rule:")),
                "date_values": literal_dates,
                # A routing signal only. It never promotes or persists a fact,
                # and is not a calibrated probability or a promise of coverage.
                "refinement_required": bool(refinement_reasons),
                "refinement_reasons": refinement_reasons,
                "status": "processed" if model_info["loaded"] else "partial_model_unavailable",
            },
            processing_ms=max(0, int((time.monotonic() - block_started) * 1000)),
        ))

    digest = request.source.content_hash or canonical_hash(request)
    statuses = [result.quality["status"] for result in results]
    return AnalyzeResponse(
        source_id=request.source.id, source_revision=request.source.revision, content_hash=digest,
        pipeline_version=PIPELINE_VERSION,
        model_versions={"entity": f"{MODEL_ID}@{MODEL_REVISION}" if model_status()["loaded"] else None,
                        "language": "langid-1.1.6" if any(b.language.get("source", "").startswith("langid") for b in results) else None},
        complete=all(status == "processed" for status in statuses), blocks=results,
        totals={"blocks": len(results), "mentions": sum(len(b.mentions) for b in results),
                "candidates": sum(len(b.candidates) for b in results),
                "processing_ms": max(0, int((time.monotonic() - started) * 1000))},
    )
