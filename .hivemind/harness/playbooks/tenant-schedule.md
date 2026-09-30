# Tenant sessions and Schedule

Use this when a task touches past sessions, mode switching, scheduled turns, or cold wake. Read the relevant package READMEs in the Harness checkout rather than copying a schema from an older deployment.

| Layer | Current owner | Check |
| --- | --- | --- |
| Durable session mode | `session-persistence-postgres` and `session-controller` | Resolve the latest saved `agent-preset/selected` event under tenant scope; creation headers can be stale. |
| BRAIN and HyperAgents rails | `ui-workspace/HiveSessionProjection.tsx` and `ui-hivemind-connect/session-route.ts` | Filter both the visible list and direct session routes by effective preset, including blank and cold sessions. |
| Schedule controls | `ui-schedule` | Header action must be visible in both modes; tasks must show current persisted state. |
| Schedule execution | `hivemind/schedule-postgres` and `schedule` | Authenticate org/user/session on restore and dispatch; a due task must wake its own tenant's session without an open browser. |

Keep the same tenant identity through list, create, edit, due dispatch, session restore, and task result. A focused integration check should include a second tenant and a cold session; a UI screenshot alone cannot establish isolation. A database migration is needed only when the committed schema changes, and it is a distinct release step from a runner image.
