const PROD = process.env.NODE_ENV === 'production';

function firstEnv(keys = []) {
  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

export function requireSecret(name, aliases = [], options = {}) {
  const {
    allowDevFallback = false,
    devFallback = '',
    rejectValues = [],
  } = options;
  const value = firstEnv([name, ...aliases]);
  if (value && !rejectValues.includes(value)) return value;
  if (!PROD && allowDevFallback && devFallback) return devFallback;
  const details = [name, ...aliases].join(' or ');
  throw new Error(`${details} must be configured${PROD ? ' in production' : ''}`);
}

export function getInternalApiKey(options = {}) {
  return requireSecret('HIVEMIND_MASTER_API_KEY', ['API_MASTER_KEY'], {
    allowDevFallback: options.allowDevFallback ?? true,
    devFallback: 'hm_master_key_99228811',
    rejectValues: ['hm_master_key_99228811'],
  });
}

export function requireAdminSecret() {
  return requireSecret('HIVEMIND_ADMIN_SECRET', [], {
    allowDevFallback: true,
    devFallback: 'local-admin-secret-change-me',
    rejectValues: ['local-admin-secret-change-me'],
  });
}

export function requireSessionSecret(name, aliases = []) {
  return requireSecret(name, aliases, {
    allowDevFallback: true,
    devFallback: 'change-me',
    rejectValues: ['change-me'],
  });
}

export function hasInternalApiKey(candidate, options = {}) {
  if (!candidate) return false;
  return candidate === getInternalApiKey(options);
}
