/** Provider-neutral extraction transport contracts; no credentials or source content. */
export function gatewayGeminiModel(model) {
  return `google-ai-studio/${String(model || '').replace(/^(?:google-ai-studio\/)?(?:google\/)?/, '')}`;
}

export class ChatProviderError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ChatProviderError';
    this.status = status;
    this.retryable = status === 408 || status === 429 || status >= 500;
  }
}

export function retryableChatError(error) {
  if (typeof error?.retryable === 'boolean') return error.retryable;
  const status = Number(error?.status || error?.statusCode);
  if (status >= 400) return status === 408 || status === 429 || status >= 500;
  return !/missing or invalid authorization|invalid api key|unauthorized|forbidden/i.test(String(error?.message || ''));
}
