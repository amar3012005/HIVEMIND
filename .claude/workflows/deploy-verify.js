export const meta = {
  name: 'deploy-verify',
  description: 'Post-deploy verification for HIVEMIND prod: box-vs-origin sync + box-patch-hazard scan, hm-core health, parallel endpoint smoke, recall-eval gate. READ-ONLY — does not pull or restart (the ship skill does that).',
  whenToUse: 'Run right after deploying hm-core to confirm the box is in sync, healthy, and recall has not regressed. Surfaces the staged/untracked-file pull hazards before they bite. Mirrors the `.claude/scripts/hm sync | status | smoke | eval` read-only commands as a parallel fan-out.',
  phases: [{ title: 'Verify' }],
}

phase('Verify')
const checks = await parallel([
  () => agent(
    'SSH alias `myserver` (Hetzner prod). Confirm /opt/HIVEMIND is in sync with origin/main: compare `git -C /opt/HIVEMIND rev-parse HEAD` to `git -C /opt/HIVEMIND ls-remote origin main`. Then report any BOX-PATCH HAZARD: `git -C /opt/HIVEMIND status --porcelain | grep -vE "^\\?\\?"` (tracked-modified or staged files that will block the next git pull). Report SYNCED or DRIFTED + the exact files.',
    { label: 'box-sync', phase: 'Verify' },
  ),
  () => agent(
    'SSH `myserver`. Is hm-core up? `docker ps --filter name=hm-core --format "{{.Status}}"`. Then scan boot: `docker logs hm-core --since 90s 2>&1 | grep -iE "listening|error|SyntaxError|cannot find" | grep -viE "redis|getaddr|ENOTFOUND"`. Report HEALTHY (listening, no import errors) or quote the error.',
    { label: 'health', phase: 'Verify' },
  ),
  () => agent(
    'SSH `myserver`. Smoke /api/chat and /api/recall in-container using the master key + the canonical X-HM-User-Id / X-HM-Org-Id test headers (exact curl + IDs are in the hivemind-apex skill — do NOT hardcode the key here). Confirm each returns sane structured JSON (not 401/500). Report PASS/FAIL per endpoint with a one-line excerpt.',
    { label: 'smoke', phase: 'Verify' },
  ),
  () => agent(
    'SSH `myserver`. Run the recall eval harness: `docker exec hm-core node /app/scripts/eval-harness.mjs 2>&1 | tail -20`. Report combo@8 and MRR, and whether it REGRESSED below the baseline (combo@8 = 1.00, MRR ≈ 0.87). If the harness path differs, find it under /app/scripts and say so.',
    { label: 'recall-eval', phase: 'Verify' },
  ),
]).then((r) => r.filter(Boolean))

const drift = /DRIFT/i.test(checks[0] || '')
const unhealthy = !/HEALTHY|listening/i.test(checks[1] || '')
log(`box-sync ${drift ? 'DRIFTED ⚠' : 'ok'} · health ${unhealthy ? 'CHECK ⚠' : 'ok'}`)
return { checks, flags: { drift, unhealthy } }
