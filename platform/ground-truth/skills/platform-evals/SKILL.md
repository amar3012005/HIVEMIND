---
name: platform-evals
description: Design and run focused contract, replay, browser, and release canaries for HIVE-MIND platform changes.
---

# Platform evaluations

Read `../../delivery-contract.md` and the task owner's skill first.

1. Translate the change into happy-path, authorization-denial, failure, replay,
   and rollback assertions relevant to its owner.
2. Prefer typed service and profile tests before browser work. Browser acceptance
   proves routing, authentication, rendering, and streaming—not internal data
   correctness by itself.
3. For agent behavior, measure task completion, tool selection, duplicate
   prevention, bounded context, and terminal workflow cleanup on representative
   fixtures.
4. Store test inputs and receipts separately from customer data. A canary cannot
   send a real external write without explicit approval.
5. Report exact artifact/version/configuration under test and distinguish a
   source pass from deployed acceptance.
