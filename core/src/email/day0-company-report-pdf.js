const DEFAULT_ENDPOINT = 'http://hm-playwright:8932/v1/pdf';
const DEFAULT_TIMEOUT_MS = 45_000;

/** Render the exact Day-0 HTML document through the internal Playwright service. */
export async function renderDayZeroOnboardingPdf(html, { fetchImpl = globalThis.fetch } = {}) {
  if (typeof html !== 'string' || !html.trim()) throw new Error('day0_report_html_required');
  const token = process.env.PLAYWRIGHT_SERVICE_TOKEN || '';
  if (!token) throw new Error('playwright_service_token_missing');
  const endpoint = process.env.HIVEMIND_PLAYWRIGHT_PDF_URL || DEFAULT_ENDPOINT;
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ html }),
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
