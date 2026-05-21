#!/usr/bin/env node
// HIVEMIND CLI entrypoint. Keep this file thin — all logic lives in src/.
import { main } from '../src/index.js';

main(process.argv.slice(2)).catch((err) => {
  console.error('\nhivemind: fatal:', err?.message || err);
  process.exit(1);
});
