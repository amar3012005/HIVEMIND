# Progressive harness release acceptance — 2026-09-05

Status: controlled production acceptance in progress. New admission is restricted to the explicit operator identity `amarsai2005@gmail.com`; it is not a global rollout.

## Implementation

This upgrades the existing runtime behind a default-off tenant gate. It does not install LangGraph or Cloudflare Agents as a second execution authority. Progressive bounded planning, generic schema-driven approval drafts, durable resume, outcome coverage and canonical approval-event projection share the existing Core authority.

## Immutable release evidence

- Initial backend implementation: `e9d9a686a06e743f49548ae557bfd73fb5f30757`, deployed Core-only through the canonical runner. Image ID `sha256:e22d65224aff9907dafb3599570f0b4df01e3f0401b3f7fdfba7e14ea4255fb7`; initial manifest `/root/releases/manifests/e9d9a686/20260905T092930Z/RELEASE_MANIFEST.json`.
- Initial frontend: `f53326325005d154901e244b52fb522400c51ba9`, Cloudflare `hivemind-web` version `aeae7f45-bb05-4b26-b2d4-3ba5bc949aa5`. Served progressive chunk matched the build byte-for-byte; SHA256 `874d375a75034254ecccd362cf08857a190dcd7c527975f1e1c276d68c37475e`.
- Live canary caught a missing POST method before any tool execution. Transport correction `c439b8425f742e192ebae4edcc7724e0d4559f3e` adds native HTTP-boundary regression coverage, not merely injected planner assertions.

## Model policy

The progressive durable turn uses one model: `openai/gpt-oss-20b:nitro`, with reasoning disabled, for intent, action selection, semantic argument validation and schema argument generation. Gemini and DeepSeek are not progressive-harness fallbacks.

## Verification

- Focused backend: 111 passing tests after transport correction.
- Real local PostgreSQL integration: passes persistent pause/fresh-client resume, tenant isolation, concurrent ownership, canonical sent/cancelled/failed projection and duplicate receipt handling. Four isolated runs, three drafts, one fixture provider call; disposable schema removed.
- Live authenticated German `use_tools:false` response passed with new admission disabled.
- First enabled run persisted `progressive-v1` and failed honestly before tool execution; no external writes. This failed attempt is not successful enabled acceptance.
- Semantic Markdown and schema-based Edit/Save frontend tests and Cloudflare build pass. Existing unrelated lint/mobile-keyboard failures are not claimed fixed.

## Rollback and limits

Previous backend: `2f8757af25257ab9f54306de28beb2b784e36be8`, image ID `sha256:86856ab808d0f0508e62d494a169cc4686b294cea8de0ec4cd40e0e6b6604f49`, manifest `/root/releases/manifests/2f8757af/20260905T073736Z/RELEASE_MANIFEST.json`. Promote that exact recorded SHA through the canonical service-scoped runner if runtime rollback is needed; the retired `--rollback` shortcut is rejected.

Previous frontend Worker version: `1032f305-df19-433b-823f-a69a03cc99d4`.

Canary configuration was backed up before appending the two explicit harness admission variables. Restore admission to default-off after acceptance. Disabling admission does not alter the contract of already latched interrupted runs.

No customer email, issue, post or other provider mutation is sent as an acceptance test. A draft is not a sent action. Local injected-provider tests do not prove real provider delivery.
