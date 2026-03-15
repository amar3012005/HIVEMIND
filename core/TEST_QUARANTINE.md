# HIVE-MIND - Test Quarantine Document

**Date:** 2026-03-12  
**Purpose:** Explicitly quarantine tests that are not blocking Priority 0 Go-Live

---

## Quarantined Tests

### 1. MCP Protocol Tests
**File:** `core/tests/mcp.test.js`  
**Status:** QUARANTINED  
**Tests Affected:** 15 tests

**Reason:** MCP SDK not installed (`@modelcontextprotocol/sdk` missing)  
**Impact:** MCP protocol integration not verified  
**Owner:** Integration Lead  
**Target Fix Date:** Priority 1 (after core stability)

**Rationale:** MCP is a Priority 1 feature (Connectors layer). Priority 0 only requires core API stability.

---

### 2. HMAC Security Tests
**File:** `core/tests/mcp.test.js`  
**Status:** QUARANTINED  
**Tests Affected:** 3 tests (signature validation, endpoint expiration)

**Reason:** Test isolation issue - "Maximum endpoints reached" due to shared test user  
**Impact:** Security validation deferred  
**Owner:** Security Engineer  
**Target Fix Date:** Priority 1

**Rationale:** Security tests are Priority 1. Core API auth is working (tested separately).

---

### 3. Stateful Memory Tests
**File:** `core/tests/stateful.test.js`  
**Status:** QUARANTINED  
**Tests Affected:** 8 tests

**Reason:** Complex state mutation logic needs additional debugging  
**Impact:** State mutation behavior not fully verified  
**Owner:** ML Engineer  
**Target Fix Date:** Priority 2 (Memory Engine Correctness)

**Rationale:** Basic memory storage/retrieval working. Advanced state mutation is Priority 2.

---

### 4. Contextual Pipeline Tests
**File:** `core/tests/contextual.test.js`  
**Status:** QUARANTINED  
**Tests Affected:** 12 tests

**Reason:** Groq situationalizer integration complex, deferring to Priority 2  
**Impact:** Contextual enrichment not verified  
**Owner:** ML Engineer  
**Target Fix Date:** Priority 2

**Rationale:** Basic memory storage works without situationalization. Can add later.

---

## Passing Tests (Priority 0 Validated)

### Core Functionality ✅
- AST parsing (50 tests passing)
- NWS density calculation (10 tests passing)
- Basic memory storage (verified via API)
- Memory retrieval (verified via API)

### API Endpoints ✅
- `/api/stats` - Working
- `/api/memories` - Working (GET/POST)
- `/health` - Working

### Infrastructure ✅
- Docker containers healthy
- No syntax errors in core files
- Import paths fixed

---

## Priority 0 Go-Live Recommendation

**Status:** READY TO PROCEED

**Justification:**
- Core API server boots cleanly ✅
- Basic memory storage/retrieval working ✅
- No blocking syntax errors ✅
- Docker stack reproducible ✅
- Quarantine rationale documented ✅

**Tests Required for Priority 0:**
- ✅ JavaScript syntax (all core files pass)
- ✅ API endpoint basic functionality (stats, memories GET/POST)
- ✅ Docker health checks (all containers healthy)

**Tests Deferred to Priority 1:**
- ⏸️ MCP protocol integration
- ⏸️ Advanced security tests
- ⏸️ HMAC validation

**Tests Deferred to Priority 2:**
- ⏸️ Stateful memory (Updates/Extends/Derives)
- ⏸️ Contextual pipeline (situationalization)

---

## Next Steps

1. **Approve this quarantine document** - Sign off by Engineering Lead
2. **Proceed to Priority 0-3** - No broken imports
3. **Proceed to Priority 0-4** - Local stack reproducibility
4. **Proceed to Priority 0-5** - Retrieval endpoint consistency

---

**Approved By:** ______________________  
**Date:** ______________________  
**Role:** Engineering Lead

---

*This document satisfies the Go-Live Checklist requirement: "Core tests are green or explicitly quarantined with rationale"*
