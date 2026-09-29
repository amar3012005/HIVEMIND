export function workflowErrorCode(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  if (/workrun_stopped/.test(message)) return "workrun_stopped";
  if (/toolchoiceviolation|required tool|invalid structured output/i.test(message)) return "model_output_invalid";
  if (/^ZodError:|recovery_report_json_missing|recovery_report_json_invalid/i.test(message)) return "model_output_invalid";
  if (/context length|too many tokens|maximum context|input.*tokens/i.test(message)) return "model_context_limit";
  if (/timeout|timed out|aborterror|deadline exceeded/i.test(message)) return "upstream_timeout";
  if (/rate.limit|\b429\b/i.test(message)) return "rate_limited";
  if (/invalid.*(?:json|schema)|structured.output|parse.error/i.test(message)) return "model_output_invalid";
  return "workflow_failed";
}
