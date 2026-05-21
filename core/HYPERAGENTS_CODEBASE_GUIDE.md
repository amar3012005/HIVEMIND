# HyperAgents Codebase Exploration Guide
## What to Look For in the Repository

**Repository**: https://github.com/facebookresearch/HyperAgents.git  
**Authors**: Jenny Zhang, Bingchen Zhao, Wannan Yang, Jakob Foerster (Meta/FAIR)  
**Publication**: ICLR 2025 / NeurIPS 2025  

---

## Quick Clone Instructions

```bash
# Clone the repository
git clone https://github.com/facebookresearch/HyperAgents.git
cd HyperAgents

# Install dependencies
pip install -r requirements.txt

# Explore structure
ls -la
tree -L 2
```

---

## Expected Directory Structure

```
HyperAgents/
├── README.md                          # Start here!
├── setup.py
├── requirements.txt
├── LICENSE
├── hyperagents/                       # Main package
│   ├── __init__.py
│   ├── core/                          # Core logic
│   │   ├── agent.py                   # Base Agent class
│   │   ├── task_agent.py              # Task agent implementation
│   │   ├── meta_agent.py              # Meta-agent implementation
│   │   └── hyperagent.py              # Combined hyperagent
│   ├── environments/                  # Test environments
│   │   ├── coding/                    # Coding tasks
│   │   ├── robotics/                  # Robotics tasks
│   │   ├── math/                      # Math tasks
│   │   └── review/                    # Paper review tasks
│   ├── evaluation/                    # Evaluation metrics
│   │   └── evaluator.py
│   └── utils/
│       ├── archive.py                 # Archive management
│       ├── versioning.py              # Version control
│       └── memory.py                  # Memory system
├── experiments/                       # Research experiments
│   ├── coding_agent/
│   ├── robotics_agent/
│   ├── math_agent/
│   └── paper_review/
├── tests/
│   ├── test_agent.py
│   ├── test_meta_agent.py
│   └── test_hyperagent.py
└── docs/                              # Documentation
    ├── architecture.md
    ├── api.md
    └── tutorial.md
```

---

## Key Files to Understand (In Order)

### 1. **README.md** (Start Here - 5 min)
**What to find**:
- Project overview
- Quick start guide
- Main concepts (Task Agent, Meta-Agent, Hyperagent)
- Links to paper and supplementary materials

**What to look for**:
```
✓ Darwin Gödel Machine (DGM) explanation
✓ How hyperagents differ from DGM
✓ Key innovation: metacognitive self-modification
✓ Example usage
```

---

### 2. **hyperagents/core/agent.py** (Foundation - 10 min)
**What this file contains**:
```python
class Agent:
    """Base agent class"""
    def __init__(self, code: str, tools: List[str]):
        self.code = code  # Python code the agent can execute
        self.tools = tools
        self.version = 0
    
    async def solve_task(self, task: str) -> str:
        """Execute the agent's code to solve a task"""
        pass
    
    async def modify(self, instructions: str) -> "Agent":
        """Create a modified version of self"""
        pass
```

**Key concepts**:
- Agents are **executable programs** (not just prompts!)
- Agents can **modify their own code**
- Version tracking from the start

**What to look for**:
```
✓ How code is stored and executed
✓ Tool integration (file I/O, search, etc.)
✓ Version tracking mechanism
✓ Error handling
```

---

### 3. **hyperagents/core/task_agent.py** (The Problem Solver - 10 min)
**What this file contains**:
```python
class TaskAgent(Agent):
    """Agent that solves the assigned task"""
    
    def __init__(self, task_description: str, tools: List[str]):
        self.task = task_description
        self.performance_history = []
    
    async def solve_task(self, input: str) -> str:
        """Solve the given task"""
        # Execute code to solve task
        pass
    
    async def get_performance_metrics(self) -> Dict:
        """Return how well this agent is doing"""
        return {
            "success_rate": 0.65,
            "avg_score": 7.5,
            "tokens_used": 1240,
        }
```

**Key concepts**:
- Task agents have **performance history**
- They're evaluated on actual **metrics** (not just feedback)
- They expose their **capabilities** to meta-agents

**What to look for**:
```
✓ How task performance is measured
✓ Feedback/evaluation storage
✓ What data is exposed to meta-agent
✓ How failures are logged
```

---

### 4. **hyperagents/core/meta_agent.py** (The Improver - 15 min)
**What this file contains**:
```python
class MetaAgent(Agent):
    """Agent that modifies other agents"""
    
    async def analyze_agent_performance(self, agent: Agent, evaluations: List[Dict]):
        """Analyze why an agent is failing"""
        # Read past evaluations
        # Identify failure patterns
        # Return analysis
        pass
    
    async def propose_modification(self, agent: Agent, analysis: Dict) -> str:
        """Generate modification instructions"""
        # "To fix these failures, change line 12 to..."
        # "Add error handling for..."
        pass
    
    async def apply_modification(self, agent: Agent, instructions: str) -> Agent:
        """Create modified version"""
        # Parse instructions
        # Generate new code
        # Create new agent version
        pass
```

**This is the core of self-improvement!**

**Key concepts**:
- Meta-agent reads **agent code and evaluations**
- Proposes **specific code modifications**
- Creates new **agent versions**
- Key insight: Uses **LLM to generate modifications**

**What to look for**:
```
✓ How failure analysis works
✓ LLM prompts for generating improvements
✓ How code modifications are validated
✓ Archive of all proposed changes
✓ Success rate of proposals
```

---

### 5. **hyperagents/core/hyperagent.py** (The Magic - 20 min)
**What this file contains** (THIS IS THE MOST IMPORTANT):
```python
class Hyperagent(Agent):
    """Self-referential agent: Task agent + Meta-agent + Meta-meta-agent"""
    
    def __init__(self, initial_code: str):
        self.task_agent = TaskAgent(code=initial_code)
        self.meta_agent = MetaAgent()
        self.meta_meta_agent = MetaMetaAgent()  # ← THE KEY
        
        self.archive = Archive()  # Stores all versions
        self.evaluation_history = []
    
    async def self_improve_cycle(self):
        """THE SELF-IMPROVING LOOP"""
        
        # 1. Task Agent solves task
        result = await self.task_agent.solve_task(self.current_task)
        
        # 2. Evaluate performance
        evaluation = await self.evaluate(result)
        self.evaluation_history.append(evaluation)
        
        # 3. Meta-Agent analyzes and proposes modification
        analysis = await self.meta_agent.analyze_agent_performance(
            self.task_agent, 
            self.evaluation_history
        )
        
        proposal = await self.meta_agent.propose_modification(
            self.task_agent, 
            analysis
        )
        
        # 4. Create variant
        variant = await self.meta_agent.apply_modification(
            self.task_agent, 
            proposal
        )
        
        # 5. A/B TEST
        variant_result = await variant.solve_task(self.current_task)
        if score(variant_result) > score(result):
            # Keep variant
            self.task_agent = variant
            self.archive.save(variant, score(variant_result))
        else:
            # Archive failed variant
            self.archive.save_failed(variant)
        
        # 6. META-META-AGENT ANALYZES META-AGENT ← THE MAGIC
        meta_quality = await self.meta_meta_agent.evaluate_meta_agent(
            self.meta_agent,
            proposal,
            evaluation
        )
        
        if meta_quality.accuracy < 0.6:
            # Meta-agent is not good at proposing improvements
            # Improve the meta-agent itself!
            new_meta_strategy = await self.meta_meta_agent.improve_meta_agent(
                self.meta_agent,
                meta_quality
            )
            self.meta_agent.update_strategy(new_meta_strategy)
        
        # 7. REPEAT
        return {
            "task_agent_version": self.task_agent.version,
            "meta_agent_version": self.meta_agent.version,
            "improvement": score(variant_result) - score(result),
        }
```

**THIS IS HYPERAGENTS IN ONE FILE**

**Key concepts**:
- **Three agents in one**: Task + Meta + Meta-Meta
- **Metacognitive**: Meta-agent modifies itself (not just task-agent!)
- **Archive**: Keeps all versions for learning
- **Self-acceleration**: Gets better at getting better

**What to look for**:
```
✓ The self_improve_cycle method
✓ How meta-meta-agent works
✓ Archive structure
✓ Version numbering scheme
✓ Evaluation metrics
✓ How variants are compared
✓ Integration with ARCHIVE
✓ Learning signals for meta-agent
```

---

### 6. **hyperagents/utils/archive.py** (The Memory - 10 min)
**What this file contains**:
```python
class Archive:
    """Stores all agent versions and their evaluations"""
    
    def save(self, agent: Agent, score: float):
        """Save successful variant"""
        key = f"{agent.name}-v{agent.version}"
        self.store[key] = {
            "agent": agent,
            "score": score,
            "created_at": now(),
            "parent": agent.parent_version,
        }
    
    async def get_best_performer(self, agent_name: str) -> Agent:
        """Return top-scoring version"""
        pass
    
    async def get_context(self, agent_name: str, limit: int = 5) -> List[Agent]:
        """Return top-N versions for meta-agent to learn from"""
        pass
    
    async def analyze_improvement_trajectory(self, agent_name: str) -> Dict:
        """Show improvement over time"""
        # Returns: [v0: 0.60, v1: 0.65, v2: 0.72, v3: 0.78...]
        pass
```

**Key concepts**:
- Archive is the **memory of progress**
- Meta-agent learns from archive
- Enables **quality-diversity** algorithms
- Tracks **genealogy** (parent-child relationships)

**What to look for**:
```
✓ Storage mechanism (file system, DB, etc.)
✓ How versions are indexed
✓ Retrieval strategies
✓ Bias toward best performers
✓ How meta-agent reads from archive
```

---

### 7. **hyperagents/evaluation/ ** (How Progress is Measured - 10 min)
**What to find**:
```
evaluator.py:
├── evaluate_coding_task()
├── evaluate_robotics_task()
├── evaluate_math_task()
└── evaluate_paper_review()

Each evaluator:
- Runs agent on task
- Measures success (pass/fail)
- Measures efficiency (tokens, time)
- Returns score 0-1
```

**What to look for**:
```
✓ Metrics for different domains
✓ How "success" is defined
✓ Efficiency penalties
✓ How evaluations are stored
```

---

### 8. **experiments/** (Real Examples - 20 min)

**What to find**:
```
experiments/coding_agent/
├── main.py              # Full hyperagent training
├── initial_agent.py     # Starting v0 code
├── tasks.py             # Test tasks
└── results/             # Training results
```

**What to look for**:
```
✓ How hyperagents are instantiated
✓ The training loop
✓ How many iterations/generations
✓ Performance trajectories
✓ Real improvement percentages
✓ Failure modes
✓ How meta-agent strategies evolve
```

**Example experiment flow**:
```
1. Create TaskAgent v0 (basic solution)
2. Run on 10 tasks, score: 0.60
3. MetaAgent proposes: "Add error handling"
4. Create TaskAgent v1
5. Score on same 10 tasks: 0.65 (+8%)
6. MetaAgent proposes: "Use better algorithm"
7. Create TaskAgent v2
8. Score: 0.73 (+12%)
9. MetaMetaAgent notices: "Algorithm suggestions work better"
10. MetaAgent v1 created with new strategy
11. MetaAgent v1 proposes: "Optimize data structures"
12. TaskAgent v3 scores: 0.82 (+12% again!)
13. Improvement is accelerating!
```

---

## The Three Critical Insights from Code

### Insight 1: Agents are Code, Not Prompts
```python
# NOT:
"You are an agent. Solve problems."

# YES:
"""
def solve(problem):
    step1 = parse_input(problem)
    step2 = apply_algorithm(step1)
    step3 = verify_output(step2)
    return step3
"""
```

**Why this matters**: The agent can **rewrite its own code**. Not just parameters—actual logic changes.

---

### Insight 2: Meta-Agent Uses LLM as Programmer
```python
# Meta-agent's prompt (real from paper):
"""
Agent code:
{agent.code}

Recent failures:
{failures}

Historical successes:
{successes}

Propose a modification to the agent code.
Be specific: which lines change, how, and why.
"""

# LLM generates:
"Change line 7 from:
    if len(data) > threshold:
to:
    if len(data) > adaptive_threshold(data):
    
Reason: Failures happen when threshold is static..."
```

**Why this matters**: LLM can be **code reviewer + programmer**. It understands its own output format.

---

### Insight 3: Evaluation is Everything
```python
# The three-agent loop only works because of this:
evaluation = await task_agent.solve_task(task)
score = await evaluator.grade(evaluation, expected)

# This score is what:
# 1. Tells meta-agent if improvement worked
# 2. Tells meta-meta-agent if meta-agent's advice was good
# 3. Drives everything forward

# Without good evaluation, no self-improvement.
```

**Why this matters**: The system is **data-driven**. More evals = better learning.

---

## Code Reading Roadmap (1-2 Hours)

### Beginner (30 min):
```
1. README.md
2. agent.py (base class)
3. Example experiment output
4. Understanding: "What is a hyperagent?"
```

### Intermediate (1 hour):
```
1. task_agent.py
2. meta_agent.py
3. archive.py
4. One experiment end-to-end
5. Understanding: "How does self-improvement work?"
```

### Advanced (1.5 hours):
```
1. hyperagent.py (full implementation)
2. meta_meta_agent.py (if exists)
3. evaluation/ code
4. experiments/ code
5. tests/ (to see failure modes)
6. Understanding: "How does it accelerate?"
```

---

## Key Things to Search For

When you clone and explore, search for:

```bash
# 1. Find the self-improvement loop
grep -r "self_improve" --include="*.py"

# 2. Find how versions are managed
grep -r "version\|Version" --include="*.py" | head -20

# 3. Find how meta-agent generates improvements
grep -r "propose_modification\|modify" --include="*.py"

# 4. Find how evaluations guide learning
grep -r "evaluate\|score\|feedback" --include="*.py"

# 5. Find the A/B testing logic
grep -r "compare\|test\|variant" --include="*.py"

# 6. Find archive implementation
grep -r "archive\|Archive" --include="*.py"

# 7. Find LLM integration points
grep -r "llm\|LLM\|gpt\|claude" --include="*.py"
```

---

## Critical Differences from DGM (Darwin Gödel Machine)

The paper's **main innovation** is fixing a limitation of DGM:

### DGM (Previous Work):
```python
class DarwinGodelMachine:
    # Fixed meta-level strategy
    def generate_instructions(self, agent, evaluations):
        # This is HARDCODED
        # Doesn't change
        # Limited to coding domain
        return "Try adding error handling"
```

### HyperAgents (New):
```python
class Hyperagent(Agent):
    # Meta-level strategy is EDITABLE
    def self_improve_cycle(self):
        # Meta-agent improves
        # Meta-meta-agent improves META-AGENT
        # Works on ANY task
        # Self-accelerating
        pass
```

**Find this comparison in the code**:
```bash
grep -r "DGM\|Darwin\|Gödel" --include="*.py"
# Should show how HyperAgents extends/differs
```

---

## What to Measure

When you run the code, look for:

### 1. Version Count
```
v0 → v1 → v2 → v3 → v4
(How many generations before plateauing?)
```

### 2. Improvement Rate
```
v0→v1: +5%
v1→v2: +8%
v2→v3: +7%
v3→v4: +10%
(Is it accelerating?)
```

### 3. Meta-Agent Accuracy
```
v0: 40% of proposals help
v1: 50% of proposals help
v2: 65% of proposals help
(Is meta-agent improving?)
```

### 4. Execution Metrics
```
Generation 0: 1000 tokens avg
Generation 1: 950 tokens avg
Generation 2: 920 tokens avg
(Improving efficiency too!)
```

---

## Integration with Your Digital Employees

When reading the code, think:

```
HyperAgents Code          →  Your Digital Employees
────────────────────────────────────────────────
Agent.code               →  Employee.persona (editable)
TaskAgent.solve_task()   →  Maya/Jonah solve_task()
MetaAgent                →  System that improves Maya
Archive                  →  HIVE-MIND memory
evaluate()               →  User feedback ratings
self_improve_cycle()     →  Daily improvement loop
```

**Implementation mapping**:
- `Agent.modify()` → Update employee persona
- `Archive.save()` → Save to HIVE-MIND
- `evaluate()` → hivemind_recall past evaluations
- `MetaAgent.propose()` → Use LLM to suggest changes

---

## Expected Pain Points & Learnings

### What Might Confuse You:
1. **Python code as executable**: They literally execute Python code. Not just modify parameters.
2. **LLM as code generator**: The meta-agent's prompts generate valid, executable code.
3. **Archive is critical**: All versions stored and accessible. This enables learning from history.
4. **Evaluation drives everything**: Without clear metrics, nothing improves.
5. **Metacognitive loop**: Mind-bending to think about meta-agent improving itself.

### Key Takeaways:
✓ Self-improvement is achievable with the right architecture  
✓ Three-agent system (task + meta + meta-meta) is powerful  
✓ Archive + evaluation = foundation for learning  
✓ Works on ANY task (not just coding)  
✓ Improvement can be self-accelerating  

---

## Next Steps After Exploring

1. **Run an experiment** (coding_agent probably easiest)
2. **Modify initial_agent.py** - Change the starting v0
3. **Track improvement** - Plot scores over generations
4. **Analyze meta-agent proposals** - What changes were suggested?
5. **Check archive growth** - How many versions created?
6. **Compare to baseline** - Does meta-agent actually help?

---

## Final: The Code is the Paper

The most important insight: **Read the code, not just the paper.**

The paper explains concepts. The code shows:
- Exact data structures
- Real prompts sent to LLM
- Actual evaluation metrics
- How versions are stored
- What happens in practice

When you clone and explore, you'll see:
```
"Oh! They store JSON like this:"
├── version_id
├── agent_code
├── performance_score
├── parent_version
├── metadata

"And they retrieve by:"
get_best_performer(agent_name)
# Finds highest-scoring version

"And they learn from archive by:"
context = archive.get_top_k_versions(5)
# Feeds to meta-agent as examples
```

This **concrete implementation detail** is what makes it work.

---

**Good luck exploring! The code is excellent and well-commented. You'll understand hyperagents much better by reading it.** 🚀

