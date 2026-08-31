import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const quick = fs.readFileSync(new URL('../../../scripts/quick-deploy.sh', import.meta.url), 'utf8');
const canonical = fs.readFileSync(new URL('../../../scripts/release-canonical.sh', import.meta.url), 'utf8');

test('explicit quick-deploy service arguments remain service scoped', () => {
  assert.match(quick, /RELEASE_SCOPE_ARGS=\(--service-scoped\)/);
  assert.match(quick, /--services "\$SERVICES" "\$\{RELEASE_SCOPE_ARGS\[@\]\}"/);
  assert.match(canonical, /--service-scoped\) SERVICE_SCOPED=1/);
  assert.match(canonical, /explicit service-scoped release: only \$SERVICES will be built and replaced/);
});

test('quick-deploy without service arguments retains the full default group', () => {
  assert.match(quick, /if \[ \$# -eq 0 \]; then\s+SERVICES="core,control-plane,employees"/);
});
