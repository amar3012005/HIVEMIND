# TARA Orchestrator API Specification

This document defines the API contract between the TARA voice agent and the orchestrator backend.

---

## Endpoints

### 1. `POST /api/tara/stream` — Live Conversation

**Purpose**: Stream TARA responses in real-time during a voice conversation.

**Request Body**:
```json
{
  "query": "User's transcribed speech",
  "session_id": "unique-session-id",
  "tenant_id": "optional-tenant",
  "agent_name": "optional-agent",
  "language": "optional-language-hint",
  "language_code": "optional-stt-language",
  "interrupted_text": "optional-interrupted-text",
  "interruption_type": "clarification|correction|other"
}
```

**Response**: NDJSON stream (content-type: `application/x-ndjson`)

**Event Types**:
```javascript
// Progress status
{ "type": "status", "step": "context_ready", "recall_count": 3, "session_turns": 5, "ms": 45 }
{ "type": "status", "step": "prompt_built", "tokens": 1842, "model": "openai/gpt-oss-20b", "ms": 52 }
{ "type": "status", "step": "first_token", "ttfb_ms": 162, "ms": 218 }

// Streaming text (orchestrator should accept both `text` and `content` fields)
{ "type": "text", "text": "Hello", "content": "Hello", "is_final": false }

// Completion
{
  "type": "done",
  "is_final": true,
  "full_response": "Full response text...",
  "latency_ms": 450,
  "ttfb_ms": 162,
  "recall_count": 3,
  "session_turns": 6,
  "model": "openai/gpt-oss-20b",
  "response_length": 234,
  "usage": { "prompt_tokens": 1842, "completion_tokens": 58, "total_tokens": 1900 }
}

// Error (if applicable)
{ "type": "error", "message": "Error description" }
```

**Performance Targets**:
- TTFB: < 250ms (internal: 162-540ms)
- Total response: 210-694ms internal

---

### 2. `POST /api/tara/end_session` — Session Analytics

**Purpose**: Trigger post-session analysis and return the final report for the orchestrator to send to the backend.

**When Called**: After the session ends (user hangs up, timeout, or explicit end).

**Request Body**:
```json
{
  "session_id": "the-session-id",
  "user_id": "optional-user-id",
  "org_id": "optional-org-id",
  "tenant_id": "optional-tenant-id"
}
```

**Response**:
```json
{
  "report": {
    "brief_context": "The user came in with a Director energy — asked directly about pricing and implementation timeline. I recognized their decisive style and shifted quickly to a close strategy. They warmed up when I mentioned enterprise features. We ended with them requesting a formal demo — strong buying signal.",
    "analysis": {
      "overall_sentiment": 0.75,
      "resolution_status": "resolved",
      "customer_pain_points": ["User expressed: frustrated with current vendor", "User expressed: disappointed with lack of support"]
    },
    "business_signals": {
      "is_hot_lead": true,
      "is_churn_risk": false,
      "priority_level": "HIGH"
    },
    "metrics": {
      "agent_iq": 85,
      "frustration_velocity": "DE-ESCALATING",
      "key_topics": ["pricing", "enterprise", "onboarding"]
    },
    "hivemind_updates": {
      "chunks_saved": 3,
      "chunks_candidates": 5,
      "chunks_skipped": 2
    }
  }
}
```

**Field Definitions**:

| Field | Type | Description |
|-------|------|-------------|
| `brief_context` | string | 2-3 sentence TARA-narrated reflection in first person ("I", "me"). Includes: user's opening need, TARA's strategic response, behavioral type (Director/Socializer/Thinker/Relater), SPICED elements uncovered, emotional trajectory, and where the conversation landed. |
| `analysis.overall_sentiment` | number | -1 (negative) to 1 (positive), 0 = neutral |
| `analysis.resolution_status` | string | `"resolved" \| "partially_resolved" \| "unresolved" \| "unknown"` |
| `analysis.customer_pain_points` | array | Specific frustrations or unmet needs |
| `business_signals.is_hot_lead` | boolean | User showed buying intent |
| `business_signals.is_churn_risk` | boolean | User expressed frustration/threat to leave |
| `business_signals.priority_level` | string | `"HIGH" \| "MEDIUM" \| "LOW"` |
| `metrics.agent_iq` | number | 0-100 score of agent performance |
| `metrics.frustration_velocity` | string | `"ESCALATING" \| "STABLE" \| "DE-ESCALATING"` |
| `metrics.key_topics` | array | Main topics discussed |
| `hivemind_updates.chunks_saved` | number | Knowledge chunks persisted |
| `hivemind_updates.chunks_candidates` | number | Candidates identified |
| `hivemind_updates.chunks_skipped` | number | Skipped (duplicates/low quality) |

---

### 3. `POST /api/tara/analyze_session` — Alternative Analytics Endpoint

**Purpose**: Same as `end_session` but accepts explicit turn history (for orchestrators that prefer to send turns directly).

**Request Body**:
```json
{
  "session_id": "the-session-id",
  "user_id": "optional-user-id",
  "org_id": "optional-org-id",
  "tenant_id": "optional-tenant-id",
  "turns": [
    { "role": "user", "content": "User query", "timestamp": "2026-04-06T10:00:00Z" },
    { "role": "assistant", "content": "TARA response", "timestamp": "2026-04-06T10:00:05Z" }
  ],
  "metadata": {
    "duration_seconds": 120,
    "total_turns": 6,
    "avg_ttft_ms": 245,
    "total_llm_tokens": 2500
  },
  "memory_stats": {
    "chunks_saved": 3,
    "chunks_candidates": 5,
    "chunks_skipped": 2
  }
}
```

**Response**: Same as `end_session`

**Note**: If `turns` array is empty, HIVEMIND will fetch turn history from memory using `session_id`.

---

## Orchestrator Integration Guide

### Minimum Required Flow

```python
# 1. During conversation — stream each user utterance
async for event in post('/api/tara/stream', json={
    'query': transcribed_text,
    'session_id': session_id,
}):
    if event['type'] == 'text':
        send_to_tts(event['content'])
    elif event['type'] == 'done':
        break

# 2. After session ends — get analytics report
analytics_resp = post('/api/tara/end_session', json={
    'session_id': session_id,
    'user_id': user_id,
    'tenant_id': tenant_id,
})
report = analytics_resp.json()['report']

# 3. Merge with local metrics and send to backend
final_report = {
    'session_id': session_id,
    'user_id': user_id,
    'tenant_id': tenant_id,
    # ... your existing fields ...
    **report  # Merge HIVEMIND analytics
}
post('https://backend.internal/webhooks/session-complete', json=final_report)
```

### Field Mapping for Backend

The orchestrator should merge HIVEMIND's report into the final backend payload:

| Orchestrator Field | HIVEMIND Source |
|--------------------|-----------------|
| `brief_context` | `report.brief_context` |
| `analysis` | `report.analysis` |
| `is_hot_lead` | `report.business_signals.is_hot_lead` |
| `is_churn_risk` | `report.business_signals.is_churn_risk` |
| `priority_level` | `report.business_signals.priority_level` |
| `rag_metrics` | `report.metrics` |
| `hivemind_updates` | `report.hivemind_updates` |

---

## Error Handling

| Status | Meaning |
|--------|---------|
| `200` | Success |
| `400` | Invalid request (missing session_id, malformed JSON) |
| `404` | Session not found |
| `500` | Analytics failed (LLM timeout, memory fetch error) |
| `503` | TARA service unavailable |

**Fallback Behavior**: If LLM analytics times out (45s), a rule-based fallback produces best-effort analysis.

---

## Performance

| Endpoint | P50 | P95 | Timeout |
|----------|-----|-----|---------|
| `POST /api/tara/stream` (TTFB) | 218ms | 540ms | 30s |
| `POST /api/tara/end_session` | 3-8s | 15s | 45s |

---

## Testing

Use the **TARA Config** page in the frontend (`/hivemind/tara-config`):

1. Send test messages via "Live Test"
2. Click "End Session & Run Analytics" after conversation
3. View full analytics report in UI

**Example Test Query**:
```
"Hi Tara, my name is Samer and I am looking for some marketing and branding advice."
```

---

## Schema (TypeScript)

```typescript
interface StreamRequest {
  query: string;
  session_id: string;
  tenant_id?: string;
  agent_name?: string;
  language?: string;
  language_code?: string;
  interrupted_text?: string;
  interruption_type?: 'clarification' | 'correction' | 'other';
}

interface StreamEvent {
  type: 'status' | 'text' | 'done' | 'error';
  step?: string;
  text?: string;
  content?: string;
  is_final?: boolean;
  ms?: number;
  ttfb_ms?: number;
  latency_ms?: number;
  recall_count?: number;
  session_turns?: number;
  full_response?: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  message?: string;
}

interface AnalyticsReport {
  /**
   * 2-3 sentence TARA-narrated reflection in first person ("I", "me").
   * Structure: User's opening need → TARA's strategic response →
   * behavioral type detected → emotional trajectory → outcome.
   *
   * Example: "The user came in with a Director energy — asked directly
   * about pricing and implementation timeline. I recognized their decisive
   * style and shifted quickly to a close strategy. They warmed up when I
   * mentioned enterprise features. We ended with them requesting a formal
   * demo — strong buying signal."
   */
  brief_context: string;

  analysis: {
    overall_sentiment: number;  // -1 to 1
    resolution_status: 'resolved' | 'partially_resolved' | 'unresolved' | 'unknown';
    customer_pain_points: string[];
  };

  business_signals: {
    is_hot_lead: boolean;
    is_churn_risk: boolean;
    priority_level: 'HIGH' | 'MEDIUM' | 'LOW';
  };

  metrics: {
    agent_iq: number;  // 0-100
    frustration_velocity: 'ESCALATING' | 'STABLE' | 'DE-ESCALATING';
    key_topics: string[];
  };

  hivemind_updates: {
    chunks_saved: number;
    chunks_candidates: number;
    chunks_skipped: number;
  };
}

interface AnalyticsReport {
  brief_context: string;
  analysis: {
    overall_sentiment: number;  // -1 to 1
    resolution_status: 'resolved' | 'partially_resolved' | 'unresolved' | 'unknown';
    customer_pain_points: string[];
  };
  business_signals: {
    is_hot_lead: boolean;
    is_churn_risk: boolean;
    priority_level: 'HIGH' | 'MEDIUM' | 'LOW';
  };
  metrics: {
    agent_iq: number;  // 0-100
    frustration_velocity: 'ESCALATING' | 'STABLE' | 'DE-ESCALATING';
    key_topics: string[];
  };
  hivemind_updates: {
    chunks_saved: number;
    chunks_candidates: number;
    chunks_skipped: number;
  };
}

interface EndSessionRequest {
  session_id: string;
  user_id?: string;
  org_id?: string;
  tenant_id?: string;
}

interface EndSessionResponse {
  report: AnalyticsReport;
}
```
