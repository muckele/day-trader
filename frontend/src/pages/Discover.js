import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import Card from '../components/ui/Card';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import Skeleton from '../components/ui/Skeleton';
import { LineChart, Line, ResponsiveContainer, XAxis, YAxis, Tooltip } from 'recharts';
import { getCache, setCache } from '../utils/cache';
import { getApiError } from '../utils/api';
import { emitToast } from '../utils/toast';

export default function Discover() {
  const [regime, setRegime] = useState(null);
  const [strategies, setStrategies] = useState([]);
  const [symbol, setSymbol] = useState('AAPL');
  const [strategyId, setStrategyId] = useState('SMA_CROSS');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(true);
  const [backtestLoading, setBacktestLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      try {
        const cachedRegime = getCache('regime-today');
        const cachedStrategies = getCache('strategies');
        if (cachedRegime) setRegime(cachedRegime);
        if (cachedStrategies) setStrategies(cachedStrategies);

        const [regimeRes, strategiesRes] = await Promise.all([
          axios.get('/api/regime/today'),
          axios.get('/api/backtest/strategies')
        ]);
        setRegime(regimeRes.data);
        setStrategies(strategiesRes.data || []);
        setCache('regime-today', regimeRes.data, 60 * 1000);
        setCache('strategies', strategiesRes.data || [], 5 * 60 * 1000);
        setError('');
      } catch (err) {
        const message = getApiError(err);
        setError(message);
        emitToast({ type: 'error', message });
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, []);

  const activeStrategy = useMemo(() => (
    strategies.find(item => item.strategyId === strategyId)
  ), [strategies, strategyId]);

  const runBacktest = async () => {
    setBacktestLoading(true);
    setResult(null);
    try {
      const res = await axios.post('/api/backtest', {
        symbol,
        strategyId,
        start: start || undefined,
        end: end || undefined,
        timeframe: '1D'
      });
      setResult(res.data);
      emitToast({ type: 'success', message: 'Backtest completed.' });
    } catch (err) {
      const message = getApiError(err);
      emitToast({ type: 'error', message });
    } finally {
      setBacktestLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <Card className="p-6">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-20 w-full mt-4" />
        </Card>
        <Card className="p-6">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-40 w-full mt-4" />
        </Card>
      </div>
    );
  }

  if (error) {
    return (
      <Card className="p-6">
        <p className="text-sm text-red-500">{error}</p>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-400">Discover</p>
          <h1 className="text-3xl font-bold text-slate-900 dark:text-white">Market Regime</h1>
        </div>
        <Badge variant="neutral">Daily</Badge>
      </div>

      <Card className="p-6">
        {regime ? (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <p className="text-xs text-slate-500">Trend/Chop</p>
              <p className="text-lg font-semibold text-slate-900 dark:text-white">{regime.trendChop}</p>
            </div>
            <div>
              <p className="text-xs text-slate-500">Volatility</p>
              <p className="text-lg font-semibold text-slate-900 dark:text-white">{regime.vol}</p>
            </div>
            <div>
              <p className="text-xs text-slate-500">Risk</p>
              <p className="text-lg font-semibold text-slate-900 dark:text-white">{regime.risk}</p>
            </div>
            {regime.notes?.length > 0 && (
              <p className="text-xs text-slate-500 md:col-span-3">{regime.notes[0]}</p>
            )}
          </div>
        ) : (
          <p className="text-sm text-slate-500">No regime snapshot yet.</p>
        )}
      </Card>

      <Card className="p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-400">Backtest Sandbox</p>
            <h2 className="text-xl font-semibold text-slate-900 dark:text-white">Strategy Replay</h2>
          </div>
          <Badge variant="neutral">Paper only</Badge>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 text-sm">
          <div>
            <label className="text-xs text-slate-500">Symbol</label>
            <input
              value={symbol}
              onChange={event => setSymbol(event.target.value.toUpperCase())}
              className="mt-1 w-full rounded-lg border border-slate-200/80 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2"
            />
          </div>
          <div>
            <label className="text-xs text-slate-500">Strategy</label>
            <select
              value={strategyId}
              onChange={event => setStrategyId(event.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-200/80 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2"
            >
              {strategies.map(strategy => (
                <option key={strategy.strategyId} value={strategy.strategyId}>
                  {strategy.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-slate-500">Start</label>
            <input
              type="date"
              value={start}
              onChange={event => setStart(event.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-200/80 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2"
            />
          </div>
          <div>
            <label className="text-xs text-slate-500">End</label>
            <input
              type="date"
              value={end}
              onChange={event => setEnd(event.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-200/80 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2"
            />
          </div>
        </div>

        {activeStrategy && (
          <p className="text-xs text-slate-500 mt-3">{activeStrategy.description}</p>
        )}

        <Button className="mt-4" onClick={runBacktest} disabled={backtestLoading}>
          {backtestLoading ? 'Running...' : 'Run backtest'}
        </Button>

        {result && (
          <div className="mt-6 space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4 text-sm">
              <div>
                <p className="text-xs text-slate-500">Trades</p>
                <p className="font-semibold">{result.tradeCount}</p>
              </div>
              <div>
                <p className="text-xs text-slate-500">Win Rate</p>
                <p className="font-semibold">{result.winRate}%</p>
              </div>
              <div>
                <p className="text-xs text-slate-500">Avg R</p>
                <p className="font-semibold">{result.avgR}</p>
              </div>
              <div>
                <p className="text-xs text-slate-500">Max Drawdown</p>
                <p className="font-semibold">{result.maxDrawdown}%</p>
              </div>
              <div>
                <p className="text-xs text-slate-500">Strategy</p>
                <p className="font-semibold">{result.strategy.strategyId}</p>
              </div>
            </div>

            <div className="h-52">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={result.equityCurve}>
                  <XAxis dataKey="timestamp" hide />
                  <YAxis hide domain={['auto', 'auto']} />
                  <Tooltip />
                  <Line type="monotone" dataKey="equity" stroke="#111827" dot={false} strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
