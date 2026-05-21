"""
Archive Manager: Version Control for Agent Prompts

Manages:
- Prompt variant storage and versioning
- Lineage tracking (v0 → v1 → v2 → ...)
- Promotion/demotion logic
- A/B test result archival
- Evaluation history
- Metrics aggregation
"""

import json
import shutil
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, List, Optional, Tuple
import logging

logger = logging.getLogger(__name__)

# ============================================================================
# PATHS
# ============================================================================

ARCHIVE_DIR = Path("/Users/amar/HIVE-MIND/archive")
PROMPT_VARIANTS_DIR = ARCHIVE_DIR / "prompt_variants"
EVALUATIONS_DIR = ARCHIVE_DIR / "evaluations"
AB_TEST_RESULTS_DIR = ARCHIVE_DIR / "ab_test_results"
LOOP_ITERATIONS_DIR = ARCHIVE_DIR / "loop_iterations"
METRICS_DIR = ARCHIVE_DIR / "metrics"

# Ensure directories exist
for d in [PROMPT_VARIANTS_DIR, EVALUATIONS_DIR, AB_TEST_RESULTS_DIR, LOOP_ITERATIONS_DIR, METRICS_DIR]:
    d.mkdir(parents=True, exist_ok=True)


# ============================================================================
# PROMPT VARIANT MANAGEMENT
# ============================================================================

class PromptVariant:
    """Represents a version of an agent's prompt"""

    def __init__(
        self,
        agent_name: str,
        version: str,  # "v0", "v1", "v2", etc.
        prompt_text: str,
        metrics: Optional[Dict] = None,
        promoted: bool = False,
        created_at: Optional[str] = None,
        promoted_at: Optional[str] = None,
        parent_version: Optional[str] = None,
    ):
        self.agent_name = agent_name
        self.version = version
        self.prompt_text = prompt_text
        self.metrics = metrics or {}
        self.promoted = promoted
        self.created_at = created_at or datetime.now().isoformat()
        self.promoted_at = promoted_at
        self.parent_version = parent_version  # For lineage tracking

    def to_dict(self) -> Dict:
        return {
            "agent_name": self.agent_name,
            "version": self.version,
            "prompt_text": self.prompt_text,
            "metrics": self.metrics,
            "promoted": self.promoted,
            "created_at": self.created_at,
            "promoted_at": self.promoted_at,
            "parent_version": self.parent_version,
        }

    @staticmethod
    def from_dict(data: Dict) -> "PromptVariant":
        return PromptVariant(
            agent_name=data["agent_name"],
            version=data["version"],
            prompt_text=data["prompt_text"],
            metrics=data.get("metrics", {}),
            promoted=data.get("promoted", False),
            created_at=data.get("created_at"),
            promoted_at=data.get("promoted_at"),
            parent_version=data.get("parent_version"),
        )


def save_prompt_variant(variant: PromptVariant) -> Path:
    """Save a prompt variant to archive with metadata"""

    filename = f"{variant.agent_name}_{variant.version}_{variant.created_at.split('T')[0]}.json"
    filepath = PROMPT_VARIANTS_DIR / filename

    with open(filepath, 'w') as f:
        json.dump(variant.to_dict(), f, indent=2)

    logger.info(f"Saved prompt variant: {filename}")
    return filepath


def load_prompt_variant(agent_name: str, version: str) -> Optional[PromptVariant]:
    """Load a specific prompt variant from archive"""

    files = list(PROMPT_VARIANTS_DIR.glob(f"{agent_name}_{version}_*.json"))
    if not files:
        return None

    # Return most recent if multiple exist
    latest = max(files, key=lambda f: f.stat().st_mtime)

    with open(latest) as f:
        data = json.load(f)
        return PromptVariant.from_dict(data)


def get_active_prompt(agent_name: str) -> Optional[str]:
    """Get the currently active prompt for an agent"""

    # Get all variants for this agent, find the promoted one
    files = list(PROMPT_VARIANTS_DIR.glob(f"{agent_name}_v*.json"))
    if not files:
        return None

    for f in sorted(files, key=lambda x: x.stat().st_mtime, reverse=True):
        with open(f) as fp:
            data = json.load(fp)
            if data.get("promoted"):
                return data["prompt_text"]

    # If none promoted, return the latest (fallback)
    if files:
        with open(files[-1]) as f:
            data = json.load(f)
            return data["prompt_text"]

    return None


def promote_variant(agent_name: str, version: str) -> bool:
    """Promote a variant to active status, demote others"""

    files = list(PROMPT_VARIANTS_DIR.glob(f"{agent_name}_*.json"))

    promoted_any = False

    for f in files:
        with open(f) as fp:
            data = json.load(fp)

        # Demote all current promotions
        if data.get("promoted"):
            data["promoted"] = False
            with open(f, 'w') as fw:
                json.dump(data, fw, indent=2)
            logger.info(f"Demoted: {data['version']}")

        # Promote target version
        if version in f.name:
            data["promoted"] = True
            data["promoted_at"] = datetime.now().isoformat()
            with open(f, 'w') as fw:
                json.dump(data, fw, indent=2)
            logger.info(f"✅ Promoted: {agent_name} {version}")
            promoted_any = True

    return promoted_any


def archive_variant(agent_name: str, version: str) -> bool:
    """Archive (mark for deletion) an old variant"""

    files = list(PROMPT_VARIANTS_DIR.glob(f"{agent_name}_{version}_*.json"))
    if not files:
        return False

    for f in files:
        with open(f) as fp:
            data = json.load(fp)

        # Move to archived subdirectory (or mark with timestamp)
        data["archived_at"] = datetime.now().isoformat()

        with open(f, 'w') as fw:
            json.dump(data, fw, indent=2)

        logger.info(f"📦 Archived: {version}")

    return True


# ============================================================================
# EVALUATION HISTORY
# ============================================================================

def load_evaluations(agent_name: str, limit: Optional[int] = None) -> List[Dict]:
    """Load evaluation history for an agent"""

    eval_file = EVALUATIONS_DIR / f"{agent_name}_evals.jsonl"
    if not eval_file.exists():
        return []

    evals = []
    with open(eval_file) as f:
        for line in f:
            if line.strip():
                evals.append(json.loads(line))

    if limit:
        evals = evals[-limit:]

    return evals


def compute_agent_metrics(agent_name: str) -> Dict:
    """Aggregate metrics for an agent across all evaluations"""

    evals = load_evaluations(agent_name)
    if not evals:
        return {
            "agent_name": agent_name,
            "eval_count": 0,
            "avg_score": 0.0,
            "min_score": 0.0,
            "max_score": 0.0,
            "improvement_rate": 0.0,
        }

    scores = [e.get("score", 0.0) for e in evals]
    avg_score = sum(scores) / len(scores) if scores else 0.0

    # Compute improvement rate (recent vs. past)
    improvement_rate = 0.0
    if len(evals) >= 6:
        first_3 = scores[:3]
        last_3 = scores[-3:]
        first_avg = sum(first_3) / 3
        last_avg = sum(last_3) / 3
        if first_avg > 0:
            improvement_rate = (last_avg - first_avg) / first_avg

    return {
        "agent_name": agent_name,
        "eval_count": len(evals),
        "avg_score": avg_score,
        "min_score": min(scores) if scores else 0.0,
        "max_score": max(scores) if scores else 0.0,
        "improvement_rate": improvement_rate,
        "computed_at": datetime.now().isoformat(),
    }


# ============================================================================
# A/B TEST RESULT ARCHIVAL
# ============================================================================

def save_ab_test_result(
    agent_name: str,
    variant_id: str,
    baseline_score: float,
    variant_score: float,
    ab_test_size: int,
    winner: str,
) -> Path:
    """Save A/B test results to archive"""

    result = {
        "agent_name": agent_name,
        "variant_id": variant_id,
        "baseline_score": baseline_score,
        "variant_score": variant_score,
        "improvement_pct": (variant_score - baseline_score) / baseline_score * 100 if baseline_score > 0 else 0,
        "ab_test_size": ab_test_size,
        "winner": winner,
        "completed_at": datetime.now().isoformat(),
    }

    filename = f"{variant_id}.json"
    filepath = AB_TEST_RESULTS_DIR / filename

    with open(filepath, 'w') as f:
        json.dump(result, f, indent=2)

    logger.info(f"Saved A/B test result: {filename}")
    return filepath


# ============================================================================
# LINEAGE TRACKING
# ============================================================================

def build_lineage_graph(agent_name: str) -> Dict:
    """Build the version lineage for an agent (v0 → v1 → v2 → ...)"""

    files = sorted(PROMPT_VARIANTS_DIR.glob(f"{agent_name}_v*.json"))

    lineage = {}

    for f in files:
        with open(f) as fp:
            data = json.load(fp)

        version = data["version"]
        parent = data.get("parent_version")

        lineage[version] = {
            "created_at": data["created_at"],
            "promoted": data.get("promoted", False),
            "parent_version": parent,
            "metrics": data.get("metrics", {}),
            "improvement_pct": data.get("metrics", {}).get("improvement_pct", 0),
        }

    return lineage


def print_lineage_report(agent_name: str):
    """Print a human-readable lineage report"""

    lineage = build_lineage_graph(agent_name)

    print(f"\n{'='*70}")
    print(f"LINEAGE REPORT: {agent_name.upper()}")
    print(f"{'='*70}")

    for version in sorted(lineage.keys()):
        entry = lineage[version]
        badge = "🔴 ACTIVE" if entry["promoted"] else "⚪"
        improvement = entry["improvement_pct"]
        parent = f" (from {entry['parent_version']})" if entry["parent_version"] else ""

        print(f"{badge} {version}{parent}")
        print(f"     Created: {entry['created_at'][:10]}")
        print(f"     Improvement: {improvement:+.1f}%")


# ============================================================================
# CLEANUP (RETENTION POLICY)
# ============================================================================

def cleanup_old_variants(agent_name: str, retention_days: int = 90):
    """
    Remove variants older than retention_days.
    Keep at least one promoted variant and the 3 most recent.
    """

    files = sorted(PROMPT_VARIANTS_DIR.glob(f"{agent_name}_v*.json"))
    cutoff_date = datetime.now() - timedelta(days=retention_days)

    protected = set()

    # Never delete the promoted variant
    for f in files:
        with open(f) as fp:
            data = json.load(fp)
            if data.get("promoted"):
                protected.add(f.name)

    # Protect 3 most recent
    for f in files[-3:]:
        protected.add(f.name)

    # Clean up
    for f in files:
        if f.name in protected:
            continue

        created_at = datetime.fromisoformat(
            json.load(open(f))["created_at"]
        )

        if created_at < cutoff_date:
            f.unlink()
            logger.info(f"Deleted old variant: {f.name}")


# ============================================================================
# METRICS EXPORT
# ============================================================================

def export_metrics_report() -> Path:
    """Generate a CSV report of all agent metrics"""

    agents = ["maya", "jonah", "lina", "eli"]
    metrics = []

    for agent in agents:
        m = compute_agent_metrics(agent)
        metrics.append(m)

    report_file = METRICS_DIR / f"metrics_report_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"

    with open(report_file, 'w') as f:
        json.dump(metrics, f, indent=2)

    logger.info(f"Metrics report saved: {report_file}")
    return report_file


# ============================================================================
# MAIN (for testing)
# ============================================================================

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)

    # Example usage
    for agent in ["maya", "jonah", "lina", "eli"]:
        metrics = compute_agent_metrics(agent)
        print(f"\n{agent.upper()}: {metrics}")

        print_lineage_report(agent)

    # Export report
    export_metrics_report()
