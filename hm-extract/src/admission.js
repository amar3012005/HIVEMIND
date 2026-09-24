/** Return whether the estimated request can fit within this parser instance's remaining memory budget. */
export function canAdmitMemoryEstimate({ estimatedBytes, inFlightBytes = 0, maxBytes } = {}) {
  const estimated = Math.max(0, Number(estimatedBytes) || 0);
  const inFlight = Math.max(0, Number(inFlightBytes) || 0);
  const maximum = Math.max(0, Number(maxBytes) || 0);
  return estimated <= maximum - inFlight;
}
