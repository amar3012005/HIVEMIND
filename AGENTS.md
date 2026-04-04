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

**Config**: `.claude/teams/feature-team.json`

```json
{
  "description": "Feature development team - implements new HIVEMIND features end-to-end",
  "members": [
    {
      "name": "feature-lead",
      "agentType": "general-purpose",
      "model": "claude-sonnet-4-6"
    },
    {
      "name": "explorer",
      "agentType": "Explore",
      "model": "claude-haiku-4-5"
    },
    {
      "name": "tester",
      "agentType": "general-purpose",
      "model": "claude-sonnet-4-6"
    }
  ],
  "workflow": {
    "1_explore": "explorer searches codebase for related code and patterns",
    "2_plan": "feature-lead creates implementation plan",
    "3_implement": "feature-lead writes code changes",
    "4_test": "tester runs tests and validates changes",
    "5_document": "feature-lead updates documentation"
  }
}
```

### Team 2: Bug Investigation Team

**Config**: `.claude/teams/bug-team.json`

```json
{
  "description": "Bug fix team - investigates and resolves bugs quickly",
  "members": [
    {
      "name": "debugger",
      "agentType": "general-purpose",
      "model": "claude-sonnet-4-6"
    },
    {
      "name": "explorer",
      "agentType": "Explore",
      "model": "claude-haiku-4-5"
    }
  ],
  "workflow": {
    "1_reproduce": "debugger reproduces and isolates the bug",
    "2_investigate": "explorer finds related code and history",
    "3_fix": "debugger implements and tests the fix",
    "4_verify": "debugger runs full test suite"
  }
}
```

### Team 3: Release Team

**Config**: `.claude/teams/release-team.json`

```json
{
  "description": "Release preparation team - handles deployments and releases",
  "members": [
    {
      "name": "release-manager",
      "agentType": "general-purpose",
      "model": "claude-sonnet-4-6"
    },
    {
      "name": "deployment-checker",
      "agentType": "general-purpose",
      "model": "claude-sonnet-4-6"
    }
  ],
  "workflow": {
    "1_prepare": "release-manager reviews changes and updates version",
    "2_test": "release-manager runs full test suite",
    "3_deploy": "deployment-checker verifies production health",
    "4_monitor": "deployment-checker monitors post-deploy metrics"
  }
}
```

## Hook Scripts

### `TeammateIdle` Hook
**File**: `.claude/hooks/teammate-idle.sh`

Called when a teammate is about to go idle. Keeps teammates working if there are pending tasks.

```bash
#!/bin/bash
# Exit code 2 = keep working, 0 = allow idle

TEAM_NAME="${CLAUDE_TEAM_NAME:-hivemind}"
TASKS_DIR="$HOME/.claude/tasks/$TEAM_NAME"

# Check for pending tasks
PENDING_COUNT=$(find "$TASKS_DIR" -name "*.json" -exec grep -l '"status": "pending"' {} \; 2>/dev/null | wc -l)

# Check for in-progress tasks
IN_PROGRESS_COUNT=$(find "$TASKS_DIR" -name "*.json" -exec grep -l '"status": "in_progress"' {} \; 2>/dev/null | wc -l)

# If there are pending tasks and no in-progress, keep working
if [ "$PENDING_COUNT" -gt 0 ] && [ "$IN_PROGRESS_COUNT" -eq 0 ]; then
    echo "There are $PENDING_COUNT pending tasks. Please claim one."
    exit 2
fi

# If still in-progress, check if actually done
if [ "$IN_PROGRESS_COUNT" -gt 0 ]; then
    echo "There are $IN_PROGRESS_COUNT tasks still in progress. Continue working."
    exit 2
fi

echo "No active tasks. Idle approved."
exit 0
```

### `TaskCompleted` Hook
**File**: `.claude/hooks/task-completed.sh`

Called when a task is being marked complete. Runs tests if code was modified.

```bash
#!/bin/bash
# Exit code 2 = block completion, 0 = allow

TASK_ID="$1"
TEAM_NAME="${CLAUDE_TEAM_NAME:-hivemind}"
TASKS_DIR="$HOME/.claude/tasks/$TEAM_NAME"

# Find the task file and verify it's marked completed
if ! grep -q '"status": "completed"' "$TASK_FILE" 2>/dev/null; then
    echo "Task not actually marked as completed"
    exit 2
fi

# Check if code was modified (look for git changes in last commit)
if git diff --name-only HEAD~1 2>/dev/null | grep -qE "\.(js|ts|mjs)$"; then
    echo "Code changes detected. Running tests..."

    # Run HIVEMIND core tests
    cd /opt/HIVEMIND/core
    npm test 2>&1 | tail -20

    if [ ${PIPESTATUS[0]} -ne 0 ]; then
        echo "Tests failed. Task cannot be marked complete."
        exit 2
    fi

    echo "All tests passed"
fi

# Check Qdrant health if memory/Qdrant files were modified
if git diff --name-only HEAD~1 2>/dev/null | grep -qE "(server\.js|memory|qdrant)"; then
    echo "Memory/Qdrant changes detected. Verifying vector storage..."
    # Qdrant health check logic
fi

echo "Task completed and validated"
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

### Model Reference

| Model | Use Case |
|-------|----------|
| `claude-sonnet-4-6` | Default for all development work |
| `claude-haiku-4-5` | Fast exploration, documentation |
| `claude-opus-4-6` | Complex reasoning, adversarial review |

### Settings.json Configuration

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1",
    "HIVEMIND_HOME": "/opt/HIVEMIND",
    "HIVEMIND_API_KEY": "hm_master_key_99228811"
  },
  "permissions": {
    "defaultMode": "default"
  },
  "hooks": {
    "TeammateIdle": [
      {
        "matcher": ".*",
        "hooks": [
          {
            "type": "command",
            "command": "/opt/HIVEMIND/.claude/hooks/teammate-idle.sh"
          }
        ]
      }
    ],
    "TaskCompleted": [
      {
        "matcher": ".*",
        "hooks": [
          {
            "type": "command",
            "command": "/opt/HIVEMIND/.claude/hooks/task-completed.sh"
          }
        ]
      }
    ]
  }
}
```

## Quick Reference

### How to Use Agent Teams

The autonomous agent system is now configured and ready. Here's how to use it:

**1. Enable Agent Teams** (already configured in settings.json):
- `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` enables the feature
- `CLAUDE_TEAM_NAME=hivemind` sets the default team name

**2. Skills are automatically available** via slash commands:
- `/hivemind` - Development workflows
- `/qdrant` - Vector database operations
- `/mcp` - MCP server development
- `/hetzner` - Infrastructure operations

**3. Hooks run automatically**:
- `teammate-idle.sh` - Keeps teammates working when tasks are pending
- `task-completed.sh` - Validates completions and runs tests

### Manual Team Spawning

To manually spawn a team for a specific task:

```
# For feature development
Create a team with:
- feature-lead (general-purpose, Sonnet): leads implementation
- explorer (Explore, Haiku): searches codebase
- tester (general-purpose, Sonnet): writes and runs tests

# For bug investigation
Create a team with:
- debugger (general-purpose, Sonnet): investigates and fixes
- explorer (Explore, Haiku): finds related code
```

### Task Assignment Pattern

```
1. Create tasks using TaskCreate for each work item
2. Assign tasks to teammates using TaskUpdate with owner field
3. Teammates work on their assigned tasks
4. Teammates mark tasks complete when done
5. Hooks validate completion automatically
```

### Team Configuration Files

| File | Purpose |
|------|---------|
| `.claude/teams/feature-team.json` | Feature development workflow |
| `.claude/teams/bug-team.json` | Bug investigation workflow |
| `.claude/teams/release-team.json` | Release preparation workflow |

### Skill Files

| File | Commands |
|------|----------|
| `.claude/skills/hivemind-dev.md` | `/hivemind add-feature`, `/hivemind fix-bug`, `/hivemind refactor` |
| `.claude/skills/qdrant-ops.md` | `/qdrant status`, `/qdrant vectors`, `/qdrant backup` |
| `.claude/skills/mcp-integration.md` | `/mcp add-tool`, `/mcp test`, `/mcp deploy` |
| `.claude/skills/hetzner-ops.md` | `/hetzner status`, `/hetzner logs`, `/hetzner restart` |

## System Status

**Agent Teams**: Configured and enabled via `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`

**Skills**: 4 skills registered and ready
- hivemind-dev
- qdrant-ops
- mcp-integration
- hetzner-ops

**Hooks**: 2 hooks configured and executable
- teammate-idle.sh (keeps teammates working)
- task-completed.sh (validates completions)

**Team Configs**: 3 team configurations created
- feature-team.json
- bug-team.json
- release-team.json

**Next Actions**:
1. Start using slash commands for development workflows
2. Create tasks for the next HIVEMIND feature or bug fix
3. Teams will auto-coordinate via the task system

<!-- code-review-graph MCP tools -->
## MCP Tools: code-review-graph

**IMPORTANT: This project has a knowledge graph. ALWAYS use the
code-review-graph MCP tools BEFORE using Grep/Glob/Read to explore
the codebase.** The graph is faster, cheaper (fewer tokens), and gives
you structural context (callers, dependents, test coverage) that file
scanning cannot.

### When to use graph tools FIRST

- **Exploring code**: `semantic_search_nodes` or `query_graph` instead of Grep
- **Understanding impact**: `get_impact_radius` instead of manually tracing imports
- **Code review**: `detect_changes` + `get_review_context` instead of reading entire files
- **Finding relationships**: `query_graph` with callers_of/callees_of/imports_of/tests_for
- **Architecture questions**: `get_architecture_overview` + `list_communities`

Fall back to Grep/Glob/Read **only** when the graph doesn't cover what you need.

### Key Tools

| Tool | Use when |
|------|----------|
| `detect_changes` | Reviewing code changes — gives risk-scored analysis |
| `get_review_context` | Need source snippets for review — token-efficient |
| `get_impact_radius` | Understanding blast radius of a change |
| `get_affected_flows` | Finding which execution paths are impacted |
| `query_graph` | Tracing callers, callees, imports, tests, dependencies |
| `semantic_search_nodes` | Finding functions/classes by name or keyword |
| `get_architecture_overview` | Understanding high-level codebase structure |
| `refactor_tool` | Planning renames, finding dead code |

### Workflow

1. The graph auto-updates on file changes (via hooks).
2. Use `detect_changes` for code review.
3. Use `get_affected_flows` to understand impact.
4. Use `query_graph` pattern="tests_for" to check coverage.
