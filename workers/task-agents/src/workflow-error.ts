export function workflowErrorCode(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  if (/context length|too many tokens|maximum context|input.*tokens/i.test(message)) return "model_context_limit";
  if (/timeout|timed out|aborterror|deadline exceeded/i.test(message)) return "upstream_timeout";
  if (/rate.limit|\b429\b/i.test(message)) return "rate_limited";
  if (/invalid.*(?:json|schema)|structured.output|parse.error/i.test(message)) return "model_output_invalid";
  return "workflow_failed";
}
