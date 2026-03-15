# HIVE-MIND Long-Term Memory

## Project Overview
**HIVE-MIND** - Cross-platform context preservation system with EU sovereign deployment.

---

## Key Milestones

### March 15, 2026 - Priority 4 Complete + Coolify Ready
**Status:** ✅ Production Ready

**Accomplishments:**
- ✅ PostgreSQL full-text search (keyword search)
- ✅ Apache AGE graph search with security fixes
- ✅ Graph expansion in recall (Updates/Extends/Derives)
- ✅ Three-Tier Retrieval (Quick/Panorama/Insight)
- ✅ Cross-platform test suite (46 tests)
- ✅ Retrieval evaluation system (Precision/Recall/F1/NDCG/MRR)
- ✅ Coolify deployment configuration
- ✅ EU sovereign compliance (GDPR/NIS2/DORA)

**Deployment:** Ready for Coolify (Hetzner/Scaleway/OVHcloud)

---

## Critical Implementations

### Retrieval System
- **Hybrid Search:** Vector + Keyword + Graph + Policy ranking
- **Three Tiers:** QuickSearch (<100ms), PanoramaSearch (<500ms), InsightForge (<3s)
- **Graph Expansion:** Traverses relationships to find related memories
- **Security:** Parameterized queries, UUID validation, multi-tenant isolation

### Testing & Evaluation
- **Cross-Platform Tests:** 46 tests covering Claude/GPT/MCP integration
- **Retrieval Metrics:** Precision@5, Recall@10, F1, NDCG@10, MRR
- **Evaluation Dataset:** 30 enterprise-like queries

### Deployment
- **Platform:** Coolify (EU sovereign cloud)
- **Security:** Non-root containers, no-new-privileges, cap_drop
- **Compliance:** GDPR_MODE, DATA_RESIDENCY=EU, EU_REGION=eu-central-1

---

## Important Files

### Core Implementation
- `/src/search/hybrid.js` - Hybrid search with PostgreSQL + AGE
- `/core/src/memory/persisted-retrieval.js` - Recall with graph expansion
- `/src/search/three-tier-retrieval.js` - Three-tier search

### Testing
- `/tests/cross-platform-handoff.test.js` - Cross-platform tests
- `/src/evaluation/retrieval-evaluator.js` - Evaluation engine

### Deployment
- `/coolify.yaml` - Main deployment config
- `/.env.coolify` - Production environment
- `/scripts/deploy-coolify.sh` - Deployment script

---

## Quick Commands

```bash
# Deploy
./scripts/deploy-coolify.sh production

# Test
npm run test:run

# Evaluate
node src/evaluation/run-evaluation.js --method hybrid

# Validate
./scripts/validate-coolify.sh
```

---

## Notes
- All Priority 4 requirements met
- Security vulnerabilities fixed (Cypher injection)
- EU sovereign deployment ready
- Comprehensive documentation available
