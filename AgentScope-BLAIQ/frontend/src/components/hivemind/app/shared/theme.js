/**
 * BLAIQ AgentScope Design Tokens
 * Clean Manus-inspired light UI
 */

export const colors = {
  bg: {
    primary: '#fafaf8',
    secondary: '#f5f5f3',
    elevated: '#ffffff',
  },
  accent: {
    primary: '#2563eb',
    primaryHover: '#1d4ed8',
  },
  text: {
    primary: '#111827',
    secondary: '#6b7280',
    muted: '#9ca3af',
  },
  border: {
    subtle: '#f3f4f6',
    default: '#e5e7eb',
  },
};

// Not used for AgentScope — the frontend talks directly to /api/v1/*
export const API_DEFAULTS = {
  controlPlaneBase: '',
  coreApiBase: '',
};
