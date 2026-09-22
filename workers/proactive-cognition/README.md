# HIVEMIND proactive cognition

An identifier-only Cloudflare Cron → Queue → Workflow adapter for voluntary
HIVE-MIND reflections. PostgreSQL remains the authority for consent, activity
compilation, policy, feedback, and provider receipts. The Worker never sees
memory body, email address, or generated reminder text.

The production Worker is fail-closed behind both:

1. `PROACTIVE_COGNITION_ENABLED=false` by default; and
2. Flagship string flag `proactive_cognition_v1`, default `off`.

Flag variations are `off`, `shadow`, and `deliver`. A real canary must first
use an explicitly opted-in user rule with `shadow`; `deliver` is permitted
only after evidence review. The Core master gate must also be set to `true`
for either non-off variation to do any work.
