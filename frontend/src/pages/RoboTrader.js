import React, { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge from '../components/ui/Badge';
import Skeleton from '../components/ui/Skeleton';
import { getApiError } from '../utils/api';

const LIVE_CONFIRMATION_TEXT = 'I understand live trading risk';
const SPECIFIC_ORDER_CONFIRMATION_TEXT = 'I authorize this specific live order.';
const READINESS_CONFIRMATION_TEXT = 'I completed this readiness check.';
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
  approvalPolicy: {
    mode: 'every_trade',
    thresholdUsd: 0,
    authorizationTtlSeconds: 300,
    requireExactOrderMatch: true
  },
  executionPolicy: {
    maxQuoteAgeSeconds: 15,
    maxSpreadBps: 35,
    minAverageDailyDollarVolume: 20000000,
    maxEstimatedSlippageBps: 25,
    cutoffMinutesBeforeClose: 15,
    regularSessionCutoffEt: '15:45'
  },
  portfolioPolicy: {
    maxGrossExposurePct: 100,
    maxNetExposurePct: 100,
    maxDailyDrawdownPct: 2,
    maxTotalDrawdownPct: 5,
    pauseOnBreach: true
  },
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
      approvalPolicy: { ...defaultSettings.approvalPolicy },
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
      approvalPolicy: { ...defaultSettings.approvalPolicy },
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
      approvalPolicy: { ...defaultSettings.approvalPolicy },
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
      approvalPolicy: { ...defaultSettings.approvalPolicy },
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
  ['maxTradesPerDay', 'Max Trades Per Day', '']
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

function needsBrokerConfirmation(order = {}) {
  const status = normalizeStatus(order.status);
  const reconciliationStatus = normalizeStatus(order.reconciliationStatus);
  return status === 'pending_submit'
    || reconciliationStatus === 'submit_error_pending_reconciliation'
    || reconciliationStatus === 'missing_alpaca_confirmation'
    || reconciliationStatus === 'alpaca_lookup_failed';
}

function statusVariant(value) {
  const status = normalizeStatus(value);
  if (['approved', 'policy_approved', 'authorized', 'submitted', 'accepted', 'new', 'open'].includes(status)) return 'info';
  if (['filled', 'complete', 'enabled'].includes(status)) return 'success';
  if (['rejected', 'canceled', 'cancelled', 'failed', 'disabled'].includes(status)) return 'danger';
  if ([
    'pending',
    'pending_manual_approval',
    'awaiting_authorization',
    'pending_submit',
    'submit_error_pending_reconciliation',
    'missing_alpaca_confirmation',
    'alpaca_lookup_failed'
  ].includes(status)) return 'warning';
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
  const [archivingHistory, setArchivingHistory] = useState(false);
  const [decisionDetail, setDecisionDetail] = useState(null);
  const [decisionDetailLoading, setDecisionDetailLoading] = useState(false);
  const [approvalQueue, setApprovalQueue] = useState([]);
  const [authorizationConfirmation, setAuthorizationConfirmation] = useState('');
  const [approvalActionId, setApprovalActionId] = useState(null);
  const [exposure, setExposure] = useState(null);
  const [readiness, setReadiness] = useState(null);
  const [operationalAlerts, setOperationalAlerts] = useState([]);
  const [liveActivation, setLiveActivation] = useState(null);
  const [livePromotion, setLivePromotion] = useState(null);
  const [supervisorSessionId] = useState(() => (
    window.crypto?.randomUUID?.() || `dashboard-${Date.now()}-${Math.random().toString(36).slice(2)}`
  ));

  const loadAll = useCallback(async () => {
    const settingsRes = await axios.get('/api/robotrader/settings');
    const nextSettings = { ...defaultSettings, ...(settingsRes.data?.settings || {}) };
    const environment = ['live', 'shadow'].includes(nextSettings.mode) ? nextSettings.mode : 'paper';
    setSettings(nextSettings);
    setAllowedSymbolsText(toSymbolText(nextSettings.allowedSymbols));
    setBlockedSymbolsText(toSymbolText(nextSettings.blockedSymbols));

    const [
      decisionsRes,
      ordersRes,
      performanceRes,
      auditRes,
      healthRes,
      reconciliationRes,
      approvalQueueRes,
      exposureRes,
      readinessRes,
      operationalAlertsRes,
      liveActivationRes,
      livePromotionRes
    ] = await Promise.allSettled([
      axios.get('/api/robotrader/decisions', { params: { limit: 25, environment } }),
      axios.get('/api/robotrader/orders', { params: { limit: 25, environment } }),
      axios.get('/api/robotrader/performance', { params: { environment } }),
      axios.get('/api/robotrader/audit', { params: { limit: 25 } }),
      axios.get('/api/robotrader/health'),
      axios.get('/api/robotrader/reconciliation-status', { params: { environment: environment === 'shadow' ? 'paper' : environment } }),
      nextSettings.mode === 'live'
        ? axios.get('/api/robotrader/approval-queue')
        : Promise.resolve({ data: { intents: [] } }),
      axios.get('/api/robotrader/exposure', { params: { environment, limit: 50 } }),
      axios.get('/api/robotrader/readiness'),
      axios.get('/api/robotrader/operational-alerts', { params: { limit: 100 } }),
      axios.get('/api/robotrader/live-activation'),
      axios.get('/api/robotrader/live-promotion')
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
    applySettled(approvalQueueRes, 'approval queue', data => setApprovalQueue(data.intents || []));
    applySettled(exposureRes, 'exposure history', data => setExposure(data || null));
    applySettled(readinessRes, 'readiness assessment', data => setReadiness(data || null));
    applySettled(operationalAlertsRes, 'operational alerts', data => setOperationalAlerts(data.alerts || []));
    applySettled(liveActivationRes, 'controlled-live activation', data => setLiveActivation(data || null));
    applySettled(livePromotionRes, 'live promotion assessment', data => setLivePromotion(data || null));

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

  const pendingBrokerConfirmationOrders = useMemo(
    () => orders.filter(needsBrokerConfirmation),
    [orders]
  );

  const visibleOrders = useMemo(
    () => orders.filter(item => normalizeStatus(item.status) !== 'rejected'),
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
    const mode = settings.approvalPolicy?.mode || 'every_trade';
    const threshold = Number(settings.approvalPolicy?.thresholdUsd || 0);
    const maxTradeAmount = Number(settings.maxTradeAmount || 0);
    return settings.mode === 'live' && (
      mode === 'every_trade'
      || (mode === 'above_threshold' && maxTradeAmount > threshold)
    );
  }, [settings.mode, settings.maxTradeAmount, settings.approvalPolicy]);

  const updateSetting = (key, value) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  };

  const updateApprovalPolicy = (key, value) => {
    setSettings(prev => ({
      ...prev,
      approvalPolicy: {
        ...defaultSettings.approvalPolicy,
        ...(prev.approvalPolicy || {}),
        [key]: value
      }
    }));
  };

  const updateExecutionPolicy = (key, value) => {
    setSettings(prev => ({
      ...prev,
      executionPolicy: {
        ...defaultSettings.executionPolicy,
        ...(prev.executionPolicy || {}),
        [key]: value
      }
    }));
  };

  const updatePortfolioPolicy = (key, value) => {
    setSettings(prev => ({
      ...prev,
      portfolioPolicy: {
        ...defaultSettings.portfolioPolicy,
        ...(prev.portfolioPolicy || {}),
        [key]: value
      }
    }));
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
    approvalPolicy: {
      ...defaultSettings.approvalPolicy,
      ...(settings.approvalPolicy || {})
    },
    executionPolicy: {
      ...defaultSettings.executionPolicy,
      ...(settings.executionPolicy || {})
    },
    portfolioPolicy: {
      ...defaultSettings.portfolioPolicy,
      ...(settings.portfolioPolicy || {})
    },
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

  const handleRunShadow = async () => {
    if (!settings.isEnabled || settings.mode !== 'shadow') {
      setError('Enable RoboTrader in shadow mode before running a shadow-live evaluation.');
      setSuccess('');
      return;
    }
    setRunningNow(true);
    setError('');
    setSuccess('');
    try {
      await axios.put('/api/robotrader/settings', buildSettingsPayload());
      const res = await axios.post('/api/robotrader/run-once-shadow');
      await refreshAfterAction(
        `Shadow run completed: ${res.data?.result?.shadowApprovedCount ?? 0} execution-eligible candidate(s), zero broker submissions.`
      );
    } catch (err) {
      setError(getApiError(err));
    } finally {
      setRunningNow(false);
    }
  };

  const handleAuthorizeIntent = async intent => {
    setApprovalActionId(intent._id);
    setError('');
    setSuccess('');
    try {
      await axios.post(`/api/robotrader/intents/${intent._id}/authorize`, {
        orderFingerprint: intent.orderFingerprint,
        confirmation: authorizationConfirmation
      });
      setAuthorizationConfirmation('');
      await refreshAfterAction(`Authorized the exact ${intent.symbol} intent. Review it once more before submission.`);
    } catch (err) {
      setError(getApiError(err));
    } finally {
      setApprovalActionId(null);
    }
  };

  const handleSubmitIntent = async intent => {
    const confirmed = window.confirm(
      `Submit the exact authorized ${formatOrderSummary(intent)} live order? Current risk, market, quote, liquidity, slippage, exposure, and drawdown gates will run again.`
    );
    if (!confirmed) return;
    setApprovalActionId(intent._id);
    setError('');
    setSuccess('');
    try {
      await axios.post(`/api/robotrader/intents/${intent._id}/submit`);
      await refreshAfterAction(`Submitted the exact authorized ${intent.symbol} intent for broker processing.`);
    } catch (err) {
      setError(getApiError(err));
      await loadAll();
    } finally {
      setApprovalActionId(null);
    }
  };

  const handleRevokeIntent = async intent => {
    setApprovalActionId(intent._id);
    setError('');
    setSuccess('');
    try {
      await axios.post(`/api/robotrader/intents/${intent._id}/revoke`);
      await refreshAfterAction(`Revoked the ${intent.symbol} authorization.`);
    } catch (err) {
      setError(getApiError(err));
    } finally {
      setApprovalActionId(null);
    }
  };

  const handleRecordReadinessEvidence = async requirement => {
    const confirmation = window.prompt(
      `Record "${requirement.label}"? Type exactly:\n${READINESS_CONFIRMATION_TEXT}`
    );
    if (confirmation === null) return;
    if (confirmation !== READINESS_CONFIRMATION_TEXT) {
      setError('The readiness confirmation text did not match exactly.');
      return;
    }
    const notes = window.prompt('Optional evidence reference, ticket, result, or operator notes:') || '';
    setSaving(true);
    setError('');
    try {
      if (requirement.key === 'emergency_stop_drill') {
        const proceed = window.confirm('This drill will actually disable RoboTrader. Continue?');
        if (!proceed) return;
        await axios.post('/api/robotrader/emergency-stop', {
          cancelOpenOrders: false,
          environment: settings.mode === 'live' ? 'live' : 'paper',
          drill: true,
          readinessConfirmation: confirmation,
          notes
        });
      } else {
        await axios.post('/api/robotrader/readiness/evidence', {
          key: requirement.key,
          confirmation,
          notes
        });
      }
      await refreshAfterAction(`${requirement.label} evidence recorded.`);
    } catch (err) {
      setError(getApiError(err));
    } finally {
      setSaving(false);
    }
  };

  const handleOperationalAlert = async (alert, action) => {
    const confirmation = action === 'resolve'
      ? window.prompt('Type exactly to resolve this alert:\nI resolved this operational issue.')
      : undefined;
    if (action === 'resolve' && confirmation !== 'I resolved this operational issue.') return;
    setApprovalActionId(alert._id);
    setError('');
    try {
      await axios.post(`/api/robotrader/operational-alerts/${alert._id}/${action}`, { confirmation });
      await refreshAfterAction(`Operational alert ${action === 'resolve' ? 'resolved' : 'acknowledged'}.`);
    } catch (err) {
      setError(getApiError(err));
    } finally {
      setApprovalActionId(null);
    }
  };

  const handleControlledLiveAction = async action => {
    const confirmations = liveActivation?.confirmations || {};
    const required = confirmations[action];
    const confirmation = window.prompt(`Type exactly to ${action} controlled live:\n${required || ''}`);
    if (!required || confirmation !== required) return;
    setSaving(true);
    setError('');
    try {
      if (action === 'approval') {
        const symbols = window.prompt(
          'Explicit canary symbols (comma separated):',
          (
            livePromotion?.assessment?.dossierCount >= 3
              ? livePromotion?.assessment?.allowedSymbols
              : settings.allowedSymbols
          )?.slice(0, 3).join(',') || 'AAPL'
        );
        if (symbols === null) return;
        await axios.post('/api/robotrader/live-activation/approve', {
          confirmation,
          allowedSymbols: fromSymbolText(symbols),
          limits: {
            maxOrderNotionalUsd: 25,
            maxDailyOrders: 1,
            maxDailyCumulativeNotionalUsd: 25,
            activationHours: 4
          },
          notes: 'Approved from the RoboTrader controlled-live dashboard.'
        });
      } else if (action === 'activation') {
        await axios.post('/api/robotrader/live-activation/activate', { confirmation });
      } else if (action === 'heartbeat') {
        await axios.post('/api/robotrader/live-activation/heartbeat', {
          confirmation,
          sessionId: supervisorSessionId
        });
      } else if (action === 'review') {
        const notes = window.prompt('Canary reconciliation result, broker reference, protection verification, and conclusions:') || '';
        await axios.post('/api/robotrader/live-activation/review', { confirmation, notes });
      } else if (action === 'dossier') {
        await axios.post('/api/robotrader/live-activation/dossier/seal', { confirmation });
      } else {
        const cancelOpenOrders = window.confirm('Revoke, run Emergency Stop, and cancel locally owned open live orders?');
        await axios.post('/api/robotrader/live-activation/revoke', { confirmation, cancelOpenOrders });
      }
      await refreshAfterAction(`Controlled-live ${action} completed.`);
    } catch (err) {
      setError(getApiError(err));
    } finally {
      setSaving(false);
    }
  };

  const handleLivePromotionAction = async action => {
    const required = livePromotion?.confirmations?.[action];
    const confirmation = window.prompt(`Type exactly to ${action} repeat-canary promotion:\n${required || ''}`);
    if (!required || confirmation !== required) return;
    setSaving(true);
    setError('');
    try {
      if (action === 'approval') {
        const notes = window.prompt('Promotion review notes and change-control reference:') || '';
        await axios.post('/api/robotrader/live-promotion/approve', { confirmation, notes });
      } else {
        const cancelOpenOrders = window.confirm('Also run Emergency Stop and cancel locally owned live orders if this promotion already authorized a canary?');
        await axios.post('/api/robotrader/live-promotion/revoke', { confirmation, cancelOpenOrders });
      }
      await refreshAfterAction(`Repeat-canary promotion ${action} completed.`);
    } catch (err) {
      setError(getApiError(err));
    } finally {
      setSaving(false);
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

  const handleArchiveReconciliationHistory = async () => {
    const historicalCount = reconciliation?.historicalSummary?.total || 0;
    if (!historicalCount) return;
    const confirmed = window.confirm(
      `Archive ${historicalCount} terminal historical reconciliation item${historicalCount === 1 ? '' : 's'}? Current/open broker issues will remain visible.`
    );
    if (!confirmed) return;

    setArchivingHistory(true);
    setError('');
    setSuccess('');
    try {
      const environment = settings.mode === 'live' ? 'live' : 'paper';
      const res = await axios.post('/api/robotrader/reconciliation/archive-history', {
        environment,
        reason: 'Archived from RoboTrader dashboard after review.'
      });
      await refreshAfterAction(`Archived ${res.data?.archivedCount ?? 0} historical reconciliation item${res.data?.archivedCount === 1 ? '' : 's'}.`);
    } catch (err) {
      setError(getApiError(err));
    } finally {
      setArchivingHistory(false);
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
    const environment = settings.mode === 'live' ? 'live' : 'paper';
    const shouldStop = window.confirm(
      environment === 'live'
        ? 'Emergency stop will disable RoboTrader immediately. Live RoboTrader orders can be canceled if you confirm the next step.'
        : 'Emergency stop will disable RoboTrader immediately.'
    );
    if (!shouldStop) return;
    const cancelOpenOrders = window.confirm(`Cancel open RoboTrader-created Alpaca ${environment} orders too?`);
    setStopping(true);
    setError('');
    setSuccess('');
    try {
      await axios.post('/api/robotrader/emergency-stop', { cancelOpenOrders, environment });
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
  const modeVariant = settings.mode === 'live' ? 'danger' : settings.mode === 'shadow' ? 'warning' : 'solid';
  const canRunPaper = settings.isEnabled && settings.mode === 'paper' && !saving && !runningNow;
  const canRunShadow = settings.isEnabled && settings.mode === 'shadow' && !saving && !runningNow;
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
              <Badge variant={modeVariant}>
                {settings.mode === 'live' ? 'Live Mode' : settings.mode === 'shadow' ? 'Shadow Live' : 'Paper Mode'}
              </Badge>
            </div>
            <p className="rt-subtitle">{RISK_DISCLOSURE}</p>
          </div>

          <div className="grid min-w-full grid-cols-2 gap-3 sm:min-w-[32rem] sm:grid-cols-3 xl:min-w-[42rem] xl:grid-cols-5">
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
              <p className="rt-label">Pending Broker Confirmation</p>
              <p className="mt-2 text-2xl font-bold text-[#ffd77a]">{pendingBrokerConfirmationOrders.length}</p>
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
          <Button variant="secondary" onClick={handleRunShadow} disabled={!canRunShadow}>
            {runningNow ? 'Running...' : 'Run Once Shadow'}
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

            <label className="rt-panel p-4">
              <span className="rt-label">Live Approval Policy</span>
              <select
                value={settings.approvalPolicy?.mode || 'every_trade'}
                onChange={event => updateApprovalPolicy('mode', event.target.value)}
                className="rt-field mt-2"
              >
                <option value="every_trade">Approve every live trade</option>
                <option value="above_threshold">Approve above threshold</option>
                <option value="autonomous" disabled>Autonomous (API-confirmed)</option>
              </select>
            </label>

            {settings.approvalPolicy?.mode === 'above_threshold' && (
              <label className="rt-panel p-4">
                <span className="rt-label">Approval Threshold</span>
                <div className="mt-2 flex items-center gap-2">
                  <span className="text-sm font-semibold text-[#8ba09f]">$</span>
                  <input
                    type="number"
                    min="0"
                    value={settings.approvalPolicy?.thresholdUsd ?? 0}
                    onChange={event => updateApprovalPolicy('thresholdUsd', Number(event.target.value))}
                    className="rt-field"
                  />
                </div>
              </label>
            )}

            <label className="rt-panel p-4">
              <span className="rt-label">Authorization Lifetime</span>
              <div className="mt-2 flex items-center gap-2">
                <input
                  type="number"
                  min="30"
                  max="3600"
                  value={settings.approvalPolicy?.authorizationTtlSeconds ?? 300}
                  onChange={event => updateApprovalPolicy('authorizationTtlSeconds', Number(event.target.value))}
                  className="rt-field"
                />
                <span className="text-xs font-semibold text-[#8ba09f]">seconds</span>
              </div>
            </label>
          </div>

          {manualApprovalWarning && (
            <div className="mt-4 rounded-lg border border-[#6f531d] bg-[#221a0e] px-4 py-3 text-sm text-[#ffd77a]">
              The live approval policy will hold qualifying candidates until an exact, short-lived order authorization is recorded.
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

            <div className="mt-5 grid grid-cols-3 gap-2 rounded-lg border border-[#26363c] bg-[#0a1012] p-1">
              {['paper', 'shadow', 'live'].map(mode => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => updateSetting('mode', mode)}
                  className={`rounded-md px-3 py-2 text-sm font-bold capitalize transition ${
                    settings.mode === mode
                      ? mode === 'live'
                        ? 'bg-[#3a1620] text-[#ffb5c2]'
                        : mode === 'shadow'
                          ? 'bg-[#3a2a12] text-[#ffd77a]'
                        : 'bg-[#123323] text-[#8cf5bd]'
                      : 'text-[#8ba09f] hover:bg-[#172126] hover:text-[#edf5f4]'
                  }`}
                >
                  {mode === 'shadow' ? 'Shadow' : mode}
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
            {settings.mode === 'shadow' && (
              <div className="mt-4 rounded-lg border border-[#6f531d] bg-[#221a0e] px-4 py-3 text-sm text-[#ffd77a]">
                Shadow mode applies live execution and portfolio gates against the paper account, persists decisions and intents, and never submits an order.
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

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Card className="p-5 md:p-6">
          <p className="rt-eyebrow">Execution Quality</p>
          <h2 className="rt-section-title mt-1">Live and shadow veto thresholds</h2>
          <p className="mt-2 text-sm text-[#8ba09f]">
            New equity entries stop at 3:45 PM ET or the configured interval before the actual exchange close, whichever comes first.
          </p>
          <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {[
              ['maxQuoteAgeSeconds', 'Max Quote Age', 'seconds'],
              ['maxSpreadBps', 'Max Spread', 'bps'],
              ['minAverageDailyDollarVolume', 'Min Daily Dollar Volume', '$'],
              ['maxEstimatedSlippageBps', 'Max Estimated Slippage', 'bps'],
              ['cutoffMinutesBeforeClose', 'Minutes Before Close', 'minutes']
            ].map(([key, label, suffix]) => (
              <label key={key} className="rt-panel p-4">
                <span className="rt-label">{label}</span>
                <div className="mt-2 flex items-center gap-2">
                  {suffix === '$' && <span className="text-sm font-semibold text-[#8ba09f]">$</span>}
                  <input
                    type="number"
                    min="0"
                    value={settings.executionPolicy?.[key] ?? defaultSettings.executionPolicy[key]}
                    onChange={event => updateExecutionPolicy(key, Number(event.target.value))}
                    className="rt-field"
                  />
                  {suffix !== '$' && <span className="text-xs font-semibold text-[#8ba09f]">{suffix}</span>}
                </div>
              </label>
            ))}
            <div className="rt-panel p-4">
              <span className="rt-label">Regular Cutoff</span>
              <p className="mt-2 text-xl font-bold text-[#edf5f4]">3:45 PM ET</p>
              <p className="mt-1 text-xs text-[#8ba09f]">Fixed safety boundary</p>
            </div>
          </div>
        </Card>

        <Card className="p-5 md:p-6">
          <p className="rt-eyebrow">Portfolio Risk</p>
          <h2 className="rt-section-title mt-1">Exposure and drawdown orchestration</h2>
          <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {[
              ['maxGrossExposurePct', 'Max Gross Exposure', '%'],
              ['maxNetExposurePct', 'Max Absolute Net Exposure', '%'],
              ['maxDailyDrawdownPct', 'Max Daily Drawdown', '%'],
              ['maxTotalDrawdownPct', 'Max Peak Drawdown', '%']
            ].map(([key, label, suffix]) => (
              <label key={key} className="rt-panel p-4">
                <span className="rt-label">{label}</span>
                <div className="mt-2 flex items-center gap-2">
                  <input
                    type="number"
                    min="0"
                    step="0.1"
                    value={settings.portfolioPolicy?.[key] ?? defaultSettings.portfolioPolicy[key]}
                    onChange={event => updatePortfolioPolicy(key, Number(event.target.value))}
                    className="rt-field"
                  />
                  <span className="text-xs font-semibold text-[#8ba09f]">{suffix}</span>
                </div>
              </label>
            ))}
          </div>
          <label className="mt-4 flex items-center justify-between gap-4 rounded-lg border border-[#26363c] bg-[#0a1012] px-4 py-3">
            <span>
              <span className="block text-sm font-semibold text-[#edf5f4]">Pause on portfolio breach</span>
              <span className="block text-xs text-[#8ba09f]">Disables shadow/live automation when any exposure or drawdown limit fails.</span>
            </span>
            <input
              type="checkbox"
              checked={settings.portfolioPolicy?.pauseOnBreach !== false}
              onChange={event => updatePortfolioPolicy('pauseOnBreach', event.target.checked)}
              className="h-4 w-4 accent-[#26d07c]"
            />
          </label>
        </Card>
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

      <Card className="p-5 md:p-6">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="rt-eyebrow">Exposure Monitor</p>
            <h2 className="rt-section-title mt-1">Latest portfolio risk snapshot</h2>
          </div>
          <Badge variant={exposure?.latest?.breached ? 'danger' : exposure?.latest ? 'success' : 'neutral'}>
            {exposure?.latest?.breached ? 'Limits Breached' : exposure?.latest ? 'Within Limits' : 'No Snapshot'}
          </Badge>
        </div>
        <div className="mt-5 grid grid-cols-2 gap-4 md:grid-cols-5 xl:grid-cols-10">
          {[
            ['Equity', formatMoney(exposure?.latest?.equity)],
            ['Gross Exposure', formatMoney(exposure?.latest?.grossExposure)],
            ['Reserved Working', formatMoney(exposure?.latest?.reservedGrossExposure)],
            ['Gross %', `${formatNumber(exposure?.latest?.grossExposurePct)}%`],
            ['Net Exposure', formatMoney(exposure?.latest?.netExposure)],
            ['Net %', `${formatNumber(exposure?.latest?.netExposurePct)}%`],
            ['Daily Drawdown', `${formatNumber(exposure?.latest?.dailyDrawdownPct)}%`],
            ['Peak Drawdown', `${formatNumber(exposure?.latest?.totalDrawdownPct)}%`],
            ['Positions', exposure?.latest?.positionCount ?? 0],
            ['Working Orders', exposure?.latest?.workingOrderCount ?? 0]
          ].map(([label, value]) => (
            <div key={label} className="rt-metric">
              <p className="rt-label">{label}</p>
              <p className="mt-2 text-lg font-bold text-[#edf5f4]">{value}</p>
            </div>
          ))}
        </div>
        {exposure?.latest?.breached && (
          <div className="mt-4 rounded-lg border border-[#6a2b3a] bg-[#211116] px-4 py-3 text-sm text-[#ffb5c2]">
            {(exposure.latest.checks || []).filter(check => !check.passed).map(check => check.message).join(' ')}
          </div>
        )}
        <p className="mt-3 text-xs text-[#8ba09f]">Captured {formatDateTime(exposure?.latest?.capturedAt)}</p>
      </Card>

      <Card className="p-5 md:p-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="rt-eyebrow">Sprint 3 Operations</p>
            <h2 className="rt-section-title mt-1">Controlled-live readiness evidence</h2>
            <p className="mt-2 text-sm text-[#8ba09f]">
              Readiness is calculated from sustained shadow evidence, unresolved incidents, reconciliation state, and expiring operator checks. It does not enable live trading.
            </p>
          </div>
          <Badge variant={readiness?.technicalReady ? 'success' : 'warning'}>
            {readiness?.technicalReady ? 'Ready for Go/No-Go' : 'Not Ready'}
          </Badge>
        </div>

        <div className="mt-5 grid grid-cols-1 gap-3 lg:grid-cols-2">
          {(readiness?.gates || []).map(gate => (
            <div key={gate.key} className="rt-panel flex items-start justify-between gap-4 p-4">
              <div>
                <p className="text-sm font-bold text-[#edf5f4]">{gate.label}</p>
                <p className="mt-1 text-xs text-[#8ba09f]">{gate.detail}</p>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-2">
                <Badge variant={gate.passed ? 'success' : 'warning'}>{gate.passed ? 'Pass' : 'Pending'}</Badge>
                {!gate.passed && (readiness?.requiredEvidence || []).some(item => item.key === gate.key) && (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={saving}
                    onClick={() => handleRecordReadinessEvidence(
                      readiness.requiredEvidence.find(item => item.key === gate.key)
                    )}
                  >
                    Record Evidence
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-5 flex flex-wrap gap-2 text-xs text-[#8ba09f]">
          <span>Shadow runs: {readiness?.observation?.runs ?? 0}/{readiness?.observation?.minShadowRuns ?? 20}</span>
          <span>·</span>
          <span>Observed days: {readiness?.observation?.distinctDays ?? 0}/{readiness?.observation?.minShadowDays ?? 7}</span>
          <span>·</span>
          <span>Live deployment flag: {readiness?.safeguards?.deploymentLiveFlag ? 'enabled' : 'disabled'}</span>
          <span>·</span>
          <span>Explicit live credentials: {readiness?.safeguards?.liveCredentialsConfigured ? 'present' : 'absent'}</span>
        </div>

        <div className="mt-6 border-t border-[#28464c] pt-5">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-bold text-[#edf5f4]">Operational alerts</h3>
            <Badge variant={operationalAlerts.some(item => item.status !== 'resolved') ? 'danger' : 'success'}>
              {operationalAlerts.filter(item => item.status !== 'resolved').length} active
            </Badge>
          </div>
          <div className="mt-3 space-y-3">
            {operationalAlerts.filter(item => item.status !== 'resolved').slice(0, 10).map(alert => (
              <div key={alert._id} className="rt-panel flex flex-col justify-between gap-3 p-4 md:flex-row md:items-center">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={alert.severity === 'critical' ? 'danger' : 'warning'}>{alert.severity}</Badge>
                    <Badge variant="neutral">{alert.status}</Badge>
                    <span className="text-sm font-bold text-[#edf5f4]">{alert.category}</span>
                  </div>
                  <p className="mt-2 text-sm text-[#c8d5d4]">{alert.message}</p>
                  <p className="mt-1 text-xs text-[#8ba09f]">Last seen {formatDateTime(alert.lastOccurredAt)} · {alert.occurrences} occurrence(s)</p>
                </div>
                <div className="flex gap-2">
                  {alert.status === 'open' && (
                    <Button variant="secondary" size="sm" onClick={() => handleOperationalAlert(alert, 'acknowledge')}>Acknowledge</Button>
                  )}
                  <Button variant="danger" size="sm" onClick={() => handleOperationalAlert(alert, 'resolve')}>Resolve</Button>
                </div>
              </div>
            ))}
            {!operationalAlerts.some(item => item.status !== 'resolved') && <EmptyState>No active operational alerts.</EmptyState>}
          </div>
        </div>
      </Card>

      <Card className="p-5 md:p-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="rt-eyebrow">Sprint 6 Continuous Assurance</p>
            <h2 className="rt-section-title mt-1">Controlled-live canary activation</h2>
            <p className="mt-2 text-sm text-[#8ba09f]">
              Approval remains readiness-bound and single-use. While active, the supervisor must explicitly refresh a five-minute heartbeat; loss of supervision revokes the activation and disables automation. Reviewed evidence can then be sealed as a durable SHA-256 dossier.
            </p>
          </div>
          <Badge variant={liveActivation?.activation?.status === 'active' ? 'danger' : 'neutral'}>
            {liveActivation?.activation?.status || 'inactive'}
          </Badge>
        </div>
        <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4">
          <div className="rt-metric"><p className="rt-label">Per Order Hard Max</p><p className="mt-2 font-bold text-[#edf5f4]">{formatMoney(liveActivation?.hardLimits?.maxOrderNotionalUsd)}</p></div>
          <div className="rt-metric"><p className="rt-label">Daily Orders Hard Max</p><p className="mt-2 font-bold text-[#edf5f4]">{liveActivation?.hardLimits?.maxDailyOrders ?? '--'}</p></div>
          <div className="rt-metric"><p className="rt-label">Daily Notional Hard Max</p><p className="mt-2 font-bold text-[#edf5f4]">{formatMoney(liveActivation?.hardLimits?.maxDailyCumulativeNotionalUsd)}</p></div>
          <div className="rt-metric"><p className="rt-label">Activation Hard Max</p><p className="mt-2 font-bold text-[#edf5f4]">{liveActivation?.hardLimits?.maxActivationHours ?? '--'}h</p></div>
        </div>
        {liveActivation?.activation && (
          <div className="mt-4 rounded-lg border border-[#28464c] bg-[#0b1517] px-4 py-3 text-sm text-[#c8d5d4]">
            Symbols: {(liveActivation.activation.allowedSymbols || []).join(', ') || '--'} · Per order {formatMoney(liveActivation.activation.limits?.maxOrderNotionalUsd)} · Daily {liveActivation.activation.limits?.maxDailyOrders} order(s) / {formatMoney(liveActivation.activation.limits?.maxDailyCumulativeNotionalUsd)} · Attempt slot {liveActivation.activation.attemptsUsed || 0}/1 · Lifecycle {liveActivation.activation.lifecycleStatus || 'armed'} · Expires {formatDateTime(liveActivation.activation.activationExpiresAt || liveActivation.activation.approvalExpiresAt)} · Supervision deadline {formatDateTime(liveActivation.activation.supervisionDeadlineAt)} · Dossier {liveActivation.activation.dossierHash ? liveActivation.activation.dossierHash.slice(0, 12) + '…' : 'not sealed'}
          </div>
        )}
        <div className="mt-5 flex flex-wrap gap-2">
          <Button
            variant="secondary"
            disabled={saving || !readiness?.technicalReady || liveActivation?.activation?.status === 'active'}
            onClick={() => handleControlledLiveAction('approval')}
          >
            Approve Canary Snapshot
          </Button>
          <Button
            variant="danger"
            disabled={saving || liveActivation?.activation?.status !== 'approved'}
            onClick={() => handleControlledLiveAction('activation')}
          >
            Activate Canary
          </Button>
          <Button
            variant="danger"
            disabled={saving || !['approved', 'active'].includes(liveActivation?.activation?.status)}
            onClick={() => handleControlledLiveAction('revocation')}
          >
            Revoke + Emergency Stop
          </Button>
          <Button
            variant="danger"
            disabled={saving || liveActivation?.activation?.status !== 'active'}
            onClick={() => handleControlledLiveAction('heartbeat')}
          >
            Refresh Supervisor Heartbeat
          </Button>
          <Button
            variant="secondary"
            disabled={saving || !['filled', 'reconciled', 'failed'].includes(liveActivation?.activation?.lifecycleStatus)}
            onClick={() => handleControlledLiveAction('review')}
          >
            Record Post-Canary Review
          </Button>
          <Button
            variant="secondary"
            disabled={saving || liveActivation?.activation?.lifecycleStatus !== 'reviewed' || Boolean(liveActivation?.activation?.dossierHash)}
            onClick={() => handleControlledLiveAction('dossier')}
          >
            Seal Evidence Dossier
          </Button>
        </div>
        {!readiness?.technicalReady && (
          <p className="mt-3 text-xs text-[#ffd77a]">Sprint 3 readiness is not complete, so controlled-live approval remains locked.</p>
        )}
      </Card>

      <Card className="p-5 md:p-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="rt-eyebrow">Sprint 7 Promotion Governance</p>
            <h2 className="rt-section-title mt-1">Evidence-based repeat canary</h2>
            <p className="mt-2 text-sm text-[#8ba09f]">
              After the first three sealed canaries, another approval requires a verified three-day cohort, a 24-hour cooling period, unchanged readiness, one strategy and policy version, successful reconciliation, protection evidence, clear exposure, and no unresolved critical alert. Promotion is single-use and does not increase any hard limit.
            </p>
          </div>
          <Badge variant={livePromotion?.assessment?.eligible ? 'success' : 'neutral'}>
            {livePromotion?.promotion?.status || (livePromotion?.assessment?.eligible ? 'eligible' : 'not eligible')}
          </Badge>
        </div>
        <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4">
          <div className="rt-metric"><p className="rt-label">Sealed Cohort</p><p className="mt-2 font-bold text-[#edf5f4]">{livePromotion?.assessment?.dossierCount ?? 0}/{livePromotion?.requirements?.minimumDossiers ?? 3}</p></div>
          <div className="rt-metric"><p className="rt-label">Distinct UTC Days</p><p className="mt-2 font-bold text-[#edf5f4]">{livePromotion?.assessment?.distinctDays ?? 0}/{livePromotion?.requirements?.minimumDistinctDays ?? 3}</p></div>
          <div className="rt-metric"><p className="rt-label">Cooling Period</p><p className="mt-2 font-bold text-[#edf5f4]">{livePromotion?.requirements?.cooldownHours ?? 24}h</p></div>
          <div className="rt-metric"><p className="rt-label">Allowed Symbols</p><p className="mt-2 font-bold text-[#edf5f4]">{(livePromotion?.assessment?.allowedSymbols || []).join(', ') || '--'}</p></div>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-2 md:grid-cols-2">
          {(livePromotion?.assessment?.gates || []).map(item => (
            <div key={item.key} className="flex items-start justify-between gap-3 rounded-lg border border-[#28464c] bg-[#0b1517] px-4 py-3">
              <div>
                <p className="text-sm font-semibold text-[#edf5f4]">{item.label}</p>
                <p className="mt-1 text-xs text-[#8ba09f]">{item.detail}</p>
              </div>
              <Badge variant={item.passed ? 'success' : 'neutral'}>{item.passed ? 'pass' : 'blocked'}</Badge>
            </div>
          ))}
        </div>
        {livePromotion?.assessment?.strategyEvidence && (
          <div className="mt-5 rounded-lg border border-[#315f99] bg-[#0d1825] p-4">
            <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
              <div>
                <p className="rt-eyebrow">Sprint 8 Strategy Evidence</p>
                <p className="mt-1 text-sm font-bold text-[#edf5f4]">Parameter-bound validation and execution drift</p>
                <p className="mt-1 text-xs text-[#8ba09f]">
                  Parameter version {livePromotion.assessment.strategyEvidence.parameterVersionId || '--'} · Mean adverse slippage {livePromotion.assessment.strategyEvidence.meanSlippageBps ?? '--'} bps · Evidence expires {formatDateTime(livePromotion.assessment.strategyEvidence.expiresAt)}
                </p>
              </div>
              <Badge variant={livePromotion.assessment.strategyEvidence.passed ? 'success' : 'warning'}>
                {livePromotion.assessment.strategyEvidence.passed ? 'validated' : 'blocked'}
              </Badge>
            </div>
            <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
              {(livePromotion.assessment.strategyEvidence.gates || []).map(item => (
                <div key={item.key} className="rounded-md border border-[#263e5b] bg-[#0a1012] px-3 py-2">
                  <p className="text-xs font-semibold text-[#edf5f4]">{item.key.replaceAll('_', ' ')}</p>
                  <p className="mt-1 text-xs text-[#8ba09f]">{item.detail}</p>
                </div>
              ))}
            </div>
          </div>
        )}
        {livePromotion?.assessment?.executionDiscrepancy && (
          <div className="mt-5 rounded-lg border border-[#6f531d] bg-[#221a0e] p-4">
            <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
              <div>
                <p className="rt-eyebrow">Paper versus live integration</p>
                <p className="mt-1 text-sm font-bold text-[#edf5f4]">Execution discrepancy report</p>
                <p className="mt-1 text-xs text-[#8ba09f]">
                  Paper mean {livePromotion.assessment.executionDiscrepancy.paperMeanSlippageBps ?? '--'} bps · Live mean {livePromotion.assessment.executionDiscrepancy.liveMeanSlippageBps ?? '--'} bps · Degradation {livePromotion.assessment.executionDiscrepancy.slippageDegradationBps ?? '--'} bps · Paper rejects {livePromotion.assessment.executionDiscrepancy.paperRejectionRatePct ?? '--'}%
                </p>
              </div>
              <Badge variant={livePromotion.assessment.executionDiscrepancy.passed ? 'success' : 'warning'}>
                {livePromotion.assessment.executionDiscrepancy.passed ? 'aligned' : 'blocked'}
              </Badge>
            </div>
            <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
              {(livePromotion.assessment.executionDiscrepancy.gates || []).map(item => (
                <div key={item.key} className="rounded-md border border-[#6f531d] bg-[#0a1012] px-3 py-2">
                  <p className="text-xs font-semibold text-[#edf5f4]">{item.key.replaceAll('_', ' ')}</p>
                  <p className="mt-1 text-xs text-[#8ba09f]">{item.detail}</p>
                </div>
              ))}
            </div>
          </div>
        )}
        {livePromotion?.assessment?.cooldownEndsAt && (
          <p className="mt-3 text-xs text-[#8ba09f]">Cooling period ends {formatDateTime(livePromotion.assessment.cooldownEndsAt)}.</p>
        )}
        <div className="mt-5 flex flex-wrap gap-2">
          <Button
            variant="secondary"
            disabled={saving || !livePromotion?.assessment?.eligible || Boolean(livePromotion?.promotion)}
            onClick={() => handleLivePromotionAction('approval')}
          >
            Approve One Repeat Canary
          </Button>
          <Button
            variant="danger"
            disabled={saving || !['approved', 'consumed'].includes(livePromotion?.promotion?.status)}
            onClick={() => handleLivePromotionAction('revocation')}
          >
            Revoke Promotion + Roll Back
          </Button>
        </div>
        <p className="mt-3 text-xs text-[#ffd77a]">Promotion never changes the $100 hard maximum, the one-order daily maximum, the one-attempt activation rule, the five-minute heartbeat, or exact-order authorization.</p>
      </Card>

      {settings.mode === 'live' && (
        <Card className="p-5 md:p-6">
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
              <p className="rt-eyebrow">Approval Queue</p>
              <h2 className="rt-section-title mt-1">Exact live order authorizations</h2>
              <p className="mt-2 text-sm text-[#8ba09f]">
                Authorization and submission are separate. Submission reruns every market, execution-quality, exposure, drawdown, and canonical policy check.
              </p>
            </div>
            <Badge variant={approvalQueue.length ? 'warning' : 'neutral'}>{approvalQueue.length} pending</Badge>
          </div>

          <label className="mt-5 block max-w-2xl">
            <span className="rt-label">Specific-order confirmation</span>
            <input
              value={authorizationConfirmation}
              onChange={event => setAuthorizationConfirmation(event.target.value)}
              placeholder={SPECIFIC_ORDER_CONFIRMATION_TEXT}
              className="rt-field mt-2"
            />
          </label>

          <div className="mt-5 space-y-4">
            {approvalQueue.length ? approvalQueue.map(intent => {
              const busy = approvalActionId === intent._id;
              const authorized = intent.status === 'authorized' && intent.authorizationStatus === 'active';
              const failedExecutionChecks = getFailedChecks(intent.executionQuality?.checks);
              return (
                <div key={intent._id} className="rt-panel p-4">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-bold text-[#edf5f4]">{formatOrderSummary(intent)}</p>
                        <Badge variant={statusVariant(intent.status)}>{intent.status}</Badge>
                        <Badge variant={intent.authorizationStatus === 'active' ? 'success' : 'warning'}>
                          {intent.authorizationStatus}
                        </Badge>
                      </div>
                      <p className="mt-2 break-all text-xs text-[#8ba09f]">Fingerprint {intent.orderFingerprint}</p>
                      <p className="mt-1 text-xs text-[#8ba09f]">
                        Policy {intent.policyVersion} · requested {formatDateTime(intent.requestedAt)}
                      </p>
                      {intent.authorizationExpiresAt && (
                        <p className="mt-1 text-xs text-[#ffd77a]">Authorization expires {formatDateTime(intent.authorizationExpiresAt)}</p>
                      )}
                      {failedExecutionChecks.length > 0 && (
                        <p className="mt-2 text-xs text-[#ffd77a]">
                          Last execution veto: {failedExecutionChecks.map(check => check.message).join(' ')}
                        </p>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {!authorized && (
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={busy || authorizationConfirmation !== SPECIFIC_ORDER_CONFIRMATION_TEXT}
                          onClick={() => handleAuthorizeIntent(intent)}
                        >
                          {busy ? 'Authorizing...' : 'Authorize Exact Order'}
                        </Button>
                      )}
                      {authorized && (
                        <>
                          <Button size="sm" disabled={busy} onClick={() => handleSubmitIntent(intent)}>
                            {busy ? 'Working...' : 'Revalidate & Submit'}
                          </Button>
                          <Button variant="danger" size="sm" disabled={busy} onClick={() => handleRevokeIntent(intent)}>
                            Revoke
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              );
            }) : (
              <EmptyState>No live order intents are waiting for authorization.</EmptyState>
            )}
          </div>
        </Card>
      )}

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
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={handleReconcilePaper} disabled={reconciling}>
                {reconciling ? 'Reconciling...' : 'Reconcile Paper'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleArchiveReconciliationHistory}
                disabled={archivingHistory || !(reconciliation?.historicalSummary?.total > 0)}
              >
                {archivingHistory ? 'Archiving...' : 'Archive History'}
              </Button>
            </div>
          </div>

          <div className="mt-5 grid grid-cols-2 gap-3">
            <div className="rt-metric">
              <p className="rt-label">Current Tracked</p>
              <p className="mt-2 text-2xl font-bold text-[#edf5f4]">{reconciliation?.summary?.total ?? 0}</p>
            </div>
            <div className="rt-metric">
              <p className="rt-label">Current Issues</p>
              <p className="mt-2 text-2xl font-bold text-[#ffd77a]">{reconciliation?.summary?.discrepancies ?? 0}</p>
            </div>
            <div className="rt-metric">
              <p className="rt-label">Pending Broker</p>
              <p className="mt-2 text-2xl font-bold text-[#edf5f4]">{reconciliation?.summary?.pending ?? 0}</p>
            </div>
            <div className="rt-metric">
              <p className="rt-label">Last Check</p>
              <p className="mt-2 text-sm font-semibold text-[#edf5f4]">{formatDateTime(reconciliation?.summary?.lastReconciledAt)}</p>
            </div>
          </div>

          {(reconciliation?.summary?.discrepancies ?? 0) > 0 ? (
            <div className="mt-4 rounded-lg border border-[#6f531d] bg-[#221a0e] px-4 py-3 text-sm text-[#ffd77a]">
              Current broker/local discrepancies need review before they are archived.
            </div>
          ) : (
            <div className="mt-4 rounded-lg border border-[#22694a] bg-[#10251c] px-4 py-3 text-sm text-[#8cf5bd]">
              No current actionable reconciliation issues are visible.
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
              <EmptyState>No current RoboTrader orders need reconciliation.</EmptyState>
            )}
          </div>

          <div className="mt-5 rounded-lg border border-[#26363c] bg-[#0a1012] p-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div>
                <p className="rt-label">Historical Discrepancies</p>
                <p className="mt-1 text-sm text-[#8ba09f]">
                  Terminal rejected/orphaned records are kept for audit, but can be archived so they no longer look like live broker problems.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge variant={reconciliation?.historicalSummary?.total ? 'warning' : 'neutral'}>
                  {reconciliation?.historicalSummary?.total ?? 0} unarchived
                </Badge>
                <Badge variant="neutral">
                  {reconciliation?.historicalSummary?.archived ?? 0} archived
                </Badge>
              </div>
            </div>

            {(reconciliation?.historicalSummary?.orphanAlpacaOrders ?? 0) > 0 && (
              <div className="mt-4 rounded-lg border border-[#6f531d] bg-[#221a0e] px-4 py-3 text-sm text-[#ffd77a]">
                {reconciliation.historicalSummary.orphanAlpacaOrders} historical unattributed RoboTrader order{reconciliation.historicalSummary.orphanAlpacaOrders === 1 ? '' : 's'} found in Alpaca. Details remain withheld until matched to this account.
              </div>
            )}

            <div className="mt-4 space-y-3">
              {(reconciliation?.historicalDiscrepancies || []).slice(0, 4).map(order => (
                <div key={order._id} className="rt-panel px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-bold text-[#edf5f4]">{order.symbol || '--'}</p>
                      <p className="text-xs text-[#8ba09f]">{order.clientOrderId || order.externalOrderId || 'No broker id'}</p>
                    </div>
                    <Badge variant="warning">{order.reconciliationStatus || order.status || 'historical'}</Badge>
                  </div>
                  {order.discrepancy && <p className="mt-2 text-xs text-[#ffd77a]">{order.discrepancy}</p>}
                  <p className="mt-2 text-[11px] text-[#6f8180]">Created {formatDateTime(order.createdAt)}</p>
                </div>
              ))}
              {!(reconciliation?.historicalDiscrepancies || []).length && (
                <EmptyState>No unarchived historical reconciliation discrepancies.</EmptyState>
              )}
            </div>
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
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="rt-eyebrow">Orders</p>
              <h2 className="rt-section-title mt-1">RoboTrader orders</h2>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge variant="neutral">{visibleOrders.length} orders</Badge>
              <Badge variant={pendingBrokerConfirmationOrders.length ? 'warning' : 'neutral'}>
                {pendingBrokerConfirmationOrders.length} pending broker confirmation
              </Badge>
            </div>
          </div>

          <div className="mt-5 overflow-x-auto">
            {visibleOrders.length ? (
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
                  {visibleOrders.slice(0, 8).map(order => (
                    <tr key={order._id}>
                      <td>
                        <span className="font-bold text-[#edf5f4]">{order.side?.toUpperCase()} {order.symbol}</span>
                        <span className="mt-1 block text-xs text-[#8ba09f]">{order.assetClass || 'equity'}</span>
                      </td>
                      <td>
                        <div className="flex flex-col items-start gap-1">
                          <Badge variant={statusVariant(order.status)}>{order.status || '--'}</Badge>
                          {needsBrokerConfirmation(order) && (
                            <Badge variant="warning">Broker confirmation pending</Badge>
                          )}
                        </div>
                      </td>
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
