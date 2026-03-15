# HIVE-MIND - Implementation Tasks

**Date:** 2026-03-09  
**Phase:** Phase 2  
**Status:** Ready to Implement

---

## 📋 Task List

### Priority 1: Groq API Configuration
| Task | Status | File |
|------|--------|------|
| Configure Groq API key | ✅ Done | Environment variable |
| Test Groq API connectivity | ⏳ Pending | `scripts/test-groq.js` |
| Implement situationalization | ⏳ Pending | `src/situationalizer.js` |

### Priority 2: Contextual Retrieval Pipeline
| Task | Status | File |
|------|--------|------|
| Create situationalizer module | ⏳ Pending | `src/situationalizer.js` |
| Implement Groq integration | ⏳ Pending | `src/embeddings/groq-situation.js` |
| Add context injection before embedding | ⏳ Pending | `src/engine.local.js` |
| Test contextual chunks | ⏳ Pending | `tests/contextual.test.js` |

### Priority 3: AST-Aware Parser
| Task | Status | File |
|------|--------|------|
| Install tree-sitter | ⏳ Pending | `package.json` |
| Install language parsers | ⏳ Pending | `package.json` |
| Create AST parser module | ⏳ Pending | `src/ast/parser.js` |
| Implement scope chain construction | ⏳ Pending | `src/ast/scope.js` |
| Implement NWS density calculation | ⏳ Pending | `src/ast/density.js` |
| Create syntax-aware chunker | ⏳ Pending | `src/chunker.ast.js` |
| Test with sample code | ⏳ Pending | `tests/ast.test.js` |

### Priority 4: Stateful Memory Manager
| Task | Status | File |
|------|--------|------|
| Create PostgreSQL trigger | ⏳ Pending | `prisma/migrations/002_stateful/` |
| Implement isLatest mutation logic | ⏳ Pending | `src/stateful/mutator.js` |
| Add conflict resolution | ⏳ Pending | `src/stateful/resolver.js` |
| Test state mutation | ⏳ Pending | `tests/stateful.test.js` |

### Priority 5: Meta-MCP Bridge
| Task | Status | File |
|------|--------|------|
| User endpoint generation | ⏳ Pending | `src/mcp/bridge.js` |
| Cross-app sync protocol | ⏳ Pending | `src/mcp/sync.js` |
| MCP server completion | ⏳ Pending | `mcp-server/server.js` |
| Test cross-app sync | ⏳ Pending | `tests/mcp.test.js` |

---

## 🚀 Quick Start Commands

### Install Dependencies
```bash
cd /Users/amar/HIVE-MIND/core
npm install tree-sitter tree-sitter-javascript tree-sitter-typescript tree-sitter-python
```

### Configure Groq API
```bash
# 🔴 SECURITY NOTICE: Previous key was compromised
# Generate new key at https://console.groq.com/
# See: project_status/KEY_ROTATION_RECORD.md
export GROQ_API_KEY="your-new-groq-api-key-here"
export GROQ_EMBEDDING_MODEL="mistral-embed"
export GROQ_INFERENCE_MODEL="llama-3-3-70b-versatile"
```

### Run Tests
```bash
npm test
```

---

## 📊 Progress Tracking

| Component | % Complete | Notes |
|-----------|------------|-------|
| Groq API Setup | 100% | Key configured |
| Contextual Pipeline | 0% | Not started |
| AST Parser | 0% | Not started |
| Stateful Manager | 0% | Not started |
| Meta-MCP Bridge | 0% | Not started |
| **Overall** | **20%** | Foundation ready |

---

## 🎯 Weekly Goals

### Week 1 (Mar 9-15)
- [ ] Groq API connectivity test
- [ ] Situationalizer implementation
- [ ] AST parser setup

### Week 2 (Mar 16-22)
- [ ] AST parser for JS/TS
- [ ] Stateful memory triggers
- [ ] Contextual chunking tests

### Week 3 (Mar 23-29)
- [ ] Meta-MCP bridge
- [ ] Cross-app sync
- [ ] Performance optimization

### Week 4 (Mar 30 - Apr 5)
- [ ] End-to-end testing
- [ ] Documentation
- [ ] Go-live preparation

---

*Last updated: 2026-03-09*
