# Frontend Decision

`frontend/Da-vinci` is the only frontend repository and is a Git submodule.
User-facing production is served under `next.singulancelabs.com`; routing and
exact container topology are verified at release time.

Rules:

- Branch, commit, and push the frontend repository first.
- Update the parent gitlink only after the frontend SHA is remotely reachable.
- Backend truth owns identity, role, plan, usage, storage mode, and gates.
- Shared backend changes must be verified in Overview, Talk to HIVE desktop and
  mobile, MCP consumers, and any affected product surface.
- Test lazy chunks/routes and service-worker behavior, not only the main bundle.
- Never place admin, Stripe secret, OAuth secret, or tenant credentials in the
  browser.

Primary shell/router: `frontend/Da-vinci/src/components/hivemind/app/HiveMindApp.jsx`.
