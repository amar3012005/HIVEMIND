from __future__ import annotations

from pathlib import Path

from agentscope_blaiq.contracts.artifact import VisualArtifact
from agentscope_blaiq.runtime.config import settings


def persist_artifact_files(thread_id: str, artifact: VisualArtifact) -> tuple[str, str]:
    artifact_root = settings.artifact_dir / thread_id
    artifact_root.mkdir(parents=True, exist_ok=True)
    html_path = artifact_root / "artifact.html"
    css_path = artifact_root / "artifact.css"
    html_path.write_text(artifact.html, encoding="utf-8")
    css_path.write_text(artifact.css, encoding="utf-8")
    return str(html_path), str(css_path)
