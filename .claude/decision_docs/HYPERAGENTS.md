# HyperAgents Decision

HyperAgents is the governed AI workforce layer, not a second memory engine or
connector runtime. Rooms use organization/project authorization, HIVEMIND
recall, approved connector tools, durable events, and explicit action gates.

Primary ownership:

- `employees-service/src/hivemind_employees/api_hyper_rooms.py`
- `employees-service/src/hivemind_employees/hyper/engine.py`
- `employees-service/src/hivemind_employees/hyper/skills/`
- `core/src/routes/hyper-rooms.js`
- `core/src/realtime/hyper-turn-events.js`
- `frontend/Da-vinci/.../pages/HyperAgents.jsx`

No prompt may fabricate tool outcomes, evidence, recipients, or completed
actions. External writes require the existing approval/audit path. Preserve
streaming plus fallback behavior and verify room creation, first-run start,
events, synthesis, artifacts, and role/usage gates.

Detailed current context is in `../hyperagents/CONTEXT.md`; its journal is
append-only history.
