# Shared native preview frontend

Native source: c8c678bb7b1d2e69e2158374742f55db57878f6a (pushed codex/team-agent-task-route).
Runner: hivemind/harness-chat:sha-c8c678bb7b-preview-two-row.
Digest: sha256:219d90940b643c859a8f6e7fd816ea365afdb42ee3ec22a1bd8f5a27eaeed221.

Preserved production source 8ab402529bfd3dcbcdf0c6b00112ee5551841e6f, including the recent attachment/artifact previews. Initial preview release 22bb6d1f8d80918692f8b0bdb27e3342976316fc was followed by the full-width image and two-row-header refinement. Each source was committed/pushed and passed client compilation. Immutable incremental images account for the complete base-to-target delta and rebuild the changed packages. Runner-only cutover was healthy and left sibling container identities unchanged.

Shared sidebar header now places window dots and Preview/Artifacts/Computer/Sources navigation above document tabs. Existing docking, resizing, floating, fullscreen and slide behavior remain. Workbench mode restriction removed. Durable artifact file receipts open their own resource preview once per mounted client lifetime. Conversation artifact nodes are displayed before their turn's feedback controls; image precedes file banner, with file-type icon. Image gallery sizing is scoped to artifact output rather than changing normal attachments.

Authenticated browser verification: existing Sofia image session opens preview; image loads; answer precedes image; banner follows image and precedes copy/feedback; shared navigation appears before document tabs. Screenshots: /tmp/preview-two-row-live.png and /tmp/preview-header-live.png. No agent task was submitted. New live artifact streaming and all file-type rendering combinations were not separately exercised.

Pending: user has not supplied the promised Higgsfield/stacked-artifact reference. Exact stacked-card styling and exact-item card selection remain outside this release. Agent team entry still creates a new session; this release did not merge or delete prior chats.
