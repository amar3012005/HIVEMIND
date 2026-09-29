# Task-room streaming playbook

Use this for `frontend/Da-vinci` HyperAgents room changes. Preserve `TaskAgentRoom`, the existing new-session flow, sidebar, selected employee, plan ownership, and artifact panel. Change only the failing boundary; do not replace the page or roll back unrelated room upgrades.

- Display the accepted user turn immediately. Display the Worker’s progress and tool-start event as soon as it arrives, before awaiting provider tokens or tool results. A fast operation may have no model tokens; it still needs a truthful live stage.
- Keep one expandable row per tool-call ID. Show its actual name, target, duration/result or failure when clicked. Repeated calls get distinct IDs and rows. A direct Workflow browser operation is a tool row too.
- Consume provider text deltas and durable event frames incrementally. The typing buffer may smooth chunks, but it must never conceal a missing upstream event or replay a partial answer from the beginning. Reconcile older state snapshots without erasing newer live frames.
- Keep plans attached to their originating turn. Intermediate progress is visible during work; final report and artifacts appear only after their required receipts. A saved artifact is rendered once, after completion, not while still drafting.
- A rejected room start, closed WebSocket, or failed Workflow must clear false `Working` state and present the real error/recovery path. Do not leave an optimistic turn spinning for 30 seconds with no Worker events.
- Follow the bottom of the active turn only while the user remains near the bottom. Do not force-scroll when they read earlier messages.

Verify with an authenticated preview browser and a slow enough canary to inspect the room before completion. Check that the first status appears in seconds, tool rows update in place, final answer follows the work, and WorkRun reaches the same terminal state shown by Cloudflare Workflow tracing.
