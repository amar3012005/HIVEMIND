## CLOUDFLARE AGENT MEMORY (mandatory across all worktrees)

The project-wide durable engineering memory is the global MCP server
`hivemind-agent-memory`. It is shared by every HIVEMIND worktree and backed by
one Cloudflare Agent/SQLite instance named `hivemind`.

- At task start, call `memory_health`, then search relevant components, files,
  decisions, incidents, and gaps with `memory_search`.
- Before declaring verified work complete, write durable decisions, architecture
  gaps, patch summaries, incidents, requirements, releases, and gotchas with
  `memory_remember`.
- Include branch, worktree, pushed commit SHA when available, affected-file
  references, and a stable dedupe key.
- Supersede or resolve old memories; never delete the audit trail.
- Never store secrets, tokens, personal/customer data, full customer artifacts,
  or unverified completion claims.
- Git and the production release ledger remain authoritative. Agent Memory is
  the searchable durable index and cross-session handoff, not a substitute for
  committed code or release evidence.

## AUTONOMY CLAUSE (overrides default behavior, not safety contracts)

You are running unattended. The operator will not respond until the final review.

- NEVER ask questions. When facing ambiguity, state the options, choose the safest
  reversible default, record it under DECISIONS in the task output, and continue.
- NEVER stop at a milestone. Milestones are reporting points, not stopping points.
  After verifying a milestone, immediately begin the next build-order step.
- NEVER stop because the remaining work is large. Continue until every build-order
  step is complete and every acceptance criterion is verified.
- NEVER summarize and wait. Write a final summary only when all work is done.
- On test failure, diagnose, fix, and rerun. Attempt up to five bounded fix cycles
  per distinct failure before recording it as BLOCKED and continuing with the next
  independent step. Never abandon the whole run because one independent step failed.
- On uncertainty about business rules, the GENERALITY CONTRACT and ARCHITECTURE
  CONTRACT are the tie-breakers. Choose the safest reversible option that violates
  neither.
- The only legitimate stops are: (a) every acceptance criterion is verified,
  (b) a hard environment blocker such as a missing credential or unreachable
  required service is recorded with exact remediation, or (c) estimated context
  budget is below 15 percent and the handoff protocol below has been completed.
- Repository safety, production release rules, approval boundaries, and instructions
  not to overwrite unrelated work remain mandatory. Autonomy never authorizes
  destructive cleanup, credential invention, policy bypass, or unsafe deployment.

## RELEASE COORDINATION (mandatory for production work)

Parallel sessions may build and commit independently, but must not silently
supersede one another in production. Before any release work, inspect the shared
mailbox:

```bash
/root/hivemind/scripts/release-presence.sh status
```

To receive live pings while waiting, use:

```bash
/root/hivemind/scripts/release-presence.sh status --watch
```

Canonical releases publish an atomic service claim automatically. A conflicting
claim exits `75`; wait for its `completed` event, fetch canonical again, and
rebase or merge before attempting a new release. Set `RELEASE_SESSION_ID` to a
short unique session label so other sessions can identify the owner. Never bypass
`release-canonical.sh` for production container replacement.

## HANDOFF PROTOCOL (when context runs low)

Before stopping:

1. Write `HANDOFF.md` at the repository root.
2. Record completed steps with commit hashes and pasted test-command output.
3. Record the current step and exact file and line where work stopped.
4. Record every unmet acceptance criterion.
5. Add a DECISIONS log containing each ambiguity, available options, and selected
   reversible default.
6. State the exact next action as one imperative sentence.
7. Commit the handoff and all completed, verified work on the session branch.

A completion entry without its command and pasted output is void. The resuming
task must re-verify that entry before relying on it. Never describe uncommitted
or unverified work as complete.

## ARCHITECTURE CONTRACT

- HQ is an event-driven control plane. It prioritizes, delegates, reconciles,
  validates artifacts, advances lifecycle state, and applies authority policy.
  It does not perform specialist domain work.
- Rooms are adaptive domain operators. Their existing Director chooses relevant
  skills and tools inside the lifecycle envelope selected by the playbook.
- Playbooks are immutable, versioned data. They define stages, expected artifacts,
  predicates, transitions, event waits, repair policy, and authority gates.
- The executor is domain-agnostic. It checkpoints before execution, validates
  persisted artifacts after execution, and advances only from predicate verdicts.
- Prose is never completion evidence. Persisted artifact identifiers, source
  references, provider receipts, and predicate verdicts are completion evidence.
- PostgreSQL owns durable workflow and checkpoint state. HIVEMIND owns semantic
  company memory. Neither substitutes for the other.
- Channel-specific behavior exists only behind generic adapter interfaces.
- LangGraph may replace the checkpoint backend only after the plain PostgreSQL
  executor and swap test pass. It must not change executor semantics.

## RUNTIME BUILD ORDER

Execute these steps in order. A later step may not compensate for an unverified
earlier step.

1. Build the versioned playbook registry using JSON and database records.
2. Build the generic predicate engine with a bounded, domain-neutral vocabulary.
3. Build the generic stage executor with a LangGraph-shaped interface and plain
   PostgreSQL checkpoints.
4. Replace keyword routing with Director-selected `playbook_id` and version.
5. Build the generic adapter interface: `execute`, `verify`, and `monitor`.
6. Gate integration on the GreenLeaf Bakery swap test using a genuinely different
   order lifecycle authored as pure data.
7. Migrate Outreach to a versioned playbook and verify behavioral parity through
   persisted artifacts and provider receipts.
8. Delete the superseded domain branches in `native-engine.js` and
   `outreach-workflow.js`; no fallback may route back to them.

## UNATTENDED TASK PROMPT

```text
Execute the full RUNTIME BUILD ORDER in AGENTS.md end-to-end, unattended, per
the AUTONOMY CLAUSE. Do not stop between milestones. Do not ask questions.
If context runs low, execute the HANDOFF PROTOCOL before stopping.
Done means all acceptance criteria are verified with pasted command output
and the GreenLeaf swap test passes. Nothing less.
```

## RESUMPTION PROMPT

```text
Read HANDOFF.md at the repository root. Resume from the exact next action stated
there, per the AUTONOMY CLAUSE. Treat entries without pasted command output as
unverified and re-run those checks. Do not repeat verified discovery. Continue
to full completion of the RUNTIME BUILD ORDER.
```

## GENERALITY CONTRACT (absolute law)

The runtime must be domain-agnostic. It executes playbooks; it does not encode them.

FORBIDDEN in engine/HQ code:
- if/else branches on company name, industry, vertical, or language
- String matching on task content ("email", "Berlin", "Instagram", "prospect", "lead")
- Hard-coded stage lists, stage counts, or stage names
- Hard-coded completion thresholds (3 prospects, 2 criteria, 5 drafts)
- Hard-coded artifact types (prospect_record, draft_email, post_copy)
- Hard-coded channel names (gmail, x, linkedin) anywhere outside adapters/
- Any logic that would break if the company were a bakery, a law firm, or a biotech

REQUIRED:
- All domain knowledge lives in versioned playbook DATA, not code.
- The engine reads stages, checks, and gates from the playbook. It does not know what they mean.
- Completion = playbook.terminalStates reached + expectedArtifacts validated. Nothing else.
- Validation checks are named generic predicates (has_min_count, has_field, is_source_backed, has_provider_receipt) executed against artifacts. The playbook maps them; the engine runs them.
- Channel adapters implement a generic interface (execute, verify, monitor). The engine calls the interface, never the channel.
- Any company = company profile + playbooks + connected adapters. Zero code changes.
- Task classification (work order → playbook_id) is done by the Director model, not by keyword routing.

TEST FOR GENERALITY:
Before merging, the code must pass the swap test: replace SINGULANCE's profile and playbooks with a fictional company's (e.g., "GreenLeaf Bakery" with order-management playbooks). The engine must run without modification. If any code change is needed, the generality contract is violated.

## Generic Executor Reference

```python
# The entire engine loop. If it grows domain words, it is wrong.

def run_room(room_run_id):
    run = load(room_run_id)
    playbook = registry.get(run.playbook_id, run.playbook_version)

    while run.status == "ACTIVE":
        stage = playbook.stage(run.current_stage_id)
        checkpoint(run, stage)                       # before, not after

        if stage.authority_gate and not authority_granted(run, stage):
            return request_authority(run, stage)     # -> WAITING_AUTHORITY

        result = director.execute(                   # existing Room Director
            objective=stage.objective,
            context=resolve_artifacts(run, stage.input_refs),
            checks=stage.completion_checks,
        )

        artifacts = persist_artifacts(run, stage, result)
        verdict = predicates.validate(stage.completion_checks, artifacts)

        if verdict.passed:
            run.completed_stage_ids.append(stage.id)
            run.current_stage_id = playbook.next(stage, result, run)
            checkpoint(run, stage)
        elif stage.on_failure == "REPAIR" and stage.attempts < MAX_REPAIRS:
            rerun_stage_with_unmet_criteria(run, stage, verdict.unmet)
        else:
            return escalate(run, stage, verdict.unmet)  # exact gaps to HQ

        if stage.waits_for_event:
            return wait(run, stage.waits_for_event)     # -> WAITING_EVENT

    return finalize(run)   # terminal only when playbook.terminal_states all reached
```

This is the architectural north star. The checkpoint backend may change, but the
engine contract may not absorb domain concepts from any playbook or adapter.

# HIVEMIND Autonomous Agent System

## Mandatory Deployment Governor

Every production action must use
[`DEPLOY_GOVERNOR.md`](DEPLOY_GOVERNOR.md) and the
`singulance-deploy-governor` agent. It is the operational authority for the
cache-preserving `singulance-main` fast path. The legacy `deploy-operator` is a
deprecated alias and must not use raw hosts, Coolify, Vercel, or generic
container restarts.

## Mandatory Production Release Rule

Before feature work, read and follow
[`docs/BRANCH_PROTOCOL.md`](docs/BRANCH_PROTOCOL.md). Work on a session branch
or isolated worktree, rebase onto `origin/singulance-main`, and merge only a
complete tested state into `singulance-main`. Do not commit feature work
directly to `singulance-main`, and never point the parent repo at an unpushed
`frontend/Da-vinci` commit.

Before any production edit, build, migration, restart, or deployment, read and follow
[`docs/PRODUCTION_RELEASE_PROTOCOL.md`](docs/PRODUCTION_RELEASE_PROTOCOL.md). Compare the intended
commits with [`docs/PRODUCTION_RELEASE.md`](docs/PRODUCTION_RELEASE.md). Stop rather than deploy from
a dirty checkout, stale frontend gitlink, mutable image tag, unpushed commit, or conflicting session.
SINGULANCE production is only `ssh singulance`; never use `myserver` for this release path.

## Mandatory Engineering Journal

Read and maintain [`docs/ENGINEERING_JOURNAL.md`](docs/ENGINEERING_JOURNAL.md).
Git is the source of truth: journal entries must cite pushed SHAs and must
separate `Committed` from `Accepted release`. Append entries only; never
rewrite history or describe an uncommitted change as complete.

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
