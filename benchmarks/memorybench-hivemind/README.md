# MemoryBench + HIVEMIND Setup

This folder is a ready-to-run MemoryBench integration against the HIVEMIND memory engine.

## What is required (from MemoryBench docs + repo)

1. `bun` installed.
2. MemoryBench source checked out and dependencies installed.
3. A memory provider adapter implementing the MemoryBench `Provider` interface.
4. At least one judge API key (`OPENAI_API_KEY` or `ANTHROPIC_API_KEY` or `GOOGLE_API_KEY`).
5. Provider API key and base URL (`HIVEMIND_API_KEY`, optional `HIVEMIND_BASE_URL`).

Docs reviewed:
- https://supermemory.ai/docs/memorybench/overview
- https://supermemory.ai/docs/memorybench/installation
- https://supermemory.ai/docs/memorybench/quickstart
- https://supermemory.ai/docs/memorybench/cli
- https://supermemory.ai/docs/memorybench/architecture
- https://supermemory.ai/docs/memorybench/extend-provider
- https://supermemory.ai/docs/memorybench/integrations
- https://supermemory.ai/docs/memorybench/contributing
- https://github.com/supermemoryai/memorybench

## What was added for HIVEMIND

- New provider: `memorybench/src/providers/hivemind/index.ts`
- Provider prompt formatter: `memorybench/src/providers/hivemind/prompts.ts`
- Registered provider in:
  - `memorybench/src/providers/index.ts`
  - `memorybench/src/types/provider.ts`
  - `memorybench/src/utils/config.ts`
  - `memorybench/src/cli/index.ts` help text

Provider behavior:
- Ingest: `POST /api/memories` with `project = containerTag`
- Search: `POST /api/search/quick` with `project = containerTag`
- Clear: `DELETE /api/memories/delete-all?project=...`

## One-time setup

```bash
cd /Users/amar/HIVE-MIND/benchmarks/memorybench-hivemind
cp .env.memorybench-hivemind.example memorybench/.env.local
```

Then edit `memorybench/.env.local`:
- set `HIVEMIND_API_KEY`
- set `HIVEMIND_BASE_URL` (default expected: `http://localhost:3001`)
- set one judge key, usually `OPENAI_API_KEY`

## Run benchmark when ready

```bash
cd /Users/amar/HIVE-MIND/benchmarks/memorybench-hivemind
./run-memorybench-hivemind.sh
```

Optional controls:

```bash
RUN_ID=hivemind-longmemeval-01 \
BENCHMARK=longmemeval \
JUDGE_MODEL=gpt-4o \
ANSWER_MODEL=gpt-4o-mini \
SAMPLE=3 \
./run-memorybench-hivemind.sh
```

For full run instead of sample, unset `SAMPLE` and optionally use `LIMIT`.

## Output locations

- Run artifacts: `memorybench/data/runs/<RUN_ID>/`
- Final report: `memorybench/data/runs/<RUN_ID>/report.json`

To inspect with UI:

```bash
cd /Users/amar/HIVE-MIND/benchmarks/memorybench-hivemind/memorybench
bun run src/index.ts serve
```

