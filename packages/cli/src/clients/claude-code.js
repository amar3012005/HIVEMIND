// Claude Code (Anthropic CLI). We don't touch a config file directly —
// the `claude` binary owns its own MCP registry and exposes `claude mcp add`
// with proper scope semantics. Calling the CLI keeps us forward-compatible
// when Anthropic changes the on-disk format.
//
// Cleanup-then-add is the idempotency trick: a bare `claude mcp remove` errors
// when the entry exists in multiple scopes (user/local/project), and the next
// `mcp add` then refuses with "already exists". So we silently remove from all
// three scopes before adding fresh in --scope user.
import { execSync, spawnSync } from 'node:child_process';

function claudeBin() {
  try {
    return execSync(process.platform === 'win32' ? 'where claude' : 'command -v claude', { encoding: 'utf-8' }).trim().split(/\r?\n/)[0];
  } catch {
    return null;
  }
}

export const claudeCode = {
  id: 'claude-code',
  name: 'Claude Code',
  note: '`claude` CLI — registers MCP via official command',
  configPath: () => '(managed by `claude` CLI; no file written by hivemind)',
  async install({ endpoint, apiKey }) {
    const bin = claudeBin();
    if (!bin) {
      throw new Error(
        '`claude` CLI not found on PATH. Install it first:\n' +
        '  macOS / Linux:  curl -fsSL https://claude.ai/install.sh | bash\n' +
        '  Windows:        irm https://claude.ai/install.ps1 | iex\n' +
        'Then re-run this command.'
      );
    }
    for (const scope of ['user', 'local', 'project']) {
      spawnSync(bin, ['mcp', 'remove', 'hivemind', '-s', scope], { stdio: 'ignore' });
    }
    const result = spawnSync(bin, [
      'mcp', 'add',
      '--scope', 'user',
      '--transport', 'http',
      'hivemind', endpoint,
      '--header', `Authorization: Bearer ${apiKey}`,
    ], { encoding: 'utf-8' });

    if (result.status !== 0) {
      throw new Error(`claude mcp add failed:\n${result.stderr || result.stdout}`);
    }
    return { path: '(claude CLI registry)' };
  },
  postInstall() {
    return 'Run `claude mcp list` to verify. New chats will see HIVEMIND tools automatically.';
  },
};
