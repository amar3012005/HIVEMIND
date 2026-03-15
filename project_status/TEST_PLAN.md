# HIVE-MIND - Cross-Platform Context Preservation Test Plan

## Test Scenarios

### Scenario 1: ChatGPT → Claude Handoff
**Objective:** Verify context preserved when switching from ChatGPT to Claude

**Steps:**
1. In ChatGPT with HIVE-MIND connected: "I'm building a project called Project X using Rust"
2. Wait for session end hook to trigger
3. Switch to Claude with HIVE-MIND connected
4. Ask: "Based on my recent project, what language should I use for this new file?"
5. **Expected:** Claude recalls "Project X" and "Rust"

### Scenario 2: Multi-Platform Sync
**Objective:** Verify memories available across all connected platforms

**Steps:**
1. Store memory via API: `{"content":"Database choice: PostgreSQL","tags":["tech"]}`
2. In ChatGPT: Ask about database choice
3. In Claude: Ask about database choice
4. In Cursor: Ask about database choice
5. **Expected:** All platforms return the PostgreSQL memory

### Scenario 3: Context Injection
**Objective:** Verify `<relevant-memories>` XML tags are injected

**Steps:**
1. Store memory: `{"content":"I prefer TypeScript for frontend","tags":["preference"]}`
2. Call `/api/recall` with `query_context: "What language for frontend?"`
3. **Expected:** Response contains `<relevant-memories>` with TypeScript memory

### Scenario 4: Ebbinghaus Decay
**Objective:** Verify older memories have lower recall probability

**Steps:**
1. Store memory with old date: `{"content":"Old project","created_at":"2025-01-01"}`
2. Store memory with recent date: `{"content":"New project","created_at":"2026-03-09"}`
3. Call `/api/recall` with `query_context: "project"`
4. **Expected:** New project has higher score than old project

### Scenario 5: Graph Traversal
**Objective:** Verify relationship-based recall

**Steps:**
1. Store memory A: `{"content":"Started with Python"}`
2. Store memory B: `{"content":"Switched to Rust"}` with `Updates` relationship to A
3. Call `/api/memories/traverse` from memory A
4. **Expected:** Memory B is returned as an update

---

## Test Commands

### Store Memory
```bash
curl -X POST http://localhost:3000/api/memories \
  -H "Content-Type: application/json" \
  -d '{
    "content": "Test memory",
    "tags": ["test"],
    "project": "test-project"
  }'
```

### Search Memories
```bash
curl -X POST http://localhost:3000/api/memories/search \
  -H "Content-Type: application/json" \
  -d '{"q": "test"}'
```

### Recall Context
```bash
curl -X POST http://localhost:3000/api/recall \
  -H "Content-Type: application/json" \
  -d '{"query_context": "test"}'
```

### Graph Traversal
```bash
curl -X POST http://localhost:3000/api/memories/traverse \
  -H "Content-Type: application/json" \
  -d '{"memory_id": "abc-123", "depth": 2}'
```

### Session End
```bash
curl -X POST http://localhost:3000/api/session/end \
  -H "Content-Type: application/json" \
  -d '{"content": "Test session"}'
```

---

## Success Criteria

| Test | Pass Criteria |
|------|---------------|
| ChatGPT → Claude | Claude recalls previous context |
| Multi-Platform | All platforms return same memories |
| Context Injection | `<relevant-memories>` tags present |
| Ebbinghaus Decay | Recent memories score higher |
| Graph Traversal | Related memories returned |

---

## Performance Targets

| Metric | Target |
|--------|--------|
| Recall Latency (P99) | <300ms |
| Search Latency (P99) | <500ms |
| Memory Storage Latency | <100ms |
| Cross-Platform Sync | <1s |

---

## Tools

- **Postman** - API testing
- **curl** - Quick API tests
- **k6** - Load testing
- **Playwright** - E2E testing

---

*Last updated: 2026-03-09*
