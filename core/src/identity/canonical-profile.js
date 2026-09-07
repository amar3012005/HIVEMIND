const GENERIC_DISPLAY_NAMES = [
  /^guest(?:\s+mode)?$/i,
  /^user$/i,
  /^local\s+user(?:\s+[0-9a-f-]+)?$/i,
];

export function cleanIdentityName(value, maxLength = 255) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

export function isGenericDisplayName(value) {
  const name = cleanIdentityName(value);
  return !name || GENERIC_DISPLAY_NAMES.some((pattern) => pattern.test(name));
}

// Identity-provider claims are discovery hints. Once a user has a meaningful
// persisted display name, subsequent Google/Microsoft logins must not replace it.
export function providerDisplayNameForExisting(savedName, providerName) {
  return isGenericDisplayName(savedName)
    ? (cleanIdentityName(providerName) || cleanIdentityName(savedName) || null)
    : cleanIdentityName(savedName);
}

export function canonicalProfileFacts({ facts = [], userName, brainName } = {}) {
  const inputFacts = Array.isArray(facts) ? facts : [];
  const retained = inputFacts.filter((fact) => (
    fact?.key !== 'name' && fact?.key !== 'brain_name' && fact?.key !== 'hivemind_name'
  ));
  const canonical = [];
  const storedUserName = inputFacts.find((fact) => fact?.key === 'name' && !isGenericDisplayName(fact?.value))?.value;
  const cleanUserName = !isGenericDisplayName(userName)
    ? cleanIdentityName(userName)
    : cleanIdentityName(storedUserName);
  const cleanBrainName = cleanIdentityName(brainName);
  if (cleanUserName && !isGenericDisplayName(cleanUserName)) {
    canonical.push({ category: 'static', key: 'name', value: cleanUserName, confidence: 1, source: 'account' });
  }
  if (cleanBrainName) {
    canonical.push({ category: 'static', key: 'brain_name', value: cleanBrainName, confidence: 1, source: 'workspace' });
  }
  return [...canonical, ...retained];
}
