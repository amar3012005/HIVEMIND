#!/usr/bin/env node
// HIVEMIND CLI entrypoint. Keep this file thin — all logic lives in src/.
//
// stdin reattachment is handled by the shim (/install/cli.sh does
// `exec </dev/tty >/dev/tty 2>/dev/tty`). Doing it again here in JS via
// Object.defineProperty(process, 'stdin', ...) caused subtle breakage in
// the select() raw-mode picker, so we trust bash.

import('../src/index.js').then(({ main }) => main(process.argv.slice(2))).catch((err) => {
  console.error('\nhivemind: fatal:', err?.message || err);
  process.exit(1);
});
