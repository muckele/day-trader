import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import axios from 'axios';
import Register from './Register';
import Login from './Login';
import RoboTrader from './RoboTrader';
import Navbar from '../components/Navbar';
import { AuthProvider } from '../context/AuthContext';

jest.mock('axios');
beforeEach(() => {
  jest.clearAllMocks();
  axios.get.mockImplementation(async url => ({ data: url === '/api/me' ? { user: null } : {} }));
  axios.put.mockResolvedValue({ data: {} });
});

test('registration route explains operator access and offers no signup form', () => {
  render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><Register /></MemoryRouter>);
  expect(screen.getByText(/public registration is disabled/i)).toBeInTheDocument();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /create account/i })).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: /log in/i })).toHaveAttribute('href', '/login');
});

test('login and navigation do not offer signup', async () => {
  render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><AuthProvider><Navbar /><Login /></AuthProvider></MemoryRouter>);
  await waitFor(() => expect(screen.getByText(/access is configured by the operator/i)).toBeInTheDocument());
  expect(screen.queryByRole('link', { name: /sign up/i })).not.toBeInTheDocument();
});

test('RoboTrader cannot enable unsupported controls and saves paper-only scope despite legacy settings', async () => {
  axios.get.mockImplementation(async url => ({ data: url === '/api/robotrader/settings' ? {
    settings: { mode: 'live', liveTradingExplicitlyEnabled: true, allowedAssetClasses: ['stocks', 'crypto', 'options'], allowFractionalShares: true, allowShortSelling: true, allowExtendedHours: true, allowOptionsTrading: true, allowCryptoTrading: true }
  } : {} }));
  render(<RoboTrader />);
  const live = await screen.findByRole('button', { name: /^live/i });
  expect(live).toBeDisabled();
  fireEvent.click(live);
  expect(screen.queryByPlaceholderText(/I understand live trading risk/i)).not.toBeInTheDocument();
  for (const name of ['Crypto', 'Options', 'Fractional Shares', 'Extended Hours', 'Crypto Trading', 'Options Trading', 'Short Selling']) {
    const control = screen.getByRole('checkbox', { name, exact: true });
    expect(control).toBeDisabled();
    expect(control).not.toBeChecked();
  }
  expect(screen.getByText(/saved settings include features outside/i)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /save settings/i }));
  await waitFor(() => expect(axios.put).toHaveBeenCalledWith('/api/robotrader/settings', expect.objectContaining({ mode: 'paper', liveTradingExplicitlyEnabled: false, allowedAssetClasses: ['stocks'], allowFractionalShares: false, allowExtendedHours: false, allowShortSelling: false, allowCryptoTrading: false, allowOptionsTrading: false })));
});

test('missing Robo health and performance data show unavailable instead of healthy or zero', async () => {
  render(<RoboTrader />);
  await screen.findByRole('heading', { name: 'RoboTrader', exact: true });
  expect(screen.queryByText('Ready')).not.toBeInTheDocument();
  expect(screen.getByText('Reconciliation status unavailable.')).toBeInTheDocument();
  const summary = within(screen.getByRole('heading', { name: 'RoboTrader summary' }).closest('.rh-card'));
  for (const label of ['Decisions', 'Submitted', 'Filled', 'Rejected']) {
    expect(summary.getByText(label).closest('.rt-metric')).toHaveTextContent('Unavailable');
  }
  for (const label of ['Current Tracked', 'Current Issues', 'Pending Broker']) {
    expect(screen.getByText(label).closest('.rt-metric')).toHaveTextContent('Unavailable');
  }
  expect(screen.getByText('Positions unavailable.')).toBeInTheDocument();
  expect(screen.queryByText('No current actionable reconciliation issues are visible.')).not.toBeInTheDocument();
});

test('confirmed zero counts remain zero and successful reconciliation is reported only with evidence', async () => {
  axios.get.mockImplementation(async url => ({ data: url === '/api/robotrader/health' ? {
    reconciliation: { lastReconciledAt: '2026-09-12T20:00:00Z', latestDiscrepancy: null }
  } : url === '/api/robotrader/performance' ? {
    summary: { decisions: 0, submittedOrders: 0, filledOrders: 0, rejectedDecisions: 0 }, positions: []
  } : {} }));
  render(<RoboTrader />);
  await screen.findByRole('heading', { name: 'RoboTrader', exact: true });
  expect(screen.getByText('Ready')).toBeInTheDocument();
  expect(screen.getByText('Submitted').closest('.rt-metric')).toHaveTextContent('0');
  expect(screen.getByText('No positions returned.')).toBeInTheDocument();
});

test('failed refresh clears earlier successful health and performance results', async () => {
  let failed = false;
  axios.get.mockImplementation(async url => {
    if (url.endsWith('/health') || url.endsWith('/performance')) {
      if (failed) throw new Error('API unavailable');
      return { data: url.endsWith('/health') ? { reconciliation: { lastReconciledAt: '2026-09-12T20:00:00Z' } } : { summary: { submittedOrders: 7 }, positions: [] } };
    }
    return { data: {} };
  });
  render(<RoboTrader />);
  await screen.findByText('Ready');
  failed = true;
  fireEvent.click(screen.getByRole('button', { name: /save settings/i }));
  await screen.findByText(/Could not load performance, system health/);
  expect(screen.queryByText('Ready')).not.toBeInTheDocument();
  expect(screen.getByText('Submitted').closest('.rt-metric')).toHaveTextContent('Unavailable');
});
