# Cross-Platform Handoff Test Suite

Comprehensive test suite for verifying memory synchronization and context preservation across ChatGPT, Claude, MCP, and other AI platforms.

## Overview

This test suite validates the HIVE-MIND cross-platform context sync system by testing:

1. **Bidirectional Memory Sync** - Memories created on one platform are accessible from all others
2. **Context Injection** - XML/JSON/Markdown formatting works correctly
3. **Memory Updates** - Changes propagate across platforms in real-time
4. **Scoring Algorithm** - Similarity, recency, and importance weighting works as expected
5. **Performance** - Recall latency meets P99 < 300ms SLA

## Prerequisites

### Required Software

- Node.js 20+
- HIVE-MIND API server running
- PostgreSQL database
- Qdrant vector store (optional for semantic search tests)
- Redis (optional for caching tests)

### Environment Variables

```bash
# API Configuration
export HIVEMIND_API_URL=http://localhost:3000
export TEST_API_KEY=your-test-api-key

# Test Configuration
export TEST_USER_ID=test-user-$(date +%s)  # Unique ID for each test run

# Optional: Redis for caching tests
export REDIS_URL=redis://localhost:6379

# Optional: Qdrant for vector search tests
export QDRANT_URL=http://localhost:6333
```

## Installation

```bash
# Navigate to project root
cd /Users/amar/HIVE-MIND

# Install dependencies (if not already installed)
cd core && npm install
cd ..

# Verify test suite is available
ls tests/cross-platform/
```

## Running Tests

### Run All Tests

```bash
node tests/cross-platform/test-handoff.js
```

### Run with Custom Configuration

```bash
HIVEMIND_API_URL=http://staging.hivemind.io \
TEST_API_KEY=staging-key-123 \
node tests/cross-platform/test-handoff.js
```

### Run Specific Test Scenario

Edit `test-handoff.js` and modify the `run()` method to call specific tests:

```javascript
async run() {
  await this.setup();
  
  // Run only specific tests
  await this.testChatGPTToClaudeHandoff();
  await this.testRecallPerformance();
  
  await this.teardown();
}
```

## Test Scenarios

### Scenario 1: ChatGPT → Claude Handoff

**Objective:** Verify memory saved from ChatGPT is recallable from Claude

**Steps:**
1. Create memory with `sourcePlatform: "chatgpt"`
2. Query with Claude context
3. Verify ChatGPT-sourced memory is found

**Expected:** Memory found with correct source attribution

---

### Scenario 2: Claude → ChatGPT Handoff

**Objective:** Verify memory saved from Claude is recallable from ChatGPT

**Steps:**
1. Create memory with `sourcePlatform: "claude"`
2. Query with ChatGPT context
3. Verify Claude-sourced memory is found

**Expected:** Memory found with correct source attribution

---

### Scenario 3: Multi-Platform Memory Aggregation

**Objective:** Verify memories from all platforms visible in unified view

**Steps:**
1. Create memories from ChatGPT, Claude, and MCP
2. List all memories without platform filter
3. Verify all memories present regardless of source

**Expected:** All memories returned with correct `sourcePlatform` fields

---

### Scenario 4: XML Context Injection

**Objective:** Verify context injection produces valid XML

**Steps:**
1. Request context with `format: "xml"`
2. Verify XML structure is valid
3. Verify memory IDs and token count included

**Expected:**
```xml
<relevant-memories>
  <topic>optional topic</topic>
  <memory id="uuid">
    <content>...</content>
    <metadata>...</metadata>
  </memory>
</relevant-memories>
```

---

### Scenario 5: Memory Updates Across Platforms

**Objective:** Verify memory updates propagate to all platforms

**Steps:**
1. Create memory on ChatGPT
2. Update memory content
3. Verify update visible from Claude

**Expected:** Updated content visible within 1 second

---

### Scenario 6: Memory Type Filtering

**Objective:** Verify filtering by memory type works correctly

**Steps:**
1. Create memories of different types
2. Query with `memoryTypes` filter
3. Verify only matching types returned

**Expected:** Results match requested types only

---

### Scenario 7: Scoring Algorithm Verification

**Objective:** Verify scoring weights are applied correctly

**Steps:**
1. Create high and low importance memories
2. Query with low recency bias
3. Verify high-importance memories score higher

**Expected:** Score breakdown shows correct weighting

---

### Scenario 8: Recall Performance (P99 < 300ms)

**Objective:** Verify recall latency meets SLA

**Steps:**
1. Run 20 recall queries
2. Measure latencies
3. Calculate P50, P95, P99

**Expected:**
- P50 < 100ms
- P95 < 200ms
- P99 < 300ms

---

## Test Fixtures

The `fixtures.json` file contains:

- **Test Memories**: Pre-defined memories for consistent testing
- **Test Queries**: Standard queries with expected results
- **Platform Configurations**: Test settings for each platform
- **Validation Rules**: Schema validation constraints
- **Expected Behaviors**: Documented expected outcomes

### Using Fixtures

```javascript
import fixtures from './fixtures.json';

// Access test memory
const testMemory = fixtures.memories.typescriptPreference;

// Access expected query results
const expected = fixtures.testQueries.backendLanguage;
```

## Output Format

### Console Output

```
============================================================
HIVE-MIND Cross-Platform Handoff Test Suite
============================================================
[TEST INFO] Setting up test environment...
[TEST INFO] Test user: test-user-1234567890
[TEST INFO] API Base: http://localhost:3000

[TEST INFO] 
=== Scenario 1: ChatGPT → Claude Handoff ===
[TEST INFO] Step 1: Creating memory from ChatGPT...
✓ [PASS] Memory created: 550e8400-e29b-41d4-a716-446655440001
[TEST INFO] Waiting for embedding generation...
[TEST INFO] Step 2: Recalling memory from Claude context...
✓ [PASS] Found memory from ChatGPT: 550e8400-e29b-41d4-a716-446655440001
✓ [PASS] Scenario 1: ChatGPT → Claude Handoff

...

============================================================
TEST SUMMARY
============================================================
Total: 8
Passed: 8
Failed: 0
Success Rate: 100.0%
============================================================
```

### Exit Codes

- `0`: All tests passed
- `1`: One or more tests failed

## Troubleshooting

### Test Fails with "Connection Refused"

**Problem:** API server not running

**Solution:**
```bash
# Start the API server
cd core && npm run server
```

### Test Fails with "Invalid Token"

**Problem:** Authentication issue

**Solution:**
```bash
# Generate new test token
export TEST_API_KEY=$(node scripts/generate-test-token.js)
```

### Test Fails with "Memory Not Found"

**Problem:** Embedding generation pending

**Solution:**
- Increase wait time in test
- Check Qdrant is running
- Verify embedding service is configured

### Performance Test Fails

**Problem:** P99 latency exceeds 300ms

**Solutions:**
1. Check database connection pool size
2. Verify Qdrant is running locally
3. Enable Redis caching
4. Check for slow queries in logs

## Continuous Integration

### GitHub Actions Example

```yaml
name: Cross-Platform Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    
    services:
      postgres:
        image: postgres:15
        env:
          POSTGRES_PASSWORD: postgres
        ports:
          - 5432:5432
      
      qdrant:
        image: qdrant/qdrant
        ports:
          - 6333:6333
      
      redis:
        image: redis:alpine
        ports:
          - 6379:6379
    
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '20'
      
      - name: Install dependencies
        run: npm install
      
      - name: Run database migrations
        run: npm run db:migrate
        env:
          DATABASE_URL: postgresql://postgres:postgres@localhost:5432/hivemind
      
      - name: Start API server
        run: npm run server &
        env:
          DATABASE_URL: postgresql://postgres:postgres@localhost:5432/hivemind
          QDRANT_URL: http://localhost:6333
          REDIS_URL: redis://localhost:6379
      
      - name: Wait for server
        run: sleep 5
      
      - name: Run cross-platform tests
        run: node tests/cross-platform/test-handoff.js
        env:
          HIVEMIND_API_URL: http://localhost:3000
          TEST_API_KEY: test-key
```

## Performance Benchmarks

| Metric | Target | Typical | Notes |
|--------|--------|---------|-------|
| OAuth Flow | <5s | 2-3s | Authorization to token |
| Memory Creation | <200ms | 50-100ms | Including embedding |
| Recall P50 | <100ms | 50-80ms | Semantic search |
| Recall P95 | <200ms | 150-180ms | 95th percentile |
| Recall P99 | <300ms | 250-290ms | SLA target |
| Context Injection | <200ms | 80-150ms | XML formatting |
| Webhook Processing | <500ms | 200-400ms | Signature + routing |

## Security Testing

### HMAC Signature Verification

Test invalid signatures are rejected:

```bash
curl -X POST http://localhost:3000/integrations/webhooks/claude \
  -H "Content-Type: application/json" \
  -H "X-Claude-Signature: invalid-signature" \
  -H "X-Claude-Timestamp: $(date +%s)" \
  -d '{"type": "test"}'

# Expected: 401 Unauthorized
```

### Token Validation

Test expired tokens are rejected:

```bash
curl -X GET http://localhost:3000/api/memories \
  -H "Authorization: Bearer expired-token"

# Expected: 401 Unauthorized
```

## Contributing

### Adding New Test Scenarios

1. Create test method in `test-handoff.js`:
   ```javascript
   async testNewScenario() {
     const testName = 'Scenario X: Description';
     logger.info(`\n=== ${testName} ===`);
     
     try {
       // Test steps
       assert.ok(condition, 'Error message');
       this.recordResult(testName, true);
     } catch (error) {
       this.recordResult(testName, false, error);
     }
   }
   ```

2. Add to `run()` method
3. Add fixtures to `fixtures.json`
4. Update this README

### Reporting Issues

Include in bug reports:
- Test scenario name
- Expected vs actual result
- Console output
- Environment details (Node version, OS, etc.)
- API server logs

## References

- [Integration Engineer Spec](../../specs/integration-engineer-spec.md)
- [Cross-Platform Sync Spec](../../CROSS_PLATFORM_SYNC_SPEC.md)
- [API Documentation](../../README.md)

---

**Version:** 1.0.0
**Last Updated:** March 9, 2026
