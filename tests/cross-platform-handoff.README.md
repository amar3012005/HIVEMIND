# Cross-Platform Handoff Verification Tests

## Overview

This comprehensive test suite verifies that Claude, GPT, and other AI platforms can all consume the same recall contract and that context is preserved across platforms in the HIVE-MIND memory system.

## Test Coverage

### 1. Recall Contract Consistency
- ✅ Same memory structure across all platforms
- ✅ Required fields validation (id, content, memoryType, createdAt, importanceScore)
- ✅ Score breakdown inclusion
- ✅ Empty results handling
- ✅ Source platform preservation

### 2. Platform-Specific Context Injection
- ✅ XML formatting for Claude
- ✅ JSON formatting for GPT/OpenAI
- ✅ Markdown formatting for generic platforms
- ✅ XML special character escaping
- ✅ Token limit enforcement
- ✅ Platform-specific metadata inclusion

### 3. Cross-Platform Memory Sharing
- ✅ Save from Platform A, recall from Platform B
- ✅ Metadata preservation (tags, importance, project)
- ✅ Unified search across all platforms
- ✅ Multi-tenant isolation
- ✅ Concurrent access handling

### 4. Context Preservation
- ✅ Memory relationships (Updates/Extends/Derives)
- ✅ Conversation continuity across platforms
- ✅ Memory versioning
- ✅ Tag consistency
- ✅ Importance score preservation

### 5. MCP Tool Integration
- ✅ MCP recall tool vs REST API parity
- ✅ get_context resource (XML/JSON/Markdown)
- ✅ Error handling
- ✅ Tool availability
- ✅ Context sync across platforms
- ✅ Consistent memory IDs

### 6. Three-Tier Retrieval
- ✅ QuickSearch from all platforms
- ✅ PanoramaSearch with historical context
- ✅ InsightForge with LLM analysis
- ✅ Auto-tier selection
- ✅ Tier comparison metrics
- ✅ Multi-tenant isolation in search

### 7. Error Handling & Edge Cases
- ✅ Network error handling
- ✅ Request validation errors
- ✅ Concurrent updates
- ✅ Missing authentication
- ✅ Vector store unavailability

### 8. Performance & SLA
- ✅ QuickSearch latency (< 100ms p50)
- ✅ PanoramaSearch latency (< 500ms p95)
- ✅ High-throughput handling

### 9. Security & Compliance
- ✅ Multi-tenant isolation
- ✅ API key validation
- ✅ Sensitive data protection
- ✅ GDPR data export
- ✅ GDPR data erasure

## Running the Tests

### Prerequisites

```bash
# Install dependencies
npm install

# Set environment variables
export HIVEMIND_API_URL=http://localhost:3000
export TEST_API_KEY=your-test-api-key
```

### Run All Tests

```bash
# Using Jest
npm test tests/cross-platform-handoff.test.js

# With coverage
npm test -- --coverage tests/cross-platform-handoff.test.js

# With verbose output
npm test -- --verbose tests/cross-platform-handoff.test.js
```


### Run Specific Test Suites

```bash
# Recall Contract tests only
npm test -- --testNamePattern="Recall Contract Consistency"

# Platform Injection tests only
npm test -- --testNamePattern="Platform-Specific Injection"
# MCP Integration tests only
npm test -- --testNamePattern="MCP Integration"
```

### Run with Watch Mode

```bash
npm test -- --watch tests/cross-platform-handoff.test.js
```

## Test Fixtures

The test suite uses comprehensive fixtures defined in `TEST_FIXTURES`:

- **Memories**: 6 sample memories covering all memory types (preference, fact, decision, lesson, goal, event)
- **Users**: 3 platform-specific user contexts
- **Platforms**: chatgpt, claude, mcp, perplexity, gemini

## Mock Services

The test suite includes mocks for:

- **Qdrant Vector Store**: Semantic search operations
- **Groq LLM Client**: LLM-powered analysis
- **Prisma/Memory Store**: CRUD operations
- **Injector**: Context formatting (XML/JSON/Markdown)
- **ThreeTierRetrieval**: Search tiers

## Key Test Patterns

### Cross-Platform Handoff Pattern
```javascript
// Save from Claude
const claudeMemory = await saveMemory({ content: '...', sourcePlatform: 'claude' });


// Recall from ChatGPT
const results = await recall({ query: '...', source_platform: 'chatgpt' });
expect(results[0].sourcePlatform).toBe('claude'); // Preserved
```

### Format Verification Pattern
```javascript
for (const format of ['xml', 'json', 'markdown']) {
  const formatted = await injectContext({ format });
  verifyFormat(formatted, format);
}
```

### Multi-Tenant Isolation Pattern
```javascript
const userA = await searchMemories({ user_id: 'user-a' });
const userB = await searchMemories({ user_id: 'user-b' });
expect(userA).not.toContain(userBMemories);
```

## CI/CD Integration


### GitHub Actions
```yaml
name: Cross-Platform Tests
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
      - run: npm ci
      - run: npm test tests/cross-platform-handoff.test.js
```

### Pre-commit Hook
```bash
#!/bin/bash
# .git/hooks/pre-commit
npm test -- --testNamePattern="Cross-Platform" --silent
```

## Troubleshooting

### Common Issues

1. **Jest not found**: Install Jest globally or use `npm test`
2. **Import errors**: Ensure `@jest/globals` is installed
3. **Timeout errors**: Increase `testTimeout` in config
4. **Mock failures**: Run `jest.clearAllMocks()` in beforeEach

### Debug Mode

```bash
# Run with Node debugger
node --inspect-brk node_modules/.bin/jest tests/cross-platform-handoff.test.js

# Run with console output
npm test -- --detectOpenHandles tests/cross-platform-handoff.test.js
```

## Contributing

When adding new tests:

1. Follow the existing describe/it pattern
2. Use the mock services provided
3. Add fixtures to TEST_FIXTURES if needed
4. Update this README with new test coverage
5. Ensure tests are deterministic (no random failures)

## References

- [CROSS_PLATFORM_SYNC_SPEC.md](../CROSS_PLATFORM_SYNC_SPEC.md)
- [DATABASE_SETUP.md](../DATABASE_SETUP.md)
- [MCP Server](../mcp-server/server.js)
- [Recall Injector](../src/recall/injector.js)
- [Three-Tier Retrieval](../src/search/three-tier-retrieval.js)
