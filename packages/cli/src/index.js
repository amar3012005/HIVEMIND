// Top-level command dispatcher for the HIVEMIND CLI.
//
// Three commands cover 95% of use:
//   hivemind setup            interactive picker (default when no args)
//   hivemind setup <client>   non-interactive — used by docs + FE one-liners
//   hivemind verify           hit /api/mcp w/ the stored API key
//   hivemind list             show every supported client + its config path
//
// All commands accept --api-key, --endpoint, --json so they can be scripted.
import kleur from 'kleur';
import prompts from 'prompts';
import { CLIENTS, findClient } from './clients/index.js';
import { DEFAULT_ENDPOINT } from './lib/config.js';
import { printBanner } from './lib/banner.js';
import { verifyEndpoint } from './lib/verify.js';
import { browserLogin } from './lib/browser-auth.js';

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
    case '--help':
    case '-h':
      return printHelp();
    case 'version':
      return printVersion();
    default:
      console.error(kleur.red(`Unknown command: ${cmd}`));
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
    const ans = await prompts({
      type: 'select',
      name: 'clientId',
      message: 'Which client should HIVEMIND be wired into?',
      choices: CLIENTS.map((c) => ({ title: c.name, description: c.note, value: c.id })),
    });
    clientId = ans.clientId;
    if (!clientId) return; // user hit ctrl-c
  }

  const client = findClient(clientId);
  if (!client) {
    console.error(kleur.red(`Unknown client: ${clientId}`));
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
        if (userEmail) console.log(kleur.green('✓') + ` Signed in as ${kleur.bold(userEmail)}`);
      } catch (err) {
        console.log(kleur.yellow('!') + ` Browser sign-in failed: ${err.message}`);
        console.log(kleur.dim('  Falling back to manual API key paste — get one at ' + controlPlane + '/hivemind/app/settings/api-keys'));
      }
    }

    if (!apiKey) {
      const ans = await prompts({
        type: 'password',
        name: 'apiKey',
        message: 'Paste your HIVEMIND API key:',
        validate: (v) => (v && v.length > 8 ? true : 'API key looks too short'),
      });
      apiKey = ans.apiKey;
      if (!apiKey) return;
    }
  }

  console.log('');
  console.log(kleur.dim(`→ endpoint  ${endpoint}`));
  console.log(kleur.dim(`→ target    ${client.name}  (${client.configPath()})`));
  console.log('');

  try {
    const result = await client.install({ endpoint, apiKey });
    console.log(kleur.green('✓') + ' Wrote config: ' + kleur.dim(result.path));
  } catch (err) {
    console.log(kleur.red('✗') + ' Install failed: ' + err.message);
    process.exit(1);
  }

  // Endpoint verify — gives the user an immediate go/no-go signal so they
  // don't spend an hour debugging why Claude can't see tools.
  process.stdout.write(kleur.dim('  verifying endpoint…'));
  const ver = await verifyEndpoint(endpoint, apiKey);
  if (ver.ok) {
    process.stdout.write('\r' + kleur.green('✓') + ` Verified (${ver.toolCount} tools available)        \n`);
  } else {
    process.stdout.write('\r' + kleur.yellow('!') + ` Verification skipped: ${ver.error || 'HTTP ' + ver.statusCode}\n`);
    console.log(kleur.dim('  (config was still written — your client will retry on restart)'));
  }

  const hint = client.postInstall && client.postInstall();
  if (hint) {
    console.log('');
    console.log(kleur.cyan('Next: ') + hint);
  }

  if (args.flags.json) {
    console.log(JSON.stringify({ client: clientId, ok: ver.ok, toolCount: ver.toolCount || 0 }));
  }
}

// `hivemind login` — browser handshake without installing a client.
// Prints the resulting key + minimal env-var snippet so users can paste
// it into shell rc files or re-use for `hivemind verify`.
async function cmdLogin(args) {
  printBanner();
  const controlPlane = args.flags['control-plane'] || DEFAULT_CONTROL_PLANE;
  try {
    const { token, userEmail } = await browserLogin({ controlPlane });
    if (userEmail) console.log(kleur.green('✓') + ` Signed in as ${kleur.bold(userEmail)}`);
    if (args.flags.json) {
      console.log(JSON.stringify({ ok: true, token, userEmail }));
    } else {
      console.log('');
      console.log(kleur.bold('Your HIVEMIND API key (treat like a password):'));
      console.log('  ' + token);
      console.log('');
      console.log(kleur.dim('Add to your shell to skip this step next time:'));
      console.log(kleur.dim('  export HIVEMIND_API_KEY="' + token + '"'));
    }
  } catch (err) {
    console.log(kleur.red('✗') + ' Login failed: ' + err.message);
    process.exit(1);
  }
}

async function cmdVerify(args) {
  const endpoint = args.flags.endpoint || DEFAULT_ENDPOINT;
  const apiKey = args.flags['api-key'] || process.env.HIVEMIND_API_KEY;
  if (!apiKey) {
    console.error(kleur.red('--api-key or $HIVEMIND_API_KEY required'));
    process.exit(1);
  }
  const ver = await verifyEndpoint(endpoint, apiKey);
  if (ver.ok) {
    console.log(kleur.green('✓') + ` ${endpoint} — ${ver.toolCount} tools`);
  } else {
    console.log(kleur.red('✗') + ` ${endpoint} — ${ver.error || ver.statusCode}`);
    process.exit(2);
  }
}

function cmdList() {
  console.log('');
  console.log(kleur.bold('Supported clients:'));
  console.log('');
  for (const c of CLIENTS) {
    console.log('  ' + kleur.cyan(c.id.padEnd(16)) + kleur.white(c.name));
    console.log('  ' + ' '.repeat(16) + kleur.dim(c.note));
    console.log('  ' + ' '.repeat(16) + kleur.dim('→ ' + c.configPath()));
    console.log('');
  }
}

async function printVersion() {
  // fs read (not import-attributes) to keep Node 18 compat.
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf-8'));
  console.log(pkg.version);
}

function printHelp() {
  console.log(`
${kleur.bold('hivemind')} — wire HIVEMIND MCP into your AI tools

${kleur.bold('Usage:')}
  npx @hivemind/cli setup              ${kleur.dim('# interactive picker — opens browser to sign in')}
  npx @hivemind/cli setup claude-code  ${kleur.dim('# install for a specific client')}
  npx @hivemind/cli login              ${kleur.dim('# just open browser, print key (gh-style)')}
  npx @hivemind/cli verify             ${kleur.dim('# check endpoint + API key')}
  npx @hivemind/cli list               ${kleur.dim('# show every supported client')}

${kleur.bold('Flags:')}
  --api-key <key>           ${kleur.dim('skip browser, use this key (or $HIVEMIND_API_KEY)')}
  --no-browser              ${kleur.dim('disable browser login, force paste-key prompt')}
  --control-plane <url>     ${kleur.dim('override hivemind.davinciai.eu host (self-hosted)')}
  --endpoint <url>          ${kleur.dim('override MCP URL (self-hosted core)')}
  --json                    ${kleur.dim('emit JSON result on stdout for scripts')}

${kleur.bold('Clients:')}
  claude-code         ${kleur.dim('Anthropic CLI (claude mcp add)')}
  claude-desktop      ${kleur.dim('Claude Desktop app')}
  cursor              ${kleur.dim('Cursor IDE')}
  vscode              ${kleur.dim('VS Code (User settings.json)')}
  codex               ${kleur.dim('OpenAI Codex CLI')}
  antigravity         ${kleur.dim('Google Antigravity')}

${kleur.bold('Docs:')}  https://github.com/amar3012005/HIVEMIND/tree/main/packages/cli
`);
}
