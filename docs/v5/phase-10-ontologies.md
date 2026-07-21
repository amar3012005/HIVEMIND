# Phase 10 — Organization Ontologies   🟡 opt-in config SHIPPED
## Envisioned state
Per-org vocabulary, approved entity types, required metadata, relationship validation
rules. Ontologies EXTEND the default pipeline — never fork canonical ingestion or add
custom persistence.
## Acceptance (real cURL)
Apply one enterprise ontology → improved terminology, source truth + tenant isolation
unchanged.


## SHIPPED — opt-in org ontology
org_ontologies table (org_id, approved_entity_types[], vocabulary, required_metadata[],
relationship_rules, enabled). Additive; absence = default pipeline (unchanged). Applied in
canonical-entity-persister: when an org has approved_entity_types, the taxonomy-normalized
entityKind is constrained to that allow-list (unknown→concept). Cached 5min, best-effort
(never blocks persistence). EXTENDS the default pipeline, never forks ingestion.
