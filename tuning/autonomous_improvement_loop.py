"""
Autonomous Improvement Loop Orchestrator

Continuously improves Digital Employees (Maya, Jonah, Lina, Eli) without human intervention.

Architecture:
  1. Generate autonomous task
  2. Run all agents on task
  3. Score autonomously (consistency, completeness, clarity)
  4. Analyze failures (meta-agent)
  5. Propose improvements (prompt variants)
  6. A/B test variants (50 new tasks)
  7. Promote winners, archive losers
  8. Track metrics and acceleration
  9. Loop back to step 1

This runs continuously in the background. It is NOT human-feedback dependent.
"""

import asyncio
import json
import os
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass, asdict
import logging

from agentscope.agent import ReActAgent
from agentscope.message import Msg
from agentscope.model import OpenAIChatModel

# ============================================================================
# CONFIGURATION
# ============================================================================

AGENTS = ["maya", "jonah", "lina", "eli"]
ARCHIVE_DIR = Path("/Users/amar/HIVE-MIND/archive")
TUNING_DIR = Path("/Users/amar/HIVE-MIND/tuning")
LOOP_CONFIG = {
    "check_interval_hours": 1,  # How often to check if tuning is needed
    "eval_threshold": 20,        # Trigger tuning after 20 evals per agent
    "ab_test_size": 50,          # Number of tasks to validate variant
    "max_concurrent_agents": 4,  # Run agents in parallel
    "archive_retention_days": 90,  # Keep old versions for 90 days
}

# ============================================================================
# LOGGING
# ============================================================================

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    handlers=[
        logging.FileHandler(TUNING_DIR / "improvement_loop.log"),
        logging.StreamHandler(),
    ]
)
logger = logging.getLogger(__name__)


# ============================================================================
# DATA STRUCTURES
# ============================================================================

@dataclass
class LoopIteration:
    """One cycle of the improvement loop"""
    iteration_id: str
    timestamp: str
    agents_improved: List[str]  # Which agents got new variants
    metrics: Dict[str, float]   # Improvement rates
    archive_entries: List[str]  # What was saved
    status: str  # "completed", "failed", "in_progress"


@dataclass
class VariantEvaluation:
    """Results from A/B testing a variant"""
    variant_id: str
    agent_name: str
    baseline_score: float  # v0 or current version
    variant_score: float   # new variant
    improvement_pct: float
    ab_test_size: int
    winner: str  # "baseline" or "variant"
    promoted_at: Optional[str] = None
    archived_at: Optional[str] = None


# ============================================================================
# STEP 1: TASK GENERATION (Autonomous)
# ============================================================================

async def generate_autonomous_task(agent_name: str) -> Dict:
    """
    Generate a decision task WITHOUT human input.

    Uses pre-defined task templates specific to each agent's role.
    Randomizes parameters to create variety.
    """

    task_templates = {
        "maya": [
            {
                "scenario": "The team disagrees on whether to launch with {feature} ready or delay for polish. What's your recommendation?",
                "context": "Team split 50/50. {feature} is 80% complete but customers are waiting.",
                "evaluation_criteria": ["options clarity", "consensus building", "decision rationale"],
            },
            {
                "scenario": "We're at a critical junction: ship {feature} now or refactor architecture first?",
                "context": "Technical debt is accumulating. {feature} blocks three other items.",
                "evaluation_criteria": ["trade-off analysis", "stakeholder consideration", "implementation clarity"],
            },
            {
                "scenario": "How do we decide between {option_a} and {option_b}?",
                "context": "Both are viable. {option_a} is faster. {option_b} is more robust.",
                "evaluation_criteria": ["systematic comparison", "evidence-based reasoning", "decision framework"],
            },
        ],
        "jonah": [
            {
                "scenario": "Everyone agrees we should {action}. What's your concern?",
                "context": "Team consensus: 90%+. But you're the skeptic.",
                "evaluation_criteria": ["risk identification", "assumption challenging", "evidence of concern"],
            },
            {
                "scenario": "We're moving fast on {initiative}. Are we missing something critical?",
                "context": "Velocity is high but {initiative} is complex and {complexity_factor}.",
                "evaluation_criteria": ["edge case discovery", "dependency mapping", "failure mode analysis"],
            },
            {
                "scenario": "This worked in {prior_context}, so we're doing it again. But is that valid?",
                "context": "Past success: {past_success}. Current context differs in: {difference}.",
                "evaluation_criteria": ["context analysis", "assumption validation", "reasoning depth"],
            },
        ],
        "lina": [
            {
                "scenario": "We've faced a similar decision before with {prior_case}. What patterns do you see?",
                "context": "Outcome was: {outcome}. Current situation mirrors it in: {similarities}.",
                "evaluation_criteria": ["pattern recognition", "historical grounding", "evidence citation"],
            },
            {
                "scenario": "How is {current_decision} like or unlike {precedent}?",
                "context": "We made {decision_action} in {prior_year}. Result: {result}.",
                "evaluation_criteria": ["comparative analysis", "data-driven reasoning", "pattern mapping"],
            },
            {
                "scenario": "What does the data tell us about {topic}?",
                "context": "We have metrics on {metric_area}. Question: should we {action}?",
                "evaluation_criteria": ["data interpretation", "trend analysis", "evidence clarity"],
            },
        ],
        "eli": [
            {
                "scenario": "How would we actually implement {initiative}?",
                "context": "{initiative} is proposed but vague. Dependencies: {dependencies}.",
                "evaluation_criteria": ["step decomposition", "resource estimation", "feasibility assessment"],
            },
            {
                "scenario": "What do we need to make {goal} happen?",
                "context": "Timeline: {timeline}. Team: {team_size}. Technical complexity: {complexity}.",
                "evaluation_criteria": ["requirement clarity", "resource planning", "timeline realism"],
            },
            {
                "scenario": "What's blocking us from {action}?",
                "context": "We want to {action}. Current blockers: {blockers}.",
                "evaluation_criteria": ["blocker identification", "solution mapping", "implementation sequencing"],
            },
        ],
    }

    # Select random template
    import random
    template = random.choice(task_templates[agent_name])

    # Fill in variables (simplified - in production, use more sophisticated generation)
    scenario = template["scenario"].format(
        feature="AI-powered onboarding",
        option_a="Hire more engineers",
        option_b="Invest in tooling",
        action="Deploy to production immediately",
        initiative="Mobile redesign",
        complexity_factor="involves system redesign",
        prior_context="the 2024 migration",
        past_success="reduced load time by 40%",
        difference="infrastructure is now cloud-native",
        prior_case="the OAuth migration",
        outcome="successful after 2 weeks",
        similarities="requires coordination across teams",
        precedent="the 2023 payment integration",
        decision_action="merged incrementally",
        prior_year="Q4 2024",
        result="faster feedback, fewer bugs",
        topic="user retention",
        metric_area="monthly churn",
        action="prioritize feature X",
        goal="reduce onboarding time by 50%",
        timeline="8 weeks",
        team_size="5 engineers",
        complexity="high",
        blockers="missing API integration",
    )

    context = template["context"]

    return {
        "task_id": f"{agent_name}_auto_{datetime.now().isoformat()}",
        "agent_name": agent_name,
        "scenario": scenario,
        "context": context,
        "evaluation_criteria": template["evaluation_criteria"],
        "generated_at": datetime.now().isoformat(),
    }


# ============================================================================
# STEP 2: RUN AGENTS (using current prompt)
# ============================================================================

async def run_agent_on_task(
    agent_name: str,
    task: Dict,
    model: OpenAIChatModel,
) -> Tuple[str, Dict]:
    """Run an agent on a task using the current prompt version"""

    # Load current prompt (latest version from archive)
    current_prompt = await load_current_prompt(agent_name)

    # Create agent
    agent = ReActAgent(
        name=agent_name,
        sys_prompt=current_prompt,
        model=model,
        print_hint_msg=False,
    )
    agent.set_console_output_enabled(False)

    # Build message
    full_prompt = f"""Context: {task.get('context', '')}

Decision Task: {task['scenario']}

Provide your analysis and recommendation."""

    # Run agent
    response = await agent.reply(
        msg=Msg("user", full_prompt, role="user"),
    )

    response_text = response.get_text_content()

    return response_text, {
        "task_id": task["task_id"],
        "agent_name": agent_name,
        "response_length": len(response_text),
        "execution_time_seconds": 0,  # Would measure in production
    }


# ============================================================================
# STEP 3: AUTONOMOUS SCORING (no human feedback)
# ============================================================================

async def score_response_autonomously(
    agent_name: str,
    task: Dict,
    response: str,
) -> Dict:
    """
    Score agent response WITHOUT human input.

    Metrics:
    - Consistency: Does response align with agent's role?
    - Completeness: Does it address all evaluation criteria?
    - Clarity: Is reasoning clear and structured?
    - Depth: Does it show multi-layer analysis?

    Returns: score 0-1, breakdown, and opportunities
    """

    score = 0.0
    breakdown = {}

    # 1. CONSISTENCY: Role-specific analysis
    consistency_checks = {
        "maya": [
            "option" in response.lower() or "choice" in response.lower(),
            "however" in response.lower() or "but" in response.lower(),
            "\n" in response,  # Multi-paragraph structure
            len(response) > 150,  # Substantial response
        ],
        "jonah": [
            "risk" in response.lower() or "concern" in response.lower() or "?" in response,
            "why" in response.lower() or "but" in response.lower(),
            "assumption" in response.lower() or "however" in response.lower(),
            len(response) > 150,
        ],
        "lina": [
            "pattern" in response.lower() or "similar" in response.lower() or "previously" in response.lower(),
            "data" in response.lower() or "based on" in response.lower(),
            "trend" in response.lower() or "history" in response.lower(),
            len(response) > 150,
        ],
        "eli": [
            "implement" in response.lower() or "build" in response.lower() or "step" in response.lower(),
            "timeline" in response.lower() or "resource" in response.lower() or "plan" in response.lower(),
            "dependency" in response.lower() or "required" in response.lower(),
            len(response) > 150,
        ],
    }

    role_checks = consistency_checks.get(agent_name, [])
    consistency_score = sum(role_checks) / len(role_checks) if role_checks else 0.5
    breakdown["consistency"] = consistency_score

    # 2. COMPLETENESS: Addresses evaluation criteria
    criteria = task.get("evaluation_criteria", [])
    criteria_met = 0
    for criterion in criteria:
        # Simple keyword match (in production, use embedding similarity)
        if criterion.lower() in response.lower():
            criteria_met += 1
    completeness_score = criteria_met / len(criteria) if criteria else 0.5
    breakdown["completeness"] = completeness_score

    # 3. CLARITY: Structural analysis
    num_paragraphs = response.count("\n")
    num_sentences = response.count(".") + response.count("!") + response.count("?")
    has_reasoning = "because" in response.lower() or "therefore" in response.lower()

    clarity_bonus = 0.0
    if num_paragraphs > 2:
        clarity_bonus += 0.15
    if num_sentences > 3:
        clarity_bonus += 0.15
    if has_reasoning:
        clarity_bonus += 0.2
    clarity_score = min(0.5, clarity_bonus)
    breakdown["clarity"] = clarity_score

    # 4. DEPTH: Multi-layer analysis
    depth_indicators = [
        "tradeoff" in response.lower(),
        "consider" in response.lower(),
        "however" in response.lower() or "on the other hand" in response.lower(),
        "evidence" in response.lower() or "data" in response.lower(),
    ]
    depth_score = sum(depth_indicators) / len(depth_indicators)
    breakdown["depth"] = depth_score

    # Final score: weighted average
    score = (
        consistency_score * 0.3 +
        completeness_score * 0.3 +
        clarity_score * 0.2 +
        depth_score * 0.2
    )

    return {
        "score": score,
        "breakdown": breakdown,
        "opportunities": [
            k for k, v in breakdown.items() if v < 0.5
        ],
    }


# ============================================================================
# STEP 4: AGGREGATE BASELINE (current version metrics)
# ============================================================================

async def compute_baseline_metrics(agent_name: str) -> Dict:
    """
    Compute current baseline performance for an agent.

    Runs 10 autonomous tasks, scores each, averages.
    Used for comparison against variants.
    """

    logger.info(f"Computing baseline metrics for {agent_name}...")

    model = OpenAIChatModel(
        model_name="gpt-4-turbo",
        api_key=os.environ.get("OPENAI_API_KEY"),
    )

    scores = []

    for i in range(10):
        # Generate task
        task = await generate_autonomous_task(agent_name)

        # Run agent with CURRENT prompt
        response_text, _ = await run_agent_on_task(agent_name, task, model)

        # Score autonomously
        score_result = await score_response_autonomously(agent_name, task, response_text)
        scores.append(score_result["score"])

    baseline = {
        "agent_name": agent_name,
        "avg_score": sum(scores) / len(scores),
        "min_score": min(scores),
        "max_score": max(scores),
        "std_dev": (sum((s - sum(scores)/len(scores))**2 for s in scores) / len(scores)) ** 0.5,
        "computed_at": datetime.now().isoformat(),
    }

    logger.info(f"  Baseline for {agent_name}: {baseline['avg_score']:.3f}")

    return baseline


# ============================================================================
# STEP 5: LOAD CURRENT PROMPT
# ============================================================================

async def load_current_prompt(agent_name: str) -> str:
    """Load the current (latest) prompt variant for an agent"""

    # Check if there's a promoted v1, v2, etc.
    variants_dir = ARCHIVE_DIR / "prompt_variants"

    if not variants_dir.exists():
        # Fallback to initial prompt
        from phase1_prompt_tuning import INITIAL_PROMPTS
        return INITIAL_PROMPTS[agent_name]

    # Find latest promoted variant
    variant_files = list(variants_dir.glob(f"{agent_name}_tuning_*.json"))
    if variant_files:
        # Load latest
        latest = sorted(variant_files)[-1]
        with open(latest) as f:
            data = json.load(f)
            return data.get("optimized_prompt", INITIAL_PROMPTS[agent_name])

    # Fallback
    from phase1_prompt_tuning import INITIAL_PROMPTS
    return INITIAL_PROMPTS[agent_name]


# ============================================================================
# STEP 6: CHECK IF TUNING IS NEEDED
# ============================================================================

async def should_trigger_tuning(agent_name: str) -> bool:
    """
    Check if we have enough evaluations to justify running prompt tuning.

    Triggers when:
    - We have >= 20 evaluations for the agent
    - No tuning has run in the last 7 days
    - Agent performance is plateauing
    """

    # Count evaluations
    eval_file = ARCHIVE_DIR / "evaluations" / f"{agent_name}_evals.jsonl"
    if not eval_file.exists():
        return False

    eval_count = 0
    with open(eval_file) as f:
        for line in f:
            if line.strip():
                eval_count += 1

    if eval_count < LOOP_CONFIG["eval_threshold"]:
        logger.debug(f"{agent_name}: Only {eval_count} evals, need {LOOP_CONFIG['eval_threshold']}")
        return False

    # Check last tuning time
    variants_dir = ARCHIVE_DIR / "prompt_variants"
    variant_files = list(variants_dir.glob(f"{agent_name}_tuning_*.json")) if variants_dir.exists() else []

    if variant_files:
        latest = sorted(variant_files)[-1]
        last_tuning = datetime.fromisoformat(
            latest.stem.split("_")[-1]  # Extract date from filename
        )
        if datetime.now() - last_tuning < timedelta(days=7):
            logger.debug(f"{agent_name}: Tuned recently ({last_tuning}), skipping")
            return False

    logger.info(f"{agent_name}: Ready for tuning (evals={eval_count})")
    return True


# ============================================================================
# STEP 7: TRIGGER PROMPT TUNING
# ============================================================================

async def trigger_prompt_tuning(agent_name: str) -> Optional[str]:
    """
    Launch prompt tuning for an agent using phase1_prompt_tuning.py

    Returns: Path to the new optimized prompt variant, or None if failed
    """

    logger.info(f"Triggering prompt tuning for {agent_name}...")

    # Run the tuning script
    # In production, this would be a background job / async task queue
    import subprocess

    try:
        result = subprocess.run(
            [
                "python",
                str(TUNING_DIR / "phase1_prompt_tuning.py"),
                "--agent", agent_name,
                "--optimization-level", "medium",
            ],
            capture_output=True,
            text=True,
            timeout=600,  # 10 minute timeout
        )

        if result.returncode == 0:
            logger.info(f"Prompt tuning completed for {agent_name}")
            # Parse output to find new variant path
            # (In phase1_prompt_tuning.py output)
            return True
        else:
            logger.error(f"Prompt tuning failed: {result.stderr}")
            return None
    except Exception as e:
        logger.error(f"Error triggering tuning: {e}")
        return None


# ============================================================================
# STEP 8: A/B TEST NEW VARIANT
# ============================================================================

async def ab_test_variant(
    agent_name: str,
    baseline_prompt: str,
    variant_prompt: str,
    test_size: int = 50,
) -> VariantEvaluation:
    """
    Compare baseline (current) vs variant (new) on autonomous tasks.

    Runs test_size tasks with both, scores autonomously, computes winner.
    """

    logger.info(f"A/B testing {agent_name}: {test_size} tasks...")

    model = OpenAIChatModel(
        model_name="gpt-4-turbo",
        api_key=os.environ.get("OPENAI_API_KEY"),
    )

    baseline_scores = []
    variant_scores = []

    for i in range(test_size):
        # Generate task
        task = await generate_autonomous_task(agent_name)

        # Test BASELINE
        baseline_agent = ReActAgent(
            name=agent_name,
            sys_prompt=baseline_prompt,
            model=model,
            print_hint_msg=False,
        )
        baseline_agent.set_console_output_enabled(False)

        full_prompt = f"""Context: {task.get('context', '')}

Decision Task: {task['scenario']}

Provide your analysis and recommendation."""

        baseline_response = await baseline_agent.reply(
            msg=Msg("user", full_prompt, role="user"),
        )
        baseline_text = baseline_response.get_text_content()
        baseline_score_result = await score_response_autonomously(agent_name, task, baseline_text)
        baseline_scores.append(baseline_score_result["score"])

        # Test VARIANT
        variant_agent = ReActAgent(
            name=agent_name,
            sys_prompt=variant_prompt,
            model=model,
            print_hint_msg=False,
        )
        variant_agent.set_console_output_enabled(False)

        variant_response = await variant_agent.reply(
            msg=Msg("user", full_prompt, role="user"),
        )
        variant_text = variant_response.get_text_content()
        variant_score_result = await score_response_autonomously(agent_name, task, variant_text)
        variant_scores.append(variant_score_result["score"])

    baseline_avg = sum(baseline_scores) / len(baseline_scores)
    variant_avg = sum(variant_scores) / len(variant_scores)
    improvement = ((variant_avg - baseline_avg) / baseline_avg * 100) if baseline_avg > 0 else 0

    # Winner: variant wins if >3% improvement AND absolute score >0.65
    winner = "variant" if (improvement > 3 and variant_avg > 0.65) else "baseline"

    result = VariantEvaluation(
        variant_id=f"{agent_name}_variant_{datetime.now().isoformat()}",
        agent_name=agent_name,
        baseline_score=baseline_avg,
        variant_score=variant_avg,
        improvement_pct=improvement,
        ab_test_size=test_size,
        winner=winner,
    )

    logger.info(f"A/B Test Results for {agent_name}:")
    logger.info(f"  Baseline: {baseline_avg:.3f}")
    logger.info(f"  Variant:  {variant_avg:.3f}")
    logger.info(f"  Improvement: {improvement:.1f}%")
    logger.info(f"  Winner: {winner}")

    return result


# ============================================================================
# STEP 9: PROMOTE OR ARCHIVE
# ============================================================================

async def promote_or_archive_variant(evaluation: VariantEvaluation):
    """
    Based on A/B test results, promote variant or archive it.

    PROMOTE: Move variant to "active", set as current prompt
    ARCHIVE: Move to history, keep for lineage tracking
    """

    results_dir = ARCHIVE_DIR / "ab_test_results"
    results_dir.mkdir(parents=True, exist_ok=True)

    # Save evaluation result
    result_file = results_dir / f"{evaluation.variant_id}.json"
    with open(result_file, 'w') as f:
        json.dump(asdict(evaluation), f, indent=2)

    if evaluation.winner == "variant":
        logger.info(f"✅ PROMOTED: {evaluation.agent_name} variant")
        evaluation.promoted_at = datetime.now().isoformat()
        # In production: update active prompt pointer, notify system
    else:
        logger.info(f"📦 ARCHIVED: {evaluation.agent_name} variant (did not beat baseline)")
        evaluation.archived_at = datetime.now().isoformat()


# ============================================================================
# STEP 10: TRACK METRICS & ACCELERATION
# ============================================================================

async def track_improvement_metrics(agent_name: str, evaluation: VariantEvaluation):
    """
    Track improvement over time.

    Metrics:
    - Weekly improvement rate
    - Variance (consistency of improvement)
    - Acceleration (is improvement rate increasing?)
    """

    metrics_file = ARCHIVE_DIR / "improvement_metrics.jsonl"
    metrics_file.parent.mkdir(parents=True, exist_ok=True)

    record = {
        "agent_name": agent_name,
        "timestamp": datetime.now().isoformat(),
        "baseline_score": evaluation.baseline_score,
        "variant_score": evaluation.variant_score,
        "improvement_pct": evaluation.improvement_pct,
        "winner": evaluation.winner,
    }

    with open(metrics_file, 'a') as f:
        f.write(json.dumps(record) + "\n")

    # Compute acceleration (improvement rate change week-to-week)
    # Would read last 2 weeks, compare rates
    # logger.info(f"Acceleration for {agent_name}: +X% this week vs +Y% last week")


# ============================================================================
# MAIN LOOP
# ============================================================================

async def run_improvement_loop():
    """Main autonomous improvement loop"""

    logger.info("="*70)
    logger.info("🚀 AUTONOMOUS IMPROVEMENT LOOP STARTED")
    logger.info("="*70)

    iteration = 0

    while True:
        iteration += 1
        loop_iteration = LoopIteration(
            iteration_id=f"iter_{iteration}_{datetime.now().isoformat()}",
            timestamp=datetime.now().isoformat(),
            agents_improved=[],
            metrics={},
            archive_entries=[],
            status="in_progress",
        )

        try:
            logger.info(f"\n{'='*70}")
            logger.info(f"ITERATION {iteration}")
            logger.info(f"{'='*70}")

            # For each agent, check if tuning is needed
            for agent_name in AGENTS:
                logger.info(f"\n[{agent_name.upper()}]")

                # Check if we should tune
                if not await should_trigger_tuning(agent_name):
                    logger.info(f"  ℹ️  No tuning needed yet")
                    continue

                # Compute baseline
                baseline = await compute_baseline_metrics(agent_name)

                # Trigger tuning
                success = await trigger_prompt_tuning(agent_name)
                if not success:
                    logger.warning(f"  ❌ Tuning failed")
                    continue

                # Load new variant
                new_variant = await load_current_prompt(agent_name)
                baseline_prompt = new_variant  # TODO: load actual baseline

                # A/B test
                evaluation = await ab_test_variant(
                    agent_name,
                    baseline_prompt,
                    new_variant,
                    test_size=LOOP_CONFIG["ab_test_size"],
                )

                # Promote or archive
                await promote_or_archive_variant(evaluation)

                # Track metrics
                await track_improvement_metrics(agent_name, evaluation)

                loop_iteration.agents_improved.append(agent_name)
                loop_iteration.metrics[agent_name] = evaluation.improvement_pct

            loop_iteration.status = "completed"

        except Exception as e:
            logger.error(f"Loop iteration failed: {e}", exc_info=True)
            loop_iteration.status = "failed"

        # Save iteration record
        iter_file = ARCHIVE_DIR / "loop_iterations" / f"{loop_iteration.iteration_id}.json"
        iter_file.parent.mkdir(parents=True, exist_ok=True)
        with open(iter_file, 'w') as f:
            json.dump(asdict(loop_iteration), f, indent=2)

        # Log summary
        logger.info(f"\n✅ Iteration {iteration} complete")
        logger.info(f"   Agents improved: {', '.join(loop_iteration.agents_improved) or 'none'}")
        logger.info(f"   Improvements: {loop_iteration.metrics}")

        # Wait before next iteration
        wait_seconds = LOOP_CONFIG["check_interval_hours"] * 3600
        logger.info(f"\n⏰ Sleeping for {LOOP_CONFIG['check_interval_hours']}h before next check...")
        await asyncio.sleep(wait_seconds)


# ============================================================================
# ENTRY POINT
# ============================================================================

if __name__ == "__main__":
    asyncio.run(run_improvement_loop())
