import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { LineChart, Line, ResponsiveContainer, XAxis, YAxis, Tooltip } from 'recharts';
import { useNavigate } from 'react-router-dom';
import Card from '../components/ui/Card';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import Skeleton from '../components/ui/Skeleton';
import { getCache, setCache } from '../utils/cache';
import { getApiError } from '../utils/api';
import { emitToast } from '../utils/toast';

function formatCurrency(value) {
  if (value === null || value === undefined) return '--';
  return `$${Number(value).toFixed(2)}`;
}

export default function Portfolio() {
  const navigate = useNavigate();
  const [account, setAccount] = useState(null);
  const [equity, setEquity] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      setError('');
      try {
        const cachedAccount = getCache('paper-account');
        const cachedEquity = getCache('paper-equity');
        if (cachedAccount) setAccount(cachedAccount);
        if (cachedEquity) setEquity(cachedEquity);

        const [accountRes, equityRes] = await Promise.all([
          axios.get('/api/paper-trades/account'),
          axios.get('/api/paper-trades/equity')
        ]);
        setAccount(accountRes.data);
        setEquity(equityRes.data || []);
        setCache('paper-account', accountRes.data, 8 * 1000);
        setCache('paper-equity', equityRes.data || [], 10 * 1000);
      } catch (err) {
        const message = getApiError(err);
        setError(message);
        emitToast({
          type: 'error',
          message,
          action: { label: 'Retry', onClick: () => setReloadKey(prev => prev + 1) }
        });
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [reloadKey]);

  const handleRetry = () => {
    setReloadKey(prev => prev + 1);
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <Card className="p-6">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-40 w-full mt-4" />
        </Card>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, idx) => (
            <Skeleton key={`port-skel-${idx}`} className="h-20 w-full" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <Card className="p-6">
        <p className="text-sm text-red-500">{error}</p>
        <Button variant="secondary" size="sm" className="mt-4" onClick={handleRetry}>
          Retry
        </Button>
      </Card>
    );
  }
  if (!account) return null;

  const positions = account.positions || [];
  const settings = account.settings || {};

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-400">Portfolio</p>
          <h1 className="text-3xl font-bold text-slate-900 dark:text-white">Paper Mode</h1>
        </div>
        <Badge variant="solid">PAPER MODE</Badge>
      </div>

      <Card className="p-6">
        <div className="flex items-center justify-between mb-4">
          <p className="text-sm font-semibold text-slate-900 dark:text-white">Equity Curve</p>
          <p className="text-xs text-slate-500">All time</p>
        </div>
        <div className="h-52">
          {equity.length ? (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={equity}>
                <XAxis dataKey="timestamp" hide />
                <YAxis hide domain={['auto', 'auto']} />
                <Tooltip
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const point = payload[0].payload;
                    return (
                      <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-sm dark:border-slate-700 dark:bg-slate-900">
                        <p className="text-slate-500">{new Date(point.timestamp).toLocaleString()}</p>
                        <p className="font-semibold text-slate-900 dark:text-white">
                          Equity {formatCurrency(point.equity)}
                        </p>
                        <p className="text-slate-500">Daily {formatCurrency(point.dailyPnl)}</p>
                      </div>
                    );
                  }}
                />
                <Line type="monotone" dataKey="equity" stroke="#111827" dot={false} strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-full flex items-center justify-center text-sm text-slate-400">
              No equity history yet.
            </div>
          )}
        </div>
      </Card>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="p-4">
          <p className="text-xs text-slate-500">Equity</p>
          <p className="text-lg font-semibold text-slate-900 dark:text-white">{formatCurrency(account.equity)}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-slate-500">Today&apos;s P/L</p>
          <p className={`text-lg font-semibold ${account.dailyPnl >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
            {formatCurrency(account.dailyPnl)}
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-slate-500">All-time P/L</p>
          <p className={`text-lg font-semibold ${account.totalPnl >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
            {formatCurrency(account.totalPnl)}
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-slate-500">Cash</p>
          <p className="text-lg font-semibold text-slate-900 dark:text-white">{formatCurrency(account.cash)}</p>
        </Card>
      </div>

      <Card className="p-6">
        <p className="text-sm font-semibold text-slate-900 dark:text-white mb-4">Positions</p>
        {positions.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-slate-500 uppercase text-left">
                <tr>
                  <th className="py-2">Symbol</th>
                  <th className="py-2">Qty</th>
                  <th className="py-2">Avg Cost</th>
                  <th className="py-2">Price</th>
                  <th className="py-2">Unrealized P/L</th>
                </tr>
              </thead>
              <tbody>
                {positions.map(pos => (
                  <tr key={pos.symbol} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="py-2 font-semibold text-slate-900 dark:text-white">{pos.symbol}</td>
                    <td className="py-2">{pos.qty}</td>
                    <td className="py-2">{formatCurrency(pos.avgCost)}</td>
                    <td className="py-2">{formatCurrency(pos.marketPrice)}</td>
                    <td className={`py-2 ${pos.unrealizedPnl >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                      {formatCurrency(pos.unrealizedPnl)} ({pos.unrealizedPnlPct.toFixed(2)}%)
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-sm text-slate-500 flex flex-col gap-3">
            <p>No open positions yet.</p>
            <Button variant="secondary" size="sm" onClick={() => navigate('/watchlist')}>
              Try a paper trade
            </Button>
          </div>
        )}
      </Card>

      <Card className="p-6">
        <p className="text-sm font-semibold text-slate-900 dark:text-white mb-3">Risk Settings</p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm text-slate-600 dark:text-slate-300">
          <div>
            <p className="text-xs text-slate-500">Max Position</p>
            <p>{settings.maxPositionPct}%</p>
          </div>
          <div>
            <p className="text-xs text-slate-500">Max Daily Loss</p>
            <p>{settings.maxDailyLossPct}%</p>
          </div>
          <div>
            <p className="text-xs text-slate-500">Slippage</p>
            <p>{settings.slippageBps} bps</p>
          </div>
          <div>
            <p className="text-xs text-slate-500">Commission</p>
            <p>{formatCurrency(settings.commission)}</p>
          </div>
        </div>
      </Card>
    </div>
  );
}
