// Update notices are durable UI state across navigation, never an automatic reload.
function frontendChanged(manifest, remote) {
  const current = Object.keys(manifest.assets || {}).find(key => /^app:\/static\/js\/main\.[^/]+\.js$/.test(key));
  const next = remote?.files?.['main.js'];
  return Boolean(current && typeof next === 'string' && current.slice(4) !== next);
}
module.exports = { frontendChanged };
