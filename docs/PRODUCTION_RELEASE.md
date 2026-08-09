# Current SINGULANCE Production Release

## prod-20260809-5d4e08e3 — generalized inline human input + grounded governed actions

- Parent/Core SHA: `5d4e08e3a333ee516dfc6acc14e5174c91de1aa6` on `singulance-main`; Core image `hivemind/core-api:sha-5d4e08e3`, image ID `sha256:7e92dac2937e1196d7e8f3e4cb6fed78510969405c03ee0839740a15689540cb`.
- Frontend source SHA: `f864c0a2e2b7064c398c2746f9971333a208607f`; unchanged accepted frontend image `hivemind/fe:sha-96ed8afe`, image ID `sha256:99f01743c53bea6d2d58ecb677c74aa471f7ddaa23dbc44f7943c8e5eeea065d` (parent image revision `96ed8afe`, exact gitlink points to `f864c0a2`).
- UX: Overview, side-panel Chat, and mobile now render approvals, arbitrary field input, continuation choices, project/save-scope choices, and cancel states directly on the chat background. There are no outer action cards; headings are bold, exact values are visible, and actions use rectangular inline buttons. Pending actions explain what finished, why HIVE-MIND paused, and that nothing external has happened.
- Generalized continuation: server accepts only declared server-owned fields, validates required values, binds the continuation to tenant/user, resumes the paused step, and retains completed dependencies instead of replaying recall/provider reads.
- Governed content: Query Mode remains primary. Unresolved templates and dependency-content loss are detected structurally plus by grounded overlap; one scoped synthesis fallback sees the complete bounded recall projection before a compact provider schema; an exact server-verified content fallback prevents evidence from being hidden by schema truncation. Missing data still pauses for inline input.
- Compound robustness: read/write authority remains separate from semantic operation. Terminal communication selects the provider send capability unless the structured planner operation specifically requests a provider draft. A later write missing its dependency edge inherits prior read/recall steps; capability discovery/selection receives one side-effect-free retry. Provider writes themselves are never auto-retried and remain pending approval.
- Tests: 42 focused Core tests passed; 3 shared frontend interaction-contract tests passed; frontend production build completed; syntax and `git diff --check` passed.
- Authenticated acceptance: the handbag-to-email request was run twice with `use_tools:true`. Both completed recall and returned `pending` `composio_gmail_send_email` actions for `amarsai2005@gmail.com`; bodies were 685 and 1,759 characters and both contained `G ROCHER` and `JL`. Drafts `0a80f7c9-4243-48b9-8b45-52b5c72d7224` and `b69feefc-387f-43b1-8327-232ba2737a41` were cancelled; database verification showed `status=cancelled`, `sentAt=null`, and tool `GMAIL_SEND_EMAIL` for both.
- Runtime acceptance: Core healthy, frontend running, zero restarts; public Core/home/login/Overview all returned 200; frontend served chunk `4676.aa4090dd.chunk.js` contains the inline interaction markers; fresh fatal/panic/uncaught/unhandled/OOM/migration error counts are zero.
- Migration: none. Rollback Core: `hivemind/core-api:rollback-pre-5d4e08e3-20260808T234149Z`; frontend remains independently rollback-safe from the previous accepted frontend release. Manifest: `/root/releases/5d4e08e3-clean/RELEASE_MANIFEST.20260808T234149Z.json`.
- Intentionally untested side effect: no Send button was clicked and no email was sent.

## prod-20260809-68ec3448 — Slack stage progress + exact governed email preview/send

- Parent SHA: `68ec34485ba25687f62371eb51811f3949b412e8` on `singulance-main`.
- Frontend SHA: `bbc8e7aac91208868419bff5eafd76aa5cd84be7` on Da-vinci `main` and recorded by the parent gitlink.
- Images: Core `hivemind/core-api:sha-68ec3448`, image ID `sha256:86c888f5407eb2ac58aff36c55387edaf60d1876ab7cc8de7da58d2ccef31d8d`; frontend `hivemind/fe:sha-68ec3448`, image ID `sha256:d18b553c4b2586effb3461322daa6d7695bc331840b03d7befa5c40361af5bee`.
- Migration: none.
- Slack: `@HIVEMIND` event-ingest now forwards the agent `onEvent` stream into one throttled in-place Slack message. Native recall/save and compound connector steps show stable stage rows; queued progress writes drain before the final answer. Connected tools are eligible on Slack unless `SLACK_CHAT_USE_TOOLS=false`; existing history and project-selection behavior remain intact.
- Governed writes: compound responses now include `pending_actions` with the exact immutable tool arguments already persisted for approval. Desktop Overview, Chat, and mobile render complete email recipient, subject, and body plus one-click Send/Cancel actions. Semantic tool selection prefers the requested terminal provider effect because HIVE-MIND already owns the approval preview; a provider create-draft remains eligible only when that is the requested terminal outcome.
- Tests: 37 focused Core routing, use-tools, compound/Composio, and Slack progress tests passed; 2 frontend approval-contract tests passed; clean frontend production build completed.
- Authenticated acceptance: the exact request `find me everything u know about my company and then write a mail to amarsai2005@gmail.com about it` returned 200, completed HIVE-MIND recall, selected `composio_gmail_send_email`, and returned a full `pending_actions[0]` containing recipient `amarsai2005@gmail.com`, subject, and complete body. The acceptance draft `50b0ba08-24d7-4289-8964-7dc54367c028` was cancelled with 200; no email/provider write was executed.
- Runtime acceptance: Core internal/public health, homepage, login, and Overview returned 200; exact Core/frontend revision labels match `68ec3448`; restarts are zero; frontend served chunks contain the new approval markers; fresh fatal/panic/uncaught/unhandled/OOM/migration error counts are zero.
- Release-script incident: the server's stale canonical script initially recreated frontend from `sha-5246cdd7` while failing to gate its own revision mismatch. The release was not accepted in that state. The exact `sha-68ec3448` frontend and Core were then rendered with explicit immutable Compose overrides under the release lock, `VERSION`/`NEXT_VERSION` were set to this release, and provenance was re-verified.
- Rollback: Core `hivemind/core-api:prod-20260809-8c8e2276`; frontend `hivemind/fe:sha-8c8e2276`; manifest `/root/releases/68ec3448/RELEASE_MANIFEST.20260808T222458Z.json` plus explicit overrides `/root/releases/68ec3448/{core,frontend}-68ec3448.yml`.
- Intentionally untested side effect: the Send button was not clicked during acceptance, so no customer email was sent. Approval execution remains the existing tenant-scoped `/api/pending-writes/:id/approve` path.

## prod-20260809-8c8e2276 — streamed chat orchestration, generalized Composio planning, resumable choices

- **Deployed:** 2026-08-08T21:56Z UTC (release date 2026-08-09 Asia/Kolkata)
- **Parent:** `singulance-main` runtime SHA `8c8e2276a6cb5516184f9d47f641483a2ebdceb4`
- **Frontend source:** `8108fbecef442a57c25b20ca80e4220ca56625e0`; running image `hivemind/fe:prod-20260809-a1829df2-single`, digest `sha256:da57722c1076833d83135f51f027910e16bad058d8763c8e83ee065445884810` (same chat UI source; parent label predates later backend-only fixes).
- **Core image:** `hivemind/core-api:prod-20260809-8c8e2276`, digest `sha256:6bd8bc2b6d0ab947c03a5f41feebe4e3033f4d7fe8c113836a3fdc4cd2e16697`, healthy with matching OCI revision.
- **Changes:** canonical `orchestration_plan` / `orchestration_step` SSE events; shared expandable Reasoning timeline with provider logos on Overview and mobile; opaque tenant-bound single-use continuation tokens; choice buttons resume blocked dependencies without replaying completed recall/provider reads; ACTIVE Composio toolkit inventory replaces the closed toolkit allowlist; one provider-error-guided retry for failed reads only; pending-write hashes are bounded SHA-256.
- **Governance:** `use_tools:false` native path unchanged; writes remain pending approval; read repair never retries writes; continuation state is server-side with a 15-minute TTL and scope check.
- **Tests:** 33 focused planner/orchestrator policy tests passed; frontend production build compiled (repository-wide pre-existing lint warnings prevent `CI=true` warning-as-error); JS syntax and `git diff --check` passed.
- **Authenticated acceptance:** tenant `0a1d5b33-…` ran recall + Gmail recipient lookup and received two choices. Choosing `amarsai2005@gmail.com` resumed only step 3 and created draft `f2352fe6-d4b3-47d6-b32c-f200004532b3`; persisted `status=draft`, `sentAt=null`, tool `GMAIL_CREATE_EMAIL_DRAFT`, 64-char args hash. Native handbag recall returned grounded `G ROCHER` with no compound status.
- **Public checks:** Core health 200, Control health 200, frontend app 200; fresh fatal-pattern count zero for Core and frontend.
- **Migrations:** none.
- **Rollback:** Core `hivemind/core-api:rollback`; frontend `hivemind/fe:rollback-single`; env backups `/root/hivemind/.env.bak-prod-20260809-*` and `/root/hivemind-next/.env.embedding-canary-runtime.bak-prod-20260809-*`.

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

## prod-20260809-3cce168a — hosted-plan completeness and connector-intent preservation

- Parent SHA: `3cce168a897284a996fa40ab6d544395d6279051` on `singulance-main`.
- Frontend SHA: `f864c0a2e2b7064c398c2746f9971333a208607f` (unchanged).
- Core image: `hivemind/core-api:sha-3cce168a`, OCI revision `3cce168a897284a996fa40ab6d544395d6279051`.
- Migration: none.
- Fix: every hosted Composio workflow proposal receives one semantic audit against the exact current request. The audit restores omitted terminal actions and preserves the requested application, artifact, recipient, dependencies, and action semantics without language-specific or toolkit-keyword routing patches. A structurally complete plan can no longer pass solely because it has multiple steps.
- Tests: 45/45 focused hosted-planner, compound-orchestrator, `use_tools` policy, and chat-router architecture tests passed, including omitted-action and equal-length substituted-connector regressions. Syntax and whitespace checks passed.
- Authenticated acceptance: the exact request `Recall all information about my company, then put the recalled information into a new Google Doc.` was run twice with `use_tools:true`. Both runs returned 200 and `recall -> create_doc`; both selected `composio_googledocs_create_document` and persisted approval drafts with non-empty title and substantive recalled company text. Both diagnostic drafts were cancelled; no Google Doc was created.
- Public/runtime acceptance: Core health returned 200; container healthy, restarts 0, and fresh fatal/panic/uncaught/unhandled/OOM/migration-error count 0.
- Superseded candidate: `hivemind/core-api:sha-aada9ce0` restored the omitted terminal step but a live acceptance exposed an equal-length Gmail-for-Docs substitution. Its diagnostic Gmail draft was cancelled, nothing was sent, and the candidate was replaced by this immutable release.
- Rollback: `hivemind/core-api:rollback-pre-3cce168a-20260809T074244Z`; manifest `/root/releases/3cce168a-clean/RELEASE_MANIFEST.txt`.
- External side effects: HIVE-MIND recall reads and pending-write draft persistence only. All three diagnostic drafts were cancelled; no approval, email send, Google Doc creation, calendar action, or memory mutation executed.

## prod-20260809-1f12a0b0 — grounded follow-up connector content and refined tools control

- Parent SHA: `1f12a0b0717376f2e753b88232c5e1ede3bd5981` on `singulance-main`.
- Frontend SHA: `1cf1b89401f1595c6a0ce997b40d5491b3eeeb9c` (includes chat UI SHA `422c34f984041647d87b5c8337f5709e865cdea1`).
- Images: `hivemind/core-api:prod-20260809-1f12a0b0`, OCI revision `1f12a0b0717376f2e753b88232c5e1ede3bd5981`; `hivemind/fe:prod-20260809-1f12a0b0-single`, OCI revision `1cf1b89401f1595c6a0ce997b40d5491b3eeeb9c`.
- Migration: none.
- Backend: content-producing follow-up actions receive the preceding assistant answer as bounded, explicitly untrusted data alongside governed recall. Query Mode must create substantive grounded content, and provider-required content fields are honored whether declared in `required`, `properties`, or both. Existing approval and Composio execution boundaries are unchanged.
- Frontend: Overview, mobile Talk to HIVE, and side-panel chat no longer duplicate the current request in history. The `Use tools` control is now a compact blue/ivory status capsule with a Sparkles state icon and live status dot; the one-line Beta notice remains.
- Tests/build: 47/47 focused compound, hosted-planner, `use_tools`, and router tests passed after final rebase. Frontend production build compiled successfully; strict-CI mode remains blocked by the repository's pre-existing unrelated lint warnings.
- Authenticated acceptance: `write an email to amarsai2005@gmail.com about DLLMs` with prior DLLM answer context and `use_tools:true` returned 200, executed recall, and created a governed `composio_gmail_send_email` approval draft. The exact body included parallel denoising, faster inference/lower latency, sub-100 ms warmed latency, and efficient batching. The final diagnostic draft was cancelled; an earlier candidate draft expired. Database verification showed both `approvedAt=null` and `sentAt=null`.
- Public/runtime acceptance: Core health, homepage, HIVE-MIND cover, and Overview returned 200. Both release-specific lazy chat chunks returned 200 and contained the connected-app Beta notice marker. Core healthy, frontend running, restarts 0, and fresh fatal/panic/uncaught/unhandled/OOM/migration-error count 0.
- Rollback: Core `hivemind/core-api:rollback-pre-1f12a0b0-20260809T102619Z`; frontend `hivemind/fe:rollback-pre-1f12a0b0-20260809T102619Z-single`; manifest `/root/builds/prod-20260809-1f12a0b0/RELEASE_MANIFEST.txt`.
- External side effects: recall reads and approval-draft persistence only. No draft was approved and no email was sent.

## prod-20260809-637fd2df — preserve recall dependencies for semantic content artifacts

- Parent SHA: `637fd2df94785d0662c882cf547b2578336f7747` on `singulance-main`.
- Frontend SHA: `794ae726f4ae1479870d4f9e8cb978891209cdfa` (unchanged by this fix).
- Images: Core `hivemind/core-api:sha-637fd2df`, digest `sha256:6f593a714e66998730418f3d8f5d115f9422bd4de40161cff76b36d18fda38f3`; Control `sha256:fca50b227b304454ea043bcdea087aa20b35c1fec72ba934a3f6e924da13be10`; Employees `sha256:864e72acb6e39674bcf0d252b4985d6bd8a76107adf308fe9f47bb44d76b23fd`; frontend `sha256:aea45f47794445311c948923b8f1c1e1ca2ecead442efc294ab3ac9802893d2e`. All carry OCI revision `637fd2df94785d0662c882cf547b2578336f7747`.
- Migration: none.
- Fix: dependency normalization now treats semantic `message` and `document` outputs as content-producing artifacts even if the hosted planner emits an imprecise authority. Earlier governed reads therefore reach provider argument generation and required body/text fields instead of producing a redundant human-input request. Hybrid recall and its ranking/delivery contract are unchanged; approval gating remains unchanged.
- Tests: syntax and whitespace checks passed; 43/43 focused compound-orchestrator, hosted-planner, `use_tools`, and router tests passed. The regression suite includes the exact recall-to-email shape with malformed authority, an omitted dependency edge, a provider-required body absent from `properties`, and a substantive recalled fact.
- Authenticated acceptance: `write email to amarsai2005@gmail.com about all company information` with `use_tools:true` returned 200 in 13.385 s. `hivemind_recall` completed, `composio_gmail_send_email` produced approval draft `b771057d-6db2-4735-a995-ad06cc804f5e`, and the body contained substantive recalled company details rather than requesting `body` from the user. The diagnostic draft was cancelled; database verification showed `status=cancelled`, `approvedAt=null`, and `sentAt=null`.
- Public/runtime acceptance: Core health, homepage, HIVE-MIND cover, and Overview returned 200. Core, Control, and Employees were healthy; frontend running; all restart counts 0; fresh fatal/panic/uncaught/unhandled/OOM/migration-error count 0.
- Rollback: immediately previous immutable images `hivemind/core-api:sha-981a2b04`, `hivemind/control-plane:sha-981a2b04`, `hivemind/employees:sha-981a2b04`, and `hivemind/fe:sha-981a2b04`; manifest `/root/releases/manifests/637fd2df/20260809T114712Z/RELEASE_MANIFEST.json`.
- External side effects: HIVE-MIND recall reads and approval-draft persistence only. The diagnostic draft was cancelled; no approval occurred and no email was sent.

## prod-20260809-0033d7fc — grounded email-recipient resolution and artifact revalidation

- Core source/runtime SHA: `0033d7fc5869a456d5b2d6957c12bf1a49373c6f` on `singulance-main`. Canonical branch subsequently advanced to frontend-only SHA `d07f92536dd967e6572515f6a64375b74f81217b`; that commit does not alter Core.
- Runtime tuple: Core `hivemind/core-api:sha-0033d7fc`, digest `sha256:7d24e516d67ac5f3cb9837dd9215f02e96859e79892d312eba9c9d13676d9c9c`, OCI revision `0033d7fc5869a456d5b2d6957c12bf1a49373c6f`; frontend independently advanced to `hivemind/fe:sha-d07f9253`. Migration: none.
- Recipient safety: email write arguments may use only an address explicitly supplied by the user or a unique typed recipient result from a preceding provider lookup. A raw display name such as `AmarSai` is never persisted into `To`, and an address appearing incidentally inside recalled company content cannot become the recipient.
- Generalized planning: when a recipient-resolution step feeds a connected provider action, the hosted planner assigns that lookup to the dependent provider rather than native HIVE-MIND recall. This is derived from the plan dependency and provider graph, without language-, name-, or Gmail-specific routing keywords.
- Content correctness: required artifact fields are revalidated after deterministic grounded-content backfill, eliminating the stale `Missing required fields: body` result when a substantive body is already present.
- Tests: 52/52 focused compound-orchestrator, hosted-planner, `use_tools` policy, and chat-router architecture tests passed after the final rebase.
- Named-recipient acceptance: `write email to AmarSai about all company information` used provider recipient lookup and found two real candidates (`amarsai2005@gmail.com`, `amarsai@example.com`). The workflow returned `needs_input` with choices, created no draft, and did not send an email.
- Explicit-recipient acceptance: `write email to amarsai2005@gmail.com about all company information` returned 200, completed HIVE-MIND recall, and created approval draft `8fc5de98-a95f-43d8-acd5-8f7b94482cc5` with exact `To: amarsai2005@gmail.com`, subject `Company Information`, and an 868-character body. The diagnostic draft was cancelled; database verification showed `status=cancelled`, `approvedAt=null`, and `sentAt=null`.
- Public/runtime acceptance: Core health reported DB, Qdrant, and Docling ready; homepage, HIVE-MIND cover, and Overview returned 200. Core was healthy with restart count 0 and no fresh fatal/panic/uncaught/unhandled logs.
- Rollback: `hivemind/core-api:sha-30b9f7a7`; manifest `/root/releases/manifests/0033d7fc/20260809T135628Z/RELEASE_MANIFEST.json`.
- Operational cleanup: only confirmed non-running superseded images and reclaimable build cache were removed to satisfy the immutable release disk gate. Active containers, application data, and the then-current rollback images were retained; removed images are recoverable by rebuilding their SHAs.
- External side effects: recipient lookup reads and approval-draft persistence only. No draft was approved and no email was sent.
