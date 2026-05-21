# AgentScope Self-Learning Integration Strategy
## For Digital Employees Container with HyperAgents Architecture

**Date**: 2026-05-16  
**Context**: Employees container uses AgentScope ReAct agents (Maya, Jonah, Lina, Eli)  
**Goal**: Implement self-improving agents via AgentScope tuning + HyperAgents feedback loop

---

## 🎯 Executive Summary: The Hybrid Approach

**Best approach: PROMPT TUNING (Phase 1) → MULTI-AGENT TUNING (Phase 2)**

| Phase | Method | Why | Timeline | Cost |
|-------|--------|-----|----------|------|
| **1** | **Prompt Tuning** | Fast iteration, lower GPU cost, aligns with meta-agent analysis | Weeks 1-3 | Low |
| **2** | **Multi-Agent Tuning** | Team dynamics, coordination, acceleration | Weeks 4-8 | Medium |
| **3** | **Hyperagent Loop** | Meta-agent improves itself via RL | Weeks 9+ | High |

---

## 📋 Why NOT Pure "X" Approach

### ❌ Prompt Tuning Alone
**Pros:**
- ✅ Fast, cheap, iterative
- ✅ Perfect for persona refinement
- ✅ Works well with evaluation feedback

**Cons:**
- ❌ Doesn't optimize agent interactions (team simulation)
- ❌ Can't learn from multi-turn dynamics
- ❌ Limited to tweaking what prompts can do
- ❌ Misses coordination patterns between Maya/Jonah/Lina/Eli

### ❌ Multi-Agent Tuning Alone
**Pros:**
- ✅ Optimizes team dynamics
- ✅ Learns interaction patterns
- ✅ Can use RL for complex behaviors

**Cons:**
- ❌ Expensive (requires multiple GPUs for auxiliary agents)
- ❌ Slow feedback loops
- ❌ Black-box improvements (hard to understand what changed)
- ❌ Overkill for initial persona tuning

### ✅ Hybrid (Prompt First, Then Multi-Agent)
**Why this wins:**
1. **Phase 1 (Prompt)** refines each agent's core behavior
2. **Phase 2 (Multi-Agent)** optimizes how they work *together*
3. **Combines benefits**: Speed + Insights + Team optimization
4. **Aligns with HyperAgents**: Meta-agent generates prompts → Evaluations → Proposals validated via A/B testing

---

## 🔄 Architecture: Three-Loop Integration

```
User Feedback (1-5 stars)
    ↓
Evaluation System (Phase 1 from previous work)
    ↓
HIVE-MIND Memory (evaluations stored)
    ↓
Meta-Agent Analysis (Why did this work/fail?)
    ↓
    ├─ LOOP 1: Prompt Variant Generation
    │  └─ Input: Analysis of failures
    │  └─ Process: LLM generates improved system prompts
    │  └─ Output: maya_v1, jonah_v1, etc. (new personas)
    │
    └─ LOOP 2: Multi-Agent Coordination Tuning
       └─ Input: Prompt variants + team simulation tasks
       └─ Process: AgentScope multi-agent tuner trains interactions
       └─ Output: Optimized team dynamics (better consensus)
       
A/B Testing Framework
    ↓
Promotion/Archival (HIVE-MIND archive)
    ↓
Performance Tracking (trending improvement)
```

---

## 📊 Phase 1: Prompt Tuning (Weeks 1-3) — CRITICAL FOUNDATION

### What AgentScope Prompt Tuning Does

From the docs, `tune_prompt()` uses an LLM (teacher model) to iteratively refine system prompts:

```
Initial: "You are a helpful coordinator"
  ↓
Teacher model analyzes failures:
  "Fails on complex decisions, needs evidence-based reasoning"
  ↓
Proposes: "You are a thorough coordinator. For each decision,
          list supporting evidence first..."
  ↓
Evaluates on dataset
  ↓
Score improves: 0.65 → 0.72
```

### Implementation for Digital Employees

**Step 1: Create per-employee tuning workflows**

```python
# agents/maya_tuning.py
async def maya_workflow(
    task: Dict,
    system_prompt: str,  # tunable
) -> WorkflowOutput:
    """Task: Coordinate team decision on feature launch"""
    
    agent = ReActAgent(
        name="maya",
        sys_prompt=system_prompt,  # ← This gets optimized
        model=gpt4,
        formatter=OpenAIChatFormatter(),
        toolkit=decision_tools,
    )
    
    response = await agent.reply(
        msg=Msg("user", task["scenario"], role="user")
    )
    
    return WorkflowOutput(response=response)
```

**Step 2: Define judge function from your evaluations**

```python
async def maya_judge(task: Dict, response: Msg) -> JudgeOutput:
    """Judge uses criteria from HIVE-MIND evaluations"""
    
    evaluation_score = task.get("avg_score", 0.5)  # from user feedback
    
    # Bonus: Add structural checks
    has_evidence = any(word in response.text for word in 
                      ["based on", "evidence", "data"])
    clarity_bonus = 0.1 if has_evidence else 0
    
    final_score = evaluation_score + clarity_bonus
    return JudgeOutput(reward=final_score)
```

**Step 3: Launch prompt tuning**

```python
from agentscope.tuner import DatasetConfig
from agentscope.tuner.prompt_tune import tune_prompt, PromptTuneConfig

# Create dataset from evaluation history
dataset = create_dataset_from_evaluations(
    agent_id="maya",
    evaluations=hive_mind_recall(tags=["maya", "evaluation"])
)

initial_prompt = """You are Maya, the coordinator. Your role:
1. Organize options clearly
2. Seek consensus
3. Document decisions"""

optimized_prompt, metrics = tune_prompt(
    workflow=maya_workflow,
    init_system_prompt=initial_prompt,
    judge_func=maya_judge,
    train_dataset=dataset,
    config=PromptTuneConfig(
        lm_model_name="gpt-4-turbo",
        optimization_level="medium",
    ),
)

# Save result to archive
save_prompt_variant(
    agent_name="maya",
    version="v1",
    system_prompt=optimized_prompt,
    metrics=metrics,
)
```

### Expected Outcome (Week 3)

```
Maya v0: "You are a helpful coordinator"
  Score: 0.65
  
Maya v1: "You are an analytical coordinator who structures 
         complex decisions through evidence mapping and 
         multi-perspective analysis..."
  Score: 0.74 (+13% ✅)
  
Archive stored in HIVE-MIND:
  - maya_v0.prompt (baseline)
  - maya_v1.prompt (optimized)
  - comparison_metrics.json
```

---

## 🤖 Phase 2: Multi-Agent Tuning (Weeks 4-8) — TEAM OPTIMIZATION

### What AgentScope Multi-Agent Tuning Does

From the docs, tune agents in *interaction*. Example: werewolf game trains werewolf agents while villagers stay frozen.

Your case: Train Maya + Jonah *together* while Lina/Eli frozen, then rotate.

### Implementation for Digital Employees

**Step 1: Define team simulation workflow**

```python
# agents/team_simulation_tuning.py
async def team_simulation_workflow(
    task: Dict,
    model: ChatModelBase,
    auxiliary_models: Dict[str, ChatModelBase],
) -> WorkflowOutput:
    """Run team meeting to decide on feature launch"""
    
    # Assign models strategically
    agents = {
        "maya": ReActAgent(
            name="maya",
            sys_prompt=load_prompt_variant("maya", "v1"),
            model=model,  # ← Trainable (coordinators)
        ),
        "jonah": ReActAgent(
            name="jonah", 
            sys_prompt=load_prompt_variant("jonah", "v1"),
            model=model,  # ← Trainable (skeptics)
        ),
        "lina": ReActAgent(
            name="lina",
            sys_prompt=load_prompt_variant("lina", "v0"),
            model=auxiliary_models["frozen"],  # ← Frozen (research)
        ),
        "eli": ReActAgent(
            name="eli",
            sys_prompt=load_prompt_variant("eli", "v0"),
            model=auxiliary_models["frozen"],  # ← Frozen (builder)
        ),
    }
    
    # Run meeting
    meeting_result = await run_team_meeting(
        agents=agents,
        scenario=task["scenario"],
        rounds=5,
    )
    
    # Reward: Did team reach good decision?
    decision_quality = evaluate_decision(meeting_result)
    reached_consensus = meeting_result["consensus_reached"]
    
    reward = 0.0
    if reached_consensus and decision_quality > 0.7:
        reward = 1.0
    elif reached_consensus:
        reward = 0.7
    else:
        reward = 0.3
    
    return WorkflowOutput(
        reward=reward,
        metrics={
            "decision_quality": decision_quality,
            "consensus_reached": reached_consensus,
            "rounds_needed": meeting_result["rounds"],
        },
    )
```

**Step 2: Configure multi-agent tuning**

```python
from agentscope.tuner import tune, AlgorithmConfig

# Create team simulation dataset
team_dataset = DatasetConfig(
    path="team_scenarios.parquet",
    split="train",
)

# Trainable model (Maya + Jonah)
trainable_model = TunerModelConfig(
    model_path="meta-llama/Llama-2-13b-chat-hf",
    max_model_len=8192,
)

# Auxiliary models (Lina + Eli frozen)
auxiliary_models = {
    "frozen": TunerModelConfig(
        model_path="gpt-4-turbo",
        max_model_len=8192,
    ),
}

# RL tuning (GRPO - Group Relative Policy Optimization)
algorithm = AlgorithmConfig(
    algorithm_type="multi_step_grpo",
    group_size=16,      # Run 16 team meetings in parallel
    batch_size=8,       # Process 8 per update
    learning_rate=1e-6,
)

tune(
    workflow_func=team_simulation_workflow,
    judge_func=None,     # Reward from workflow (consensus + quality)
    train_dataset=team_dataset,
    model=trainable_model,
    auxiliary_models=auxiliary_models,
    algorithm=algorithm,
)
```

### Expected Outcome (Week 8)

```
Team Simulation (Maya v1 + Jonah v1 vs Lina v0 + Eli v0):

Before tuning:
  - Average decision quality: 0.62
  - Consensus rate: 60%
  - Rounds to consensus: 8

After multi-agent tuning:
  - Average decision quality: 0.78 (+25% ✅)
  - Consensus rate: 85%
  - Rounds to consensus: 5 (faster!)
  
Archive: team_sim_metrics_week8.json
```

---

## 🔀 Phase 3: Hyperagent Loop (Weeks 9+) — META-AGENT IMPROVEMENT

### The Metacognitive Layer

The meta-agent doesn't just improve agents—it improves *itself*.

```
Week 1: Meta-agent proposes prompt change
        └─ "Shorten responses" → Maya v1

Week 3: Meta-agent v0 has 60% accuracy
        (50% of suggestions actually help)
        
Week 4: Meta-Meta-Agent analyzes:
        "Your best suggestions use evidence-based reasoning.
         Focus there more."
        
Week 5: Meta-agent v1 created with better heuristics
        Now 75% accurate (↑25%)
        
Week 6: Agents improve FASTER because meta-agent improved!
```

### Implementation

```python
# meta_agent_improvement.py
class MetaAgentTuner:
    """Tunes the meta-agent's proposal generation process"""
    
    async def tune_meta_agent_prompts(self):
        """Use multi-agent tuning to improve meta-agent itself"""
        
        # Get historical data
        modifications = hive_mind_recall(
            tags=["meta_agent", "modification"],
            mode="insight",
        )
        
        # Extract: Which modifications actually helped?
        effective = [m for m in modifications 
                    if m["ab_test_winner"] == "variant"]
        
        # Analyze patterns in effective suggestions
        patterns = await self.meta_agent.analyze_patterns(effective)
        
        # Create new meta-agent prompt focusing on patterns
        improved_prompt = f"""
        You are a meta-agent that analyzes agent failures and proposes improvements.
        
        Based on analysis of 100 prior improvements, the most effective changes focus on:
        {patterns}
        
        When proposing modifications:
        1. Prioritize evidence-based reasoning improvements
        2. Target specific failure patterns (not generic changes)
        3. Include rollback conditions if change harms performance
        """
        
        # Tune the meta-agent prompt
        optimized, metrics = tune_prompt(
            workflow=self.meta_agent_workflow,
            init_system_prompt=improved_prompt,
            judge_func=self.meta_agent_judge,
            train_dataset=create_dataset_from_modifications(effective),
        )
        
        return optimized, metrics
```

---

## 📈 Integration with Your Evaluation System

Your Phase 1 (from earlier) creates evaluations. Here's how they feed the tuning loop:

```
Week 1: User rates Maya's response (⭐⭐⭐⭐)
        → Stored in archive/evaluations/
        
Week 2: Accumulate 50+ evaluations (mix of ⭐-⭐⭐⭐⭐⭐)
        
Week 3: Meta-agent analyzes patterns:
        "Low ratings when: task is complex + no evidence shown"
        "High ratings when: clear reasoning + options listed"
        
Week 3: Prompt tuning dataset created from these 50 evals
        `tune_prompt()` optimizes Maya's prompt
        
Week 4: New Maya variant tested against baseline
        A/B test on fresh 20 tasks
        
Week 5: If variant wins, promote to active
        Archive old version, track improvement (+8%)
```

### Code Integration Point

```python
# In your evaluation API (from Phase 1)
@app.post("/api/agents/evaluate")
async def evaluate_agent(req):
    # ... existing code saves evaluation ...
    
    # NEW: Check if we should trigger tuning
    eval_count = count_evaluations(agent_id)
    if eval_count % 50 == 0:  # Every 50 evals
        trigger_prompt_tuning(agent_id)

async def trigger_prompt_tuning(agent_id):
    """Asynchronously start prompt tuning"""
    
    # Get recent evaluations
    evals = hive_mind_recall(
        tags=[f"{agent_id}", "evaluation"],
        limit=50,
    )
    
    # Create tuning dataset
    dataset = create_tuning_dataset(evals)
    
    # Run tuning (non-blocking)
    task_id = schedule_tuning_job(
        agent_id=agent_id,
        dataset=dataset,
        optimization_level="medium",
    )
    
    return {"tuning_started": task_id}
```

---

## 🎮 Practical Workflow

### Week 1-3: Prompt Tuning
```bash
# For each employee
python tune_prompt_maya.py
python tune_prompt_jonah.py
python tune_prompt_lina.py
python tune_prompt_eli.py

# Creates: maya_v1, jonah_v1, lina_v1, eli_v1
```

### Week 4-8: Multi-Agent Tuning
```bash
# Train Maya + Jonah together
python tune_multi_agent_coordinators.py

# Then train Lina + Eli
python tune_multi_agent_builders.py

# Creates: improved team dynamics (↑25%)
```

### Week 9+: Hyperagent Loop
```bash
# Meta-agent improves itself
python tune_meta_agent.py

# Now system self-accelerates
# Agents improve → meta-agent improves → agents improve faster
```

---

## ⚙️ Hardware Requirements

| Phase | GPU Needed | Timeline | Cost |
|-------|-----------|----------|------|
| **1: Prompt Tuning** | 1 GPU (for teacher model) | 3 weeks | Low (~$100) |
| **2: Multi-Agent** | 2-3 GPUs (main + auxiliaries) | 4 weeks | Medium (~$500) |
| **3: Hyperagent** | 2 GPUs | 2+ weeks | Medium (~$300) |

**Quick start**: Start with prompt tuning on single GPU.

---

## 🎯 Success Metrics

### Phase 1 (Prompt Tuning)
- [ ] Each agent has v1 prompt
- [ ] v1 scores 10%+ higher than v0
- [ ] Prompt changes are interpretable (not random tokens)
- [ ] A/B test validates improvement on fresh tasks

### Phase 2 (Multi-Agent)
- [ ] Team reaches consensus 80%+ of time
- [ ] Decision quality scores 20%+ higher
- [ ] Meeting time reduced (fewer rounds)
- [ ] Interaction patterns show clear roles (not all agents saying same thing)

### Phase 3 (Hyperagent)
- [ ] Meta-agent accuracy 75%+
- [ ] Improvement rate accelerating (6% → 8% → 12%)
- [ ] System discovers novel agent patterns (not hand-coded)
- [ ] HIVE-MIND archive shows version lineage

---

## 🚀 Next Steps

1. **This week**: Review this strategy, gather GPU resources
2. **Week 1**: Implement Phase 1 prompt tuning for Maya (test case)
3. **Week 2-3**: Replicate for Jonah, Lina, Eli
4. **Week 4**: Start Phase 2 multi-agent training
5. **Week 9**: Launch hyperagent loop

---

## 📚 Reference

**AgentScope Docs Used:**
- Prompt Tuning: https://docs.agentscope.io/tune-agent/prompt-tuning
- Multi-Agent Tuning: https://docs.agentscope.io/tune-agent/tune-multi-agents
- Overview: https://docs.agentscope.io/tune-agent/tune-your-first-agent

**Your Previous Work:**
- DIGITAL_EMPLOYEES_IMPLEMENTATION.md (Phase 1 evaluation)
- HYPERAGENTS_CODEBASE_GUIDE.md (self-improvement architecture)
- HIVE-MIND Memory Integration

---

**Status**: Strategy complete, ready for Phase 1 implementation  
**Owner**: Implementation team  
**Next Review**: After Phase 1 prompt tuning results (Week 3)
