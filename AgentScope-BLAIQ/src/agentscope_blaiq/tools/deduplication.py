from __future__ import annotations

from typing import Any
from urllib.parse import urlparse
from difflib import SequenceMatcher

from agentscope_blaiq.contracts.evidence import (
    Citation,
    EvidenceFinding,
    SourceRecord,
)


def _normalize_url_for_comparison(url: str) -> str:
    """
    Normalize URL for deduplication by:
    - Converting to lowercase
    - Removing www prefix
    - Standardizing scheme to https
    - Removing trailing slashes
    - Extracting just domain + path (no query/fragment)
    """
    try:
        parsed = urlparse(url.strip().lower())
        if not parsed.scheme:
            parsed = urlparse(f"https://{url.strip().lower()}")

        netloc = parsed.netloc.removeprefix("www.")
        normalized = f"{netloc}{parsed.path}".rstrip("/")
        return normalized
    except Exception:
        return url.strip().lower()


def _semantic_similarity(text1: str, text2: str) -> float:
    """
    Calculate semantic similarity between two strings.
    Returns a score between 0 and 1.
    """
    if not text1 or not text2:
        return 0.0
    text1_lower = text1.lower().strip()
    text2_lower = text2.lower().strip()
    if text1_lower == text2_lower:
        return 1.0
    matcher = SequenceMatcher(None, text1_lower, text2_lower)
    return matcher.ratio()


def _should_merge_sources(source1: SourceRecord, source2: SourceRecord, similarity_threshold: float = 0.85) -> bool:
    """
    Determine if two sources should be merged based on:
    1. URL normalization (if both are web sources)
    2. Semantic similarity of titles
    """
    if source1.source_id == source2.source_id:
        return True

    # For web sources, try URL matching first
    if source1.source_type == "web" and source2.source_type == "web":
        norm1 = _normalize_url_for_comparison(source1.source_id)
        norm2 = _normalize_url_for_comparison(source2.source_id)
        if norm1 and norm2 and norm1 == norm2:
            return True

    # Fall back to semantic similarity on titles
    title_similarity = _semantic_similarity(source1.title, source2.title)
    return title_similarity >= similarity_threshold


def _merge_confidence_scores(scores: list[float]) -> tuple[float, int]:
    """
    Merge multiple confidence scores into a single score.
    Uses a weighted average that boosts confidence when multiple sources agree.

    Returns: (merged_score, source_count)
    """
    if not scores:
        return 0.5, 0

    # Weighted average: higher weight for higher scores
    weighted_sum = sum(score ** 2 for score in scores)
    weight_sum = sum(scores)

    if weight_sum == 0:
        avg_score = sum(scores) / len(scores)
    else:
        avg_score = weighted_sum / weight_sum

    # Boost confidence for multiple sources (up to 1.0)
    boost = min(0.1 * (len(scores) - 1), 0.3)  # Max boost of 0.3 for 4+ sources
    merged_score = min(avg_score + boost, 1.0)

    return merged_score, len(scores)


def deduplicate_sources_and_findings(
    sources: list[SourceRecord],
    findings: list[EvidenceFinding],
    citations: list[Citation],
    similarity_threshold: float = 0.85,
) -> tuple[list[SourceRecord], list[EvidenceFinding], list[Citation]]:
    """
    Deduplicate sources and findings by:
    1. Grouping sources by URL normalization and semantic similarity
    2. Merging duplicate findings and updating confidence scores
    3. Updating citations to point to merged sources

    Returns: (deduplicated_sources, deduplicated_findings, deduplicated_citations)
    """
    if not sources or not findings:
        return sources, findings, citations

    # Build a mapping of source_id -> list of indices for sources that should be merged
    source_groups: dict[int, list[int]] = {}
    source_id_to_canonical: dict[str, str] = {}

    # Group sources by similarity
    for i, source_i in enumerate(sources):
        if i in source_id_to_canonical:
            continue

        # Start a new group with this source as canonical
        group = [i]
        source_id_to_canonical[source_i.source_id] = source_i.source_id

        # Find all sources that should merge with this one
        for j, source_j in enumerate(sources):
            if i != j and j not in source_id_to_canonical:
                if _should_merge_sources(source_i, source_j, similarity_threshold):
                    group.append(j)
                    source_id_to_canonical[source_j.source_id] = source_i.source_id

        source_groups[i] = group

    # Merge sources within each group
    deduplicated_sources: dict[str, SourceRecord] = {}
    source_id_mapping: dict[str, str] = {}  # old_id -> canonical_id

    for canonical_idx, group_indices in source_groups.items():
        canonical_source = sources[canonical_idx]

        if len(group_indices) == 1:
            # No merge needed
            deduplicated_sources[canonical_source.source_id] = canonical_source
            source_id_mapping[canonical_source.source_id] = canonical_source.source_id
        else:
            # Merge sources in the group
            merged_source = SourceRecord(
                source_id=canonical_source.source_id,
                source_type=canonical_source.source_type,
                title=canonical_source.title,
                location=canonical_source.location,
                metadata={
                    **canonical_source.metadata,
                    "merged_count": len(group_indices),
                    "merged_from": [sources[idx].source_id for idx in group_indices if idx != canonical_idx],
                },
            )
            deduplicated_sources[canonical_source.source_id] = merged_source

            # Map all source IDs in the group to the canonical one
            for idx in group_indices:
                source_id_mapping[sources[idx].source_id] = canonical_source.source_id

    # Merge findings that reference the same canonical source
    deduplicated_findings_dict: dict[str, EvidenceFinding] = {}

    for finding in findings:
        # Update source_ids to point to canonical sources
        canonical_source_ids = list(set(source_id_mapping.get(sid, sid) for sid in finding.source_ids))

        if not canonical_source_ids:
            continue

        # Create a key for grouping duplicate findings
        finding_key = (tuple(sorted(canonical_source_ids)), finding.title[:50])

        if finding_key in deduplicated_findings_dict:
            # Merge with existing finding
            existing = deduplicated_findings_dict[finding_key]
            scores = [existing.confidence, finding.confidence]
            merged_confidence, source_count = _merge_confidence_scores(scores)

            # Update existing finding with merged confidence and metadata
            merged_metadata = existing.metadata.copy() if hasattr(existing, 'metadata') else {}
            merged_metadata.update({
                "merged_count": source_count,
                "original_confidence": existing.confidence,
            })

            existing.confidence = merged_confidence
            if hasattr(existing, 'metadata'):
                existing.metadata = merged_metadata
            # Ensure all canonical source IDs are in the list
            existing.source_ids = list(set(existing.source_ids + canonical_source_ids))
        else:
            # New finding (or first of its kind after dedup)
            merged_finding = EvidenceFinding(
                finding_id=finding.finding_id,
                title=finding.title,
                summary=finding.summary,
                source_ids=canonical_source_ids,
                confidence=finding.confidence,
            )
            if hasattr(finding, 'metadata'):
                merged_finding.metadata = finding.metadata.copy()
            deduplicated_findings_dict[finding_key] = merged_finding

    deduplicated_findings = list(deduplicated_findings_dict.values())

    # Update citations to point to canonical sources
    deduplicated_citations = []
    for citation in citations:
        canonical_id = source_id_mapping.get(citation.source_id, citation.source_id)
        updated_citation = Citation(
            source_id=canonical_id,
            label=citation.label,
            excerpt=citation.excerpt,
            url=citation.url,
        )
        deduplicated_citations.append(updated_citation)

    # Remove duplicate citations
    unique_citations = {(c.source_id, c.label): c for c in deduplicated_citations}
    final_citations = list(unique_citations.values())

    return (
        list(deduplicated_sources.values()),
        deduplicated_findings,
        final_citations,
    )
