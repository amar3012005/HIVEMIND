# Phase 1 Implementation: Autonomous Prompt Tuning

**Status**: READY FOR EXECUTION  
**Timeline**: Weeks 1-3  
**Expected Improvement**: +9% to +21% per agent  
**Hardware**: 1 GPU recommended (for gpt-4-turbo inference)

---

## Overview

Phase 1 consists of two parallel streams:

1. **Continuous Evaluation Collection** (from frontend)
   - Users rate agent responses (1-5 stars) → API stores evaluations
   - Archive grows: `archive/evaluations/{agent_id}_evals.jsonl`

2. **Autonomous Improvement Loop** (24/7 background process)
   - Detects when 20+ evaluations accumulated
   - Runs prompt tuning on accumulated data
   - A/B tests variant against baseline
   - Promotes winner or archives variant
   - Tracks improvement metrics

---

## Architecture

```
Frontend (DigitalEmployees.jsx)
  ↓
  ├─ Runs agents with current prompts
  ├─ User rates responses 1-5 stars
  └─ POST /api/agents/evaluate
       ↓
       Archive (evaluation storage)
       ├─ evaluations/{agent_id}_evals.jsonl
       └─ evaluations/{agent_id}.json (individual)
            ↓
            Continuous monitoring
            ↓
Background Process: autonomous_improvement_loop.py (hourly check)
  │
  ├─ Check: Does agent have 20+ evals?
  │
  └─ YES → Trigger prompt tuning
       ├─ phase1_prompt_tuning.py runs (uses AgentScope)
       │  └─ Reads evaluations → Creates training dataset
       │  └─ Optimizes system prompt via LLM analysis
       │  └─ Saves result to archive/prompt_variants/
       │
       ├─ A/B Test (50 tasks)
       │  ├─ Run baseline (current prompt)
       │  ├─ Run variant (new prompt)
       │  ├─ Score autonomously (consistency/completeness/clarity)
       │  └─ Compare: variant wins if >3% improvement + score >0.65
       │
       ├─ Promote or Archive
       │  ├─ Winner → marked as active in archive
       │  └─ Loser → archived with metadata
       │
       └─ Track Metrics
          └─ Save to archive/improvement_metrics.jsonl
             ├─ baseline_score
             ├─ variant_score
             ├─ improvement_pct
             └─ week_over_week_acceleration
```

---

## Files Created

### Core Execution

| File | Purpose |
|------|---------|
| `phase1_prompt_tuning.py` | AgentScope integration; optimizes individual agent prompts |
| `autonomous_improvement_loop.py` | Main orchestrator; monitors, triggers tuning, A/B tests |
| `archive_manager.py` | Version control; lineage tracking; metrics aggregation |
| `task_generator.py` | Creates 20+ autonomous decision scenarios per agent |

### Supporting

| File | Purpose |
|------|---------|
| `PHASE1_IMPLEMENTATION.md` | This file; execution guide |
| `SELF_IMPROVING_AGENTS_README.md` | High-level vision and concepts |

### Existing (Already Created)

| File | Purpose |
|------|---------|
| `api/agents/evaluate.js` | Stores user ratings → archive (EXISTING) |
| `frontend/DigitalEmployees.jsx` | UI for rating responses (EXISTING) |

---

## Getting Started

### Step 1: Verify Dependencies

```bash
cd /Users/amar/HIVE-MIND/tuning

# Check Python version (3.9+)
python --version

# Check required packages
pip list | grep -E "agentscope|openai|aiohttp"

# Install if missing
pip install agentscope openai aiohttp pydantic
```

### Step 2: Set Environment Variables

```bash
export OPENAI_API_KEY="sk-..."
export DASHSCOPE_API_KEY="sk-..."  # For qwen-max teacher model

# Verify
echo $OPENAI_API_KEY
```

### Step 3: Start the Improvement Loop

```bash
# Terminal 1: Run the main loop
python autonomous_improvement_loop.py

# This will:
# - Check every 1 hour if agents need tuning
# - Run prompt tuning for agents with 20+ evals
# - A/B test variants
# - Promote winners
# - Log to improvement_loop.log and stdout
```

### Step 4: Monitor Progress

```bash
# Terminal 2: Watch improvement metrics
watch -n 60 'tail -20 tuning/improvement_loop.log'

# Or in Python:
python
>>> from archive_manager import compute_agent_metrics
>>> for agent in ["maya", "jonah", "lina", "eli"]:
...     m = compute_agent_metrics(agent)
...     print(f"{agent}: {m['avg_score']:.3f} ({m['eval_count']} evals)")
```

### Step 5: Collect Evaluations (Frontend)

Users will naturally collect evaluations through the UI:

1. Digital Employees page: Run team task
2. Get response from each agent
3. Rate each response (1-5 stars)
4. Provide feedback: "too verbose", "missed key point", etc.
5. Submit → API stores evaluation

Each evaluation triggers a check: "Does agent now have 20+ evals?"

---

## Expected Timeline

### Week 1
- [ ] Evaluations accumulate (10-15 per agent as users try it)
- [ ] Loop running, monitoring every hour
- [ ] Log entries confirm loop is alive

### Week 2
- [ ] First agent hits 20+ evals → Tuning triggers
- [ ] Prompt tuning runs (5-10 min per agent)
- [ ] A/B test starts (50 tasks × 2 prompts)
- [ ] Results: First variant generated

### Week 3
- [ ] Evaluations spike (users actively rating)
- [ ] All 4 agents have v1 variants
- [ ] Winners promoted: expect +9-21% improvement
- [ ] Acceleration detected: improvement rate climbing

### Expected Metrics (End of Week 3)

```
Maya:
  v0 baseline: 0.62
  v1 variant:  0.74 (+19%)
  Winner: v1 → PROMOTED
  Evals collected: 45

Jonah:
  v0 baseline: 0.65
  v1 variant:  0.71 (+9%)
  Winner: v1 → PROMOTED
  Evals collected: 38

Lina:
  v0 baseline: 0.68
  v1 variant:  0.80 (+18%)
  Winner: v1 → PROMOTED
  Evals collected: 52

Eli:
  v0 baseline: 0.66
  v1 variant:  0.75 (+14%)
  Winner: v1 → PROMOTED
  Evals collected: 41

AGGREGATE IMPROVEMENT: +15% across all agents
```

---

## Checking Progress

### View Agent Metrics

```python
from archive_manager import compute_agent_metrics

for agent in ["maya", "jonah", "lina", "eli"]:
    metrics = compute_agent_metrics(agent)
    print(f"{agent}: {metrics['avg_score']:.1%} (evals: {metrics['eval_count']})")
```

### View Prompt Lineage

```python
from archive_manager import print_lineage_report

for agent in ["maya", "jonah", "lina", "eli"]:
    print_lineage_report(agent)
```

### View A/B Test Results

```bash
# List all A/B test results
ls -la archive/ab_test_results/

# View latest result
cat archive/ab_test_results/$(ls -t archive/ab_test_results/ | head -1)
```

### View Improvement Loop Logs

```bash
# Live tail
tail -f tuning/improvement_loop.log

# Last 50 lines
tail -50 tuning/improvement_loop.log

# Search for a specific agent
grep "maya" tuning/improvement_loop.log | tail -20
```

---

## Key Configuration (autonomous_improvement_loop.py)

Adjust these if needed:

```python
LOOP_CONFIG = {
    "check_interval_hours": 1,      # How often to check for tuning need
    "eval_threshold": 20,            # Evals needed before tuning triggers
    "ab_test_size": 50,              # Tasks to validate variant
    "max_concurrent_agents": 4,      # Parallel execution
    "archive_retention_days": 90,    # Keep old versions for 90 days
}
```

---

## Troubleshooting

### Loop Not Starting

```bash
# Check logs
cat tuning/improvement_loop.log

# Verify env vars
echo $OPENAI_API_KEY | head -c 10

# Ensure archive directory exists
mkdir -p archive/{evaluations,prompt_variants,ab_test_results}
```

### Tuning Not Triggering

```bash
# Check eval count
ls -la archive/evaluations/*_evals.jsonl
wc -l archive/evaluations/maya_evals.jsonl

# Manually trigger for testing
python
>>> from autonomous_improvement_loop import should_trigger_tuning
>>> should_trigger_tuning("maya")  # Check if threshold met
```

### A/B Test Failing

```bash
# Check model access
python
>>> from agentscope.model import OpenAIChatModel
>>> m = OpenAIChatModel(model_name="gpt-4-turbo")
>>> print(m)  # Should not error

# If 401/403: verify API key
export OPENAI_API_KEY="sk-..."
```

### Variant Not Being Promoted

Check the A/B test result:

```bash
cat archive/ab_test_results/$(ls -t archive/ab_test_results/ | head -1) | jq .

# Look for:
# - "baseline_score": 0.62
# - "variant_score": 0.65
# - "improvement_pct": 4.8
# - "winner": "variant" or "baseline"
```

---

## Next Steps After Phase 1

Once all agents have v1 variants and improvements are stable:

1. **Phase 2 Preparation**: Collect team simulation scenarios
2. **Phase 2 Launch** (Week 4): Multi-agent coordination tuning
   - Train agents to work better *together*
   - Expected: +25% team consensus, -60% rounds to decision

3. **Phase 3 Prep**: Build meta-agent failure analyzer
4. **Phase 3 Launch** (Week 9): Hyperagent self-improvement loop

---

## Success Criteria

✅ **Phase 1 Complete When:**

- [ ] All 4 agents have v1 prompt variants
- [ ] v1 scores 10%+ higher than v0 on A/B tests
- [ ] Improvements validated on fresh task set
- [ ] Archive shows clean lineage: v0 → v1 → (archival or v2)
- [ ] Improvement rate is trending up week-over-week
- [ ] Loop runs 24/7 without errors
- [ ] Total engineering effort: ~40 hours (monitoring, not development)

---

## Contact / Escalation

If loop crashes or gets stuck:

1. Check `improvement_loop.log` for stack trace
2. Verify OpenAI API quota and key validity
3. Check disk space in `/Users/amar/HIVE-MIND/archive`
4. Restart the loop process
5. Escalate if persistent errors

---

**Last Updated**: 2026-05-16  
**Next Review**: After Phase 1 results (2026-05-30)
