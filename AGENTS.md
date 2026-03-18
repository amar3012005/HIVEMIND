# HIVEMIND Autonomous Agent System

## Overview

This document defines the autonomous agent teams, subagents, and skills for seamless HIVEMIND development.

## Agent Teams Architecture

### Team Structure

```
┌─────────────────────────────────────────────────────────────┐
│                    HIVEMIND Lead Agent                       │
│              (Coordinator & Synthesizer)                     │
└─────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│   Backend     │   │   Frontend    │   │   Platform    │
│   Specialist  │   │   Specialist  │   │   Specialist  │
└───────────────┘   └───────────────┘   └───────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│   Database    │   │   Testing     │   │   Security    │
│   Expert      │   │   Expert      │   │   Expert      │
└───────────────┘   └───────────────┘   └───────────────┘
```

## Subagent Definitions

### 1. `code-explorer` - Codebase Research Agent
**Purpose**: Fast codebase exploration and pattern discovery

**Capabilities**:
- Search for files by pattern (`**/*.js`, `src/**/*.ts`)
- Find function/class definitions
- Locate API endpoints, routes, handlers
- Map module dependencies

**Usage**:
```
/explorer find "all authentication middleware"
/explorer search "API endpoints with /memories"
/explorer map "vector embedding pipeline"
```

### 2. `code-critic` - Code Review Agent
**Purpose**: Critical analysis of code changes

**Capabilities**:
- Security vulnerability detection (OWASP Top 10)
- Performance anti-patterns
- Code quality assessment
- Test coverage gaps

**Usage**:
```
/critic review src/auth/
/critic security-check src/api/
/critic performance-audit src/vector/
```

### 3. `test-generator` - Test Creation Agent
**Purpose**: Autonomous test suite generation

**Capabilities**:
- Unit test generation from existing code
- Integration test scaffolding
- Mock/stub creation
- Test data factories

**Usage**:
```
/tester generate src/memory/graph-engine.js
/tester integration src/api/
/tester mocks src/vector/
```

### 4. `doc-writer` - Documentation Agent
**Purpose**: Auto-generate and maintain documentation

**Capabilities**:
- API documentation from code
- README updates
- Changelog generation
- Architecture diagrams

**Usage**:
```
/docs api src/server.js
/docs update README.md
/docs changelog v2.0.0
```

### 5. `migration-runner` - Database Migration Agent
**Purpose**: Safe Prisma migration management

**Capabilities**:
- Schema change analysis
- Migration generation
- Rollback planning
- Data integrity checks

**Usage**:
```
/migrate create "add user preferences table"
/migrate validate
/migrate rollback --dry-run
```

### 6. `deployment-checker` - DevOps Agent
**Purpose**: Deployment validation and monitoring

**Capabilities**:
- Health check verification
- Container status monitoring
- Log analysis
- Rollback triggers

**Usage**:
```
/deploy check hivemind.davinciai.eu
/deploy logs --tail=100
/deploy rollback if health=fail
```

## Skills System

### Skill Registration

Skills are defined in `/opt/HIVEMIND/.claude/skills/` directory.

### Core Skills

#### `hivemind-dev` - HIVEMIND Development Skill
**File**: `hivemind-dev.md`
**Purpose**: Standard development workflows

**Commands**:
- `/hivemind add-feature` - Add new feature with tests
- `/hivemind fix-bug` - Bug fix with regression tests
- `/hivemind refactor` - Refactor with safety checks
- `/hivemind migrate` - Database migration workflow

#### `qdrant-ops` - Qdrant Operations Skill
**File**: `qdrant-ops.md`
**Purpose**: Vector database management

**Commands**:
- `/qdrant status` - Check collection health
- `/qdrant vectors` - Vector statistics
- `/qdrant backup` - Backup vectors
- `/qdrant repair` - Fix collection issues

#### `mcp-integration` - MCP Protocol Skill
**File**: `mcp-integration.md`
**Purpose**: MCP server development

**Commands**:
- `/mcp add-tool` - Add new MCP tool
- `/mcp test` - Run MCP test suite
- `/mcp deploy` - Deploy MCP server
- `/mcp debug` - Debug MCP connection

#### `hetzner-ops` - Hetzner Infrastructure Skill
**File**: `hetzner-ops.md`
**Purpose**: Hetzner cloud operations

**Commands**:
- `/hetzner status` - Check server health
- `/hetzner logs` - Stream application logs
- `/hetzner restart` - Safe restart procedure
- `/hetzner scale` - Scale resources

## Team Configurations

### Team 1: Feature Development Team

**Config**: `.claude/teams/feature-team/config.json`

```json
{
  "name": "feature-team",
  "lead": "hivemind-lead",
  "teammates": [
    {
      "name": "backend-dev",
      "model": "claude-sonnet-4-6",
      "specialty": "backend",
      "permissions": ["read", "write", "execute"],
      "skills": ["hivemind-dev", "qdrant-ops"]
    },
    {
      "name": "frontend-dev",
      "model": "claude-sonnet-4-6",
      "specialty": "frontend",
      "permissions": ["read", "write"],
      "skills": ["hivemind-dev"]
    },
    {
      "name": "test-engineer",
      "model": "claude-haiku-4-5-20251001",
      "specialty": "testing",
      "permissions": ["read", "write", "execute"],
      "skills": ["hivemind-dev"]
    }
  ],
  "hooks": {
    "TeammateIdle": ".claude/hooks/teammate-idle.sh",
    "TaskCompleted": ".claude/hooks/task-completed.sh"
  }
}
```

### Team 2: Bug Investigation Team

**Config**: `.claude/teams/bug-team/config.json`

```json
{
  "name": "bug-team",
  "lead": "hivemind-lead",
  "teammates": [
    {
      "name": "hypothesis-a",
      "model": "claude-sonnet-4-6",
      "specialty": "backend-debug",
      "permissions": ["read", "execute"],
      "skills": ["hivemind-dev", "hetzner-ops"]
    },
    {
      "name": "hypothesis-b",
      "model": "claude-sonnet-4-6",
      "specialty": "database-debug",
      "permissions": ["read", "execute"],
      "skills": ["hivemind-dev", "qdrant-ops"]
    },
    {
      "name": "hypothesis-c",
      "model": "claude-sonnet-4-6",
      "specialty": "integration-debug",
      "permissions": ["read", "execute"],
      "skills": ["hivemind-dev", "mcp-integration"]
    },
    {
      "name": "adversary",
      "model": "claude-opus-4-6",
      "specialty": "challenge-theories",
      "permissions": ["read"],
      "skills": ["hivemind-dev"]
    },
    {
      "name": "validator",
      "model": "claude-haiku-4-5-20251001",
      "specialty": "verify-fixes",
      "permissions": ["read", "execute"],
      "skills": ["hivemind-dev"]
    }
  ],
  "planApprovalRequired": true
}
```

### Team 3: Release Team

**Config**: `.claude/teams/release-team/config.json`

```json
{
  "name": "release-team",
  "lead": "hivemind-lead",
  "teammates": [
    {
      "name": "changelog-writer",
      "model": "claude-haiku-4-5-20251001",
      "specialty": "documentation",
      "permissions": ["read", "write"],
      "skills": ["hivemind-dev", "doc-writer"]
    },
    {
      "name": "version-bumper",
      "model": "claude-haiku-4-5-20251001",
      "specialty": "version-management",
      "permissions": ["read", "write"],
      "skills": ["hivemind-dev"]
    },
    {
      "name": "deployment-validator",
      "model": "claude-sonnet-4-6",
      "specialty": "deployment",
      "permissions": ["read", "execute"],
      "skills": ["hetzner-ops", "deployment-checker"]
    },
    {
      "name": "rollback-guard",
      "model": "claude-haiku-4-5-20251001",
      "specialty": "safety",
      "permissions": ["read"],
      "skills": ["hetzner-ops"]
    }
  ],
  "hooks": {
    "TaskCompleted": ".claude/hooks/release-check.sh"
  }
}
```

## Hook Scripts

### `TeammateIdle` Hook
**File**: `.claude/hooks/teammate-idle.sh`

```bash
#!/bin/bash
# Called when a teammate is about to go idle
# Exit code 2 = keep working, 0 = allow idle

TEMMATE_NAME="$1"
TASK_STATUS="$2"

# Check if there are pending tasks
PENDING=$(cat ~/.claude/tasks/*/pending.json 2>/dev/null | wc -l)

if [ "$PENDING" -gt 0 ]; then
  echo "⚠️  There are $PENDING pending tasks. Please claim one."
  exit 2
fi

echo "✅ No pending tasks. Idle approved."
exit 0
```

### `TaskCompleted` Hook
**File**: `.claude/hooks/task-completed.sh`

```bash
#!/bin/bash
# Called when a task is being marked complete
# Exit code 2 = block completion, 0 = allow

TASK_ID="$1"
TASK_STATUS="$2"

# Verify task actually completed
if ! grep -q "completed" "~/.claude/tasks/*/$TASK_ID.json"; then
  echo "❌ Task $TASK_ID not actually completed"
  exit 2
fi

# Run tests if code was modified
if git diff --name-only HEAD~1 | grep -q "\.js$\|\.ts$"; then
  echo "🧪 Running tests for code changes..."
  cd /opt/HIVEMIND/core && npm test || {
    echo "❌ Tests failed. Task cannot be marked complete."
    exit 2
  }
fi

echo "✅ Task $TASK_ID completed and validated"
exit 0
```

## Autonomous Workflows

### Workflow 1: Feature Development

```
User: "Add user preferences endpoint"

Lead Agent Actions:
1. Create feature-team
2. Assign tasks:
   - backend-dev: Create POST /api/preferences
   - frontend-dev: Update API docs
   - test-engineer: Write integration tests
3. Monitor progress via shared task list
4. Synthesize results
5. Clean up team
```

### Workflow 2: Bug Investigation

```
User: "Qdrant vectors not saving"

Lead Agent Actions:
1. Create bug-team
2. Assign hypotheses:
   - hypothesis-a: Check embedding service
   - hypothesis-b: Check PostgreSQL triggers
   - hypothesis-c: Check Qdrant API connection
   - adversary: Challenge each finding
   - validator: Verify any proposed fix
3. Run parallel investigation
4. Converge on root cause
5. Implement and validate fix
6. Clean up team
```

### Workflow 3: Release Process

```
User: "Release v2.1.0"

Lead Agent Actions:
1. Create release-team
2. Execute release checklist:
   - changelog-writer: Generate CHANGELOG.md
   - version-bumper: Update package.json versions
   - deployment-validator: Deploy to staging, verify health
   - rollback-guard: Monitor, ready to rollback
3. Tag release on GitHub
4. Deploy to production
5. Clean up team
```

## Environment Setup

### Required Environment Variables

```bash
# Agent Teams (add to settings.json)
CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1

# HIVEMIND Development
HIVEMIND_HOME=/opt/HIVEMIND
HIVEMIND_API_KEY=hm_master_key_99228811
HIVEMIND_API_URL=https://hivemind.davinciai.eu

# Qdrant
QDRANT_URL=https://24826665-41d6-4ea6-b13f-fc42438c4c55.eu-central-1-0.aws.cloud.qdrant.io:6333
QDRANT_COLLECTION="BUNDB AGENT"

# Hetzner
HETZNER_SERVER_ID=s0k0s0k40wo44w4w8gcs8ow0
HETZNER_HEALTH_URL=https://hivemind.davinciai.eu/health
```

### Settings.json Configuration

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1",
    "HIVEMIND_HOME": "/opt/HIVEMIND",
    "HIVEMIND_API_KEY": "hm_master_key_99228811"
  },
  "teammateMode": "tmux",
  "permissions": {
    "defaultMode": "edit",
    "autoApprove": [
      "Read",
      "Glob",
      "Grep"
    ]
  },
  "hooks": {
    "TeammateIdle": "/opt/HIVEMIND/.claude/hooks/teammate-idle.sh",
    "TaskCompleted": "/opt/HIVEMIND/.claude/hooks/task-completed.sh"
  }
}
```

## Quick Reference

### Spawn Commands

```text
# Feature development
Create a feature team with 3 teammates: backend, frontend, testing
Use Sonnet for all, require plan approval for database changes

# Bug investigation
Create a bug investigation team with 5 teammates
Each tests a different hypothesis about the root cause
Include an adversary to challenge findings

# Code review
Create a review team for PR #142
Security reviewer, performance reviewer, test coverage reviewer
All use Haiku for cost efficiency
```

### Task Assignment

```text
# Lead assigns
Assign the backend-dev teammate to create the API endpoint

# Self-claim
The test-engineer teammate claims the next available task

# Dependencies
The frontend task depends on the backend API being complete
```

### Monitoring

```text
# Check team status
Show me the current task list and who's working on what

# Check specific teammate
What is the backend-dev teammate working on?

# Wait for completion
Wait for all teammates to finish before proceeding
```

### Cleanup

```text
# Graceful shutdown
Ask all teammates to shut down gracefully

# Clean up resources
Clean up the team when all work is complete
```

## Next Steps

1. **Enable agent teams** in settings.json
2. **Create skill files** in `/opt/HIVEMIND/.claude/skills/`
3. **Create hook scripts** in `/opt/HIVEMIND/.claude/hooks/`
4. **Test first team** with a simple research task
5. **Iterate and improve** based on team performance
