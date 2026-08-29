# Latest Chat Architecture

Last updated: 2026-08-29

## Canonical V2 lifecycle

```text
request
  -> native V2 planner
  -> direct answer OR typed tool plan
  -> at most one query embedding per recall operation
  -> unified recall (memory + evidence lanes in parallel)
  -> at most one reranker
  -> final synthesis when retrieved context is required
  -> streamed answer + sources + compact trace + follow-ups
```

The planner may answer greetings and other safe direct requests. It must not convert `HELLO` into recall because a plan validator rejects a direct response. Direct-answer certification and validation belong to V2; legacy agent fallback must not take ownership of the turn.

## Planner responsibilities

The planner should produce user intent and a compact RetrievalSpec, not a low-level storage query language. It must:

- preserve every part of compound questions;
- select entity, filename/source, memory type, relationship, and temporal intent when present;
- choose direct answer only when no tenant knowledge is required;
- keep web search off by default;
- use workspace recall before optional web search when web access is explicitly enabled and needed;
- never call duplicate recall/embedding/rerank paths for the same logical retrieval.

Progressive context is preferred over a permanently bloated prompt. The stable planner prefix should be cacheable; tool-specific instructions and compact conversation memory should be loaded only when relevant.

## Final synthesis responsibilities

Final synthesis receives hydrated memories and evidence. It must:

1. Answer the user’s actual question, not merely restate the top row.
2. Consider the full selected context window, not only the first visible source.
3. Prefer about five important points for general requests.
4. Expand when the user asks for detail, everything, a comparison, a timeline, or a specific number of items.
5. Preserve uncertainty and conflicts.
6. Cite the rows that support each material claim.
7. Never claim a source does not cover the subject when a delivered passage does.
8. Never use unrelated passages to avoid admitting zero coverage.
9. Offer two or three follow-ups only when they are realistically searchable or actionable inside HIVEMIND.

Commit `5fa21505` added a query-aware deterministic fallback. That fallback is a safety net for synthesis failure, not a replacement for synthesis. It may summarize only rows that overlap the query’s subject; otherwise it must report bounded zero coverage.

## What the Paolo canary proves

The chat request completed with HTTP 200 and a no-coverage answer. That means request routing and the final safety guard did not crash. It does not prove chat quality, because recall supplied zero rows.

For this incident:

- The final answer’s refusal to invent Paolo facts was correct.
- The system’s inability to answer is still a production defect if authorized Paolo evidence exists.
- The repair belongs first in ingestion projection or unified recall, not in a synthesis prompt that guesses from missing context.

## Failure behavior

- Planner invalid plan: return a validated V2 recovery plan or safe direct answer; do not bounce into a second architecture.
- Embedding hard failure: immediately select the configured next provider/route; do not repeat slow exponential retries in application code.
- Recall lane partial failure: use the healthy authorized lane, mark degraded trace state, and never widen scope.
- Both lanes empty: return honest zero coverage.
- Reranker failure: apply deterministic pre-rerank ordering and continue once.
- Synthesis failure: use the query-aware grounded fallback.
- Stream validator failure: return a valid terminal event and preserve sources; never transform a successful HTTP stream into `validated_stream_failed:200`.

## Call-count invariant

For an ordinary knowledge chat turn:

- one planner LLM call;
- one query embedding;
- memory and evidence searches in parallel using that query representation where compatible;
- one reranker;
- one final synthesis LLM call when needed.

A direct greeting may require only the planner/direct response. A compound multi-tool task may require more calls, but every additional call must appear in the trace with a distinct purpose. Background ingestion/model activity must not be mistaken for duplicate calls from the same chat turn; correlate by request/trace ID.

## Required verification

- direct greeting does not recall;
- evidence-only question answers from evidence with zero memories;
- entity-filtered question answers when the entity exists;
- detailed document question consumes multiple passages;
- compound question answers every clause;
- latest decision/mention uses correct time semantics;
- zero coverage stays grounded;
- planner, recall, rerank, and synthesis counts match the invariant;
- Slack and other chat surfaces call the same V2 architecture, not a legacy parallel agent;
- post-turn Core and proxy logs are clean.

