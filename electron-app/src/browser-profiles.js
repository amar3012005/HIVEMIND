const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/;
const PROFILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function browserPaths(userDataPath) {
  if (typeof userDataPath !== 'string' || !path.isAbsolute(userDataPath)) throw new Error('SINGULANCE user-data path must be absolute');
  const root = path.join(userDataPath, 'agent-browser');
  return { root, browsers: path.join(root, 'browsers'), profiles: path.join(root, 'profiles'), registry: path.join(root, 'profiles.json') };
}
function ensurePrivateDir(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Agent browser data directory must be a real directory');
  try { fs.chmodSync(directory, 0o700); } catch {}
}
function normalizeAgentName(name) {
  if (typeof name !== 'string') throw new Error('Enter a unique agent name');
  const value = name.trim();
  if (!AGENT_NAME.test(value)) throw new Error('Use 1–64 letters, numbers, spaces, dots, underscores, or hyphens; start with a letter or number');
  return value;
}
function readProfiles(userDataPath) {
  try {
    const data = JSON.parse(fs.readFileSync(browserPaths(userDataPath).registry, 'utf8'));
    if (data?.schema !== 1 || !Array.isArray(data.profiles)) throw new Error('Invalid registry');
    const names = new Set(); const ids = new Set();
    for (const profile of data.profiles) {
      if (!profile || !PROFILE_ID.test(profile.id || '') || normalizeAgentName(profile.name) !== profile.name || names.has(profile.name.toLowerCase()) || ids.has(profile.id)) throw new Error('Invalid profile');
      names.add(profile.name.toLowerCase()); ids.add(profile.id);
    }
    return data.profiles;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error('SINGULANCE agent browser profile registry is invalid');
  }
}
function writeProfiles(userDataPath, profiles) {
  const paths = browserPaths(userDataPath);
  ensurePrivateDir(paths.root); ensurePrivateDir(paths.profiles);
  const temporary = `${paths.registry}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(descriptor, JSON.stringify({ schema: 1, profiles }, null, 2) + '\n'); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, paths.registry);
  try { fs.chmodSync(paths.registry, 0o600); } catch {}
}
function getAgentProfile({ userDataPath, profileId }) {
  if (!PROFILE_ID.test(profileId || '')) throw new Error('Unknown agent browser profile');
  const profile = readProfiles(userDataPath).find(item => item.id === profileId);
  if (!profile) throw new Error('Unknown agent browser profile');
  const root = path.resolve(browserPaths(userDataPath).profiles);
  const profilePath = path.resolve(root, profileId);
  if (path.dirname(profilePath) !== root) throw new Error('Invalid agent browser profile path');
  try {
    const stat = fs.lstatSync(profilePath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Agent browser profiles must not use symlinks');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { ...profile, profilePath };
}
function createAgentProfile({ userDataPath, name, now = new Date().toISOString(), id = crypto.randomUUID() }) {
  const displayName = normalizeAgentName(name);
  if (!PROFILE_ID.test(id)) throw new Error('Invalid generated agent profile ID');
  const profiles = readProfiles(userDataPath);
  if (profiles.some(profile => profile.name.toLowerCase() === displayName.toLowerCase())) throw new Error('That agent name is already in use on this Mac. Choose a unique name.');
  const profilePath = path.join(browserPaths(userDataPath).profiles, id);
  ensurePrivateDir(profilePath);
  const profile = { id, name: displayName, createdAt: now };
  try { writeProfiles(userDataPath, [...profiles, profile]); }
  catch (error) { fs.rmSync(profilePath, { recursive: true, force: true }); throw error; }
  return { ...profile, profilePath };
}
function ensureDefaultProfile(userDataPath) {
  const existing = readProfiles(userDataPath).find(profile => profile.name === 'SINGULANCE Browser');
  return existing ? getAgentProfile({ userDataPath, profileId: existing.id }) : createAgentProfile({ userDataPath, name: 'SINGULANCE Browser' });
}
function profileIsActive(profilePath) {
  for (const file of ['SingletonLock', 'SingletonSocket']) {
    try { fs.lstatSync(path.join(profilePath, file)); return true; } catch (error) { if (error.code !== 'ENOENT') return true; }
  }
  return false;
}
function removeAgentProfile({ userDataPath, profileId }) {
  const profile = getAgentProfile({ userDataPath, profileId });
  if (profileIsActive(profile.profilePath)) throw new Error('Close this agent browser before deleting its profile');
  const profiles = readProfiles(userDataPath).filter(item => item.id !== profileId);
  fs.rmSync(profile.profilePath, { recursive: true, force: true }); writeProfiles(userDataPath, profiles);
  return profile;
}
module.exports = { AGENT_NAME, PROFILE_ID, browserPaths, ensurePrivateDir, normalizeAgentName, readProfiles,
  createAgentProfile, ensureDefaultProfile, getAgentProfile, profileIsActive, removeAgentProfile };
