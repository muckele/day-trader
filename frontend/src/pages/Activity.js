import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import Card from '../components/ui/Card';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import Skeleton from '../components/ui/Skeleton';
import { getCache, setCache } from '../utils/cache';
import { getApiError } from '../utils/api';
import { emitToast } from '../utils/toast';

function formatTime(value) {
  if (!value) return '--';
  return new Date(value).toLocaleString();
}

export default function Activity() {
  const [orders, setOrders] = useState([]);
  const [trades, setTrades] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [selectedTrade, setSelectedTrade] = useState(null);
  const [journalEntry, setJournalEntry] = useState(null);
  const [journalLoading, setJournalLoading] = useState(false);
  const [journalSaving, setJournalSaving] = useState(false);

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      setError('');
      try {
        const cachedOrders = getCache('paper-orders');
        const cachedTrades = getCache('paper-trades');
        if (cachedOrders) setOrders(cachedOrders);
        if (cachedTrades) setTrades(cachedTrades);

        const [ordersRes, tradesRes] = await Promise.all([
          axios.get('/api/paper-trades/orders'),
          axios.get('/api/paper-trades/trades')
        ]);
        setOrders(ordersRes.data || []);
        setTrades(tradesRes.data || []);
        setCache('paper-orders', ordersRes.data || [], 8 * 1000);
        setCache('paper-trades', tradesRes.data || [], 8 * 1000);
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

  const activity = useMemo(() => {
    const orderItems = orders.map(item => ({
      type: 'order',
      ...item,
      timestamp: item.filledAt
    }));
    const tradeItems = trades.map(item => ({
      type: 'trade',
      ...item,
      timestamp: item.filledAt
    }));
    return [...orderItems, ...tradeItems].sort(
      (a, b) => new Date(b.timestamp) - new Date(a.timestamp)
    );
  }, [orders, trades]);

  const openJournal = async trade => {
    setSelectedTrade(trade);
    setJournalLoading(true);
    try {
      const res = await axios.get(`/api/journal/${trade._id}`);
      setJournalEntry(res.data || {
        thesis: '',
        plan: '',
        emotions: '',
        postTradeNotes: '',
        rating: null,
        tags: []
      });
    } catch (err) {
      emitToast({ type: 'error', message: getApiError(err) });
    } finally {
      setJournalLoading(false);
    }
  };

  const saveJournal = async () => {
    if (!selectedTrade) return;
    setJournalSaving(true);
    try {
      const res = await axios.put(`/api/journal/${selectedTrade._id}`, journalEntry);
      setJournalEntry(res.data);
      emitToast({ type: 'success', message: 'Journal entry saved.' });
    } catch (err) {
      emitToast({ type: 'error', message: getApiError(err) });
    } finally {
      setJournalSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-4 w-32" />
        <div className="space-y-3">
          {Array.from({ length: 6 }).map((_, idx) => (
            <Skeleton key={`act-skel-${idx}`} className="h-14 w-full" />
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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-400">Activity</p>
          <h1 className="text-3xl font-bold text-slate-900 dark:text-white">Orders & Trades</h1>
        </div>
        <Badge variant="solid">PAPER MODE</Badge>
      </div>

      <Card className="p-6">
        <p className="text-sm font-semibold text-slate-900 dark:text-white mb-4">Recent Activity</p>
        {activity.length ? (
          <div className="space-y-3">
            {activity.map(item => (
              <div
                key={`${item.type}-${item._id}`}
                className={`border border-slate-100 dark:border-slate-800 rounded-lg p-3 transition ${
                  item.type === 'trade'
                    ? 'hover:bg-slate-50/80 dark:hover:bg-slate-900/40 cursor-pointer'
                    : ''
                }`}
                onClick={() => {
                  if (item.type === 'trade') {
                    openJournal(item);
                  }
                }}
              >
                <div className="flex items-center justify-between">
                  <p className="font-semibold text-slate-900 dark:text-white">{item.symbol}</p>
                  <p className="text-xs text-slate-500">{formatTime(item.timestamp)}</p>
                </div>
                <p className="text-sm text-slate-600 dark:text-slate-300">
                  {item.side.toUpperCase()} {item.qty} @ $
                  {item.type === 'order' ? item.fillPrice : item.price}
                </p>
                {item.strategyId && (
                  <p className="text-xs text-slate-500">Strategy {item.strategyId}</p>
                )}
                {item.type === 'trade' && (
                  <p className={`text-xs ${item.realizedPnl >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                    Realized P/L {item.realizedPnl.toFixed(2)}
                  </p>
                )}
                <p className="text-xs text-slate-400 uppercase mt-1">{item.type}</p>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-slate-500">No activity yet.</p>
        )}
      </Card>

      {selectedTrade && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center px-4 z-50">
          <Card className="p-6 max-w-lg w-full">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold text-slate-900 dark:text-white">
                  {selectedTrade.symbol} Trade Journal
                </p>
                <p className="text-xs text-slate-500">
                  {selectedTrade.side.toUpperCase()} {selectedTrade.qty} @ ${selectedTrade.price}
                </p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setSelectedTrade(null)}>
                Close
              </Button>
            </div>

            {journalLoading ? (
              <div className="mt-4 space-y-3">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-20 w-full" />
              </div>
            ) : (
              <div className="mt-4 space-y-3 text-sm">
                <div>
                  <label className="text-xs text-slate-500">Thesis</label>
                  <input
                    value={journalEntry?.thesis || ''}
                    onChange={event => setJournalEntry(prev => ({ ...prev, thesis: event.target.value }))}
                    className="mt-1 w-full rounded-lg border border-slate-200/80 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2"
                  />
                </div>
                <div>
                  <label className="text-xs text-slate-500">Plan</label>
                  <textarea
                    value={journalEntry?.plan || ''}
                    onChange={event => setJournalEntry(prev => ({ ...prev, plan: event.target.value }))}
                    className="mt-1 w-full rounded-lg border border-slate-200/80 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2"
                    rows={2}
                  />
                </div>
                <div>
                  <label className="text-xs text-slate-500">Emotions</label>
                  <input
                    value={journalEntry?.emotions || ''}
                    onChange={event => setJournalEntry(prev => ({ ...prev, emotions: event.target.value }))}
                    className="mt-1 w-full rounded-lg border border-slate-200/80 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2"
                  />
                </div>
                <div>
                  <label className="text-xs text-slate-500">Post-trade notes</label>
                  <textarea
                    value={journalEntry?.postTradeNotes || ''}
                    onChange={event => setJournalEntry(prev => ({ ...prev, postTradeNotes: event.target.value }))}
                    className="mt-1 w-full rounded-lg border border-slate-200/80 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2"
                    rows={3}
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-slate-500">Rating (1-5)</label>
                    <input
                      type="number"
                      min="1"
                      max="5"
                      value={journalEntry?.rating || ''}
                      onChange={event => setJournalEntry(prev => ({
                        ...prev,
                        rating: event.target.value ? Number(event.target.value) : null
                      }))}
                      className="mt-1 w-full rounded-lg border border-slate-200/80 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-slate-500">Tags</label>
                    <input
                      value={journalEntry?.tags?.join(', ') || ''}
                      onChange={event => setJournalEntry(prev => ({
                        ...prev,
                        tags: event.target.value
                          .split(',')
                          .map(tag => tag.trim())
                          .filter(Boolean)
                      }))}
                      className="mt-1 w-full rounded-lg border border-slate-200/80 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2"
                    />
                  </div>
                </div>
                <Button onClick={saveJournal} disabled={journalSaving}>
                  {journalSaving ? 'Saving...' : 'Save Journal'}
                </Button>
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
