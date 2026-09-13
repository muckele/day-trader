// src/components/PrivateRoute.js
import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function PrivateRoute({ children }) {
  const { isAuthenticated, status, refreshAuth } = useAuth();

  if (status === 'checking') {
    return <div className="p-6 text-sm text-[#8ba09f]">Checking session...</div>;
  }

  if (status === 'unavailable') {
    return <section role="alert" className="p-6 space-y-3">
      <h1 className="text-lg font-semibold">Session service unavailable</h1>
      <p className="text-sm">Your session could not be checked. Private data stays hidden until the backend responds.</p>
      <button type="button" className="rt-button" onClick={refreshAuth}>Retry session</button>
    </section>;
  }

  return isAuthenticated ? children : <Navigate to="/login" replace />;
}
