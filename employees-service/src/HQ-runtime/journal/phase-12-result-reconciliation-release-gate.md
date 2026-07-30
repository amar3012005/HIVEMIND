# Phase 12: Specialist-result reconciliation and release gate

HQ can now reconcile a returned specialist Work Order without reading missing
state. `resolveWorkResultTodo` first proves that both the Work Order and result
packet exist, then derives the result payload and its source todo. A missing
packet blocks the Runtime with an attributable event; a valid packet completes
only the linked todo and continues to stage review.

- `core/tests/unit/hq-native-engine.test.js` covers absent order/result packets
  and both result-owned and Work-Order-owned todo linkage.
- HQ Runtime source, migrations, policy assets, and tests must ship as one
  committed reviewed change from `/root/hivemind-main`.
- `/root/hivemind` remains the Compose/run tree. It is not a build source and
  must not be treated as a competing Runtime implementation.
- Do not deploy a new Runtime image until the canonical source is committed,
  the focused suite passes, and the existing stable image tag is recorded for
  rollback.
