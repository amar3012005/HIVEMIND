# SINGULANCE Engine Toolkit

Use this from a clean HIVEMIND checkout:

```bash
bash scripts/singulance-engine.sh status
bash scripts/singulance-engine.sh logs core 200
bash scripts/singulance-engine.sh images
bash scripts/singulance-engine.sh release
```

Only these commands change production, and each requires an explicit confirmation:

```bash
bash scripts/singulance-engine.sh deploy --confirm
bash scripts/singulance-engine.sh rollback core --confirm
bash scripts/singulance-engine.sh prune-images --confirm
```

## Invariants

- The host is fixed to `ssh singulance`; no command targets `myserver`.
- Deployment is fixed to `singulance-main` and delegates to
  `/root/quick-deploy.sh singulance-main` in the foreground.
- `rollback` uses the current service's saved `:stable` image, not an arbitrary
  historical tag.
- `prune-images` keeps every running image plus each service's stable rollback
  image, and only then removes obsolete HIVEMIND image tags and old build cache.
- Health alone is not acceptance. After each deploy, run the relevant authenticated
  user-path check and record it in `docs/PRODUCTION_RELEASE.md`.

## Agent Use

An LLM may run the read-only commands automatically. It must request explicit
approval before `deploy`, `rollback`, or `prune-images`, then report the exact
service image and route behavior observed. Never run Docker commands directly
against production when this toolkit exposes the required operation.
