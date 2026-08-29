# Singulance Feature Registry

This append-only registry records features accepted on the canonical local and
production branches. A local entry requires focused tests plus a healthy local
container. A production entry requires the governed release path, runtime
verification, and its independent rollback control.

## feature-20260829T203749Z — Day 1 lifecycle default-on

- Local status: accepted on `singulance-local`.
- Capability: reusable Cloudflare Workflow lifecycle for Day 1 research delivery,
  responsive branded email rendering, Humation character colors, and projection
  of every accepted transactional email into platform notifications.
- Safety: local preview-mail gateway and local-only Compose settings are preserved;
  the Day 1 overlay supplies a non-production admin secret and never imports a
  production database or service credential.
- Verification: 30 focused email, notification, Humation, and Day 1 unit tests
  passed; `hivemind-control-plane-local` rebuilt from this branch and reached
  `healthy`.
- Production counterpart: runtime commit `d843a66885878a605c4bc6d9589e207d568433b4`;
  Cloudflare flag `day1_first_move_v1`; Worker `hivemind-day1-lifecycle`.
- Rollback: disable the Flagship flag or the backend
  `HIVEMIND_D1_WORKFLOW_ENABLED` master gate.
