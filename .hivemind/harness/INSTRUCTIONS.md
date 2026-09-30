# Harness task instructions

The Harness source is the `deepseek-harness-hivemind` Git repository. Its root `harness-fe-guide.md` is the component index; `harness-development-playbook.md` is the build and release guide. Use those before broad text searches. The parent HIVE-MIND repository owns the outer site and deployment coordination; do not infer that its working directory contains the Harness source.

1. Classify the change. Native BRAIN or HyperAgents chat, Schedule UI, session API, and Cordis plugins compile into `harness-runner`. Outer HIVE navigation and VOICE use their own frontend owner.
2. Inspect the current package, bundle patch, and focused upstream documentation. Add capability through Cordis services, events, or tools; retain tenant and session identity across storage, API, and UI. The web profile is suitable for local iteration; production uses an immutable image.
3. Commit and push each reviewable Harness feature from a named task branch. Check only the affected behavior and compiler face during iteration. Before release, record the exact pushed SHA and current live image.
4. Release only the owning artifact. For the runner, verify the built profile and image revision, preserve the live Compose chain, replace only the runner, then check the authenticated route and keep one rollback image.

The current Harness repository is authoritative for package names and commands. In particular, module HMR uses `@deepseek-ai/cordis-plugin-hmr` in the checked-in base bundle; the HMR name in a pasted tutorial may differ from this version. The base HMR row is disabled, so enable it only in a local development overlay.
