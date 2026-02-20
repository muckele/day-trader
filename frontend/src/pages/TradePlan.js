import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import Card from '../components/ui/Card';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import Skeleton from '../components/ui/Skeleton';
import { useMarketStatus } from '../hooks/useMarketStatus';
import { getApiError } from '../utils/api';
import { emitToast } from '../utils/toast';

export default function TradePlan() {
  const navigate = useNavigate();
  const { status } = useMarketStatus();
  const [plan, setPlan] = useState(null);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedIdea, setSelectedIdea] = useState(null);
  const [executionCheck, setExecutionCheck] = useState(null);
  const [checkingExecution, setCheckingExecution] = useState(false);
  const [executing, setExecuting] = useState(false);

  const fetchPlan = async (rescore = false) => {
    if (rescore) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    try {
      const res = await axios.get('/api/trade-plan/today', {
        params: rescore ? { rescore: 1 } : {}
      });
      setPlan(res.data.plan);
    } catch (err) {
      emitToast({ type: 'error', message: getApiError(err) });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const fetchHistory = async () => {
    try {
      const res = await axios.get('/api/trade-plan/history', { params: { days: 14 } });
      setHistory(res.data.history || []);
    } catch (err) {
      emitToast({ type: 'error', message: getApiError(err) });
    }
  };

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const res = await axios.post('/api/trade-plan/generate');
      setPlan(res.data.plan);
      emitToast({ type: 'success', message: 'Daily trade plan generated.' });
      fetchHistory();
    } catch (err) {
      emitToast({ type: 'error', message: getApiError(err) });
    } finally {
      setGenerating(false);
    }
  };

  const handleSkip = async ideaId => {
    if (!plan?._id) return;
    try {
      const res = await axios.put(`/api/trade-plan/${plan._id}/ideas/${ideaId}`, {
        status: 'SKIPPED'
      });
      setPlan(res.data.plan);
      emitToast({ type: 'success', message: 'Trade idea marked as skipped.' });
      fetchHistory();
    } catch (err) {
      emitToast({ type: 'error', message: getApiError(err) });
    }
  };

  const handleReviewExecute = async idea => {
    if (!plan?._id) return;
    setSelectedIdea(idea);
    setCheckingExecution(true);
    try {
      const res = await axios.post('/api/execution/check', {
        planId: plan._id,
        ideaId: idea._id
      });
      setExecutionCheck(res.data);
    } catch (err) {
      emitToast({ type: 'error', message: getApiError(err) });
      setExecutionCheck(null);
    } finally {
      setCheckingExecution(false);
    }
  };

  const handleExecute = async () => {
    if (!selectedIdea || !executionCheck?.eligible) return;
    const qty = executionCheck.projectedStats?.recommendedQty || 0;
    if (!qty) {
      emitToast({ type: 'error', message: 'Unable to calculate position size.' });
      return;
    }

    setExecuting(true);
    try {
      await axios.post('/api/paper-trades/order', {
        symbol: selectedIdea.symbol,
        side: selectedIdea.bias === 'SHORT' ? 'sell' : 'buy',
        qty,
        orderType: 'market',
        strategyId: selectedIdea.strategyId,
        stopPrice: selectedIdea.stop
      });
      emitToast({ type: 'success', message: 'Paper trade executed.' });
      setSelectedIdea(null);
      setExecutionCheck(null);
      fetchPlan();
      fetchHistory();
    } catch (err) {
      emitToast({ type: 'error', message: getApiError(err) });
    } finally {
      setExecuting(false);
    }
  };

  useEffect(() => {
    fetchPlan();
    fetchHistory();
  }, []);

  useEffect(() => {
    if (status !== 'OPEN') return undefined;
    const interval = setInterval(() => fetchPlan(true), 15 * 60 * 1000);
    return () => clearInterval(interval);
  }, [status]);

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <Card className="p-6">
          <Skeleton className="h-40 w-full" />
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-400">Trade Plan</p>
          <h1 className="text-3xl font-bold text-slate-900 dark:text-white">Daily Playbook</h1>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={status === 'OPEN' ? 'success' : 'neutral'}>
            {status === 'OPEN' ? 'Market Open' : 'Market Closed'}
          </Badge>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => fetchPlan(true)}
            disabled={!plan || refreshing}
          >
            {refreshing ? 'Rescoring...' : 'Rescore'}
          </Button>
          <Button
            size="sm"
            onClick={handleGenerate}
            disabled={generating || status !== 'OPEN'}
          >
            {generating ? 'Generating...' : 'Generate Plan'}
          </Button>
        </div>
      </div>

      {!plan ? (
        <Card className="p-6 text-sm text-slate-600 dark:text-slate-300">
          <p>No plan for today yet.</p>
          <p className="mt-2 text-xs text-slate-500">
            Generate a plan during market hours to see structured trade ideas.
          </p>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <Card className="p-6">
              <p className="text-sm font-semibold text-slate-900 dark:text-white">Regime</p>
              <div className="mt-3 text-sm text-slate-600 dark:text-slate-300 space-y-1">
                <p>Trend/Chop: {plan.regime?.trendChop || '--'}</p>
                <p>Volatility: {plan.regime?.vol || '--'}</p>
                <p>Risk: {plan.regime?.risk || '--'}</p>
              </div>
              {plan.regime?.notes?.length ? (
                <p className="mt-3 text-xs text-slate-500">{plan.regime.notes[0]}</p>
              ) : null}
            </Card>
            <Card className="p-6 lg:col-span-2">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-slate-900 dark:text-white">Ranked Strategies</p>
                <Badge variant="neutral">Top {plan.rankedStrategies?.length || 0}</Badge>
              </div>
              <div className="mt-4 space-y-2 text-sm">
                {plan.rankedStrategies?.map(item => (
                  <div
                    key={item.strategyId}
                    className="flex flex-wrap items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-2"
                  >
                    <div>
                      <p className="font-semibold">{item.strategyId}</p>
                      <p className="text-xs text-slate-500">
                        {item.tradeCount} trades · {item.winRate}% win
                        {item.sampleAdjusted ? ' · Sample adjusted' : ''}
                      </p>
                    </div>
                    <div className="text-right text-xs text-slate-500">
                      <p>Score {item.score}</p>
                      <p>Expectancy {item.expectancy ?? '--'} · Align {item.alignmentScore}%</p>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </div>

          <Card className="p-6">
            <div className="flex items-center justify-between mb-4">
              <div>
                <p className="text-sm font-semibold text-slate-900 dark:text-white">Trade Ideas</p>
                <p className="text-xs text-slate-500">
                  Total suggested exposure {plan.totalSuggestedExposurePct}% (cap 20%)
                </p>
              </div>
            </div>
            {plan.tradeIdeas?.length ? (
              <div className="space-y-3">
                {plan.tradeIdeas.map(idea => (
                  <div
                    key={idea._id}
                    className="border border-slate-100 dark:border-slate-800 rounded-lg p-4 text-sm"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="text-lg font-semibold text-slate-900 dark:text-white">
                          {idea.symbol}
                        </p>
                        <p className="text-xs text-slate-500">
                          {idea.strategyId} · {idea.bias}
                        </p>
                      </div>
                      <Badge variant={idea.status === 'EXECUTED' ? 'success' : idea.status === 'SKIPPED' ? 'warning' : 'neutral'}>
                        {idea.status}
                      </Badge>
                    </div>
                    <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-3 text-xs text-slate-600 dark:text-slate-300">
                      <div>Entry ${idea.entry}</div>
                      <div>Stop ${idea.stop}</div>
                      <div>Target ${idea.target}</div>
                      <div>Size {idea.positionSizePct}%</div>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-3 text-xs text-slate-500">
                      <span>Confidence {idea.confidenceScore}</span>
                      <span>Alignment {idea.alignmentScore}%</span>
                    </div>
                    <p className="mt-2 text-xs text-slate-500">{idea.reason}</p>
                    <div className="mt-4 flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        onClick={() => handleReviewExecute(idea)}
                        disabled={checkingExecution || idea.status !== 'PENDING'}
                      >
                        {checkingExecution && selectedIdea?._id === idea._id
                          ? 'Checking...'
                          : 'Review & Execute'}
                      </Button>
                      {idea.status === 'PENDING' && (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => handleSkip(idea._id)}
                        >
                          Mark Skipped
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-slate-500">No eligible ideas today.</p>
            )}
          </Card>
        </>
      )}

      <Card className="p-6">
        <p className="text-sm font-semibold text-slate-900 dark:text-white">Plan History (14 days)</p>
        {history.length ? (
          <div className="mt-4 space-y-3 text-sm">
            {history.map(item => (
              <div key={item._id} className="border border-slate-100 dark:border-slate-800 rounded-lg p-3">
                <div className="flex items-center justify-between">
                  <p className="font-semibold">{item.date}</p>
                  <span className="text-xs text-slate-500">{item.tradeIdeas?.length || 0} ideas</span>
                </div>
                <div className="mt-2 grid grid-cols-2 md:grid-cols-4 gap-2 text-xs text-slate-500">
                  <div>Executed {item.metrics?.executedCount || 0}</div>
                  <div>Win {item.metrics?.winRatePlanned || 0}%</div>
                  <div>Expectancy {item.metrics?.planExpectancy ?? '--'}</div>
                  <div>Missed winners {item.metrics?.missedWinners ?? 0}</div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-3 text-sm text-slate-500">No plan history yet.</p>
        )}
      </Card>

      {selectedIdea && executionCheck && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center px-4 z-50">
          <Card className="p-6 max-w-lg w-full">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold text-slate-900 dark:text-white">
                  {selectedIdea.symbol} Execution Check
                </p>
                <p className="text-xs text-slate-500">
                  {selectedIdea.strategyId} · {selectedIdea.bias}
                </p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => {
                setSelectedIdea(null);
                setExecutionCheck(null);
              }}>
                Close
              </Button>
            </div>

            <div className="mt-4 space-y-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-xs text-slate-500">Eligibility</span>
                <Badge variant={executionCheck.eligible ? 'success' : 'warning'}>
                  {executionCheck.eligible ? 'Eligible' : 'Blocked'}
                </Badge>
              </div>

              <div className="grid grid-cols-2 gap-3 text-xs text-slate-600 dark:text-slate-300">
                <div>
                  <p className="text-slate-500">Expectancy</p>
                  <p>{executionCheck.strategyStats.expectancy ?? '--'}</p>
                </div>
                <div>
                  <p className="text-slate-500">Sharpe-like</p>
                  <p>{executionCheck.strategyStats.sharpeLike ?? '--'}</p>
                </div>
                <div>
                  <p className="text-slate-500">Trade Count</p>
                  <p>{executionCheck.strategyStats.tradeCount}</p>
                </div>
                <div>
                  <p className="text-slate-500">Recent Avg R</p>
                  <p>{executionCheck.strategyStats.recentAvgR ?? '--'}</p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 text-xs text-slate-600 dark:text-slate-300">
                <div>
                  <p className="text-slate-500">Daily Drawdown</p>
                  <p>{executionCheck.accountStats.dailyDrawdown}%</p>
                </div>
                <div>
                  <p className="text-slate-500">Exposure</p>
                  <p>{executionCheck.accountStats.exposurePct}%</p>
                </div>
                <div>
                  <p className="text-slate-500">Consecutive Losses</p>
                  <p>{executionCheck.accountStats.consecutiveLosses}</p>
                </div>
                <div>
                  <p className="text-slate-500">Post-Trade Exposure</p>
                  <p>{executionCheck.projectedStats.postTradeExposurePct}%</p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 text-xs text-slate-600 dark:text-slate-300">
                <div>
                  <p className="text-slate-500">Projected Risk</p>
                  <p>{executionCheck.projectedStats.projectedRiskPct ?? '--'}%</p>
                </div>
                <div>
                  <p className="text-slate-500">Recommended Qty</p>
                  <p>{executionCheck.projectedStats.recommendedQty}</p>
                </div>
              </div>

              {executionCheck.reasonsBlocked.length > 0 && (
                <div className="rounded-lg border border-amber-200/60 bg-amber-50/70 px-3 py-2 text-xs text-amber-700">
                  <p className="font-semibold">Blocked reasons</p>
                  <ul className="mt-1 list-disc list-inside">
                    {executionCheck.reasonsBlocked.map(reason => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            <div className="mt-4 flex gap-2">
              <Button
                onClick={handleExecute}
                disabled={!executionCheck.eligible || executing}
                className="flex-1"
              >
                {executing ? 'Executing...' : 'Confirm Paper Trade'}
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setSelectedIdea(null);
                  setExecutionCheck(null);
                }}
                className="flex-1"
              >
                Cancel
              </Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
