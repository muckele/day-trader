// src/components/PrivateRoute.js
import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function PrivateRoute({ children }) {
  const { isAuthenticated, status } = useAuth();

  if (status === 'checking') {
    return <div className="p-6 text-sm text-[#8ba09f]">Checking session...</div>;
  }

  return isAuthenticated ? children : <Navigate to="/login" replace />;
}
