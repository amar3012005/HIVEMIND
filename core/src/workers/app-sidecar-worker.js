if (!process.env.HIVEMIND_RUNTIME_ROLE) {
  process.env.HIVEMIND_RUNTIME_ROLE = 'sidecar';
}

console.log(`[runtime] starting app sidecar worker (role=${process.env.HIVEMIND_RUNTIME_ROLE})`);
await import('../server.js');
