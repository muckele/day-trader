import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { useParams } from 'react-router-dom';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer
} from 'recharts';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge from '../components/ui/Badge';
import Skeleton from '../components/ui/Skeleton';
import { getCache, setCache } from '../utils/cache';
import { getApiError } from '../utils/api';
import { emitToast } from '../utils/toast';

export default function Stock() {
  const { symbol } = useParams();
  const [intraday,   setIntraday]  = useState([]);
  const [historical, setHistorical]= useState([]);
  const [company,    setCompany]   = useState(null);
  const [stats,      setStats]     = useState(null);
  const [analysis, setAnalysis] = useState('');
  const [aiError, setAiError] = useState('');
  const [aiLoading, setAiLoading] = useState(true);
  const [recommendation, setRecommendation] = useState(null);
  const [paperSettings, setPaperSettings] = useState(null);
  const [account, setAccount] = useState(null);
  const [error,      setError]     = useState('');
  const [loading,    setLoading]   = useState(true);
  const [timeframe, setTimeframe] = useState('1M');
  const [showSma20, setShowSma20] = useState(true);
  const [showSma50, setShowSma50] = useState(true);
  const [showRsi, setShowRsi] = useState(false);
  const [chartLoading, setChartLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [tradeSide, setTradeSide] = useState('buy');
  const [tradeQty, setTradeQty] = useState(1);
  const [tradeError, setTradeError] = useState('');
  const [tradeResult, setTradeResult] = useState(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [aiRetryKey, setAiRetryKey] = useState(0);

  useEffect(() => {
    const fetchWithCache = async (key, ttl, fetcher) => {
      const cached = getCache(key);
      if (cached) return cached;
      const data = await fetcher();
      setCache(key, data, ttl);
      return data;
    };

    const fetchData = async () => {
      setLoading(true);
      setChartLoading(true);
      try {
        const [
          intradayData,
          historicalData,
          companyData,
          recData,
          settingsData,
          accountData
        ] = await Promise.all([
          fetchWithCache(
            `intraday:${symbol}`,
            60 * 1000,
            () => axios.get(`/api/market/intraday/${symbol}`).then(res => res.data)
          ),
          fetchWithCache(
            `historical:${symbol}`,
            5 * 60 * 1000,
            () => axios.get(`/api/market/historical/${symbol}`).then(res => res.data)
          ),
          fetchWithCache(
            `company:${symbol}`,
            5 * 60 * 1000,
            () => axios.get(`/api/company/${symbol}`).then(res => res.data)
          ).catch(() => ({
            company: {
              symbol: symbol.toUpperCase(),
              name: symbol.toUpperCase(),
              exchange: null,
              asset_class: null,
              status: null
            },
            stats: {
              marketcap: null,
              peRatio: null,
              dividendYield: null,
              employees: null
            }
          })),
          fetchWithCache(
            `recommendation:${symbol}`,
            60 * 1000,
            () => axios.get(`/api/recommendations/${symbol}`).then(res => res.data)
          ),
          fetchWithCache(
            'paper-settings',
            10 * 1000,
            () => axios.get('/api/paper-trades/settings').then(res => res.data)
          ),
          fetchWithCache(
            'paper-account',
            5 * 1000,
            () => axios.get('/api/paper-trades/account').then(res => res.data)
          )
        ]);

        setIntraday(intradayData);
        setHistorical(historicalData);
        const resolvedCompany = companyData.company || companyData;
        setCompany(resolvedCompany);
        setStats(companyData.stats || null);
        setRecommendation(recData?.recommendations?.[0] || null);
        setPaperSettings(settingsData);
        setAccount(accountData);
        setError('');
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
        setChartLoading(false);
      }
    };

    fetchData();
  }, [symbol, reloadKey]);

  useEffect(() => {
    let cancelled = false;

    const fetchAnalysis = async () => {
      setAiLoading(true);
      setAiError('');
      try {
        const cacheKey = `analyze:${symbol}`;
        let analyzeData = getCache(cacheKey);
        if (!analyzeData) {
          const res = await axios.get(`/api/analyze/${symbol}`);
          analyzeData = res.data;
          if (analyzeData?.ok !== false) {
            setCache(cacheKey, analyzeData, 60 * 1000);
          }
        }

        if (cancelled) return;

        if (analyzeData?.ok === false) {
          setAnalysis('');
          setAiError(analyzeData.message || 'AI temporarily unavailable');
          return;
        }

        const aiText = analyzeData?.analysis ?? analyzeData?.rationale ?? '';
        setAnalysis(aiText);
      } catch (err) {
        if (cancelled) return;
        setAnalysis('');
        setAiError(getApiError(err));
      } finally {
        if (!cancelled) {
          setAiLoading(false);
        }
      }
    };

    fetchAnalysis();
    return () => {
      cancelled = true;
    };
  }, [symbol, reloadKey, aiRetryKey]);

  const handleRetry = () => {
    setReloadKey(prev => prev + 1);
  };

  const handleAiRetry = () => {
    setAiRetryKey(prev => prev + 1);
  };

  const formatStat = (value, formatter) => {
    if (value === null || value === undefined) return 'N/A';
    return formatter ? formatter(value) : value;
  };

  const timeframes = [
    { id: '1D', label: '1D' },
    { id: '1W', label: '1W' },
    { id: '1M', label: '1M' },
    { id: '3M', label: '3M' },
    { id: '1Y', label: '1Y' }
  ];

  const computeSma = (data, period) => {
    if (!data.length) return [];
    return data.map((point, index) => {
      if (index + 1 < period) return null;
      const slice = data.slice(index + 1 - period, index + 1);
      const avg = slice.reduce((sum, item) => sum + item.close, 0) / period;
      return Number(avg.toFixed(2));
    });
  };

  const computeRsi = (data, period = 14) => {
    if (data.length <= period) return [];
    const rsiValues = Array(data.length).fill(null);
    let gains = 0;
    let losses = 0;
    for (let i = 1; i <= period; i += 1) {
      const change = data[i].close - data[i - 1].close;
      if (change >= 0) gains += change;
      else losses -= change;
    }
    let avgGain = gains / period;
    let avgLoss = losses / period;
    rsiValues[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

    for (let i = period + 1; i < data.length; i += 1) {
      const change = data[i].close - data[i - 1].close;
      const gain = change > 0 ? change : 0;
      const loss = change < 0 ? -change : 0;
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      rsiValues[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
    return rsiValues.map(value => (value === null ? null : Number(value.toFixed(2))));
  };

  const chartData = useMemo(() => {
    const source = timeframe === '1D' ? intraday : historical;
    if (!source.length) return [];
    let filtered = source;
    if (timeframe === '1W') filtered = source.slice(-5);
    if (timeframe === '1M') filtered = source.slice(-22);
    if (timeframe === '3M') filtered = source.slice(-66);
    if (timeframe === '1Y') filtered = source.slice(-252);

    const base = filtered.map(point => ({
      label: point.time ? point.time.slice(11, 16) : point.date,
      close: point.close,
      rawTime: point.time || point.date
    }));
    const sma20 = computeSma(base, 20);
    const sma50 = computeSma(base, 50);
    const rsi = computeRsi(base, 14);

    return base.map((point, idx) => ({
      ...point,
      sma20: sma20[idx],
      sma50: sma50[idx],
      rsi: rsi[idx]
    }));
  }, [historical, intraday, timeframe]);

  const priceInfo = useMemo(() => {
    if (!chartData.length) return null;
    const first = chartData[0].close;
    const last = chartData[chartData.length - 1].close;
    const change = last - first;
    const changePct = first ? (change / first) * 100 : 0;
    return {
      price: last,
      change,
      changePct
    };
  }, [chartData]);

  useEffect(() => {
    if (!chartData.length) return;
    setChartLoading(true);
    const timer = setTimeout(() => setChartLoading(false), 200);
    return () => clearTimeout(timer);
  }, [timeframe, chartData.length]);

  const ChartTooltip = ({ active, payload }) => {
    if (!active || !payload?.length) return null;
    const point = payload[0].payload;
    return (
      <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <p className="text-slate-500">{point.rawTime}</p>
        <p className="font-semibold text-slate-900 dark:text-white">${point.close}</p>
      </div>
    );
  };

  const RsiTooltip = ({ active, payload }) => {
    if (!active || !payload?.length) return null;
    const point = payload[0].payload;
    return (
      <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <p className="text-slate-500">{point.rawTime}</p>
        <p className="font-semibold text-slate-900 dark:text-white">RSI {point.rsi}</p>
      </div>
    );
  };

  const estimatedFillPrice = useMemo(() => {
    if (!priceInfo) return 0;
    const slippage = (paperSettings?.slippageBps || 0) / 10000;
    const multiplier = tradeSide === 'buy' ? 1 + slippage : 1 - slippage;
    return Number((priceInfo.price * multiplier).toFixed(2));
  }, [priceInfo, paperSettings, tradeSide]);

  const estimatedNotional = useMemo(() => {
    if (!estimatedFillPrice) return 0;
    return estimatedFillPrice * tradeQty;
  }, [estimatedFillPrice, tradeQty]);

  const estimatedPositionPct = useMemo(() => {
    if (!account?.equity || !estimatedNotional) return null;
    return (estimatedNotional / account.equity) * 100;
  }, [account, estimatedNotional]);

  const estimatedMaxLoss = useMemo(() => {
    if (!recommendation?.risk?.stop || !estimatedFillPrice) return null;
    const stop = recommendation.risk.stop;
    const perShare = tradeSide === 'buy'
      ? estimatedFillPrice - stop
      : stop - estimatedFillPrice;
    return Math.max(0, perShare) * tradeQty;
  }, [recommendation, estimatedFillPrice, tradeSide, tradeQty]);

  const handleSubmitTrade = async () => {
    setIsSubmitting(true);
    setTradeError('');
    try {
      const res = await axios.post('/api/paper-trades/order', {
        symbol,
        side: tradeSide,
        qty: tradeQty,
        orderType: 'market',
        strategyId: recommendation?.strategy?.strategyId || null,
        setupType: recommendation?.setupType || null,
        strategyTags: recommendation?.strategy?.tags || null,
        stopPrice: recommendation?.risk?.stop || null
      });
      setTradeResult(res.data);
      setAccount(res.data.account || account);
      setConfirmOpen(false);
      emitToast({
        type: 'success',
        title: 'Order placed',
        message: `${tradeSide.toUpperCase()} ${tradeQty} ${symbol} @ $${res.data.order?.fillPrice}`
      });
    } catch (err) {
      const message = getApiError(err);
      setTradeError(message);
      emitToast({
        type: 'error',
        title: 'Trade blocked',
        message
      });
    } finally {
      setIsSubmitting(false);
    }
  };

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
  if (loading || !company) {
    return (
      <div className="space-y-6">
        <Card className="p-6">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-8 w-64 mt-4" />
          <Skeleton className="h-48 w-full mt-6" />
        </Card>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, idx) => (
            <Skeleton key={`stat-skel-${idx}`} className="h-16 w-full" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col lg:flex-row lg:items-start gap-6">
        <div className="flex-1">
          <Card className="p-6">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-wide text-slate-500">Stock</p>
                <h1 className="text-3xl font-bold text-slate-900 dark:text-white">
                  {company.name} <span className="text-slate-400">({symbol})</span>
                </h1>
              </div>
              {priceInfo && (
                <div className="text-right">
                  <p className="text-2xl font-semibold text-slate-900 dark:text-white">
                    ${priceInfo.price.toFixed(2)}
                  </p>
                  <p className={`${priceInfo.change >= 0 ? 'text-emerald-500' : 'text-red-500'} text-sm`}>
                    {priceInfo.change >= 0 ? '+' : ''}
                    {priceInfo.change.toFixed(2)} ({priceInfo.changePct.toFixed(2)}%)
                  </p>
                </div>
              )}
            </div>

            <div className="flex flex-wrap gap-2 my-4">
              {timeframes.map(frame => (
                <Button
                  key={frame.id}
                  size="sm"
                  variant={timeframe === frame.id ? 'primary' : 'secondary'}
                  onClick={() => setTimeframe(frame.id)}
                >
                  {frame.label}
                </Button>
              ))}
            </div>

            <div className="relative h-64">
              {chartLoading && (
                <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/70 dark:bg-slate-900/70">
                  <Skeleton className="h-40 w-full" />
                </div>
              )}
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData}>
                  <XAxis dataKey="label" hide />
                  <YAxis domain={['auto', 'auto']} hide />
                  <Tooltip content={<ChartTooltip />} />
                  <Line type="monotone" dataKey="close" stroke="#111827" dot={false} strokeWidth={2} />
                  {showSma20 && (
                    <Line type="monotone" dataKey="sma20" stroke="#10B981" dot={false} strokeWidth={1.5} />
                  )}
                  {showSma50 && (
                    <Line type="monotone" dataKey="sma50" stroke="#3B82F6" dot={false} strokeWidth={1.5} />
                  )}
                </LineChart>
              </ResponsiveContainer>
            </div>

            <div className="mt-4 flex flex-wrap gap-4 text-sm text-slate-600 dark:text-slate-300">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={showSma20}
                  onChange={() => setShowSma20(!showSma20)}
                />
                SMA 20
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={showSma50}
                  onChange={() => setShowSma50(!showSma50)}
                />
                SMA 50
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={showRsi}
                  onChange={() => setShowRsi(!showRsi)}
                />
                RSI 14
              </label>
            </div>

            {showRsi && (
              <div className="mt-4 h-24">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData}>
                    <XAxis dataKey="label" hide />
                    <YAxis domain={[0, 100]} hide />
                    <Tooltip content={<RsiTooltip />} />
                    <Line type="monotone" dataKey="rsi" stroke="#f97316" dot={false} strokeWidth={1.5} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-6 text-sm">
              <div>
                <p className="text-xs text-slate-500">Market Cap</p>
                <p className="font-medium">
                  {formatStat(stats?.marketcap, value => `$${(value / 1e9).toFixed(2)}B`)}
                </p>
              </div>
              <div>
                <p className="text-xs text-slate-500">P/E Ratio</p>
                <p className="font-medium">
                  {formatStat(stats?.peRatio, value => value.toFixed(2))}
                </p>
              </div>
              <div>
                <p className="text-xs text-slate-500">Dividend Yield</p>
                <p className="font-medium">
                  {formatStat(stats?.dividendYield, value => `${value}%`)}
                </p>
              </div>
              <div>
                <p className="text-xs text-slate-500">Employees</p>
                <p className="font-medium">
                  {formatStat(stats?.employees, value => value.toLocaleString())}
                </p>
              </div>
            </div>
          </Card>
        </div>

        <aside className="w-full lg:w-80 space-y-6">
          <Card className="p-6">
            <p className="text-xs uppercase tracking-wide text-slate-500">AI Analysis</p>
            {aiLoading ? (
              <div className="mt-3 space-y-2">
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-11/12" />
                <Skeleton className="h-3 w-4/5" />
              </div>
            ) : aiError ? (
              <>
                <p className="mt-3 text-sm text-amber-600">{aiError}</p>
                <Button variant="secondary" size="sm" className="mt-3" onClick={handleAiRetry}>
                  Retry
                </Button>
              </>
            ) : (
              <p className="mt-3 text-sm text-slate-700 dark:text-slate-200">
                {analysis || 'No AI analysis available.'}
              </p>
            )}
          </Card>

          <Card className="p-6">
            <p className="text-xs uppercase tracking-wide text-slate-500">Trade Idea</p>
            {recommendation ? (
              <>
                <div className="mt-2 flex items-center justify-between">
                  <p className="text-lg font-semibold text-slate-900 dark:text-white">{recommendation.bias}</p>
                  {recommendation.score && (
                    <Badge variant="neutral">
                      {recommendation.score.label} {recommendation.score.value}
                    </Badge>
                  )}
                </div>
                <div className="mt-3 text-sm text-slate-600 dark:text-slate-300 space-y-2">
                  <p>Entry: ${recommendation.entry?.price}</p>
                  <p>Stop: ${recommendation.risk?.stop}</p>
                  <p>Take Profit: ${recommendation.risk?.takeProfit?.[0]}</p>
                  <p>Horizon: {recommendation.risk?.timeHorizon}</p>
                  <p>Size: {recommendation.risk?.positionSizePct}%</p>
                </div>
                <div className="mt-4">
                  <p className="text-sm font-semibold text-slate-900 dark:text-white">Why now</p>
                  <ul className="mt-2 text-sm text-slate-600 dark:text-slate-300 list-disc list-inside">
                    {(recommendation.rationale || []).map(item => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
                {recommendation.strategy && (
                  <div className="mt-4 text-xs text-slate-500">
                    Strategy {recommendation.strategy.strategyId} · {recommendation.strategy.expectedHold}
                  </div>
                )}
                <div className="mt-4 text-xs text-slate-500">
                  {recommendation.disclaimer}
                </div>
              </>
            ) : (
              <p className="text-sm text-slate-500 mt-2">No trade idea available.</p>
            )}
          </Card>

          {recommendation && (
            <Card className="p-6">
              <p className="text-xs uppercase tracking-wide text-slate-500">Quality Gate</p>
              <div className="mt-3 flex items-center justify-between">
                <span className="text-sm font-semibold text-slate-900 dark:text-white">
                  {recommendation.qualityGate?.passed ? 'Passed' : 'Blocked'}
                </span>
                <Badge variant={recommendation.qualityGate?.passed ? 'success' : 'warning'}>
                  {recommendation.qualityGate?.passed ? 'OK' : 'Review'}
                </Badge>
              </div>
              <div className="mt-3 text-xs text-slate-500 space-y-1">
                <p>Liquidity score {recommendation.qualityGate?.liquidityScore}</p>
                <p>Volatility score {recommendation.qualityGate?.volatilityScore}</p>
                {recommendation.qualityGate?.blockedReasons?.length > 0 && (
                  <p className="text-amber-600">
                    {recommendation.qualityGate.blockedReasons[0]}
                  </p>
                )}
              </div>
            </Card>
          )}

          {recommendation?.regime && (
            <Card className="p-6">
              <p className="text-xs uppercase tracking-wide text-slate-500">Market Regime</p>
              <div className="mt-3 text-sm text-slate-600 dark:text-slate-300 space-y-1">
                <p>Trend/Chop: {recommendation.regime.trendChop}</p>
                <p>Volatility: {recommendation.regime.vol}</p>
                <p>Risk: {recommendation.regime.risk}</p>
              </div>
              {recommendation.regime.notes?.length > 0 && (
                <p className="mt-2 text-xs text-slate-500">
                  {recommendation.regime.notes[0]}
                </p>
              )}
            </Card>
          )}

          <Card className="p-6">
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs uppercase tracking-wide text-slate-500">Paper Trade</p>
              <Badge variant="solid">PAPER MODE</Badge>
            </div>
            <div className="flex gap-2 mb-3">
              <Button
                variant={tradeSide === 'buy' ? 'primary' : 'secondary'}
                size="sm"
                className="flex-1"
                onClick={() => setTradeSide('buy')}
              >
                Buy
              </Button>
              <Button
                variant={tradeSide === 'sell' ? 'danger' : 'secondary'}
                size="sm"
                className="flex-1"
                onClick={() => setTradeSide('sell')}
              >
                Sell
              </Button>
            </div>
            <label className="text-xs text-slate-500">Quantity</label>
            <input
              type="number"
              min="1"
              value={tradeQty}
              onChange={event => setTradeQty(Number(event.target.value))}
              className="mt-1 w-full border border-slate-200/80 dark:border-slate-700 rounded-lg px-3 py-2 text-sm bg-white dark:bg-slate-900"
            />
            <div className="mt-2 text-xs text-slate-500">
              Est. fill ${estimatedFillPrice || '--'} · Notional {estimatedNotional ? `$${estimatedNotional.toFixed(2)}` : '--'}
            </div>
            <Button
              onClick={() => setConfirmOpen(true)}
              className="mt-4 w-full"
            >
              Review Paper Trade
            </Button>
            {tradeError && <p className="text-xs text-red-600 mt-2">{tradeError}</p>}
            {tradeResult && (
              <div className="mt-3 text-xs text-slate-600 dark:text-slate-400">
                Filled {tradeResult.order?.side?.toUpperCase()} {tradeResult.order?.qty} @ $
                {tradeResult.order?.fillPrice}
              </div>
            )}
          </Card>
        </aside>
      </div>

      {confirmOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center px-4 z-50">
          <Card className="p-6 max-w-sm w-full">
            <p className="text-sm font-semibold text-slate-900 dark:text-white mb-2">Confirm Paper Trade</p>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              {tradeSide.toUpperCase()} {tradeQty} {symbol}
            </p>
            <div className="mt-3 space-y-1 text-xs text-slate-500">
              <p>Estimated fill ${estimatedFillPrice || '--'}</p>
              <p>Slippage {paperSettings?.slippageBps || 0} bps · Commission ${paperSettings?.commission || 0}</p>
              <p>
                Position size {estimatedPositionPct ? `${estimatedPositionPct.toFixed(2)}%` : '--'}
              </p>
              <p>
                Max loss on stop {estimatedMaxLoss !== null ? `$${estimatedMaxLoss.toFixed(2)}` : '--'}
              </p>
            </div>
            <div className="flex gap-2 mt-4">
              <Button
                onClick={handleSubmitTrade}
                disabled={isSubmitting}
                className="flex-1"
              >
                {isSubmitting ? 'Submitting...' : 'Confirm'}
              </Button>
              <Button
                variant="secondary"
                onClick={() => setConfirmOpen(false)}
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
