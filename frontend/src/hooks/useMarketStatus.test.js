import React from 'react';
import { render, screen } from '@testing-library/react';
import axios from 'axios';
import { useMarketStatus } from './useMarketStatus';
jest.mock('../utils/cache', () => ({ getCache: () => null, setCache: jest.fn() }));
jest.mock('../utils/toast', () => ({ emitToast: jest.fn() }));
function Display() { const { status, source } = useMarketStatus(); return <p>{status} {source}</p>; }
test('failed market lookup reports unavailable instead of claiming market closed', async () => {
  axios.get.mockRejectedValue(new Error('outage'));
  render(<Display />);
  expect(await screen.findByText(/UNAVAILABLE/)).toBeInTheDocument();
  expect(screen.queryByText(/CLOSED/)).not.toBeInTheDocument();
});
test('provider clock status and source reach consumers', async () => {
  axios.get.mockResolvedValue({ data: { status: 'OPEN', source: 'alpaca-clock', nextClose: '2026-09-14T20:00:00Z' } });
  render(<Display />);
  expect(await screen.findByText('OPEN alpaca-clock')).toBeInTheDocument();
});
