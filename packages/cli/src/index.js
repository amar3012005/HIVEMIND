// Top-level command dispatcher for the HIVEMIND CLI.
//
// Three commands cover 95% of use:
//   hivemind setup            interactive picker (default when no args)
//   hivemind setup <client>   non-interactive — used by docs + FE one-liners
//   hivemind verify           hit /api/mcp w/ the stored API key
//   hivemind list             show every supported client + its config path
//
// All commands accept --api-key, --endpoint, --json so they can be scripted.
import { CLIENTS, findClient } from './clients/index.js';
import { DEFAULT_ENDPOINT } from './lib/config.js';
import { printBanner } from './lib/banner.js';
import { verifyEndpoint } from './lib/verify.js';
import { browserLogin } from './lib/browser-auth.js';
import { c, select, prompt } from './lib/ui.js';

// Default control plane (browser-auth host). The MCP endpoint
// (DEFAULT_ENDPOINT) lives on a different subdomain — control plane handles
// auth + session keys (issues /auth/login → Zitadel + /auth/cli/start), core
// handles MCP RPC. The FE at hivemind.davinciai.eu is a Vercel static build
// that talks to api.hivemind.davinciai.eu:8040 for everything auth-related.
const DEFAULT_CONTROL_PLANE =
  process.env.HIVEMIND_CONTROL_PLANE || 'https://api.hivemind.davinciai.eu:8040';

export async function main(argv) {
  const args = parseArgs(argv);

  // Handle global flags (--version / --help) before falling into the
  // default setup-picker. parseArgs puts dash-prefixed tokens into flags,
  // not _, so we need to check both shapes.
  if (args.flags.version || args.flags.v) {
    return printVersion();
  }
  if (args.flags.help || args.flags.h) {
    return printHelp();
  }

  const cmd = args._[0] || 'setup';

  switch (cmd) {
    case 'setup':
      return cmdSetup(args);
    case 'login':
      return cmdLogin(args);
    case 'verify':
      return cmdVerify(args);
    case 'list':
      return cmdList();
    case 'help':
      return printHelp();
    case 'version':
      return printVersion();
    default:
      console.error(c.red(`Unknown command: ${cmd}`));
      printHelp();
      process.exit(1);
  }
}

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) {
        out.flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
          out.flags[a.slice(2)] = next;
          i++;
        } else {
          out.flags[a.slice(2)] = true;
        }
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

async function cmdSetup(args) {
  printBanner();

  const endpoint = args.flags.endpoint || process.env.HIVEMIND_ENDPOINT || DEFAULT_ENDPOINT;
  let clientId = args._[1];

  if (!clientId) {
    clientId = await select({
      message: 'Which client should HIVEMIND be wired into?',
      choices: CLIENTS.map((cl) => ({ title: cl.name, description: cl.note, value: cl.id })),
    });
    if (!clientId) return; // user hit ctrl-c / esc
  }

  const client = findClient(clientId);
  if (!client) {
    console.error(c.red(`Unknown client: ${clientId}`));
    cmdList();
    process.exit(1);
  }

  // Auth resolution priority:
  //   1. explicit --api-key flag (highest, scriptable)
  //   2. $HIVEMIND_API_KEY env
  //   3. browser handshake (gh-style) — default for interactive humans
  //   4. paste-key fallback when --no-browser is set or browser fails
  let apiKey = args.flags['api-key'] || process.env.HIVEMIND_API_KEY;
  let userEmail = null;

  if (!apiKey) {
    const controlPlane = args.flags['control-plane'] || DEFAULT_CONTROL_PLANE;
    const noBrowser = args.flags['no-browser'] === true || args.flags['no-browser'] === 'true';

    if (!noBrowser) {
      try {
        const result = await browserLogin({ controlPlane });
        apiKey = result.token;
        userEmail = result.userEmail;
        if (userEmail) console.log(c.green('✓') + ` Signed in as ${c.bold(userEmail)}`);
      } catch (err) {
        console.log(c.yellow('!') + ` Browser sign-in failed: ${err.message}`);
        console.log(c.dim('  Falling back to manual API key paste — get one at ' + controlPlane + '/hivemind/app/settings/api-keys'));
      }
    }

    if (!apiKey) {
      apiKey = await prompt({ message: 'Paste your HIVEMIND API key:', mask: true });
      if (!apiKey) return;
    }
  }

  console.log('');
  console.log(c.dim(`→ endpoint  ${endpoint}`));
  console.log(c.dim(`→ target    ${client.name}  (${client.configPath()})`));
  console.log('');

  try {
    const result = await client.install({ endpoint, apiKey });
    console.log(c.green('✓') + ' Wrote config: ' + c.dim(result.path));
  } catch (err) {
    console.log(c.red('✗') + ' Install failed: ' + err.message);
    process.exit(1);
  }

  // Endpoint verify — gives the user an immediate go/no-go signal so they
  // don't spend an hour debugging why Claude can't see tools.
  process.stdout.write(c.dim('  verifying endpoint…'));
  const ver = await verifyEndpoint(endpoint, apiKey);
  if (ver.ok) {
    process.stdout.write('\r' + c.green('✓') + ` Verified (${ver.toolCount} tools available)        \n`);
  } else {
    process.stdout.write('\r' + c.yellow('!') + ` Verification skipped: ${ver.error || 'HTTP ' + ver.statusCode}\n`);
    console.log(c.dim('  (config was still written — your client will retry on restart)'));
  }

  const hint = client.postInstall && client.postInstall();
  if (hint) {
    console.log('');
    console.log(c.cyan('Next: ') + hint);
  }

  if (args.flags.json) {
    console.log(JSON.stringify({ client: clientId, ok: ver.ok, toolCount: ver.toolCount || 0 }));
  }
}

// `hivemind login` — browser handshake without installing a client.
async function cmdLogin(args) {
  printBanner();
  const controlPlane = args.flags['control-plane'] || DEFAULT_CONTROL_PLANE;
  try {
    const { token, userEmail } = await browserLogin({ controlPlane });
    if (userEmail) console.log(c.green('✓') + ` Signed in as ${c.bold(userEmail)}`);
    if (args.flags.json) {
      console.log(JSON.stringify({ ok: true, token, userEmail }));
    } else {
      console.log('');
      console.log(c.bold('Your HIVEMIND API key (treat like a password):'));
      console.log('  ' + token);
      console.log('');
      console.log(c.dim('Add to your shell to skip this step next time:'));
      console.log(c.dim('  export HIVEMIND_API_KEY="' + token + '"'));
    }
  } catch (err) {
    console.log(c.red('✗') + ' Login failed: ' + err.message);
    process.exit(1);
  }
}

async function cmdVerify(args) {
  const endpoint = args.flags.endpoint || DEFAULT_ENDPOINT;
  const apiKey = args.flags['api-key'] || process.env.HIVEMIND_API_KEY;
  if (!apiKey) {
    console.error(c.red('--api-key or $HIVEMIND_API_KEY required'));
    process.exit(1);
  }
  const ver = await verifyEndpoint(endpoint, apiKey);
  if (ver.ok) {
    console.log(c.green('✓') + ` ${endpoint} — ${ver.toolCount} tools`);
  } else {
    console.log(c.red('✗') + ` ${endpoint} — ${ver.error || ver.statusCode}`);
    process.exit(2);
  }
}

function cmdList() {
  console.log('');
  console.log(c.bold('Supported clients:'));
  console.log('');
  for (const cl of CLIENTS) {
    console.log('  ' + c.cyan(cl.id.padEnd(16)) + c.white(cl.name));
    console.log('  ' + ' '.repeat(16) + c.dim(cl.note));
    console.log('  ' + ' '.repeat(16) + c.dim('→ ' + cl.configPath()));
    console.log('');
  }
}

async function printVersion() {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf-8'));
  console.log(pkg.version);
}

function printHelp() {
  console.log(`
${c.bold('hivemind')} — wire HIVEMIND MCP into your AI tools

${c.bold('Usage:')}
  hivemind setup              ${c.dim('# interactive picker — opens browser to sign in')}
  hivemind setup claude-code  ${c.dim('# install for a specific client')}
  hivemind login              ${c.dim('# just open browser, print key (gh-style)')}
  hivemind verify             ${c.dim('# check endpoint + API key')}
  hivemind list               ${c.dim('# show every supported client')}

${c.bold('Flags:')}
  --api-key <key>           ${c.dim('skip browser, use this key (or $HIVEMIND_API_KEY)')}
  --no-browser              ${c.dim('disable browser login, force paste-key prompt')}
  --control-plane <url>     ${c.dim('override hivemind.davinciai.eu host (self-hosted)')}
  --endpoint <url>          ${c.dim('override MCP URL (self-hosted core)')}
  --json                    ${c.dim('emit JSON result on stdout for scripts')}

${c.bold('Clients:')}
  claude-code         ${c.dim('Anthropic CLI (claude mcp add)')}
  claude-desktop      ${c.dim('Claude Desktop app')}
  cursor              ${c.dim('Cursor IDE')}
  vscode              ${c.dim('VS Code (User settings.json)')}
  codex               ${c.dim('OpenAI Codex CLI')}
  antigravity         ${c.dim('Google Antigravity')}

${c.bold('Docs:')}  https://github.com/amar3012005/HIVEMIND/tree/main/packages/cli
`);
}
