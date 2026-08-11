import fs from 'node:fs';
import path from 'node:path';

function readRegistry(registryFile) {
  try {
    const value = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
}

function writeRegistry(registryFile, registry) {
  fs.mkdirSync(path.dirname(registryFile), { recursive: true });
  const temporary = `${registryFile}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(registry), { mode: 0o600 });
  fs.renameSync(temporary, registryFile);
}

export function registerEmbeddedAmrOrg(orgId, registryFile) {
  const registry = readRegistry(registryFile);
  registry[orgId] = { url: 'local:', token: '', kind: 'amr-central' };
  writeRegistry(registryFile, registry);
}

export function unregisterEmbeddedAmrOrg(orgId, registryFile) {
  const registry = readRegistry(registryFile);
  if (registry[orgId]?.url !== 'local:' || registry[orgId]?.kind !== 'amr-central') return false;
  delete registry[orgId];
  writeRegistry(registryFile, registry);
  return true;
}
