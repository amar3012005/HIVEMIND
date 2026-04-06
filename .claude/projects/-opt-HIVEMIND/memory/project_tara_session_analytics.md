---
name: tara_session_analytics_contract
description: TARA session analytics: first-person narrated brief_context with clinical reasoning for orchestrator handoff
type: project
---

# TARA Session Analytics — Orchestrator Contract

**Implementation Date**: 2026-04-06

## What Was Built

Post-session analytics endpoint that produces TARA-narrated reflections with clinical reasoning insights for the orchestrator to send to the backend.

## Key Design Decision

**brief_context is now first-person TARA narration** — not a neutral third-party summary. TARA reflects on the conversation from its own perspective, including:

- User's behavioral type (Director/Socializer/Thinker/Relater)
- TARA's strategic moves (probe_deeper, pivot, empathize, close, reframe, educate)
- SPICED elements uncovered (Situation, Pain, Impact, Critical Event, Decision)
- Emotional trajectory (tension → relief, frustration → trust)
- Key turning points

## Example Output

```
"The user came in with a Director energy — asked directly about pricing and 
implementation timeline. I recognized their decisive style and shifted quickly 
to a close strategy. They warmed up when I mentioned enterprise features. We 
ended with them requesting a formal demo — strong buying signal."
```

## API Endpoints

| Endpoint | Purpose |
|----------|---------|
| `POST /api/tara/end_session` | Get analytics for a completed session (fetches turns from memory) |
| `POST /api/tara/analyze_session` | Get analytics with explicit turns provided |

## Full Report Structure

```json
{
  "report": {
    "brief_context": "TARA-narrated 2-3 sentence reflection",
    "analysis": {
      "overall_sentiment": 0.75,
      "resolution_status": "resolved",
      "customer_pain_points": ["User expressed: frustrated with vendor"]
    },
    "business_signals": {
      "is_hot_lead": true,
      "is_churn_risk": false,
      "priority_level": "HIGH"
    },
    "metrics": {
      "agent_iq": 85,
      "frustration_velocity": "DE-ESCALATING",
      "key_topics": ["pricing", "enterprise"]
    },
    "hivemind_updates": {
      "chunks_saved": 3,
      "chunks_candidates": 5,
      "chunks_skipped": 2
    }
  }
}
```

## Files Created/Modified

| File | Change |
|------|--------|
| `core/src/tara/session-analytics.js` | **New** — LLM-powered analyzer with rule-based fallback |
| `core/src/server.js` | Added `/api/tara/end_session` and `/api/tara/analyze_session` endpoints |
| `core/src/tara/stream-handler.js` | Added memory stats tracking (`_sessionMemoryStats`, `_trackMemoryOperation`, `getSessionAnalyticsData`, `cleanupSessionStats`) |
| `frontend/Da-vinci/src/components/hivemind/app/pages/TaraConfig.jsx` | Added "End Session & Run Analytics" button + report display UI |
| `docs/tara-orchestrator-api.md` | **New** — Full API specification |

## Clinical Reasoning Integration

The analytics engine uses the same clinical reasoning framework as the live conversation:

- **Behavioral Profiling**: Director/Socializer/Thinker/Relater detection from language patterns
- **SPICED Framework**: Situation, Pain, Impact, Critical Event, Decision tracking
- **Strategy Detection**: probe_deeper, pivot, empathize, close, reframe, educate
- **Emotional Arc**: frustration_velocity (ESCALATING/STABLE/DE-ESCALATING)

## Fallback Behavior

If LLM times out (45s) or fails:
- Rule-based heuristic analysis kicks in
- Keyword sentiment scoring
- Pattern-based behavioral type detection
- Turn-count + closing-phrase resolution detection
- Produces structured output with ~60% confidence

## Testing

Use TaraConfig page:
1. Go to `/hivemind/tara-config`
2. Send test message in "Live Test"
3. Click "End Session & Run Analytics"
4. View narrated reflection + full report

## Orchestrator Integration

```python
# After session ends
resp = post('/api/tara/end_session', json={'session_id': sid})
report = resp.json()['report']

# Merge into backend payload
backend_payload = {
    ...existing_fields,
    'brief_context': report['brief_context'],  # TARA's narration
    'analysis': report['analysis'],
    'business_signals': report['business_signals'],
    'rag_metrics': report['metrics'],
    'hivemind_updates': report['hivemind_updates']
}
```

## Why First-Person Narration?

1. **Clinical coherence** — TARA was the agent, it has the "patient perspective"
2. **Actionable insights** — "I adapted my close strategy" tells the backend what TARA _did_, not just what happened
3. **Continuity** — Future sessions can reference how TARA approached previous conversations
4. **Trust signal** — Shows the system has introspective awareness, not just pattern matching
