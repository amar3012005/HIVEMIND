## MCP Tools: code-review-graph

**IMPORTANT: Project has knowledge graph. ALWAYS use
code-review-graph MCP tools BEFORE Grep/Glob/Read for codebase exploration.** Graph faster, cheaper (fewer tokens), gives
structural context (callers, dependents, test coverage) file
scanning cannot.

### When to use graph tools FIRST

- **Exploring code**: `semantic_search_nodes` or `query_graph` instead of Grep
- **Understanding impact**: `get_impact_radius` instead of manually tracing imports
- **Code review**: `detect_changes` + `get_review_context` instead of reading entire files
- **Finding relationships**: `query_graph` with callers_of/callees_of/imports_of/tests_for
- **Architecture questions**: `get_architecture_overview` + `list_communities`

Fall back to Grep/Glob/Read **only** when graph not cover need.

### Key Tools

| Tool | Use when |
|------|----------|
| `detect_changes` | Reviewing code changes — gives risk-scored analysis |
| `get_review_context` | Need source snippets for review — token-efficient |
| `get_impact_radius` | Understanding blast radius of change |
| `get_affected_flows` | Finding which execution paths impacted |
| `query_graph` | Tracing callers, callees, imports, tests, dependencies |
| `semantic_search_nodes` | Finding functions/classes by name or keyword |
| `get_architecture_overview` | Understanding high-level codebase structure |
| `refactor_tool` | Planning renames, finding dead code |

### Workflow

1. Graph auto-updates on file changes (via hooks).
2. Use `detect_changes` for code review.
3. Use `get_affected_flows` to understand impact.
4. Use `query_graph` pattern="tests_for" to check coverage.

---

## HIVEMIND Session Trail — bootstrap context on every new session

This repo has persistent memory in HIVEMIND across sessions. **At the start of every new Claude Code session in this repo, run these as the FIRST tool calls:**

```
hivemind_recall({ tags: ["session-b-master", "session-trail-2026-05-09", "master-index"], mode: "panorama", limit: 10 })
hivemind_recall({ tags: ["session-progress"], mode: "insight", limit: 20 })
```

The first call returns master trail-index memories listing every prior session's commits, decisions, and pending actions. The second call returns the most recent task-level memories (decisions, refactors, bug fixes, code ingests).

If a master-index memory is returned, follow up with:

```
hivemind_traverse_graph({ memory_id: "<master-id>", depth: 3, relationship: "all" })
```

to walk the graph of related child memories.

### Memory discipline (mandatory in this repo)

- After any Edit/Write to a real file → `hivemind_ingest_code({ file_path, content, summary })` (auto-dedups against prior version)
- On any architectural choice → `hivemind_log_decision({ title, decision, rationale, alternatives, affected_files })`
- On any rename/move/split/merge/extract → `hivemind_track_refactor`
- On any test write/update → `hivemind_test_coverage({ action: "save", ... })`
- Before writing in a known-buggy area → `hivemind_recall_bugs({ context, file_path })`
- Before modifying unfamiliar code → `hivemind_why_code({ query, file_path })`
- At end of meaningful task → `hivemind_save_conversation({ title, messages, tags: ["session-progress"], platform: "claude" })`

### Tag conventions

Every memory MUST include:
- `file:<path>` for code-related memories
- `fn:<name>` when scoped to one function
- `bug | fix | gotcha` for failure-mode memories
- a session-trail tag like `session-trail-YYYY-MM-DD` for chronological clustering
- a session identity tag like `session-b` if running in parallel with another session

At the END of every session, ALWAYS save a master-index memory tagged `session-trail-<date>` + `master-index` summarising what was done, the commits, the pending actions, and the IDs of child memories. New sessions recall via that one tag and rehydrate everything.