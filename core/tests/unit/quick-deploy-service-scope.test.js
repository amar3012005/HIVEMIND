import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const quick = fs.readFileSync(new URL('../../../scripts/quick-deploy.sh', import.meta.url), 'utf8');
const canonical = fs.readFileSync(new URL('../../../scripts/release-canonical.sh', import.meta.url), 'utf8');

test('canonical migrations derive the same database URL as Compose without duplicating a secret', () => {
  assert.match(canonical, /Docker's --env-file does not evaluate Compose interpolation/);
  assert.match(canonical, /cannot resolve the live Core Docker network for migrations/);
  assert.match(canonical, /--network "\$MIGRATION_NETWORK"/);
  assert.doesNotMatch(canonical, /--network hivemind_default/);
  assert.match(canonical, /export DATABASE_URL="postgresql:\/\/\$\{POSTGRES_USER\}:\$\{POSTGRES_PASSWORD\}@postgres:5432\/\$\{POSTGRES_DB\}\?schema=hivemind/);
});

test('explicit quick-deploy service arguments remain service scoped', () => {
  assert.match(quick, /RELEASE_SCOPE_ARGS=\(--service-scoped\)/);
  assert.match(quick, /--services "\$SERVICES" "\$\{RELEASE_SCOPE_ARGS\[@\]\}"/);
  assert.match(canonical, /--service-scoped\) SERVICE_SCOPED=1/);
  assert.match(canonical, /explicit service-scoped release: only \$SERVICES will be built and replaced/);
});

test('quick-deploy without service arguments retains the full default group', () => {
  assert.match(quick, /if \[ \$# -eq 0 \]; then\s+SERVICES="core,control-plane,employees"/);
});

test('Harness runner releases require a digest-pinned external artifact', () => {
  assert.match(canonical, /harness-runner requires --harness-image/);
  assert.match(canonical, /@sha256:\[0-9a-f\]\{64\}/);
  assert.match(canonical, /docker compose --profile harness-chat/);
});
