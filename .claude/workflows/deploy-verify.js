export const meta = {
  name: 'deploy-verify',
  description: 'Read-only SINGULANCE release identity and acceptance audit.',
  whenToUse: 'After a reviewed release, or when runtime drift is suspected.',
  phases: [{ title: 'Verify' }],
}

phase('Verify')
const checks = await parallel([
  () => agent(
    'Read docs/PRODUCTION_RELEASE_PROTOCOL.md and docs/PRODUCTION_RELEASE.md. On ssh singulance, compare the recorded live SHA, /root/hivemind-next HEAD, running container image tags, and immutable digests. Do not mutate anything. Report exact drift.',
    { label: 'release-identity', phase: 'Verify' },
  ),
  () => agent(
    'On ssh singulance, inspect Core, Control, Employees, TARA, and frontend container health plus fresh fatal/OOM/unhandled logs. Read-only. Quote failures; do not restart.',
    { label: 'runtime-health', phase: 'Verify' },
  ),
  () => agent(
    'Run public health/home/login checks and the release-specific authenticated canary described in the ledger. Do not use or print secrets in the report. Distinguish route health from feature acceptance.',
    { label: 'acceptance', phase: 'Verify' },
  ),
]).then((results) => results.filter(Boolean))

return { checks }
