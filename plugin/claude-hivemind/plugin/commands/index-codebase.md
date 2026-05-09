---
description: Bulk-ingest the current repository into HIVEMIND so future sessions can recall its structure, decisions, and code via semantic search.
allowed-tools: ["Read", "Glob", "Grep", "Bash", "mcp__hivemind__hivemind_ingest_code", "mcp__hivemind__hivemind_log_decision"]
---

# /hivemind:index-codebase — Mass-ingest this repo

Walk the current repo and ingest meaningful files into HIVEMIND so future sessions inherit full context.

## What gets ingested

For every source file (excluding `node_modules`, `.git`, `dist`, `build`, lockfiles, binaries, generated code):

```
hivemind_ingest_code({
  file_path: <relative>,
  content: <full or summarised>,
  summary: <one-line purpose>,
  project: <repo name>,
  tags: ["initial-index", <language>]
})
```

Auto-dedup builds a version chain on re-indexing — running this command again
won't duplicate memories, it will create UPDATE relationships.

## What also gets logged

After indexing, save a high-level architectural summary:

```
hivemind_log_decision({
  title: "Initial codebase index: <repo>",
  decision: "<one-paragraph architecture summary>",
  rationale: "Captured by /hivemind:index-codebase",
  affected_files: [<top-level dirs>]
})
```

## Heuristic guidance

- **Skip anything > 200KB or binary.**
- **Read full content for top-level entry points, configs, and READMEs.**
- **Read first 200 lines for large source files; summarise the rest.**
- **Tag every ingest with `file:<path>`, `<language>`, and the project name.**
- **Make ~20–50 ingest calls per repo. Don't try to capture everything — capture the spine.**

## Phase 1 — detect ecosystem

Glob for these manifests at repo root (and one level deep):

| Pattern | Ecosystem |
|---------|-----------|
| `package.json`, `tsconfig.json` | JS / TypeScript |
| `pyproject.toml`, `setup.py`, `requirements.txt` | Python |
| `go.mod` | Go |
| `Cargo.toml` | Rust |
| `pom.xml`, `build.gradle` | Java / Kotlin |
| `Gemfile` | Ruby |
| `composer.json` | PHP |
| `*.csproj`, `*.sln` | .NET |

## Phase 2 — ingest entry points + configs

Read and ingest:
- `README.md`, `CLAUDE.md`, `AGENTS.md` if present
- Manifest files
- CI/CD config (`.github/workflows`, `.gitlab-ci.yml`)
- Dockerfiles + compose
- Top-level src entry points

## Phase 3 — ingest architecture

Use Glob to map folder structure. Ingest:
- Routing files (Express, FastAPI, Spring controllers, etc.)
- Database models / schemas / migrations
- Auth middleware
- Public API surface

## Phase 4 — log architectural decisions inferred from the code

For each non-obvious choice (DI container, ORM, framework, pattern), call
`hivemind_log_decision` with whatever rationale is documented in code comments
or git history.

## Final

Print a one-line summary: `Indexed N files into HIVEMIND under project=<name>.`
