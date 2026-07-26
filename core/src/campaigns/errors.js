export function campaignError(message, status = 400, code = 'invalid_campaign') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}
