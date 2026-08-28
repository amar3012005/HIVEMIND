# Canonical graph relationship policy v1

Status: production candidate

Every durable memory producer submits relationship proposals through
`MemoryGraphEngine.applyValidatedRelationship`. Models, ingestion heuristics,
resident jobs, chat saves, cognition, managed storage, embedded AMR, and BYOD
may propose edges; they may not persist semantic edges directly.

## Durable relationship vocabulary

- `Updates`: a newer atomic claim changes the same subject and predicate. The
  predecessor is demoted atomically and remains available for history.
- `Extends`: a source-supported claim adds compatible detail. Both memories
  remain current.
- `Derives`: one or more explicit source memories support a newly synthesized
  memory. Direction is always source to synthesis.
- `Contradicts`: two claims address the same subject and predicate with
  incompatible values, without choosing a winner.
- `PartOf`: structural membership such as fact to document summary or thought
  to trace. It is not a semantic similarity edge.

`Mentions` is not a durable memory-to-memory edge. Entities and co-occurrence
live in `CanonicalEntity` and `MemoryEntityLink`, where they remain filterable
without turning the graph into a dense clique.

## Admission and storage invariants

1. Both endpoints must exist in the same authorized tenant.
2. `Updates` requires confidence at least 0.85 and deterministic change
   evidence for the same structured claim.
3. `Extends`, `Derives`, and `Contradicts` require confidence at least 0.75;
   `Derives` is admitted only from an explicit provenance lane.
4. Every semantic edge carries `relationship_policy_version`, validation
   status, reason, producer, confidence, and provenance metadata.
5. The Prisma, embedded AMR, and BYOD write boundaries reject uncertified
   semantic edges. The same metadata is returned by graph reads.
6. Graph degree is not a relevance signal. Recall ranks content relevance and
   temporal eligibility first, then expands a bounded typed neighbourhood.

## Rollout behavior

The policy governs all new writes immediately. Existing relationships are not
hard-deleted during deployment. Legacy `Mentions` edges are excluded from
semantic traversal; a separate audited maintenance pass may archive duplicate,
uncertified, or weak legacy edges after counts by tenant, producer, type, and
confidence have been reviewed.

## Release proof

Release requires claim-signature, relationship-policy, versioning,
document-promotion, public-route, stigmergic, BYOD bundle, and storage-filter
contracts. Native AMR parity must run on a host containing the matching signed
native binding; a missing platform binding is an environment gate, not a
passing test.
