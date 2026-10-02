# Persistent HyperAgent rooms and shared agent details

## Source and release

- Native Harness branch: `codex/team-agent-task-route`.
- Final source: `17fae97d62a68240325c8a748f5a5bdd576450bf`.
- Runner target: `hivemind/harness-chat:sha-17fae97d62-employee-rooms`.
- Compatible immutable base: `hivemind/harness-chat:sha-fdd25ea3f0-employee-rooms`.
- Outer frontend source: `f2deded5784758e08f1711b4aa65de2dd7f9951d`.
- Outer Worker version: `f466d9c6-17ed-4390-a6d1-b621d75fbbd8`.

## Behavior

The team list opens one tenant/user-scoped persistent room per employee, including Run Time. The HyperAgents landing path reuses the canonical Run Time room. Employee selection does not reassign a used room. Brain sessions retain separate routing. New Session and the repeated task history are removed from this mode.

The shared Agent details component reads the selected employee profile and session projections. It displays a large centered Humation avatar, stored persona, role, configured tools, connected account links, active jobs, routines, latest work and available artifacts. It supports future employee profiles through the same catalog. It does not invent birth dates or infer read/write permission from an app name. Agent details opens from Environment and closes that popover first. Working indicators derive from actual job/session state.

The shared preview resize handle was exercised at the user's current zoom: its edge moved from about 1171 to 1014 CSS pixels. File-type previews and missing-thumbnail fallback are preserved.

## Authorized history reset

A transaction deleted precisely 156 DSH HyperAgents session records: 150 owned by the requesting user and six other initialized sessions with zero started turns. No target had active started work or scheduled tasks. All 318 other Harness session records were preserved; legacy HyperAgents, company memories and other database records were not reset.

A subsequent read-only count after opening all four employees confirmed four HyperAgents rooms, 312 Brain sessions and six HQ sessions. Repeated Sofia selection reopened the same room. Ravi and Elena also opened directly with their selected identities. The main Voice dropdown opened the existing Tara page.

## Checks and limitations

Focused compilation and the mandatory full host/client pre-push checks passed. The routing suite passed all 17 tests after removing a stale blank-room exception that could admit HyperAgents into Brain.

The old Munich PDF and other historic PDF objects were absent from attachment storage, and no recoverable copies were found in the checked production release/home paths. A rendering change cannot recover those bytes. The missing-object UI now provides a fallback instead of a broken image. New PDF generation has not been exercised in the clean rooms during this check.

The delegated security review found no verified cross-tenant exposure in the checked paths, but the published runner tunnel origin remains directly reachable. Authentication rejected the checked root/bootstrap requests; health remained public. Tightening that origin boundary is a separate recommended security change, not implemented by this frontend release.

## Cutover evidence

The guarded cutover completed successfully. The runner is healthy and sibling service identities remained unchanged. Manifest: `/root/releases/manifests/hyperagents/employee-rooms-17fae97d62`. The live shared profile check displayed the stored Sofia persona, configured tools and connected apps, without the prior routine-loading error.
