import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import apiClient from '../shared/api-client';

const AuthContext = createContext(undefined);

/**
 * Four auth states — not one generic "unavailable":
 *
 *   loading                   → checking session / bootstrap in flight
 *   signed_out                → 401 from bootstrap — control plane is reachable, user not authenticated
 *   signed_in                 → 200 from bootstrap — render dashboard from bootstrap payload
 *   control_plane_unreachable → network failure or timeout — the only state that says "unavailable"
 */
export function AuthProvider({ children }) {
  const [authState, setAuthState] = useState('loading');
  const [user, setUser] = useState(null);
  const [org, setOrg] = useState(null);
  const [onboarding, setOnboarding] = useState(null);
  const [connectivity, setConnectivity] = useState(null);
  const [clientSupport, setClientSupport] = useState([]);
  const bootstrapAttempted = useRef(false);
  const location = useLocation();

  const runBootstrap = useCallback(async () => {
    setAuthState('loading');

    try {
      const data = await apiClient.bootstrap();

      // 200 — signed in
      setUser(data.user || null);
      setOrg(data.organization || null);
      setOnboarding(data.onboarding || null);
      setConnectivity(data.connectivity || null);
      setClientSupport(data.client_support || []);
      setAuthState('signed_in');
    } catch (err) {
      if (err.response?.status === 401) {
        // 401 — control plane is reachable, user is not authenticated
        setUser(null);
        setOrg(null);
        setOnboarding(null);
        setConnectivity(null);
        setAuthState('signed_out');
      } else {
        // Network failure, timeout, 503, or any other error
        setUser(null);
        setOrg(null);
        setOnboarding(null);
        setConnectivity(null);
        setAuthState('control_plane_unreachable');
      }
    } finally {
      bootstrapAttempted.current = true;
    }
  }, []);

  useEffect(() => {
    runBootstrap();
  }, [runBootstrap]);

  // Re-bootstrap when returning from ZITADEL callback
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get('auth') === 'callback' && bootstrapAttempted.current) {
      runBootstrap();
    }
  }, [location.search, runBootstrap]);

  const login = useCallback((options = {}) => {
    const returnTo = `${window.location.origin}/hivemind/app/overview?auth=callback`;
    if (options.provider === 'google') {
      // Direct Google OAuth — bypasses Zitadel
      window.location.href = apiClient.getGoogleLoginUrl(returnTo);
    } else {
      // Zitadel Enterprise SSO
      window.location.href = apiClient.getLoginUrl(returnTo);
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiClient.logout();
    } catch {
      // Clear local state regardless
    }
    setUser(null);
    setOrg(null);
    setOnboarding(null);
    setAuthState('signed_out');
    window.location.href = '/hivemind';
  }, []);

  const createOrg = useCallback(async (name) => {
    const data = await apiClient.createOrg(name);
    setOrg(data.organization || null);
    setOnboarding(prev => prev ? { ...prev, needs_org_setup: false } : null);
    return data;
  }, []);

  const value = {
    // Four states
    authState,
    loading: authState === 'loading',
    isAuthenticated: authState === 'signed_in',
    isSignedOut: authState === 'signed_out',
    isUnreachable: authState === 'control_plane_unreachable',

    // Bootstrap payload
    user,
    org,
    onboarding,
    connectivity,
    clientSupport,

    // Derived flags
    needsOnboarding: onboarding?.needs_org_setup === true,
    hasApiKey: onboarding?.has_api_key === true,

    // Actions
    login,
    logout,
    createOrg,
    refresh: runBootstrap,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
