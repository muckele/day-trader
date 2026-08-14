import React, { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import axios from 'axios';
import { vi } from 'vitest';
import { AuthProvider, useAuth } from './AuthContext';
import { getCache, setCache } from '../utils/cache';

function Harness() {
  const { status, signOut, user } = useAuth();
  const [error, setError] = useState('');
  return (
    <div>
      <span>{status}</span>
      <span>{user?.username || 'none'}</span>
      <button type="button" onClick={() => signOut().catch(() => setError('failed'))}>Sign out</button>
      <span>{error}</span>
    </div>
  );
}

describe('AuthProvider sign out', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    axios.get.mockResolvedValue({ data: { user: { id: 'user-1', username: 'matt' } } });
  });

  test('keeps the authenticated state when the server cannot clear the session cookie', async () => {
    axios.post.mockRejectedValueOnce(new Error('network unavailable'));
    render(<AuthProvider><Harness /></AuthProvider>);
    expect(await screen.findByText('authenticated')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText('failed')).toBeInTheDocument();
    expect(screen.getByText('authenticated')).toBeInTheDocument();
    expect(screen.getByText('matt')).toBeInTheDocument();
  });

  test('clears private caches only after confirmed sign out', async () => {
    axios.post.mockResolvedValueOnce({ data: { message: 'ok' } });
    setCache('paper-account:user-1', { equity: 10 }, 60000);
    render(<AuthProvider><Harness /></AuthProvider>);
    expect(await screen.findByText('authenticated')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(screen.getByText('anonymous')).toBeInTheDocument());
    expect(getCache('paper-account:user-1')).toBeNull();
  });
});
