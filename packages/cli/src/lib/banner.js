// Compact ASCII banner used at the top of interactive flows.
// Kept intentionally small so it doesn't dominate the terminal.
import kleur from 'kleur';

export function printBanner() {
  const line = (s) => process.stdout.write(s + '\n');
  line('');
  line(kleur.cyan('  ╭─ ') + kleur.bold().white('HIVEMIND') + kleur.cyan(' ─╮'));
  line(kleur.cyan('  │ ') + kleur.dim('persistent memory · ') + kleur.dim('mcp ready') + kleur.cyan('  │'));
  line(kleur.cyan('  ╰─────────────────────────╯'));
  line('');
}
