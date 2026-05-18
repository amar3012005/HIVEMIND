import fs from 'fs';
import path from 'path';
import { access } from 'fs/promises';

const chromiumPath =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  '/usr/bin/chromium';

const sessionsDir =
  process.env.HIVEMIND_WHATSAPP_SESSIONS_DIR ||
  '/opt/hivemind-data/whatsapp-sessions';

const checks = [];

async function canAccess(targetPath, mode) {
  try {
    await access(targetPath, mode);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const chromiumExists = fs.existsSync(chromiumPath);
  const chromiumExecutable = chromiumExists
    ? await canAccess(chromiumPath, fs.constants.X_OK)
    : false;

  checks.push({
    name: 'Chromium exists',
    ok: chromiumExists,
    detail: chromiumPath,
  });

  checks.push({
    name: 'Chromium executable',
    ok: chromiumExecutable,
    detail: chromiumPath,
  });

  const sessionsExists = fs.existsSync(sessionsDir);
  let createError = null;
  if (!sessionsExists) {
    try {
      fs.mkdirSync(sessionsDir, { recursive: true });
    } catch (err) {
      createError = err;
    }
  }

  const sessionsStat = fs.existsSync(sessionsDir) ? fs.statSync(sessionsDir) : null;
  const sessionsWritable = await canAccess(sessionsDir, fs.constants.W_OK);

  checks.push({
    name: 'Sessions dir exists',
    ok: Boolean(sessionsStat?.isDirectory?.()),
    detail: createError ? `${sessionsDir} (${createError.message})` : sessionsDir,
  });

  checks.push({
    name: 'Sessions dir writable',
    ok: sessionsWritable,
    detail: sessionsDir,
  });

  const lockProbe = path.join(sessionsDir, '.write-test');
  let writeProbeOk = false;
  try {
    fs.writeFileSync(lockProbe, 'ok');
    fs.rmSync(lockProbe, { force: true });
    writeProbeOk = true;
  } catch {
    writeProbeOk = false;
  }

  checks.push({
    name: 'Sessions dir write probe',
    ok: writeProbeOk,
    detail: sessionsDir,
  });

  const failures = checks.filter((item) => !item.ok);

  console.log('WhatsApp runtime check');
  console.log(`PUPPETEER_EXECUTABLE_PATH=${chromiumPath}`);
  console.log(`HIVEMIND_WHATSAPP_SESSIONS_DIR=${sessionsDir}`);
  console.log('');

  for (const item of checks) {
    console.log(`${item.ok ? 'OK' : 'FAIL'}  ${item.name}  ${item.detail}`);
  }

  if (failures.length > 0) {
    console.error('');
    console.error(`WhatsApp runtime check failed with ${failures.length} issue(s).`);
    process.exit(1);
  }

  console.log('');
  console.log('WhatsApp runtime looks ready for QR pairing.');
}

main().catch((err) => {
  console.error(err.message || String(err));
  process.exit(1);
});
