from __future__ import annotations

from agentscope_blaiq.contracts.artifact import VisualArtifact


def validate_visual_artifact(artifact: VisualArtifact) -> dict[str, object]:
    issues: list[str] = []
    if not artifact.html.strip():
        issues.append("html_missing")
    if not artifact.css.strip():
        issues.append("css_missing")
    if not artifact.sections:
        issues.append("sections_missing")
    if not artifact.evidence_refs:
        issues.append("evidence_refs_missing")
    return {
        "approved": not issues,
        "issues": issues,
        "readiness_score": max(0.0, 1.0 - 0.2 * len(issues)),
    }
