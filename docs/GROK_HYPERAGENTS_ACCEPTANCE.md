# Grok HyperAgents acceptance ledger

This ledger maps the architecture's fifteen acceptance requirements to
authoritative evidence. A code-level pass is not treated as a substitute for a
fresh integrated local Room run. The feature is accepted only when every row is
`PASS` against the merged `singulance-local` build.

| # | Requirement | Current evidence | State |
|---|---|---|---|
| 1 | Five-person roster activates only the minimum sufficient team | exact five-to-two roster regression in `test_grok_runtime.py`; integrated UI canary remains | PASS-CODE |
| 2 | Every activated participant has a persistent Agent identity | deterministic tenant-opaque identity tests; live Agent provisioning already recorded in local DB | PASS-CODE |
| 3 | Concurrent agents do not share scratch context | concurrent LangGraph regression proves isolated employee/order/prompt state; integrated concurrency canary remains | PASS-CODE |
| 4 | Delegates use their own skills, tools and connector grants | `test_delegate_to_tool.py` plus per-employee `_build_agent_for_room` | PASS-CODE |
| 5 | Agent, Workflow or Employees restart resumes checkpoints | deterministic Workflow IDs, PostgreSQL leases, and prior local recovery turn; latest merged-image kill test remains | PARTIAL |
| 6 | Replay does not duplicate provider actions or artifacts | unique receipt action keys, WorkResult attempt keys and generic adapter ledger tests | PASS-CODE |
| 7 | Closing the frontend does not stop work | execution is server/Workflow-owned; a fresh browser-close canary remains | PARTIAL |
| 8 | Redirect, pause and cancel work | persisted control state, Workflow controls, Employees polling, and UI controls exist; merged UI canary remains | PARTIAL |
| 9 | High-risk actions require reviewer and user approval | independent reviewer repair tests and generic authority-gate tests pass | PASS-CODE |
| 10 | Cross-tenant Room, artifact, connector and browser access is denied | tenant-scoped queries, opaque Agent/Room IDs, signed Room tickets and connector tests; integrated hostile probes remain | PARTIAL |
| 11 | Missing capability requests a specialist | `specialist_requested` and `waiting_for_capability` are regression-tested behavior | PASS-CODE |
| 12 | Synthesis consumes persisted results/receipts, not worker prose | synthesis-context tests exclude WorkResult prose and retain exact provider receipt identity | PASS-CODE |
| 13 | Flag-off remains compatible | unknown/failure modes fail closed to `off`; complete API snapshot after integration remains | PARTIAL |
| 14 | Enabled turns never silently fall back | durable/full path fail-closes without the work-agent executor; full-mode fallback regression exists | PASS-CODE |
| 15 | Market, SEO, Legal and fictional-company swap without engine changes | generic playbook/GreenLeaf tests pass; four-department Room canary remains | PARTIAL |

## Verified commands

```text
Python 3.12:
pytest tests/test_langgraph_runtime.py tests/test_grok_runtime.py tests/test_adaptive_director.py -q
43 passed

Core:
node --test [Grok, Hyper state, predicates, runtime registry/adapters suites]
79 passed total (18 focused + 61 dependency-complete rerun)

Worker:
npm run check
npm test -- --run
npm run dry-run
5 passed; dry-run listed Room/Hired Agents, Room/Assignment Workflows,
Browser, Sandbox and Flagship.

Frontend:
npm run build
passed for commit 61d940ba7442e488948905f5b5429c7a9d115777.
```

## Live Cloudflare evidence

- Local Flagship decision: `full`.
- Worker version: `3d2eac64-94ab-458c-843f-7e2dd6bb5e6c`.
- Browser capture returned HTTP 200.
- Sandbox returned 403 without authority and `SANDBOX_OK` with authority.
- Room Agent accepted a valid short-lived signed ticket and rejected an invalid
  ticket with close code 4001.

## Remaining integrated gate

Merge `codex/grok-room-bounded-repair` into a clean permanent
`singulance-local` worktree, rebuild only Core, Employees and frontend, then run
the missing integrated canaries above. The permanent worktree currently contains
unrelated connector-catalog changes and must not be cleaned, stashed, reset or
overwritten by this session.
