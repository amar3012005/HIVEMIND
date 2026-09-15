/** Layout: one org sandbox; each invited user gets an isolated workspace. */
import fs from 'node:fs';
import path from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const root = String(process.env.DSH_WORKSPACE || '/data/fs');
const orgId = String(process.env.HIVEMIND_ORG_ID || '').trim();
const owner = String(process.env.HIVEMIND_USER_ID || '').trim();
const invited = String(process.env.HIVEMIND_INVITED_USER_IDS || '')
  .split(',')
  .map((id) => id.trim())
  .filter((id) => UUID.test(id));

if (!UUID.test(orgId)) {
  process.stderr.write('ensure-org-fs: HIVEMIND_ORG_ID must be a UUID\n');
  process.exit(0);
}

const orgRoot = path.join(root, 'org', orgId);
const users = new Set(invited);
if (UUID.test(owner)) users.add(owner);
else users.add(orgId);

fs.mkdirSync(path.join(orgRoot, 'shared'), { recursive: true, mode: 0o750 });
for (const userId of users) {
  fs.mkdirSync(path.join(orgRoot, 'users', userId, 'workspace'), { recursive: true, mode: 0o750 });
}
fs.writeFileSync(
  path.join(orgRoot, 'README.txt'),
  [
    'SINGULANCE org sandbox',
    `org: ${orgId}`,
    'shared/                 org-wide files',
    'users/<userId>/workspace  isolated per invited user',
    'One user owns the org sandbox. Additional users get their own users/<id>/ tree.',
    '',
  ].join('\n'),
);
process.stdout.write(JSON.stringify({ event: 'org_fs_ready', orgId, users: [...users] }) + '\n');
