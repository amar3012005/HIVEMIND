# Dreaming welcome and connected-app presentation — 2026-10-01

## Artifacts

- Native source: `2793c574a253b7175b576ac51cb5c9a06bd9cd60` (`codex/connector-panel-polish`).
- Runner: `hivemind/harness-chat:sha-2793c574a2`.
- Image: `sha256:dd11a19ea1338e542eae33072cf89a43603d9ef06a94db206c56061d75e677f6`.
- Frontend: `9a21c014becb1ce145b0d6edbb79742f24b0c7fb`, promoted to Da-vinci `main`.
- Parent gitlink promotion: `287deaf9` on `singulance-main`.
- Worker: `87a41d94-3854-47a6-a568-014d29695db6`.

## Behavior

The independent Dreaming route shows a first-time banner with three existing
HyperAgent portraits when no Dreaming occurrence exists. Admin opt-in queues one
introduction occurrence in the persistent Dreaming child, using the existing
native delegation/lease machinery. It loads authenticated profile context and
can only finish its greeting; it cannot save Flashbacks or read apps. The final
receipt renders “Welcome to Dreaming.” Later scheduled runs retain full dreaming
capabilities and the same room. Duplicate setting requests reuse the occurrence.

Connected apps show logos, readable names and switches. More apps opens the
existing Connectors page. The blank BRAIN chat replaces connector suggestion
chips with onboarding or already connected apps. Existing BRAIN chats have an
environment control. Actual settled credits come from the usage ledger, scoped
to an owned session or the authorized company Dreaming room. Unavailable usage
shows a dash, never an estimate. Run history starts collapsed, beneath apps,
with the future-goal editor below it.

## Authorized reset

At the user's explicit request, SINGULANCE/AMAR Dreaming was turned off and the
old seven occurrences plus two parent/child sessions were archived before being
removed from the live Dreaming ledger. The original session logs, leases,
outputs, connector evidence and settings are retained in a root-only recoverable
archive: `/root/releases/archives/dreaming-reset-20261001T125412Z/archive.json`.
Saved Flashbacks and their company memory lineage were not deleted. This user's
Dreaming app-access master setting was revoked; existing app connections remain.
The next opt-in gets a fresh session identity derived from the current settings
revision, so old session credit usage does not appear on the new room.

## Checks and rollback

Focused TypeScript graph passed; native commit/push hooks passed host compilation
and client typechecks. Frontend production build passed. Immutable image verifier
passed. Runner cutover preserved all sibling container identities and the runner
reports healthy. Production read confirmed zero retained Dreaming occurrences.

Runner rollback: `hivemind/harness-chat:sha-815a403885`.
Managed cutover: `/root/releases/manifests/hyperagents/dreaming-welcome-2793c574a2`.
Previous Worker: `73a9a581-fd24-4baf-a0af-0b1b96b1fb0f`.
Reset restoration is separate from binary rollback; preserve the archive.
No first-time model greeting has been triggered for the user: enabling remains
an explicit user action on the banner.

Authenticated browser proof: the live Dreaming route displays the first-time
banner, real Sofia/Elena/Ravi portraits and an unchecked enable switch. The new
BRAIN chat renders the connected-account list; all five logos loaded, the More
apps route points to Connectors, and its environment panel confirms 0 settled
credits for the new session. Screenshots: `/tmp/hivemind-dreaming-welcome.png`
and `/tmp/hivemind-chat-connected-apps.png` on the operator workstation.
