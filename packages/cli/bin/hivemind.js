#!/usr/bin/env node
// HIVEMIND CLI entrypoint. Keep this file thin — all logic lives in src/.

// Defence in depth: when this CLI is invoked via `curl ... | bash`, the
// outer bash's stdin is a non-TTY pipe. Even with the shim's redirect,
// some npx wrappers re-establish the parent's stdin chain — meaning
// prompts() reads EOF and silently exits the picker.
//
// If stdin is not a TTY but /dev/tty exists, reopen stdin against it so
// every interactive question (client picker, paste-key fallback) still
// reaches the user. POSIX-only — no-op on Windows.
import fs from 'node:fs';
import tty from 'node:tty';

function reattachTTY() {
  if (process.stdin.isTTY) return;
  if (process.platform === 'win32') return;
  try {
    const fd = fs.openSync('/dev/tty', 'r');
    if (tty.isatty(fd)) {
      // Replace the readable stream — prompts uses process.stdin directly.
      Object.defineProperty(process, 'stdin', {
        value: new tty.ReadStream(fd),
        configurable: true,
      });
    }
  } catch {
    // /dev/tty may be missing in CI containers — fine, prompts will EOF
    // and the user can rerun with --api-key flag.
  }
}

reattachTTY();

const { main } = await import('../src/index.js');
main(process.argv.slice(2)).catch((err) => {
  console.error('\nhivemind: fatal:', err?.message || err);
  process.exit(1);
});
