import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import axios from 'axios';
import { vi } from 'vitest';
import TradingSystem from './TradingSystem';

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

function responseFor(url) {
  if (url === '/api/trading-system/status') {
    return {
      environment: { defaultExecutionMode: 'paper', paperTradingEnabled: true, liveTradingEnabled: false },
      mongo: { state: 'connected' },
      featureFlags: { liveTradingEnabled: false },
      riskLimits: { maxDailyLossPct: 2 },
      strategyCount: 1,
      strategies: [],
      warnings: []
    };
  }
  if (url === '/api/trading-system/strategy-runs') return { items: [] };
  if (url === '/api/trading-system/strategy-parameters') return { items: [] };
  if (url === '/api/trading-system/execution') {
    return { orders: [], fills: [], summary: { attemptedOrders: 0, filledOrders: 0, rejectedOrders: 0, rejectRate: 0 } };
  }
  if (url === '/api/trading-system/operational-evidence') {
    return {
      lookbackDays: 90,
      completeness: {
        complete: true,
        collections: {
          strategyRuns: { matchedCount: 1, returnedCount: 1, complete: true },
          exposureSnapshots: { matchedCount: 1, returnedCount: 1, complete: true },
          orderIntents: { matchedCount: 1, returnedCount: 1, complete: true },
          roboTradeOrders: { matchedCount: 1, returnedCount: 1, complete: true }
        }
      },
      strategyScorecards: [{
        strategyId: 'ROBO_TREND_FOLLOWING_V1',
        strategyName: 'Trend Following',
        status: 'validated',
        symbols: ['AAPL'],
        parameterVersions: ['3'],
        qualifyingWalkForwardRunCount: 1,
        walkForwardRunCount: 1,
        metricBasis: 'walk_forward',
        latestRunAt: '2026-07-18T12:00:00.000Z',
        metrics: { meanTradeCount: 35, meanAverageR: 0.4, worstMaxDrawdown: 5.5 }
      }],
      paperCoverage: [{
        strategyId: 'ROBO_TREND_FOLLOWING_V1',
        symbol: 'AAPL',
        totalOrders: 12,
        filledOrders: 10,
        comparableFills: 10,
        rejectedOrders: 1,
        targetComparableFills: 20,
        coveragePct: 50
      }],
      exposure: {
        summary: {
          snapshotCount: 1,
          breachCount: 0,
          peakGrossExposurePct: 8,
          peakTotalDrawdownPct: 1.5,
          latest: { equity: 10025, positionCount: 1 }
        },
        series: [{
          capturedAt: '2026-07-18T12:00:00.000Z',
          grossExposurePct: 8,
          netExposurePct: 8,
          totalDrawdownPct: 1.5
        }]
      },
      blotter: {
        summary: { intentCount: 1, policyBlockedCount: 0, staleOpenOrderCount: 0, discrepancyCount: 0 },
        rows: [{
          intentId: 'intent-1',
          requestedAt: '2026-07-18T12:00:00.000Z',
          symbol: 'AAPL',
          side: 'buy',
          qty: 1,
          environment: 'paper',
          intentStatus: 'filled',
          brokerStatus: 'filled',
          authorizationStatus: 'not_required',
          slippageBps: 2,
          fillLatencyMs: 850,
          riskFailures: [],
          reasonCodes: [],
          discrepancy: null,
          stale: false
        }]
      }
    };
  }
  throw new Error(`Unhandled GET ${url}`);
}

describe('Trading System operational evidence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    axios.get.mockImplementation(url => Promise.resolve({ data: responseFor(url) }));
  });

  test('renders strategy, paper coverage, exposure, and control blotter evidence', async () => {
    render(<TradingSystem />);

    expect(await screen.findByRole('heading', { name: 'Trading System' })).toBeInTheDocument();
    expect(screen.getByText('Operational Evidence')).toBeInTheDocument();
    expect(screen.getByText('Strategy Scorecards')).toBeInTheDocument();
    expect(screen.getByText('Trend Following')).toBeInTheDocument();
    expect(screen.getByText('Paper Evidence Coverage')).toBeInTheDocument();
    expect(screen.getByText('10/20')).toBeInTheDocument();
    expect(screen.getByText('Exposure History')).toBeInTheDocument();
    expect(screen.getByText('Control Blotter')).toBeInTheDocument();
    expect(screen.getAllByText('AAPL').length).toBeGreaterThan(0);

    await waitFor(() => {
      expect(axios.get).toHaveBeenCalledWith(
        '/api/trading-system/operational-evidence',
        { params: { days: 90, limit: 200 } }
      );
    });
  });

  test('renders missing evidence as unknown instead of a clean green result', async () => {
    axios.get.mockImplementation(url => {
      const data = responseFor(url);
      if (url === '/api/trading-system/operational-evidence') {
        return Promise.resolve({
          data: {
            ...data,
            strategyScorecards: [],
            paperCoverage: [],
            exposure: {
              summary: {
                snapshotCount: 0,
                breachCount: 0,
                peakGrossExposurePct: null,
                peakTotalDrawdownPct: null,
                latest: null
              },
              series: []
            },
            blotter: { summary: { intentCount: 0, discrepancyCount: 0 }, rows: [] },
            completeness: {
              complete: true,
              collections: {
                strategyRuns: { matchedCount: 0, returnedCount: 0, complete: true },
                exposureSnapshots: { matchedCount: 0, returnedCount: 0, complete: true },
                orderIntents: { matchedCount: 0, returnedCount: 0, complete: true },
                roboTradeOrders: { matchedCount: 0, returnedCount: 0, complete: true }
              }
            }
          }
        });
      }
      return Promise.resolve({ data });
    });

    render(<TradingSystem />);
    expect(await screen.findByText('No Evidence')).toBeInTheDocument();
    expect(screen.queryByText('No Recorded Exceptions')).not.toBeInTheDocument();
    expect(screen.getByText('No Exposure Evidence')).toBeInTheDocument();
  });
});
