import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import Card from '../components/ui/Card';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import Skeleton from '../components/ui/Skeleton';
import { LineChart, Line, ResponsiveContainer, XAxis, YAxis, Tooltip, Area, AreaChart } from 'recharts';
import { getApiBaseUrl, getApiError } from '../utils/api';
import { emitToast } from '../utils/toast';

const ranges = [
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
  { value: '90d', label: '90d' },
  { value: 'all', label: 'All' }
];

export default function Analytics() {
  const [range, setRange] = useState('30d');
  const [symbol, setSymbol] = useState('');
  const [strategyId, setStrategyId] = useState('');
  const [regime, setRegime] = useState('');
  const [summary, setSummary] = useState(null);
  const [strategies, setStrategies] = useState([]);
  const [regimes, setRegimes] = useState({ trendChop: [], vol: [], risk: [] });
  const [journal, setJournal] = useState([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  const fetchAll = async () => {
    setLoading(true);
    try {
      const params = { range, symbol, strategyId, regime };
      const [summaryRes, strategiesRes, regimesRes, journalRes] = await Promise.all([
          axios.get('/api/analytics/summary', { params }),
          axios.get('/api/analytics/strategies', { params: { range } }),
          axios.get('/api/analytics/regimes', { params: { range } }),
          axios.get('/api/journal', { params: { range, symbol, strategyId } })
        ]);
      setSummary(summaryRes.data);
      setStrategies(strategiesRes.data);
      setRegimes(regimesRes.data.regimes);
      setJournal(journalRes.data || []);
    } catch (err) {
      const message = getApiError(err);
      emitToast({ type: 'error', message });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, symbol, strategyId, regime]);

  const handleExport = () => {
    const params = new URLSearchParams({ range, symbol, strategyId, regime });
    const apiBaseUrl = getApiBaseUrl();
    const base = apiBaseUrl || window.location.origin;
    const url = new URL('/api/analytics/trades.csv', base);
    url.search = params.toString();
    window.open(url.toString(), '_blank');
  };

  const journalFiltered = useMemo(() => {
    if (!search) return journal;
    const term = search.toLowerCase();
    return journal.filter(entry => (
      entry.thesis?.toLowerCase().includes(term)
      || entry.plan?.toLowerCase().includes(term)
      || entry.postTradeNotes?.toLowerCase().includes(term)
      || entry.trade?.symbol?.toLowerCase().includes(term)
    ));
  }, [journal, search]);

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-40" />
        <Card className="p-6">
          <Skeleton className="h-40 w-full" />
        </Card>
      </div>
    );
  }

  if (!summary) return null;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-400">Analytics</p>
          <h1 className="text-3xl font-bold text-slate-900 dark:text-white">Performance Dashboard</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={handleExport}>
            Export CSV
          </Button>
        </div>
      </div>

      <Card className="p-4">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4 text-sm">
          <div>
            <label className="text-xs text-slate-500">Range</label>
            <select
              value={range}
              onChange={event => setRange(event.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-200/80 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2"
            >
              {ranges.map(item => (
                <option key={item.value} value={item.value}>{item.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-slate-500">Symbol</label>
            <input
              value={symbol}
              onChange={event => setSymbol(event.target.value.toUpperCase())}
              className="mt-1 w-full rounded-lg border border-slate-200/80 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2"
              placeholder="AAPL"
            />
          </div>
          <div>
            <label className="text-xs text-slate-500">Strategy</label>
            <input
              value={strategyId}
              onChange={event => setStrategyId(event.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-200/80 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2"
              placeholder="SMA_CROSS"
            />
          </div>
          <div>
            <label className="text-xs text-slate-500">Regime</label>
            <input
              value={regime}
              onChange={event => setRegime(event.target.value.toUpperCase())}
              className="mt-1 w-full rounded-lg border border-slate-200/80 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2"
              placeholder="TREND"
            />
          </div>
          <div className="flex items-end">
            <Button variant="secondary" size="sm" onClick={() => fetchAll()}>
              Refresh
            </Button>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="p-6">
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm font-semibold text-slate-900 dark:text-white">Equity Curve</p>
            <Badge variant="neutral">Trades {summary.tradeCount}</Badge>
          </div>
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={summary.equityCurve}>
                <XAxis dataKey="timestamp" hide />
                <YAxis hide domain={['auto', 'auto']} />
                <Tooltip />
                <Line type="monotone" dataKey="equity" stroke="#111827" dot={false} strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>
        <Card className="p-6">
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm font-semibold text-slate-900 dark:text-white">Drawdown</p>
            <Badge variant="warning">Max {summary.maxDrawdown}%</Badge>
          </div>
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={summary.drawdownSeries}>
                <XAxis dataKey="timestamp" hide />
                <YAxis hide domain={[0, 100]} />
                <Tooltip />
                <Area type="monotone" dataKey="drawdown" stroke="#f97316" fill="#fed7aa" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="p-4">
          <p className="text-xs text-slate-500">Total Return</p>
          <p className="text-lg font-semibold">{summary.totalReturn}%</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-slate-500">Total P/L</p>
          <p className={`text-lg font-semibold ${summary.totalPnl >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
            ${summary.totalPnl}
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-slate-500">Daily P/L</p>
          <p className={`text-lg font-semibold ${summary.dailyPnl >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
            ${summary.dailyPnl}
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-slate-500">Win Rate</p>
          <p className="text-lg font-semibold">{summary.winRate}%</p>
        </Card>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="p-4">
          <p className="text-xs text-slate-500">Expectancy (R)</p>
          <p className="text-lg font-semibold">{summary.expectancy ?? '--'}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-slate-500">Avg Hold (hrs)</p>
          <p className="text-lg font-semibold">{summary.avgHoldHours ?? '--'}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-slate-500">% ≥ 1R</p>
          <p className="text-lg font-semibold">{summary.rStats.above1R}%</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-slate-500">% ≤ -1R</p>
          <p className="text-lg font-semibold">{summary.rStats.belowMinus1R}%</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-slate-500">Profit Factor</p>
          <p className="text-lg font-semibold">{summary.profitFactor ?? '--'}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-slate-500">Max Drawdown</p>
          <p className="text-lg font-semibold">{summary.maxDrawdown}%</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-slate-500">Rolling 7d</p>
          <p className="text-sm font-semibold">{summary.rolling['7d'].winRate}% · ${summary.rolling['7d'].pnl}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-slate-500">Rolling 30d</p>
          <p className="text-sm font-semibold">{summary.rolling['30d'].winRate}% · ${summary.rolling['30d'].pnl}</p>
        </Card>
      </div>

      <Card className="p-6">
        <p className="text-sm font-semibold text-slate-900 dark:text-white mb-4">Exposure</p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm text-slate-600 dark:text-slate-300">
          <div>
            <p className="text-xs text-slate-500">Cash %</p>
            <p>{summary.exposure.cashPct}%</p>
          </div>
          <div>
            <p className="text-xs text-slate-500">Positions %</p>
            <p>{summary.exposure.positionsPct}%</p>
          </div>
          <div>
            <p className="text-xs text-slate-500">Max Position Util</p>
            <p>{summary.exposure.maxPositionUtilization}%</p>
          </div>
          <div>
            <p className="text-xs text-slate-500">Guardrail Blocks</p>
            <p>{summary.exposure.guardrailBlocks}</p>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="p-6">
          <p className="text-sm font-semibold text-slate-900 dark:text-white mb-4">Strategy Attribution</p>
          <div className="space-y-2 text-sm">
            {strategies.strategies?.map(item => (
              <div key={item.strategyId} className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-2">
                <div>
                  <p className="font-semibold">{item.strategyId}</p>
                  <p className="text-xs text-slate-500">{item.trades} trades · {item.winRate}% win</p>
                </div>
                <div className="text-right">
                  <p className={`font-semibold ${item.totalPnl >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                    ${item.totalPnl}
                  </p>
                  <p className="text-xs text-slate-500">Avg R {item.avgR ?? '--'} · DD ${item.maxDrawdown}</p>
                </div>
              </div>
            ))}
          </div>
        </Card>
        <Card className="p-6">
          <p className="text-sm font-semibold text-slate-900 dark:text-white mb-4">Strategy Highlights</p>
          <div className="space-y-4 text-sm">
            <div>
              <p className="text-xs uppercase text-slate-400 mb-2">Top 3 (Expectancy)</p>
              {strategies.top?.map(item => (
                <div key={item.strategyId} className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 py-1">
                  <span>{item.strategyId}</span>
                  <span className="text-xs text-slate-500">Avg R {item.avgR ?? '--'}</span>
                </div>
              ))}
            </div>
            <div>
              <p className="text-xs uppercase text-slate-400 mb-2">Bottom 3 (Expectancy)</p>
              {strategies.bottom?.map(item => (
                <div key={item.strategyId} className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 py-1">
                  <span>{item.strategyId}</span>
                  <span className="text-xs text-slate-500">Avg R {item.avgR ?? '--'}</span>
                </div>
              ))}
            </div>
          </div>
        </Card>
      </div>

      <Card className="p-6">
        <p className="text-sm font-semibold text-slate-900 dark:text-white mb-4">Regime Attribution</p>
        <div className="space-y-4 text-sm">
          {['trendChop', 'vol', 'risk'].map(group => (
            <div key={group}>
              <p className="text-xs uppercase text-slate-400 mb-2">{group}</p>
              {regimes[group]?.map(item => (
                <div key={item.label} className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 py-1">
                  <span>{item.label}</span>
                  <span className="text-xs text-slate-500">
                    {item.trades} trades · {item.winRate}% · ${item.totalPnl}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </Card>

      <Card className="p-6">
        <div className="flex items-center justify-between mb-4">
          <p className="text-sm font-semibold text-slate-900 dark:text-white">Journal</p>
          <input
            value={search}
            onChange={event => setSearch(event.target.value)}
            placeholder="Search entries..."
            className="rounded-lg border border-slate-200/80 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm"
          />
        </div>
        {journalFiltered.length ? (
          <div className="space-y-3">
            {journalFiltered.map(entry => (
              <div key={entry._id} className="border border-slate-100 dark:border-slate-800 rounded-lg p-3 text-sm">
                <div className="flex items-center justify-between">
                  <p className="font-semibold">{entry.trade?.symbol || 'Trade'}</p>
                  <span className="text-xs text-slate-500">
                    {entry.trade?.filledAt ? new Date(entry.trade.filledAt).toLocaleDateString() : '--'}
                  </span>
                </div>
                <p className="text-xs text-slate-500">{entry.thesis}</p>
                {entry.postTradeNotes && (
                  <p className="text-xs text-slate-400 mt-1">{entry.postTradeNotes}</p>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-slate-500">No journal entries yet.</p>
        )}
      </Card>
    </div>
  );
}
