# Your Team sidebar release — 2026-10-02

- Outer frontend: 0307483d, Worker version e06a97bf-d218-4a09-9ec0-63b6ea658f4d.
- Native frontend: bdf644c8d473604ad919c98256013d524fa69492, runner image hivemind/harness-chat:sha-bdf644c8d4.
- Your Team sits below Dreaming and above Your Brain, with Run Time and authenticated employee profiles using existing Humation avatars.
- Sidebar selection creates a fresh unsent session, waits for session hydration, and selects the native employee command. Existing mounted composers are preserved.
- HyperAgents history renders stored owner names/avatars and stored session topic on hover. Legacy unnamed sessions retain Run Time.
- Verified live sidebar selections for Sofia, Elena and Ravi; Elena and Ravi had distinct new session URLs. No request submitted. Verified existing Ravi history rows and topic title attributes.
- Full native compilation and production outer build passed. Runner cutover reported healthy and preserved sibling container identities.
- Rollback runner: hivemind/harness-chat:sha-137279023f; manifest /root/releases/manifests/hyperagents/unified-entry-bdf644c8d4.
- Agent runtime, Core and Control unchanged. Latest voice and connector recovery retained.
