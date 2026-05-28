import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import axios from 'axios';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [status, setStatus] = useState('checking');

  const refreshAuth = useCallback(async () => {
    setStatus('checking');
    try {
      const res = await axios.get('/api/me');
      setUser(res.data.user || null);
      setStatus('authenticated');
      return res.data.user || null;
    } catch (err) {
      setUser(null);
      setStatus('anonymous');
      return null;
    }
  }, []);

  const signOut = useCallback(async () => {
    try {
      await axios.post('/api/logout');
    } finally {
      localStorage.removeItem('token');
      setUser(null);
      setStatus('anonymous');
    }
  }, []);

  useEffect(() => {
    refreshAuth();
  }, [refreshAuth]);

  const value = useMemo(() => ({
    isAuthenticated: status === 'authenticated',
    refreshAuth,
    signOut,
    status,
    user
  }), [refreshAuth, signOut, status, user]);

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
}
