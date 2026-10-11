import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const quick = fs.readFileSync(new URL('../../../scripts/quick-deploy.sh', import.meta.url), 'utf8');
const canonical = fs.readFileSync(new URL('../../../scripts/release-canonical.sh', import.meta.url), 'utf8');
const workflow = fs.readFileSync(new URL('../../../.github/workflows/singulance-production-hetzner.yml', import.meta.url), 'utf8');

test('canonical migrations derive the same database URL as Compose without duplicating a secret', () => {
  assert.match(canonical, /Docker's --env-file does not evaluate Compose interpolation/);
  assert.match(canonical, /cannot resolve the live Core Docker network for migrations/);
  assert.match(canonical, /docker network inspect "\$MIGRATION_NETWORK_ID" --format '\{\{\.Name\}\}'/);
  assert.match(canonical, /--network "\$MIGRATION_NETWORK"/);
  assert.doesNotMatch(canonical, /--network hivemind_default/);
  assert.match(canonical, /com\.docker\.compose\.project/);
  assert.match(canonical, /--project-name "\$COMPOSE_PROJECT"/);
  assert.match(canonical, /export DATABASE_URL="postgresql:\/\/\$\{POSTGRES_USER\}:\$\{POSTGRES_PASSWORD\}@postgres:5432\/\$\{POSTGRES_DB\}\?schema=hivemind/);
});

test('explicit quick-deploy service arguments remain service scoped', () => {
  assert.match(quick, /RELEASE_SCOPE_ARGS=\(--service-scoped\)/);
  assert.match(quick, /--services "\$SERVICES" "\$\{RELEASE_SCOPE_ARGS\[@\]\}"/);
  assert.match(quick, /OPEN_DOT_ARGS=\(\)/);
  assert.match(quick, /--open-dot-mode "\$OPEN_DOT_MODE"/);
  assert.match(canonical, /--service-scoped\) SERVICE_SCOPED=1/);
  assert.match(canonical, /explicit service-scoped release: only \$SERVICES will be built and replaced/);
});

test('quick-deploy without service arguments retains the full default group', () => {
  assert.match(quick, /if \[ \$# -eq 0 \]; then\s+SERVICES="core,control-plane,employees"/);
});

test('workflow bootstraps quick-deploy from the verified exact SHA without overwriting the installed wrapper', () => {
  assert.match(workflow, /RELEASE_SOURCE_SHA=\$HEAD/);
  assert.match(workflow, /git -C \/root\/hivemind-main fetch --quiet https:\/\/github\.com\/amar3012005\/HIVEMIND\.git "\$RELEASE_SOURCE_SHA"/);
  assert.match(workflow, /show "\$RELEASE_SOURCE_SHA:scripts\/quick-deploy\.sh" > "\$BOOTSTRAP"/);
  assert.match(workflow, /"\$BOOTSTRAP" singulance-main/);
  assert.doesNotMatch(workflow, /\/root\/quick-deploy\.sh singulance-main/);
  assert.match(quick, /SINGULANCE_EXPECTED_SHA must be a full 40-character commit SHA/);
  assert.match(quick, /canonical branch moved from expected/);
});

test('single-user Open Dot mode stays protected, isolated, and TLS-gated before ingress succeeds', () => {
  const compose = fs.readFileSync(new URL('../../../infra/docker-compose.hetzner.yml', import.meta.url), 'utf8');
  const docs = fs.readFileSync(new URL('../../../docs/OPEN_DOT_PRODUCTION_DEPLOYMENT.md', import.meta.url), 'utf8');
  const provisioner = fs.readFileSync(new URL('../../../scripts/provision-open-dot-owner-binding.py', import.meta.url), 'utf8');
  const localService = compose.split('  open-dot-local:\n')[1]?.split('\n  employees:\n')[0] ?? '';
  assert.match(localService, /profiles: \["open-dot-local"\]/);
  assert.match(localService, /DOTS_DEPLOYMENT_MODE: local/);
  assert.match(localService, /DOTS_PROTECTED_LOCAL_SERVER: "1"/);
  assert.match(localService, /DOTS_TENANT_ID: \$\{OPEN_DOT_ORGANIZATION_ID/);
  assert.match(localService, /DOTS_USER_ID: \$\{OPEN_DOT_USER_ID/);
  assert.match(localService, /open-dot-local-data:\/data/);
  assert.match(localService, /networks: \[open-dot-local\]/);
  assert.match(compose, /open-dot-local:\n\s+name: hivemind-open-dot-local/);
  assert.match(compose, /open-dot-local-data:\n\s+name: hivemind-open-dot-local-data/);
  assert.doesNotMatch(localService, /depends_on:|OPEN_DOT_DATABASE_URL|open-dot-postgres/);
  assert.match(canonical, /\[ "\$FAIL" = 0 \][\s\S]*refusing to publish ingress/);
  assert.match(canonical, /curl -sS -o \/dev\/null -w '%\{http_code\}' --max-time 10/);
  assert.match(canonical, /TLS-verified \$\{local_public_url\}\/api\/health/);
  assert.doesNotMatch(canonical, /curl -sk[^\n]*local_public_url/);
  assert.match(docs, /AMAR \(`amarsai2005@gmail.com`\)/);
  assert.match(canonical, /provision-open-dot-owner-binding\.py/);
  assert.match(provisioner, /u\.email = \$\{'amarsai2005@gmail\.com'\}/);
  assert.match(provisioner, /UPPER\(o\.name\) = \$\{'SINGULANCE'\}/);
  assert.match(provisioner, /uo\.is_active = TRUE/);
  assert.match(provisioner, /rows\.length !== 1/);
  assert.match(provisioner, /stderr=subprocess\.DEVNULL/);
  assert.match(provisioner, /os\.replace\(temp_name, path\)/);
  assert.match(docs, /exact verified account and active SINGULANCE owner membership/);
});

test('Harness runner releases require a digest-pinned external artifact', () => {
  assert.match(canonical, /harness-runner requires --harness-image/);
  assert.match(canonical, /@sha256:\[0-9a-f\]\{64\}/);
  assert.match(canonical, /COMPOSE_PROFILES=\(--profile harness-chat\)/);
  assert.match(canonical, /docker compose --project-name "\$COMPOSE_PROJECT" "\$\{COMPOSE_PROFILES\[@\]\}"/);
});
