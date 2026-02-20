import React, { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge from '../components/ui/Badge';
import Skeleton from '../components/ui/Skeleton';
import { getApiError } from '../utils/api';

function formatMoney(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '--';
  return `$${amount.toFixed(2)}`;
}

function formatDateTime(value) {
  if (!value) return '--';
  return new Date(value).toLocaleString();
}

function mapEventType(eventType) {
  const map = {
    trade_executed: 'Trade Executed',
    trade_skipped_limit: 'Skipped: Limit',
    trade_skipped_locked: 'Skipped: Locked',
    trade_skipped_invalid_signal: 'Skipped: Invalid Signal',
    trade_skipped_no_quote: 'Skipped: No Quote',
    trade_skipped_scheduler_error: 'Skipped: Scheduler Error',
    robo_disabled: 'Robo Disabled',
    robo_settings_updated: 'Settings Updated',
    email_sent: 'Email Sent',
    email_failed: 'Email Failed'
  };
  return map[eventType] || eventType;
}

export default function RoboTrader() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [settings, setSettings] = useState({
    enabled: false,
    dailyLimit: 0,
    weeklyLimit: 0,
    monthlyLimit: 0
  });
  const [usage, setUsage] = useState(null);
  const [audit, setAudit] = useState([]);
  const [auditLoading, setAuditLoading] = useState(true);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [limit, setLimit] = useState(100);

  const loadSettings = async () => {
    const res = await axios.get('/api/robo/settings');
    setSettings({
      enabled: Boolean(res.data?.settings?.enabled),
      dailyLimit: Number(res.data?.settings?.dailyLimit || 0),
      weeklyLimit: Number(res.data?.settings?.weeklyLimit || 0),
      monthlyLimit: Number(res.data?.settings?.monthlyLimit || 0)
    });
    setUsage(res.data?.usage || null);
  };

  const loadAudit = useCallback(async (filters = {}) => {
    try {
      setAuditLoading(true);
      const params = {};
      if (filters.from) params.from = filters.from;
      if (filters.to) params.to = filters.to;
      if (filters.limit) params.limit = Number(filters.limit);
      const res = await axios.get('/api/robo/audit', { params });
      setAudit(res.data?.events || []);
    } finally {
      setAuditLoading(false);
    }
  }, []);

  useEffect(() => {
    (async () => {
      setLoading(true);
        setError('');
      try {
        await Promise.all([loadSettings(), loadAudit()]);
      } catch (err) {
        setError(getApiError(err));
      } finally {
        setLoading(false);
      }
    })();
  }, [loadAudit]);

  const usageCards = useMemo(() => {
    if (!usage) return [];
    return [
      { id: 'day', label: 'Daily', value: usage.day },
      { id: 'week', label: 'Weekly', value: usage.week },
      { id: 'month', label: 'Monthly', value: usage.month }
    ];
  }, [usage]);

  const handleSave = async () => {
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const payload = {
        enabled: settings.enabled,
        dailyLimit: Number(settings.dailyLimit || 0),
        weeklyLimit: Number(settings.weeklyLimit || 0),
        monthlyLimit: Number(settings.monthlyLimit || 0)
      };
      const res = await axios.put('/api/robo/settings', payload);
      setSettings({
        enabled: Boolean(res.data?.settings?.enabled),
        dailyLimit: Number(res.data?.settings?.dailyLimit || 0),
        weeklyLimit: Number(res.data?.settings?.weeklyLimit || 0),
        monthlyLimit: Number(res.data?.settings?.monthlyLimit || 0)
      });
      setUsage(res.data?.usage || null);
      setSuccess('Robo Trader settings updated.');
      await loadAudit({ from, to, limit });
    } catch (err) {
      setError(getApiError(err));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <Card className="p-6">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-64 mt-3" />
          <Skeleton className="h-28 w-full mt-5" />
        </Card>
        <Card className="p-6">
          <Skeleton className="h-5 w-28" />
          <div className="space-y-3 mt-4">
            {Array.from({ length: 6 }).map((_, idx) => (
              <Skeleton key={`audit-skel-${idx}`} className="h-12 w-full" />
            ))}
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Card className="p-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <p className="text-[11px] uppercase tracking-[0.2em] text-emerald-100/45">Automation</p>
            <h1 className="text-3xl font-extrabold tracking-tight text-emerald-50">Robo Trader</h1>
            <p className="text-sm text-emerald-100/60 mt-1">
              Configure auto-trading guardrails and keep a full audit trail.
            </p>
          </div>
          <Badge variant={settings.enabled ? 'success' : 'neutral'}>
            {settings.enabled ? 'Enabled' : 'Disabled'}
          </Badge>
        </div>

        {error && <p className="mt-4 text-sm text-[#ffb2c1]">{error}</p>}
        {success && <p className="mt-4 text-sm text-[#5dff90]">{success}</p>}

        <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
          <label className="flex items-center justify-between rounded-xl border border-emerald-900/60 bg-[#0f1913] px-4 py-3">
            <span className="text-sm text-emerald-100/80">Robo Trader Enabled</span>
            <button
              type="button"
              className={`relative h-7 w-14 rounded-full transition ${
                settings.enabled ? 'bg-[#00c805]' : 'bg-[#1e2d24]'
              }`}
              onClick={() => setSettings(prev => ({ ...prev, enabled: !prev.enabled }))}
            >
              <span
                className={`absolute top-1 h-5 w-5 rounded-full bg-[#041207] transition ${
                  settings.enabled ? 'left-8' : 'left-1'
                }`}
              />
            </button>
          </label>

          <label className="flex flex-col gap-2 rounded-xl border border-emerald-900/60 bg-[#0f1913] px-4 py-3">
            <span className="text-xs uppercase tracking-wide text-emerald-100/50">Daily Limit ($)</span>
            <input
              type="number"
              min="0"
              value={settings.dailyLimit}
              onChange={event => setSettings(prev => ({ ...prev, dailyLimit: event.target.value }))}
              className="rounded-lg border border-emerald-900/70 bg-[#0a130f] px-3 py-2 text-sm text-emerald-50 focus:outline-none focus:ring-2 focus:ring-[#00c805]/30"
            />
          </label>

          <label className="flex flex-col gap-2 rounded-xl border border-emerald-900/60 bg-[#0f1913] px-4 py-3">
            <span className="text-xs uppercase tracking-wide text-emerald-100/50">Weekly Limit ($)</span>
            <input
              type="number"
              min="0"
              value={settings.weeklyLimit}
              onChange={event => setSettings(prev => ({ ...prev, weeklyLimit: event.target.value }))}
              className="rounded-lg border border-emerald-900/70 bg-[#0a130f] px-3 py-2 text-sm text-emerald-50 focus:outline-none focus:ring-2 focus:ring-[#00c805]/30"
            />
          </label>

          <label className="flex flex-col gap-2 rounded-xl border border-emerald-900/60 bg-[#0f1913] px-4 py-3">
            <span className="text-xs uppercase tracking-wide text-emerald-100/50">Monthly Limit ($)</span>
            <input
              type="number"
              min="0"
              value={settings.monthlyLimit}
              onChange={event => setSettings(prev => ({ ...prev, monthlyLimit: event.target.value }))}
              className="rounded-lg border border-emerald-900/70 bg-[#0a130f] px-3 py-2 text-sm text-emerald-50 focus:outline-none focus:ring-2 focus:ring-[#00c805]/30"
            />
          </label>
        </div>

        <div className="mt-5">
          <Button onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : 'Save Robo Settings'}
          </Button>
        </div>
      </Card>

      <Card className="p-6">
        <h2 className="text-lg font-semibold text-emerald-50">Current Usage</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-4">
          {usageCards.map(item => (
            <div key={item.id} className="rounded-xl border border-emerald-900/60 bg-[#0f1913] p-4">
              <p className="text-xs uppercase tracking-wide text-emerald-100/50">{item.label}</p>
              <p className="text-lg font-semibold text-emerald-50 mt-2">{formatMoney(item.value?.spentNotional)}</p>
              <p className="text-xs text-emerald-100/55 mt-1">
                Limit: {item.value?.limit === null ? 'None' : formatMoney(item.value?.limit)}
              </p>
              <p className="text-xs text-emerald-100/55">
                Remaining: {item.value?.remaining === null ? 'Unlimited' : formatMoney(item.value?.remaining)}
              </p>
            </div>
          ))}
        </div>
      </Card>

      <Card className="p-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <h2 className="text-lg font-semibold text-emerald-50">Robo Audit Trail</h2>
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={from}
              onChange={event => setFrom(event.target.value)}
              className="rounded-lg border border-emerald-900/60 bg-[#0f1913] px-2 py-1.5 text-xs text-emerald-50"
            />
            <input
              type="date"
              value={to}
              onChange={event => setTo(event.target.value)}
              className="rounded-lg border border-emerald-900/60 bg-[#0f1913] px-2 py-1.5 text-xs text-emerald-50"
            />
            <input
              type="number"
              min="1"
              max="500"
              value={limit}
              onChange={event => setLimit(event.target.value)}
              className="w-20 rounded-lg border border-emerald-900/60 bg-[#0f1913] px-2 py-1.5 text-xs text-emerald-50"
            />
            <Button variant="secondary" size="sm" onClick={() => loadAudit({ from, to, limit })}>
              Refresh
            </Button>
          </div>
        </div>

        {auditLoading ? (
          <div className="space-y-3 mt-4">
            {Array.from({ length: 6 }).map((_, idx) => (
              <Skeleton key={`audit-load-${idx}`} className="h-12 w-full" />
            ))}
          </div>
        ) : audit.length === 0 ? (
          <p className="text-sm text-emerald-100/55 mt-4">No robo audit events yet.</p>
        ) : (
          <div className="space-y-3 mt-4">
            {audit.map(event => (
              <div
                key={event._id}
                className="rounded-xl border border-emerald-900/60 bg-[#0f1913] px-4 py-3"
              >
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
                  <p className="text-sm font-semibold text-emerald-50">{mapEventType(event.eventType)}</p>
                  <p className="text-xs text-emerald-100/50">{formatDateTime(event.createdAt)}</p>
                </div>
                <pre className="text-xs text-emerald-100/60 mt-2 whitespace-pre-wrap break-words">
                  {JSON.stringify(event.payload || {}, null, 2)}
                </pre>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
