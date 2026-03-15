# ChatGPT Custom GPT Test Scenarios

## Test Environment Setup

### Prerequisites
- ZITADEL OIDC project configured
- ChatGPT Custom GPT created with OpenAPI spec
- Test user account with OAuth access
- API staging environment accessible

### Test Configuration
```bash
# Environment variables required
export CHATGPT_CLIENT_ID=your-client-id
export CHATGPT_CLIENT_SECRET=your-client-secret
export CHATGPT_REDIRECT_URI=https://api-staging.hivemind.io/integrations/chatgpt/oauth/callback
export ZITADEL_PROJECT_ID=your-project-id
export TEST_USER_EMAIL=test@hivemind.io
```

---

## Scenario 1: OAuth Flow Verification

### TC-OAUTH-01: Successful OAuth Authorization

**Objective:** Verify complete OAuth PKCE flow from ChatGPT to HIVE-MIND

**Steps:**
1. Open ChatGPT with HIVE-MIND Custom GPT
2. Trigger an action that requires authentication
3. Complete OAuth flow via ZITADEL
4. Verify redirect back to ChatGPT

**Expected Results:**
- [ ] OAuth state parameter generated and stored in Redis
- [ ] Redirect to ZITADEL authorization page
- [ ] User authentication successful
- [ ] Callback received with authorization code
- [ ] Code exchanged for tokens successfully
- [ ] Tokens encrypted and stored in database
- [ ] Redirect back to ChatGPT with status=success
- [ ] State parameter cleaned up from Redis

**Verification Commands:**
```bash
# Check Redis for state (should be cleaned up after)
redis-cli GET "oauth:chatgpt:test-state-123"

# Check database for integration record
psql -c "SELECT * FROM platform_integrations WHERE platform_type='chatgpt' AND platform_user_id='test-user'"

# Verify token encryption
psql -c "SELECT access_token_encrypted FROM platform_integrations WHERE id='test-integration-id'"
```

**Pass Criteria:** OAuth completes in <5 seconds, tokens stored encrypted

---

### TC-OAUTH-02: Expired State Parameter

**Objective:** Verify handling of expired OAuth state

**Steps:**
1. Initiate OAuth flow
2. Wait 11 minutes (state expires at 10 minutes)
3. Attempt to complete OAuth with expired state

**Expected Results:**
- [ ] State not found in Redis (expired)
- [ ] Error response: "Invalid or expired state"
- [ ] HTTP 400 returned
- [ ] User redirected with status=error

**Pass Criteria:** Clear error message, no security vulnerability

---

### TC-OAUTH-03: Invalid Redirect URI

**Objective:** Verify rejection of unauthorized redirect URIs

**Steps:**
1. Attempt OAuth with modified redirect_uri parameter
2. Use URI not in allowed origins list

**Expected Results:**
- [ ] Redirect URI validation fails
- [ ] OAuth flow rejected immediately
- [ ] HTTP 400 returned
- [ ] Error logged for security monitoring

**Pass Criteria:** Unauthorized redirects blocked

---

## Scenario 2: Memory Creation Tests

### TC-MEM-01: Create Memory via ChatGPT Action

**Objective:** Verify memory creation through Custom GPT action

**Steps:**
1. In ChatGPT, say: "Remember that I prefer TypeScript for backend development"
2. Custom GPT should trigger save_memory action
3. Verify memory stored in database

**Request:**
```json
POST /api/memories
Authorization: Bearer <jwt-token>
Content-Type: application/json

{
  "content": "User prefers TypeScript for backend development",
  "memoryType": "preference",
  "title": "Backend Language Preference",
  "tags": ["typescript", "backend", "programming"],
  "importanceScore": 0.7
}
```

**Expected Results:**
- [ ] HTTP 201 Created
- [ ] Memory ID returned in response
- [ ] Memory stored in PostgreSQL
- [ ] Embedding generated and stored in Qdrant
- [ ] Source platform set to "chatgpt"

**Verification:**
```bash
# Check memory in database
psql -c "SELECT * FROM memories WHERE content LIKE '%TypeScript%' ORDER BY created_at DESC LIMIT 1"

# Check embedding in Qdrant
curl http://localhost:6333/collections/hivemind_memories/points/scroll \
  -H "Content-Type: application/json" \
  -d '{"filter":{"must":[{"key":"payload.content","match":{"text":"TypeScript"}}]}}'
```

**Pass Criteria:** Memory created with all fields, embedding generated

---

### TC-MEM-02: Create Memory with Invalid Content

**Objective:** Verify validation of memory creation requests

**Steps:**
1. Attempt to create memory with empty content
2. Attempt to create memory with content >10000 characters

**Expected Results:**
- [ ] HTTP 400 Bad Request
- [ ] Validation error message returned
- [ ] No memory created in database
- [ ] Error includes requestId for tracing

**Pass Criteria:** Invalid requests rejected with clear errors

---

### TC-MEM-03: Create Memory with All Types

**Objective:** Verify all memory types can be created

**Test Data:**
```json
[
  {"type": "fact", "content": "User lives in Berlin"},
  {"type": "preference", "content": "Prefers dark mode"},
  {"type": "decision", "content": "Chose PostgreSQL for database"},
  {"type": "lesson", "content": "Microservices added complexity"},
  {"type": "goal", "content": "Launch MVP by Q2 2024"},
  {"type": "event", "content": "Meeting with investor on March 15"},
  {"type": "relationship", "content": "Works with team of 5 developers"}
]
```

**Expected Results:**
- [ ] All 7 memory types created successfully
- [ ] Each memory has correct type in database
- [ ] No type validation errors

**Pass Criteria:** All memory types supported

---

## Scenario 3: Memory Recall Tests

### TC-RECALL-01: Semantic Search Recall

**Objective:** Verify semantic search returns relevant memories

**Steps:**
1. Create test memories (from TC-MEM-03)
2. Query: "What programming database did the user choose?"
3. Verify PostgreSQL memory returned with high score

**Request:**
```json
POST /api/recall
Authorization: Bearer <jwt-token>
Content-Type: application/json

{
  "query": "What programming database did the user choose?",
  "limit": 5,
  "recencyBias": 0.3
}
```

**Expected Results:**
- [ ] HTTP 200 OK
- [ ] Results array contains PostgreSQL memory
- [ ] Score breakdown includes similarity, recency, importance
- [ ] Latency <300ms (P99)
- [ ] Results ranked by relevance

**Pass Criteria:** Correct memory found with high relevance score

---

### TC-RECALL-02: Recall with Type Filter

**Objective:** Verify filtering by memory types

**Steps:**
1. Query with memoryTypes filter: "decision,preference"
2. Verify only those types returned

**Request:**
```json
{
  "query": "What has the user decided?",
  "memoryTypes": "decision,preference",
  "limit": 10
}
```

**Expected Results:**
- [ ] Only decision and preference memories returned
- [ ] Fact, lesson, goal, event, relationship excluded
- [ ] Relevant decision memories found

**Pass Criteria:** Type filtering works correctly

---

### TC-RECALL-03: Recall with No Results

**Objective:** Verify handling of queries with no matching memories

**Steps:**
1. Query for non-existent topic: "What's the user's favorite color?"
2. Verify empty but valid response

**Expected Results:**
- [ ] HTTP 200 OK
- [ ] Empty results array: `{"results": [], "metadata": {"total": 0}}`
- [ ] No errors thrown
- [ ] Latency still <300ms

**Pass Criteria:** Graceful handling of no results

---

## Scenario 4: Cross-Platform Handoff Tests

### TC-HANDOFF-01: ChatGPT → Claude Memory Sync

**Objective:** Verify memory saved from ChatGPT is recallable from Claude

**Steps:**
1. Save memory via ChatGPT: "User is working on project Phoenix"
2. Switch to Claude interface
3. Query Claude: "What project am I working on?"
4. Verify Phoenix memory found

**Expected Results:**
- [ ] Memory created with sourcePlatform="chatgpt"
- [ ] Claude can recall memory despite different source
- [ ] No platform isolation issues
- [ ] Sync status shows healthy

**Pass Criteria:** Cross-platform recall works seamlessly

---

### TC-HANDOFF-02: Multi-Platform Memory Aggregation

**Objective:** Verify memories from all platforms visible in unified view

**Steps:**
1. Create memories from ChatGPT, Claude, and direct API
2. List all memories without platform filter
3. Verify all memories present

**Expected Results:**
- [ ] All memories returned regardless of source
- [ ] sourcePlatform field correctly populated
- [ ] No duplicates created
- [ ] Unified view shows complete history

**Pass Criteria:** Multi-platform aggregation works

---

## Scenario 5: Error Handling Tests

### TC-ERR-01: Invalid JWT Token

**Objective:** Verify rejection of invalid authentication

**Steps:**
1. Make API request with malformed JWT
2. Make API request with expired JWT
3. Make API request with valid signature but wrong issuer

**Expected Results:**
- [ ] HTTP 401 Unauthorized for all cases
- [ ] Error message: "Invalid or expired token"
- [ ] No memory data exposed
- [ ] Attempt logged for security monitoring

**Pass Criteria:** Invalid tokens rejected securely

---

### TC-ERR-02: Rate Limiting

**Objective:** Verify rate limiting protects API

**Steps:**
1. Send 101 requests in 1 minute (limit is 100)
2. Verify 101st request is rejected

**Expected Results:**
- [ ] First 100 requests succeed
- [ ] 101st request returns HTTP 429 Too Many Requests
- [ ] Retry-After header included
- [ ] Rate limit resets after 1 minute

**Pass Criteria:** Rate limiting enforced

---

### TC-ERR-03: Server Error Handling

**Objective:** Verify graceful handling of server errors

**Steps:**
1. Simulate database connection failure
2. Simulate Qdrant unavailability
3. Verify error responses

**Expected Results:**
- [ ] HTTP 500 Internal Server Error
- [ ] Error includes requestId for tracing
- [ ] No stack traces exposed to client
- [ ] Error logged with full details server-side
- [ ] RequestId traceable in logs

**Pass Criteria:** Errors handled gracefully without information leakage

---

## Scenario 6: Performance Tests

### TC-PERF-01: OAuth Flow Latency

**Objective:** Verify OAuth completes within SLA

**Steps:**
1. Measure time from OAuth initiation to completion
2. Run 100 iterations
3. Calculate P50, P95, P99 latencies

**Expected Results:**
- [ ] P50 < 2 seconds
- [ ] P95 < 4 seconds
- [ ] P99 < 5 seconds

**Pass Criteria:** OAuth SLA met

---

### TC-PERF-02: Recall Latency

**Objective:** Verify recall meets P99 <300ms target

**Steps:**
1. Load 10,000 test memories
2. Run 1,000 recall queries
3. Measure latencies

**Expected Results:**
- [ ] P50 < 100ms
- [ ] P95 < 200ms
- [ ] P99 < 300ms

**Pass Criteria:** Recall SLA met

---

## Test Execution Checklist

### Pre-Test Setup
- [ ] ZITADEL OIDC configured
- [ ] Test database seeded
- [ ] Qdrant collection created
- [ ] Redis running
- [ ] Staging API deployed
- [ ] ChatGPT Custom GPT published (unlisted)

### Test Execution
- [ ] TC-OAUTH-01: Successful OAuth
- [ ] TC-OAUTH-02: Expired State
- [ ] TC-OAUTH-03: Invalid Redirect
- [ ] TC-MEM-01: Create Memory
- [ ] TC-MEM-02: Invalid Content
- [ ] TC-MEM-03: All Memory Types
- [ ] TC-RECALL-01: Semantic Search
- [ ] TC-RECALL-02: Type Filter
- [ ] TC-RECALL-03: No Results
- [ ] TC-HANDOFF-01: ChatGPT→Claude
- [ ] TC-HANDOFF-02: Multi-Platform
- [ ] TC-ERR-01: Invalid JWT
- [ ] TC-ERR-02: Rate Limiting
- [ ] TC-ERR-03: Server Errors
- [ ] TC-PERF-01: OAuth Latency
- [ ] TC-PERF-02: Recall Latency

### Post-Test Cleanup
- [ ] Delete test memories
- [ ] Remove test user
- [ ] Clear Redis cache
- [ ] Document any failures
- [ ] Generate test report

---

## Test Report Template

```markdown
# Test Execution Report

**Date:** YYYY-MM-DD
**Tester:** [Name]
**Environment:** Staging

## Summary
- Total Tests: 16
- Passed: X
- Failed: Y
- Blocked: Z

## Failures
| Test ID | Description | Error | Severity |
|---------|-------------|-------|----------|
| TC-XXX | ... | ... | High/Med/Low |

## Performance Results
| Metric | Target | Actual | Status |
|--------|--------|--------|--------|
| OAuth P99 | <5s | Xs | Pass/Fail |
| Recall P99 | <300ms | Xms | Pass/Fail |

## Notes
[Any observations, issues, or recommendations]
```

---

**Document Version:** 1.0.0
**Last Updated:** March 9, 2026
