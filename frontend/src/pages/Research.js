import React, { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { useNavigate, useParams } from 'react-router-dom';
import Card from '../components/ui/Card';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import Skeleton from '../components/ui/Skeleton';
import ResearchChart from '../components/ResearchChart';
import { getApiError } from '../utils/api';
import { getCache, setCache } from '../utils/cache';
import { emitToast } from '../utils/toast';

const DEFAULT_SYMBOLS = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOG', 'META', 'TSLA', 'AMD'];
const DEFAULT_SCREENER_FILTERS = {
  symbols: DEFAULT_SYMBOLS.join(', '),
  minMomentum: '',
  maxVolatility: '',
  minVolumeRatio: '',
  newsSentiment: 'any',
  earningsWithinDays: '',
  sector: '',
  trend: 'any'
};
const SECTOR_OPTIONS = ['', 'TECHNOLOGY', 'COMMUNICATION', 'CONSUMER', 'FINANCIALS', 'INDEX', 'OTHER'];
const TREND_OPTIONS = ['any', 'uptrend', 'mixed', 'downtrend', 'insufficient_data'];
const DEFAULT_TRADE_TICKET = {
  side: 'buy',
  qty: '',
  orderType: 'market',
  limitPrice: '',
  positionSizePct: '',
  allowExtendedHours: true
};

function normalizeSymbol(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9./-]/g, '');
}

function formatCurrency(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 'N/A';
  return `$${numeric.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 'N/A';
  return `${numeric > 0 ? '+' : ''}${numeric.toFixed(2)}%`;
}

function formatNumber(value, suffix = '') {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 'N/A';
  return `${numeric.toLocaleString(undefined, { maximumFractionDigits: 2 })}${suffix}`;
}

function getSentimentVariant(sentiment) {
  if (sentiment === 'positive') return 'success';
  if (sentiment === 'negative') return 'danger';
  return 'neutral';
}

function getHealthVariant(status) {
  if (status === 'ok' || status === 'configured') return 'success';
  if (status === 'disabled') return 'warning';
  if (status === 'error') return 'danger';
  return 'neutral';
}

function formatDateTime(value) {
  if (!value) return 'N/A';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'N/A';
  return date.toLocaleString();
}

function formatEventType(value) {
  return String(value || '').replace(/_/g, ' ');
}

function uniqueWarnings(...groups) {
  return [...new Set(groups.flatMap(group => Array.isArray(group) ? group : []).filter(Boolean))];
}

function formatCitationTimestamp(value) {
  const formatted = formatDateTime(value);
  return formatted === 'N/A' ? 'No timestamp' : formatted;
}

function alertNeedsThreshold(type) {
  return !['news_keyword', 'thesis_change'].includes(type);
}

function getTicketValue(value) {
  return value === null || value === undefined || value === '' ? 'N/A' : value;
}

function Metric({ label, value, accent = false }) {
  return (
    <div className="rt-metric">
      <p className="rt-label">{label}</p>
      <p className={`mt-2 text-xl font-bold ${accent ? 'text-[#8cf5bd]' : 'text-[#edf5f4]'}`}>{value}</p>
    </div>
  );
}

export default function Research() {
  const { symbol: routeSymbol } = useParams();
  const navigate = useNavigate();
  const stockRequestIdRef = useRef(0);
  const [selectedSymbol, setSelectedSymbol] = useState(normalizeSymbol(routeSymbol) || 'AAPL');
  const [symbolInput, setSymbolInput] = useState(normalizeSymbol(routeSymbol) || 'AAPL');
  const [dashboard, setDashboard] = useState(null);
  const [stock, setStock] = useState(null);
  const [compare, setCompare] = useState(null);
  const [compareInput, setCompareInput] = useState('AAPL, MSFT, NVDA');
  const [activeTab, setActiveTab] = useState('chart');
  const [loadingDashboard, setLoadingDashboard] = useState(true);
  const [loadingStock, setLoadingStock] = useState(true);
  const [error, setError] = useState('');
  const [noteTitle, setNoteTitle] = useState('');
  const [noteBody, setNoteBody] = useState('');
  const [noteTags, setNoteTags] = useState('');
  const [noteStance, setNoteStance] = useState('neutral');
  const [alertType, setAlertType] = useState('price_above');
  const [alertThreshold, setAlertThreshold] = useState('');
  const [alertKeyword, setAlertKeyword] = useState('');
  const [screenerFilters, setScreenerFilters] = useState(DEFAULT_SCREENER_FILTERS);
  const [screener, setScreener] = useState(null);
  const [loadingScreener, setLoadingScreener] = useState(false);
  const [savedWatchlists, setSavedWatchlists] = useState([]);
  const [selectedWatchlistId, setSelectedWatchlistId] = useState('');
  const [watchlistForm, setWatchlistForm] = useState({
    name: '',
    description: '',
    symbols: DEFAULT_SYMBOLS.join(', '),
    pinnedSymbols: ''
  });
  const [watchlistSummary, setWatchlistSummary] = useState(null);
  const [loadingWatchlistSummary, setLoadingWatchlistSummary] = useState(false);
  const [tradeTicket, setTradeTicket] = useState(DEFAULT_TRADE_TICKET);
  const [tradePreview, setTradePreview] = useState(null);
  const [loadingTradePreview, setLoadingTradePreview] = useState(false);
  const [creatingTradePlan, setCreatingTradePlan] = useState(false);
  const [submittingPaperTrade, setSubmittingPaperTrade] = useState(false);

  useEffect(() => {
    const next = normalizeSymbol(routeSymbol) || 'AAPL';
    setSelectedSymbol(next);
    setSymbolInput(next);
  }, [routeSymbol]);

  useEffect(() => {
    let cancelled = false;
    const fetchDashboard = async () => {
      setLoadingDashboard(true);
      const cacheKey = `research-dashboard:${DEFAULT_SYMBOLS.join(',')}`;
      const cached = getCache(cacheKey);
      if (cached) {
        setDashboard(cached);
        setLoadingDashboard(false);
      }
      try {
        const res = await axios.get('/api/research/dashboard', {
          params: { symbols: DEFAULT_SYMBOLS.join(',') }
        });
        if (cancelled) return;
        setDashboard(res.data);
        setCache(cacheKey, res.data, 60 * 1000);
      } catch (err) {
        if (!cancelled) setError(getApiError(err));
      } finally {
        if (!cancelled) setLoadingDashboard(false);
      }
    };
    fetchDashboard();
    return () => {
      cancelled = true;
    };
  }, []);

  const fetchStock = async symbol => {
    const requestId = stockRequestIdRef.current + 1;
    stockRequestIdRef.current = requestId;
    setLoadingStock(true);
    setError('');
    const cacheKey = `research-stock:${symbol}`;
    const cached = getCache(cacheKey);
    if (cached && stockRequestIdRef.current === requestId) {
      setStock(cached);
      setLoadingStock(false);
    }
    try {
      const res = await axios.get(`/api/research/stock/${symbol}`);
      if (stockRequestIdRef.current !== requestId) return;
      setStock(res.data);
      setCache(cacheKey, res.data, 60 * 1000);
      setNoteTitle('');
      setNoteBody('');
      setNoteTags('');
    } catch (err) {
      if (stockRequestIdRef.current !== requestId) return;
      const message = getApiError(err);
      setError(message);
      emitToast({ type: 'error', message });
    } finally {
      if (stockRequestIdRef.current === requestId) setLoadingStock(false);
    }
  };

  const fetchCompare = async (symbols = compareInput) => {
    try {
      const res = await axios.get('/api/research/compare', {
        params: { symbols }
      });
      setCompare(res.data);
    } catch (err) {
      emitToast({ type: 'error', message: getApiError(err) });
    }
  };

  const fetchScreener = async (filters = screenerFilters) => {
    setLoadingScreener(true);
    try {
      const res = await axios.get('/api/research/screener', {
        params: filters
      });
      setScreener(res.data);
    } catch (err) {
      emitToast({ type: 'error', message: getApiError(err) });
    } finally {
      setLoadingScreener(false);
    }
  };

  const selectWatchlist = watchlist => {
    if (!watchlist) return;
    setSelectedWatchlistId(watchlist._id);
    setWatchlistSummary(watchlist.summarySnapshot || null);
    setWatchlistForm({
      name: watchlist.name || '',
      description: watchlist.description || '',
      symbols: (watchlist.symbols || []).join(', '),
      pinnedSymbols: (watchlist.pinnedSymbols || []).join(', ')
    });
  };

  const fetchWatchlists = async (preferredWatchlistId = '') => {
    try {
      const res = await axios.get('/api/research/watchlists');
      const lists = res.data || [];
      setSavedWatchlists(lists);
      const preferred = preferredWatchlistId
        ? lists.find(item => item._id === preferredWatchlistId)
        : null;
      if (preferred) {
        selectWatchlist(preferred);
      } else if (!selectedWatchlistId && lists[0]) {
        selectWatchlist(lists[0]);
      }
    } catch (err) {
      emitToast({ type: 'error', message: getApiError(err) });
    }
  };

  const fetchWatchlistSummary = async (watchlistId = selectedWatchlistId) => {
    if (!watchlistId) return;
    setLoadingWatchlistSummary(true);
    try {
      const res = await axios.get(`/api/research/watchlists/${watchlistId}/summary`);
      setWatchlistSummary(res.data);
    } catch (err) {
      emitToast({ type: 'error', message: getApiError(err) });
    } finally {
      setLoadingWatchlistSummary(false);
    }
  };

  const fetchTradePreview = async (overrides = tradeTicket) => {
    setLoadingTradePreview(true);
    try {
      const res = await axios.post(`/api/research/trade-workflow/${selectedSymbol}/preview`, overrides);
      setTradePreview(res.data);
      setTradeTicket(prev => ({
        ...prev,
        side: res.data?.ticket?.side || prev.side,
        qty: prev.qty || (res.data?.ticket?.qty ? String(res.data.ticket.qty) : ''),
        positionSizePct: prev.positionSizePct || (res.data?.ticket?.positionSizePct ? String(res.data.ticket.positionSizePct) : ''),
        limitPrice: prev.limitPrice || (res.data?.ticket?.limitPrice ? String(res.data.ticket.limitPrice) : '')
      }));
      return res.data;
    } catch (err) {
      emitToast({ type: 'error', message: getApiError(err) });
      return null;
    } finally {
      setLoadingTradePreview(false);
    }
  };

  const createTradePlanFromThesis = async () => {
    setCreatingTradePlan(true);
    try {
      const res = await axios.post(`/api/research/trade-workflow/${selectedSymbol}/plan`, tradeTicket);
      setTradePreview(res.data.preview);
      emitToast({ type: 'success', message: res.data.updatedExistingIdea ? 'Research trade plan updated.' : 'Research trade plan created.' });
    } catch (err) {
      if (err.response?.data?.preview) setTradePreview(err.response.data.preview);
      emitToast({ type: 'error', message: getApiError(err) });
    } finally {
      setCreatingTradePlan(false);
    }
  };

  const submitPaperTradeFromResearch = async () => {
    setSubmittingPaperTrade(true);
    try {
      const preview = await fetchTradePreview(tradeTicket);
      if (!preview?.ticket) return;
      if (!preview.risk?.eligible) {
        emitToast({ type: 'error', message: 'Risk checks must pass before submitting a paper trade.' });
        return;
      }
      const ticket = preview.ticket;
      const res = await axios.post('/api/paper-trades/order', {
        symbol: ticket.symbol,
        assetClass: ticket.assetClass,
        side: ticket.side,
        qty: ticket.qty,
        orderType: ticket.orderType,
        timeInForce: ticket.timeInForce,
        limitPrice: ticket.orderType === 'limit' ? ticket.limitPrice : null,
        stopPrice: ticket.stopLossPrice,
        stopLossPrice: ticket.stopLossPrice,
        takeProfitPrice: ticket.takeProfitPrice,
        maxPricePerShare: ticket.maxPricePerShare,
        allowExtendedHours: ticket.allowExtendedHours,
        strategyId: ticket.strategyId,
        setupType: ticket.setupType,
        strategyTags: ticket.strategyTags,
        origin: 'research',
        metadata: {
          source: 'research_trade_workflow',
          researchSnapshot: preview.researchSnapshot,
          riskPreview: preview.risk
        }
      });
      const status = String(res.data?.order?.status || '').toLowerCase();
      emitToast({
        type: status === 'rejected' ? 'error' : 'success',
        message: status === 'rejected'
          ? (res.data?.order?.rejectedReason || 'Paper order was rejected.')
          : (status === 'filled' ? 'Research paper trade filled.' : 'Research paper order submitted.')
      });
    } catch (err) {
      emitToast({ type: 'error', message: getApiError(err) });
    } finally {
      setSubmittingPaperTrade(false);
    }
  };

  const saveWatchlist = async event => {
    event.preventDefault();
    const payload = {
      name: watchlistForm.name,
      description: watchlistForm.description,
      symbols: watchlistForm.symbols,
      pinnedSymbols: watchlistForm.pinnedSymbols
    };
    try {
      const res = selectedWatchlistId
        ? await axios.patch(`/api/research/watchlists/${selectedWatchlistId}`, payload)
        : await axios.post('/api/research/watchlists', payload);
      emitToast({ type: 'success', message: selectedWatchlistId ? 'Watchlist updated.' : 'Watchlist created.' });
      setSelectedWatchlistId(res.data._id);
      await fetchWatchlists(res.data._id);
      await fetchWatchlistSummary(res.data._id);
    } catch (err) {
      emitToast({ type: 'error', message: getApiError(err) });
    }
  };

  useEffect(() => {
    fetchStock(selectedSymbol);
    fetchCompare(compareInput);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSymbol]);

  useEffect(() => {
    fetchScreener(DEFAULT_SCREENER_FILTERS);
    fetchWatchlists();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (selectedWatchlistId) fetchWatchlistSummary(selectedWatchlistId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedWatchlistId]);

  useEffect(() => {
    setTradeTicket(DEFAULT_TRADE_TICKET);
    setTradePreview(null);
  }, [selectedSymbol]);

  useEffect(() => {
    if (activeTab === 'trade') {
      fetchTradePreview(DEFAULT_TRADE_TICKET);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, selectedSymbol]);

  const latestNews = stock?.news || [];
  const stockNewsClusters = stock?.newsClusters || stock?.intelligence?.newsClusters || [];
  const dashboardNewsClusters = dashboard?.newsClusters || [];
  const intelligence = stock?.intelligence || stock?.thesis || {};
  const events = stock?.events || [];
  const watchlist = dashboard?.watchlist || [];
  const benchmarks = dashboard?.benchmarks || [];
  const qualityWarnings = uniqueWarnings(
    dashboard?.dataQuality?.staleWarnings,
    stock?.dataQuality?.staleWarnings
  );
  const providerHealth = [
    ...(stock?.dataQuality?.providerHealth || []),
    ...(dashboard?.dataQuality?.providerHealth || [])
  ].slice(0, 12);
  const cacheStatus = stock?.dataQuality?.cache?.status || dashboard?.dataQuality?.cache?.status || 'miss';
  const selectedWatchlist = savedWatchlists.find(item => item._id === selectedWatchlistId);

  const submitSymbol = event => {
    event.preventDefault();
    const next = normalizeSymbol(symbolInput);
    if (!next) return;
    navigate(`/research/${next}`);
  };

  const saveNote = async event => {
    event.preventDefault();
    if (!noteBody.trim() && !noteTitle.trim()) return;
    try {
      await axios.post(`/api/research/notes/${selectedSymbol}`, {
        title: noteTitle,
        body: noteBody,
        tags: noteTags,
        stance: noteStance
      });
      emitToast({ type: 'success', message: 'Research note saved.' });
      await fetchStock(selectedSymbol);
    } catch (err) {
      emitToast({ type: 'error', message: getApiError(err) });
    }
  };

  const createAlert = async event => {
    event.preventDefault();
    try {
      await axios.post(`/api/research/alerts/${selectedSymbol}`, {
        type: alertType,
        threshold: alertNeedsThreshold(alertType) ? alertThreshold : '',
        keyword: alertKeyword
      });
      setAlertThreshold('');
      setAlertKeyword('');
      emitToast({ type: 'success', message: 'Research alert created.' });
      await fetchStock(selectedSymbol);
    } catch (err) {
      emitToast({ type: 'error', message: getApiError(err) });
    }
  };

  const toggleAlert = async alert => {
    try {
      await axios.patch(`/api/research/alerts/${alert._id}`, { isActive: !alert.isActive });
      await fetchStock(selectedSymbol);
    } catch (err) {
      emitToast({ type: 'error', message: getApiError(err) });
    }
  };

  return (
    <div className="space-y-5">
      <div className="rt-page-header">
        <p className="rt-eyebrow">Research Workstation</p>
        <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <h1 className="rt-title">Market dashboard and stock deep dives</h1>
            <p className="rt-subtitle max-w-3xl">
              Watchlists, charts, news, thesis tracking, alerts, and comparison tools for discretionary research.
            </p>
          </div>
          <form onSubmit={submitSymbol} className="flex w-full max-w-md gap-2">
            <input
              value={symbolInput}
              onChange={event => setSymbolInput(normalizeSymbol(event.target.value))}
              className="rt-field"
              placeholder="Search ticker"
              aria-label="Search ticker"
            />
            <Button type="submit" className="shrink-0">Open</Button>
          </form>
        </div>
      </div>

      {error && (
        <Card variant="warning" className="p-4">
          <p className="text-sm text-[#ffd77a]">{error}</p>
        </Card>
      )}

      {qualityWarnings.length > 0 && (
        <Card variant="warning" className="p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p className="rt-label">Data Quality</p>
              <p className="mt-1 text-sm text-[#ffd77a]">{qualityWarnings[0]}</p>
              {qualityWarnings.length > 1 && (
                <p className="mt-1 text-xs text-[#b8c8c7]">{qualityWarnings.length - 1} additional freshness warning{qualityWarnings.length > 2 ? 's' : ''} available in provider status.</p>
              )}
            </div>
            <Badge variant={cacheStatus === 'hit' ? 'success' : (cacheStatus === 'stale_hit' ? 'warning' : 'neutral')}>
              Cache {cacheStatus.replace('_', ' ')}
            </Badge>
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[18rem_minmax(0,1fr)_22rem]">
        <Card className="p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="rt-label">Watchlist</p>
              <h2 className="rt-section-title mt-1">Linked symbols</h2>
            </div>
            <Badge variant="info">Live</Badge>
          </div>
          <div className="mt-4 space-y-2">
            {loadingDashboard ? (
              Array.from({ length: 6 }).map((_, idx) => <Skeleton key={idx} className="h-12 w-full" />)
            ) : watchlist.map(item => {
              const active = item.symbol === selectedSymbol;
              return (
                <button
                  key={item.symbol}
                  type="button"
                  onClick={() => navigate(`/research/${item.symbol}`)}
                  className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                    active
                      ? 'border-[#26d07c]/55 bg-[#143a2a] text-[#edf5f4]'
                      : 'border-[#26363c] bg-[#0b1012] text-[#b8c8c7] hover:border-[#35515a]'
                  }`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-bold">{item.symbol}</span>
                    <span className={Number(item.changePercent) >= 0 ? 'text-[#8cf5bd]' : 'text-[#ffb5c2]'}>
                      {formatPercent(item.changePercent)}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center justify-between text-xs text-[#8ba09f]">
                    <span>{item.assetClass || 'equity'}</span>
                    <span>{formatCurrency(item.price)}</span>
                  </div>
                </button>
              );
            })}
          </div>

          <div className="mt-5 border-t border-[#26363c] pt-4">
            <p className="rt-label">Market Pulse</p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              {benchmarks.map(item => (
                <div key={item.symbol} className="rt-panel-muted p-3">
                  <p className="text-sm font-bold text-[#edf5f4]">{item.symbol}</p>
                  <p className={Number(item.changePercent) >= 0 ? 'text-xs text-[#8cf5bd]' : 'text-xs text-[#ffb5c2]'}>
                    {formatPercent(item.changePercent)}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </Card>

        <div className="space-y-5">
          <Card className="p-5">
            {loadingStock ? (
              <div className="space-y-4">
                <Skeleton className="h-8 w-48" />
                <Skeleton className="h-72 w-full" />
              </div>
            ) : (
              <>
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-3xl font-black text-[#edf5f4]">{stock?.symbol}</h2>
                      <Badge variant={stock?.company?.fractionable ? 'success' : 'neutral'}>
                        {stock?.company?.fractionable ? 'Fractional' : 'Equity'}
                      </Badge>
                      {stock?.company?.shortable && <Badge variant="info">Shortable</Badge>}
                      {intelligence?.confidence?.label && (
                        <Badge variant={intelligence.confidence.label === 'High' ? 'success' : (intelligence.confidence.label === 'Low' ? 'warning' : 'info')}>
                          {intelligence.confidence.label} confidence
                        </Badge>
                      )}
                      <Badge variant={intelligence?.aiGenerated ? 'success' : 'neutral'}>
                        {intelligence?.aiGenerated ? 'AI summary' : 'Rule summary'}
                      </Badge>
                    </div>
                    <p className="mt-1 text-sm text-[#8ba09f]">{stock?.company?.name || stock?.symbol}</p>
                    <p className="mt-1 text-xs text-[#6f8584]">
                      Research generated {formatDateTime(stock?.dataQuality?.generatedAt || stock?.updatedAt)}
                      {stock?.dataQuality?.cache?.status ? ` · cache ${stock.dataQuality.cache.status.replace('_', ' ')}` : ''}
                    </p>
                  </div>
                  <div className="text-left lg:text-right">
                    <p className="text-3xl font-black text-[#edf5f4]">{formatCurrency(stock?.technicals?.latestPrice)}</p>
                    <p className={Number(stock?.technicals?.changePercent) >= 0 ? 'text-sm text-[#8cf5bd]' : 'text-sm text-[#ffb5c2]'}>
                      {formatCurrency(stock?.technicals?.change)} ({formatPercent(stock?.technicals?.changePercent)})
                    </p>
                  </div>
                </div>

                <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-6">
                  <Metric label="Trend" value={stock?.technicals?.trend?.replace('_', ' ') || 'N/A'} accent />
                  <Metric label="RSI 14" value={stock?.technicals?.rsi14 ?? 'N/A'} />
                  <Metric label="ATR %" value={formatPercent(stock?.technicals?.atrPercent)} />
                  <Metric label="Vol Ratio" value={stock?.technicals?.volumeRatio ? `${stock.technicals.volumeRatio}x` : 'N/A'} />
                  <Metric label="Support" value={formatCurrency(stock?.technicals?.support20)} />
                  <Metric label="Resistance" value={formatCurrency(stock?.technicals?.resistance20)} />
                </div>

                <div className="mt-5 flex flex-wrap items-center gap-2">
                  {[
                    ['chart', 'Chart'],
                    ['news', 'News'],
                    ['intelligence', 'Intelligence'],
                    ['trade', 'Trade'],
                    ['compare', 'Compare'],
                    ['screener', 'Screener'],
                    ['watchlists', 'Watchlists']
                  ].map(([tab, label]) => (
                    <button
                      key={tab}
                      type="button"
                      onClick={() => setActiveTab(tab)}
                      className={`rounded-lg px-3 py-2 text-sm font-semibold ${
                        activeTab === tab ? 'bg-[#173426] text-[#8cf5bd]' : 'bg-[#10171a] text-[#b8c8c7] hover:bg-[#172126]'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {activeTab === 'chart' && (
                  <div className="mt-5">
                    <ResearchChart
                      symbol={stock?.symbol}
                      chart={stock?.chart}
                      compare={compare}
                    />
                  </div>
                )}

                {activeTab === 'news' && (
                  <div className="mt-5 space-y-3">
                    {stockNewsClusters.length ? stockNewsClusters.map(cluster => (
                      <article key={cluster.id} className="rt-panel p-4">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant={getSentimentVariant(cluster.sentiment)}>{cluster.sentiment}</Badge>
                          <Badge variant="neutral">{cluster.category}</Badge>
                          <Badge variant={cluster.count > 1 ? 'info' : 'neutral'}>
                            {cluster.count} source{cluster.count === 1 ? '' : 's'}
                          </Badge>
                          {cluster.sources?.slice(0, 3).map(source => (
                            <Badge key={source} variant={source === 'research_fallback' ? 'warning' : 'neutral'}>{source}</Badge>
                          ))}
                          <span className="text-xs text-[#8ba09f]">
                            {formatCitationTimestamp(cluster.latestPublishedAt)}
                          </span>
                        </div>
                        <h3 className="mt-3 text-base font-bold text-[#edf5f4]">{cluster.primaryHeadline}</h3>
                        {cluster.summary && <p className="mt-2 text-sm text-[#b8c8c7]">{cluster.summary}</p>}
                        <div className="mt-3 flex flex-wrap gap-2">
                          {cluster.citations?.slice(0, 4).map(citation => citation.url ? (
                            <a key={citation.id} className="text-xs font-semibold text-[#8cf5bd]" href={citation.url} target="_blank" rel="noreferrer">
                              {citation.source} · {formatCitationTimestamp(citation.timestamp)}
                            </a>
                          ) : (
                            <span key={citation.id} className="text-xs text-[#8ba09f]">
                              {citation.source} · {formatCitationTimestamp(citation.timestamp)}
                            </span>
                          ))}
                        </div>
                      </article>
                    )) : latestNews.map(item => (
                      <article key={`${item.source}-${item.externalId}`} className="rt-panel p-4">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant={getSentimentVariant(item.sentiment)}>{item.sentiment}</Badge>
                          <Badge variant="neutral">{item.category}</Badge>
                          <Badge variant={item.source === 'research_fallback' ? 'warning' : 'info'}>{item.source}</Badge>
                          <span className="text-xs text-[#8ba09f]">
                            {item.publishedAt ? new Date(item.publishedAt).toLocaleString() : 'No timestamp'}
                          </span>
                        </div>
                        <h3 className="mt-3 text-base font-bold text-[#edf5f4]">{item.headline}</h3>
                        {item.summary && <p className="mt-2 text-sm text-[#b8c8c7]">{item.summary}</p>}
                        <p className="mt-3 text-sm text-[#ffd77a]">{item.whyItMatters}</p>
                        {item.url && (
                          <a className="mt-3 inline-flex text-sm font-semibold text-[#8cf5bd]" href={item.url} target="_blank" rel="noreferrer">
                            Open source
                          </a>
                        )}
                      </article>
                    ))}
                  </div>
                )}

                {activeTab === 'intelligence' && (
                  <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-3">
                    <div className="rt-panel p-4 lg:col-span-3">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <p className="rt-label">Research Intelligence</p>
                          <h3 className="mt-1 text-lg font-bold text-[#edf5f4]">
                            {intelligence?.aiGenerated ? 'AI-generated summary' : 'Fallback rule summary'}
                          </h3>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Badge variant={intelligence?.aiGenerated ? 'success' : 'neutral'}>{intelligence?.provider || 'research'}</Badge>
                          {intelligence?.confidence?.label && (
                            <Badge variant={intelligence.confidence.label === 'High' ? 'success' : (intelligence.confidence.label === 'Low' ? 'warning' : 'info')}>
                              {intelligence.confidence.label} confidence
                            </Badge>
                          )}
                        </div>
                      </div>
                      <p className="mt-3 text-sm leading-6 text-[#d9e5e4]">{intelligence?.summary}</p>
                      {intelligence?.confidence?.rationale && (
                        <p className="mt-3 text-xs text-[#ffd77a]">{intelligence.confidence.rationale}</p>
                      )}
                      <p className="mt-3 text-xs text-[#8ba09f]">
                        Generated {formatDateTime(intelligence?.generatedAt)}{intelligence?.model ? ` · ${intelligence.model}` : ''}
                      </p>
                      <p className="mt-2 text-xs text-[#8ba09f]">{intelligence?.riskNote}</p>
                    </div>
                    <div className="rt-panel p-4">
                      <p className="rt-label">Bull Case</p>
                      <ul className="mt-3 space-y-2 text-sm text-[#d9e5e4]">
                        {intelligence?.bullCase?.map(item => <li key={item}>{item}</li>)}
                      </ul>
                    </div>
                    <div className="rt-panel p-4">
                      <p className="rt-label">Bear Case</p>
                      <ul className="mt-3 space-y-2 text-sm text-[#d9e5e4]">
                        {intelligence?.bearCase?.map(item => <li key={item}>{item}</li>)}
                      </ul>
                    </div>
                    <div className="rt-panel p-4">
                      <p className="rt-label">Key Risks</p>
                      <ul className="mt-3 space-y-2 text-sm text-[#d9e5e4]">
                        {intelligence?.keyRisks?.map(item => <li key={item}>{item}</li>)}
                      </ul>
                    </div>
                    <div className="rt-panel p-4 lg:col-span-2">
                      <p className="rt-label">What Changed Today</p>
                      <ul className="mt-3 space-y-2 text-sm text-[#d9e5e4]">
                        {intelligence?.whatChangedToday?.map(item => <li key={item}>{item}</li>)}
                      </ul>
                    </div>
                    <div className="rt-panel p-4">
                      <p className="rt-label">Watch Items</p>
                      <ul className="mt-3 space-y-2 text-sm text-[#d9e5e4]">
                        {intelligence?.watchItems?.map(item => <li key={item}>{item}</li>)}
                      </ul>
                    </div>
                    <div className="rt-panel p-4 lg:col-span-3">
                      <p className="rt-label">Sources and Timestamps</p>
                      <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
                        {(intelligence?.citations || []).map(citation => (
                          <div key={citation.id} className="rt-panel-muted p-3">
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge variant="neutral">{citation.type}</Badge>
                              <span className="text-xs text-[#8ba09f]">{formatCitationTimestamp(citation.timestamp)}</span>
                            </div>
                            <p className="mt-2 text-sm font-semibold text-[#d9e5e4]">{citation.title}</p>
                            {citation.url ? (
                              <a className="mt-2 inline-flex text-xs font-semibold text-[#8cf5bd]" href={citation.url} target="_blank" rel="noreferrer">
                                {citation.source}
                              </a>
                            ) : (
                              <p className="mt-2 text-xs text-[#8ba09f]">{citation.source}</p>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                {activeTab === 'trade' && (
                  <div className="mt-5 space-y-4">
                    <div className="rt-panel p-4">
                      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                        <div>
                          <p className="rt-label">Research Trade Workflow</p>
                          <h3 className="mt-1 text-lg font-bold text-[#edf5f4]">Paper ticket preview</h3>
                          <p className="mt-2 max-w-3xl text-xs leading-5 text-[#8ba09f]">
                            RoboTrader uses automated trading rules and market data to identify potential opportunities. Trading involves risk, including possible loss of principal. Past performance does not guarantee future results.
                          </p>
                        </div>
                        <Badge variant={tradePreview?.risk?.eligible ? 'success' : 'warning'}>
                          {tradePreview?.risk?.eligible ? 'Risk passed' : 'Needs review'}
                        </Badge>
                      </div>

                      <form
                        onSubmit={event => {
                          event.preventDefault();
                          fetchTradePreview(tradeTicket);
                        }}
                        className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4"
                      >
                        <label className="space-y-1">
                          <span className="rt-label">Side</span>
                          <select
                            value={tradeTicket.side}
                            onChange={event => {
                              setTradeTicket(prev => ({ ...prev, side: event.target.value }));
                              setTradePreview(null);
                            }}
                            className="rt-field"
                          >
                            <option value="buy">Buy</option>
                            <option value="sell">Sell</option>
                          </select>
                        </label>
                        <label className="space-y-1">
                          <span className="rt-label">Quantity</span>
                          <input
                            value={tradeTicket.qty}
                            onChange={event => {
                              setTradeTicket(prev => ({ ...prev, qty: event.target.value }));
                              setTradePreview(null);
                            }}
                            className="rt-field"
                            type="number"
                            min="0.000001"
                            step="0.000001"
                            placeholder="Auto"
                          />
                        </label>
                        <label className="space-y-1">
                          <span className="rt-label">Position %</span>
                          <input
                            value={tradeTicket.positionSizePct}
                            onChange={event => {
                              setTradeTicket(prev => ({ ...prev, positionSizePct: event.target.value }));
                              setTradePreview(null);
                            }}
                            className="rt-field"
                            type="number"
                            min="0.1"
                            max="10"
                            step="0.1"
                            placeholder="Auto"
                          />
                        </label>
                        <label className="space-y-1">
                          <span className="rt-label">Order Type</span>
                          <select
                            value={tradeTicket.orderType}
                            onChange={event => {
                              setTradeTicket(prev => ({ ...prev, orderType: event.target.value }));
                              setTradePreview(null);
                            }}
                            className="rt-field"
                          >
                            <option value="market">Market</option>
                            <option value="limit">Limit</option>
                          </select>
                        </label>
                        {tradeTicket.orderType === 'limit' && (
                          <label className="space-y-1 md:col-span-2">
                            <span className="rt-label">Limit Price</span>
                            <input
                              value={tradeTicket.limitPrice}
                              onChange={event => {
                                setTradeTicket(prev => ({ ...prev, limitPrice: event.target.value }));
                                setTradePreview(null);
                              }}
                              className="rt-field"
                              type="number"
                              min="0.01"
                              step="0.01"
                              placeholder="Latest price"
                            />
                          </label>
                        )}
                        <label className="flex items-center gap-3 rounded-lg border border-[#26363c] bg-[#0b1012] px-3 py-3 text-sm font-semibold text-[#d9e5e4]">
                          <input
                            type="checkbox"
                            checked={tradeTicket.allowExtendedHours}
                            onChange={event => {
                              setTradeTicket(prev => ({ ...prev, allowExtendedHours: event.target.checked }));
                              setTradePreview(null);
                            }}
                          />
                          Extended hours
                        </label>
                        <div className="flex flex-wrap gap-2 md:col-span-2 xl:col-span-4">
                          <Button type="submit" disabled={loadingTradePreview}>
                            {loadingTradePreview ? 'Checking...' : 'Preview risk'}
                          </Button>
                          <Button
                            type="button"
                            variant="secondary"
                            onClick={createTradePlanFromThesis}
                            disabled={creatingTradePlan || loadingTradePreview}
                          >
                            {creatingTradePlan ? 'Creating...' : 'Create Trade Plan from Thesis'}
                          </Button>
                          <Button
                            type="button"
                            variant="secondary"
                            onClick={submitPaperTradeFromResearch}
                            disabled={submittingPaperTrade || loadingTradePreview}
                          >
                            {submittingPaperTrade ? 'Submitting...' : 'Submit Paper Trade'}
                          </Button>
                        </div>
                      </form>
                    </div>

                    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                      <Metric label="Entry" value={formatCurrency(tradePreview?.ticket?.entryPrice)} />
                      <Metric label="Stop" value={formatCurrency(tradePreview?.ticket?.stopLossPrice)} />
                      <Metric label="Target" value={formatCurrency(tradePreview?.ticket?.takeProfitPrice)} accent />
                      <Metric label="Reward/Risk" value={getTicketValue(tradePreview?.ticket?.rewardRiskRatio)} />
                      <Metric label="Quantity" value={getTicketValue(tradePreview?.ticket?.qty)} />
                      <Metric label="Notional" value={formatCurrency(tradePreview?.ticket?.plannedNotional)} />
                      <Metric label="Position %" value={tradePreview?.ticket?.positionSizePct ? `${tradePreview.ticket.positionSizePct}%` : 'N/A'} />
                      <Metric label="Confidence" value={tradePreview?.risk?.confidenceScore ? `${tradePreview.risk.confidenceScore}/100` : 'N/A'} />
                    </div>

                    <div className="rt-panel p-4">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <p className="rt-label">Pre-Trade Checks</p>
                          <h3 className="mt-1 text-base font-bold text-[#edf5f4]">
                            {tradePreview?.risk?.eligible ? 'Eligible for paper execution' : 'Blocked until resolved'}
                          </h3>
                        </div>
                        <Badge variant={tradePreview?.risk?.eligible ? 'success' : 'warning'}>
                          {tradePreview?.risk?.eligible ? 'eligible' : 'blocked'}
                        </Badge>
                      </div>
                      {(tradePreview?.risk?.reasonsBlocked || []).length > 0 ? (
                        <ul className="mt-3 space-y-2 text-sm text-[#ffd77a]">
                          {tradePreview.risk.reasonsBlocked.map(reason => (
                            <li key={reason}>{reason}</li>
                          ))}
                        </ul>
                      ) : (
                        <p className="mt-3 text-sm text-[#b8c8c7]">No blocking risk checks returned for the current preview.</p>
                      )}
                      {(tradePreview?.risk?.warnings || []).length > 0 && (
                        <div className="mt-4 border-t border-[#26363c] pt-3">
                          <p className="rt-label">Warnings</p>
                          <ul className="mt-2 space-y-2 text-sm text-[#d9e5e4]">
                            {tradePreview.risk.warnings.map(warning => (
                              <li key={warning}>{warning}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>

                    <div className="rt-panel p-4">
                      <p className="rt-label">Research Snapshot Captured</p>
                      <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
                        <div className="rt-panel-muted p-3">
                          <p className="text-xs text-[#8ba09f]">Captured</p>
                          <p className="mt-1 text-sm font-semibold text-[#edf5f4]">{formatDateTime(tradePreview?.researchSnapshot?.capturedAt)}</p>
                        </div>
                        <div className="rt-panel-muted p-3">
                          <p className="text-xs text-[#8ba09f]">Thesis</p>
                          <p className="mt-1 line-clamp-3 text-sm text-[#d9e5e4]">{tradePreview?.researchSnapshot?.intelligence?.summary || 'No thesis summary available.'}</p>
                        </div>
                        <div className="rt-panel-muted p-3">
                          <p className="text-xs text-[#8ba09f]">Data warnings</p>
                          <p className="mt-1 text-sm text-[#d9e5e4]">{tradePreview?.researchSnapshot?.dataQuality?.staleWarnings?.length || 0}</p>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {activeTab === 'compare' && (
                  <div className="mt-5 space-y-4">
                    <form
                      onSubmit={event => {
                        event.preventDefault();
                        fetchCompare(compareInput);
                      }}
                      className="flex flex-col gap-2 sm:flex-row"
                    >
                      <input
                        value={compareInput}
                        onChange={event => setCompareInput(event.target.value.toUpperCase())}
                        className="rt-field"
                        placeholder="AAPL, MSFT, NVDA"
                      />
                      <Button type="submit" className="shrink-0">Compare</Button>
                    </form>
                    <div className="overflow-x-auto rounded-lg border border-[#26363c]">
                      <table className="rt-table">
                        <thead>
                          <tr>
                            <th>Symbol</th>
                            <th>Price</th>
                            <th>Move</th>
                            <th>Trend</th>
                            <th>RSI</th>
                            <th>ATR</th>
                            <th>Vol</th>
                            <th>News</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(compare?.rows || []).map(row => (
                            <tr key={row.symbol}>
                              <td className="font-bold">{row.symbol}</td>
                              <td>{formatCurrency(row.price)}</td>
                              <td>{formatPercent(row.changePercent)}</td>
                              <td>{row.trend}</td>
                              <td>{row.rsi14 ?? 'N/A'}</td>
                              <td>{formatPercent(row.atrPercent)}</td>
                              <td>{row.volumeRatio ? `${row.volumeRatio}x` : 'N/A'}</td>
                              <td>{row.positiveNews}+ / {row.negativeNews}-</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {activeTab === 'screener' && (
                  <div className="mt-5 space-y-4">
                    <form
                      onSubmit={event => {
                        event.preventDefault();
                        fetchScreener(screenerFilters);
                      }}
                      className="rt-panel p-4"
                    >
                      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
                        <label className="space-y-1">
                          <span className="rt-label">Symbols</span>
                          <input
                            value={screenerFilters.symbols}
                            onChange={event => setScreenerFilters(prev => ({ ...prev, symbols: event.target.value.toUpperCase() }))}
                            className="rt-field"
                            placeholder="AAPL, MSFT, NVDA"
                          />
                        </label>
                        <label className="space-y-1">
                          <span className="rt-label">Momentum min %</span>
                          <input
                            value={screenerFilters.minMomentum}
                            onChange={event => setScreenerFilters(prev => ({ ...prev, minMomentum: event.target.value }))}
                            className="rt-field"
                            type="number"
                            step="0.1"
                            placeholder="0"
                          />
                        </label>
                        <label className="space-y-1">
                          <span className="rt-label">Volatility max %</span>
                          <input
                            value={screenerFilters.maxVolatility}
                            onChange={event => setScreenerFilters(prev => ({ ...prev, maxVolatility: event.target.value }))}
                            className="rt-field"
                            type="number"
                            step="0.1"
                            placeholder="8"
                          />
                        </label>
                        <label className="space-y-1">
                          <span className="rt-label">Volume ratio min</span>
                          <input
                            value={screenerFilters.minVolumeRatio}
                            onChange={event => setScreenerFilters(prev => ({ ...prev, minVolumeRatio: event.target.value }))}
                            className="rt-field"
                            type="number"
                            step="0.1"
                            placeholder="1"
                          />
                        </label>
                        <label className="space-y-1">
                          <span className="rt-label">News sentiment</span>
                          <select
                            value={screenerFilters.newsSentiment}
                            onChange={event => setScreenerFilters(prev => ({ ...prev, newsSentiment: event.target.value }))}
                            className="rt-field"
                          >
                            <option value="any">Any</option>
                            <option value="positive">Positive</option>
                            <option value="neutral">Neutral</option>
                            <option value="negative">Negative</option>
                          </select>
                        </label>
                        <label className="space-y-1">
                          <span className="rt-label">Earnings within</span>
                          <input
                            value={screenerFilters.earningsWithinDays}
                            onChange={event => setScreenerFilters(prev => ({ ...prev, earningsWithinDays: event.target.value }))}
                            className="rt-field"
                            type="number"
                            step="1"
                            placeholder="30 days"
                          />
                        </label>
                        <label className="space-y-1">
                          <span className="rt-label">Sector</span>
                          <select
                            value={screenerFilters.sector}
                            onChange={event => setScreenerFilters(prev => ({ ...prev, sector: event.target.value }))}
                            className="rt-field"
                          >
                            {SECTOR_OPTIONS.map(option => (
                              <option key={option || 'any'} value={option}>{option || 'Any'}</option>
                            ))}
                          </select>
                        </label>
                        <label className="space-y-1">
                          <span className="rt-label">Trend</span>
                          <select
                            value={screenerFilters.trend}
                            onChange={event => setScreenerFilters(prev => ({ ...prev, trend: event.target.value }))}
                            className="rt-field"
                          >
                            {TREND_OPTIONS.map(option => (
                              <option key={option} value={option}>{option.replace('_', ' ')}</option>
                            ))}
                          </select>
                        </label>
                      </div>
                      <div className="mt-4 flex flex-wrap gap-2">
                        <Button type="submit" disabled={loadingScreener}>
                          {loadingScreener ? 'Screening...' : 'Run screener'}
                        </Button>
                        <Button
                          type="button"
                          variant="secondary"
                          onClick={() => {
                            setScreenerFilters(DEFAULT_SCREENER_FILTERS);
                            fetchScreener(DEFAULT_SCREENER_FILTERS);
                          }}
                        >
                          Reset
                        </Button>
                      </div>
                    </form>

                    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                      <Metric label="Candidates" value={screener?.totalCandidates ?? 0} />
                      <Metric label="Matches" value={screener?.matchedCount ?? 0} accent />
                      <Metric label="Top score" value={screener?.rows?.[0]?.score ?? 'N/A'} />
                      <Metric label="Cache" value={screener?.dataQuality?.cache?.status?.replace('_', ' ') || 'miss'} />
                    </div>

                    <div className="overflow-x-auto rounded-lg border border-[#26363c]">
                      <table className="rt-table">
                        <thead>
                          <tr>
                            <th>Symbol</th>
                            <th>Score</th>
                            <th>Momentum</th>
                            <th>Volatility</th>
                            <th>Volume</th>
                            <th>Sentiment</th>
                            <th>Earnings</th>
                            <th>Trend</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(screener?.rows || []).map(row => (
                            <tr key={row.symbol} className="cursor-pointer" onClick={() => navigate(`/research/${row.symbol}`)}>
                              <td className="font-bold">{row.symbol}</td>
                              <td>{formatNumber(row.score)}</td>
                              <td>{formatPercent(row.momentumPercent)}</td>
                              <td>{formatPercent(row.volatilityPercent)}</td>
                              <td>{row.volumeRatio ? `${row.volumeRatio}x` : 'N/A'}</td>
                              <td>
                                <Badge variant={getSentimentVariant(row.newsSentiment)}>{row.newsSentiment}</Badge>
                              </td>
                              <td>{row.earnings ? `${row.earnings.daysUntil}d` : 'N/A'}</td>
                              <td>{row.technicalTrend?.replace('_', ' ') || 'N/A'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {activeTab === 'watchlists' && (
                  <div className="mt-5 grid grid-cols-1 gap-4 xl:grid-cols-[16rem_minmax(0,1fr)]">
                    <div className="space-y-2">
                      <Button
                        type="button"
                        variant="secondary"
                        className="w-full"
                        onClick={() => {
                          setSelectedWatchlistId('');
                          setWatchlistSummary(null);
                          setWatchlistForm({
                            name: 'New Research List',
                            description: '',
                            symbols: selectedSymbol,
                            pinnedSymbols: selectedSymbol
                          });
                        }}
                      >
                        New watchlist
                      </Button>
                      {savedWatchlists.map(item => (
                        <button
                          key={item._id}
                          type="button"
                          onClick={() => selectWatchlist(item)}
                          className={`rt-panel-muted w-full p-3 text-left ${item._id === selectedWatchlistId ? 'border-[#26d07c]/60 bg-[#10251c]' : ''}`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <p className="text-sm font-bold text-[#edf5f4]">{item.name}</p>
                            {item.isDefault && <Badge variant="info">default</Badge>}
                          </div>
                          <p className="mt-1 text-xs text-[#8ba09f]">{(item.symbols || []).slice(0, 6).join(', ')}</p>
                        </button>
                      ))}
                    </div>

                    <div className="space-y-4">
                      <form onSubmit={saveWatchlist} className="rt-panel p-4">
                        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                          <input
                            value={watchlistForm.name}
                            onChange={event => setWatchlistForm(prev => ({ ...prev, name: event.target.value }))}
                            className="rt-field"
                            placeholder="Watchlist name"
                          />
                          <input
                            value={watchlistForm.description}
                            onChange={event => setWatchlistForm(prev => ({ ...prev, description: event.target.value }))}
                            className="rt-field"
                            placeholder="Description"
                          />
                          <textarea
                            value={watchlistForm.symbols}
                            onChange={event => setWatchlistForm(prev => ({ ...prev, symbols: event.target.value.toUpperCase() }))}
                            className="rt-field min-h-[6rem] md:col-span-2"
                            placeholder="AAPL, MSFT, NVDA"
                          />
                          <input
                            value={watchlistForm.pinnedSymbols}
                            onChange={event => setWatchlistForm(prev => ({ ...prev, pinnedSymbols: event.target.value.toUpperCase() }))}
                            className="rt-field md:col-span-2"
                            placeholder="Pinned symbols"
                          />
                        </div>
                        <div className="mt-4 flex flex-wrap gap-2">
                          <Button type="submit">{selectedWatchlistId ? 'Save watchlist' : 'Create watchlist'}</Button>
                          {selectedWatchlistId && (
                            <Button type="button" variant="secondary" onClick={() => fetchWatchlistSummary(selectedWatchlistId)}>
                              Refresh summary
                            </Button>
                          )}
                        </div>
                      </form>

                      <div className="rt-panel p-4">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div>
                            <p className="rt-label">Watchlist Research</p>
                            <h3 className="mt-1 text-lg font-bold text-[#edf5f4]">{selectedWatchlist?.name || watchlistForm.name || 'Research list'}</h3>
                          </div>
                          <Badge variant={loadingWatchlistSummary ? 'warning' : 'success'}>
                            {loadingWatchlistSummary ? 'refreshing' : 'summary'}
                          </Badge>
                        </div>
                        <p className="mt-3 text-sm leading-6 text-[#d9e5e4]">
                          {watchlistSummary?.summary || 'Save or select a watchlist to generate a research summary.'}
                        </p>
                        <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
                          <Metric label="Symbols" value={watchlistSummary?.metrics?.symbolCount ?? 0} />
                          <Metric label="Avg momentum" value={formatPercent(watchlistSummary?.metrics?.avgMomentum)} accent />
                          <Metric label="Avg volatility" value={formatPercent(watchlistSummary?.metrics?.avgVolatility)} />
                          <Metric label="Top score" value={watchlistSummary?.metrics?.topScore ?? 'N/A'} />
                        </div>
                        <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-3">
                          <div className="rt-panel-muted p-3">
                            <p className="rt-label">Top Momentum</p>
                            <div className="mt-2 space-y-2">
                              {(watchlistSummary?.topMomentum || []).slice(0, 4).map(row => (
                                <button key={row.symbol} type="button" onClick={() => navigate(`/research/${row.symbol}`)} className="flex w-full items-center justify-between text-left text-sm">
                                  <span className="font-bold text-[#edf5f4]">{row.symbol}</span>
                                  <span className="text-[#8cf5bd]">{formatPercent(row.momentumPercent)}</span>
                                </button>
                              ))}
                            </div>
                          </div>
                          <div className="rt-panel-muted p-3">
                            <p className="rt-label">Watch Items</p>
                            <ul className="mt-2 space-y-2 text-sm text-[#d9e5e4]">
                              {(watchlistSummary?.watchItems || []).map(item => <li key={item}>{item}</li>)}
                            </ul>
                          </div>
                          <div className="rt-panel-muted p-3">
                            <p className="rt-label">Risk Flags</p>
                            <ul className="mt-2 space-y-2 text-sm text-[#ffd77a]">
                              {(watchlistSummary?.riskFlags || []).map(item => <li key={item}>{item}</li>)}
                            </ul>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
          </Card>
        </div>

        <div className="space-y-5">
          <Card className="p-4">
            <p className="rt-label">News Engine</p>
            <div className="mt-3 grid grid-cols-3 gap-2">
              <div className="rt-panel-muted p-3 text-center">
                <p className="text-lg font-bold text-[#8cf5bd]">{dashboard?.sentiment?.positive || 0}</p>
                <p className="text-[11px] text-[#8ba09f]">Positive clusters</p>
              </div>
              <div className="rt-panel-muted p-3 text-center">
                <p className="text-lg font-bold text-[#d9e5e4]">{dashboard?.sentiment?.neutral || 0}</p>
                <p className="text-[11px] text-[#8ba09f]">Neutral clusters</p>
              </div>
              <div className="rt-panel-muted p-3 text-center">
                <p className="text-lg font-bold text-[#ffb5c2]">{dashboard?.sentiment?.negative || 0}</p>
                <p className="text-[11px] text-[#8ba09f]">Negative clusters</p>
              </div>
            </div>
            {dashboardNewsClusters.length > 0 && (
              <div className="mt-4 space-y-2">
                {dashboardNewsClusters.slice(0, 4).map(cluster => (
                  <button
                    key={cluster.id}
                    type="button"
                    onClick={() => {
                      const nextSymbol = cluster.symbols?.[0];
                      if (nextSymbol) navigate(`/research/${nextSymbol}`);
                    }}
                    className="rt-panel-muted w-full p-3 text-left"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={getSentimentVariant(cluster.sentiment)}>{cluster.sentiment}</Badge>
                      <span className="text-xs text-[#8ba09f]">{cluster.count} source{cluster.count === 1 ? '' : 's'}</span>
                    </div>
                    <p className="mt-2 line-clamp-2 text-xs font-semibold text-[#d9e5e4]">{cluster.primaryHeadline}</p>
                  </button>
                ))}
              </div>
            )}
          </Card>

          <Card className="p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="rt-label">Corporate Events</p>
                <h2 className="rt-section-title mt-1">Normalized feed</h2>
              </div>
              <Badge variant={events.length ? 'success' : 'warning'}>{events.length}</Badge>
            </div>
            <div className="mt-4 space-y-2">
              {events.length ? events.slice(0, 8).map(event => (
                <div key={`${event.source}-${event.externalId}`} className="rt-panel-muted p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-bold capitalize text-[#edf5f4]">{formatEventType(event.type)}</p>
                    <Badge variant={getSentimentVariant(event.sentiment)}>{event.sentiment}</Badge>
                  </div>
                  <p className="mt-2 text-xs font-semibold text-[#d9e5e4]">{event.title}</p>
                  <p className="mt-1 text-xs text-[#8ba09f]">{formatDateTime(event.eventDate)}</p>
                  {event.summary && <p className="mt-2 text-xs text-[#b8c8c7]">{event.summary}</p>}
                </div>
              )) : (
                <p className="text-sm text-[#8ba09f]">No normalized earnings, rating, filing, dividend, split, or insider events are available yet.</p>
              )}
            </div>
          </Card>

          <Card className="p-4">
            <p className="rt-label">Provider Status</p>
            <div className="mt-3 space-y-2">
              {providerHealth.length ? providerHealth.map((item, index) => (
                <div key={`${item.provider}-${item.category}-${index}`} className="rt-panel-muted p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-bold uppercase tracking-[0.18em] text-[#b8c8c7]">{item.provider}</p>
                    <Badge variant={getHealthVariant(item.status)}>{item.status}</Badge>
                  </div>
                  <p className="mt-1 text-xs text-[#8ba09f]">
                    {item.category} · rank {item.rank}{item.itemCount !== null && item.itemCount !== undefined ? ` · ${item.itemCount} item${item.itemCount === 1 ? '' : 's'}` : ''}
                  </p>
                  {item.message && <p className="mt-2 text-xs text-[#ffd77a]">{item.message}</p>}
                </div>
              )) : (
                <p className="text-sm text-[#8ba09f]">Provider health has not loaded yet.</p>
              )}
            </div>
          </Card>

          <Card className="p-4">
            <p className="rt-label">Research Notes</p>
            <form onSubmit={saveNote} className="mt-3 space-y-3">
              <input value={noteTitle} onChange={event => setNoteTitle(event.target.value)} className="rt-field" placeholder="Title" />
              <textarea value={noteBody} onChange={event => setNoteBody(event.target.value)} className="rt-field min-h-[7rem]" placeholder="Thesis, catalyst, invalidation..." />
              <div className="grid grid-cols-2 gap-2">
                <select value={noteStance} onChange={event => setNoteStance(event.target.value)} className="rt-field">
                  <option value="bullish">Bullish</option>
                  <option value="neutral">Neutral</option>
                  <option value="bearish">Bearish</option>
                </select>
                <input value={noteTags} onChange={event => setNoteTags(event.target.value)} className="rt-field" placeholder="tags" />
              </div>
              <Button type="submit" className="w-full">Save note</Button>
            </form>
            <div className="mt-4 space-y-2">
              {(stock?.notes || []).slice(0, 4).map(note => (
                <div key={note._id} className="rt-panel-muted p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-bold text-[#edf5f4]">{note.title || `${note.stance} note`}</p>
                    <Badge variant={note.stance === 'bullish' ? 'success' : (note.stance === 'bearish' ? 'danger' : 'neutral')}>
                      {note.stance}
                    </Badge>
                  </div>
                  <p className="mt-2 line-clamp-3 text-xs text-[#b8c8c7]">{note.body}</p>
                </div>
              ))}
            </div>
          </Card>

          <Card className="p-4">
            <p className="rt-label">Alerts</p>
            <form onSubmit={createAlert} className="mt-3 space-y-3">
              <select value={alertType} onChange={event => setAlertType(event.target.value)} className="rt-field">
                <option value="price_above">Price above</option>
                <option value="price_below">Price below</option>
                <option value="volume_spike">Volume spike</option>
                <option value="rsi_above">RSI above</option>
                <option value="rsi_below">RSI below</option>
                <option value="news_keyword">News keyword</option>
                <option value="thesis_change">Thesis change</option>
              </select>
              {alertType === 'news_keyword' ? (
                <input value={alertKeyword} onChange={event => setAlertKeyword(event.target.value)} className="rt-field" placeholder="Keyword" />
              ) : alertType === 'thesis_change' ? (
                <input value={alertKeyword} onChange={event => setAlertKeyword(event.target.value)} className="rt-field" placeholder="Optional thesis keyword" />
              ) : (
                <input value={alertThreshold} onChange={event => setAlertThreshold(event.target.value)} className="rt-field" placeholder="Threshold" type="number" step="0.01" />
              )}
              <Button type="submit" className="w-full">Create alert</Button>
            </form>
            <div className="mt-4 space-y-2">
              {(stock?.alerts || []).slice(0, 5).map(alert => (
                <button
                  key={alert._id}
                  type="button"
                  onClick={() => toggleAlert(alert)}
                  className="rt-panel-muted w-full p-3 text-left"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-bold text-[#edf5f4]">{alert.type.replace('_', ' ')}</p>
                    <Badge variant={alert.isActive ? 'success' : 'neutral'}>{alert.isActive ? 'active' : 'paused'}</Badge>
                  </div>
                  <p className="mt-1 text-xs text-[#8ba09f]">
                    {['news_keyword', 'thesis_change'].includes(alert.type) ? (alert.keyword || 'Any change') : alert.threshold}
                  </p>
                </button>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
