if (!process.env.HIVEMIND_RUNTIME_ROLE) {
  process.env.HIVEMIND_RUNTIME_ROLE = 'maintenance';
}

console.log(`[runtime] starting memory maintenance worker (role=${process.env.HIVEMIND_RUNTIME_ROLE})`);
await import('../server.js');
