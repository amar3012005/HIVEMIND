"""Evidence-led operating reports for SEO Intelligence Rooms.

The room's agents still research and debate. The final strategic sentence may be
model-written, but crawl measurements, findings, phases, and verification gates
are rendered directly from the deterministic SEO artifact. This keeps the final
deliverable useful without asking an LLM to reproduce a large output schema.
"""

from __future__ import annotations

from typing import Any, Dict, Iterable, List


def _text(value: Any, fallback: str = "unknown") -> str:
    if value is None:
        return fallback
    rendered = str(value).strip()
    return rendered or fallback


def _cell(value: Any) -> str:
    return _text(value).replace("|", "\\|").replace("\n", " ")


def _items(values: Iterable[Any]) -> List[str]:
    return [str(value).strip() for value in values or [] if str(value).strip()]


def _bullets(values: Iterable[Any], fallback: str = "None recorded.") -> str:
    rows = _items(values)
    return "\n".join(f"- {row}" for row in rows) if rows else f"- {fallback}"


def _finding_evidence(finding: Dict[str, Any]) -> str:
    evidence = finding.get("evidence") or {}
    if not isinstance(evidence, dict) or not evidence:
        return f"{finding.get('instances', 1)} instance(s)"
    details = ", ".join(f"{key}={value}" for key, value in evidence.items())
    return f"{finding.get('instances', 1)} instance(s); {details}"


def _finding_scope(finding: Dict[str, Any]) -> str:
    urls = _items(finding.get("affected_urls") or [])
    template = _text(finding.get("template"))
    if urls:
        return f"{template}; " + ", ".join(urls[:3])
    return template


def _impact(finding: Dict[str, Any]) -> str:
    category = str(finding.get("category") or "").lower()
    return {
        "crawlability": "Can prevent a crawler from reliably retrieving the page.",
        "indexability": "Changes the page-level indexing signal and should be verified after release.",
        "on_page": "Weakens the page's explicit topic and search-result presentation.",
        "content": "May leave the page without enough useful information for its intended search need.",
        "accessibility": "Reduces image context for assistive technology and image understanding.",
        "structured_data": "Leaves eligible machine-readable page context unevaluated.",
    }.get(category, "Requires page-level verification after implementation.")


def _owner(_: Dict[str, Any]) -> str:
    # Room agents advise; implementation ownership belongs to the customer's team.
    return "Confirm"


def render_operating_report(audit: Dict[str, Any], recommendation: str = "") -> str:
    """Render a complete SEO operating report from a completed audit artifact."""
    maturity = audit.get("maturity") or {}
    coverage = audit.get("coverage") or {}
    severity = audit.get("severity") or {}
    capability = audit.get("capability") or {}
    search_console = audit.get("search_console") or {}
    architecture = audit.get("architecture") or {}
    findings = [row for row in audit.get("findings") or [] if isinstance(row, dict)]
    templates = [row for row in audit.get("templates") or [] if isinstance(row, dict)]
    procedure = [row for row in audit.get("optimization_procedure") or [] if isinstance(row, dict)]

    summary = recommendation.strip()
    if not summary:
        summary = (
            f"The site is at the {_text(maturity.get('label'))} stage. Work the measured findings in "
            "severity order, verify each release with the same rendered audit, and connect Search Console "
            "before making demand or performance claims."
        )

    health_rows = [
        ("Website", audit.get("seed_url")),
        ("Audit artifact", capability.get("artifact_id")),
        ("Scanned at", audit.get("scanned_at")),
        ("Evidence quality", (audit.get("evidence_quality") or {}).get("level")),
        ("Pages scanned", coverage.get("pages_scanned", 0)),
        ("Pages discovered", coverage.get("pages_discovered", 0)),
        ("Sitemap URLs found", coverage.get("sitemap_urls_found", 0)),
        ("Crawl errors", coverage.get("crawl_errors", 0)),
        ("Audit score", f"{audit.get('score', 0)}/100"),
        ("Critical findings", severity.get("critical", 0)),
        ("High findings", severity.get("high", 0)),
        ("Medium findings", severity.get("medium", 0)),
        ("Low findings", severity.get("low", 0)),
    ]
    health = "\n".join(f"| {_cell(label)} | {_cell(value)} |" for label, value in health_rows)

    priority_rows = []
    for item in findings[:12]:
        priority_rows.append(
            "| " + " | ".join(_cell(value) for value in (
                f"{item.get('severity', 'unknown')}: {item.get('title', item.get('rule', 'finding'))}",
                _finding_scope(item),
                _finding_evidence(item),
                _impact(item),
                item.get("effort", "confirm"),
                _owner(item),
                item.get("recommendation", "Confirm the intended behavior and correct the measured signal."),
                f"Rerun the rendered audit; `{item.get('id', item.get('rule', 'finding'))}` is resolved.",
            )) + " |"
        )
    if not priority_rows:
        priority_rows.append("| No deterministic findings | - | - | - | - | - | Continue monitoring | Rescan |")

    connected = bool(search_console.get("connected")) and search_console.get("status") == "connected"
    opportunities = [row for row in search_console.get("opportunities") or [] if isinstance(row, dict)]
    if connected and opportunities:
        opportunity_rows = []
        for item in opportunities[:10]:
            opportunity_rows.append("| " + " | ".join(_cell(value) for value in (
                item.get("query") or item.get("label") or "Measured opportunity",
                item.get("page") or item.get("url") or "See Search Console artifact",
                item.get("evidence") or "Connected Search Console evidence",
                item.get("confidence") or "Measured",
                item.get("demand") or "See connected baseline",
            )) + " |")
    else:
        opportunity_rows = [
            "| Query and landing-page opportunities | Not available until Search Console is connected | "
            "Public crawl only | Unknown | Unknown |"
        ]

    template_rows = [
        f"| {_cell(row.get('template'))} | {_cell(row.get('pages', 0))} | {_cell(row.get('issues', 0))} |"
        for row in templates[:12]
    ] or ["| No template evidence | 0 | 0 |"]

    procedure_rows = []
    for phase in procedure:
        actions = "; ".join(_items(phase.get("actions") or [])) or "Use the artifact's recorded objective."
        procedure_rows.append("| " + " | ".join(_cell(value) for value in (
            phase.get("order"), phase.get("status"), phase.get("phase"), phase.get("objective"),
            actions, "Confirm", phase.get("verification"),
        )) + " |")
    if not procedure_rows:
        procedure_rows.append("| 1 | current | Verify evidence | Complete a rendered audit | Run audit | Confirm | Artifact completed |")

    current = [row for row in procedure if row.get("status") == "current"]
    upcoming = [row for row in procedure if row.get("status") == "upcoming"]
    roadmap = [
        ("Day 0-7", current[:1] or procedure[:1]),
        ("Day 8-30", upcoming[:1] or current[1:2]),
        ("Day 31-90", upcoming[1:] or procedure[-1:]),
    ]
    roadmap_rows = []
    for horizon, phases in roadmap:
        names = "; ".join(_text(row.get("phase")) for row in phases) if phases else "No additional phase"
        gates = "; ".join(_text(row.get("verification")) for row in phases) if phases else "Keep the current verified state"
        roadmap_rows.append(f"| {_cell(horizon)} | {_cell(names)} | Confirm | {_cell(gates)} |")

    measurement_rows = [
        f"| Audit score | {_cell(audit.get('score', 0))}/100 | Rendered audit | After releases | Crawl-only health, not search performance | Compare the same audit |",
        f"| Finding severity | C:{_cell(severity.get('critical', 0))} H:{_cell(severity.get('high', 0))} M:{_cell(severity.get('medium', 0))} L:{_cell(severity.get('low', 0))} | Rendered audit | After releases | Findings describe inspected pages only | Compare severity and finding IDs |",
        f"| Crawl coverage | {_cell(coverage.get('pages_scanned', 0))} scanned / {_cell(coverage.get('pages_discovered', 0))} discovered | Rendered audit | Each audit | Coverage is bounded by discovery and page limit | Compare URLs and crawl errors |",
        f"| Search performance | {_cell(search_console.get('status', 'not_connected'))} | Search Console | After connection | No query, click, impression, CTR, position, or demand claims before connection | Verify connector and selected property |",
    ]

    blockers = _items(maturity.get("blockers") or [])
    exits = _items(maturity.get("exit_criteria") or [])
    limitations = _items(audit.get("limitations") or [])
    gaps = blockers + exits

    return f"""{summary}

## Current SEO Stage

**{_text(maturity.get('label'))}** (`{_text(maturity.get('stage'))}`, stage {_text(maturity.get('stage_number'))} of {_text(maturity.get('stage_count'))})

{_text(maturity.get('rationale'))}

**Observed blockers**
{_bullets(blockers)}

**Evidence required to exit**
{_bullets(exits)}

## SEO Health

| Measure | Observed value |
|---|---|
{health}

**Evidence limitations**
{_bullets(limitations)}

## Priority Fixes

| Issue | Affected page/template | Measured evidence | Why it matters | Effort | Implementation owner | Fix | Verification |
|---|---|---|---|---|---|---|---|
{chr(10).join(priority_rows)}

## Search Opportunity

| Opportunity | Candidate page | Evidence | Confidence | Demand |
|---|---|---|---|---|
{chr(10).join(opportunity_rows)}

## Architecture & Content

| Template | Pages inspected | Findings |
|---|---:|---:|
{chr(10).join(template_rows)}

- Orphan candidates: **{_text(architecture.get('orphan_candidates', 0))}**
- Pages without internal in-links: **{_text(architecture.get('pages_without_internal_inlinks', 0))}**
- Maximum observed crawl depth: **{_text(architecture.get('max_crawl_depth', 0))}**

## Optimization Procedure

| Order | Status | Phase | Objective | Actions | Owner | Verification / exit gate |
|---:|---|---|---|---|---|---|
{chr(10).join(procedure_rows)}

## Delivery Roadmap

| Horizon | Work | Owner | Decision gate |
|---|---|---|---|
{chr(10).join(roadmap_rows)}

## Measurement Contract

| KPI | Current baseline | Source | Cadence | Attribution limit | Verification |
|---|---|---|---|---|---|
{chr(10).join(measurement_rows)}

## Risks & Unknowns

{_bullets(limitations + (["Search demand and opportunity priority remain unknown until Search Console evidence is connected."] if not connected else []))}

## Gaps to confirm

{_bullets(gaps, "No additional gaps were recorded by the deterministic audit.")}
""".strip()
