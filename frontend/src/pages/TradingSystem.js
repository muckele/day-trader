import React, { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
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
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '--';
  return numeric.toFixed(digits);
}

function formatPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '--';
  return `${numeric.toFixed(2)}%`;
}

function formatFlagLabel(key) {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, char => char.toUpperCase());
}

function getStatusVariant(status) {
  if (status === 'completed' || status === 'connected') return 'success';
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

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [statusRes, runsRes, paramsRes, executionRes] = await Promise.all([
        axios.get('/api/trading-system/status'),
        axios.get('/api/trading-system/strategy-runs', { params: { limit: 12 } }),
        axios.get('/api/trading-system/strategy-parameters', { params: { limit: 12 } }),
        axios.get('/api/trading-system/execution', { params: { limit: 12 } })
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
    return items;
  }, [error, execution?.message, execution?.warning, status?.message, status?.warning]);

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
            <p className="text-[11px] uppercase tracking-[0.2em] text-emerald-100/45">Admin Surface</p>
            <h1 className="text-3xl font-extrabold tracking-tight text-emerald-50">Trading System</h1>
            <p className="mt-2 max-w-3xl text-sm text-emerald-100/65">
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
            <div key={card.label} className="rounded-2xl border border-emerald-900/55 bg-[#0d1712] px-4 py-4">
              <p className="text-xs uppercase tracking-[0.16em] text-emerald-100/40">{card.label}</p>
              <p className="mt-3 text-xl font-semibold text-emerald-50">{card.value}</p>
            </div>
          ))}
        </div>
      </Card>

      <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
        <Card className="p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-emerald-50">Feature Flags</p>
              <p className="text-xs text-emerald-100/45">Safe defaults stay in paper mode until explicitly overridden.</p>
            </div>
            <Badge variant={status?.warnings?.length ? 'warning' : 'success'}>
              {status?.warnings?.length ? `${status.warnings.length} Warnings` : 'Healthy'}
            </Badge>
          </div>

          <div className="mt-5 grid gap-3 md:grid-cols-2">
            {Object.entries(status?.featureFlags || {}).map(([key, value]) => (
              <div key={key} className="rounded-xl border border-emerald-900/55 bg-[#0d1712] px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm text-emerald-100/78">{formatFlagLabel(key)}</p>
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
          <p className="text-sm font-semibold text-emerald-50">Risk Defaults</p>
          <p className="text-xs text-emerald-100/45">Global account-level guardrails loaded from config and persisted overrides.</p>
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            {Object.entries(status?.riskLimits || {}).map(([key, value]) => (
              <div key={key} className="rounded-xl border border-emerald-900/55 bg-[#0d1712] px-4 py-3">
                <p className="text-xs uppercase tracking-[0.16em] text-emerald-100/38">{formatFlagLabel(key)}</p>
                <p className="mt-2 text-base font-semibold text-emerald-50">{String(value)}</p>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card className="p-6">
        <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-sm font-semibold text-emerald-50">Strategy Registry</p>
            <p className="text-xs text-emerald-100/45">Compatibility, allocation ceilings, and enabled state per module.</p>
          </div>
          <p className="text-xs text-emerald-100/38">{status?.strategyCount || 0} configured strategies</p>
        </div>
        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          {(status?.strategies || []).map(strategy => (
            <div key={strategy.strategyId} className="rounded-2xl border border-emerald-900/55 bg-[#0d1712] px-5 py-4">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-base font-semibold text-emerald-50">{strategy.name}</p>
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
              <p className="mt-3 text-sm text-emerald-100/64">{strategy.description}</p>
              <div className="mt-4 grid gap-3 sm:grid-cols-2 text-sm text-emerald-100/72">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.16em] text-emerald-100/36">Strategy ID</p>
                  <p className="mt-1 font-mono text-xs">{strategy.strategyId}</p>
                </div>
                <div>
                  <p className="text-[11px] uppercase tracking-[0.16em] text-emerald-100/36">Max Allocation</p>
                  <p className="mt-1">{strategy.maxAllocationPct}%</p>
                </div>
                <div>
                  <p className="text-[11px] uppercase tracking-[0.16em] text-emerald-100/36">Regimes</p>
                  <p className="mt-1">{(strategy.compatibleRegimes || []).join(', ') || '--'}</p>
                </div>
                <div>
                  <p className="text-[11px] uppercase tracking-[0.16em] text-emerald-100/36">Asset Classes</p>
                  <p className="mt-1">{(strategy.assetClasses || []).join(', ') || '--'}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <div className="grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
        <Card className="p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-emerald-50">Recent Strategy Runs</p>
              <p className="text-xs text-emerald-100/45">Backtests and robo cycles with parameter-version linkage.</p>
            </div>
            <Badge variant="neutral">{strategyRuns.length} records</Badge>
          </div>
          <div className="mt-5 space-y-3">
            {!strategyRuns.length && (
              <div className="rounded-xl border border-emerald-900/55 bg-[#0d1712] px-4 py-4 text-sm text-emerald-100/55">
                No persisted strategy runs yet.
              </div>
            )}
            {strategyRuns.map(run => (
              <div key={run._id || `${run.strategyId}-${run.startedAt}`} className="rounded-xl border border-emerald-900/55 bg-[#0d1712] px-4 py-4">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-semibold text-emerald-50">{run.strategyName || run.strategyId}</p>
                  <Badge variant={getStatusVariant(run.status)}>{run.status}</Badge>
                  <Badge variant="neutral">{run.runType}</Badge>
                  <Badge variant="solid">{run.mode}</Badge>
                </div>
                <div className="mt-3 grid gap-3 md:grid-cols-3 text-sm text-emerald-100/70">
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.16em] text-emerald-100/36">Symbol</p>
                    <p className="mt-1">{run.symbol || '--'}</p>
                  </div>
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.16em] text-emerald-100/36">Started</p>
                    <p className="mt-1">{formatDateTime(run.startedAt)}</p>
                  </div>
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.16em] text-emerald-100/36">Parameter Version</p>
                    <p className="mt-1">{run.parameterVersionId?.version || '--'}</p>
                  </div>
                </div>
                {(run.summary?.reason || run.error) && (
                  <p className="mt-3 text-xs text-emerald-100/52">
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
              <p className="text-sm font-semibold text-emerald-50">Parameter Versions</p>
              <p className="text-xs text-emerald-100/45">Stable hashed configs for reproducible backtests and robo runs.</p>
            </div>
            <Badge variant="neutral">{parameterVersions.length} versions</Badge>
          </div>
          <div className="mt-5 space-y-3">
            {!parameterVersions.length && (
              <div className="rounded-xl border border-emerald-900/55 bg-[#0d1712] px-4 py-4 text-sm text-emerald-100/55">
                No persisted parameter versions yet.
              </div>
            )}
            {parameterVersions.map(item => (
              <div key={item._id || `${item.strategyId}-${item.version}`} className="rounded-xl border border-emerald-900/55 bg-[#0d1712] px-4 py-4">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-semibold text-emerald-50">{item.strategyId}</p>
                  <Badge variant="solid">v{item.version}</Badge>
                  <Badge variant="neutral">{item.source}</Badge>
                </div>
                <p className="mt-2 break-all font-mono text-[11px] text-emerald-100/44">{item.parameterHash}</p>
                <p className="mt-2 text-xs text-emerald-100/55">Created {formatDateTime(item.createdAt)}</p>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card className="p-6">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-sm font-semibold text-emerald-50">Execution Telemetry</p>
            <p className="text-xs text-emerald-100/45">Order intents, broker outcomes, and fills captured independently from paper-trade inference.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant="neutral">Attempts {execution.summary?.attemptedOrders || 0}</Badge>
            <Badge variant="success">Filled {execution.summary?.filledOrders || 0}</Badge>
            <Badge variant="danger">Rejected {execution.summary?.rejectedOrders || 0}</Badge>
          </div>
        </div>

        <div className="mt-5 grid gap-4 md:grid-cols-4">
          <div className="rounded-xl border border-emerald-900/55 bg-[#0d1712] px-4 py-4">
            <p className="text-xs uppercase tracking-[0.16em] text-emerald-100/38">Reject Rate</p>
            <p className="mt-3 text-xl font-semibold text-emerald-50">{formatPercent(execution.summary?.rejectRate || 0)}</p>
          </div>
          <div className="rounded-xl border border-emerald-900/55 bg-[#0d1712] px-4 py-4">
            <p className="text-xs uppercase tracking-[0.16em] text-emerald-100/38">Broker Orders</p>
            <p className="mt-3 text-xl font-semibold text-emerald-50">{execution.orders.length}</p>
          </div>
          <div className="rounded-xl border border-emerald-900/55 bg-[#0d1712] px-4 py-4">
            <p className="text-xs uppercase tracking-[0.16em] text-emerald-100/38">Fills</p>
            <p className="mt-3 text-xl font-semibold text-emerald-50">{execution.fills.length}</p>
          </div>
          <div className="rounded-xl border border-emerald-900/55 bg-[#0d1712] px-4 py-4">
            <p className="text-xs uppercase tracking-[0.16em] text-emerald-100/38">Latest Fill</p>
            <p className="mt-3 text-sm font-semibold text-emerald-50">
              {execution.fills[0] ? `${execution.fills[0].symbol} @ ${formatNumber(execution.fills[0].price)}` : '--'}
            </p>
          </div>
        </div>

        <div className="mt-6 grid gap-6 xl:grid-cols-2">
          <div>
            <p className="text-sm font-semibold text-emerald-50">Recent Orders</p>
            <div className="mt-4 space-y-3">
              {!execution.orders.length && (
                <div className="rounded-xl border border-emerald-900/55 bg-[#0d1712] px-4 py-4 text-sm text-emerald-100/55">
                  No broker-order telemetry yet.
                </div>
              )}
              {execution.orders.map(order => (
                <div key={order._id || `${order.symbol}-${order.submittedAt}`} className="rounded-xl border border-emerald-900/55 bg-[#0d1712] px-4 py-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-semibold text-emerald-50">{order.symbol}</p>
                    <Badge variant={getStatusVariant(order.status)}>{order.status}</Badge>
                    <Badge variant="neutral">{order.broker}</Badge>
                    <Badge variant="solid">{order.origin}</Badge>
                  </div>
                  <div className="mt-3 grid gap-3 md:grid-cols-3 text-sm text-emerald-100/70">
                    <div>
                      <p className="text-[11px] uppercase tracking-[0.16em] text-emerald-100/36">Qty</p>
                      <p className="mt-1">{order.qty}</p>
                    </div>
                    <div>
                      <p className="text-[11px] uppercase tracking-[0.16em] text-emerald-100/36">Fill Price</p>
                      <p className="mt-1">{formatNumber(order.fillPrice)}</p>
                    </div>
                    <div>
                      <p className="text-[11px] uppercase tracking-[0.16em] text-emerald-100/36">Submitted</p>
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
            <p className="text-sm font-semibold text-emerald-50">Recent Fills</p>
            <div className="mt-4 space-y-3">
              {!execution.fills.length && (
                <div className="rounded-xl border border-emerald-900/55 bg-[#0d1712] px-4 py-4 text-sm text-emerald-100/55">
                  No fill telemetry yet.
                </div>
              )}
              {execution.fills.map(fill => (
                <div key={fill._id || `${fill.symbol}-${fill.filledAt}`} className="rounded-xl border border-emerald-900/55 bg-[#0d1712] px-4 py-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-semibold text-emerald-50">{fill.symbol}</p>
                    <Badge variant="success">{fill.side}</Badge>
                    <Badge variant="neutral">{fill.strategyId || 'UNASSIGNED'}</Badge>
                  </div>
                  <div className="mt-3 grid gap-3 md:grid-cols-3 text-sm text-emerald-100/70">
                    <div>
                      <p className="text-[11px] uppercase tracking-[0.16em] text-emerald-100/36">Qty</p>
                      <p className="mt-1">{fill.qty}</p>
                    </div>
                    <div>
                      <p className="text-[11px] uppercase tracking-[0.16em] text-emerald-100/36">Price</p>
                      <p className="mt-1">{formatNumber(fill.price)}</p>
                    </div>
                    <div>
                      <p className="text-[11px] uppercase tracking-[0.16em] text-emerald-100/36">Filled</p>
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
