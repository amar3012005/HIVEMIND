"""
Autonomous Task Generator

Creates diverse, challenging decision scenarios for agents.
No human input required - uses templates + randomization.

Includes 20+ scenarios per agent covering:
- Different complexity levels
- Various industry contexts
- Multiple stakeholder perspectives
- Time pressure variations
- Resource constraint scenarios
"""

import random
from dataclasses import dataclass
from typing import Dict, List


@dataclass
class DecisionTask:
    """A decision task for an agent"""
    task_id: str
    agent_name: str
    scenario: str
    context: str
    evaluation_criteria: List[str]
    difficulty: str  # "easy", "medium", "hard"
    category: str  # "resource", "timeline", "quality", "coordination"


# ============================================================================
# MAYA (COORDINATOR) TASKS
# ============================================================================

MAYA_TASKS = [
    # Resource allocation
    {
        "category": "resource",
        "scenarios": [
            "The team disagrees: spend 2 months polishing feature X or launch it now and iterate? What's your recommendation?",
            "We have $100k budget. Do we invest in infrastructure, hire 2 engineers, or split both ways?",
            "Three projects are competing for the same engineer. How do we decide?",
            "Staffing crisis: core engineer leaving. Do we backfill, redistribute their work, or delay projects?",
        ],
        "contexts": [
            "Team morale is high but burnout risk is rising. Timeline pressure: Q4 deadline.",
            "Budget year is ending. Unspent money reverts. Headcount is frozen.",
            "New startup fund just arrived. High-risk, high-reward opportunities available.",
            "Market window closing: competitors are moving. We have 4 weeks.",
        ],
        "criteria": [
            "Clear option presentation",
            "Stakeholder consideration",
            "Decision trade-off analysis",
            "Action plan clarity",
            "Risk acknowledgment",
        ],
    },
    # Timeline decisions
    {
        "category": "timeline",
        "scenarios": [
            "Launch with known bugs vs delay 2 weeks for fixes? What factors matter most?",
            "Beta with 100 users vs 1000 users? Tradeoffs?",
            "Incremental rollout (1% → 10% → 100%) or big bang? Your call?",
        ],
        "contexts": [
            "Customer complaints about current state. Pressure to deliver.",
            "System is stable but unproven at scale. Load testing incomplete.",
            "Competitor just launched similar feature. Speed is critical.",
        ],
        "criteria": [
            "Risk vs speed analysis",
            "Rollback readiness",
            "Monitoring clarity",
            "Communication plan",
        ],
    },
    # Quality vs speed
    {
        "category": "quality",
        "scenarios": [
            "Code review feedback suggests major refactor before launch. Accept delay or ship first?",
            "Test coverage is 70% (target: 90%). Ship or wait?",
            "Technical debt is documented. Do we pay it down now or defer?",
        ],
        "contexts": [
            "Engineering team argues for higher quality. Product team argues for speed.",
            "Previous launch had bugs. Quality-conscious culture.",
            "We've shipped with lower quality before without incident.",
        ],
        "criteria": [
            "Quality trade-off reasoning",
            "Long-term impact assessment",
            "Consensus building",
            "Mitigation strategy",
        ],
    },
    # Coordination decisions
    {
        "category": "coordination",
        "scenarios": [
            "Feature X blocks feature Y. Do we parallelize, sequence, or redesign both?",
            "Two teams propose different solutions. How do we decide?",
            "API change requested by mobile team breaks web team. Resolution?",
        ],
        "contexts": [
            "Teams are remote, communication is async.",
            "Both solutions are technically sound. Religious disagreement.",
            "Tight timeline - no room for rework.",
        ],
        "criteria": [
            "Multi-team perspective integration",
            "Technical trade-off clarity",
            "Implementation feasibility",
            "Communication effectiveness",
        ],
    },
]


# ============================================================================
# JONAH (SKEPTIC) TASKS
# ============================================================================

JONAH_TASKS = [
    # Consensus questioning
    {
        "category": "consensus",
        "scenarios": [
            "Everyone agrees we should expand internationally next quarter. What's your biggest concern?",
            "The team is unanimous: this architecture is sound. What could we be missing?",
            "Consensus: we should go all-in on machine learning. What's the downside?",
        ],
        "contexts": [
            "90%+ team alignment. Rare for this group.",
            "External advisors also agree. Industry zeitgeist supports it.",
            "Leadership is enthusiastic. Budget is allocated.",
        ],
        "criteria": [
            "Assumption identification",
            "Risk articulation",
            "Evidence for concern",
            "Alternative scenario modeling",
        ],
    },
    # Speed vs safety
    {
        "category": "safety",
        "scenarios": [
            "We're moving fast on payments integration. What could break in production?",
            "Database migration planned for 2-hour window. What's risky?",
            "Security scanning skipped to save 1 day. What's the exposure?",
        ],
        "contexts": [
            "Team is confident. They've done similar migrations before.",
            "Customers are waiting. Business pressure is high.",
            "No known vulnerabilities in current code.",
        ],
        "criteria": [
            "Failure mode identification",
            "Rollback readiness assessment",
            "Dependency mapping",
            "Recovery time estimation",
        ],
    },
    # Historical pattern questioning
    {
        "category": "pattern",
        "scenarios": [
            "We succeeded with this exact approach 2 years ago. But is context still the same?",
            "Previous launch with this team went smoothly. Why might this one be different?",
            "We've hit this scaling challenge before and solved it. Can we apply the same fix?",
        ],
        "contexts": [
            "Team composition has changed 40%.",
            "Customer base is 10x larger now.",
            "Technology stack has evolved significantly.",
        ],
        "criteria": [
            "Context change analysis",
            "Assumption validation",
            "Applicability questioning",
            "Risk of false confidence",
        ],
    },
]


# ============================================================================
# LINA (RESEARCHER) TASKS
# ============================================================================

LINA_TASKS = [
    # Pattern recognition
    {
        "category": "pattern",
        "scenarios": [
            "We've seen 3 similar customer churn events in the last year. What pattern explains them?",
            "Performance degradation keeps happening after big releases. What's the common thread?",
            "Three separate teams have abandoned the same internal tool. Why?",
        ],
        "contexts": [
            "Each event seemed isolated at the time.",
            "Team remembers anecdotes but no systematic data.",
            "Different root causes suspected each time.",
        ],
        "criteria": [
            "Pattern identification",
            "Data-driven reasoning",
            "Historical grounding",
            "Predictive insight",
        ],
    },
    # Data analysis
    {
        "category": "data",
        "scenarios": [
            "Retention metrics show X% decline. What does the data say we should prioritize?",
            "User engagement data reveals unexpected cluster: 20% of users do Y. So what?",
            "API latency increased 30% last month. What's the trend signal?",
        ],
        "contexts": [
            "Multiple confounding variables in the data.",
            "Cluster is small but consistent.",
            "Latency spike coincided with feature X launch.",
        ],
        "criteria": [
            "Data interpretation accuracy",
            "Confounding variable awareness",
            "Trend forecasting",
            "Causal reasoning",
        ],
    },
    # Precedent application
    {
        "category": "precedent",
        "scenarios": [
            "How is this customer escalation like/unlike the one that became a support crisis last year?",
            "We tried feature Z before and it failed. Should we try again with improvements?",
            "This is similar to the 2023 incident. Are we making the same mistake?",
        ],
        "contexts": [
            "Surface similarities but deep differences.",
            "Improvements are modest but meaningful.",
            "Different team, similar mistake pattern.",
        ],
        "criteria": [
            "Comparative analysis depth",
            "Historical accuracy",
            "Learning application",
            "Risk of repetition detection",
        ],
    },
]


# ============================================================================
# ELI (BUILDER) TASKS
# ============================================================================

ELI_TASKS = [
    # Implementation planning
    {
        "category": "implementation",
        "scenarios": [
            "How would we actually implement end-to-end encryption in our platform?",
            "Build a real-time notification system. What are the steps?",
            "Migrate 50M users from old database to new one without downtime. Plan?",
        ],
        "contexts": [
            "Current architecture wasn't designed for this.",
            "Team has some experience but not experts.",
            "Tight timeline (8 weeks).",
        ],
        "criteria": [
            "Step decomposition clarity",
            "Dependency identification",
            "Resource estimation",
            "Risk mitigation planning",
        ],
    },
    # Resource estimation
    {
        "category": "resources",
        "scenarios": [
            "What do we need to build the mobile app in 6 months with current team?",
            "Estimate effort for 'make dashboard 5x faster'.",
            "Cost-benefit: hire 2 specialists or train team internally?",
        ],
        "contexts": [
            "Team has never built mobile before.",
            "Dashboard is complex but critical path unclear.",
            "Training takes 3 months, hiring adds cost.",
        ],
        "criteria": [
            "Requirement clarity",
            "Skill gap identification",
            "Timeline realism",
            "Trade-off reasoning",
        ],
    },
    # Dependency and sequencing
    {
        "category": "sequencing",
        "scenarios": [
            "We want to: add payments, build admin portal, launch mobile app. What order?",
            "Feature X depends on infrastructure Y which depends on refactor Z. Timeline?",
            "Three API changes requested. Can we batch them? If not, what order?",
        ],
        "contexts": [
            "All seem urgent.",
            "Z is architectural, long-blocking.",
            "Batching saves engineering time but delays individual features.",
        ],
        "criteria": [
            "Dependency mapping",
            "Critical path identification",
            "Sequencing rationale",
            "Parallel opportunity recognition",
        ],
    },
]


# ============================================================================
# TASK GENERATOR
# ============================================================================

def generate_task(agent_name: str, seed: int = None) -> DecisionTask:
    """
    Generate a random task for an agent.

    Args:
        agent_name: "maya", "jonah", "lina", or "eli"
        seed: optional for reproducibility

    Returns:
        DecisionTask with scenario, context, and evaluation criteria
    """

    if seed is not None:
        random.seed(seed)

    task_templates = {
        "maya": MAYA_TASKS,
        "jonah": JONAH_TASKS,
        "lina": LINA_TASKS,
        "eli": ELI_TASKS,
    }

    if agent_name not in task_templates:
        raise ValueError(f"Unknown agent: {agent_name}")

    # Pick a random template group
    template_group = random.choice(task_templates[agent_name])

    # Pick random scenario, context, category
    scenario = random.choice(template_group["scenarios"])
    context = random.choice(template_group["contexts"])
    category = template_group["category"]
    criteria = template_group["criteria"]

    # Determine difficulty (random, but can be weighted)
    difficulty = random.choice(["easy", "medium", "hard"])

    # Generate unique task ID
    from datetime import datetime
    task_id = f"{agent_name}_{category}_{datetime.now().isoformat()}"

    return DecisionTask(
        task_id=task_id,
        agent_name=agent_name,
        scenario=scenario,
        context=context,
        evaluation_criteria=criteria,
        difficulty=difficulty,
        category=category,
    )


def generate_batch_tasks(
    agent_name: str,
    count: int,
    difficulty: str = None,  # Filter to specific difficulty
) -> List[DecisionTask]:
    """Generate a batch of tasks for an agent"""

    tasks = []
    for i in range(count):
        task = generate_task(agent_name, seed=random.randint(0, 1000000))

        if difficulty and task.difficulty != difficulty:
            # Retry for matching difficulty
            attempts = 0
            while task.difficulty != difficulty and attempts < 3:
                task = generate_task(agent_name, seed=random.randint(0, 1000000))
                attempts += 1

        tasks.append(task)

    return tasks


def task_to_dict(task: DecisionTask) -> Dict:
    """Convert task to dictionary (for JSON serialization)"""

    return {
        "task_id": task.task_id,
        "agent_name": task.agent_name,
        "scenario": task.scenario,
        "context": task.context,
        "evaluation_criteria": task.evaluation_criteria,
        "difficulty": task.difficulty,
        "category": task.category,
    }


# ============================================================================
# SAMPLING STRATEGIES
# ============================================================================

def sample_diverse_tasks(count: int) -> Dict[str, List[DecisionTask]]:
    """Sample diverse tasks across all agents"""

    agents = ["maya", "jonah", "lina", "eli"]
    per_agent = count // len(agents)

    tasks = {}
    for agent in agents:
        tasks[agent] = generate_batch_tasks(agent, per_agent)

    return tasks


def sample_by_difficulty(agent_name: str, difficulties: Dict[str, int]) -> List[DecisionTask]:
    """
    Sample tasks with specific difficulty distribution.

    Example:
        {"easy": 10, "medium": 20, "hard": 10}
    """

    tasks = []

    for difficulty, count in difficulties.items():
        batch = generate_batch_tasks(agent_name, count, difficulty=difficulty)
        tasks.extend(batch)

    return tasks


# ============================================================================
# MAIN (for testing)
# ============================================================================

if __name__ == "__main__":
    # Test task generation
    print("=" * 70)
    print("SAMPLE TASKS")
    print("=" * 70)

    for agent_name in ["maya", "jonah", "lina", "eli"]:
        print(f"\n{agent_name.upper()}:")
        print("-" * 70)

        task = generate_task(agent_name)
        print(f"Scenario: {task.scenario}")
        print(f"Context: {task.context}")
        print(f"Difficulty: {task.difficulty}")
        print(f"Category: {task.category}")
        print(f"Criteria: {', '.join(task.evaluation_criteria)}")

    # Test batch generation
    print("\n" + "=" * 70)
    print("BATCH GENERATION (20 tasks total, diverse)")
    print("=" * 70)

    batch = sample_diverse_tasks(20)
    for agent, tasks in batch.items():
        print(f"\n{agent}: {len(tasks)} tasks")
        for task in tasks:
            print(f"  - {task.category}: {task.difficulty}")
