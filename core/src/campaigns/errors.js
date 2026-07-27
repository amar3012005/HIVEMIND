export function campaignError(message, status = 400, code = 'invalid_campaign', details = null) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  if (details != null) error.details = details;
  return error;
}
