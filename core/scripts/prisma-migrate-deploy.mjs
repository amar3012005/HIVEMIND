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

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});