import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { Template, defaultBuildLogger } from 'e2b'

if (!process.env.E2B_API_KEY) throw new Error('E2B_API_KEY is required in this process environment; never commit or log it.')

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const name = process.env.E2B_TEMPLATE_NAME ?? 'hm-computer-operator-canary-v3'

// Preserve E2B's maintained graphical Desktop base. Node and Playwright are
// added to a child template so the visible Xfce/Chrome handoff remains intact.
const template = Template({ fileContextPath: root })
  .fromTemplate('desktop')
  .setUser('root')
  // The Desktop base is Ubuntu Jammy, whose distribution `nodejs` package is
  // Node 12. Playwright 1.55 requires Node 18+, so use NodeSource's Node 22
  // package rather than silently building a non-runnable worker.
  .aptInstall(['ca-certificates', 'curl'])
  .runCmd('curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs')
  .runCmd("node -e \"const major=Number(process.versions.node.split('.')[0]); if (major < 18) process.exit(1)\"")
  .setUser('user')
  .makeDir('/home/user/hm-computer-worker', { user: 'user' })
  .copy('template/worker/package.json', '/home/user/hm-computer-worker/package.json', { user: 'user' })
  .copy('template/worker/canary.mjs', '/home/user/hm-computer-worker/canary.mjs', { user: 'user' })
  .copy('src/operator', '/home/user/hm-computer-worker/operator', { user: 'user' })
  .setWorkdir('/home/user/hm-computer-worker')
  .runCmd('npm install --ignore-scripts --omit=dev --no-audit --no-fund')

const result = await Template.build(template, name, {
  cpuCount: 2,
  memoryMB: 4096,
  minFreeDiskMb: 2048,
  onBuildLogs: defaultBuildLogger({ minLevel: 'info' }),
})

console.log(JSON.stringify({ template_name: result.name, template_id: result.templateId, build_id: result.buildId }))
