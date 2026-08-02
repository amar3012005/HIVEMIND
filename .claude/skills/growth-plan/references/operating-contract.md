# Growth Operating Contract

Use these headings in order. Omit empty optional sections; do not invent data to fill them.

## Current Position
- **Global goal:**
- **Observed constraint:**
- **Evidence:** source/resource IDs and dated observations.
- **Unknowns:** evidence needed before a higher-risk action.

## Growth Thesis

For each hypothesis:
- **Hypothesis:**
- **Confidence:** low, medium, or high.
- **Evidence:**
- **Expected signal:**
- **Falsified when:**

## Current Stage
- **Name and purpose:**
- **Duration:** start and checkpoint/end date.
- **Owner:** HQ.
- **Channels:** chosen channels and why; name channels explicitly excluded.
- **Autonomy:** manual review, assisted, or auto.
- **Policy:** budget, claims, brand, consent, and stop conditions.

## Delegated Work

One row per room:

| Room | Bounded outcome | Inputs | Deliverable | Success measure |
| --- | --- | --- | --- | --- |

## Measurement and Decision
- **Baseline metrics:** only real, dated connector or analytics values.
- **Checkpoint metrics:**
- **Continue when:**
- **Pause or repair when:**
- **Next collection:** source, frequency, and reason.

## Owner Brief
State what is being improved now, what is scheduled, what needs approval, and what will change based on results. Keep this concise.

## Machine Contract

```json
{
  "global_goal": "",
  "constraint": "positioning|reach|conversion|pipeline|retention|measurement",
  "stage": {
    "name": "",
    "duration_days": 14,
    "autonomy_mode": "MANUAL_REVIEW|ASSISTED|AUTO",
    "channels": [],
    "policy": {
      "spend_cap": null,
      "approval_required": true,
      "stop_conditions": []
    }
  },
  "hypotheses": [
    {
      "statement": "",
      "confidence": "low|medium|high",
      "evidence_refs": [],
      "expected_signal": "",
      "falsification": ""
    }
  ],
  "delegations": [
    {
      "room_type": "campaign|seo|marketing|branding|research|sales|outreach",
      "objective": "",
      "deliverable": "",
      "success_metric": ""
    }
  ],
  "measurement": {
    "baseline_refs": [],
    "checkpoint_at": "ISO-8601",
    "continue_when": [],
    "pause_or_repair_when": [],
    "collection": []
  }
}
```

The compiler, not the model, assigns IDs, timestamps, ownership, approval state, schedule IDs, and connector payloads.
