import http from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { Sandbox } from '@e2b/desktop'

const leasePath = process.argv[2]
if (!leasePath) throw new Error('Usage: npm run open-stream -- /absolute/path/to/lease.json')
if (!process.env.E2B_API_KEY) throw new Error('E2B_API_KEY is required in this process environment; never commit or log it.')

const lease = JSON.parse(await readFile(leasePath, 'utf8'))
const desktop = await Sandbox.connect(lease.sandboxId)
// Auth keys are intentionally scoped to the controller that created the stream.
// Rotate the one-time stream session instead of recovering or persisting an old key.
await desktop.stream.stop().catch(() => {})
await desktop.stream.start({ requireAuth: true })
const authKey = await desktop.stream.getAuthKey()
const streamUrl = desktop.stream.getUrl({ authKey, autoConnect: true })
const port = Number(process.env.E2B_STREAM_PROXY_PORT ?? 48131)

const server = http.createServer((request, response) => {
  if (request.url !== '/' || request.method !== 'GET') {
    response.writeHead(404).end()
    return
  }
  response.writeHead(302, { location: streamUrl, 'cache-control': 'no-store' }).end()
  // Drop the only in-memory copy of the redirect after the browser consumes it.
  server.close()
})

server.listen(port, '127.0.0.1', () => {
  console.log(`Open http://127.0.0.1:${port}/ in the browser you are using. This local one-time redirect expires after one use.`)
})
