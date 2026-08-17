import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const compose = fs.readFileSync(new URL('../../../infra/docker-compose.hetzner.yml', import.meta.url), 'utf8');
const dockerfile = fs.readFileSync(new URL('../../../infra/postgres/Dockerfile.age', import.meta.url), 'utf8');
const config = fs.readFileSync(new URL('../../../infra/postgres/pgbackrest.conf', import.meta.url), 'utf8');
const wrapper = fs.readFileSync(new URL('../../../infra/postgres/hivemind-pgbackrest.sh', import.meta.url), 'utf8');
const drill = fs.readFileSync(new URL('../../../infra/scripts/singulance-pitr-restore-drill.sh', import.meta.url), 'utf8');
const fullTimer = fs.readFileSync(new URL('../../../infra/scripts/singulance-pitr-backup@full.timer', import.meta.url), 'utf8');
const diffTimer = fs.readFileSync(new URL('../../../infra/scripts/singulance-pitr-backup@diff.timer', import.meta.url), 'utf8');

test('managed PostgreSQL PITR is opt-in and keeps its key outside application containers', () => {
  assert.match(compose, /archive_mode=\$\{POSTGRES_ARCHIVE_MODE:-off\}/);
  assert.match(compose, /postgres-pitr-secrets:\/run\/secrets\/hivemind-pitr:ro/);
  const coreBlock = compose.slice(compose.indexOf('  core:'), compose.indexOf('\n  control-plane:'));
  assert.doesNotMatch(coreBlock, /postgres-pitr-secrets|PGBACKREST_REPO1_CIPHER_PASS/);
});

test('PITR drill restores to a named target in a disposable volume', () => {
  assert.match(drill, /pg_create_restore_point/);
  assert.match(drill, /--type=name --target=/);
  assert.match(drill, /baseline.*== 1 && .*after.*== 0/s);
  assert.match(drill, /docker volume rm/);
});

test('PITR schedules recurring full and differential backups', () => {
  assert.match(fullTimer, /OnCalendar=Sun/);
  assert.match(diffTimer, /OnCalendar=Mon\.\.Sat/);
  assert.match(fullTimer, /Persistent=true/);
  assert.match(diffTimer, /Persistent=true/);
});

test('pgBackRest repository encrypts backups and archives with bounded retention', () => {
  assert.match(dockerfile, /pgbackrest/);
  assert.match(config, /repo1-cipher-type=aes-256-cbc/);
  assert.match(config, /repo1-retention-full=2/);
  assert.match(compose, /archive_command=hivemind-pgbackrest --stanza=hivemind archive-push %p/);
  assert.match(wrapper, /PGBACKREST_REPO1_CIPHER_PASS/);
  assert.match(wrapper, /PGUSER=.*POSTGRES_USER/);
  assert.doesNotMatch(config, /repo1-cipher-pass=/);
});
