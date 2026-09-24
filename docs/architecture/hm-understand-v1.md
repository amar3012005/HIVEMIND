# hm-understand v1

`hm-understand` is a stateless text-analysis service. Existing HIVE parsers and connectors own
bytes-to-text conversion and semantic evidence segmentation, preserving page, slide, sheet, row,
message, and heading provenance. Core passes those exact parser segments (not a second, competing
chunking of the full parse) as bounded text blocks with source-global offsets. The service returns
entity mentions, exact literals, and candidate statements with block-local and source-global
evidence offsets. It has no tenant identity, database credentials, or write path.

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
  exact submitted block. Parser/Core source offsets use JavaScript UTF-16 code units; the service
  converts block-local code-point offsets before returning document-global ranges. Core verifies
  quotes against the parser segment before using them.
- Entity mentions are not canonical identities. Core resolves identities under tenant authorization.
- Candidates are review-required proposals. Negation, conditionals, and reported speech are kept
  visible as uncertainty signals. The service never writes memories, entity links, claims, or vectors.

## Local preview

The standalone analyzer can be run independently on the existing Docker network and publishes
port 8090 only on loopback:

```bash
docker compose -f infra/compose.hm-understand.local.yml up -d --build
curl -fsS http://127.0.0.1:8090/health
curl -fsS http://127.0.0.1:8090/ready
curl -fsS http://127.0.0.1:8090/v1/capabilities
```

The first analysis downloads the pinned multilingual `urchade/gliner_multi-v2.1` checkpoint
(`443d26d654e0324125a96bebd8e796c14ff2efe6`, SHA-256
`2100142f31627531497850659dcb3821c99d5e71c08a8e01a98e4b11ef32a199`, BF16 weights) and pinned
`microsoft/mdeberta-v3-base` tokenizer (`a0484667b22365f84929a935b5e50a51f71f159d`) into the
named model volume. Scores are raw model scores, not calibrated probabilities; use them for
ranking, not automatic identity merges. Do not expose this unauthenticated service beyond the
local machine or trusted internal network.

The Docker image caps Torch intra-op threads at two and inter-op at one. The container runtime
reported ten CPUs while limited to two CPU shares; leaving Torch's default at ten caused severe
oversubscription when two requests ran concurrently. With the cap, the warmed six-block smoke
corpus completed in 1,166 ms (model already loaded); the corresponding short English example took
390 ms. These are one-machine synthetic timings, not throughput guarantees. Model download/startup
is excluded.

The current annotated smoke corpus has only six short examples (English, German, Spanish, Hindi,
and Telugu). The current local CPU candidate measured 11 TP / 1 FP / 6 FN (micro precision
0.9167, recall 0.6471, F1 0.7586); all 12 predicted evidence spans mapped exactly back to their
submitted text. English and Spanish were 5/5 and 3/3 respectively; German had 3 TP / 1 FP, and
Hindi/Telugu were 0/3 each. This tiny fixture is diagnostic, not a production quality estimate or
proof of multilingual coverage. No language is currently promoted to skip refinement; all remain
conservatively refinement-required. A prior warmed CPU stream smoke emitted blocks progressively,
but those timings do not establish production throughput. Cold model load is separate.

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
tests. A disposable Core runner passed the RTF parser → exact hm-extract segment persistence helper
→ analyzer evidence-offset check. This uses a stub DB, not authenticated user uploads or real memory
writes. The earlier PDF/CSV Docling canary failed while fetching from the local parser after 92
seconds; it did not establish a Docling pass or an hm-extract failure. The shared local preview Core
and original `hivemind-hm-understand` container were not replaced. Do not use a parser endpoint by
itself as evidence of complete HIVE ingestion.

### Parser and evidence-segment ownership

`hm-extract` should be used at full scale only for formats where it preserves or improves the
provenance contract and passes the full upload-to-recall golden suite. Its current Core upload
allowlist is intentionally `pptx,doc,docm,odt,rtf,epub`; it is not a universal format router.
Structured CSV/XLSX paths preserve cell/row semantics, the DOCX seam preserves Mammoth heading
structure, and the PDF tier preserves page evidence with fast-PDF/vision. Replacing these routes
without equivalent locator fidelity would make downstream evidence less trustworthy even if text
parsing were faster.

For allowed hm-extract formats, Core now accepts validated parser `segments` and reuses them as
canonical evidence segments when every quote maps exactly to the returned parse text. Invalid or
missing spans fall back to Core's existing chunker. Core requires explicit, ordered source offsets;
it never guesses the occurrence of repeated text with `indexOf`. Those same persisted segments feed
hm-understand, whose returned local and document-global offsets are checked against their source.
This removes duplicate chunking and keeps parser locators attached end-to-end. Expansion of the
format allowlist should be evidence-driven per format: compare latency, peak RSS, truncation,
semantic boundaries, locator recall, exact quote mapping, and downstream retrieval—not parse speed
alone. Large-file memory admission also needs a separate stress canary; a prior 70 MB CSV run OOMed
the 4 GiB local service container under Docker VM pressure.

The parser response now honors socket backpressure and batches segment JSON in bounded 64 KiB
writes. The internal Core adapter negotiates `application/vnd.hm-extract.v2+json`, which sends the
full text once instead of duplicating it as both `markdown` and `text`; legacy clients retain the
original response aliases. A 21 MB / 125,000-row CSV slow-reader canary returned 25,001 segments,
with exact source offsets and all rows preserved. A 74 MB CSV canary was OOM-killed before
completion in the shared local Docker VM, so that size is **not** considered supported through the
hm-extract/anydoc route. The default admission gate now rejects a single estimated request larger
than its configured memory budget before multer buffers or parsing begins. Core's existing
`csv-direct` route remains the correct production path for large CSVs unless a separately sized
streaming parser canary proves otherwise. Do not loosen that gate to make the oversized canary
appear green.

To test actual synthetic PDF and CSV parsing plus the changed Core hook without replacing that
preview, build a separately tagged local Core image and run only the integration test in a
disposable container on `hivemind-network`:

```bash
docker build --target development -f core/Dockerfile.dev -t hivemind/hm-core-understand-test:local .
docker run --rm --network hivemind-network \
  -e HM_UNDERSTAND_URL=http://hm-understand-v1:8090 \
  -e DOCLING_URL=http://hivemind-docling:5001 \
  -e 'DATABASE_URL=postgresql://hivemind:localtest@127.0.0.1:5432/test?schema=hivemind' \
  -e MNEME_AGENT_REGISTRY_FILE=/nonexistent \
  hivemind/hm-core-understand-test:local \
  node --test tests/integration/hm-understand-local-e2e.test.js
```

This checks Docling file parsing, Core adapter, tenant-scoped receipt persistence contract, and
service discovery when the local Docling endpoint is available. It deliberately uses a DB stub and
does not claim to test an authenticated upload or real DB write. The separate RTF test uses
`KB_EXTRACT_URL` and exercises the local `hm-extract` parser before calling the analyzer.

For the `singulance-local` preview stack, `infra/docker-compose.hivemind-chat.yml` defines the
independent `hm-understand-v1` and `hm-extract` services and Core's internal `HM_UNDERSTAND_URL`
and `KB_EXTRACT_URL` service addresses. The analyzer has a writable named model-cache volume;
neither service publishes a host port. Start only these services with the existing local secrets
file (this does not recreate Core or any dependency):

```bash
docker compose -f infra/docker-compose.hivemind-chat.yml \
  --env-file /path/to/infra/.env.hivemind-chat.local up -d --no-deps hm-extract hm-understand-v1
```

The shared `hivemind-core` container still runs its prior immutable image; it has not loaded this
branch's integration. Recreate Core only after a separately reviewed local Core artifact and
rollback identity are ready. The analyzer URL is wiring, not an enable flag; the single
tenant-scoped `hm_understand_v1` Flagship decision remains authoritative. Run the annotated smoke corpus with
`uv run --project hm-understand --python 3.11 python hm-understand/eval/run.py`; its small scores
are diagnostic examples, not representative quality estimates.

The opt-in real-provider token comparison test is present, but no token-savings result is established:
the default custom-provider route returned a Gateway 502, and the explicitly selected OpenRouter
Gateway route exceeded Core's extraction budget before usage was returned. Do not claim token savings
until a comparable baseline/assisted run produces provider usage receipts.

Current verification (2026-09-24): the local-branch hm-extract golden, atomicity,
offset/backpressure, and admission suite passes 36/36; hm-understand passes 20/20; Core's focused
adapter/evidence set passes 18/18, with two optional Docling/provider integration checks skipped
because those endpoints were not available to the host test runner. The live RTF chain passes: a
synthetic RTF is parsed by the running hm-extract service; Core's evidence helper persists the
validated exact segments to a stub DB; the real pinned multilingual GLiNER service analyzes those
same segments. The model returned grounded date, person, money, and project mentions plus a decision
candidate, with quotes and document offsets matching parser evidence. The Core RTF canary completed
in about 0.85 seconds warm; analyzer readiness reported all 224/224 pinned model tensors loaded.
This proves the local parser→evidence→real-model contract, not authenticated upload, real PostgreSQL
writes, or production throughput.

The shared local Core container still uses its prior immutable image and was not recreated. The
candidate model was exercised as a host-local process because Docker Desktop had 58 containers
using about 6.3 GiB of its 7.65 GiB VM; previous attempts to cold-load this model inside that crowded
VM were OOM-killed. Host-local inference proves model behavior but does not prove candidate Docker
image startup, model-cache warmup, or container memory sizing. Those remain explicit local-stack
gates. No language is promoted to bypass refinement: even the successful English example is marked
`language_outside_smoke_set`, and model scores are uncalibrated. Keep results as evidence-backed
candidates, not auto-written memories or identity merges. Keep large CSVs on Core's structured path
until a separately sized full-content canary passes.

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
Core's unified extraction path records only provider-reported prompt/completion token totals per
document diagnostic (`llm_usage_reports`, `llm_prompt_tokens`, `llm_completion_tokens`). Compare
these across equivalent `shadow` and `assisted` fixture runs; character savings are not a substitute
for token savings. Providers that omit usage are counted as having no usage report, not zero-cost.
