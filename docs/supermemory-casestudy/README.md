# Supermemory Case Study

This folder captures a source-backed understanding of how Supermemory works at the conceptual and architectural level, based on the public docs under `https://supermemory.ai/docs` and the mirrored local docs in the `supermemory` repo.

## What This Covers

- The concepts-page map and what each page contributes
- The broader live docs surface around ingestion, memory operations, user profiles, connectors, and memory router
- The core architectural model behind Supermemory
- How ingestion, memory extraction, relationships, retrieval, and profiles fit together
- What appears to matter most if we want to compare or learn from it for HIVEMIND

## Folder Contents

- [`README.md`](/Users/amar/HIVE-MIND/docs/supermemory-casestudy/README.md)
  The high-level synthesis
- [`concepts-map.md`](/Users/amar/HIVE-MIND/docs/supermemory-casestudy/concepts-map.md)
  Page-by-page map of the concepts section plus adjacent docs surfaces
- [`core-architecture.md`](/Users/amar/HIVE-MIND/docs/supermemory-casestudy/core-architecture.md)
  The clearest explanation of how Supermemory appears to work under the hood
- [`hivemind-implications.md`](/Users/amar/HIVE-MIND/docs/supermemory-casestudy/hivemind-implications.md)
  Direct lessons for HIVEMIND ingestion, knowledge base, and connectors
- [`docs-inventory.md`](/Users/amar/HIVE-MIND/docs/supermemory-casestudy/docs-inventory.md)
  Inventory of the broader docs surface under `supermemory.ai/docs`

## Executive Summary

Supermemory is not presented as a plain vector database or simple RAG layer. The docs consistently frame it as a memory system with five linked ideas:

1. Documents are raw inputs, not the final unit of recall.
2. Memories are extracted semantic units that can be linked, updated, extended, and derived.
3. Retrieval is hybrid.
   Static document retrieval is used for knowledge sources.
   Memory retrieval is used for evolving user- and context-specific state.
4. Memory is temporal.
   Truth can change, memories can decay, and historical state is preserved.
5. Ingestion is opinionated.
   The system auto-detects content type, extracts content differently by type, chunks differently by type, and tries to build relationships automatically.

That is the central product claim: Supermemory is trying to turn uploaded content into living knowledge, not just searchable chunks.

## The Core Model

The docs repeatedly split the world into:

- `documents`
  Raw uploaded or connected content
- `memories`
  Derived semantic facts or units of context

This distinction matters. Their concept pages suggest that Supermemory does not treat ingestion as "store file, embed file, search file." Instead, it treats ingestion as a transformation pipeline:

1. accept content
2. detect content type
3. extract useful content
4. chunk appropriately
5. embed
6. connect to existing memory graph
7. expose hybrid retrieval

That is the main architectural difference from a basic RAG product.

## Relationship Model

The docs define three relationship types:

- `Updates`
  New information supersedes old information
- `Extends`
  New information enriches an existing memory without replacing it
- `Derives`
  New memory is inferred from multiple other memories

The `graph-memory` and `how-it-works` pages also emphasize:

- `isLatest` is how current truth is surfaced while preserving history
- memories can be contradicted and superseded
- temporary or low-value memories can be forgotten

This means their "memory" concept includes lifecycle and truth management, not only retrieval.

## Ingestion Model

Across `how-it-works`, `content-types`, and `super-rag`, the ingestion model appears to be:

1. content-type aware
2. extraction aware
3. chunking aware
4. relationship aware

The docs explicitly mention support for:

- raw text
- URLs and web pages
- PDFs
- Office docs
- Google Workspace through connectors
- Markdown
- code
- images
- audio/video
- JSON
- CSV

The important architectural point is not just the list of types. It is that they claim type-specific handling for each, including OCR/transcription for media and AST-aware chunking for code.

## Retrieval Model

The docs do not argue for "vector search alone." They position retrieval as hybrid by default:

- document retrieval for external or static knowledge
- memory retrieval for evolving user/context state

The docs also mention:

- query rewriting
- reranking
- metadata filtering
- container scoping

That means Supermemory treats retrieval quality as a layered system:

1. scope correctly
2. retrieve candidates
3. improve candidate quality
4. return context appropriate to the query type

## Profiles and Context

The `user-profiles` material frames profiles as persistent user context, split into:

- static profile
- dynamic profile

That is different from ad hoc search. The stated model is:

- profiles provide durable standing context
- search retrieves targeted supporting memories

This is relevant for any "second brain" product because it separates:

- broad identity/state
- situational memory retrieval

## Why This Matters for HIVEMIND

The strongest takeaways are not the branding terms. They are the product and system choices:

- treat uploads as transformation jobs, not just stored blobs
- extract memories from content, not only chunks from content
- maintain update history instead of blindly appending
- separate static retrieval from evolving memory retrieval
- treat filters, scopes, and containers as first-class

If our ingestion, knowledge base, and connectors feel inaccurate, this case study suggests the likely gap is not "missing embeddings." It is more likely one or more of:

- weak normalization before storage
- weak extraction of durable facts from source content
- insufficient lifecycle handling for changing facts
- inadequate separation between document recall and memory recall
- insufficient scoping and container discipline

## Primary Public Sources

- https://supermemory.ai/docs/concepts/how-it-works
- https://supermemory.ai/docs/concepts/graph-memory
- https://supermemory.ai/docs/concepts/content-types
- https://supermemory.ai/docs/concepts/super-rag
- https://supermemory.ai/docs/concepts/memory-vs-rag
- https://supermemory.ai/docs/concepts/filtering
- https://supermemory.ai/docs/concepts/user-profiles
- https://supermemory.ai/docs/concepts/customization
- https://supermemory.ai/docs/add-memories
- https://supermemory.ai/docs/memory-operations
- https://supermemory.ai/docs/memory-router/overview
- https://supermemory.ai/docs/memory-router/usage
- https://supermemory.ai/docs/memory-router/with-memory-api
- https://supermemory.ai/docs/memory-api/overview
- https://supermemory.ai/docs/memory-api/introduction
- https://supermemory.ai/docs/memory-api/ingesting
- https://supermemory.ai/docs/memory-api/searching/searching-memories
- https://supermemory.ai/docs/memory-api/connectors/overview
- https://supermemory.ai/docs/user-profiles/overview

## Adjacent Source

- https://supermemory.ai/docs/authentication
