# Supermemory Concepts Map

This file maps the concepts section and the adjacent docs pages that matter most for understanding how Supermemory works in practice.

## Concepts Entry

- `/docs/concepts`
  Redirects to `How Supermemory Works`

## Concepts Pages

### How Supermemory Works

Source:
- https://supermemory.ai/docs/concepts/how-it-works

Main contribution:
- Defines the basic model:
  documents in, memories out
- Describes the processing stages:
  queued -> extracting -> chunking -> embedding -> indexing -> searchable
- Introduces graph relationships and the distinction between raw inputs and semantic memory units

### Graph Memory

Source:
- https://supermemory.ai/docs/concepts/graph-memory

Main contribution:
- Explains relationship types:
  `Updates`, `Extends`, `Derives`
- Explains `isLatest`
- Frames memory as temporal and evolving
- Mentions contradiction handling, automatic forgetting, and different memory categories such as facts, preferences, and episodes

### Content Types

Source:
- https://supermemory.ai/docs/concepts/content-types

Main contribution:
- Documents supported ingestion formats
- Emphasizes type-specific extraction and chunking
- Highlights that code is AST-aware and media can use OCR or transcription

### SuperRAG

Source:
- https://supermemory.ai/docs/concepts/super-rag

Main contribution:
- Positions Supermemory as managed RAG plus memory
- Describes type-aware extraction, chunking, embeddings, and relationship building
- Mentions hybrid search, reranking, and query rewriting

### Memory vs RAG

Source:
- https://supermemory.ai/docs/concepts/memory-vs-rag

Main contribution:
- Draws the product boundary:
  RAG for static knowledge
  memory for evolving user/state context
- Explains why "vector search over documents" is not enough for true memory behavior

### Filtering

Source:
- https://supermemory.ai/docs/concepts/filtering

Main contribution:
- Defines `containerTags` as isolation and organization primitives
- Defines metadata filtering as the query narrowing mechanism
- Indicates filter composition with logical operators
- Important nuance:
  container tags are exact array matches

### User Profiles

Source:
- https://supermemory.ai/docs/concepts/user-profiles

Main contribution:
- Introduces persistent user-level context
- Splits profiles into static and dynamic context
- Positions profile state as complementary to targeted search

### Customization

Source:
- https://supermemory.ai/docs/concepts/customization

Main contribution:
- Documents tuning controls
- Highlights `filterPrompt`, `entityContext`, chunk sizing, and connector branding
- Shows that ingestion behavior can be shaped at org and container scope

## Adjacent Page Referenced by Concepts Nav

### Authentication

Source:
- https://supermemory.ai/docs/authentication

Note:
- It appears in the docs navigation alongside concepts-related material
- It is not itself under `/docs/concepts`

## Adjacent Docs That Matter To The Architecture

These are not concept pages, but they are necessary to understand how the product behaves operationally.

### Add Memories

Source:
- https://supermemory.ai/docs/add-memories

Main contribution:
- Shows the live ingest entrypoint from a user perspective
- Frames ingestion as asynchronous processing rather than immediate raw storage
- Reinforces that uploads become extracted memories automatically

### Memory Operations

Source:
- https://supermemory.ai/docs/memory-operations

Main contribution:
- Shows how memory can be manipulated after ingestion
- Indicates that memory is treated as a mutable working surface, not only passive recall

### Memory API Overview

Sources:
- https://supermemory.ai/docs/memory-api/overview
- https://supermemory.ai/docs/memory-api/introduction
- https://supermemory.ai/docs/memory-api/ingesting
- https://supermemory.ai/docs/memory-api/searching/searching-memories

Main contribution:
- Documents the API surfaces for adding and searching memory
- Shows that ingestion, status tracking, filtering, query rewriting, reranking, and content cleaning are first-class product behaviors

### Memory API Features

Sources:
- https://supermemory.ai/docs/memory-api/features/auto-multi-modal
- https://supermemory.ai/docs/memory-api/features/content-cleaner
- https://supermemory.ai/docs/memory-api/features/filtering
- https://supermemory.ai/docs/memory-api/features/query-rewriting
- https://supermemory.ai/docs/memory-api/features/reranking

Main contribution:
- Explains that retrieval and ingestion quality are improved by additional processing layers
- Reinforces that Supermemory is optimizing the full pipeline, not only vector search

### Connectors

Sources:
- https://supermemory.ai/docs/memory-api/connectors/overview
- https://supermemory.ai/docs/memory-api/connectors/creating-connection
- https://supermemory.ai/docs/memory-api/connectors/managing-resources
- https://supermemory.ai/docs/memory-api/connectors/google-drive

Main contribution:
- Shows how external sources are pulled into the same memory system
- Suggests that connectors are part of the core memory pipeline rather than a separate integration surface

### User Profiles Expanded

Sources:
- https://supermemory.ai/docs/user-profiles/overview
- https://supermemory.ai/docs/user-profiles/api
- https://supermemory.ai/docs/user-profiles/examples
- https://supermemory.ai/docs/user-profiles/use-cases

Main contribution:
- Extends the concepts-level profile framing into practical API and usage patterns
- Makes it clearer that profiles are a durable context layer, not just a UI feature

### Memory Router

Sources:
- https://supermemory.ai/docs/memory-router/overview
- https://supermemory.ai/docs/memory-router/usage
- https://supermemory.ai/docs/memory-router/with-memory-api

Main contribution:
- Shows a second product surface where Supermemory acts as a proxy in front of the LLM
- Clarifies that memory capture, retrieval, and prompt augmentation can happen in a transparent routing layer
- Suggests a practical product architecture:
  memory can be integrated either directly through API calls or indirectly through a routing/proxy layer

