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

interface SourceBlocked {
  outcome: 'source_blocked'
  url: string
  status: number | null
  title: string | null
  reason: string
  next: string
}

type Browser = Awaited<ReturnType<typeof launch>>
type BrowserPage = Awaited<ReturnType<Browser['newPage']>>
type OpenPage =
  | { outcome: 'ready'; page: BrowserPage; resolvedUrl: string; title: string; status: number | null }
  | { outcome: 'source_blocked'; page: BrowserPage; result: { content: Array<{ type: 'text'; text: string }> } }

function authorized(request: Request, token: string): boolean {
  const value = request.headers.get('authorization')
  return value === `Bearer ${token}` && token.length > 0
}

function imageBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function isErrorPage(status: number | null, title: string): boolean {
  // Status is authoritative. The title check covers CDN error documents that
  // arrive with an unexpected success status.
  return (status !== null && status >= 400) || /^error\b/i.test(title.trim())
}

function blockedSource(url: string, status: number | null, title: string | null, reason: string): { content: Array<{ type: 'text'; text: string }> } {
  const result: SourceBlocked = {
    outcome: 'source_blocked',
    url,
    status,
    title,
    reason,
    next: 'Do not retry this URL or guess a replacement. Use one focused research lookup to select a different authoritative absolute URL, then rediscover browser tools and navigate to that URL.',
  }
  return { content: [{ type: 'text', text: JSON.stringify(result) }] }
}

async function openPublicPage(browser: Browser, url: string): Promise<OpenPage> {
  const page = await browser.newPage()
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    const resolvedUrl = page.url()
    const title = await page.title()
    const status = response?.status() ?? null
    if (isErrorPage(status, title)) {
      return { outcome: 'source_blocked', page, result: blockedSource(resolvedUrl, status, title, 'The source returned an error page.') }
    }
    return { outcome: 'ready', page, resolvedUrl, title, status }
  } catch (error) {
    return {
      page,
      outcome: 'source_blocked',
      result: blockedSource(url, null, null, error instanceof Error ? error.message : 'Navigation failed before a page could be loaded.'),
    }
  }
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
          const loaded = await openPublicPage(browser, url)
          if (loaded.outcome === 'source_blocked') {
            this.setState({})
            return loaded.result
          }
          this.setState({ url: loaded.resolvedUrl })
          return { content: [{ type: 'text', text: JSON.stringify({ outcome: 'ready', url: loaded.resolvedUrl, title: loaded.title, status: loaded.status }) }] }
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
        if (this.state.url === undefined) return { isError: true, content: [{ type: 'text', text: 'No capturable Browser Run page is available. Resolve an authoritative absolute URL, rediscover browser tools, then navigate first.' }] }
        const browser = await launch(this.env.BROWSER)
        try {
          const loaded = await openPublicPage(browser, this.state.url)
          if (loaded.outcome === 'source_blocked') {
            this.setState({})
            return loaded.result
          }
          const text = (await loaded.page.locator('body').innerText()).slice(0, 40_000)
          return { content: [{ type: 'text', text: JSON.stringify({ outcome: 'ready', url: loaded.resolvedUrl, title: loaded.title, text }) }] }
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
        if (this.state.url === undefined) return { isError: true, content: [{ type: 'text', text: 'No capturable Browser Run page is available. Resolve an authoritative absolute URL, rediscover browser tools, then navigate first.' }] }
        const browser = await launch(this.env.BROWSER)
        try {
          const loaded = await openPublicPage(browser, this.state.url)
          if (loaded.outcome === 'source_blocked') {
            this.setState({})
            return loaded.result
          }
          const screenshot = await loaded.page.screenshot({ type: 'png', fullPage: fullPage === true })
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
