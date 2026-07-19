# Current SINGULANCE Production Release

This file is the deployment ledger. Update it only after production acceptance succeeds.

```yaml
release_id: prod-20260719-366c551a
host: singulance
deployed_at_utc: 2026-07-19T11:37:30Z
parent:
  branch: singulance-main
  sha: 366c551aaa02844c38519fd8d4f7662e2142eea9
frontend:
  sha: 866c98372cd309687e1d45fa4b3696a241ffa04d
runtime:
  VERSION: latest
  NEXT_VERSION: latest
images:
  frontend_single: sha256:18b16c4198bd39a8eb3d457a881a252400f3b374b1509a833963dffa5465c19d
changes:
  - Deferred cinematic frame-sequence initialization until the scene is near the viewport.
  - Prevented the HIVEMIND landing page from preloading 121 sovereign frames during application startup.
acceptance:
  public: [hivemind_200, login_200, overview_200, mobile_chat_200]
  runtime: [landing_rendered, cinematic_frames_requested_at_startup_0]
  fresh_fatal_errors: 0
rollback:
  frontend_single: hivemind/fe:stable-single (sha256:7482970476f87b354029de6304e3d176e51dca83c0a1d5486648b6ed57a64f27)
```

No customer email, connector action, or telephone call was triggered during release acceptance.
