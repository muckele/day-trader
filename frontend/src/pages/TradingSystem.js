import React, { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import Card from '../components/ui/Card';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import Skeleton from '../components/ui/Skeleton';
import { getApiError } from '../utils/api';

function formatDateTime(value) {
  if (!value) return '--';
  return new Date(value).toLocaleString();
}

function formatNumber(value, digits = 2) {
  if (value === null || value === undefined || value === '') return '--';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '--';
  return numeric.toFixed(digits);
}

function formatPercent(value) {
  if (value === null || value === undefined || value === '') return '--';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '--';
  return `${numeric.toFixed(2)}%`;
}

function formatDuration(value) {
  if (value === null || value === undefined || value === '') return '--';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '--';
  if (numeric < 1000) return `${Math.round(numeric)} ms`;
  return `${(numeric / 1000).toFixed(2)} s`;
}

function formatFlagLabel(key) {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, char => char.toUpperCase());
}

function getStatusVariant(status) {
  if (status === 'completed' || status === 'connected' || status === 'validated' || status === 'filled') return 'success';
  if (status === 'failed' || status === 'rejected' || status === 'disconnected') return 'danger';
  if (status === 'running' || status === 'connecting') return 'solid';
  return 'warning';
}

export default function TradingSystem() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [status, setStatus] = useState(null);
  const [strategyRuns, setStrategyRuns] = useState([]);
  const [parameterVersions, setParameterVersions] = useState([]);
  const [execution, setExecution] = useState({ orders: [], fills: [], summary: null });
  const [evidence, setEvidence] = useState({
    strategyScorecards: [],
    exposure: { summary: {}, series: [] },
    blotter: { summary: {}, rows: [] },
    paperCoverage: [],
    completeness: { complete: false, collections: {} }
  });

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [statusRes, runsRes, paramsRes, executionRes, evidenceRes] = await Promise.all([
        axios.get('/api/trading-system/status'),
        axios.get('/api/trading-system/strategy-runs', { params: { limit: 12 } }),
        axios.get('/api/trading-system/strategy-parameters', { params: { limit: 12 } }),
        axios.get('/api/trading-system/execution', { params: { limit: 12 } }),
        axios.get('/api/trading-system/operational-evidence', { params: { days: 90, limit: 200 } })
      ]);
      setStatus(statusRes.data || null);
      setStrategyRuns(runsRes.data?.items || []);
      setParameterVersions(paramsRes.data?.items || []);
      setExecution({
        orders: executionRes.data?.orders || [],
        fills: executionRes.data?.fills || [],
        summary: executionRes.data?.summary || null,
        warning: executionRes.data?.warning || null,
        message: executionRes.data?.message || ''
      });
      setEvidence({
        strategyScorecards: evidenceRes.data?.strategyScorecards || [],
        exposure: evidenceRes.data?.exposure || { summary: {}, series: [] },
        blotter: evidenceRes.data?.blotter || { summary: {}, rows: [] },
        paperCoverage: evidenceRes.data?.paperCoverage || [],
        completeness: evidenceRes.data?.completeness || { complete: false, collections: {} },
        lookbackDays: evidenceRes.data?.lookbackDays || 90,
        generatedAt: evidenceRes.data?.generatedAt || null,
        warning: evidenceRes.data?.warning || null,
        message: evidenceRes.data?.message || ''
      });
    } catch (err) {
      setError(getApiError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const banners = useMemo(() => {
    const items = [];
    if (error) {
      items.push({ type: 'danger', text: error });
    }
    if (status?.warning && status?.message) {
      items.push({ type: 'warning', text: status.message });
    }
    if (execution?.warning && execution?.message && execution.message !== status?.message) {
      items.push({ type: 'warning', text: execution.message });
    }
    if (evidence?.warning && evidence?.message && evidence.message !== status?.message) {
      items.push({ type: 'warning', text: evidence.message });
    }
    return items;
  }, [error, evidence?.message, evidence?.warning, execution?.message, execution?.warning, status?.message, status?.warning]);

  const evidenceSummary = useMemo(() => ({
    qualifyingRuns: evidence.strategyScorecards.reduce(
      (sum, item) => sum + Number(item.qualifyingWalkForwardRunCount || 0),
      0
    ),
    paperFills: evidence.paperCoverage.reduce((sum, item) => sum + Number(item.comparableFills || 0), 0),
    exposureBreaches: Number(evidence.exposure?.summary?.breachCount || 0),
    discrepancies: Number(evidence.blotter?.summary?.discrepancyCount || 0),
    complete: evidence.completeness?.complete === true,
    hasEvidence: [
      evidence.completeness?.collections?.strategyRuns?.matchedCount,
      evidence.completeness?.collections?.exposureSnapshots?.matchedCount,
      evidence.completeness?.collections?.orderIntents?.matchedCount,
      evidence.completeness?.collections?.roboTradeOrders?.matchedCount
    ].some(value => Number(value) > 0)
  }), [evidence]);

  const evidenceState = evidenceSummary.complete
    ? (evidenceSummary.exposureBreaches || evidenceSummary.discrepancies
      ? { variant: 'warning', label: 'Review Required' }
      : evidenceSummary.hasEvidence
        ? { variant: 'success', label: 'No Recorded Exceptions' }
        : { variant: 'neutral', label: 'No Evidence' })
    : { variant: 'warning', label: evidenceSummary.hasEvidence ? 'Incomplete Evidence' : 'No Evidence' };

  const exposureChart = useMemo(() => (
    (evidence.exposure?.series || []).map(item => ({
      ...item,
      label: item.capturedAt ? new Date(item.capturedAt).toLocaleDateString() : '--'
    }))
  ), [evidence.exposure?.series]);

  const summaryCards = useMemo(() => {
    if (!status) return [];
    return [
      {
        label: 'Execution Mode',
        value: status.environment?.defaultExecutionMode || 'paper'
      },
      {
        label: 'Mongo State',
        value: status.mongo?.state || 'unknown'
      },
      {
        label: 'Strategy Modules',
        value: String(status.strategyCount || 0)
      },
      {
        label: 'Order Reject Rate',
        value: execution.summary ? formatPercent(execution.summary.rejectRate || 0) : '--'
      }
    ];
  }, [execution.summary, status]);

  if (loading) {
    return (
      <div className="space-y-6">
        <Card className="p-6">
          <Skeleton className="h-5 w-52" />
          <Skeleton className="h-4 w-72 mt-3" />
          <div className="grid gap-4 md:grid-cols-4 mt-6">
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={`trading-system-summary-${index}`} className="h-24 w-full" />
            ))}
          </div>
        </Card>
        <Card className="p-6">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-56 w-full mt-4" />
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Card className="p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="rt-eyebrow">Admin Surface</p>
            <h1 className="rt-title">Trading System</h1>
            <p className="rt-subtitle mt-2 max-w-3xl">
              Central view for feature flags, risk defaults, strategy registry, run history, and execution telemetry.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={status?.environment?.paperTradingEnabled ? 'success' : 'danger'}>
              {status?.environment?.paperTradingEnabled ? 'Paper Enabled' : 'Paper Disabled'}
            </Badge>
            <Badge variant={status?.environment?.liveTradingEnabled ? 'warning' : 'neutral'}>
              {status?.environment?.liveTradingEnabled ? 'Live Enabled' : 'Live Disabled'}
            </Badge>
            <Button variant="secondary" size="sm" onClick={loadAll}>
              Refresh
            </Button>
          </div>
        </div>

        {banners.map((banner, index) => (
          <div
            key={`${banner.type}-${index}`}
            className={`mt-4 rounded-xl border px-4 py-3 text-sm ${
              banner.type === 'danger'
                ? 'border-[#5d2734] bg-[#341a22] text-[#ffb2c1]'
                : 'border-amber-500/30 bg-amber-500/10 text-amber-100'
            }`}
          >
            {banner.text}
          </div>
        ))}

        <div className="mt-6 grid gap-4 md:grid-cols-4">
          {summaryCards.map(card => (
            <div key={card.label} className="rt-metric">
              <p className="rt-label">{card.label}</p>
              <p className="mt-3 text-xl font-semibold text-[#edf5f4]">{card.value}</p>
            </div>
          ))}
        </div>
      </Card>

      <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
        <Card className="p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="rt-section-title">Feature Flags</p>
              <p className="text-xs text-[#8ba09f]">Safe defaults stay in paper mode until explicitly overridden.</p>
            </div>
            <Badge variant={status?.warnings?.length ? 'warning' : 'success'}>
              {status?.warnings?.length ? `${status.warnings.length} Warnings` : 'Healthy'}
            </Badge>
          </div>

          <div className="mt-5 grid gap-3 md:grid-cols-2">
            {Object.entries(status?.featureFlags || {}).map(([key, value]) => (
              <div key={key} className="rt-panel px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm text-[#b8c8c7]">{formatFlagLabel(key)}</p>
                  <Badge variant={value ? 'success' : 'neutral'}>{value ? 'On' : 'Off'}</Badge>
                </div>
              </div>
            ))}
          </div>

          {!!status?.warnings?.length && (
            <div className="mt-5 space-y-2">
              {status.warnings.map(warning => (
                <div key={warning} className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
                  {warning}
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card className="p-6">
          <p className="rt-section-title">Risk Defaults</p>
          <p className="text-xs text-[#8ba09f]">Global account-level guardrails loaded from config and persisted overrides.</p>
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            {Object.entries(status?.riskLimits || {}).map(([key, value]) => (
              <div key={key} className="rt-panel px-4 py-3">
                <p className="text-xs uppercase tracking-[0.16em] text-[#8ba09f]">{formatFlagLabel(key)}</p>
                <p className="mt-2 text-base font-semibold text-[#edf5f4]">{String(value)}</p>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card className="p-6">
        <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="rt-section-title">Strategy Registry</p>
            <p className="text-xs text-[#8ba09f]">Compatibility, allocation ceilings, and enabled state per module.</p>
          </div>
          <p className="text-xs text-[#8ba09f]">{status?.strategyCount || 0} configured strategies</p>
        </div>
        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          {(status?.strategies || []).map(strategy => (
            <div key={strategy.strategyId} className="rt-panel px-5 py-4">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-base font-semibold text-[#edf5f4]">{strategy.name}</p>
                <Badge variant={strategy.enabled ? 'success' : 'neutral'}>
                  {strategy.enabled ? 'Enabled' : 'Disabled'}
                </Badge>
                <Badge variant={strategy.paperEligible ? 'solid' : 'neutral'}>
                  {strategy.paperEligible ? 'Paper' : 'Paper Off'}
                </Badge>
                <Badge variant={strategy.liveEligible ? 'warning' : 'neutral'}>
                  {strategy.liveEligible ? 'Live Ready' : 'Live Off'}
                </Badge>
              </div>
              <p className="mt-3 text-sm text-[#a9b8b8]">{strategy.description}</p>
              <div className="mt-4 grid gap-3 sm:grid-cols-2 text-sm text-[#b8c8c7]">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.16em] text-[#8ba09f]">Strategy ID</p>
                  <p className="mt-1 font-mono text-xs">{strategy.strategyId}</p>
                </div>
                <div>
                  <p className="text-[11px] uppercase tracking-[0.16em] text-[#8ba09f]">Max Allocation</p>
                  <p className="mt-1">{strategy.maxAllocationPct}%</p>
                </div>
                <div>
                  <p className="text-[11px] uppercase tracking-[0.16em] text-[#8ba09f]">Regimes</p>
                  <p className="mt-1">{(strategy.compatibleRegimes || []).join(', ') || '--'}</p>
                </div>
                <div>
                  <p className="text-[11px] uppercase tracking-[0.16em] text-[#8ba09f]">Asset Classes</p>
                  <p className="mt-1">{(strategy.assetClasses || []).join(', ') || '--'}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card className="p-6">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="rt-eyebrow">Controlled-Live Evidence Campaign</p>
            <h2 className="rt-section-title mt-1">Operational Evidence</h2>
            <p className="mt-2 max-w-3xl text-sm text-[#8ba09f]">
              Read-only account evidence for walk-forward validation, paper-fill coverage, portfolio exposure, and order-control diagnostics.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant="neutral">{evidence.lookbackDays || 90}-Day Window</Badge>
            <Badge variant={evidenceState.variant}>{evidenceState.label}</Badge>
          </div>
        </div>

        {!evidenceSummary.complete && (
          <div className="mt-4 rounded-lg border border-[#6b5725] bg-[#2b2412] px-4 py-3 text-sm text-[#ffd77a]">
            Evidence coverage is incomplete. Counts and charts include only the returned records; do not interpret zero as proof that no exception occurred.
          </div>
        )}

        <div className="mt-6 grid gap-4 md:grid-cols-4">
          <div className="rt-metric">
            <p className="rt-label">Qualifying Walk-Forward Runs</p>
            <p className="mt-3 text-xl font-semibold text-[#edf5f4]">{evidenceSummary.qualifyingRuns}</p>
          </div>
          <div className="rt-metric">
            <p className="rt-label">Comparable Paper Fills</p>
            <p className="mt-3 text-xl font-semibold text-[#edf5f4]">{evidenceSummary.paperFills}</p>
          </div>
          <div className="rt-metric">
            <p className="rt-label">Exposure Breaches</p>
            <p className="mt-3 text-xl font-semibold text-[#edf5f4]">{evidenceSummary.exposureBreaches}</p>
          </div>
          <div className="rt-metric">
            <p className="rt-label">Reconciliation Discrepancies</p>
            <p className="mt-3 text-xl font-semibold text-[#edf5f4]">{evidenceSummary.discrepancies}</p>
          </div>
        </div>
      </Card>

      <div className="grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
        <Card className="p-6">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="rt-section-title">Strategy Scorecards</p>
              <p className="text-xs text-[#8ba09f]">Run stability and reproducibility grouped by exact strategy identifier.</p>
            </div>
            <Badge variant="neutral">{evidence.strategyScorecards.length} Strategies</Badge>
          </div>
          <div className="mt-5 space-y-4">
            {!evidence.strategyScorecards.length && (
              <div className="rt-panel px-4 py-4 text-sm text-[#8ba09f]">
                No strategy evidence is recorded in this lookback window.
              </div>
            )}
            {evidence.strategyScorecards.map(scorecard => (
              <div key={scorecard.strategyId} className="rt-panel px-5 py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-[#edf5f4]">{scorecard.strategyName}</p>
                    <p className="mt-1 font-mono text-[11px] text-[#8ba09f]">{scorecard.strategyId}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Badge variant={getStatusVariant(scorecard.status)}>{scorecard.status}</Badge>
                    <Badge variant="neutral">{scorecard.symbols.length} Symbols</Badge>
                  </div>
                </div>
                <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <div>
                    <p className="rt-label">Walk-Forward</p>
                    <p className="mt-1 text-sm text-[#dbe8e7]">
                      {scorecard.qualifyingWalkForwardRunCount}/{scorecard.walkForwardRunCount} passed
                    </p>
                  </div>
                  <div>
                    <p className="rt-label">{scorecard.metricBasis === 'walk_forward' ? 'Mean OOS Trades' : 'Mean Trades'}</p>
                    <p className="mt-1 text-sm text-[#dbe8e7]">{formatNumber(scorecard.metrics?.meanTradeCount, 0)}</p>
                  </div>
                  <div>
                    <p className="rt-label">Mean Average R</p>
                    <p className="mt-1 text-sm text-[#dbe8e7]">{formatNumber(scorecard.metrics?.meanAverageR)}</p>
                  </div>
                  <div>
                    <p className="rt-label">Worst Drawdown</p>
                    <p className="mt-1 text-sm text-[#dbe8e7]">{formatPercent(scorecard.metrics?.worstMaxDrawdown)}</p>
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-[#8ba09f]">
                  <span>Symbols: {scorecard.symbols.join(', ') || '--'}</span>
                  <span aria-hidden="true">•</span>
                  <span>Parameter versions: {scorecard.parameterVersions.join(', ') || '--'}</span>
                  <span aria-hidden="true">•</span>
                  <span>Latest: {formatDateTime(scorecard.latestRunAt)}</span>
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card className="p-6">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="rt-section-title">Paper Evidence Coverage</p>
              <p className="text-xs text-[#8ba09f]">Progress toward 20 comparable paper fills per strategy and symbol.</p>
            </div>
            <Badge variant="neutral">{evidence.paperCoverage.length} Cohorts</Badge>
          </div>
          <div className="mt-5 space-y-4">
            {!evidence.paperCoverage.length && (
              <div className="rt-panel px-4 py-4 text-sm text-[#8ba09f]">
                No paper RoboTrader orders are recorded in this window.
              </div>
            )}
            {evidence.paperCoverage.map(item => (
              <div key={`${item.strategyId}-${item.symbol}`} className="rt-panel px-4 py-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-[#edf5f4]">{item.symbol}</p>
                    <p className="mt-1 max-w-[18rem] truncate font-mono text-[10px] text-[#8ba09f]">{item.strategyId}</p>
                  </div>
                  <Badge variant={item.comparableFills >= item.targetComparableFills ? 'success' : 'warning'}>
                    {item.comparableFills}/{item.targetComparableFills}
                  </Badge>
                </div>
                <div className="mt-3 h-2 overflow-hidden rounded-full bg-[#1c292e]">
                  <div
                    className="h-full rounded-full bg-[#2dd881]"
                    style={{ width: `${item.coveragePct}%` }}
                  />
                </div>
                <div className="mt-2 flex justify-between text-[11px] text-[#8ba09f]">
                  <span>{formatPercent(item.coveragePct)} complete</span>
                  <span>{item.filledOrders} filled · {item.rejectedOrders} rejected</span>
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card className="p-6">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="rt-section-title">Exposure History</p>
            <p className="text-xs text-[#8ba09f]">Gross/net account exposure and drawdown captured at each policy boundary.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant={evidence.exposure?.summary?.snapshotCount
              ? (evidence.exposure?.summary?.breachCount ? 'danger' : 'success')
              : 'neutral'}>
              {evidence.exposure?.summary?.snapshotCount
                ? `${evidence.exposure?.summary?.breachCount || 0} Breaches`
                : 'No Exposure Evidence'}
            </Badge>
            <Badge variant="neutral">{evidence.exposure?.summary?.snapshotCount || 0} Snapshots</Badge>
          </div>
        </div>

        <div className="mt-5 grid gap-4 md:grid-cols-4">
          <div className="rt-metric">
            <p className="rt-label">Latest Equity</p>
            <p className="mt-3 text-lg font-semibold text-[#edf5f4]">
              {evidence.exposure?.summary?.latest?.equity === null || evidence.exposure?.summary?.latest?.equity === undefined
                ? '--'
                : `$${formatNumber(evidence.exposure.summary.latest.equity)}`}
            </p>
          </div>
          <div className="rt-metric">
            <p className="rt-label">Peak Gross Exposure</p>
            <p className="mt-3 text-lg font-semibold text-[#edf5f4]">{formatPercent(evidence.exposure?.summary?.peakGrossExposurePct)}</p>
          </div>
          <div className="rt-metric">
            <p className="rt-label">Peak Total Drawdown</p>
            <p className="mt-3 text-lg font-semibold text-[#edf5f4]">{formatPercent(evidence.exposure?.summary?.peakTotalDrawdownPct)}</p>
          </div>
          <div className="rt-metric">
            <p className="rt-label">Latest Positions</p>
            <p className="mt-3 text-lg font-semibold text-[#edf5f4]">{evidence.exposure?.summary?.latest?.positionCount ?? '--'}</p>
          </div>
        </div>

        <div className="mt-6 h-72 rounded-lg border border-[#26363c] bg-[#0d1417] p-3">
          {!exposureChart.length ? (
            <div className="flex h-full items-center justify-center text-sm text-[#8ba09f]">No exposure history yet.</div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={exposureChart} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
                <XAxis dataKey="label" stroke="#6f8584" tick={{ fontSize: 11 }} minTickGap={24} />
                <YAxis stroke="#6f8584" tick={{ fontSize: 11 }} unit="%" />
                <Tooltip
                  contentStyle={{ background: '#11181b', border: '1px solid #33474f', borderRadius: 8 }}
                  labelStyle={{ color: '#edf5f4' }}
                />
                <Line type="monotone" dataKey="grossExposurePct" name="Gross exposure" stroke="#2dd881" dot={false} strokeWidth={2} />
                <Line type="monotone" dataKey="netExposurePct" name="Net exposure" stroke="#72a8ff" dot={false} strokeWidth={2} />
                <Line type="monotone" dataKey="totalDrawdownPct" name="Drawdown" stroke="#ff8ba0" dot={false} strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </Card>

      <Card className="p-6">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="rt-section-title">Control Blotter</p>
            <p className="text-xs text-[#8ba09f]">Intent, authorization, risk, broker, and reconciliation outcomes on one diagnostic row.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant="neutral">{evidence.blotter?.summary?.intentCount || 0} Intents</Badge>
            <Badge variant={evidence.blotter?.summary?.policyBlockedCount ? 'warning' : 'neutral'}>
              {evidence.blotter?.summary?.policyBlockedCount || 0} Policy Blocks
            </Badge>
            <Badge variant={evidence.blotter?.summary?.staleOpenOrderCount ? 'danger' : 'neutral'}>
              {evidence.blotter?.summary?.staleOpenOrderCount || 0} Stale
            </Badge>
          </div>
        </div>

        <div className="mt-5 overflow-x-auto rounded-lg border border-[#26363c]">
          <table className="min-w-[1050px] w-full text-left text-sm">
            <thead className="bg-[#141d21] text-[11px] uppercase tracking-[0.14em] text-[#8ba09f]">
              <tr>
                <th className="px-4 py-3">Time</th>
                <th className="px-4 py-3">Order</th>
                <th className="px-4 py-3">Environment</th>
                <th className="px-4 py-3">Intent</th>
                <th className="px-4 py-3">Broker</th>
                <th className="px-4 py-3">Authorization</th>
                <th className="px-4 py-3">Execution</th>
                <th className="px-4 py-3">Diagnostics</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#26363c]">
              {!evidence.blotter?.rows?.length && (
                <tr>
                  <td colSpan="8" className="px-4 py-8 text-center text-[#8ba09f]">No order intents are recorded in this window.</td>
                </tr>
              )}
              {(evidence.blotter?.rows || []).map(row => (
                <tr key={row.intentId} className="bg-[#10171a] align-top text-[#b8c8c7]">
                  <td className="px-4 py-4 whitespace-nowrap">{formatDateTime(row.requestedAt)}</td>
                  <td className="px-4 py-4">
                    <p className="font-semibold text-[#edf5f4]">{row.symbol || '--'} {row.side || ''}</p>
                    <p className="mt-1 text-xs text-[#8ba09f]">Qty {row.qty ?? '--'}</p>
                  </td>
                  <td className="px-4 py-4"><Badge variant={row.environment === 'live' ? 'warning' : 'neutral'}>{row.environment || 'unknown'}</Badge></td>
                  <td className="px-4 py-4"><Badge variant={getStatusVariant(row.intentStatus)}>{row.intentStatus || 'unknown'}</Badge></td>
                  <td className="px-4 py-4"><Badge variant={getStatusVariant(row.brokerStatus)}>{row.brokerStatus || 'not submitted'}</Badge></td>
                  <td className="px-4 py-4">{row.authorizationStatus || '--'}</td>
                  <td className="px-4 py-4 whitespace-nowrap">
                    <p>{formatNumber(row.slippageBps)} bps</p>
                    <p className="mt-1 text-xs text-[#8ba09f]">{formatDuration(row.fillLatencyMs)}</p>
                  </td>
                  <td className="px-4 py-4 max-w-[22rem]">
                    <div className="flex flex-wrap gap-1">
                      {row.stale && <Badge variant="danger">Stale Open Order</Badge>}
                      {row.discrepancy && <Badge variant="danger">Discrepancy</Badge>}
                      {row.riskFailures.map(check => <Badge key={check.name} variant="warning">{check.name}</Badge>)}
                      {row.reasonCodes.map(code => <Badge key={code} variant="neutral">{code}</Badge>)}
                    </div>
                    {(row.rejectionReason || row.discrepancy) && (
                      <p className="mt-2 text-xs text-[#ffb2c1]">{row.rejectionReason || row.discrepancy}</p>
                    )}
                    {!row.stale && !row.discrepancy && !row.riskFailures.length && !row.reasonCodes.length && (
                      <span className="text-xs text-[#6f8584]">No recorded exception</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
        <Card className="p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="rt-section-title">Recent Strategy Runs</p>
              <p className="text-xs text-[#8ba09f]">Backtests and robo cycles with parameter-version linkage.</p>
            </div>
            <Badge variant="neutral">{strategyRuns.length} records</Badge>
          </div>
          <div className="mt-5 space-y-3">
            {!strategyRuns.length && (
              <div className="rt-panel px-4 py-4 text-sm text-[#8ba09f]">
                No persisted strategy runs yet.
              </div>
            )}
            {strategyRuns.map(run => (
              <div key={run._id || `${run.strategyId}-${run.startedAt}`} className="rt-panel px-4 py-4">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-semibold text-[#edf5f4]">{run.strategyName || run.strategyId}</p>
                  <Badge variant={getStatusVariant(run.status)}>{run.status}</Badge>
                  <Badge variant="neutral">{run.runType}</Badge>
                  <Badge variant="solid">{run.mode}</Badge>
                </div>
                <div className="mt-3 grid gap-3 md:grid-cols-3 text-sm text-[#b8c8c7]">
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.16em] text-[#8ba09f]">Symbol</p>
                    <p className="mt-1">{run.symbol || '--'}</p>
                  </div>
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.16em] text-[#8ba09f]">Started</p>
                    <p className="mt-1">{formatDateTime(run.startedAt)}</p>
                  </div>
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.16em] text-[#8ba09f]">Parameter Version</p>
                    <p className="mt-1">{run.parameterVersionId?.version || '--'}</p>
                  </div>
                </div>
                {(run.summary?.reason || run.error) && (
                  <p className="mt-3 text-xs text-[#8ba09f]">
                    {run.summary?.reason || run.error}
                  </p>
                )}
              </div>
            ))}
          </div>
        </Card>

        <Card className="p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="rt-section-title">Parameter Versions</p>
              <p className="text-xs text-[#8ba09f]">Stable hashed configs for reproducible backtests and robo runs.</p>
            </div>
            <Badge variant="neutral">{parameterVersions.length} versions</Badge>
          </div>
          <div className="mt-5 space-y-3">
            {!parameterVersions.length && (
              <div className="rt-panel px-4 py-4 text-sm text-[#8ba09f]">
                No persisted parameter versions yet.
              </div>
            )}
            {parameterVersions.map(item => (
              <div key={item._id || `${item.strategyId}-${item.version}`} className="rt-panel px-4 py-4">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-semibold text-[#edf5f4]">{item.strategyId}</p>
                  <Badge variant="solid">v{item.version}</Badge>
                  <Badge variant="neutral">{item.source}</Badge>
                </div>
                <p className="mt-2 break-all font-mono text-[11px] text-[#8ba09f]">{item.parameterHash}</p>
                <p className="mt-2 text-xs text-[#8ba09f]">Created {formatDateTime(item.createdAt)}</p>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card className="p-6">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="rt-section-title">Execution Telemetry</p>
            <p className="text-xs text-[#8ba09f]">Order intents, broker outcomes, and fills captured independently from paper-trade inference.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant="neutral">Attempts {execution.summary?.attemptedOrders || 0}</Badge>
            <Badge variant="success">Filled {execution.summary?.filledOrders || 0}</Badge>
            <Badge variant="danger">Rejected {execution.summary?.rejectedOrders || 0}</Badge>
          </div>
        </div>

        <div className="mt-5 grid gap-4 md:grid-cols-4">
          <div className="rt-metric">
            <p className="rt-label">Reject Rate</p>
            <p className="mt-3 text-xl font-semibold text-[#edf5f4]">{formatPercent(execution.summary?.rejectRate || 0)}</p>
          </div>
          <div className="rt-metric">
            <p className="rt-label">Broker Orders</p>
            <p className="mt-3 text-xl font-semibold text-[#edf5f4]">{execution.orders.length}</p>
          </div>
          <div className="rt-metric">
            <p className="rt-label">Fills</p>
            <p className="mt-3 text-xl font-semibold text-[#edf5f4]">{execution.fills.length}</p>
          </div>
          <div className="rt-metric">
            <p className="rt-label">Latest Fill</p>
            <p className="mt-3 text-sm font-semibold text-[#edf5f4]">
              {execution.fills[0] ? `${execution.fills[0].symbol} @ ${formatNumber(execution.fills[0].price)}` : '--'}
            </p>
          </div>
        </div>

        <div className="mt-6 grid gap-6 xl:grid-cols-2">
          <div>
            <p className="rt-section-title">Recent Orders</p>
            <div className="mt-4 space-y-3">
              {!execution.orders.length && (
                <div className="rt-panel px-4 py-4 text-sm text-[#8ba09f]">
                  No broker-order telemetry yet.
                </div>
              )}
              {execution.orders.map(order => (
                <div key={order._id || `${order.symbol}-${order.submittedAt}`} className="rt-panel px-4 py-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-semibold text-[#edf5f4]">{order.symbol}</p>
                    <Badge variant={getStatusVariant(order.status)}>{order.status}</Badge>
                    <Badge variant="neutral">{order.broker}</Badge>
                    <Badge variant="solid">{order.origin}</Badge>
                  </div>
                  <div className="mt-3 grid gap-3 md:grid-cols-3 text-sm text-[#b8c8c7]">
                    <div>
                      <p className="text-[11px] uppercase tracking-[0.16em] text-[#8ba09f]">Qty</p>
                      <p className="mt-1">{order.qty}</p>
                    </div>
                    <div>
                      <p className="text-[11px] uppercase tracking-[0.16em] text-[#8ba09f]">Fill Price</p>
                      <p className="mt-1">{formatNumber(order.fillPrice)}</p>
                    </div>
                    <div>
                      <p className="text-[11px] uppercase tracking-[0.16em] text-[#8ba09f]">Submitted</p>
                      <p className="mt-1">{formatDateTime(order.submittedAt)}</p>
                    </div>
                  </div>
                  {order.rejectionReason && (
                    <p className="mt-3 text-xs text-[#ffb2c1]">{order.rejectionReason}</p>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div>
            <p className="rt-section-title">Recent Fills</p>
            <div className="mt-4 space-y-3">
              {!execution.fills.length && (
                <div className="rt-panel px-4 py-4 text-sm text-[#8ba09f]">
                  No fill telemetry yet.
                </div>
              )}
              {execution.fills.map(fill => (
                <div key={fill._id || `${fill.symbol}-${fill.filledAt}`} className="rt-panel px-4 py-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-semibold text-[#edf5f4]">{fill.symbol}</p>
                    <Badge variant="success">{fill.side}</Badge>
                    <Badge variant="neutral">{fill.strategyId || 'UNASSIGNED'}</Badge>
                  </div>
                  <div className="mt-3 grid gap-3 md:grid-cols-3 text-sm text-[#b8c8c7]">
                    <div>
                      <p className="text-[11px] uppercase tracking-[0.16em] text-[#8ba09f]">Qty</p>
                      <p className="mt-1">{fill.qty}</p>
                    </div>
                    <div>
                      <p className="text-[11px] uppercase tracking-[0.16em] text-[#8ba09f]">Price</p>
                      <p className="mt-1">{formatNumber(fill.price)}</p>
                    </div>
                    <div>
                      <p className="text-[11px] uppercase tracking-[0.16em] text-[#8ba09f]">Filled</p>
                      <p className="mt-1">{formatDateTime(fill.filledAt)}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}
