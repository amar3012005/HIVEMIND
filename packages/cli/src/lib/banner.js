import { c } from './ui.js';

export function printBanner() {
  const line = (s) => process.stdout.write(s + '\n');
  line('');
  line(c.cyan('  ╭─ ') + c.bold(c.white('HIVEMIND')) + c.cyan(' ─╮'));
  line(c.cyan('  │ ') + c.dim('persistent memory · ') + c.dim('mcp ready') + c.cyan('  │'));
  line(c.cyan('  ╰─────────────────────────╯'));
  line('');
}
