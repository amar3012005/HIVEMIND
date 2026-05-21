# Phase 1 Quick Start Guide

**Your System is Ready. Here's How to Launch It.**

---

## What You Have Now

✅ **Frontend** (Existing)
- Digital Employees UI at `/frontend/Da-vinci/src/components/hivemind/app/pages/DigitalEmployees.jsx`
- Evaluation form at `/api/agents/evaluate.js`
- Users rate responses 1-5 stars → stored in archive

✅ **Tuning Infrastructure** (Just Created)
- `autonomous_improvement_loop.py` — Main orchestrator (runs 24/7)
- `archive_manager.py` — Version control & lineage
- `task_generator.py` — Autonomous task creation (20+ scenarios per agent)
- `phase1_prompt_tuning.py` — AgentScope prompt optimizer (already existed)

✅ **Archive System** (Ready)
- `archive/evaluations/` — User feedback storage
- `archive/prompt_variants/` — Version history
- `archive/ab_test_results/` — Variant comparison results
- `archive/improvement_metrics.jsonl` — Tracking metrics

---

## Launch in 5 Minutes

### 1. Set Up Environment

```bash
cd /Users/amar/HIVE-MIND/tuning

# Install dependencies (one-time)
pip install agentscope openai aiohttp pydantic

# Set API keys
export OPENAI_API_KEY="sk-your-key-here"
export DASHSCOPE_API_KEY="sk-your-dashscope-key"
```

### 2. Start the Improvement Loop

```bash
# This runs forever, monitoring every hour
python autonomous_improvement_loop.py
```

That's it. The loop will:
- Check if any agent has 20+ evaluations
- Run prompt tuning for agents that do
- A/B test new variants
- Promote winners automatically
- Log everything to `improvement_loop.log`

### 3. Check Status (in another terminal)

```bash
# Watch logs in real-time
tail -f tuning/improvement_loop.log

# Or check agent metrics manually
python -c "
from archive_manager import compute_agent_metrics
for agent in ['maya', 'jonah', 'lina', 'eli']:
    m = compute_agent_metrics(agent)
    print(f'{agent}: {m[\"avg_score\"]:.1%} ({m[\"eval_count\"]} evals)')
"
```

---

## How Users Generate Evaluations

1. **Open Digital Employees UI** (wherever that's deployed)
2. **Run a team task** (e.g., "Should we launch with known bugs?")
3. **See agent responses** from Maya, Jonah, Lina, Eli
4. **Rate each response** with 1-5 stars (⭐⭐⭐⭐⭐)
5. **Add feedback** (optional): "too verbose", "missing key point", etc.
6. **Submit** → Goes to `/api/agents/evaluate` → Stored in archive

As evaluations accumulate:
- After 20 evals per agent → Tuning automatically triggers
- New variants created and tested
- Winners promoted, losers archived
- Improvement metrics updated

---

## What Happens Week by Week

### Week 1: Accumulation Phase
- Loop is running, checking hourly
- Users provide evaluations (10-15 per agent expected)
- Logs show "No tuning needed yet" because threshold not hit
- **Action:** Nothing — loop does all the work

### Week 2: First Tuning Wave
- First agent hits 20+ evals → Tuning triggers
- Prompt variant generated (5-10 min)
- A/B test starts (50 new tasks)
- **Expected output:** New variant in `archive/prompt_variants/`

### Week 3: Promotion & Scaling
- Winners promoted (+9-21% improvement each)
- All 4 agents have v1 variants
- Improvement metrics show upward trend
- **Result:** System demonstrably works

---

## Monitoring Dashboard (DIY)

Create a simple monitoring script:

```python
# save as monitor.py
import time
import json
from pathlib import Path
from archive_manager import compute_agent_metrics

while True:
    print("\n" + "="*70)
    print(f"DIGITAL EMPLOYEES IMPROVEMENT STATUS")
    print("="*70)
    
    for agent in ["maya", "jonah", "lina", "eli"]:
        metrics = compute_agent_metrics(agent)
        
        eval_pct = (metrics["eval_count"] / 20) * 100  # % to tuning trigger
        bar = "█" * int(eval_pct/5) + "░" * (20 - int(eval_pct/5))
        
        print(f"\n{agent.upper()}: {bar} {int(eval_pct)}%")
        print(f"  Score: {metrics['avg_score']:.1%}")
        print(f"  Evals: {metrics['eval_count']}/20 (tuning at 20)")
        print(f"  Improvement: {metrics['improvement_rate']+100:.0f}% (baseline)")
    
    print("\n" + "="*70)
    print(f"Last updated: {time.strftime('%Y-%m-%d %H:%M:%S')}")
    print("(Updates every 60s)")
    time.sleep(60)
```

Run it:
```bash
python monitor.py
```

---

## Files You Might Edit

### Fine-tune loop timing:

**`autonomous_improvement_loop.py`** line 28-33:
```python
LOOP_CONFIG = {
    "check_interval_hours": 1,      # ← Change for more/less frequent checks
    "eval_threshold": 20,            # ← Lower to trigger sooner
    "ab_test_size": 50,              # ← Smaller = faster tests, less confident
    ...
}
```

### Fine-tune scoring:

**`autonomous_improvement_loop.py`** line 250-300 (score_response_autonomously)
- Consistency checks for each agent role
- Completeness criteria checking
- Clarity analysis

### Adjust task diversity:

**`task_generator.py`** - Add more scenarios to MAYA_TASKS, JONAH_TASKS, etc.

---

## Troubleshooting

### "Loop keeps checking but never triggers tuning"

The eval threshold (20) probably hasn't been hit yet. Check:

```bash
# Count evaluations per agent
for agent in maya jonah lina eli; do
  count=$(wc -l < archive/evaluations/${agent}_evals.jsonl 2>/dev/null || echo 0)
  echo "$agent: $count evals"
done
```

If counts are < 20, keep collecting evaluations. This is normal.

### "Tuning triggered but A/B test failed"

Check API access:

```bash
python -c "
from agentscope.model import OpenAIChatModel
m = OpenAIChatModel(model_name='gpt-4-turbo')
print('API OK')
" 2>&1
```

If error, verify:
- `echo $OPENAI_API_KEY` is set
- API key is valid at https://platform.openai.com/api-keys
- You have quota (check usage)

### "New variant exists but wasn't promoted"

Check the A/B test result:

```bash
# Find latest result
ls -t archive/ab_test_results/ | head -1 | xargs -I {} cat archive/ab_test_results/{}
```

Look for `"winner"` field. If "baseline", variant didn't improve enough (>3% + score >0.65).

### Loop crashes or gets stuck

Check logs:
```bash
tail -100 tuning/improvement_loop.log | grep -i error
```

Common issues:
- OpenAI API rate limit → increase sleep time
- Disk full → clean old archives
- Memory leak → restart loop weekly

Restart:
```bash
# Kill old process
pkill -f autonomous_improvement_loop

# Start fresh
python autonomous_improvement_loop.py
```

---

## Success Indicators

✅ **Week 1**
- Loop runs without errors (check logs)
- Hourly "checking..." messages in log
- No tuning triggered yet (normal)

✅ **Week 2**
- First tuning job completes ("✅ Tuning complete")
- New variant files appear in `archive/prompt_variants/`
- A/B test runs for 50 tasks
- Winner or loser decision logged

✅ **Week 3**
- 4 agents all have v1 variants
- At least 1 winner promoted
- Improvement % positive for most agents
- Logs show acceleration building

---

## Next: Phase 2

Once Phase 1 is stable (all agents have v1, improvements validated):

1. **Gather team scenarios** - Real decision tasks teams face
2. **Run Phase 2 tuning** - Multi-agent coordination optimization
3. **Expected gain** - +25% consensus rate, fewer rounds to decision

See `PHASE1_IMPLEMENTATION.md` for full Phase 2 roadmap.

---

## Commands Cheat Sheet

```bash
# Start the loop
python autonomous_improvement_loop.py

# Monitor logs
tail -f tuning/improvement_loop.log

# Check agent metrics
python archive_manager.py

# View lineage for an agent
python -c "from archive_manager import print_lineage_report; print_lineage_report('maya')"

# List all variants
ls -la archive/prompt_variants/

# List all A/B test results
ls -la archive/ab_test_results/

# Export metrics report
python -c "from archive_manager import export_metrics_report; export_metrics_report()"

# Generate test tasks
python -c "from task_generator import generate_batch_tasks; tasks = generate_batch_tasks('maya', 10); [print(t.scenario) for t in tasks]"
```

---

## You're All Set!

The system is ready to run. Start the loop, let evaluations accumulate, and watch the magic happen.

**Questions?** Check `PHASE1_IMPLEMENTATION.md` for detailed docs.

---

**Created**: 2026-05-16  
**Status**: Ready for Phase 1 execution  
**Estimated Timeline**: 3 weeks to first improvements
