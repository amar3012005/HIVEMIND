# hm-understand v1

`hm-understand` is a stateless text-analysis service. Existing HIVE parsers and connectors own
bytes-to-text conversion and preserve page, slide, sheet, row, message, and heading provenance.
The service receives those text blocks and returns entity mentions, exact literals, and candidate
statements with evidence offsets. It has no tenant identity, database credentials, or write path.

## Contract and ownership

- `POST /v1/analyze` accepts at most 100 blocks, 100,000 characters per block, and 1,000,000
  combined characters. Source/revision/block identifiers and parser locators pass through.
- `POST /v1/analyze/stream` returns per-block progress and a final whole-request result. Consumers
  must require the final event and `complete=true` before treating a document analysis as complete.
- `/health` measures process health. `/ready` reports whether the pinned GLiNER model loaded.
- A language label is a best-effort routing signal, not proof of extraction quality. langid scores
  are log-likelihood rankings, not calibrated probabilities. Each block returns
  `quality.refinement_required` plus bounded reason codes when the local model is unavailable,
  language is unclassified/outside the small smoke set, a candidate has no model-backed entity
  anchor, or a statement is uncertain/negated. This is only a conservative routing hint; it is
  not a calibrated bypass decision and does not promote data.
- Every mention and candidate includes the verbatim quote and Python code-point offsets into the
  exact submitted block. Core converts offsets if needed and verifies quotes before persistence.
- Entity mentions are not canonical identities. Core resolves identities under tenant authorization.
- Candidates are review-required proposals. Negation, conditionals, and reported speech are kept
  visible as uncertainty signals. The service never writes memories, entity links, claims, or vectors.

## Local preview

The local overlay attaches only `hm-understand` to the already-running `hivemind-network` and
publishes port 8090 only on loopback:

```bash
docker compose -f infra/compose.hm-understand.local.yml up -d --build
curl -fsS http://127.0.0.1:8090/health
curl -fsS http://127.0.0.1:8090/ready
curl -fsS http://127.0.0.1:8090/v1/capabilities
```

The first analysis downloads the pinned `gliner-community/gliner_small-v2.5` checkpoint
(`f227d3cd637bd4e6757ae143935316d062393341`, BF16 weights) into the named model
volume. Scores are raw model scores, not calibrated probabilities; use them for ranking, not
automatic identity merges. Do not expose this unauthenticated service beyond the local machine or
trusted internal network.

The Docker image caps Torch intra-op threads at two and inter-op at one. The container runtime
reported ten CPUs while limited to two CPU shares; leaving Torch's default at ten caused severe
oversubscription when two requests ran concurrently. With the cap, the warmed six-block smoke
corpus completed in 1,166 ms (model already loaded); the corresponding short English example took
390 ms. These are one-machine synthetic timings, not throughput guarantees. Model download/startup
is excluded.

The initial annotated smoke corpus has only six short examples (English, German, Spanish, Hindi,
and Telugu). After removing casing-only single-token guesses, the local CPU service measured
9 TP / 2 FP / 7 FN (micro precision 0.8182, recall 0.5625, F1 0.6667); all 11 remaining
evidence spans mapped exactly back to their submitted text. English was 4/4 recall, German 2/3,
Spanish 3/3, and Hindi/Telugu 0/3 each. This explicitly demonstrates that this checkpoint is
**not yet an all-language extractor**. Keep Hindi, Telugu, and any unbenchmarked language in a
low-confidence/review or bounded-refinement path; do not claim universal quality or use this smoke
score as a production estimate. A warmed two-block stream test emitted its first block at 676 ms
and the second/final at 1,048 ms in an earlier image; on the current image the same check emitted
the first block at 811 ms and second/final at 1,040 ms. Both are warm CPU measurements; cold model
load is separate.

The Core adapter in `core/src/knowledge/enterprise/hm-understand-adapter.js` converts authorized
evidence segments into this contract and batches large documents without dropping blocks. The
document-ingestion seam runs it only when the dedicated tenant-scoped Cloudflare Flagship
decision `hm_understand_v1` is exactly `shadow` or `assisted`; all other modes fail closed. It is independent
from canonical-memory and entity-profile flags, so enabling those features cannot invoke this
service. The existing Worker URL and bearer secret are transport configuration, not feature gates.
In `shadow`, the result is never fed back into memory generation. Core stores only bounded
version/hash/count metrics, including refinement-reason counts, in the document's
`parse_metadata.hm_understand_shadow`; candidate text and evidence quotes are not duplicated there.
In `assisted`, a complete local result can produce a compact prompt projection only when language,
uncertainty, entity-anchor, literal, and fact-bearing-sentence coverage gates pass. The existing
unified extractor still makes the one authoritative LLM call and validates every `source_quote`
against the original source window. If a gate fails, or compact extraction truncates, it receives the
full original window. The local service never promotes claims, resolves identities, writes memories,
or replaces evidence. Its analysis is ephemeral within that ingestion request; only bounded counts
are persisted. No second refinement LLM call runs in either mode. Remote/BYOD organizations are
skipped to preserve data residency. An unavailable analyzer degrades without failing ingestion.

The adapter, feature decision, bounded receipt, and ingestion seam are covered by focused Core unit
tests. A disposable Core runner against the local Docling service and a separately tagged candidate
`hm-understand` image passed a synthetic PDF+CSV parser → Core hook → analysis → shadow-receipt E2E;
the DB was stubbed, so this is not an authenticated user
upload or a real memory write. The shared local preview Core and original `hivemind-hm-understand`
container were not replaced. Do not use the shared service's `/analyze` endpoint as evidence of a
complete HIVE ingestion.

To test actual synthetic PDF and CSV parsing plus the changed Core hook without replacing that
preview, build a separately tagged local Core image and run only the integration test in a
disposable container on `hivemind-network`:

```bash
docker build --target development -f core/Dockerfile.dev -t hivemind/hm-core-understand-test:local .
docker run --rm --network hivemind-network \
  -e HM_UNDERSTAND_URL=http://hm-understand:8090 \
  -e DOCLING_URL=http://docling:5001 \
  -e 'DATABASE_URL=postgresql://hivemind:localtest@127.0.0.1:5432/test?schema=hivemind' \
  -e MNEME_AGENT_REGISTRY_FILE=/nonexistent \
  hivemind/hm-core-understand-test:local \
  node --test tests/integration/hm-understand-local-e2e.test.js
```

This checks Docling file parsing, Core adapter, tenant-scoped receipt persistence contract, and
service discovery. It deliberately uses a DB stub and does not claim to test an authenticated
upload or real DB write; hm-extract is not currently present in the running local Compose stack.

Local preview wiring sets `HM_UNDERSTAND_URL=http://hm-understand:8090` as an internal service
address, not an enable flag. The Compose overlay attaches the standalone service to the existing
`hivemind-network` and publishes only loopback port 8090. Run the annotated smoke corpus with
`uv run --project hm-understand --python 3.11 python hm-understand/eval/run.py`; its small scores
are diagnostic examples, not representative quality estimates.

## Evaluation and rollout

Run fixtures for multilingual entity quality, negation/conditions, ambiguous same-name people,
Unicode offsets, table locators, long-block window coverage, duplicate inputs, and model-unavailable
partial results. Compare baseline Core ingestion, local analysis, and local analysis-assisted
prompt compaction. Report precision/recall by language and label, false identity
merges (must remain zero because the service does not resolve identities), quote/span validity,
latency, CPU/RAM, and LLM-token reduction.

The local candidate extractor deliberately returns ordinary declarative sentences too; candidate
count alone is not evidence that a sentence is durable or safe to drop. The assisted projection
selects only exact candidates anchored by a model entity, a high-signal decision/task/preference cue,
or a typed literal, then requires every Core-heuristic fact-bearing sentence to be covered and at
least 15% character reduction. This is conservative prompt compaction, not a proven 90% token
reduction or broad quality guarantee. If it saves too little or misses any measured high-signal
sentence, Core sends the original window. Benchmark by language and document type before targeting
assisted mode beyond internal fixtures. `hm-understand` never holds provider credentials. Shadow
receipts must be keyed by tenant/source revision/content hash/pipeline version and must not create
user-visible memories. The only runtime feature decision is Cloudflare Flagship string flag
`hm_understand_v1` (`off` by default; `shadow` for measurement; `assisted` for exact-span prompt
compaction). No environment variable independently enables assisted processing or promotion.
