# Digital Employees Implementation Guide
## From Research to Runnable Code

---

## Quick Reference: What Each Component Does

| Component | Purpose | Status | Priority |
|-----------|---------|--------|----------|
| **Agent Evaluation** | Score employee responses | ❌ Missing | HIGH |
| **Archive System** | Store all agent versions | ❌ Missing | HIGH |
| **Meta-Agent** | Analyze & propose improvements | ❌ Missing | HIGH |
| **A/B Testing** | Validate improvements work | ❌ Missing | HIGH |
| **Hyperagent Loop** | Self-referential improvement | ❌ Missing | MED |
| **Peer Review** | Cross-agent feedback | ⚠️ Partial | MED |
| **Memory Integration** | Connect to HIVE-MIND | ⚠️ Partial | MED |

---

## Phase 1: Evaluation System (Week 1)

### Step 1.1: Add Evaluation Form to UI

```jsx
// In EmployeeChatPreview.jsx - add after message display

function EvaluationPanel({ messageId, onSubmit }) {
  const [score, setScore] = useState(null);
  const [feedback, setFeedback] = useState('');
  
  return (
    <div className="border-t border-[#e3e0db] p-4 mt-4">
      <p className="text-xs font-semibold mb-2">Rate this response</p>
      
      <div className="grid grid-cols-4 gap-2 mb-3">
        {[
          { score: 0.9, label: '😊 Excellent', color: '#16a34a' },
          { score: 0.7, label: '👍 Good', color: '#3b82f6' },
          { score: 0.5, label: '🤷 Okay', color: '#f59e0b' },
          { score: 0.2, label: '👎 Needs work', color: '#dc2626' }
        ].map(({ score: s, label, color }) => (
          <button
            key={s}
            onClick={() => setScore(s)}
            className={`p-2 rounded text-xs font-medium transition-all ${
              score === s 
                ? 'ring-2 ring-offset-2 ring-blue-500' 
                : 'border border-[#e3e0db]'
            }`}
            style={score === s ? { borderColor: color, color } : {}}
          >
            {label}
          </button>
        ))}
      </div>
      
      <textarea
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        placeholder="Why this score? What would improve it?"
        rows={2}
        className="w-full p-2 border border-[#e3e0db] rounded text-xs mb-2"
      />
      
      <button
        onClick={() => onSubmit({ score, feedback, messageId })}
        className="px-3 py-1.5 bg-blue-500 text-white text-xs rounded hover:bg-blue-600"
        disabled={score === null}
      >
        Submit Evaluation
      </button>
    </div>
  );
}

// In EmployeeChatPreview, add:
const handleEvaluate = async (evaluation) => {
  const lastMessage = messages[messages.length - 2]; // Last assistant message
  
  await apiClient.evaluateResponse(employee.slug, {
    message_id: lastMessage.id,
    score: evaluation.score,
    feedback: evaluation.feedback,
    timestamp: new Date().toISOString(),
  });
  
  // Show confirmation
  setMessages(prev => [...prev, {
    id: 'eval-' + Date.now(),
    role: 'system',
    content: 'Evaluation recorded. Thanks for the feedback!',
  }]);
};
```

### Step 1.2: Backend API Endpoint

```python
# api/employees.py

from fastapi import APIRouter, HTTPException
from typing import Optional

router = APIRouter(prefix="/employees", tags=["employees"])

@router.post("/{slug}/evaluate")
async def evaluate_response(
    slug: str,
    message_id: str,
    score: float,  # 0-1
    feedback: str,
    timestamp: str,
    current_user,
):
    """Store evaluation for an employee's response"""
    
    # Get employee version
    employee = await get_employee(slug)
    if not employee:
        raise HTTPException(status_code=404, detail="Employee not found")
    
    # Store evaluation
    evaluation = {
        "version": f"{slug}-v{employee.version}",
        "message_id": message_id,
        "task_id": "chat",  # or extract from context
        "timestamp": timestamp,
        "relevance_score": score * 0.7,      # Rough conversion
        "clarity_score": score * 0.8,
        "efficiency_score": score * 0.6,
        "correctness_score": score * 0.9,
        "overall_score": score,
        "human_feedback": feedback,
        "helpful": score >= 0.7,
        "revision_needed": score < 0.7,
        "tool_usage": [],  # Extract from message metadata
        "tokens_used": 0,  # Extract from response
        "response_time_ms": 0,  # From message timestamp
    }
    
    # Save to database
    await db.agent_evaluations.insert(evaluation)
    
    # Update employee metrics
    await update_employee_metrics(slug, evaluation)
    
    return {"status": "evaluated", "score": score}

async def update_employee_metrics(slug: str, evaluation: dict):
    """Update employee's running performance stats"""
    
    employee = await get_employee(slug)
    
    # Add to evaluations list
    if not employee.get("metrics_all_time"):
        employee["metrics_all_time"] = {"evaluations": []}
    
    employee["metrics_all_time"]["evaluations"].append(evaluation["overall_score"])
    
    # Calculate new average
    scores = employee["metrics_all_time"]["evaluations"]
    employee["metrics_all_time"]["avg_score"] = sum(scores) / len(scores)
    employee["metrics_all_time"]["best_score"] = max(scores)
    
    # Save back
    await update_employee(slug, employee)
```

### Step 1.3: Display Performance History

```jsx
// EmployeeCard.jsx - add performance sparkline

function PerformanceSparkline({ scores }) {
  if (!scores || scores.length < 2) return null;
  
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const range = max - min || 1;
  
  return (
    <div className="flex items-end gap-1 h-6">
      {scores.slice(-10).map((score, i) => {
        const height = ((score - min) / range) * 100;
        return (
          <div
            key={i}
            className="flex-1 bg-blue-300 rounded-t opacity-70 hover:opacity-100"
            style={{ height: `${Math.max(height, 10)}%` }}
            title={`${(score * 100).toFixed(0)}%`}
          />
        );
      })}
    </div>
  );
}
```

---

## Phase 2: Meta-Agent (Week 2-3)

### Step 2.1: Implement MetaAgent Class

```python
# services/meta_agent.py

from anthropic import Anthropic
from datetime import datetime, timedelta

class MetaAgent:
    def __init__(self, llm_client):
        self.client = llm_client
        self.model = "claude-3-5-sonnet-20241022"
    
    async def analyze_failures(self, employee: dict, look_back_days: int = 7):
        """Identify failure patterns in recent evaluations"""
        
        # Get recent evaluations
        recent_evals = await db.agent_evaluations.find({
            "version": f"{employee['slug']}-v{employee.get('version', 0)}",
            "timestamp": {"$gte": datetime.now() - timedelta(days=look_back_days)}
        }).to_list(length=None)
        
        if not recent_evals:
            return {"pattern": "no_recent_data", "insights": []}
        
        # Find low-scoring evaluations
        failures = [e for e in recent_evals if e["overall_score"] < 0.7]
        
        if not failures:
            return {"pattern": "strong_performance", "insights": []}
        
        # Analyze with LLM
        analysis_prompt = f"""
        Employee: {employee['name']} ({employee['slug']})
        Persona: {employee['persona']}
        Current Tools: {', '.join(employee['tools'])}
        
        Recent failures (score < 0.7):
        {json.dumps([
            {
                "feedback": f['human_feedback'],
                "score": f['overall_score'],
                "timestamp": f['timestamp']
            }
            for f in failures
        ], indent=2)}
        
        Identify 2-3 patterns in these failures.
        For each pattern, suggest what aspect of the agent could be improved.
        
        Format:
        PATTERN 1: [description]
        IMPROVEMENT: [what to change]
        CONFIDENCE: [high/medium/low]
        
        PATTERN 2: ...
        """
        
        response = self.client.messages.create(
            model=self.model,
            max_tokens=500,
            messages=[{"role": "user", "content": analysis_prompt}]
        )
        
        return {
            "pattern": "identified",
            "analysis": response.content[0].text,
            "failure_count": len(failures),
            "avg_score": sum(f["overall_score"] for f in failures) / len(failures),
        }
    
    async def propose_modifications(self, employee: dict, analysis: dict):
        """Generate specific modifications to improve agent"""
        
        prompt = f"""
        Employee: {employee['name']}
        Current Version: {employee['version']}
        
        Analysis of recent failures:
        {analysis['analysis']}
        
        Current persona: {employee['persona'][:200]}...
        Current tools: {', '.join(employee['tools'])}
        
        Based on the failure patterns, propose specific modifications:
        
        1. If persona needs change:
           PERSONA_CHANGE: [new persona or modification]
        
        2. If tools need change:
           ADD_TOOLS: [tool1, tool2]
           REMOVE_TOOLS: [tool1]
        
        3. If constraints needed:
           CONSTRAINT: [new rule, e.g., "Keep response under 200 words"]
        
        4. Rationale:
           WHY: [explain reasoning]
        
        Be specific and actionable.
        """
        
        response = self.client.messages.create(
            model=self.model,
            max_tokens=800,
            messages=[{"role": "user", "content": prompt}]
        )
        
        return {
            "proposed_changes": response.content[0].text,
            "generated_at": datetime.now().isoformat(),
        }

# Usage:
async def trigger_self_improvement(employee: dict):
    """Run meta-agent improvement cycle"""
    
    meta_agent = MetaAgent(anthropic_client)
    
    # Step 1: Analyze failures
    analysis = await meta_agent.analyze_failures(employee)
    
    if analysis["pattern"] == "no_recent_data":
        return {"status": "skipped", "reason": "not enough data"}
    
    if analysis["pattern"] == "strong_performance":
        return {"status": "skipped", "reason": "performing well"}
    
    # Step 2: Propose modifications
    modifications = await meta_agent.propose_modifications(employee, analysis)
    
    # Step 3: Create variant
    new_version = employee["version"] + 1
    new_employee = {
        **employee,
        "version": new_version,
        "parent_version": employee["version"],
        "modification_history": [
            *(employee.get("modification_history", [])),
            {
                "from_v": employee["version"],
                "to_v": new_version,
                "proposal": modifications["proposed_changes"],
                "created_at": datetime.now().isoformat(),
            }
        ]
    }
    
    # Store in archive
    await db.employee_archive.insert({
        "version": f"{employee['slug']}-v{new_version}",
        "slug": employee['slug'],
        "persona": new_employee.get("persona"),
        "tools": new_employee.get("tools"),
        "parent_version": f"{employee['slug']}-v{employee['version']}",
        "modification_rationale": modifications["proposed_changes"],
        "created_at": datetime.now().isoformat(),
    })
    
    # Save as active version
    await update_employee(employee["slug"], new_employee)
    
    return {
        "status": "created",
        "new_version": new_version,
        "modifications": modifications,
    }
```

### Step 2.2: A/B Testing Handler

```python
# services/ab_testing.py

async def test_variant(baseline_employee: dict, variant_employee: dict, test_tasks: list):
    """Run A/B test: baseline vs. improved variant"""
    
    results = {
        "baseline": {"version": f"{baseline_employee['slug']}-v{baseline_employee['version']}", "scores": []},
        "variant": {"version": f"{variant_employee['slug']}-v{variant_employee['version']}", "scores": []},
        "test_date": datetime.now().isoformat(),
    }
    
    for task in test_tasks:
        # Run baseline
        baseline_response = await run_employee_task(baseline_employee, task)
        baseline_score = await score_response(baseline_response, task)
        results["baseline"]["scores"].append(baseline_score)
        
        # Run variant
        variant_response = await run_employee_task(variant_employee, task)
        variant_score = await score_response(variant_response, task)
        results["variant"]["scores"].append(variant_score)
    
    # Calculate statistics
    baseline_avg = sum(results["baseline"]["scores"]) / len(results["baseline"]["scores"])
    variant_avg = sum(results["variant"]["scores"]) / len(results["variant"]["scores"])
    
    improvement_pct = ((variant_avg - baseline_avg) / baseline_avg) * 100 if baseline_avg > 0 else 0
    
    # Decide: keep variant if >5% improvement
    should_keep = improvement_pct > 5
    
    results["summary"] = {
        "baseline_avg": baseline_avg,
        "variant_avg": variant_avg,
        "improvement_pct": improvement_pct,
        "should_keep": should_keep,
        "confidence": "high" if abs(improvement_pct) > 10 else "medium",
    }
    
    # If good, commit variant
    if should_keep:
        await promote_variant(variant_employee)
    else:
        await archive_variant_as_failed(variant_employee)
    
    return results

async def promote_variant(variant_employee: dict):
    """Promote variant to active status"""
    await update_employee(variant_employee["slug"], variant_employee)

async def archive_variant_as_failed(variant_employee: dict):
    """Keep in archive but mark as unsuccessful"""
    await db.employee_archive.update_one(
        {"version": f"{variant_employee['slug']}-v{variant_employee['version']}"},
        {"$set": {"status": "tested_unsuccessful"}}
    )
```

---

## Phase 3: Hyperagent Loop (Week 4-5)

### Step 3.1: MetaMetaAgent

```python
# services/meta_meta_agent.py

class MetaMetaAgent:
    """Analyzes and improves the meta-agent itself"""
    
    def __init__(self, llm_client):
        self.client = llm_client
    
    async def evaluate_meta_agent_quality(self, employee_slug: str):
        """Score how good the meta-agent's suggestions are"""
        
        # Get meta-agent history
        modifications = await db.meta_agent_modifications.find({
            "source_version": f"{employee_slug}-*"
        }).to_list(length=None)
        
        if not modifications:
            return {"quality": "unknown", "suggestions_count": 0}
        
        # Count: which suggestions led to improvement?
        successful = sum(1 for m in modifications if m.get("actual_improvement", 0) > 0.05)
        total = len(modifications)
        
        accuracy = successful / total if total > 0 else 0
        
        return {
            "quality": "high" if accuracy > 0.7 else "medium" if accuracy > 0.4 else "low",
            "accuracy": accuracy,
            "suggestions_count": total,
            "successful_suggestions": successful,
            "failure_patterns": self._identify_failure_patterns(modifications),
        }
    
    async def improve_meta_agent_approach(self, employee_slug: str):
        """Propose improvements to how meta-agent analyzes failures"""
        
        quality = await self.evaluate_meta_agent_quality(employee_slug)
        
        prompt = f"""
        Meta-agent performance for {employee_slug}:
        - Suggestion accuracy: {quality['accuracy']:.1%}
        - Weak areas: {quality.get('failure_patterns', [])}
        
        The meta-agent currently:
        1. Identifies failure patterns
        2. Proposes specific modifications
        3. Uses LLM to generate changes
        
        How should we improve the PROCESS of generating modifications?
        
        Suggestions might include:
        - Different failure analysis approach
        - Weight certain patterns more heavily
        - Add constraint checking before proposing changes
        - Use ensemble of analysis methods
        - Incorporate peer feedback into analysis
        
        Propose 1-2 specific improvements.
        """
        
        response = self.client.messages.create(
            model="claude-3-5-sonnet-20241022",
            max_tokens=400,
            messages=[{"role": "user", "content": prompt}]
        )
        
        return {
            "meta_improvements": response.content[0].text,
            "target": "meta_agent_approach",
            "current_accuracy": quality["accuracy"],
        }
    
    def _identify_failure_patterns(self, modifications: list) -> list:
        """Find patterns in unsuccessful suggestions"""
        patterns = []
        
        failed = [m for m in modifications if m.get("actual_improvement", 0) <= 0.05]
        
        if failed:
            # Group by modification type
            by_type = {}
            for f in failed:
                t = f.get("modification_type", "unknown")
                by_type[t] = by_type.get(t, 0) + 1
            
            # Find worst type
            worst_type = max(by_type, key=by_type.get)
            patterns.append(f"{worst_type} changes often fail ({by_type[worst_type]} failures)")
        
        return patterns
```

### Step 3.2: Self-Accelerating Progress Tracking

```python
# services/progress_tracker.py

class ProgressTracker:
    """Track if improvement trajectory is accelerating"""
    
    async def get_trajectory(self, employee_slug: str):
        """Get performance trend over versions"""
        
        # Get all versions
        versions = await db.employee_archive.find({
            "slug": employee_slug
        }).sort("created_at", 1).to_list(length=None)
        
        if len(versions) < 2:
            return {"status": "not_enough_data", "versions": len(versions)}
        
        # Get average score per version
        trajectory = []
        for v in versions:
            evals = await db.agent_evaluations.find({
                "version": v["version"]
            }).to_list(length=None)
            
            if evals:
                avg = sum(e["overall_score"] for e in evals) / len(evals)
                trajectory.append({
                    "version": v["version"],
                    "avg_score": avg,
                    "eval_count": len(evals),
                })
        
        if len(trajectory) < 2:
            return {"status": "insufficient_evaluations"}
        
        # Calculate improvement rate
        improvements = []
        for i in range(1, len(trajectory)):
            delta = trajectory[i]["avg_score"] - trajectory[i-1]["avg_score"]
            improvements.append(delta)
        
        # Check if accelerating
        avg_first_half = sum(improvements[:len(improvements)//2]) / max(1, len(improvements)//2)
        avg_second_half = sum(improvements[len(improvements)//2:]) / max(1, len(improvements) - len(improvements)//2)
        
        accelerating = avg_second_half > avg_first_half
        
        return {
            "versions_count": len(trajectory),
            "trajectory": trajectory,
            "improvements": improvements,
            "avg_improvement_rate": sum(improvements) / len(improvements),
            "accelerating": accelerating,
            "acceleration_factor": avg_second_half / avg_first_half if avg_first_half > 0 else 0,
        }
    
    async def check_self_improving_badge(self, employee_slug: str) -> bool:
        """Should we show the 'Self-Improving' badge?"""
        
        trajectory = await self.get_trajectory(employee_slug)
        
        if trajectory["versions_count"] < 2:
            return False
        
        # Multiple versions + improving
        return any(i > 0.02 for i in trajectory.get("improvements", []))
    
    async def check_accelerating_badge(self, employee_slug: str) -> bool:
        """Should we show the 'Accelerating' badge?"""
        
        trajectory = await self.get_trajectory(employee_slug)
        
        return trajectory.get("accelerating", False)
```

---

## Phase 4: UI Updates (Week 5-6)

### Update EmployeeCard with Badges

```jsx
// EmployeeCard.jsx

function EmployeeBadges({ employee }) {
  return (
    <div className="flex gap-2 items-center">
      {employee.version > 0 && (
        <span className="px-2 py-1 bg-blue-100 text-blue-700 text-xs rounded-full flex items-center gap-1">
          📈 Gen {employee.version}
        </span>
      )}
      
      {employee.is_self_improving && (
        <span className="px-2 py-1 bg-green-100 text-green-700 text-xs rounded-full flex items-center gap-1">
          🤖 Self-Improving
        </span>
      )}
      
      {employee.accelerating && (
        <span className="px-2 py-1 bg-purple-100 text-purple-700 text-xs rounded-full flex items-center gap-1">
          🚀 Accelerating
        </span>
      )}
    </div>
  );
}
```

### Create Performance Dashboard

```jsx
// PerformanceDashboard.jsx

function PerformanceDashboard({ employee }) {
  const [trajectory, setTrajectory] = useState(null);
  
  useEffect(() => {
    async function loadData() {
      const data = await apiClient.getTrajectory(employee.slug);
      setTrajectory(data);
    }
    loadData();
  }, [employee.slug]);
  
  if (!trajectory) return <div>Loading...</div>;
  
  return (
    <div className="space-y-4">
      <h3 className="font-semibold">{employee.name} Performance Trajectory</h3>
      
      {/* Score over time */}
      <LineChart
        data={trajectory.trajectory}
        xKey="version"
        yKey="avg_score"
        title="Score per Version"
      />
      
      {/* Improvement rate */}
      <BarChart
        data={trajectory.improvements.map((imp, i) => ({
          version: i,
          improvement: imp
        }))}
        title="Improvement per Generation"
      />
      
      {/* Acceleration indicator */}
      {trajectory.accelerating && (
        <div className="p-3 bg-green-50 border border-green-200 rounded">
          <p className="text-sm font-semibold text-green-900">
            🚀 Accelerating! (Factor: {trajectory.acceleration_factor.toFixed(2)}x)
          </p>
          <p className="text-xs text-green-700">
            Improvements getting bigger each generation
          </p>
        </div>
      )}
      
      {/* Modification history */}
      <div className="space-y-2">
        <p className="text-sm font-semibold">Improvements Applied</p>
        {employee.modification_history?.map((mod, i) => (
          <div key={i} className="text-xs p-2 border rounded bg-gray-50">
            <p className="font-medium">v{mod.from_v} → v{mod.to_v}</p>
            <p className="text-gray-600">{mod.change}</p>
            <p className="text-green-700">+{(mod.improvement * 100).toFixed(1)}%</p>
          </div>
        ))}
      </div>
    </div>
  );
}
```

---

## Testing Checklist

```
Phase 1: Evaluation
[ ] Can submit evaluation via UI
[ ] Evaluations stored in DB
[ ] Scores displayed on EmployeeCard
[ ] Performance history visible

Phase 2: Meta-Agent
[ ] Meta-agent analyzes failures
[ ] Generates modification proposals
[ ] Creates new variants
[ ] A/B test runs and compares
[ ] Wins promoted, losses archived

Phase 3: Hyperagent
[ ] MetaMetaAgent evaluates meta-agent quality
[ ] Proposes improvements to improvement process
[ ] Trajectories show acceleration

Phase 4: UI
[ ] Badges show correctly
[ ] Dashboard renders
[ ] Performance charts update
[ ] Archive browser works
```

---

## Deployment Order

1. **Week 1**: Evaluation system → get feedback loop working
2. **Week 2-3**: Meta-agent → generate variants
3. **Week 3**: A/B testing → validate improvements
4. **Week 4-5**: Hyperagent → improve the improvement process
5. **Week 5-6**: UI enhancements → visualize progress

---

## Success Signals

✅ **Week 1**: Users can rate employee responses  
✅ **Week 2**: System generates >1 improvement per employee  
✅ **Week 3**: 50%+ of improvements show gains in A/B tests  
✅ **Week 4**: Agents reach v2-v3 with measurable improvement  
✅ **Week 5**: First "accelerating" badge appears  
✅ **Week 6**: Team simulations show synergistic improvement across agents  

