# How Supermemory Works Under The Core

This document is the direct architectural reading of the concepts documentation.

## 1. The Foundational Split: Documents vs Memories

The clearest architectural idea in the docs is that documents are not the primary retrieval unit.

- Documents are raw inputs.
- Memories are processed semantic units extracted from those inputs.

This implies a two-layer system:

1. input/content layer
2. memory layer

That distinction explains why their product language avoids describing itself as only a document search engine.

## 2. Ingestion Is A Processing Pipeline

The docs describe ingestion as an opinionated pipeline, not a generic upload API.

The implied stages are:

1. detect type
2. extract content according to type
3. chunk according to type
4. embed
5. connect to prior knowledge
6. index for retrieval

This is a strong claim because it means ingestion quality depends on:

- content normalization
- type-aware extraction
- chunking strategy
- relation building

not just vector storage.

## 3. The Graph Is Not Decorative

The graph model appears to be central, not secondary.

The docs specify three relationship operators:

- `Updates`
- `Extends`
- `Derives`

This tells us the system is designed to model knowledge change, not just similarity.

### What These Relationships Mean

- `Updates`
  Truth changed. Old memory is still historically real, but not current.
- `Extends`
  Existing memory was incomplete and is now enriched.
- `Derives`
  A new memory is inferred from multiple memories.

This relationship model implies a retrieval system that cares about:

- current truth
- historical truth
- inferred truth

## 4. Current Truth Requires Versioning

The docs mention `isLatest`.

That is important because it implies:

- memories can have historical lineage
- retrieval can prefer current state
- history can remain recoverable

Without explicit version state, `Updates` would collapse into blind append behavior.

## 5. Memory Categories Have Different Lifecycle Rules

The docs refer to at least:

- facts
- preferences
- episodes

Those are not equivalent storage objects.

The implied behavior is:

- facts persist until superseded
- preferences strengthen with repetition
- episodes decay unless they prove important

So the system likely treats memory importance and persistence as type-sensitive.

## 6. Retrieval Is Hybrid By Design

The concepts docs do not present a pure vector-search story.

Instead they describe:

- document retrieval
- memory retrieval
- reranking
- query rewriting
- scoped filtering

That implies retrieval quality depends on more than embeddings. It depends on:

- choosing the right corpus
- isolating the right scope
- improving the query
- reranking candidates

## 7. Container Discipline Matters

The filtering docs emphasize `containerTags`.

That suggests Supermemory uses container tags as a major scoping primitive for:

- project isolation
- workspace isolation
- contextual organization

This is not a cosmetic tagging feature. It appears to shape both ingestion context and search scope.

The docs also note an exact-match nuance in tag matching, which means container design affects practical recall quality.

## 8. User Profiles Are A Separate Layer

The user profile material implies a second context channel besides search:

- user profile for durable standing context
- search for targeted episodic/contextual retrieval

That separation is strategically important.

It suggests a strong system should not make every answer depend on live retrieval alone.

## 9. Customization Happens At The Ingestion Boundary

The customization docs surface three especially important controls:

- `filterPrompt`
- `entityContext`
- chunk sizing

These are not just developer conveniences.

They imply that Supermemory assumes raw data quality is not enough.

The system expects developers to define:

- what is worth remembering
- how a container should be interpreted
- how large or small memory units should be

## 10. Best Reading Of The Architecture

The most defensible architectural interpretation is:

- Supermemory is a managed memory operating layer built on top of:
  - multi-modal ingestion
  - typed extraction
  - chunking
  - embeddings
  - graph relationships
  - scoped retrieval
  - profile context

The important part is not any single feature.
The important part is that the docs describe memory as:

- evolving
- scoped
- type-aware
- relationship-aware
- retrieval-aware

That is the real core.

## 11. Practical Reading For HIVEMIND

If we compare this model to HIVEMIND, the most relevant pressure points are:

- do we convert source material into durable memory units, or mostly just store source text?
- do we explicitly model updates and current truth?
- do we distinguish static document retrieval from personal memory retrieval?
- do connectors and knowledge-base uploads carry enough context to produce accurate extracted memories?
- do our scopes and projects behave like true memory containers?

Those are the right questions to ask if our ingestion accuracy feels weak.

