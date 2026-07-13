import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import axios from 'axios';
import Stock from './Stock';
import { emitToast } from '../utils/toast';
import { vi } from 'vitest';

vi.mock('../hooks/useMarketStatus', () => ({
  useMarketStatus: () => ({
    status: 'OPEN',
    nextOpen: null,
    nextClose: null,
    countdown: ''
  })
}));

vi.mock('../utils/cache', () => ({
  getCache: vi.fn(() => null),
  setCache: vi.fn()
}));

vi.mock('../utils/toast', () => ({
  emitToast: vi.fn()
}));

vi.mock('recharts', () => {
  const Wrapper = ({ children }) => <div>{children}</div>;
  return {
    ResponsiveContainer: Wrapper,
    LineChart: Wrapper,
    Line: () => <div />,
    XAxis: () => <div />,
    YAxis: () => <div />,
    Tooltip: () => <div />
  };
});

function buildIntradayBars() {
  return [
    { time: '2026-02-26T14:30:00.000Z', open: 271, high: 272, low: 270.8, close: 271.8, volume: 1000 },
    { time: '2026-02-26T14:35:00.000Z', open: 271.8, high: 272.2, low: 271.5, close: 272.1, volume: 900 },
    { time: '2026-02-26T14:40:00.000Z', open: 272.1, high: 272.4, low: 271.9, close: 272.3, volume: 1100 }
  ];
}

function buildHistoricalBars() {
  return [
    { date: '2026-02-24', close: 269.9 },
    { date: '2026-02-25', close: 271.7 },
    { date: '2026-02-26', close: 272.3 }
  ];
}

function mockStockApi({
  analyzePayload,
  recommendationBySymbolPayload
}) {
  axios.get.mockImplementation(url => {
    if (url === '/api/market/intraday/AAPL') {
      return Promise.resolve({ data: buildIntradayBars() });
    }
    if (url === '/api/market/historical/AAPL') {
      return Promise.resolve({ data: buildHistoricalBars() });
    }
    if (url === '/api/company/AAPL') {
      return Promise.resolve({
        data: {
          company: { symbol: 'AAPL', name: 'Apple Inc.' },
          stats: {
            marketcap: 3_000_000_000_000,
            peRatio: 30.2,
            dividendYield: 0.5,
            employees: 161000
          }
        }
      });
    }
    if (url === '/api/recommendations/AAPL') {
      return Promise.resolve({ data: recommendationBySymbolPayload });
    }
    if (url === '/api/paper-trades/settings') {
      return Promise.resolve({ data: { slippageBps: 10, commission: 0 } });
    }
    if (url === '/api/paper-trades/account') {
      return Promise.resolve({
        data: {
          equity: 100000,
          cash: 100000,
          positionsValue: 0,
          positions: [],
          totalPnl: 0,
          dailyPnl: 0
        }
      });
    }
    if (url === '/api/analyze/AAPL') {
      return Promise.resolve({ data: analyzePayload });
    }
    return Promise.reject(new Error(`Unhandled GET ${url}`));
  });
}

function renderStockPage() {
  return render(
    <MemoryRouter
      initialEntries={['/stock/AAPL']}
      future={{
        v7_startTransition: true,
        v7_relativeSplatPath: true
      }}
    >
      <Routes>
        <Route path="/stock/:symbol" element={<Stock />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('Stock page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('renders company/chart/stats and analysis on happy path', async () => {
    mockStockApi({
      analyzePayload: {
        ok: true,
        analysis: {
          setup: { setupType: 'TREND_PULLBACK', bias: 'LONG', confidenceScore: 78 },
          levels: { entry: 272.3, stop: 268.5, target: 277.2 },
          qualityGate: { passed: true, reasons: [] }
        }
      },
      recommendationBySymbolPayload: {
        asOf: '2026-02-26T20:00:00.000Z',
        marketStatus: 'OPEN',
        recommendations: [
          {
            ticker: 'AAPL',
            bias: 'LONG',
            entry: { price: 271.8 },
            risk: { stop: 268.5, takeProfit: [277.2], timeHorizon: '2-5d', positionSizePct: 3 },
            rationale: ['Momentum expansion with healthy breadth'],
            qualityGate: { passed: true, blockedReasons: [], liquidityScore: 82, volatilityScore: 71 },
            regime: { trendChop: 'TREND', vol: 'NORMAL', risk: 'RISK_ON' },
            disclaimer: 'Educational purposes only.'
          }
        ]
      }
    });

    renderStockPage();

    expect(await screen.findByRole('heading', { name: /apple inc\./i })).toBeInTheDocument();
    expect(screen.getByText('Market Cap')).toBeInTheDocument();
    expect(screen.getByLabelText('SMA 20')).toBeInTheDocument();
    expect(screen.getByText(/TREND_PULLBACK/i)).toBeInTheDocument();
    expect(screen.getByText(/Entry: \$271.8/i)).toBeInTheDocument();
    expect(emitToast).not.toHaveBeenCalled();
  });

  test('keeps stock page loaded when analyze fails and recommendations are unavailable', async () => {
    mockStockApi({
      analyzePayload: {
        ok: false,
        error: 'AI_UNAVAILABLE',
        message: 'AI temporarily unavailable',
        analysis: null
      },
      recommendationBySymbolPayload: {
        asOf: '2026-02-26T20:00:00.000Z',
        marketStatus: 'OPEN',
        recommendations: [],
        warning: 'DATA_UNAVAILABLE',
        message: 'Could not fetch daily bars'
      }
    });

    renderStockPage();

    expect(await screen.findByRole('heading', { name: /apple inc\./i })).toBeInTheDocument();
    expect(screen.getByText('Market Cap')).toBeInTheDocument();
    expect(screen.getByText('AI temporarily unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.getByText('No trade idea available.')).toBeInTheDocument();
    expect(screen.queryByText('Could not fetch daily bars')).not.toBeInTheDocument();

    await waitFor(() => {
      expect(emitToast).not.toHaveBeenCalled();
    });
  });
});
