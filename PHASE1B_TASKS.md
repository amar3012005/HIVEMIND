# Phase 1b Task List: Server Integration & Validation

**Status:** Ready to begin  
**Prerequisites:** ✅ Schema migrated | ✅ Services created | ✅ Feature flags added  
**Objective:** Wire document-first services into existing routes with feature flags, validate behavior, deploy safely

---

## Task 1: Initialize Evidence Qdrant Collection

**Why:** Need separate vector collection for evidence segments

**Steps:**
1. Create `core/src/scripts/init-evidence-collection.js`:
   ```javascript
   // Initialize hivemind_evidence Qdrant collection
   // Vector size: 1024 (Mistral embeddings)
   // Fields: segment_id, document_id, user_id, org_id, segment_type
   ```

2. Add collection initialization to server bootstrap:
   ```javascript
   // In server.js, on startup
   if (process.env.EVIDENCE_QDRANT_COLLECTION) {
     await qdrantClient.ensureCollection({
       name: process.env.EVIDENCE_QDRANT_COLLECTION,
       vectorSize: 1024,
       distance: 'Cosine'
     });
   }
   ```

3. Test collection creation:
   ```bash
   ENABLE_DOCUMENT_FIRST_INGEST=true node core/src/scripts/init-evidence-collection.js
   ```

**Acceptance:** Evidence collection exists in Qdrant, separate from memory collection

---

## Task 2: Instantiate Services in Server Bootstrap

**Why:** Make services available to routes

**Steps:**
1. Import services in `core/src/server.js`:
   ```javascript
   import { DocumentFirstIngestionService } from './knowledge/document-first-ingestion.js';
   import { EvidenceRetrievalService } from './knowledge/evidence-retrieval.js';
   ```

2. Instantiate after existing services (around line 100):
   ```javascript
   // Phase 1: Document-backed memory services
   let documentFirstIngestion = null;
   let evidenceRetrieval = null;

   if (process.env.ENABLE_DOCUMENT_FIRST_INGEST === 'true') {
     documentFirstIngestion = new DocumentFirstIngestionService({
       db: prisma,
       smartIngestRouter,
       memoryGraphEngine,
       doclingAdapter: null, // Optional, add when Docling service available
       embeddingService
     });
     console.log('[Phase1] DocumentFirstIngestionService enabled');
   }

   if (process.env.ENABLE_EVIDENCE_RECALL === 'true') {
     evidenceRetrieval = new EvidenceRetrievalService({
       db: prisma,
       qdrantClient
     });
     console.log('[Phase1] EvidenceRetrievalService enabled');
   }
   ```

**Acceptance:** Server starts successfully with services instantiated when flags are on

---

## Task 3: Add Feature-Flagged KB Upload Route

**Why:** Enable document-first path for KB uploads

**Steps:**
1. Find existing KB upload route in `core/src/server.js` (around line 800-900):
   ```javascript
   router.post('/api/knowledge/document', authenticateToken, upload.single('file'), async (req, res) => {
     // Current implementation
   });
   ```

2. Add dual-path logic:
   ```javascript
   router.post('/api/knowledge/document', authenticateToken, upload.single('file'), async (req, res) => {
     const userId = req.user.userId;
     const orgId = req.user.orgId;

     try {
       // Feature-flagged: document-first path
       if (process.env.ENABLE_DOCUMENT_FIRST_INGEST === 'true' && documentFirstIngestion) {
         const result = await documentFirstIngestion.ingestKnowledgeDocument({
           userId,
           orgId,
           filename: req.file.originalname,
           fileBuffer: req.file.buffer,
           contentType: req.file.mimetype,
           metadata: {
             tags: req.body.tags ? req.body.tags.split(',') : []
           }
         });

         return res.json({
           success: true,
           mode: 'document_first',
           documentId: result.documentId,
           segmentCount: result.segmentCount,
           candidateCount: result.candidateCount,
           promotedCount: result.promotedCount,
           promotedMemoryIds: result.promotedMemoryIds
         });
       }

       // Fallback: existing chunk-memory path
       // ... existing implementation ...
     } catch (error) {
       console.error('[KB Upload] Error:', error);
       res.status(500).json({ error: 'Upload failed', details: error.message });
     }
   });
   ```

**Acceptance:** KB upload works with flag off (old path), works with flag on (new path), returns mode indicator

---

## Task 4: Add Feature-Flagged Enterprise Upload Route

**Why:** Enable document-first path for enterprise uploads

**Steps:**
1. Find existing enterprise upload route in `core/src/server.js` (around line 1200-1400):
   ```javascript
   router.post('/api/enterprise/upload/ingest', authenticateToken, upload.single('file'), async (req, res) => {
     // Current implementation
   });
   ```

2. Add dual-path logic (similar to Task 3, but call `ingestEnterpriseDocument` with schema param)

**Acceptance:** Enterprise upload works with flag off (old path), works with flag on (new path)

---

## Task 5: Add Evidence Retrieval Endpoints

**Why:** Expose evidence search separate from canonical memory recall

**Steps:**
1. Add evidence search route:
   ```javascript
   router.post('/api/evidence/search', authenticateToken, async (req, res) => {
     if (!evidenceRetrieval) {
       return res.status(501).json({ error: 'Evidence retrieval not enabled' });
     }

     const { query, limit = 10, documentId } = req.body;
     const userId = req.user.userId;
     const orgId = req.user.orgId;

     try {
       const results = await evidenceRetrieval.retrieveEvidence({
         query,
         userId,
         orgId,
         limit,
         documentId
       });

       res.json({
         success: true,
         mode: 'evidence',
         results,
         count: results.length
       });
     } catch (error) {
       console.error('[Evidence Search] Error:', error);
       res.status(500).json({ error: 'Evidence search failed', details: error.message });
     }
   });
   ```

2. Add hybrid retrieval route:
   ```javascript
   router.post('/api/evidence/hybrid', authenticateToken, async (req, res) => {
     if (!evidenceRetrieval) {
       return res.status(501).json({ error: 'Evidence retrieval not enabled' });
     }

     const { query, memoryLimit = 5, evidenceLimit = 5 } = req.body;
     const userId = req.user.userId;
     const orgId = req.user.orgId;

     try {
       const results = await evidenceRetrieval.retrieveHybrid({
         query,
         userId,
         orgId,
         memoryLimit,
         evidenceLimit
       });

       res.json({
         success: true,
         mode: 'hybrid',
         memories: results.memories,
         evidence: results.evidence,
         memoriesCount: results.memories.length,
         evidenceCount: results.evidence.length
       });
     } catch (error) {
       console.error('[Hybrid Retrieval] Error:', error);
       res.status(500).json({ error: 'Hybrid retrieval failed', details: error.message });
     }
   });
   ```

3. Add memory → evidence endpoint:
   ```javascript
   router.get('/api/evidence/memory/:memoryId', authenticateToken, async (req, res) => {
     if (!evidenceRetrieval) {
       return res.status(501).json({ error: 'Evidence retrieval not enabled' });
     }

     const { memoryId } = req.params;

     try {
       const evidenceLinks = await evidenceRetrieval.getMemoryEvidence(memoryId);

       res.json({
         success: true,
         memoryId,
         evidenceLinks,
         count: evidenceLinks.length
       });
     } catch (error) {
       console.error('[Memory Evidence] Error:', error);
       res.status(500).json({ error: 'Failed to get memory evidence', details: error.message });
     }
   });
   ```

4. Add document → evidence endpoint:
   ```javascript
   router.get('/api/evidence/document/:documentId', authenticateToken, async (req, res) => {
     if (!evidenceRetrieval) {
       return res.status(501).json({ error: 'Evidence retrieval not enabled' });
     }

     const { documentId } = req.params;
     const userId = req.user.userId;
     const orgId = req.user.orgId;

     try {
       const result = await evidenceRetrieval.getDocumentEvidence({
         documentId,
         userId,
         orgId
       });

       if (!result) {
         return res.status(404).json({ error: 'Document not found or access denied' });
       }

       res.json({
         success: true,
         document: result.document,
         segments: result.segments,
         linkedMemories: result.linkedMemories,
         segmentCount: result.segments.length,
         memoryCount: result.linkedMemories.length
       });
     } catch (error) {
       console.error('[Document Evidence] Error:', error);
       res.status(500).json({ error: 'Failed to get document evidence', details: error.message });
     }
   });
   ```

**Acceptance:** All 4 new endpoints respond correctly, return 501 when feature flag off

---

## Task 6: Add Feature Flag Status Endpoint

**Why:** Allow clients to detect which features are enabled

**Steps:**
1. Add status endpoint:
   ```javascript
   router.get('/api/features', (req, res) => {
     res.json({
       document_first_ingest: process.env.ENABLE_DOCUMENT_FIRST_INGEST === 'true',
       evidence_recall: process.env.ENABLE_EVIDENCE_RECALL === 'true',
       memory_promotion_jobs: process.env.ENABLE_MEMORY_PROMOTION_JOBS === 'true',
       evidence_collection: process.env.EVIDENCE_QDRANT_COLLECTION,
       memory_collection: process.env.MEMORY_QDRANT_COLLECTION || process.env.QDRANT_COLLECTION
     });
   });
   ```

**Acceptance:** Endpoint returns current feature flag state

---

## Task 7: Update Health Check to Include Phase 1 Services

**Why:** Monitor service availability

**Steps:**
1. Find existing health check route in `core/src/server.js`:
   ```javascript
   router.get('/health', async (req, res) => {
     // Current checks
   });
   ```

2. Add Phase 1 checks:
   ```javascript
   const phase1Status = {
     document_first_ingestion: documentFirstIngestion ? 'enabled' : 'disabled',
     evidence_retrieval: evidenceRetrieval ? 'enabled' : 'disabled',
     evidence_collection_configured: !!process.env.EVIDENCE_QDRANT_COLLECTION
   };

   res.json({
     ...existingHealthData,
     phase1: phase1Status
   });
   ```

**Acceptance:** Health endpoint shows Phase 1 service status

---

## Task 8: Local Testing

**Why:** Validate behavior before deploying

**Test Cases:**

### Test 1: KB Upload with Flag Off
```bash
curl -X POST http://localhost:3002/api/knowledge/document \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -F "file=@test.pdf" \
  -F "tags=test"

# Expect: Old chunk-memory path, no documentId in response
```

### Test 2: KB Upload with Flag On
```bash
# In .env: ENABLE_DOCUMENT_FIRST_INGEST=true
curl -X POST http://localhost:3002/api/knowledge/document \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -F "file=@test.pdf" \
  -F "tags=test"

# Expect: documentId, segmentCount, candidateCount, promotedCount in response
```

### Test 3: Evidence Search
```bash
curl -X POST http://localhost:3002/api/evidence/search \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query": "test content", "limit": 5}'

# Expect: Evidence segments, not canonical memories
```

### Test 4: Hybrid Retrieval
```bash
curl -X POST http://localhost:3002/api/evidence/hybrid \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query": "test content", "memoryLimit": 3, "evidenceLimit": 3}'

# Expect: Both memories and evidence arrays
```

### Test 5: Memory → Evidence Links
```bash
# After uploading a document and getting promotedMemoryIds
curl -X GET http://localhost:3002/api/evidence/memory/MEMORY_ID \
  -H "Authorization: Bearer YOUR_TOKEN"

# Expect: Evidence links with segments and documents
```

### Test 6: Document → Evidence View
```bash
# After uploading a document and getting documentId
curl -X GET http://localhost:3002/api/evidence/document/DOCUMENT_ID \
  -H "Authorization: Bearer YOUR_TOKEN"

# Expect: Document metadata, segments, linked memories
```

### Test 7: Feature Flag Status
```bash
curl -X GET http://localhost:3002/api/features

# Expect: Feature flag states
```

### Test 8: Health Check
```bash
curl -X GET http://localhost:3002/health

# Expect: phase1 section in response
```

**Acceptance:** All 8 test cases pass

---

## Task 9: Database Validation

**Why:** Ensure data model integrity

**Queries:**

### Check Document Creation
```sql
SELECT id, title, document_type, source_platform, parse_status, word_count
FROM knowledge_documents
ORDER BY created_at DESC
LIMIT 5;
```

### Check Segment Creation
```sql
SELECT d.title, s.segment_type, s.segment_index, s.word_count, s.vector_stored
FROM knowledge_segments s
JOIN knowledge_documents d ON s.document_id = d.id
ORDER BY s.created_at DESC
LIMIT 10;
```

### Check Memory Promotion
```sql
SELECT m.title, m.memory_type, mel.link_type, mel.confidence, d.title AS source_document
FROM memories m
JOIN memory_evidence_links mel ON m.id = mel.memory_id
JOIN knowledge_documents d ON mel.document_id = d.id
ORDER BY m.created_at DESC
LIMIT 5;
```

### Check Memory Derivation
```sql
SELECT m.title, md.derivation_method, md.derivation_agent, md.confidence, md.review_status
FROM memories m
JOIN memory_derivations md ON m.id = md.memory_id
ORDER BY md.created_at DESC
LIMIT 5;
```

**Acceptance:** All queries return expected data after test uploads

---

## Task 10: Deployment Checklist

**Why:** Safe production rollout

**Steps:**

### Pre-Deploy
- [ ] All tests pass locally
- [ ] Feature flags off in production .env
- [ ] Migration SQL reviewed by second pair of eyes
- [ ] Rollback plan documented

### Deploy to Staging
- [ ] Apply migration: `npx prisma migrate deploy`
- [ ] Restart server: `pm2 restart hivemind-api`
- [ ] Verify health check shows phase1 section
- [ ] Test KB upload with flag off (should use old path)
- [ ] Test KB upload with flag on (should use new path)
- [ ] Monitor logs for errors
- [ ] Check Qdrant evidence collection created

### Deploy to Production
- [ ] Apply migration during low-traffic window
- [ ] Restart server with zero downtime (rolling restart)
- [ ] Verify health check
- [ ] Monitor error rates
- [ ] Keep flags off for 24 hours (validate zero impact)

### Enable for Test Users
- [ ] Enable flags for internal test accounts only
- [ ] Monitor document/segment/memory creation
- [ ] Compare canonical memory count (should be lower)
- [ ] Verify evidence retrieval works
- [ ] Collect feedback

### Gradual Rollout
- [ ] Enable for 10% of users
- [ ] Monitor for 48 hours
- [ ] Enable for 50% of users
- [ ] Monitor for 1 week
- [ ] Enable for 100% of users

**Acceptance:** Production deployment complete, flags off, zero impact verified

---

## Task 11: Documentation Updates

**Why:** Keep docs in sync with implementation

**Files to Update:**

1. `COMPANY_BRAIN.md`:
   - Add Phase 1 architecture section
   - Document new API endpoints
   - Add deployment notes

2. `API.md` (create if doesn't exist):
   - Document new evidence endpoints
   - Add request/response examples
   - Add feature flag behavior

3. `RUNBOOK.md`:
   - Add Phase 1 operational procedures
   - Add troubleshooting section for evidence collection
   - Add rollback procedure

**Acceptance:** Docs updated and reviewed

---

## Task 12: Frontend Integration (Optional Phase 1c)

**Why:** Allow users to see document/segment/promoted memory breakdown

**Steps:**
1. Update `frontend/Da-vinci/src/api/api-client.js`:
   - Add `searchEvidence(query, limit)`
   - Add `searchHybrid(query, memoryLimit, evidenceLimit)`
   - Add `getMemoryEvidence(memoryId)`
   - Add `getDocumentEvidence(documentId)`

2. Update KnowledgeBase component:
   - Show document count vs memory count
   - Show "View Evidence" button for promoted memories
   - Show segment count per document

3. Add EvidenceView component:
   - Display segments with highlighting
   - Show linked memories
   - Show document metadata

**Acceptance:** Frontend can display evidence separate from canonical memories

---

## Success Criteria

Phase 1b is complete when:
- ✅ Evidence Qdrant collection initialized
- ✅ Services instantiated in server bootstrap
- ✅ KB upload route feature-flagged
- ✅ Enterprise upload route feature-flagged
- ✅ 4 new evidence endpoints added
- ✅ Feature flag status endpoint added
- ✅ Health check updated
- ✅ All 8 local tests pass
- ✅ Database queries return expected data
- ✅ Deployed to staging with flags off
- ✅ Deployed to production with flags off
- ✅ Zero existing functionality broken
- ✅ Documentation updated

---

## Timeline Estimate

| Task | Estimated Time |
|------|----------------|
| Task 1: Qdrant collection init | 1 hour |
| Task 2: Service instantiation | 1 hour |
| Task 3: KB upload route | 2 hours |
| Task 4: Enterprise upload route | 2 hours |
| Task 5: Evidence endpoints | 3 hours |
| Task 6: Feature flag endpoint | 0.5 hours |
| Task 7: Health check update | 0.5 hours |
| Task 8: Local testing | 2 hours |
| Task 9: Database validation | 1 hour |
| Task 10: Deployment | 4 hours |
| Task 11: Documentation | 2 hours |
| **Total** | **~19 hours** |

Task 12 (frontend) is optional and adds ~8 hours.

---

## Next Immediate Action

**Start with Task 1:** Create `core/src/scripts/init-evidence-collection.js` to initialize the evidence Qdrant collection.

**Command:**
```bash
cd /Users/amar/HIVE-MIND/core/src/scripts
# Create init-evidence-collection.js
# Then run: ENABLE_DOCUMENT_FIRST_INGEST=true node init-evidence-collection.js
```
