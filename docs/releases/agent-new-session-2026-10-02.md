# Agent New Session routing correction

Native source: 8d2e99200403f151af79bf2831f38aed996bbb4c.
Production base: e008591d51bdf6b2f4ca8213a09a4e8b3cad59ba, image hivemind/harness-chat:sha-e008591d51-progress.

One changed file relative to production: ui-workspace HiveSessionProjection.tsx. Agent New Session previously explicitly pushed /hivemind/app/overview/new. It now pushes /hivemind/app/employee/harness/new so existing native route handling creates the correct preset and keeps agent history separate.

Release is a client-only rebuild on the current immutable runner. No Core, control, database or outer frontend changes. Production and browser verification pending.
