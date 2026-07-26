const OPENROUTER_IMAGE_URL = 'https://openrouter.ai/api/v1/images';
export const DEFAULT_CAMPAIGN_IMAGE_MODEL = 'openai/gpt-image-1';

export class CampaignImageProviderError extends Error {
  constructor(message, { status = 502, code = 'campaign_image_provider_error', details = null } = {}) {
    super(message);
    this.name = 'CampaignImageProviderError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function generateCampaignImage({ prompt, aspectRatio = '16:9', model = DEFAULT_CAMPAIGN_IMAGE_MODEL, signal } = {}) {
  const apiKey = String(process.env.OPENROUTER_API_KEY || '').trim();
  if (!apiKey) throw new CampaignImageProviderError('Image generation is not configured', { status: 503, code: 'campaign_image_provider_unavailable' });
  const response = await fetch(OPENROUTER_IMAGE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://singulancelabs.com',
      'X-Title': 'Singulance Campaign OS',
    },
    body: JSON.stringify({ model, prompt, n: 1, aspect_ratio: aspectRatio, quality: 'high', output_format: 'png' }),
    signal: signal || AbortSignal.timeout(180_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || data?.message || `Image provider returned ${response.status}`;
    throw new CampaignImageProviderError(String(message).slice(0, 1000), { status: response.status === 429 ? 429 : 502, code: response.status === 429 ? 'campaign_image_rate_limited' : 'campaign_image_generation_failed' });
  }
  const image = Array.isArray(data?.data) ? data.data[0] : null;
  if (!image?.b64_json) throw new CampaignImageProviderError('Image provider returned no image', { code: 'campaign_image_empty_response' });
  const contentType = String(image.media_type || 'image/png').toLowerCase();
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(contentType)) {
    throw new CampaignImageProviderError(`Unsupported generated image type: ${contentType}`, { code: 'campaign_image_type_unsupported' });
  }
  return {
    bytes: Buffer.from(image.b64_json, 'base64'),
    contentType,
    provider: 'openrouter',
    model,
    usage: data.usage && typeof data.usage === 'object' ? data.usage : {},
  };
}
