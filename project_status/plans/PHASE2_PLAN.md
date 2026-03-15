# HIVE-MIND - Phase 2 Implementation Plan

**Date:** 2026-03-09
**Status:** Plans Created | Ready for Implementation

🔴 **SECURITY NOTICE:** Previous Groq API key was compromised. See `project_status/KEY_ROTATION_RECORD.md` for rotation instructions.

---

## 🎯 Goal: Match Supermemory.ai's Core Promises

| Gap | Current HIVE-MIND | Supermemory.ai Goal |
|-----|-------------------|---------------------|
| **Chunking** | Keyword/Basic Text | AST-Aware (Tree-sitter) |
| **Retrieval** | Direct Vector/Keyword | Contextual Situationalization |
| **State** | Manual isLatest | Automatic isLatest Mutation |
| **Connectivity** | Local MCP Server | Meta-MCP Bridge (Cross-App) |

---

## 📁 Implementation Plans

### Plan 1: Contextual Retrieval Pipeline
**File:** `project_status/plans/01-contextual-retrieval-pipeline.md`

**What:** Pre-Embedding Situationalizer using Groq API

**Key Features:**
- Lightweight LLM (Claude 3 Haiku / Mistral 7B) generates one-sentence context
- Context template: "This is from [SOURCE]; [ORIGINAL_TEXT]"
- Prevents failed retrievals when chunk is separated from source

**Effort:** 4.5 days

---

### Plan 2: AST-Aware Parser
**File:** `project_status/plans/02-ast-aware-parser.md`

**What:** Tree-sitter integration for code understanding

**Key Features:**
- Abstract Syntax Tree parsing for JS/TS/Python/Go/Rust/Java/C#
- Scope Chain construction (Class > Method > Block)
- NWS Density calculation for information density
- Syntax-aware chunking instead of basic text splitting

**Effort:** 9.5 days

---

### Plan 3: Stateful Memory Manager
**File:** `project_status/plans/03-stateful-memory-manager.md`

**What:** Automatic isLatest mutation within database

**Key Features:**
- PostgreSQL triggers for automatic state mutation
- Edge-Mutation when "Update" relationship detected
- Conflict resolution strategies (latest, highest-confidence, merge)
- Version history tracking for temporal reasoning

**Effort:** 8 days

---

### Plan 4: Meta-MCP Bridge
**File:** `project_status/plans/04-meta-mcp-bridge.md`

**What:** User-specific endpoints for cross-app visibility

**Key Features:**
- UUID-based user-specific endpoints
- Cross-app context synchronization (Cursor ↔ Claude ↔ ChatGPT)
- Full MCP protocol implementation
- No manual sync needed

**Effort:** 10.5 days

---

## 📊 Total Implementation Estimate

| Component | Effort | Priority |
|-----------|--------|----------|
| Contextual Retrieval Pipeline | 4.5 days | High |
| AST-Aware Parser | 9.5 days | High |
| Stateful Memory Manager | 8 days | High |
| Meta-MCP Bridge | 10.5 days | Medium |
| **Total** | **32.5 days** | |

---

## 🚀 Implementation Order

### Week 1: Foundation
1. ✅ Configure Groq API key (DONE)
2. Implement Contextual Retrieval Pipeline
3. Set up AST parser for JavaScript/TypeScript

### Week 2: Core Logic
4. Implement AST-Aware Parser (JS/TS/Python)
5. Implement Stateful Memory Manager (isLatest triggers)
6. Test contextual chunking

### Week 3: Connectivity
7. Implement Meta-MCP Bridge
8. Cross-app synchronization testing
9. Performance optimization

### Week 4: Validation
10. End-to-end testing
11. Documentation
12. Go-live preparation

---

## 🔑 Key Technical Decisions

### Groq API Configuration
- 🔴 **KEY ROTATION REQUIRED** - Previous key was compromised
- **Model:** mistral-embed (for embeddings), llama-3-3-70b (for situationalization)
- **Endpoint:** https://api.groq.com/openai/v1/chat/completions
- See `project_status/KEY_ROTATION_RECORD.md` for new key configuration

### AST Parser Targets
- JavaScript/TypeScript (highest priority)
- Python (medium priority)
- Go, Rust, Java, C# (later)

### State Mutation Strategy
- PostgreSQL triggers on relationship creation
- Automatic isLatest = false on previous node
- Conflict resolution: latest > highest-confidence > merge

---

## ✅ Success Criteria

| Metric | Target |
|--------|--------|
| Contextual Retrieval Accuracy | >90% |
| AST Parsing Coverage | JS/TS/Python |
| isLatest Mutation | <100ms |
| Cross-App Sync | <500ms |
| Recall Latency (P99) | <300ms |

---

## 📋 Next Immediate Tasks

### Priority 1: Groq API Setup
- [x] Configure Groq API key
- [ ] Test Groq API connectivity
- [ ] Implement situationalization endpoint

### Priority 2: AST Parser
- [ ] Install tree-sitter and language parsers
- [ ] Create AST parser module
- [ ] Implement scope chain construction
- [ ] Test with sample code

### Priority 3: Stateful Manager
- [ ] Create PostgreSQL triggers
- [ ] Implement isLatest mutation logic
- [ ] Test conflict resolution

### Priority 4: Meta-MCP Bridge
- [ ] User endpoint generation
- [ ] Cross-app sync protocol
- [ ] MCP server completion

---

## 🎯 Phase 2 vs Phase 1 Comparison

| Feature | Phase 1 | Phase 2 |
|---------|---------|---------|
| Chunking | Basic text | AST-aware |
| Context | Raw text | Situationalized |
| State | Manual isLatest | Automatic mutation |
| Connectivity | Local only | Cross-app |
| Code Understanding | Keyword match | AST parsing |
| Retrieval | Vector + keyword | Contextual + AST |

---

## 💰 Cost Estimation (Monthly)

| Component | Estimated Cost |
|-----------|----------------|
| Groq API (situationalization) | ~$50-100 |
| Qdrant Cloud | ~$50-100 |
| PostgreSQL (Scaleway) | ~$25 |
| **Total** | **~$125-225/month** |

---

## 📞 Resources

- **Plans Directory:** `/Users/amar/HIVE-MIND/project_status/plans/`
- **Groq API:** https://console.groq.com/
- **Tree-sitter:** https://tree-sitter.github.io/tree-sitter/
- **Supermemory.ai:** Reference implementation

---

*Last updated: 2026-03-09*
