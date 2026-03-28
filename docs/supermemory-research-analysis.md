# Supermemory Research Analysis — Competitive Intelligence

Source: https://supermemory.ai/research/

---

## Their Scores (LongMemEval-S, GPT-4o Judge)

| Category | Supermemory | Zep | Full Context | HIVEMIND (30q temporal) |
|----------|-------------|-----|--------------|------------------------|
| Single-Session-User | **97.14%** | 92.9% | 81.4% | — |
| Single-Session-Assistant | **96.43%** | 80.4% | 94.6% | — |
| Single-Session-Preference | **70.00%** | 56.7% | 20.0% | — |
| Knowledge-Update | **88.46%** | 83.3% | 78.2% | — |
| Temporal-Reasoning | **76.69%** | 62.4% | 45.1% | **86.7%** (llama judge) |
| Multi-Session | **71.43%** | 57.9% | 44.3% | — |
| **Overall** | **81.6%** | 71.2% | 60.2% | — |

### With Stronger Models

| Model | Overall |
|-------|---------|
| Supermemory + GPT-4o | 81.6% |
| Supermemory + GPT-5 | 84.6% |
| Supermemory + Gemini-3-Pro | **85.2%** |

---

## Their Architecture (What They Do)

### 1. Chunk-based Ingestion + Contextual Memories
- Decompose sessions into semantic chunks
- For each chunk, generate "memories" = atomic facts
- Uses Anthropic's Contextual Retrieval approach (Ford, 2024)
- Resolves ambiguous references (pronouns, "it", "that") using surrounding context

### 2. Relational Versioning (Knowledge Chains)
- **Updates** (state mutation): "favorite color is now Green" supersedes "favorite color is Blue"
- **Extends** (refinement): Add job title to existing employment memory
- **Derives** (inference): Second-order logic from combining multiple memories

**This is identical to our Triple Operator (Updates/Extends/Derives).**

### 3. Temporal Grounding (Dual Timestamps)
- **documentDate**: When the conversation happened
- **eventDate**: When the event described actually occurred

**This is identical to our Bi-Temporal engine.**

### 4. Hybrid Search
1. Semantic search on memories (atomic facts) first
2. On hit, inject original source chunk into results
3. LLM gets both: precise fact + full context

**Key insight: They search MEMORIES (facts), not raw chunks. Then they inject the source chunk for context.**

### 5. Session-Based Ingestion
- Ingest full sessions, not individual rounds
- Process session-by-session (not round-by-round)

---

## Their Answering Prompt (Exact)

```
You are a question-answering system. Based on the retrieved context below,
answer the question.

Question: ${question}
Question Date: ${questionDate}

Retrieved Context:
${retrievedContext}

Understanding the Context:
The context contains search results from a memory system. Each result has
multiple components you can use:

Memory: A high-level summary/atomic fact
  This is the searchable title/summary of what was stored

Chunks: The actual detailed raw content where the memory was extracted from
  Contains conversations, documents, messages, or text excerpts
  This is your primary source for detailed information and facts

Temporal Context (if present):
  Question Date: The date when the question was asked
  documentDate: When content was originally authored
  eventDate: When the event actually occurred

Profile Data (if present):
  Static Profile: Permanent user characteristics
  Dynamic Profile: Recently added memories
  Version: Shows if a memory has been updated/extended

How to Answer:
  Start by scanning memory titles to find relevant results
  Read the chunks carefully - they contain the actual details
  Use temporal context to understand when things happened
  Synthesize information from multiple results if needed

Instructions:
  If the context contains enough information, provide a clear answer
  If not, respond with "I don't know"
  Base your answer ONLY on the provided context
  Prioritize information from chunks - they're the raw source material
```

---

## HIVEMIND vs Supermemory — Feature Comparison

| Feature | Supermemory | HIVEMIND |
|---------|-------------|----------|
| **Atomic memory extraction** | Yes (contextual retrieval) | Yes (MemoryProcessor fact sentences) |
| **Relational versioning** | Updates/Extends/Derives | Updates/Extends (same concept) |
| **Dual timestamps** | documentDate + eventDate | documentDate + valid_time (bi-temporal) |
| **Hybrid search** | Semantic on memories → inject chunks | Qdrant vector + Prisma keyword + Graph |
| **Search target** | Memories (facts) first | Raw chunks (but now also fact-memories) |
| **Embedding model** | Not disclosed | bge-m3 (1024-dim) |
| **LLM for generation** | GPT-4o / GPT-5 / Gemini-3-Pro | llama-3.3-70b (Groq) |
| **Judge** | GPT-4o | llama-3.3-70b (Groq) |

---

## Key Differences That Explain Score Gap

### 1. They Search Facts, Not Chunks
Supermemory searches atomic MEMORIES first, then injects source chunks for context.
We do this now with fact-memories + parent context. Same approach.

### 2. They Use GPT-4o for Generation
Their 81.6% uses GPT-4o. With Gemini-3-Pro they reach 85.2%.
We use llama-3.3-70b and reach 86.7% on temporal (but only tested 30 questions).

### 3. Their Prompt Is More Structured
They explicitly tell the LLM about Memory vs Chunks vs Temporal Context vs Profile.
We use a simpler prompt with Key Facts + Sessions.

### 4. Contextual Retrieval (Anthropic)
They process each chunk by adding context: "This chunk is about X, in a conversation where Y was discussed."
We don't do this — our chunks are raw user+assistant turn pairs.

### 5. Session-Level Ingestion
They ingest full sessions. We ingest turn pairs (user+assistant rounds).
Session-level gives more context per memory but fewer, larger chunks.

---

## What We Should Adopt

1. **Contextual chunk enrichment** — Before embedding, prepend context: "In a conversation about [topic], the user said: [content]"
2. **Structured prompt** — Tell LLM explicitly about Memory vs Chunk vs Temporal Context
3. **GPT-4o for official evaluation** — Use for the final judge run (evaluate_qa.py)
4. **eventDate extraction** — We store documentDate but should also extract eventDate from content
5. **Profile data injection** — They inject static/dynamic user profile into search results

---

## Citations They Reference

1. Liu et al. (2024) — Lost in the middle: How language models use long contexts
2. Wu et al. (2024) — LongMemEval benchmark paper (ICLR 2025)
3. Maharana et al. (2024) — LoCoMo benchmark
4. Rasmussen et al. (2025) — Zep temporal knowledge graph
5. Ford, D. (2024) — Anthropic Contextual Retrieval blog post
6. Lewis et al. (2020) — RAG for knowledge-intensive NLP tasks
7. Shah, P. (2024) — Effects of data noise on vector search
