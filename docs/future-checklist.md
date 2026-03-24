# HIVEMIND — Future Implementation Checklist

## Evaluation System

### Current State (2026-03-24)
- Auto-eval endpoints exist but DISABLED for user-facing UI (fragile with Gmail/web-crawl noise)
- Endpoints still available at `/api/evaluate/*` for internal/admin use
- Frontend Evaluation page being rebuilt as Memory Health Dashboard

### Phase 1: Memory Health Dashboard (User-Facing) — IN PROGRESS
- [ ] Memory Health cards: total count, freshness distribution, source breakdown
- [ ] Search Tester: user types query, sees results, gives thumbs up/down feedback
- [ ] Retrieval Confidence: show vector similarity score per result
- [ ] Sync Status: active connectors, last sync, errors
- [ ] Memory Coverage: tag cloud, category distribution, timeline view

### Phase 2: LongMemEval Benchmark (Admin/Marketing) — PLANNED
- [ ] Download `longmemeval_s.json` from HuggingFace
- [ ] Build ingestion runner (`longmemeval-runner.js`)
- [ ] Build evaluation runner (`longmemeval-evaluate.js`)
- [ ] Run with GPT-4o judge (requires OpenAI API key, ~$15)
- [ ] Publish results on marketing site
- [ ] Targets: Overall >81.6%, KU >88.46%, TR >76.69%, MS >71.43%
- [ ] Full plan: `docs/longmemeval-benchmark-plan.md`

### Phase 3: LoCoMo + ConvoMem Benchmarks — FUTURE
- [ ] Implement LoCoMo dataset evaluation
- [ ] Implement ConvoMem dataset evaluation
- [ ] Cross-benchmark comparison dashboard (admin only)

## Gmail Connector

### Current Issues (2026-03-24)
- [ ] Email body extraction incomplete — many emails stored as subject-only
- [ ] HTML emails not being properly stripped to text
- [ ] Multipart MIME handling needs improvement (nested parts)
- [ ] Some emails ingested without body content (only snippet)
- [ ] Search can't find Gmail memories reliably — embedding quality for email content needs review

### Improvements Needed
- [ ] Improve body extraction: handle nested multipart/mixed, multipart/alternative
- [ ] Strip email signatures, disclaimers, quoted reply chains
- [ ] Chunk long email threads instead of storing full thread as one memory
- [ ] Add Gmail-specific search boost (search by sender, recipient, date range)
- [ ] Pub/Sub webhooks for real-time sync (currently polling only)
- [ ] Token refresh handling when access token expires

## Connectors Roadmap
- [ ] Slack — OAuth + channel sync
- [ ] GitHub — OAuth + issue/PR/commit sync
- [ ] Linear — OAuth + issue sync
- [ ] Notion — OAuth + page/database sync
- [ ] Google Calendar — OAuth + event sync

## Auth Improvements
- [ ] Auth-less consumer URL: fix base URL to always use public domain
- [ ] OAuth plugin connect: add refresh token support
- [ ] Container tags: add to frontend API key creation UI
- [ ] Scoped API keys: frontend UI for managing container tag restrictions
