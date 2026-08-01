# Phase 15: Playbook-only dispatch

## Decision

HQ may preserve and prioritize an operating instruction, but it may not encode
the instruction's domain lifecycle. The Runtime now keeps one complete objective
and asks the Director to select an immutable playbook. The selected playbook owns
stages, dependencies, expected artifacts, predicates, adapters, event waits, and
authority gates.

## Removed bypasses

- Instruction fallback no longer classifies work with keyword regular expressions.
- Compound instructions are not split into domain-specific HQ todos.
- HQ does not derive connector requirements or completion artifacts from a task kind.
- A declined or failed playbook selection cannot create a one-shot `HyperWorkOrder`.
- Missing lifecycle coverage blocks only that todo and advances another independent
  priority; it does not substitute a general Room or accept prose as completion.

## Verification

- The Runtime architecture suite asserts that `native-engine.js` contains no
  `hyperWorkOrder.create` dispatch path.
- Instruction tests assert that no keyword router or domain lifecycle decomposition
  remains.
- The GreenLeaf swap lifecycle and Outreach lifecycle run through the same executor.
- Real PostgreSQL checkpoints remain the durable execution source of truth.

