import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import axios from 'axios';
import Portfolio from './Portfolio';
import Activity from './Activity';
jest.mock('../utils/cache', () => ({ getCache: () => null, setCache: jest.fn() }));
jest.mock('recharts', () => {
  const Wrapper = ({ children }) => <div>{children}</div>;
  return { ResponsiveContainer: Wrapper, LineChart: Wrapper, Line: () => null, XAxis: () => null, YAxis: () => null, Tooltip: () => null };
});
test('Portfolio renders broker positions with unavailable P&L percentage', async () => {
  axios.get.mockImplementation(url => Promise.resolve({ data: url.endsWith('/account') ? { executionSource: 'alpaca-paper', equity: 1010, cash: 900, totalPnl: null, dailyPnl: 10, positions: [{ symbol: 'AAPL', qty: 1, avgCost: 100, marketPrice: 110, unrealizedPnl: 10 }] } : [] }));
  render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><Portfolio /></MemoryRouter>);
  expect(await screen.findByText('AAPL')).toBeInTheDocument();
  expect(screen.getByText('Alpaca Paper')).toBeInTheDocument();
  expect(screen.getByText(/percentage unavailable/i)).toBeInTheDocument();
});
test('Activity distinguishes requested quantity, confirmed fills, source and unavailable realized P&L', async () => {
  axios.get.mockImplementation(url => Promise.resolve({ data: url.endsWith('/orders')
    ? [{ _id: 'intent', executionSource: 'alpaca-paper', symbol: 'AAPL', side: 'buy', qty: 10, filledQty: 4, fillPrice: 99, status: 'partially_filled' }]
    : [{ _id: 'fill', executionSource: 'alpaca-paper', symbol: 'AAPL', side: 'buy', qty: 4, price: 99, realizedPnl: null }] }));
  render(<Activity />);
  expect(await screen.findByText(/Filled 4 of 10 requested shares/)).toBeInTheDocument();
  expect(screen.getByText('Realized P/L unavailable')).toBeInTheDocument();
  expect(screen.getAllByText(/Alpaca paper/).length).toBeGreaterThan(0);
});
