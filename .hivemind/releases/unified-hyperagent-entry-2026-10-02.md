# Unified HIVEMIND and HyperAgents entry — 2 October 2026

## Released artifacts

- Outer frontend: `62fe47106234fd0827bf9a3b87bd99dbc7604aae`.
- Cloudflare frontend version: `d5e01ef8-da42-4e91-a141-91cdd46d54e9`.
- Parent frontend promotion: `5094c7ab90148f39786f00359e9f6e43bc72cf90`.
- Native Harness source: `d7786d4003f899db0a0728dee7abb58d550a996a`.
- Runner image: `hivemind/harness-chat:sha-d7786d4003`.
- Image ID: `sha256:b32c490845fbed46378f9f79a68e190f75956032ae3bea639e3d792f8ffeb73e`, linux/amd64.
- Final runner-only cutover manifest: `/root/releases/manifests/hyperagents/unified-entry-d7786d4003`.
- Immediate rollback image: `hivemind/harness-chat:sha-6f6df78f82`.

The source merges the newer connected-workflow recovery release `acaf9b0c8b00abc67ec3b33f233a69becbbc10ae`, which itself includes the initial unified entry release. The latest voice-composer base and connected-app recovery changes are preserved. Core, Control, Employees and sibling container identities were unchanged by these runner cutovers.

## User flow

1. Overview and the HyperAgents session route render the same native composer surface.
2. New Session defaults to HIVEMIND/BRAIN, including when opened from HyperAgents history.
3. Selecting an authorized named employee switches the native preset to HyperAgents/OS independently of query wording, retaining the draft.
4. Choosing HIVEMIND clears the employee selection and restores BRAIN while retaining the draft.
5. Agent-task suggestions choose their authorized recipient before replacing the editable draft. They do not send.
6. Send starts the native session and changes directly to the same session under HyperAgents. Ordinary requests stay under Overview. Histories are filtered by native preset.
7. Company workspace, existing deep links, native permissions, persistent session ownership, scheduling and the native execution loop remain available. One environment panel follows the selected mode. Headline transitions animate in place with reduced-motion handling.

## Verification

- Mandatory pre-push host build and client typecheck passed; final check took about 50 seconds.
- Incremental immutable image compiled both changed client packages; image verifier retained Markdown, math, reasoning, tools, trajectory, attachments, jobs, subagents, replay and both HIVE presets.
- Live runner health: healthy.
- Authenticated browser: Ravi selected, OS shown, draft retained; HIVEMIND selected, BRAIN restored with same draft.
- Task suggestion selected Ravi and replaced the draft without changing the Overview route or sending.
- Small canary Send opened the same session under HyperAgents; Ravi produced the response with the selected identity. Reload preserved that owner.
- Small normal-chat canary stayed in Overview and appeared in its recents, separate from the agent task.
- Both user-provided existing session URLs remained directly accessible.
- Final build: HyperAgents New Session returned to a fresh Overview/BRAIN composer. Selecting Elena preserved the same query and switched to OS; exactly one Environment panel and no duplicate HIVEMIND connected-app panel appeared.
- Screenshot: `/tmp/hivemind-unified-composer-final.png` (local verification artifact).

No recurring schedule or connected-app write was created for verification. Existing ownership restrictions were retained; no new runtime restrictions were introduced.
