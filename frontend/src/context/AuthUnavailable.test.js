import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import axios from 'axios';
import { AuthProvider } from './AuthContext';
import PrivateRoute from '../components/PrivateRoute';
test('authentication service outage has a retry state distinct from invalid credentials', async () => {
  axios.get.mockRejectedValue({ response: { status: 503 } });
  render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><AuthProvider><PrivateRoute><h1>Private balance</h1></PrivateRoute></AuthProvider></MemoryRouter>);
  expect(await screen.findByText('Session service unavailable')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Retry session' })).toBeInTheDocument();
  expect(screen.queryByText('Private balance')).not.toBeInTheDocument();
});
