import { launch } from '@cloudflare/playwright'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { McpAgent } from 'agents/mcp'
import { z } from 'zod'

interface Env {
  BROWSER: never
  HIVE_HARNESS_BROWSER_TOKEN: string
}

interface BrowserState {
  url?: string
}

function authorized(request: Request, token: string): boolean {
  const value = request.headers.get('authorization')
  return value === `Bearer ${token}` && token.length > 0
}

function imageBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/**
 * Stateful, native MCP access to Cloudflare Browser Run for public pages.
 * Interactive, authenticated, or private work stays on self-hosted Playwright.
 */
export class HivemindBrowserMcp extends McpAgent<Env, BrowserState> {
  initialState: BrowserState = {}
  server = new McpServer({ name: 'hivemind-browser-run', version: '1.0.0' })

  async init(): Promise<void> {
    this.server.tool(
      'browser_navigate',
      'Navigate a new Browser Run page to a public absolute URL.',
      { url: z.string().url() },
      async ({ url }) => {
        const browser = await launch(this.env.BROWSER)
        try {
          const page = await browser.newPage()
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
          const resolvedUrl = page.url()
          const title = await page.title()
          this.setState({ url: resolvedUrl })
          return { content: [{ type: 'text', text: JSON.stringify({ url: resolvedUrl, title }) }] }
        } finally {
          await browser.close()
        }
      },
    )

    this.server.tool(
      'browser_snapshot',
      'Extract the rendered title and readable text from the current Browser Run page.',
      {},
      async () => {
        if (this.state.url === undefined) return { isError: true, content: [{ type: 'text', text: 'Navigate first with browser_navigate.' }] }
        const browser = await launch(this.env.BROWSER)
        try {
          const page = await browser.newPage()
          await page.goto(this.state.url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
          const title = await page.title()
          const text = (await page.locator('body').innerText()).slice(0, 40_000)
          return { content: [{ type: 'text', text: JSON.stringify({ url: page.url(), title, text }) }] }
        } finally {
          await browser.close()
        }
      },
    )

    this.server.tool(
      'browser_take_screenshot',
      'Return a PNG image attachment of the current Browser Run page. The image renders natively in Harness chat.',
      { fullPage: z.boolean().optional() },
      async ({ fullPage }) => {
        if (this.state.url === undefined) return { isError: true, content: [{ type: 'text', text: 'Navigate first with browser_navigate.' }] }
        const browser = await launch(this.env.BROWSER)
        try {
          const page = await browser.newPage()
          await page.goto(this.state.url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
          const screenshot = await page.screenshot({ type: 'png', fullPage: fullPage === true })
          return { content: [{ type: 'image', data: imageBase64(screenshot), mimeType: 'image/png' }] }
        } finally {
          await browser.close()
        }
      },
    )
  }
}

export default {
  fetch(request: Request, environment: Env, ctx: ExecutionContext): Response | Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/health') return Response.json({ ok: true, provider: 'cloudflare-browser-run' })
    if (url.pathname !== '/mcp') return new Response('Not found', { status: 404 })
    if (!authorized(request, environment.HIVE_HARNESS_BROWSER_TOKEN)) return new Response('Unauthorized', { status: 401 })
    return HivemindBrowserMcp.serve('/mcp').fetch(request, environment, ctx)
  },
}
