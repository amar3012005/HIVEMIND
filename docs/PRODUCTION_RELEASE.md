# Current SINGULANCE Production Release

This file is the deployment ledger. Update it only after production acceptance succeeds.

```yaml
release_id: prod-20260806-0a677a89   # core; FE prod-20260806-8a0e73b1-single
host: singulance
deployed_at_utc: 2026-08-06T16:55:00Z          # runtime observed, not build time
parent:
  branch: singulance-main
  sha: 0a677a890b9b                             # RUNNING core. Recorded from
  # `docker inspect hm-core --format '{{.Config.Image}}'`, NOT from a build log —
  # see changes[] below: the release script reports success over a container that
  # is still on the previous image. singulance-main had already advanced past this
  # (ff7dc7ef) when this was written; the ledger records what RUNS, not what merged.
frontend:
  sha: 7f51e7d554f57f0651603328c73265c171d15ead  # Da-vinci main (image tag prod-20260806-8a0e73b1-single)
runtime:
  VERSION: prod-20260806-7e1b07b9
  env_change: |
    MEMORY_PROCESSOR_MODEL and ENTERPRISE_EXTRACTION_MODEL moved off
    deepseek/deepseek-v4-flash-0731 to google/gemini-2.5-flash-lite (deepseek
    truncated small-JSON calls: finish=length, which triggered a fallback call
    every time). KB_UNIFIED_FALLBACK_MODELS deliberately left TWO-FAMILY
    (deepseek,gpt-oss-120b) so one provider outage cannot take out extraction —
    a single-member gpt-oss chain was considered and rejected because gpt-oss
    was returning HTTP 400 "Reasoning is mandatory" at the time. Applied in
    /root/hivemind/.env only, NOT in the repo. Backup: .env.bak-modelswap-*.
images:
  core: hivemind/core-api:prod-20260806-0a677a890b9b
  control: hivemind/control-plane:sha-556d95ec5                          # unchanged
  employees: hivemind/employees:prod-20260804-runtime-campaign-86f70547  # unchanged
  tara_deepgram: hivemind/tara-deepgram:sha-bf7af3ca                     # unchanged
  byod_agent: hivemind/hm-agent:sha-a95090c2                             # unchanged
  frontend_single: hivemind/fe:prod-20260806-8a0e73b1-single
  docling: ghcr.io/docling-project/docling-serve@sha256:69f7c33dab7067be28d88bfe61b7be08e53c4f87d5571378001f853d9b95c34e  # PINNED BY DIGEST (was :latest)
migration: none
changes:
  - KB PIPELINE, 2026-08-06 late session. pptx RESTORED to KB_EXTENSIONS (server) and
    ACCEPTED_EXTS (FE). It was withdrawn after a real .pptx measured 479s / chunks=0;
    that cause — one serial vision call per slide image — was already fixed by
    FORMAT_PROFILES pptx pics:false and never revisited here. Re-measured on the SAME
    file named in the old comment: 12.4s, 100% word recall. ppt/doc/xls stay refused
    (legacy binary, need LibreOffice; `command -v soffice` in hm-docling is empty).
    The FE picker no longer offers .ppt/.xls it would then reject.
  - EMPTY EXTRACTION now fails for EVERY format, not just pdf. Docling answers
    200/success with a near-empty body on an image-only document (measured: 46 chars,
    three `<!-- image -->`; 104 chars even with do_ocr=true). Non-pdf formats had no
    fallback AND no guard, so the document finished `ready` holding nothing. Same
    200-char floor as parseFailed, which already requires usableChunks === 0.
  - SLIDE CITATIONS. Docling emits no page break for pptx even with
    md_page_break_placeholder set; the page lives in texts[].prov[0].page_no, which
    only arrives when to_formats includes json — and the adapter sent no to_formats.
    Now requests md AND json for slide formats (json alone returns md_content: null)
    and INSERTS `<!-- page N -->`, the marker the segment writer already parses.
    Trap: prov.bbox reports coord_origin BOTTOMLEFT with b < t, which reads y-up and
    is not — bbox `b` equals the true top-down `top` (verified against python-pptx).
    Sorting by `t` returns every slide upside-down while looking plausible.
    Measured live: with_page 0/9 -> 6/9, "no start_page on ANY segment" gone,
    parseText unchanged at 5009 chars.
  - hm-docling PINNED BY DIGEST off mutable :latest. Rollback pointer recorded
    BEFORE recreate at /root/.last-docling-rollback.
  - NOT CHANGED, because measurement showed they were already correct: the async
    submit/poll path (useAsync = smart || >4MB), the task-vanished/OOM guard, the
    per-format profiles, and the provider-rejects-reasoning retry. Four earlier
    "findings" against these were artefacts of benchmarking with a standalone sync
    harness instead of reading the production path first.
  - REVERTED same session: DOCLING_SERVE_MAX_NUM_PAGES / MAX_FILE_SIZE (inert — the
    docling service has no env_file, its config is inline in compose) and
    KB_QUEUE_CONCURRENCY 6->3 (contradicted a measured tuning note: the serial point
    is the sidecar, not the queue). .env diffed identical to its pre-change backup.
  - KB GROUNDING (the session's main find). normalizeUnifiedClaims gated facts on a
    BYTE-EXACT content.includes(source_quote), so any quote spanning a hard line-wrap
    ("klein und\nergaenzt" vs "klein und ergaenzt") was discarded with no log line.
    This produced "EXTRACTION SHORTFALL: kept 0 facts from a window holding 14/15
    fact-bearing sentences" and was long misattributed to the extraction model —
    model benchmarks scoring "verbatim quote ratio" were in fact scoring this filter.
    Replaced with locateSourceQuote(): whitespace/dash/quote-variant tolerant, recovers
    the real offset AND repairs source_quote to the actual section bytes. Normalization
    can only merge characters that already exist, so a hallucinated quote still fails
    and is still rejected — the grounding guarantee is unchanged. Added per-condition
    drop counters ([kb-normalize] in/kept/repaired/dropped{...}) because seven AND-ed
    conditions meant "0 facts" had seven silent causes.
  - The identical byte-exact gate in resolveEvidenceSegment fixed the same way, so a
    re-wrapped quote still binds evidence to its segment.
  - start_page: added a form-feed (\f) page-boundary fallback for fast-pdf/vision tiers
    that emit neither Docling "<!-- page N -->" nor "-- N of M --" markers. A tier with
    no page signal still yields null and is logged honestly rather than guessed.
  - UPLOAD PRECHECK: a knowledge_ingest_jobs row with status=ready OUTLIVES its document
    (hard delete, no soft-delete flag), so re-uploading a since-deleted file was blocked
    forever as "Already in your knowledge base". Precheck now confirms the document still
    exists before reporting a duplicate; a stale ready job returns duplicate:false with
    stale_job:<id>. Dedup stays DB-authoritative and fails open toward allowing.
  - EVIDENCE SCOPE: every knowledge_segment now carries scope / scope_key / project_id /
    team_id / document_title in metadata, on BOTH segment paths (the semantic upload path
    and ingestConnectorRecord, which serves /api/ingest/source). Scope lenses therefore
    apply the same filter to memories AND evidence on central and .amr alike, without
    needing a document join the remote agent does not have.
  - DOC SUMMARY prompt: stopped coining an umbrella entity out of the filename ("The
    WrapTest DE project establishes...") and pinned same-language output.
  - MCP BI-TEMPORAL: hivemind_at / hivemind_diff posted a NESTED time:{valid_at,known_at}
    that /api/recall never reads (it reads body.valid_at / body.transaction_at), so the
    filter was silently dropped — hivemind_at returned the entire corpus (356 memories /
    1.7MB) while looking like a working snapshot, and hivemind_diff compared two
    unfiltered sets. Now sent top-level with the route's real key (transaction_at), and
    capped by the documented limit (default 20, max 200).
  - CHAT BI-TEMPORAL: routing was already correct, but hivemind_context is a `strict`
    tool whose every property is required, so the model satisfied the schema with null
    dates; plan.time came out null and every diff question fell through gatherEvidence's
    dispatch to a version-chain walk. Added extractMessageDates() — a deterministic
    ISO + English/German month-name parser used ONLY when the model supplies no usable
    date. A model-supplied date is never overridden; when nothing parses the value stays
    null and behaviour is byte-identical. The bi-temporal ENGINE is untouched.
  - FRONTEND: the upload scope modal gated the "Entire organization" tier on user.role,
    which bootstrap never populates (org membership is exposed as org.role / user.orgRole;
    control-plane emits orgRole: membership.role). isOrgAdmin was therefore false for
    EVERY user including owners, so the tier rendered opacity-50/cursor-not-allowed and
    could not be clicked, and queueFilesForUpload silently defaulted admins to 'personal'.
  - CHAT ROUTING: respond_directly was answering WORKSPACE questions from model
    parameters on compound input. Measured: "What changed in my knowledge between
    Aug 4 and Aug 6 2026? Was the Gmail pipeline working on August 1st?" selected
    respond_directly with ZERO tool calls — first inventing workspace facts, later
    refusing with "my training only includes data up to June 2024". The same question
    asked one clause at a time routed correctly, so it was a routing miss on compound
    input, not a capability gap. Added a deterministic guard: only when reason=general,
    only when a REAL date parses, and only when the message reads as a question about
    state. clarification / safety_refusal are never overridden.
  - INGESTION FAIL-PROOFING (this session, second half). Dead jobs no longer delete
    the bytes needed to replay them, and a retry endpoint plus GET
    /api/knowledge/jobs?status=failed,dead make failures discoverable and
    re-runnable; a raw-file sweeper bounds retention. The BullMQ worker lock was
    30s against 30-134s jobs, so a lapsed lock could re-deliver a job and ingest
    the same document twice — lockDuration now equals the job budget. The
    reconciler heals evidence SEGMENTS as well as memories, closing the last silent
    data-loss path (a segment whose ingest-time heal failed stayed unsearchable
    forever). Formats with no working parser (pptx/ppt/doc/xls) are refused at
    KB_EXTENSIONS instead of failing slowly through Docling. Vision no longer counts
    an empty 200 as success, so the OpenRouter fallback actually runs. Project-scoped
    uploads reach their project (the modal collapsed every non-personal scope to
    organization), duplicates are checked per scope so one file may live in My Space
    AND a project, and deleting a document no longer blocks re-uploading it. Table
    rows are merged into one contextual memory: the same 5-page budget went from 31
    memories averaging 154 chars to 17-20 averaging ~235.
  - ALSO IN THIS RELEASE, FROM A PARALLEL SESSION (see acceptance.not_verified):
    .amr recall parity work — B5 graph-expansion + update-chain revival, SQL-mirror
    lexical backfill, dual-write of evidence into the shard, sparse-aware shard
    snapshots, and an in-shard lexical lane.
acceptance:
  public: [core_health_200, api_health_200, next_hivemind_200, singulancelabs_200]
  runtime: [core_healthy, restarts_0, oom_false, exit_0, fresh_fatal_errors_0]
  authenticated:
    - kb_ingest_wrapped_german_doc_5_facts_kept_no_shortfall
    - kb_recall_returns_wrapped_sentence_facts
    - upload_precheck_stale_ready_job_returns_duplicate_false   # verified on the real blocked file
    - evidence_segment_scope_stamped_personal_project_org       # 3 uploads, correct scope_key each
    - recall_scope_filter_personal_returns_only_personal
    - recall_scope_filter_organization_returns_only_org
    - recall_scope_filter_project_fails_closed_when_not_member
    - mcp_hivemind_at_ancient_date_returns_zero                 # was: whole corpus
    - mcp_hivemind_at_bounded_output                            # was: 1.7-3.1MB
    - chat_range_question_dispatches_hivemind_diff              # was: hivemind_timeline
    - chat_pointintime_question_dispatches_hivemind_at
    - chat_german_nonISO_range_dispatches_hivemind_diff
    - chat_nontemporal_regression_zero_temporal_leak            # greeting/recall/source/projects/relation
    - chat_compound_temporal_dispatches_hivemind_diff           # was: 0 tools, answered from model params
    - chat_respond_directly_still_owns_greeting_and_arithmetic  # 17*23=391, no tools
    - chat_statement_with_date_not_diverted                     # "let's meet on August 5" -> no tools
    - upload_project_scope_lands_in_project                     # job+doc+memories+segments all scope=project
    - upload_same_file_second_scope_allowed                     # personal AND project, separate jobs
    - upload_same_file_same_scope_refused                       # duplicate_document
    - upload_after_delete_allowed                               # was permanently blocked
    - unsupported_format_refused_instantly                      # pptx -> 415, no Docling burn
    - jobs_list_and_retry_endpoints                             # replayable flag; 409 when bytes are gone
    - delete_leaves_no_trace                                    # 7 tables verified 0 after delete
    - fe_scope_modal_orgRole_derivation_present_in_served_bundle
  not_verified:                                  # recorded honestly; NOT accepted by this session
    - amr_recall_parity_lanes                    # parallel session's work; the only .amr org this
                                                 # session could use was emptied for testing, and the
                                                 # remaining .amr orgs are other tenants' workspaces
                                                 # whose memory content was deliberately not read
    - fe_scope_modal_click_through               # proven at API + served-bundle level only; needs a
                                                 # logged-in browser session
known_gaps:
  - Disk was 92% mid-session but the release script prunes superseded rollback images as
    it goes; measured 69% (90G free of 301G) after the final deploy. No manual pruning
    was performed, so every current rollback path is intact.
  - /root/.quickdeploy-last-sha still reads f172bb75 — release-singulance.sh does not
    update that marker, so it is NOT a reliable source of current runtime truth. Use the
    container image label instead.
  - The hosted MCP connector used from Claude points at a DIFFERENT host than singulance,
    which still runs the pre-fix hivemind_at / hivemind_diff.
  - Facts are translated DE->EN at extraction despite an explicit no-translate instruction
    in the prompt (evidence/source_quote stays in the source language). Owner decision:
    leave as-is.
  - fail2ban locked the owner's IP out of port 22 on 2026-08-06 after rapid automated SSH
    during this session's deploys (HTTPS unaffected — the sshd jail rejects port 22 only).
    Unbanned, and /etc/fail2ban/jail.local now sets ignoreip = 127.0.0.1/8 ::1
    100.64.0.0/10 so the operator's authenticated Tailscale range cannot trip the sshd
    jail. jail.conf untouched; public-internet protection verified still active
    (a fresh attacker was banned immediately after the reload). Tailscale
    (singulance-engine 100.81.115.51) remains the out-of-band route.
rollback:
  core: hivemind/core-api:rollback-20260806-100604
  frontend_single: hivemind/fe:rollback-20260806-100604-single
  control: hivemind/control-plane:sha-556d95ec5      # unchanged this release
  employees: hivemind/employees:prod-20260804-runtime-campaign-86f70547
  tara_deepgram: hivemind/tara-deepgram:sha-bf7af3ca
  git: revert 9ac8203b..47d0122f; frontend gitlink back to d9fbb8316a67fae368138b430d83374876803f5c
aliases:
  stable: prod-20260806-7e1b07b9
  latest: prod-20260806-7e1b07b9
```

No customer email, connector action, telephone call, or write operation was triggered during
release acceptance. The eight disposable test documents created for scope and grounding
verification (WrapTest DE, WrapTest DE v2, ScopeTest x3, ScopeV2 x3 on org 1380251c) WERE
deleted afterwards, together with their 28 memories, and zero residual recall hits were
confirmed.

## prod-20260809-d878c42f — final chat synthesis on GPT-OSS-20B Nitro

- Parent SHA: `d878c42fe0b928c91d9362b9bcd31439af362493` on `singulance-main`.
- Frontend SHA: `e2dc70f437ea26bb919a19e23157670086b1be11` (unchanged by this release).
- Core image: `hivemind/core-api:sha-d878c42f`, digest `sha256:70c5cec4a3da1a3112d6f7a404a1140ba8acb223727c4abb3b99958bc3211281`.
- Migration: none.
- Model policy: default user-facing final synthesis is `openai/gpt-oss-20b:nitro` through OpenRouter. Progressive planning remains `google/gemini-2.5-flash-lite`; compound subtask selection remains its dedicated `cerebras/gpt-oss-120b`. Historical DeepSeek final-synthesis shadow/canary flags can no longer override or duplicate final answers. DeepSeek HQ awakening/dispatch workloads are outside this chat-final policy and unchanged.
- Compatibility: direct OpenRouter probe returned valid JSON in 401 ms and resolved Nitro to Groq. OpenRouter routing retains prompt-cache keys and does not set a manual provider order/sort that would override the Nitro variant.
- Tests: 56 focused provider, synthesis-policy, prompt-cache, router, native recall, evidence projection, use-tools, and compound/Composio isolation tests passed.
- Production acceptance: authenticated English brand recall, German color recall, and `use_tools:true` brand recall all returned 200, grounded answers, and trace model `openai/gpt-oss-20b:nitro`; no compound execution or drafts were created. Observed end-to-end times were 3.576 s, 5.926 s, and 5.392 s respectively. Core healthy, restarts 0, OOM false, and no fresh fatal/panic/uncaught/unhandled/OOM logs.
- Rollback: `hivemind/core-api:sha-5246cdd7`; manifest `/root/releases/d878c42f/RELEASE_MANIFEST.20260808T192925Z.json`.
- External side effects: none; no connector write, pending-write approval, email, document, calendar action, campaign, or memory mutation was executed.

## prod-20260809-0293df4d — progressive chat prompt-prefix caching

- Parent SHA: `0293df4da392b868dfc9cd7f364c84010f5277ba` on `singulance-main`.
- Frontend SHA: `b68eb71782fbf394c056550b304c7a6a769e7d49` (unchanged).
- Core image: `hivemind/core-api:sha-0293df4d`, digest `sha256:ceda195e4b075a5993307d52e38a0c246cb5aaee20838a1db2e034a7a0e1422d`.
- Migration: none.
- Change: stable router and grounded-synthesis contracts are first-message exact prefixes; OpenRouter receives a stable `prompt_cache_key`; Cerebras remains automatic. A bounded in-process CAG caches versioned static prompt artifacts. Evidence, history, user/profile context, connector results, tool arguments, drafts, approvals, and final answers are not cached by this layer.
- Telemetry: per-stage cached/uncached/cache-write tokens, aggregate hit ratio, static/dynamic character and estimated-token contribution, and static-prompt CAG hit/miss/fingerprint.
- Tests: 55 focused chat/recall/evidence/compound tests passed after rebase; 43 focused tests passed after the explicit system-message split. Six broader local files could not load the unavailable macOS ARM `singulance-amr` binary and did not execute; production route acceptance below covers the running Linux image.
- Production measurement, tenant-scoped read-only `/api/chat`: static CAG was a warm hit after first construction. Provider reuse observed `0..2,048+` cached tokens per turn; cross-language English→German reused `2,048 / 4,664` prompt tokens (43.9%). Router static-prefix hits reached `1,792` tokens; synthesis stable-prefix hits reached `256` tokens. Dynamic evidence-prefix reuse was variable and added up to `1,024` tokens in the measured sample. Provider caching remains opportunistic/ephemeral, not guaranteed per request.
- Acceptance: handbag brand and color recalls returned grounded answers; German recall returned `G ROCHER`; `use_tools:true` recall returned 200 with no execution, compound status, or drafts; Core and public site health returned 200; Core healthy, restart count 0, OOM false, and no fresh fatal/panic/uncaught/unhandled/OOM logs.
- Rollback: `hivemind/core-api:sha-66312a29` (also tagged `hivemind/core-api:rollback`); manifest `/root/releases/0293df4d/RELEASE_MANIFEST.20260808T185149Z.json`.
- Known operational gap: the canonical release script deployed and verified the immutable SHA override but did not refresh the legacy `VERSION`/`NEXT_VERSION` values in `.env`; runtime truth is the container image, OCI revision label, deploy override, and release manifest above.
- External side effects: none; no connector read/write, pending-write approval, email, document creation, calendar operation, campaign, or memory mutation was executed.

## prod-20260808-e70585b8e7ac — hosted connection-aware Composio workflow planner

- Parent SHA: `e70585b8e7ac5be4aacf2d70f97fa7381a352b5b` on `singulance-main`; includes concurrent runtime guard SHA `9fbd5f11` and hosted-planner feature parent `c0c38526`.
- Frontend SHA: `e2dc70f437ea26bb919a19e23157670086b1be11` (unchanged).
- Core image: `hivemind/core-api:prod-20260808-e70585b8e7ac`, digest `sha256:dfd53f40b2b070f2eae30798cf11cc9e52ae4d827885242bbfd74660b55a42cf`.
- Migration: none. Runtime flags: `CHAT_ROUTER=progressive`, `COMPOUND_ORCHESTRATOR_ENABLED=true`, `HOSTED_COMPOSIO_PLANNER_ENABLED=true`.
- Contract: authenticated `POST /api/composio/plan` discovers only the tenant's ACTIVE Composio providers and returns a bounded sequential DAG across hosted HIVE-MIND and connected-app capabilities. `use_tools:false` retains the pre-existing native path. `use_tools:true` uses the hosted plan with an explicit fallback to the pre-existing progressive planner if planning fails before execution.
- Execution safety: each step has explicit read/write authority, semantic `output_kind`, compact canonical retrieval `query`, and prior-step dependencies. Provider reads execute immediately; writes remain pending-write approval drafts. Zero/multiple recipient resolution returns `needs_input`; unresolved, failed, or approval-pending dependencies block downstream steps. Composio Query Mode `/input` generates current provider arguments without executing the action, replacing the redundant second subtask argument-model call.
- Tests: 60 focused routing, synthesis, use-tools, hosted-planner, Composio, and compound tests passed; production image build gate passed 21 authorization/orchestration tests. A concurrent runtime-playbook test could not start locally because the workspace lacked optional package `oauth-1.0a`; the concurrent commit's own release ownership was preserved and its files were not modified here.
- Authenticated acceptance: planner-only 200 in 1.871 s, one attempt, three-step recall → Gmail recipient lookup → email-draft DAG, `side_effects_executed=false`, 2,689 total planner tokens with 1,792 provider-cached tokens. Native `use_tools:false` handbag recall returned grounded `G ROCHER` in 3.799 s with no execution fields. `use_tools:true` returned `needs_input` in 9.388 s after finding two Amar addresses; recall completed, dependent draft was blocked, and `draft_ids=[]`.
- Exact-image no-side-effect write probe: explicit recipient produced a complete `GMAIL_SEND_EMAIL` approval draft payload grounded in the full rank-one handbag memory (G ROCHER, JL, material and design details). Persistence was stubbed (`PROBE_DRAFT_NOT_PERSISTED`), and no provider write or email occurred.
- Public/runtime acceptance: Singulance homepage, HIVE-MIND frontend, API health, and Core health returned 200; Core, Control, Employees, and TARA healthy; frontend running; restarts 0; OOM false; fresh fatal/panic/uncaught/unhandled/OOM/migration error count 0.
- Superseded candidate: `prod-20260808-c0c38526727f` built and passed health but failed affected-route acceptance: planner-only intermittently returned an empty plan (502), and Gmail input generation supplied an invalid provider field. No draft/write occurred. It was replaced, not repaired in place, by this immutable release.
- Rollback: `hivemind/core-api:rollback-20260808-211230` (the immediately previous immutable candidate); pre-feature accepted runtime is retained as `hivemind/core-api:rollback-20260808-210725` / `sha-5605b858`. Env backup before flag enable: `/root/hivemind/.env.pre-hosted-planner-c0c38526`.
- External side effects: Gmail recipient lookup read only. No pending-write row persisted, no approval executed, and no email/document/calendar/provider mutation occurred.
