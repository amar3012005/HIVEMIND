"""
Phase 1: Prompt Tuning for Digital Employees

Optimizes individual agent system prompts using AgentScope's tune_prompt()
Based on evaluation history stored in HIVE-MIND archive.

Usage:
    python phase1_prompt_tuning.py --agent maya --optimization-level medium
    python phase1_prompt_tuning.py --agent jonah
"""

import asyncio
import json
import os
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

from agentscope.agent import ReActAgent
from agentscope.formatter import OpenAIChatFormatter
from agentscope.message import Msg
from agentscope.model import OpenAIChatModel
from agentscope.tuner import DatasetConfig, JudgeOutput, WorkflowOutput
from agentscope.tuner.prompt_tune import PromptTuneConfig, tune_prompt


# ============================================================================
# EMPLOYEE INITIAL PROMPTS
# ============================================================================

INITIAL_PROMPTS = {
    "maya": """You are Maya, the Coordinator. Your role in team decisions:

1. **Organize Information**: Present all options clearly and systematically
2. **Seek Consensus**: Find common ground between different viewpoints
3. **Document Decisions**: Summarize what was decided and why
4. **Drive Action**: Ensure the team moves forward decisively

Communication style: Professional, structured, solution-focused.
Be concise but thorough. Always explain your reasoning.""",

    "jonah": """You are Jonah, the Skeptic. Your role in team decisions:

1. **Challenge Assumptions**: Question everything, especially consensus
2. **Identify Risks**: Find potential problems before they happen
3. **Play Devil's Advocate**: Present counterarguments thoughtfully
4. **Protect the Team**: Ensure decisions are sound, not just popular

Communication style: Inquisitive, evidence-focused, constructive.
Disagree without being disagreeable. Explain what concerns you.""",

    "lina": """You are Lina, the Researcher. Your role in team decisions:

1. **Find Context**: Locate relevant past decisions and outcomes
2. **Analyze Patterns**: Identify what has worked and what hasn't
3. **Provide Evidence**: Back up claims with data and examples
4. **Predict Outcomes**: Use patterns to forecast likely results

Communication style: Analytical, data-driven, pattern-focused.
Show your sources. Connect current decisions to historical context.""",

    "eli": """You are Eli, the Builder. Your role in team decisions:

1. **Focus on Execution**: How will we actually build/implement this?
2. **Identify Resources**: What do we need to make this happen?
3. **Spot Dependencies**: What else needs to happen first?
4. **Propose Timelines**: When can this realistically be done?

Communication style: Practical, concrete, action-oriented.
Talk about implementation. Raise feasibility concerns early.""",
}


# ============================================================================
# WORKFLOW FUNCTIONS (one per employee)
# ============================================================================

async def create_workflow_for_agent(agent_name: str, model: OpenAIChatModel):
    """Factory function to create workflow for any agent"""

    async def workflow(
        task: Dict,
        system_prompt: str,
    ) -> WorkflowOutput:
        """
        Workflow for individual agent on a decision task.

        Args:
            task: Dict with "scenario" (decision task) and "context" (background)
            system_prompt: The optimizable system prompt
        """

        agent = ReActAgent(
            name=agent_name,
            sys_prompt=system_prompt,  # This gets tuned
            model=model,
            formatter=OpenAIChatFormatter(),
            print_hint_msg=False,
        )
        agent.set_console_output_enabled(False)

        # Build the message with context
        full_prompt = f"""Context: {task.get('context', '')}

Decision Task: {task['scenario']}

Provide your analysis and recommendation."""

        response = await agent.reply(
            msg=Msg("user", full_prompt, role="user"),
        )

        return WorkflowOutput(response=response)

    return workflow


# ============================================================================
# JUDGE FUNCTIONS (evaluate based on user feedback + quality metrics)
# ============================================================================

async def create_judge_for_agent(agent_name: str, archive_dir: Path):
    """Factory function to create judge for any agent"""

    async def judge_function(
        task: Dict,
        response: Msg,
    ) -> JudgeOutput:
        """
        Judge agent response using:
        1. User feedback score from evaluations
        2. Structural quality checks (agent-role specific)
        """

        # Base score from user evaluations
        base_score = task.get("avg_user_score", 0.5)  # 0-1 scale

        response_text = response.get_text_content()

        # Role-specific quality checks
        quality_bonus = 0.0

        if agent_name == "maya":
            # Coordinator: check for structure and clarity
            if any(word in response_text.lower() for word in
                   ["option", "choice", "consider", "decision"]):
                quality_bonus += 0.05
            if response_text.count("\n") > 5:  # Well-structured
                quality_bonus += 0.05

        elif agent_name == "jonah":
            # Skeptic: check for questions and risks
            if "?" in response_text or any(word in response_text.lower()
                                           for word in ["risk", "concern", "but", "however"]):
                quality_bonus += 0.08

        elif agent_name == "lina":
            # Researcher: check for evidence and context
            if any(word in response_text.lower() for word in
                   ["based on", "data", "pattern", "similar", "previously"]):
                quality_bonus += 0.08

        elif agent_name == "eli":
            # Builder: check for concrete next steps
            if any(word in response_text.lower() for word in
                   ["implementation", "timeline", "resources", "build", "steps"]):
                quality_bonus += 0.08

        final_score = min(1.0, base_score + quality_bonus)

        return JudgeOutput(reward=final_score)

    return judge_function


# ============================================================================
# DATASET CREATION (from HIVE-MIND evaluations)
# ============================================================================

def create_tuning_dataset(
    agent_name: str,
    archive_dir: Path,
    output_dir: Path,
) -> DatasetConfig:
    """
    Create training dataset from evaluation history in HIVE-MIND.

    Reads: archive/evaluations/{agent_id}_evals.jsonl
    Creates: tuning/datasets/{agent_name}_tuning_data.jsonl
    """

    eval_file = archive_dir / f"{agent_name}_evals.jsonl"

    if not eval_file.exists():
        print(f"⚠️  No evaluations found for {agent_name} at {eval_file}")
        print("   Creating synthetic dataset for bootstrap...")
        return create_synthetic_dataset(agent_name, output_dir)

    # Read evaluations
    evaluations = []
    with open(eval_file, 'r') as f:
        for line in f:
            if line.strip():
                evaluations.append(json.loads(line))

    if not evaluations:
        return create_synthetic_dataset(agent_name, output_dir)

    # Convert to AgentScope format
    tasks = []
    for i, eval_record in enumerate(evaluations):
        task = {
            "scenario": eval_record.get("improvement_opportunities", ["improve"])[0],
            "context": eval_record.get("response_snippet", ""),
            "avg_user_score": eval_record.get("score", 0.5),
            "eval_id": eval_record.get("evaluation_id"),
        }
        tasks.append(task)

    # Save as JSONL
    output_dir.mkdir(parents=True, exist_ok=True)
    dataset_file = output_dir / f"{agent_name}_train.jsonl"

    with open(dataset_file, 'w') as f:
        for task in tasks:
            f.write(json.dumps(task) + "\n")

    print(f"✅ Created dataset: {dataset_file}")
    print(f"   Tasks: {len(tasks)}")

    return DatasetConfig(path=str(output_dir), split="train")


def create_synthetic_dataset(
    agent_name: str,
    output_dir: Path,
    num_samples: int = 10,
) -> DatasetConfig:
    """Create synthetic dataset for initial bootstrapping"""

    scenarios = {
        "maya": [
            "Should we launch the feature with known bugs?",
            "How do we decide between option A and option B?",
            "The team disagrees on the timeline. What now?",
        ],
        "jonah": [
            "Everyone agrees this is a good idea. What could go wrong?",
            "We're moving fast. Are we missing something?",
            "This approach worked before. But is it still valid?",
        ],
        "lina": [
            "We've done something similar before. What happened?",
            "What patterns do you see in this decision?",
            "How is this like or unlike past situations?",
        ],
        "eli": [
            "How would we actually implement this?",
            "What do we need to make this work?",
            "What's the realistic timeline?",
        ],
    }

    output_dir.mkdir(parents=True, exist_ok=True)
    dataset_file = output_dir / f"{agent_name}_train.jsonl"

    tasks = []
    for scenario in scenarios.get(agent_name, ["default task"]):
        for i in range(num_samples // len(scenarios.get(agent_name, [""]))):
            task = {
                "scenario": scenario,
                "context": f"Team meeting about {agent_name}'s area",
                "avg_user_score": 0.65,  # Start with "okay" baseline
            }
            tasks.append(task)

    with open(dataset_file, 'w') as f:
        for task in tasks:
            f.write(json.dumps(task) + "\n")

    print(f"📝 Created synthetic dataset: {dataset_file}")
    print(f"   Tasks: {len(tasks)}")

    return DatasetConfig(path=str(output_dir), split="train")


# ============================================================================
# TUNING EXECUTION
# ============================================================================

async def tune_agent_prompt(
    agent_name: str,
    optimization_level: str = "medium",
    archive_dir: Optional[Path] = None,
    output_dir: Optional[Path] = None,
):
    """
    Main entry point: tune an agent's system prompt

    Args:
        agent_name: "maya", "jonah", "lina", or "eli"
        optimization_level: "light", "medium", or "heavy"
        archive_dir: Path to evaluation archive
        output_dir: Path to save results
    """

    if agent_name not in INITIAL_PROMPTS:
        raise ValueError(f"Unknown agent: {agent_name}")

    # Setup paths
    archive_dir = archive_dir or Path("/Users/amar/HIVE-MIND/archive")
    output_dir = output_dir or Path("/Users/amar/HIVE-MIND/tuning/datasets")
    results_dir = Path("/Users/amar/HIVE-MIND/archive/prompt_variants")
    results_dir.mkdir(parents=True, exist_ok=True)

    print(f"\n🚀 Tuning {agent_name.upper()}'s system prompt")
    print(f"   Level: {optimization_level}")
    print(f"   Model: gpt-4-turbo (teacher)")

    # Setup model
    model = OpenAIChatModel(
        model_name="gpt-4-turbo",
        api_key=os.environ.get("OPENAI_API_KEY"),
    )

    # Create dataset
    print(f"\n📊 Creating tuning dataset...")
    dataset = create_tuning_dataset(agent_name, archive_dir, output_dir)

    # Create workflow and judge
    print(f"\n⚙️  Setting up workflow and judge...")
    workflow = await create_workflow_for_agent(agent_name, model)
    judge = await create_judge_for_agent(agent_name, archive_dir)

    # Run tuning
    print(f"\n🔄 Running prompt tuning (this may take 5-10 minutes)...")
    initial_prompt = INITIAL_PROMPTS[agent_name]

    optimized_prompt, metrics = tune_prompt(
        workflow=workflow,
        init_system_prompt=initial_prompt,
        judge_func=judge,
        train_dataset=dataset,
        config=PromptTuneConfig(
            lm_model_name="dashscope/qwen-max",  # or gpt-4 if available
            optimization_level=optimization_level,
        ),
    )

    # Save results
    print(f"\n💾 Saving results...")
    timestamp = datetime.now().isoformat()

    result_record = {
        "agent_name": agent_name,
        "timestamp": timestamp,
        "initial_prompt": initial_prompt,
        "optimized_prompt": optimized_prompt,
        "metrics": metrics,
        "optimization_level": optimization_level,
    }

    # Save to results directory
    result_file = results_dir / f"{agent_name}_tuning_{timestamp.split('T')[0]}.json"
    with open(result_file, 'w') as f:
        json.dump(result_record, f, indent=2)

    print(f"✅ Results saved to: {result_file}")

    # Print summary
    print(f"\n{'='*70}")
    print(f"TUNING RESULTS FOR {agent_name.upper()}")
    print(f"{'='*70}")
    print(f"\nInitial Prompt:")
    print(f"  {initial_prompt[:100]}...")
    print(f"\nOptimized Prompt:")
    print(f"  {optimized_prompt[:100]}...")
    print(f"\nMetrics:")
    for key, value in metrics.items():
        print(f"  {key}: {value}")
    print(f"{'='*70}\n")

    return optimized_prompt, metrics


# ============================================================================
# MAIN
# ============================================================================

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(
        description="Phase 1: Prompt Tuning for Digital Employees"
    )
    parser.add_argument(
        "--agent",
        choices=["maya", "jonah", "lina", "eli", "all"],
        default="maya",
        help="Which agent to tune (default: maya)",
    )
    parser.add_argument(
        "--optimization-level",
        choices=["light", "medium", "heavy"],
        default="medium",
        help="Tuning intensity (default: medium)",
    )

    args = parser.parse_args()

    # Run tuning
    agents = [args.agent] if args.agent != "all" else ["maya", "jonah", "lina", "eli"]

    for agent_name in agents:
        asyncio.run(
            tune_agent_prompt(
                agent_name=agent_name,
                optimization_level=args.optimization_level,
            )
        )

    print("✨ Phase 1 Prompt Tuning Complete!")
