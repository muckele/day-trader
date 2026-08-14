import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { clearCache } from '../utils/cache';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [status, setStatus] = useState('checking');
  const identityRef = useRef(null);

  const refreshAuth = useCallback(async () => {
    setStatus('checking');
    try {
      const res = await axios.get('/api/me');
      const currentUser = res.data.user || null;
      const nextIdentity = currentUser?.id || null;
      if (identityRef.current && identityRef.current !== nextIdentity) clearCache();
      identityRef.current = nextIdentity;
      setUser(currentUser);
      setStatus(currentUser ? 'authenticated' : 'anonymous');
      return currentUser;
    } catch (err) {
      setUser(null);
      setStatus('anonymous');
      return null;
    }
  }, []);

  const signOut = useCallback(async () => {
    await axios.post('/api/logout');
    clearCache();
    identityRef.current = null;
    localStorage.removeItem('token');
    setUser(null);
    setStatus('anonymous');
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
