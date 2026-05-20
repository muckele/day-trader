import React, { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge from '../components/ui/Badge';
import Skeleton from '../components/ui/Skeleton';
import { getApiError } from '../utils/api';

const LIVE_CONFIRMATION_TEXT = 'I understand live trading risk';
const RISK_DISCLOSURE = 'RoboTrader uses automated trading rules and market data to identify potential opportunities. Trading involves risk, including possible loss of principal. Past performance does not guarantee future results.';

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

const RISK_PRESETS = [
  {
    id: 'paper-test',
    label: 'Paper Test',
    meta: '$100 max / 1 trade',
    values: {
      mode: 'paper',
      liveTradingExplicitlyEnabled: false,
      maxTradeAmount: 100,
      maxPositionSize: 250,
      maxDailyLoss: 50,
      maxOpenPositions: 1,
      maxTradesPerDay: 1,
      requireManualApprovalAboveDollarAmount: 0,
      riskLevel: 'conservative',
      allowedAssetClasses: ['stocks'],
      allowedSymbols: ['AAPL', 'MSFT', 'SPY'],
      blockedSymbols: ['TSLA', 'GME'],
      allowShortSelling: false,
      allowFractionalShares: true,
      allowExtendedHours: false,
      allowOptionsTrading: false,
      allowCryptoTrading: false
    }
  },
  {
    id: 'conservative',
    label: 'Conservative',
    meta: '$250 max / 2 trades',
    values: {
      mode: 'paper',
      liveTradingExplicitlyEnabled: false,
      maxTradeAmount: 250,
      maxPositionSize: 750,
      maxDailyLoss: 100,
      maxOpenPositions: 3,
      maxTradesPerDay: 2,
      requireManualApprovalAboveDollarAmount: 0,
      riskLevel: 'conservative',
      allowedAssetClasses: ['stocks'],
      allowedSymbols: [],
      blockedSymbols: [],
      allowShortSelling: false,
      allowFractionalShares: true,
      allowExtendedHours: false,
      allowOptionsTrading: false,
      allowCryptoTrading: false
    }
  },
  {
    id: 'balanced',
    label: 'Balanced',
    meta: '$500 max / 3 trades',
    values: {
      mode: 'paper',
      liveTradingExplicitlyEnabled: false,
      maxTradeAmount: 500,
      maxPositionSize: 1500,
      maxDailyLoss: 200,
      maxOpenPositions: 5,
      maxTradesPerDay: 3,
      requireManualApprovalAboveDollarAmount: 0,
      riskLevel: 'balanced',
      allowedAssetClasses: ['stocks'],
      allowedSymbols: [],
      blockedSymbols: [],
      allowShortSelling: false,
      allowFractionalShares: true,
      allowExtendedHours: false,
      allowOptionsTrading: false,
      allowCryptoTrading: false
    }
  },
  {
    id: 'aggressive-paper',
    label: 'Aggressive Paper',
    meta: '$1000 max / 5 trades',
    values: {
      mode: 'paper',
      liveTradingExplicitlyEnabled: false,
      maxTradeAmount: 1000,
      maxPositionSize: 3000,
      maxDailyLoss: 400,
      maxOpenPositions: 8,
      maxTradesPerDay: 5,
      requireManualApprovalAboveDollarAmount: 0,
      riskLevel: 'aggressive',
      allowedAssetClasses: ['stocks'],
      allowedSymbols: [],
      blockedSymbols: [],
      allowShortSelling: false,
      allowFractionalShares: true,
      allowExtendedHours: false,
      allowOptionsTrading: false,
      allowCryptoTrading: false
    }
  }
];

const numericFields = [
  ['maxTradeAmount', 'Max Trade Amount', '$'],
  ['maxPositionSize', 'Max Position Size', '$'],
  ['maxDailyLoss', 'Max Daily Loss', '$'],
  ['maxOpenPositions', 'Max Open Positions', ''],
  ['maxTradesPerDay', 'Max Trades Per Day', ''],
  ['requireManualApprovalAboveDollarAmount', 'Manual Approval Above', '$']
];

const capabilityToggles = [
  ['allowFractionalShares', 'Fractional Shares', 'neutral'],
  ['allowExtendedHours', 'Extended Hours', 'warning'],
  ['allowShortSelling', 'Short Selling', 'warning'],
  ['allowCryptoTrading', 'Crypto Trading', 'warning'],
  ['allowOptionsTrading', 'Options Trading', 'danger']
];

function formatMoney(value) {
  if (value === null || value === undefined || value === '') return '--';
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '--';
  return `$${amount.toFixed(2)}`;
}

function formatNumber(value) {
  if (value === null || value === undefined || value === '') return '--';
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '--';
  return amount.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function formatDateTime(value) {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  return date.toLocaleString();
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

function normalizeStatus(value) {
  return String(value || '').toLowerCase();
}

function statusVariant(value) {
  const status = normalizeStatus(value);
  if (['approved', 'submitted', 'accepted', 'new', 'open'].includes(status)) return 'info';
  if (['filled', 'complete', 'enabled'].includes(status)) return 'success';
  if (['rejected', 'canceled', 'cancelled', 'failed', 'disabled'].includes(status)) return 'danger';
  if (['pending', 'pending_manual_approval', 'pending_submit'].includes(status)) return 'warning';
  return 'neutral';
}

function healthVariant(ok, warning = false) {
  if (ok) return 'success';
  return warning ? 'warning' : 'danger';
}

function formatOrderSummary(order = {}) {
  const size = order.notional
    ? formatMoney(order.notional)
    : (order.qty ? `${formatNumber(order.qty)} sh` : '--');
  return `${String(order.side || '--').toUpperCase()} ${size} ${order.symbol || ''}`.trim();
}

function getFailedChecks(checks = []) {
  return (checks || []).filter(check => check && check.passed === false);
}

function EmptyState({ children }) {
  return (
    <div className="rt-panel-muted px-4 py-6 text-center text-sm text-[#8ba09f]">
      {children}
    </div>
  );
}

function ToggleCard({ label, checked, onChange, tone = 'neutral' }) {
  const toneClass = checked && tone === 'danger'
    ? 'border-[#6a2b3a] bg-[#211116]'
    : checked && tone === 'warning'
      ? 'border-[#6f531d] bg-[#221a0e]'
      : checked
        ? 'border-[#22694a] bg-[#10251c]'
        : '';

  return (
    <label className={`rt-panel flex min-h-[4rem] items-center justify-between gap-3 px-4 py-3 ${toneClass}`}>
      <span className="text-sm font-semibold text-[#d9e5e4]">{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="h-4 w-4 accent-[#26d07c]"
      />
    </label>
  );
}

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
  const [health, setHealth] = useState(null);
  const [reconciliation, setReconciliation] = useState(null);
  const [preview, setPreview] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [decisionDetail, setDecisionDetail] = useState(null);
  const [decisionDetailLoading, setDecisionDetailLoading] = useState(false);

  const loadAll = useCallback(async () => {
    const settingsRes = await axios.get('/api/robotrader/settings');
    const nextSettings = { ...defaultSettings, ...(settingsRes.data?.settings || {}) };
    const environment = nextSettings.mode === 'live' ? 'live' : 'paper';
    setSettings(nextSettings);
    setAllowedSymbolsText(toSymbolText(nextSettings.allowedSymbols));
    setBlockedSymbolsText(toSymbolText(nextSettings.blockedSymbols));

    const [
      decisionsRes,
      ordersRes,
      performanceRes,
      auditRes,
      healthRes,
      reconciliationRes
    ] = await Promise.allSettled([
      axios.get('/api/robotrader/decisions', { params: { limit: 25, environment } }),
      axios.get('/api/robotrader/orders', { params: { limit: 25, environment } }),
      axios.get('/api/robotrader/performance', { params: { environment } }),
      axios.get('/api/robotrader/audit', { params: { limit: 25 } }),
      axios.get('/api/robotrader/health'),
      axios.get('/api/robotrader/reconciliation-status', { params: { environment } })
    ]);

    const failedSections = [];
    const applySettled = (result, label, applyValue) => {
      if (result.status === 'fulfilled') {
        applyValue(result.value.data || {});
        return;
      }
      failedSections.push(label);
    };

    applySettled(decisionsRes, 'decisions', data => setDecisions(data.decisions || []));
    applySettled(ordersRes, 'orders', data => setOrders(data.orders || []));
    applySettled(performanceRes, 'performance', data => setPerformance(data || null));
    applySettled(auditRes, 'audit log', data => setAudit(data.events || []));
    applySettled(healthRes, 'system health', data => setHealth(data || null));
    applySettled(reconciliationRes, 'reconciliation status', data => setReconciliation(data || null));

    if (failedSections.length) {
      setError(`Could not load ${failedSections.join(', ')}. RoboTrader settings are still loaded.`);
    }
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
    () => orders.filter(item => !['pending_submit', 'rejected'].includes(normalizeStatus(item.status))),
    [orders]
  );

  const activeOrders = useMemo(
    () => submittedOrders.filter(item => !['filled', 'canceled', 'cancelled', 'rejected'].includes(normalizeStatus(item.status))),
    [submittedOrders]
  );

  const approvedDecisions = useMemo(
    () => decisions.filter(item => ['approved', 'submitted', 'filled'].includes(normalizeStatus(item.status))),
    [decisions]
  );

  const manualApprovalWarning = useMemo(() => {
    const threshold = Number(settings.requireManualApprovalAboveDollarAmount || 0);
    const maxTradeAmount = Number(settings.maxTradeAmount || 0);
    return threshold > 0 && maxTradeAmount > threshold;
  }, [settings.maxTradeAmount, settings.requireManualApprovalAboveDollarAmount]);

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

  const applyPreset = preset => {
    setSettings(prev => ({
      ...prev,
      ...preset.values,
      isEnabled: prev.isEnabled,
      pausedReason: prev.pausedReason,
      lastRunAt: prev.lastRunAt
    }));

    if (preset.values.allowedSymbols) {
      setAllowedSymbolsText(toSymbolText(preset.values.allowedSymbols));
    }
    if (preset.values.blockedSymbols) {
      setBlockedSymbolsText(toSymbolText(preset.values.blockedSymbols));
    }
    if (preset.values.mode !== 'live') {
      setLiveConfirmation('');
    }
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
    if (!settings.isEnabled) {
      setError('Enable RoboTrader before running a paper test.');
      setSuccess('');
      return;
    }
    if (settings.mode !== 'paper') {
      setError('Run Once Paper is only available while the dashboard is in paper mode.');
      setSuccess('');
      return;
    }

    setRunningNow(true);
    setError('');
    setSuccess('');
    try {
      await axios.put('/api/robotrader/settings', buildSettingsPayload());
      const res = await axios.post('/api/robotrader/run-once-paper');
      await refreshAfterAction(`Paper run completed: ${res.data?.result?.runId || 'run saved'}.`);
    } catch (err) {
      setError(getApiError(err));
    } finally {
      setRunningNow(false);
    }
  };

  const handlePreviewPaper = async () => {
    if (settings.mode !== 'paper') {
      setError('Paper preview is only available while the dashboard is in paper mode.');
      setSuccess('');
      return;
    }

    setPreviewing(true);
    setError('');
    setSuccess('');
    try {
      const payload = buildSettingsPayload();
      const res = await axios.post('/api/robotrader/preview-paper', {
        settings: {
          ...payload,
          mode: 'paper',
          liveTradingExplicitlyEnabled: false
        }
      });
      setPreview(res.data?.preview || null);
      setSuccess(`Paper preview completed: ${res.data?.preview?.runId || 'no trade submitted'}.`);
      await loadAll();
    } catch (err) {
      setError(getApiError(err));
    } finally {
      setPreviewing(false);
    }
  };

  const handleReconcilePaper = async () => {
    setReconciling(true);
    setError('');
    setSuccess('');
    try {
      const res = await axios.post('/api/robotrader/reconcile', { mode: 'paper' });
      await refreshAfterAction(`Paper reconciliation complete: ${res.data?.result?.updatedCount ?? 0} updates, ${res.data?.result?.discrepancyCount ?? 0} discrepancies.`);
    } catch (err) {
      setError(getApiError(err));
    } finally {
      setReconciling(false);
    }
  };

  const handleLoadDecisionDetail = async decisionId => {
    if (!decisionId) return;
    setDecisionDetailLoading(true);
    setError('');
    try {
      const res = await axios.get(`/api/robotrader/decisions/${decisionId}`);
      setDecisionDetail(res.data || null);
    } catch (err) {
      setError(getApiError(err));
    } finally {
      setDecisionDetailLoading(false);
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

  const enabledVariant = settings.isEnabled ? 'success' : 'neutral';
  const modeVariant = settings.mode === 'live' ? 'danger' : 'solid';
  const canRunPaper = settings.isEnabled && settings.mode === 'paper' && !saving && !runningNow;
  const canPreviewPaper = settings.mode === 'paper' && !saving && !previewing;

  return (
    <div className="space-y-6">
      <Card className="p-5 md:p-6" variant="elevated">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
          <div className="rt-page-header max-w-4xl">
            <p className="rt-eyebrow">Automation Console</p>
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="rt-title">RoboTrader</h1>
              <Badge variant={enabledVariant}>{settings.isEnabled ? 'Enabled' : 'Disabled'}</Badge>
              <Badge variant={modeVariant}>{settings.mode === 'live' ? 'Live Mode' : 'Paper Mode'}</Badge>
            </div>
            <p className="rt-subtitle">{RISK_DISCLOSURE}</p>
          </div>

          <div className="grid min-w-full grid-cols-2 gap-3 sm:min-w-[28rem] sm:grid-cols-4 xl:min-w-[34rem]">
            <div className="rt-metric">
              <p className="rt-label">Last Run</p>
              <p className="mt-2 text-sm font-semibold text-[#edf5f4]">
                {formatDateTime(performance?.summary?.lastRunAt || settings.lastRunAt)}
              </p>
            </div>
            <div className="rt-metric">
              <p className="rt-label">Active Orders</p>
              <p className="mt-2 text-2xl font-bold text-[#edf5f4]">{activeOrders.length}</p>
            </div>
            <div className="rt-metric">
              <p className="rt-label">Approved</p>
              <p className="mt-2 text-2xl font-bold text-[#77f0b2]">{approvedDecisions.length}</p>
            </div>
            <div className="rt-metric">
              <p className="rt-label">Rejected</p>
              <p className="mt-2 text-2xl font-bold text-[#ffd77a]">{rejectedDecisions.length}</p>
            </div>
          </div>
        </div>

        {error && (
          <div className="mt-5 rounded-lg border border-[#6a2b3a] bg-[#211116] px-4 py-3 text-sm text-[#ffb5c2]">
            {error}
          </div>
        )}
        {success && (
          <div className="mt-5 rounded-lg border border-[#22694a] bg-[#10251c] px-4 py-3 text-sm text-[#8cf5bd]">
            {success}
          </div>
        )}

        <div className="mt-6 flex flex-wrap gap-2">
          <Button onClick={handleToggleEnabled} disabled={saving} variant={settings.isEnabled ? 'secondary' : 'primary'}>
            {settings.isEnabled ? 'Disable RoboTrader' : 'Enable RoboTrader'}
          </Button>
          <Button variant="secondary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : 'Save Settings'}
          </Button>
          <Button variant="secondary" onClick={handlePreviewPaper} disabled={!canPreviewPaper}>
            {previewing ? 'Previewing...' : 'Preview Paper Run'}
          </Button>
          <Button variant="secondary" onClick={handleRunOnce} disabled={!canRunPaper}>
            {runningNow ? 'Running...' : 'Run Once Paper'}
          </Button>
          <Button variant="danger" onClick={handleEmergencyStop} disabled={stopping}>
            {stopping ? 'Stopping...' : 'Emergency Stop'}
          </Button>
        </div>
      </Card>

      <Card className="p-5 md:p-6">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="rt-eyebrow">System Health</p>
            <h2 className="rt-section-title mt-1">Connections and automation status</h2>
          </div>
          <Badge variant={healthVariant(health?.mongo?.connected && health?.alpaca?.paper?.connected, Boolean(health?.latestError))}>
            {health?.mongo?.connected && health?.alpaca?.paper?.connected ? 'Online' : 'Needs Attention'}
          </Badge>
        </div>

        <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rt-metric">
            <div className="flex items-center justify-between gap-3">
              <p className="rt-label">MongoDB</p>
              <Badge variant={healthVariant(health?.mongo?.connected)}>{health?.mongo?.status || 'unknown'}</Badge>
            </div>
            <p className="mt-2 text-sm text-[#8ba09f]">{health?.mongo?.name || 'No database name returned'}</p>
          </div>
          <div className="rt-metric">
            <div className="flex items-center justify-between gap-3">
              <p className="rt-label">Alpaca Paper</p>
              <Badge variant={healthVariant(health?.alpaca?.paper?.connected && !health?.alpaca?.paper?.tradingBlocked, health?.alpaca?.paper?.connected)}>
                {health?.alpaca?.paper?.connected ? 'Connected' : 'Offline'}
              </Badge>
            </div>
            <p className="mt-2 text-sm text-[#8ba09f]">
              {health?.alpaca?.paper?.connected
                ? `${health.alpaca.paper.accountStatus || 'account'} / ${formatMoney(health.alpaca.paper.buyingPower)} buying power`
                : (health?.alpaca?.paper?.error || 'Paper account not checked')}
            </p>
          </div>
          <div className="rt-metric">
            <div className="flex items-center justify-between gap-3">
              <p className="rt-label">Worker</p>
              <Badge variant={healthVariant(health?.scheduler?.phase1WorkerEnabled, true)}>
                {health?.scheduler?.phase1WorkerEnabled ? 'Enabled' : 'Disabled'}
              </Badge>
            </div>
            <p className="mt-2 text-sm text-[#8ba09f]">Last tick {formatDateTime(health?.scheduler?.lastPhase1WorkerAt || health?.scheduler?.lastTickAt)}</p>
          </div>
          <div className="rt-metric">
            <div className="flex items-center justify-between gap-3">
              <p className="rt-label">Reconciliation</p>
              <Badge variant={healthVariant(!health?.reconciliation?.latestDiscrepancy, Boolean(health?.reconciliation?.latestDiscrepancy))}>
                {health?.reconciliation?.latestDiscrepancy ? 'Discrepancy' : 'Ready'}
              </Badge>
            </div>
            <p className="mt-2 text-sm text-[#8ba09f]">Last check {formatDateTime(health?.reconciliation?.lastReconciledAt)}</p>
          </div>
        </div>

        {health?.latestError && (
          <div className="mt-4 rounded-lg border border-[#6f531d] bg-[#221a0e] px-4 py-3 text-sm text-[#ffd77a]">
            Latest audit issue: {health.latestError.eventType}{health.latestError.message ? ` - ${health.latestError.message}` : ''}
          </div>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.85fr)]">
        <Card className="p-5 md:p-6">
          <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
            <div>
              <p className="rt-eyebrow">Risk Settings</p>
              <h2 className="rt-section-title mt-1">Trading limits and guardrails</h2>
            </div>
            <Badge variant={settings.riskLevel === 'aggressive' ? 'warning' : settings.riskLevel === 'conservative' ? 'success' : 'info'}>
              {settings.riskLevel}
            </Badge>
          </div>

          <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {RISK_PRESETS.map(preset => (
              <button
                key={preset.id}
                type="button"
                onClick={() => applyPreset(preset)}
                className="rt-panel px-4 py-3 text-left transition hover:border-[#26d07c]/70 hover:bg-[#10251c]"
              >
                <span className="block text-sm font-bold text-[#edf5f4]">{preset.label}</span>
                <span className="mt-1 block text-xs text-[#8ba09f]">{preset.meta}</span>
              </button>
            ))}
          </div>

          <div className="mt-4 flex flex-col gap-3 rounded-lg border border-[#28464c] bg-[#0b1517] px-4 py-3 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-sm font-bold text-[#edf5f4]">Safe paper test mode</p>
              <p className="mt-1 text-xs text-[#8ba09f]">Paper only, stocks only, max $100, one position, one trade per day, AAPL/MSFT/SPY universe.</p>
            </div>
            <Button variant="secondary" size="sm" onClick={() => applyPreset(RISK_PRESETS[0])}>
              Apply Safe Test
            </Button>
          </div>

          <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {numericFields.map(([key, label, prefix]) => (
              <label key={key} className="rt-panel p-4">
                <span className="rt-label">{label}</span>
                <div className="mt-2 flex items-center gap-2">
                  {prefix && <span className="text-sm font-semibold text-[#8ba09f]">{prefix}</span>}
                  <input
                    type="number"
                    min="0"
                    value={settings[key] ?? 0}
                    onChange={event => updateSetting(key, Number(event.target.value))}
                    className="rt-field"
                  />
                </div>
              </label>
            ))}

            <label className="rt-panel p-4">
              <span className="rt-label">Risk Level</span>
              <select
                value={settings.riskLevel}
                onChange={event => updateSetting('riskLevel', event.target.value)}
                className="rt-field mt-2"
              >
                <option value="conservative">Conservative</option>
                <option value="balanced">Balanced</option>
                <option value="aggressive">Aggressive</option>
              </select>
            </label>
          </div>

          {manualApprovalWarning && (
            <div className="mt-4 rounded-lg border border-[#6f531d] bg-[#221a0e] px-4 py-3 text-sm text-[#ffd77a]">
              Manual approval is below the max trade amount, so larger automated candidates will be blocked for review.
            </div>
          )}

          <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <label className="rt-panel p-4">
              <span className="rt-label">Allowed Symbols</span>
              <input
                value={allowedSymbolsText}
                onChange={event => setAllowedSymbolsText(event.target.value)}
                placeholder="AAPL, MSFT, SPY"
                className="rt-field mt-2"
              />
            </label>
            <label className="rt-panel p-4">
              <span className="rt-label">Blocked Symbols</span>
              <input
                value={blockedSymbolsText}
                onChange={event => setBlockedSymbolsText(event.target.value)}
                placeholder="TSLA, GME"
                className="rt-field mt-2"
              />
            </label>
          </div>
        </Card>

        <div className="space-y-6">
          <Card className="p-5 md:p-6">
            <p className="rt-eyebrow">Mode</p>
            <h2 className="rt-section-title mt-1">Paper and live trading controls</h2>

            <div className="mt-5 grid grid-cols-2 gap-2 rounded-lg border border-[#26363c] bg-[#0a1012] p-1">
              {['paper', 'live'].map(mode => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => updateSetting('mode', mode)}
                  className={`rounded-md px-3 py-2 text-sm font-bold capitalize transition ${
                    settings.mode === mode
                      ? mode === 'live'
                        ? 'bg-[#3a1620] text-[#ffb5c2]'
                        : 'bg-[#123323] text-[#8cf5bd]'
                      : 'text-[#8ba09f] hover:bg-[#172126] hover:text-[#edf5f4]'
                  }`}
                >
                  {mode}
                </button>
              ))}
            </div>

            <label className="mt-4 flex min-h-[4rem] items-center justify-between gap-4 rounded-lg border border-[#26363c] bg-[#0a1012] px-4 py-3">
              <span>
                <span className="block text-sm font-semibold text-[#edf5f4]">Live trading opt-in</span>
                <span className="block text-xs text-[#8ba09f]">Live mode remains locked unless explicitly confirmed.</span>
              </span>
              <input
                type="checkbox"
                checked={settings.liveTradingExplicitlyEnabled}
                onChange={event => updateSetting('liveTradingExplicitlyEnabled', event.target.checked)}
                disabled={settings.mode !== 'live'}
                className="h-4 w-4 accent-[#ff647c]"
              />
            </label>

            <label className="mt-4 block">
              <span className="rt-label">Live Confirmation</span>
              <input
                value={liveConfirmation}
                onChange={event => setLiveConfirmation(event.target.value)}
                disabled={settings.mode !== 'live'}
                placeholder={LIVE_CONFIRMATION_TEXT}
                className="rt-field mt-2"
              />
            </label>

            {settings.mode === 'live' && (
              <div className="mt-4 rounded-lg border border-[#6a2b3a] bg-[#211116] px-4 py-3 text-sm text-[#ffb5c2]">
                Live mode will not save unless the opt-in box is checked and the confirmation text matches exactly.
              </div>
            )}
          </Card>

          <Card className="p-5 md:p-6">
            <p className="rt-eyebrow">Permissions</p>
            <h2 className="rt-section-title mt-1">Asset classes and execution options</h2>

            <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {['stocks', 'crypto', 'options'].map(assetClass => (
                <ToggleCard
                  key={assetClass}
                  label={assetClass.charAt(0).toUpperCase() + assetClass.slice(1)}
                  checked={(settings.allowedAssetClasses || []).includes(assetClass)}
                  onChange={() => toggleAssetClass(assetClass)}
                  tone={assetClass === 'options' ? 'danger' : assetClass === 'crypto' ? 'warning' : 'neutral'}
                />
              ))}
              {capabilityToggles.map(([key, label, tone]) => (
                <ToggleCard
                  key={key}
                  label={label}
                  checked={Boolean(settings[key])}
                  onChange={event => updateSetting(key, event.target.checked)}
                  tone={tone}
                />
              ))}
            </div>
          </Card>
        </div>
      </div>

      <Card className="p-5 md:p-6">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="rt-eyebrow">Performance</p>
            <h2 className="rt-section-title mt-1">RoboTrader summary</h2>
          </div>
          {performance?.brokerError && <Badge variant="warning">Broker Warning</Badge>}
        </div>

        <div className="mt-5 grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
          <div className="rt-metric">
            <p className="rt-label">Decisions</p>
            <p className="mt-2 text-2xl font-bold">{performance?.summary?.decisions ?? 0}</p>
          </div>
          <div className="rt-metric">
            <p className="rt-label">Submitted</p>
            <p className="mt-2 text-2xl font-bold">{performance?.summary?.submittedOrders ?? 0}</p>
          </div>
          <div className="rt-metric">
            <p className="rt-label">Filled</p>
            <p className="mt-2 text-2xl font-bold text-[#77f0b2]">{performance?.summary?.filledOrders ?? 0}</p>
          </div>
          <div className="rt-metric">
            <p className="rt-label">Rejected</p>
            <p className="mt-2 text-2xl font-bold text-[#ffd77a]">{performance?.summary?.rejectedDecisions ?? 0}</p>
          </div>
          <div className="rt-metric">
            <p className="rt-label">Max Trade</p>
            <p className="mt-2 text-xl font-bold">{formatMoney(settings.maxTradeAmount)}</p>
          </div>
          <div className="rt-metric">
            <p className="rt-label">Daily Loss Cap</p>
            <p className="mt-2 text-xl font-bold">{formatMoney(settings.maxDailyLoss)}</p>
          </div>
        </div>

        {performance?.brokerError && (
          <div className="mt-4 rounded-lg border border-[#6f531d] bg-[#221a0e] px-4 py-3 text-sm text-[#ffd77a]">
            {performance.brokerError}
          </div>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(360px,0.9fr)]">
        <Card className="p-5 md:p-6">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="rt-eyebrow">Paper Preview</p>
              <h2 className="rt-section-title mt-1">Next-run trade preview</h2>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {preview?.generatedAt && <Badge variant="neutral">{formatDateTime(preview.generatedAt)}</Badge>}
              <Button variant="secondary" size="sm" onClick={handlePreviewPaper} disabled={!canPreviewPaper}>
                {previewing ? 'Previewing...' : 'Preview Now'}
              </Button>
            </div>
          </div>

          <div className="mt-5 overflow-x-auto">
            {preview?.decisions?.length ? (
              <table className="rt-table">
                <thead>
                  <tr>
                    <th>Candidate</th>
                    <th>Status</th>
                    <th>Score</th>
                    <th>Order</th>
                    <th>Risk Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.decisions.slice(0, 8).map((item, index) => {
                    const failedChecks = getFailedChecks(item.riskChecks);
                    return (
                      <tr key={`${item.symbol}-${item.strategyId || index}`}>
                        <td>
                          <span className="font-bold text-[#edf5f4]">{item.symbol || '--'}</span>
                          <span className="mt-1 block text-xs text-[#8ba09f]">{item.strategyName || item.strategyId || item.action || '--'}</span>
                        </td>
                        <td>
                          <Badge variant={item.wouldSubmit ? 'success' : statusVariant(item.status)}>
                            {item.wouldSubmit ? 'Would Submit' : (item.status || '--')}
                          </Badge>
                        </td>
                        <td>
                          <span className="block">Conf {item.confidenceScore ?? 0}</span>
                          <span className="block text-xs text-[#8ba09f]">R/R {item.rewardRiskRatio ?? '--'}</span>
                        </td>
                        <td className="text-xs">
                          <span className="block text-[#edf5f4]">{formatOrderSummary({ ...item.recommendedOrder, symbol: item.symbol })}</span>
                          <span className="block text-[#8ba09f]">{item.recommendedOrder?.orderType || '--'} / {item.recommendedOrder?.timeInForce || '--'}</span>
                        </td>
                        <td className="max-w-[20rem] text-xs">
                          {failedChecks.length
                            ? failedChecks.slice(0, 2).map(check => check.message || check.name).join(' | ')
                            : (item.reasoningSummary || 'No failed checks.')}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <EmptyState>Run a paper preview before submitting a paper test order.</EmptyState>
            )}
          </div>
        </Card>

        <Card className="p-5 md:p-6">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="rt-eyebrow">Reconciliation</p>
              <h2 className="rt-section-title mt-1">Broker/local order match</h2>
            </div>
            <Button variant="secondary" size="sm" onClick={handleReconcilePaper} disabled={reconciling}>
              {reconciling ? 'Reconciling...' : 'Reconcile Paper'}
            </Button>
          </div>

          <div className="mt-5 grid grid-cols-2 gap-3">
            <div className="rt-metric">
              <p className="rt-label">Tracked Orders</p>
              <p className="mt-2 text-2xl font-bold text-[#edf5f4]">{reconciliation?.summary?.total ?? 0}</p>
            </div>
            <div className="rt-metric">
              <p className="rt-label">Discrepancies</p>
              <p className="mt-2 text-2xl font-bold text-[#ffd77a]">{reconciliation?.summary?.discrepancies ?? 0}</p>
            </div>
            <div className="rt-metric">
              <p className="rt-label">Pending</p>
              <p className="mt-2 text-2xl font-bold text-[#edf5f4]">{reconciliation?.summary?.pending ?? 0}</p>
            </div>
            <div className="rt-metric">
              <p className="rt-label">Last Check</p>
              <p className="mt-2 text-sm font-semibold text-[#edf5f4]">{formatDateTime(reconciliation?.summary?.lastReconciledAt)}</p>
            </div>
          </div>

          {(reconciliation?.summary?.orphanAlpacaOrders ?? 0) > 0 && (
            <div className="mt-4 rounded-lg border border-[#6f531d] bg-[#221a0e] px-4 py-3 text-sm text-[#ffd77a]">
              {reconciliation.summary.orphanAlpacaOrders} unattributed RoboTrader order{reconciliation.summary.orphanAlpacaOrders === 1 ? '' : 's'} found in Alpaca. Details are withheld until the order can be matched to this account.
            </div>
          )}

          <div className="mt-5 space-y-3">
            {(reconciliation?.orders || []).slice(0, 4).map(order => (
              <div key={order._id} className="rt-panel px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-bold text-[#edf5f4]">{order.symbol || '--'}</p>
                    <p className="text-xs text-[#8ba09f]">{order.clientOrderId || order.externalOrderId || 'No broker id'}</p>
                  </div>
                  <Badge variant={order.discrepancy ? 'warning' : statusVariant(order.reconciliationStatus)}>
                    {order.reconciliationStatus || 'pending'}
                  </Badge>
                </div>
                {order.discrepancy && <p className="mt-2 text-xs text-[#ffd77a]">{order.discrepancy}</p>}
              </div>
            ))}
            {!(reconciliation?.orders || []).length && (
              <EmptyState>No RoboTrader orders to reconcile yet.</EmptyState>
            )}
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Card className="p-5 md:p-6">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="rt-eyebrow">Portfolio</p>
              <h2 className="rt-section-title mt-1">Current positions</h2>
            </div>
            <Badge variant="neutral">{(performance?.positions || []).length} positions</Badge>
          </div>

          <div className="mt-5 overflow-x-auto">
            {(performance?.positions || []).length ? (
              <table className="rt-table">
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th>Qty</th>
                    <th>Market Value</th>
                    <th>Side</th>
                  </tr>
                </thead>
                <tbody>
                  {performance.positions.slice(0, 8).map(position => (
                    <tr key={position.symbol}>
                      <td className="font-bold text-[#edf5f4]">{position.symbol}</td>
                      <td>{formatNumber(position.qty)}</td>
                      <td>{formatMoney(position.market_value)}</td>
                      <td>{position.side || '--'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <EmptyState>No positions returned.</EmptyState>
            )}
          </div>
        </Card>

        <Card className="p-5 md:p-6">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="rt-eyebrow">Orders</p>
              <h2 className="rt-section-title mt-1">Submitted RoboTrader orders</h2>
            </div>
            <Badge variant="neutral">{submittedOrders.length} orders</Badge>
          </div>

          <div className="mt-5 overflow-x-auto">
            {submittedOrders.length ? (
              <table className="rt-table">
                <thead>
                  <tr>
                    <th>Order</th>
                    <th>Status</th>
                    <th>Type</th>
                    <th>Client ID</th>
                  </tr>
                </thead>
                <tbody>
                  {submittedOrders.slice(0, 8).map(order => (
                    <tr key={order._id}>
                      <td>
                        <span className="font-bold text-[#edf5f4]">{order.side?.toUpperCase()} {order.symbol}</span>
                        <span className="mt-1 block text-xs text-[#8ba09f]">{order.assetClass || 'equity'}</span>
                      </td>
                      <td><Badge variant={statusVariant(order.status)}>{order.status || '--'}</Badge></td>
                      <td>{order.orderType || '--'} / {order.timeInForce || '--'}</td>
                      <td className="max-w-[14rem] truncate">{order.clientOrderId || order.externalOrderId || '--'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <EmptyState>No RoboTrader orders submitted yet.</EmptyState>
            )}
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Card className="p-5 md:p-6">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="rt-eyebrow">Decisions</p>
              <h2 className="rt-section-title mt-1">Recent strategy decisions</h2>
            </div>
            <Badge variant="neutral">{decisions.length} total</Badge>
          </div>

          <div className="mt-5 overflow-x-auto">
            {decisions.length ? (
              <table className="rt-table">
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th>Status</th>
                    <th>Score</th>
                    <th>Reason</th>
                    <th>Time</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {decisions.slice(0, 10).map(decision => (
                    <tr key={decision._id}>
                      <td>
                        <span className="font-bold text-[#edf5f4]">{decision.symbol || '--'}</span>
                        <span className="mt-1 block text-xs text-[#8ba09f]">{decision.strategyName || decision.strategyId || '--'}</span>
                      </td>
                      <td><Badge variant={statusVariant(decision.status)}>{decision.status || '--'}</Badge></td>
                      <td>
                        <span className="block">Conf {decision.confidenceScore ?? 0}</span>
                        <span className="block text-xs text-[#8ba09f]">R/R {decision.rewardRiskRatio ?? '--'}</span>
                      </td>
                      <td className="max-w-[22rem] text-xs">{decision.reasoningSummary || '--'}</td>
                      <td className="whitespace-nowrap text-xs">{formatDateTime(decision.decidedAt)}</td>
                      <td>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleLoadDecisionDetail(decision._id)}
                          disabled={decisionDetailLoading}
                        >
                          View
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <EmptyState>No decisions saved yet.</EmptyState>
            )}
          </div>
        </Card>

        <Card className="p-5 md:p-6">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="rt-eyebrow">Risk Gate</p>
              <h2 className="rt-section-title mt-1">Rejected and approval-required trades</h2>
            </div>
            <Badge variant="warning">{rejectedDecisions.length} blocked</Badge>
          </div>

          <div className="mt-5 space-y-3">
            {rejectedDecisions.length ? rejectedDecisions.slice(0, 10).map(decision => (
              <div key={decision._id} className="rt-panel px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-bold text-[#edf5f4]">{decision.symbol || '--'}</p>
                    <p className="text-xs text-[#8ba09f]">{decision.strategyName || decision.strategyId || '--'}</p>
                  </div>
                  <Badge variant={statusVariant(decision.status)}>{decision.status || '--'}</Badge>
                </div>
                <ul className="mt-3 list-disc space-y-1 pl-4 text-xs text-[#c5d3d2]">
                  {(decision.rejectionReasons || ['No rejection reason saved.']).slice(0, 4).map(reason => (
                    <li key={`${decision._id}-${reason}`}>{reason}</li>
                  ))}
                </ul>
              </div>
            )) : (
              <EmptyState>No rejected RoboTrader trades yet.</EmptyState>
            )}
          </div>
        </Card>
      </div>

      {decisionDetail?.decision && (
        <Card className="p-5 md:p-6">
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
              <p className="rt-eyebrow">Decision Detail</p>
              <h2 className="rt-section-title mt-1">
                {decisionDetail.decision.symbol || '--'} / {decisionDetail.decision.strategyName || decisionDetail.decision.strategyId || 'strategy'}
              </h2>
              <p className="mt-2 text-sm text-[#8ba09f]">{decisionDetail.decision.reasoningSummary || 'No reasoning summary saved.'}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={statusVariant(decisionDetail.decision.status)}>{decisionDetail.decision.status || '--'}</Badge>
              <Button variant="ghost" size="sm" onClick={() => setDecisionDetail(null)}>Close</Button>
            </div>
          </div>

          <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className="rt-metric">
              <p className="rt-label">Confidence</p>
              <p className="mt-2 text-2xl font-bold text-[#edf5f4]">{decisionDetail.decision.confidenceScore ?? 0}</p>
            </div>
            <div className="rt-metric">
              <p className="rt-label">Reward/Risk</p>
              <p className="mt-2 text-2xl font-bold text-[#edf5f4]">{decisionDetail.decision.rewardRiskRatio ?? '--'}</p>
            </div>
            <div className="rt-metric">
              <p className="rt-label">Linked Orders</p>
              <p className="mt-2 text-2xl font-bold text-[#edf5f4]">{decisionDetail.orders?.length || 0}</p>
            </div>
          </div>

          <div className="mt-5 grid grid-cols-1 gap-4 xl:grid-cols-2">
            <div className="rt-panel p-4">
              <p className="rt-label">Risk Checks</p>
              <div className="mt-3 space-y-2">
                {(decisionDetail.decision.riskChecks || []).slice(0, 12).map(check => (
                  <div key={`${check.name}-${check.message}`} className="flex items-start justify-between gap-3 text-xs">
                    <span className="text-[#c5d3d2]">{check.name}</span>
                    <span className={check.passed ? 'text-[#8cf5bd]' : 'text-[#ffd77a]'}>
                      {check.passed ? 'passed' : (check.message || 'blocked')}
                    </span>
                  </div>
                ))}
                {!(decisionDetail.decision.riskChecks || []).length && (
                  <p className="text-sm text-[#8ba09f]">No risk checks saved.</p>
                )}
              </div>
            </div>

            <div className="rt-panel p-4">
              <p className="rt-label">Recommended Order</p>
              <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[#080d0f] p-3 text-xs text-[#a9b8b8]">
                {JSON.stringify(decisionDetail.decision.recommendedOrder || {}, null, 2)}
              </pre>
            </div>

            <div className="rt-panel p-4 xl:col-span-2">
              <p className="rt-label">Research Snapshot</p>
              <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[#080d0f] p-3 text-xs text-[#a9b8b8]">
                {JSON.stringify(decisionDetail.decision.researchSnapshot || {}, null, 2)}
              </pre>
            </div>
          </div>
        </Card>
      )}

      <Card className="p-5 md:p-6">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="rt-eyebrow">Audit</p>
            <h2 className="rt-section-title mt-1">Recent RoboTrader events</h2>
          </div>
          <Badge variant="neutral">{audit.length} events</Badge>
        </div>

        <div className="mt-5 space-y-3">
          {audit.length ? audit.map(event => (
            <div key={event._id} className="rt-panel px-4 py-3">
              <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                <p className="text-sm font-bold text-[#edf5f4]">{event.eventType}</p>
                <p className="text-xs text-[#8ba09f]">{formatDateTime(event.createdAt)}</p>
              </div>
              <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[#080d0f] p-3 text-xs text-[#a9b8b8]">
                {JSON.stringify(event.payload || {}, null, 2)}
              </pre>
            </div>
          )) : (
            <EmptyState>No RoboTrader audit entries yet.</EmptyState>
          )}
        </div>
      </Card>
    </div>
  );
}
