const DEFAULT_ENDPOINT = 'http://hm-playwright:8932/v1/pdf';
const DEFAULT_TIMEOUT_MS = 45_000;

// Chromium clips complex inline SVG/flex header templates after page one.
// Keep the native repeating header deliberately text-only; the SINGULANCE
// wordmark is the stable branding primitive on every printed page.
export const DAY0_HEADER_TEMPLATE = `<div style="box-sizing:border-box;width:100%;margin:0 15mm;padding:5mm 0 2mm;border-bottom:1px solid #e3e0db;font-family:Arial,sans-serif;font-size:12px"><b style="font-size:14px;letter-spacing:-.35px">SINGULANCE</b><span style="float:right;color:#117dff;font:700 7px/10px ui-monospace,monospace;letter-spacing:1.5px">DAY-0 / AWAKENING</span><div style="margin-top:1px;font:700 5px/7px ui-monospace,monospace;letter-spacing:1.15px;color:#999">HIVEMIND · OPERATING SYSTEM</div></div>`;
export const DAY0_FOOTER_TEMPLATE = `<div style="box-sizing:border-box;width:100%;margin:0 15mm;padding:2.5mm 0 6mm;border-top:1px solid #e3e0db;display:flex;justify-content:space-between;font:700 6px/9px ui-monospace,monospace;letter-spacing:1.1px;color:#999"><span>SINGULANCE · HIVEMIND OPERATING SYSTEM</span><span>DAY 0 · COMPANY AWAKENING · <span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`;

/** Render the exact Day-0 HTML document through the internal Playwright service. */
export async function renderDayZeroOnboardingPdf(html, { fetchImpl = globalThis.fetch } = {}) {
  if (typeof html !== 'string' || !html.trim()) throw new Error('day0_report_html_required');
  const token = process.env.PLAYWRIGHT_SERVICE_TOKEN || '';
  if (!token) throw new Error('playwright_service_token_missing');
  const endpoint = process.env.HIVEMIND_PLAYWRIGHT_PDF_URL || DEFAULT_ENDPOINT;
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      html,
      display_header_footer: true,
      prefer_css_page_size: false,
      header_template: DAY0_HEADER_TEMPLATE,
      footer_template: DAY0_FOOTER_TEMPLATE,
      margin: { top: '24mm', right: '0mm', bottom: '18mm', left: '0mm' },
    }),
    signal: AbortSignal.timeout(Math.max(5_000, Number(process.env.HIVEMIND_PLAYWRIGHT_PDF_TIMEOUT_MS || DEFAULT_TIMEOUT_MS))),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 240);
    throw new Error(`day0_report_pdf_failed_${response.status}${detail ? `:${detail}` : ''}`);
  }
  const pdf = Buffer.from(await response.arrayBuffer());
  if (!pdf.length || pdf.length > 4 * 1024 * 1024) throw new Error('day0_report_pdf_invalid_size');
  return pdf;
}
