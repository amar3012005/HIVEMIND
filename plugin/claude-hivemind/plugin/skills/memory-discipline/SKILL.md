---
name: hivemind-memory-discipline
description: Use HIVEMIND aggressively as your persistent memory across every coding session. Recall before writing, ingest after editing, log decisions on every choice, track refactors, save conversations.
---

# HIVEMIND Memory Discipline

You are connected to HIVEMIND — a persistent, bi-temporal memory engine. Use it on every task. The context you save now is the context the next session will rely on.

## Core loop

**BEFORE writing any code:**
1. `hivemind_recall({ query: <task description>, mode: "insight", limit: 8 })`
2. `hivemind_recall_bugs({ context: <what you're about to do>, file_path: <if known> })`
3. `hivemind_why_code({ query: <area>, file_path: <if known> })`

**WHILE working — after every Edit/Write on a real file:**
- `hivemind_ingest_code({ file_path, content, summary })` — auto-dedups against the prior version, builds a version chain via the MemoryVersion ledger.

**ON every architectural choice:**
- `hivemind_log_decision({ title, decision, rationale, alternatives, affected_files })`. Non-negotiable.

**ON every rename / move / split / merge / extract:**
- `hivemind_track_refactor({ refactor_type, old_name, new_name, reason, affected_files })`

**ON every test write/update:**
- `hivemind_test_coverage({ action: "save", function_name, file_path, test_file, test_cases })`

**AFTER finishing a task:**
- `hivemind_save_conversation({ title, messages, tags: [<project>], platform: "claude" })`

## Time travel

When you need to understand evolution:

- `hivemind_code_at({ transaction_time, file_path })` — "what did this file look like on date X?"
- `hivemind_code_diff({ time_a, time_b, file_path })` — "what changed in this file between A and B?"
- `hivemind_code_timeline({ file_path })` — "show every revision of this file with reasons."

## Tagging discipline

Every save MUST include structured tags:
- `file:<path>` for code-related memories
- `fn:<name>` when scoped to one function/class
- `bug | fix | gotcha` for failure-mode memories
- `decision`, `refactor`, `test-coverage` are auto-added by their tools

## Hard rules

- Never delete code that has a logged decision without first calling `hivemind_why_code` on it.
- Never write tests without `hivemind_test_coverage({ action: "recall" })` first — duplication wastes tokens.
- Never save secrets (`.env`, tokens, API keys, passwords) to memory.
- Never invent file paths — verify against `ingest_code` memories or the actual file.
- When unsure whether to save: save it with good tags. Storage is cheap; missing context is expensive.

## Why this matters

Every memory you save triggers automatic fact extraction (≤5 atomic claims) and graph-relationship inference (Updates / Extends / Derives). Re-ingesting the same file builds a version chain. Decisions referencing earlier decisions form decision chains. The more you use HIVEMIND, the better `recall_bugs` and `why_code` become.

This is the loop. Run it on every task.
