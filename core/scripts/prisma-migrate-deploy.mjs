import dns from 'node:dns/promises';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    ...options,
  });

  if (result.error) {
    throw result.error;
  }

  process.exit(result.status ?? 1);
}

export function assertMigrationLedgerSafe({ applicationRelations, currentLedger, archivedLedger, appliedMigrations = 0 }) {
  const relationCount = Number(applicationRelations || 0);
  if (relationCount === 0) return true;
  // Production was explicitly baselined at 160 migrations on 2026-08-17.
  // Refuse a partially-created/replaced ledger: otherwise Prisma interprets
  // historical migrations as pending and can replay them against live tables.
  const baselineFloor = Number(process.env.PRISMA_MIGRATION_BASELINE_FLOOR || 160);
  if (currentLedger && Number(appliedMigrations || 0) >= baselineFloor) return true;
  if (currentLedger) {
    const partial = new Error(
      `Refusing prisma migrate deploy: the application schema has ${relationCount} relations but only `
      + `${Number(appliedMigrations || 0)} applied migration records; the safety floor is ${baselineFloor}.`,
    );
    partial.code = 'MIGRATION_LEDGER_PARTIAL';
    throw partial;
  }
  const archive = archivedLedger ? ' An archived legacy ledger exists.' : '';
  const error = new Error(
    `Refusing prisma migrate deploy: the application schema contains ${applicationRelations} relations `
    + `but its _prisma_migrations ledger is missing.${archive} Baseline/reconcile the production `
    + 'schema explicitly before applying another migration.',
  );
  error.code = 'MIGRATION_LEDGER_UNSAFE';
  throw error;
}

async function verifyMigrationLedger() {
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.$queryRawUnsafe(`
      SELECT
        (SELECT count(*)::int
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = current_schema() AND c.relkind IN ('r','p','v','m','S')) AS application_relations,
        to_regclass(format('%I._prisma_migrations', current_schema())) IS NOT NULL AS current_ledger,
        to_regclass('legacy_public._prisma_migrations') IS NOT NULL AS archived_ledger
    `);
    const state = rows?.[0] || {};
    const applied = state.current_ledger
      ? await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM hivemind._prisma_migrations
          WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`)
      : [{ n: 0 }];
    return assertMigrationLedgerSafe({
      applicationRelations: state.application_relations,
      currentLedger: state.current_ledger,
      archivedLedger: state.archived_ledger,
      appliedMigrations: applied?.[0]?.n || 0,
    });
  } finally {
    await prisma.$disconnect();
  }
}

async function canResolveHost(hostname) {
  try {
    await dns.lookup(hostname);
    return true;
  } catch {
    return false;
  }
}

function getDatabaseHost() {
  const databaseUrl = process.env.DATABASE_URL ?? readDatabaseUrlFromEnvFile();

  if (!databaseUrl) {
    return null;
  }

  try {
    return new URL(databaseUrl).hostname;
  } catch {
    return null;
  }
}

function readDatabaseUrlFromEnvFile() {
  const envPath = path.resolve(scriptDir, '..', '.env');

  try {
    const envContents = fs.readFileSync(envPath, 'utf8');
    const databaseUrlLine = envContents
      .split(/\r?\n/)
      .find((line) => line.startsWith('DATABASE_URL='));

    if (!databaseUrlLine) {
      return null;
    }

    return databaseUrlLine.slice('DATABASE_URL='.length).trim();
  } catch {
    return null;
  }
}

async function main() {
  await verifyMigrationLedger();
  const databaseHost = getDatabaseHost();
  const runningInsideContainer = fs.existsSync('/.dockerenv');

  if (!databaseHost || runningInsideContainer || await canResolveHost(databaseHost)) {
    run('npx', ['prisma', 'migrate', 'deploy']);
  }

  console.error(
    `DATABASE_URL host "${databaseHost}" is not reachable from the host shell; running migration inside hm-core instead.`
  );
  run('docker', [
    'exec',
    'hm-core',
    'sh',
    '-lc',
    'cd /app/core 2>/dev/null || cd /app || exit 1; npx prisma migrate deploy',
  ]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
