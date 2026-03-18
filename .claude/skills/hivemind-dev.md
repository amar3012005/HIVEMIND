---
name: hivemind-dev
description: Standard HIVEMIND development workflows for features, bugs, refactors, and migrations
type: reference
---

# HIVEMIND Development Skill

## Overview
This skill provides standardized workflows for common HIVEMIND development tasks.

## Commands

### `/hivemind add-feature`
Add a new feature with full test coverage and documentation.

**Workflow**:
1. Read existing code patterns in target directory
2. Create feature implementation following existing conventions
3. Generate unit tests (minimum 80% coverage)
4. Generate integration tests
5. Update API documentation
6. Run full test suite
7. Commit with conventional commit message

**Example**:
```
/hivemind add-feature "user preferences endpoint"
  - Location: /opt/HIVEMIND/core/src/api/preferences.js
  - Tests: /opt/HIVEMIND/core/tests/preferences.test.js
  - Docs: Update /opt/HIVEMIND/core/docs/API.md
```

### `/hivemind fix-bug`
Fix a bug with regression tests.

**Workflow**:
1. Reproduce the bug (document steps)
2. Identify root cause (check logs, trace execution)
3. Implement fix
4. Add regression test that would have caught this bug
5. Run full test suite to ensure no regressions
6. Document the fix in journal.md

**Example**:
```
/hivemind fix-bug "Qdrant vectors not saving"
  - Root cause: SSL certificate mismatch
  - Fix: Added https.Agent with rejectUnauthorized: false
  - Test: /opt/HIVEMIND/core/tests/qdrant-ssl.test.js
```

### `/hivemind refactor`
Refactor code with safety checks.

**Workflow**:
1. Analyze current code structure
2. Identify refactoring targets (duplication, complexity)
3. Create refactoring plan
4. **Require user approval before changes**
5. Implement refactoring
6. Run full test suite
7. Verify no behavior changes

**Example**:
```
/hivemind refactor "extract embedding service"
  - Source: /opt/HIVEMIND/core/src/embeddings/
  - Target: Separate service module
  - Tests: Must all pass after refactor
```

### `/hivemind migrate`
Database migration workflow.

**Workflow**:
1. Analyze schema changes needed
2. Generate Prisma migration
3. **Review migration SQL before applying**
4. Apply to local database
5. Test with application
6. Document migration in journal.md
7. Apply to production (via Coolify)

**Example**:
```
/hivemind migrate "add user preferences table"
  - Migration: /opt/HIVEMIND/core/prisma/migrations/
  - Tables: preferences, user_preferences
  - Rollback plan: Documented in migration file
```

## Key Files

| File | Purpose |
|------|---------|
| `/opt/HIVEMIND/core/src/server.js` | Main API server |
| `/opt/HIVEMIND/core/prisma/schema.prisma` | Database schema |
| `/opt/HIVEMIND/mcp-server/server.js` | MCP server |
| `/opt/HIVEMIND/journal.md` | Development journal |
| `/data/coolify/applications/s0k0s0k40wo44w4w8gcs8ow0/.env` | Production config |

## Production Deployment

**Hetzner Server**: `hivemind.davinciai.eu:8050`

**Deployment Checklist**:
- [ ] All tests passing
- [ ] Migration SQL reviewed
- [ ] Journal entry created
- [ ] Git commit pushed
- [ ] Container restarted via Coolify
- [ ] Health check passing

## API Keys

- **Master API Key**: `hm_master_key_99228811` (in .env, never commit)
- **Qdrant Cloud**: Configured in .env
- **Groq API**: Configured in .env for LLM inference

## Common Patterns

### Memory Storage Pipeline
```
API Request → Graph Engine → PostgreSQL → Qdrant Vector Store
                                    ↓
                            Hetzner Embeddings (384-dim)
```

### Triple-Operator Relationships
- **Updates**: New memory replaces old (is_latest: false on old)
- **Extends**: New memory adds to old (both is_latest: true)
- **Derives**: AI-inferred relationship (queued for processing)

### MCP Tools
All HIVEMIND APIs are exposed via MCP for Claude Desktop:
- `save_memory` - Save to persistent memory
- `recall` - Semantic search
- `get_memory` - Get by ID
- `list_memories` - List with filters
- `delete_memory` - Delete permanently
