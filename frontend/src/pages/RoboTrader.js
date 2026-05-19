import React, { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge from '../components/ui/Badge';
import Skeleton from '../components/ui/Skeleton';
import { getApiError } from '../utils/api';

const LIVE_CONFIRMATION_TEXT = 'I understand live trading risk';
const RISK_DISCLOSURE = 'RoboTrader uses automated trading rules and market data to identify potential opportunities. Trading involves risk, including possible loss of principal. Past performance does not guarantee future results.';

function formatMoney(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '--';
  return `$${amount.toFixed(2)}`;
}

function formatNumber(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '--';
  return amount.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function formatDateTime(value) {
  if (!value) return '--';
  return new Date(value).toLocaleString();
}

function toSymbolText(value) {
  return Array.isArray(value) ? value.join(', ') : String(value || '');
}

function fromSymbolText(value) {
  return String(value || '')
    .split(',')
    .map(item => item.trim().toUpperCase())
    .filter(Boolean);
}

const defaultSettings = {
  isEnabled: false,
  mode: 'paper',
  liveTradingExplicitlyEnabled: false,
  allowedAssetClasses: ['stocks'],
  allowedSymbols: [],
  blockedSymbols: [],
  maxTradeAmount: 1000,
  maxPositionSize: 5000,
  maxDailyLoss: 500,
  maxOpenPositions: 5,
  maxTradesPerDay: 3,
  allowShortSelling: false,
  allowFractionalShares: true,
  allowExtendedHours: false,
  allowOptionsTrading: false,
  allowCryptoTrading: false,
  riskLevel: 'balanced',
  requireManualApprovalAboveDollarAmount: 0,
  pausedReason: null,
  lastRunAt: null
};

export default function RoboTrader() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [runningNow, setRunningNow] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [settings, setSettings] = useState(defaultSettings);
  const [allowedSymbolsText, setAllowedSymbolsText] = useState('');
  const [blockedSymbolsText, setBlockedSymbolsText] = useState('');
  const [liveConfirmation, setLiveConfirmation] = useState('');
  const [decisions, setDecisions] = useState([]);
  const [orders, setOrders] = useState([]);
  const [audit, setAudit] = useState([]);
  const [performance, setPerformance] = useState(null);

  const loadAll = useCallback(async () => {
    const [settingsRes, decisionsRes, ordersRes, performanceRes, auditRes] = await Promise.all([
      axios.get('/api/robotrader/settings'),
      axios.get('/api/robotrader/decisions', { params: { limit: 25 } }),
      axios.get('/api/robotrader/orders', { params: { limit: 25 } }),
      axios.get('/api/robotrader/performance'),
      axios.get('/api/robotrader/audit', { params: { limit: 25 } })
    ]);

    const nextSettings = { ...defaultSettings, ...(settingsRes.data?.settings || {}) };
    setSettings(nextSettings);
    setAllowedSymbolsText(toSymbolText(nextSettings.allowedSymbols));
    setBlockedSymbolsText(toSymbolText(nextSettings.blockedSymbols));
    setDecisions(decisionsRes.data?.decisions || []);
    setOrders(ordersRes.data?.orders || []);
    setPerformance(performanceRes.data || null);
    setAudit(auditRes.data?.events || []);
  }, []);

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError('');
      try {
        await loadAll();
      } catch (err) {
        setError(getApiError(err));
      } finally {
        setLoading(false);
      }
    })();
  }, [loadAll]);

  const rejectedDecisions = useMemo(
    () => decisions.filter(item => item.status === 'rejected' || item.status === 'pending_manual_approval'),
    [decisions]
  );

  const submittedOrders = useMemo(
    () => orders.filter(item => !['pending_submit', 'rejected'].includes(String(item.status || '').toLowerCase())),
    [orders]
  );

  const updateSetting = (key, value) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  };

  const toggleAssetClass = assetClass => {
    setSettings(prev => {
      const current = new Set(prev.allowedAssetClasses || []);
      if (current.has(assetClass)) current.delete(assetClass);
      else current.add(assetClass);
      if (!current.size) current.add('stocks');
      return { ...prev, allowedAssetClasses: [...current] };
    });
  };

  const buildSettingsPayload = () => ({
    ...settings,
    allowedSymbols: fromSymbolText(allowedSymbolsText),
    blockedSymbols: fromSymbolText(blockedSymbolsText),
    liveTradingExplicitlyEnabled: settings.mode === 'live'
      ? settings.liveTradingExplicitlyEnabled
      : false,
    confirmLiveTrading: settings.mode === 'live' ? liveConfirmation : undefined
  });

  const refreshAfterAction = async message => {
    await loadAll();
    setSuccess(message);
  };

  const handleSave = async () => {
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      await axios.put('/api/robotrader/settings', buildSettingsPayload());
      await refreshAfterAction('RoboTrader settings saved.');
    } catch (err) {
      setError(getApiError(err));
    } finally {
      setSaving(false);
    }
  };

  const handleToggleEnabled = async () => {
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      if (settings.isEnabled) {
        await axios.post('/api/robotrader/disable', { reason: 'Disabled from dashboard.' });
        await refreshAfterAction('RoboTrader disabled.');
      } else {
        await axios.post('/api/robotrader/enable', buildSettingsPayload());
        await refreshAfterAction('RoboTrader enabled.');
      }
    } catch (err) {
      setError(getApiError(err));
    } finally {
      setSaving(false);
    }
  };

  const handleRunOnce = async () => {
    setRunningNow(true);
    setError('');
    setSuccess('');
    try {
      const res = await axios.post('/api/robotrader/run-once-paper');
      await refreshAfterAction(`Paper run completed: ${res.data?.result?.runId || 'run saved'}.`);
    } catch (err) {
      setError(getApiError(err));
    } finally {
      setRunningNow(false);
    }
  };

  const handleEmergencyStop = async () => {
    const shouldStop = window.confirm('Emergency stop will disable RoboTrader immediately.');
    if (!shouldStop) return;
    const cancelOpenOrders = window.confirm('Cancel open RoboTrader-created Alpaca paper orders too?');
    setStopping(true);
    setError('');
    setSuccess('');
    try {
      await axios.post('/api/robotrader/emergency-stop', { cancelOpenOrders, environment: 'paper' });
      await refreshAfterAction('Emergency stop completed.');
    } catch (err) {
      setError(getApiError(err));
    } finally {
      setStopping(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <Card className="p-6">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-full mt-4" />
          <Skeleton className="h-40 w-full mt-6" />
        </Card>
        <Card className="p-6">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-32 w-full mt-4" />
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Card className="p-6">
        <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
          <div>
            <p className="text-[11px] uppercase tracking-[0.2em] text-emerald-100/45">Automation</p>
            <h1 className="text-3xl font-extrabold tracking-tight text-emerald-50">RoboTrader</h1>
            <p className="text-sm text-emerald-100/65 mt-2 max-w-4xl">{RISK_DISCLOSURE}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant={settings.isEnabled ? 'success' : 'neutral'}>
              {settings.isEnabled ? 'Enabled' : 'Disabled'}
            </Badge>
            <Badge variant={settings.mode === 'live' ? 'danger' : 'solid'}>
              {settings.mode === 'live' ? 'Live Mode' : 'Paper Mode'}
            </Badge>
          </div>
        </div>

        {error && <p className="mt-4 text-sm text-[#ffb2c1]">{error}</p>}
        {success && <p className="mt-4 text-sm text-[#5dff90]">{success}</p>}

        <div className="mt-6 flex flex-wrap gap-2">
          <Button onClick={handleToggleEnabled} disabled={saving} variant={settings.isEnabled ? 'secondary' : 'primary'}>
            {settings.isEnabled ? 'Disable RoboTrader' : 'Enable RoboTrader'}
          </Button>
          <Button variant="secondary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : 'Save Settings'}
          </Button>
          <Button variant="secondary" onClick={handleRunOnce} disabled={runningNow}>
            {runningNow ? 'Running...' : 'Run Once Paper'}
          </Button>
          <Button variant="danger" onClick={handleEmergencyStop} disabled={stopping}>
            {stopping ? 'Stopping...' : 'Emergency Stop'}
          </Button>
        </div>
      </Card>

      <Card className="p-6">
        <h2 className="text-lg font-semibold text-emerald-50">Trading Mode</h2>
        <div className="mt-4 grid grid-cols-1 lg:grid-cols-3 gap-4">
          <label className="flex flex-col gap-2 rounded-lg border border-emerald-900/60 bg-[#0f1913] px-4 py-3">
            <span className="text-xs uppercase tracking-wide text-emerald-100/50">Mode</span>
            <select
              value={settings.mode}
              onChange={event => updateSetting('mode', event.target.value)}
              className="rounded-lg border border-emerald-900/70 bg-[#0a130f] px-3 py-2 text-sm text-emerald-50 focus:outline-none"
            >
              <option value="paper">Paper</option>
              <option value="live">Live</option>
            </select>
          </label>
          <label className="flex items-center justify-between gap-4 rounded-lg border border-emerald-900/60 bg-[#0f1913] px-4 py-3">
            <span className="text-sm text-emerald-100/80">Live trading explicit opt-in</span>
            <input
              type="checkbox"
              checked={settings.liveTradingExplicitlyEnabled}
              onChange={event => updateSetting('liveTradingExplicitlyEnabled', event.target.checked)}
              disabled={settings.mode !== 'live'}
            />
          </label>
          <label className="flex flex-col gap-2 rounded-lg border border-emerald-900/60 bg-[#0f1913] px-4 py-3">
            <span className="text-xs uppercase tracking-wide text-emerald-100/50">Live confirmation</span>
            <input
              value={liveConfirmation}
              onChange={event => setLiveConfirmation(event.target.value)}
              disabled={settings.mode !== 'live'}
              placeholder={LIVE_CONFIRMATION_TEXT}
              className="rounded-lg border border-emerald-900/70 bg-[#0a130f] px-3 py-2 text-sm text-emerald-50 focus:outline-none"
            />
          </label>
        </div>
        {settings.mode === 'live' && (
          <div className="mt-4 rounded-lg border border-[#5d2734] bg-[#341a22]/70 px-4 py-3">
            <p className="text-sm font-semibold text-[#ff9db0]">Live trading requires explicit confirmation.</p>
            <p className="text-xs text-[#ffd1da]/80 mt-1">
              Paper mode remains the default. Live mode will not save unless the opt-in box is checked and the confirmation text matches exactly.
            </p>
          </div>
        )}
      </Card>

      <Card className="p-6">
        <h2 className="text-lg font-semibold text-emerald-50">Risk Settings</h2>
        <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {[
            ['maxTradeAmount', 'Max Trade Amount'],
            ['maxPositionSize', 'Max Position Size'],
            ['maxDailyLoss', 'Max Daily Loss'],
            ['maxOpenPositions', 'Max Open Positions'],
            ['maxTradesPerDay', 'Max Trades Per Day'],
            ['requireManualApprovalAboveDollarAmount', 'Manual Approval Above']
          ].map(([key, label]) => (
            <label key={key} className="flex flex-col gap-2 rounded-lg border border-emerald-900/60 bg-[#0f1913] px-4 py-3">
              <span className="text-xs uppercase tracking-wide text-emerald-100/50">{label}</span>
              <input
                type="number"
                min="0"
                value={settings[key] ?? 0}
                onChange={event => updateSetting(key, Number(event.target.value))}
                className="rounded-lg border border-emerald-900/70 bg-[#0a130f] px-3 py-2 text-sm text-emerald-50 focus:outline-none"
              />
            </label>
          ))}
          <label className="flex flex-col gap-2 rounded-lg border border-emerald-900/60 bg-[#0f1913] px-4 py-3">
            <span className="text-xs uppercase tracking-wide text-emerald-100/50">Risk Level</span>
            <select
              value={settings.riskLevel}
              onChange={event => updateSetting('riskLevel', event.target.value)}
              className="rounded-lg border border-emerald-900/70 bg-[#0a130f] px-3 py-2 text-sm text-emerald-50 focus:outline-none"
            >
              <option value="conservative">Conservative</option>
              <option value="balanced">Balanced</option>
              <option value="aggressive">Aggressive</option>
            </select>
          </label>
        </div>

        <div className="mt-5 grid grid-cols-1 lg:grid-cols-2 gap-4">
          <label className="flex flex-col gap-2 rounded-lg border border-emerald-900/60 bg-[#0f1913] px-4 py-3">
            <span className="text-xs uppercase tracking-wide text-emerald-100/50">Allowed Symbols</span>
            <input
              value={allowedSymbolsText}
              onChange={event => setAllowedSymbolsText(event.target.value)}
              placeholder="AAPL, MSFT, SPY"
              className="rounded-lg border border-emerald-900/70 bg-[#0a130f] px-3 py-2 text-sm text-emerald-50 focus:outline-none"
            />
          </label>
          <label className="flex flex-col gap-2 rounded-lg border border-emerald-900/60 bg-[#0f1913] px-4 py-3">
            <span className="text-xs uppercase tracking-wide text-emerald-100/50">Blocked Symbols</span>
            <input
              value={blockedSymbolsText}
              onChange={event => setBlockedSymbolsText(event.target.value)}
              placeholder="TSLA, GME"
              className="rounded-lg border border-emerald-900/70 bg-[#0a130f] px-3 py-2 text-sm text-emerald-50 focus:outline-none"
            />
          </label>
        </div>

        <div className="mt-5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {[
            ['stocks', 'Stocks', 'allowedAssetClasses'],
            ['crypto', 'Crypto', 'allowedAssetClasses'],
            ['options', 'Options', 'allowedAssetClasses']
          ].map(([assetClass, label]) => (
            <label key={assetClass} className="flex items-center justify-between rounded-lg border border-emerald-900/60 bg-[#0f1913] px-4 py-3">
              <span className="text-sm text-emerald-100/80">{label}</span>
              <input
                type="checkbox"
                checked={(settings.allowedAssetClasses || []).includes(assetClass)}
                onChange={() => toggleAssetClass(assetClass)}
              />
            </label>
          ))}
          {[
            ['allowShortSelling', 'Short selling'],
            ['allowFractionalShares', 'Fractional shares'],
            ['allowExtendedHours', 'Extended hours'],
            ['allowOptionsTrading', 'Options trading'],
            ['allowCryptoTrading', 'Crypto trading']
          ].map(([key, label]) => (
            <label key={key} className="flex items-center justify-between rounded-lg border border-emerald-900/60 bg-[#0f1913] px-4 py-3">
              <span className="text-sm text-emerald-100/80">{label}</span>
              <input
                type="checkbox"
                checked={Boolean(settings[key])}
                onChange={event => updateSetting(key, event.target.checked)}
              />
            </label>
          ))}
        </div>
      </Card>

      <Card className="p-6">
        <h2 className="text-lg font-semibold text-emerald-50">Performance Summary</h2>
        <div className="mt-4 grid grid-cols-2 lg:grid-cols-5 gap-4">
          <div className="rounded-lg border border-emerald-900/60 bg-[#0f1913] p-4">
            <p className="text-xs text-emerald-100/50 uppercase">Decisions</p>
            <p className="text-xl font-semibold text-emerald-50">{performance?.summary?.decisions ?? 0}</p>
          </div>
          <div className="rounded-lg border border-emerald-900/60 bg-[#0f1913] p-4">
            <p className="text-xs text-emerald-100/50 uppercase">Submitted</p>
            <p className="text-xl font-semibold text-emerald-50">{performance?.summary?.submittedOrders ?? 0}</p>
          </div>
          <div className="rounded-lg border border-emerald-900/60 bg-[#0f1913] p-4">
            <p className="text-xs text-emerald-100/50 uppercase">Filled</p>
            <p className="text-xl font-semibold text-emerald-50">{performance?.summary?.filledOrders ?? 0}</p>
          </div>
          <div className="rounded-lg border border-emerald-900/60 bg-[#0f1913] p-4">
            <p className="text-xs text-emerald-100/50 uppercase">Rejected</p>
            <p className="text-xl font-semibold text-emerald-50">{performance?.summary?.rejectedDecisions ?? 0}</p>
          </div>
          <div className="rounded-lg border border-emerald-900/60 bg-[#0f1913] p-4">
            <p className="text-xs text-emerald-100/50 uppercase">Last Run</p>
            <p className="text-sm font-semibold text-emerald-50">{formatDateTime(performance?.summary?.lastRunAt || settings.lastRunAt)}</p>
          </div>
        </div>
        {performance?.brokerError && <p className="mt-3 text-xs text-amber-200">{performance.brokerError}</p>}
      </Card>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <Card className="p-6">
          <h2 className="text-lg font-semibold text-emerald-50">Current Positions</h2>
          <div className="mt-4 space-y-3">
            {(performance?.positions || []).length ? performance.positions.slice(0, 8).map(position => (
              <div key={position.symbol} className="flex items-center justify-between rounded-lg border border-emerald-900/60 bg-[#0f1913] px-4 py-3">
                <div>
                  <p className="text-sm font-semibold text-emerald-50">{position.symbol}</p>
                  <p className="text-xs text-emerald-100/55">Qty {formatNumber(position.qty)}</p>
                </div>
                <p className="text-sm text-emerald-100/80">{formatMoney(position.market_value)}</p>
              </div>
            )) : <p className="text-sm text-emerald-100/55">No positions returned.</p>}
          </div>
        </Card>

        <Card className="p-6">
          <h2 className="text-lg font-semibold text-emerald-50">Submitted Orders</h2>
          <div className="mt-4 space-y-3">
            {submittedOrders.length ? submittedOrders.slice(0, 8).map(order => (
              <div key={order._id} className="rounded-lg border border-emerald-900/60 bg-[#0f1913] px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-semibold text-emerald-50">{order.side?.toUpperCase()} {order.symbol}</p>
                  <Badge variant={order.status === 'filled' ? 'success' : 'neutral'}>{order.status}</Badge>
                </div>
                <p className="text-xs text-emerald-100/55 mt-2">
                  {order.orderType} {order.orderClass} · {order.timeInForce} · {order.clientOrderId || order.externalOrderId || '--'}
                </p>
              </div>
            )) : <p className="text-sm text-emerald-100/55">No RoboTrader orders submitted yet.</p>}
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <Card className="p-6">
          <h2 className="text-lg font-semibold text-emerald-50">Recent Decisions</h2>
          <div className="mt-4 space-y-3">
            {decisions.length ? decisions.slice(0, 10).map(decision => (
              <div key={decision._id} className="rounded-lg border border-emerald-900/60 bg-[#0f1913] px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-semibold text-emerald-50">{decision.symbol} · {decision.strategyName || decision.strategyId || '--'}</p>
                  <Badge variant={decision.status === 'approved' || decision.status === 'submitted' ? 'success' : 'warning'}>
                    {decision.status}
                  </Badge>
                </div>
                <p className="text-xs text-emerald-100/55 mt-2">
                  Confidence {decision.confidenceScore ?? 0} · R/R {decision.rewardRiskRatio ?? '--'} · {formatDateTime(decision.decidedAt)}
                </p>
                {decision.reasoningSummary && <p className="text-xs text-emerald-100/70 mt-2">{decision.reasoningSummary}</p>}
              </div>
            )) : <p className="text-sm text-emerald-100/55">No decisions saved yet.</p>}
          </div>
        </Card>

        <Card className="p-6">
          <h2 className="text-lg font-semibold text-emerald-50">Rejected Trades</h2>
          <div className="mt-4 space-y-3">
            {rejectedDecisions.length ? rejectedDecisions.slice(0, 10).map(decision => (
              <div key={decision._id} className="rounded-lg border border-emerald-900/60 bg-[#0f1913] px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-semibold text-emerald-50">{decision.symbol}</p>
                  <Badge variant="warning">{decision.status}</Badge>
                </div>
                <ul className="mt-2 list-disc pl-4 text-xs text-emerald-100/65 space-y-1">
                  {(decision.rejectionReasons || []).slice(0, 4).map(reason => (
                    <li key={`${decision._id}-${reason}`}>{reason}</li>
                  ))}
                </ul>
              </div>
            )) : <p className="text-sm text-emerald-100/55">No rejected RoboTrader trades yet.</p>}
          </div>
        </Card>
      </div>

      <Card className="p-6">
        <h2 className="text-lg font-semibold text-emerald-50">Audit Log</h2>
        <div className="mt-4 space-y-3">
          {audit.length ? audit.map(event => (
            <div key={event._id} className="rounded-lg border border-emerald-900/60 bg-[#0f1913] px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-semibold text-emerald-50">{event.eventType}</p>
                <p className="text-xs text-emerald-100/50">{formatDateTime(event.createdAt)}</p>
              </div>
              <pre className="mt-2 whitespace-pre-wrap break-words text-xs text-emerald-100/60">
                {JSON.stringify(event.payload || {}, null, 2)}
              </pre>
            </div>
          )) : <p className="text-sm text-emerald-100/55">No RoboTrader audit entries yet.</p>}
        </div>
      </Card>
    </div>
  );
}
