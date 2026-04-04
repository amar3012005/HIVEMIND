import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './AuthProvider';

export default function ProtectedRoute({ children }) {
  const { isAuthenticated, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-8 h-8 border-2 border-[#bdf213] border-t-transparent rounded-full animate-spin" />
          <span className="text-white/50 text-sm font-['Space_Grotesk']">Loading HIVEMIND...</span>
        </div>
      </div>
    );
  }

  // signed_out or control_plane_unreachable → send to login
  if (!isAuthenticated) {
    return <Navigate to="/hivemind/login" state={{ from: location }} replace />;
  }

  return children;
}
