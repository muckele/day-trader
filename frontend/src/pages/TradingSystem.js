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
