# Current SINGULANCE Production Release

This file is the deployment ledger. Update it only after production acceptance succeeds.

```yaml
release_id: prod-20260806-47d0122f
host: singulance
deployed_at_utc: 2026-08-06T04:34:26Z          # core image build; FE image 2026-08-06T03:49:43Z
parent:
  branch: singulance-main
  sha: 47d0122fe50cff417fe92fbb739d986aff6bb62a
frontend:
  sha: a60762b2b9ead565f6354096fbbab1053ddeb00b  # Da-vinci main — upload scope modal org tier selectable
runtime:
  VERSION: prod-20260806-47d0122f
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
  core: hivemind/core-api:sha-47d0122
  control: hivemind/control-plane:sha-556d95ec5                          # unchanged
  employees: hivemind/employees:prod-20260804-runtime-campaign-86f70547  # unchanged
  tara_deepgram: hivemind/tara-deepgram:sha-bf7af3ca                     # unchanged
  byod_agent: hivemind/hm-agent:sha-a95090c2                             # unchanged
  frontend_single: hivemind/fe:prod-20260806-c024cd5700a3-single
migration: none
changes:
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
    - fe_scope_modal_orgRole_derivation_present_in_served_bundle
  not_verified:                                  # recorded honestly; NOT accepted by this session
    - amr_recall_parity_lanes                    # parallel session's work; the only .amr org this
                                                 # session could use was emptied for testing, and the
                                                 # remaining .amr orgs are other tenants' workspaces
                                                 # whose memory content was deliberately not read
    - fe_scope_modal_click_through               # proven at API + served-bundle level only; needs a
                                                 # logged-in browser session
known_gaps:
  - Disk at 92% (26G free of 301G). Not urgent but the next few image builds will bite;
    rollback images accumulate (10+ core rollback tags present).
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
    Unbanned. Tailscale (singulance-engine 100.81.115.51) is the out-of-band route; adding
    100.64.0.0/10 to fail2ban ignoreip is proposed but NOT applied.
rollback:
  core: hivemind/core-api:rollback-20260806-042921
  frontend_single: hivemind/fe:rollback-20260806-042921-single
  control: hivemind/control-plane:sha-556d95ec5      # unchanged this release
  employees: hivemind/employees:prod-20260804-runtime-campaign-86f70547
  tara_deepgram: hivemind/tara-deepgram:sha-bf7af3ca
  git: revert 9ac8203b..47d0122f; frontend gitlink back to d9fbb8316a67fae368138b430d83374876803f5c
aliases:
  stable: prod-20260806-47d0122f
  latest: prod-20260806-47d0122f
```

No customer email, connector action, telephone call, or write operation was triggered during
release acceptance. The eight disposable test documents created for scope and grounding
verification (WrapTest DE, WrapTest DE v2, ScopeTest x3, ScopeV2 x3 on org 1380251c) WERE
deleted afterwards, together with their 28 memories, and zero residual recall hits were
confirmed.
