// Zero-dependency UI helpers: ANSI colour + an arrow-key picker built on
// raw stdin. Replaces `kleur` + `prompts` so the published tarball is
// self-contained — no `npm install` step in the curl|bash shim, no
// transitive supply-chain surface.
//
// Trade-off: this isn't as polished as `prompts` (no fuzzy filter, no
// fancy borders) but the picker handles arrow keys, j/k, enter, Ctrl-C,
// and Esc — which is the only UX we needed.
import readline from 'node:readline';

// ── Colour ───────────────────────────────────────────────────────────────
// Disable if NO_COLOR is set or stdout isn't a TTY (CI / piped logs).
const useColor = !process.env.NO_COLOR && process.stdout.isTTY;
const wrap = (code) => (s) => useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s);

export const c = {
  bold:      wrap('1'),
  dim:       wrap('2'),
  italic:    wrap('3'),
  underline: wrap('4'),
  red:       wrap('31'),
  green:     wrap('32'),
  yellow:    wrap('33'),
  blue:      wrap('34'),
  magenta:   wrap('35'),
  cyan:      wrap('36'),
  white:     wrap('37'),
  gray:      wrap('90'),
};

// ── select(): arrow-key picker ──────────────────────────────────────────
// Returns the chosen item's `value`, or undefined on cancel.
//
// Renders:
//   ? Question
//   ❯ Option A — description
//     Option B — description
//
// Re-renders the option block in place using ANSI cursor moves. Resilient
// to small terminals (clamps the visible window).
export async function select({ message, choices }) {
  if (!process.stdin.isTTY) {
    // Non-interactive fallback: pick first choice silently. Caller should
    // detect this case earlier and require explicit args instead.
    return choices[0]?.value;
  }

  return new Promise((resolve) => {
    let cursor = 0;
    const stdout = process.stdout;
    const stdin = process.stdin;

    const draw = (first = false) => {
      if (!first) {
        // Move cursor up to the top of the previous render and erase down.
        readline.moveCursor(stdout, 0, -(choices.length + 1));
        readline.clearScreenDown(stdout);
      }
      stdout.write(c.bold(c.cyan('? ')) + c.bold(message) + '\n');
      for (let i = 0; i < choices.length; i++) {
        const selected = i === cursor;
        const prefix = selected ? c.cyan('❯ ') : '  ';
        const label = selected ? c.cyan(c.bold(choices[i].title)) : choices[i].title;
        const desc = choices[i].description ? '  ' + c.dim('— ' + choices[i].description) : '';
        stdout.write(prefix + label + desc + '\n');
      }
    };

    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.removeListener('data', onData);
      stdin.pause();
    };

    const onData = (buf) => {
      const key = buf.toString('utf8');
      // Up: \x1b[A  Down: \x1b[B  Enter: \r or \n  Ctrl-C: \x03
      if (key === '\x1b[A' || key === 'k') {
        cursor = (cursor - 1 + choices.length) % choices.length;
        draw();
      } else if (key === '\x1b[B' || key === 'j') {
        cursor = (cursor + 1) % choices.length;
        draw();
      } else if (key === '\r' || key === '\n') {
        cleanup();
        resolve(choices[cursor].value);
      } else if (key === '\x03' || key === '\x1b') {
        // Ctrl-C or Esc
        cleanup();
        stdout.write('\n');
        resolve(undefined);
      } else if (/^[1-9]$/.test(key)) {
        // Number shortcut: 1 → first, 2 → second, …
        const idx = parseInt(key, 10) - 1;
        if (idx < choices.length) {
          cursor = idx;
          cleanup();
          resolve(choices[cursor].value);
        }
      }
    };

    draw(true);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

// ── prompt(): single line input (with optional masking) ────────────────
export async function prompt({ message, mask = false }) {
  if (!process.stdin.isTTY) return undefined;
  return new Promise((resolve) => {
    const stdout = process.stdout;
    const stdin = process.stdin;
    let buf = '';
    stdout.write(c.bold(c.cyan('? ')) + c.bold(message) + ' ');
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.removeListener('data', onData);
      stdin.pause();
      stdout.write('\n');
    };
    const onData = (b) => {
      const s = b.toString('utf8');
      if (s === '\r' || s === '\n') {
        cleanup();
        resolve(buf);
      } else if (s === '\x03') {
        cleanup();
        resolve(undefined);
      } else if (s === '\x7f' || s === '\b') {
        if (buf.length) {
          buf = buf.slice(0, -1);
          readline.moveCursor(stdout, -1, 0);
          stdout.write(' ');
          readline.moveCursor(stdout, -1, 0);
        }
      } else if (s >= ' ' && s !== '\x1b') {
        buf += s;
        stdout.write(mask ? '•' : s);
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}
