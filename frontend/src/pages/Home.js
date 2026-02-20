// src/pages/Home.js
import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import { LineChart, Line, ResponsiveContainer } from 'recharts';
import Card from '../components/ui/Card';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import Skeleton from '../components/ui/Skeleton';
import { getCache, setCache } from '../utils/cache';
import { getApiError } from '../utils/api';
import { emitToast } from '../utils/toast';

const WATCHLIST_UNIVERSE = [
  { symbol: 'AAPL', name: 'Apple' },
  { symbol: 'MSFT', name: 'Microsoft' },
  { symbol: 'GOOG', name: 'Alphabet' },
  { symbol: 'AMZN', name: 'Amazon' },
  { symbol: 'NVDA', name: 'NVIDIA' },
  { symbol: 'META', name: 'Meta' },
  { symbol: 'TSLA', name: 'Tesla' },
  { symbol: 'AMD', name: 'AMD' },
  { symbol: 'NFLX', name: 'Netflix' },
  { symbol: 'COST', name: 'Costco' },
  { symbol: 'JPM', name: 'JPMorgan' },
  { symbol: 'DIS', name: 'Disney' },
  { symbol: 'SHOP', name: 'Shopify' },
  { symbol: 'SPY', name: 'S&P 500 ETF' },
  { symbol: 'QQQ', name: 'Nasdaq 100 ETF' }
];

export default function Home() {
  const [trades, setTrades]   = useState([]);
  const [marketStatus, setMarketStatus] = useState('CLOSED');
  const [nextOpen, setNextOpen] = useState(null);
  const [nextClose, setNextClose] = useState(null);
  const [countdown, setCountdown] = useState('');
  const [watchlist, setWatchlist] = useState([]);
  const [watchlistSymbols, setWatchlistSymbols] = useState([]);
  const [pinnedSymbols, setPinnedSymbols] = useState([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [quotes, setQuotes] = useState({});
  const [sparklines, setSparklines] = useState({});
  const [watchlistLoading, setWatchlistLoading] = useState(true);
  const [watchlistError, setWatchlistError] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [recommendationWarning, setRecommendationWarning] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [watchlistRefresh, setWatchlistRefresh] = useState(0);
  const [showBlocked, setShowBlocked] = useState(false);
  const navigate = useNavigate();

  const universeMap = useMemo(() => {
    const map = {};
    WATCHLIST_UNIVERSE.forEach(item => {
      map[item.symbol] = item;
    });
    watchlist.forEach(item => {
      map[item.symbol] = item;
    });
    return map;
  }, [watchlist]);

  useEffect(() => {
    const fetchRecs = async () => {
      setLoading(true);
      const applyRecommendationsPayload = payload => {
        const isDataUnavailable = payload?.warning === 'DATA_UNAVAILABLE';
        setTrades(isDataUnavailable ? [] : (payload?.recommendations || []));
        setMarketStatus(payload?.marketStatus || 'CLOSED');
        setNextOpen(payload?.nextOpen || null);
        setNextClose(payload?.nextClose || null);
        setRecommendationWarning(
          isDataUnavailable ? (payload?.message || 'Could not fetch daily bars') : ''
        );
        setError('');
      };

      const cached = getCache('recommendations');
      if (cached) {
        applyRecommendationsPayload(cached);
        setLoading(false);
        return;
      }
      try {
        const res = await axios.get('/api/recommendations');
        applyRecommendationsPayload(res.data || {});
        setCache('recommendations', res.data, 30 * 1000);
      } catch (err) {
        const message = getApiError(err);
        setError(message);
        setRecommendationWarning('');
        emitToast({
          type: 'error',
          message,
          action: { label: 'Retry', onClick: () => setRefreshKey(prev => prev + 1) }
        });
      } finally {
        setLoading(false);
      }
    };

    fetchRecs();
  }, [refreshKey]);

  useEffect(() => {
    const fetchWatchlist = async () => {
      setWatchlistLoading(true);
      setWatchlistError('');
      try {
        const res = await axios.get('/api/watchlist/default');
        const list = res.data || [];
        setWatchlist(list);
        const stored = JSON.parse(localStorage.getItem('watchlistSymbols') || 'null');
        const symbols = stored && stored.length ? stored : list.map(item => item.symbol);
        setWatchlistSymbols(symbols);
        const pinned = JSON.parse(localStorage.getItem('watchlistPinned') || '[]');
        setPinnedSymbols(pinned);
      } catch (err) {
        const message = getApiError(err);
        setWatchlistError(message);
        emitToast({
          type: 'error',
          message,
          action: { label: 'Retry', onClick: () => setWatchlistRefresh(prev => prev + 1) }
        });
      } finally {
        setWatchlistLoading(false);
      }
    };

    fetchWatchlist();
  }, [watchlistRefresh]);

  useEffect(() => {
    if (watchlistSymbols.length) {
      localStorage.setItem('watchlistSymbols', JSON.stringify(watchlistSymbols));
    } else {
      localStorage.removeItem('watchlistSymbols');
    }
  }, [watchlistSymbols]);

  useEffect(() => {
    localStorage.setItem('watchlistPinned', JSON.stringify(pinnedSymbols));
  }, [pinnedSymbols]);

  useEffect(() => {
    const fetchMarketData = async () => {
      if (!watchlistSymbols.length) {
        setQuotes({});
        setSparklines({});
        return;
      }

      const quotesKey = `quotes:${watchlistSymbols.join(',')}`;
      const cachedQuotes = getCache(quotesKey);
      if (cachedQuotes) {
        setQuotes(cachedQuotes);
      }

      try {
        const quotesRes = await axios.post('/api/market/quotes', { symbols: watchlistSymbols });
        const quoteMap = {};
        quotesRes.data.forEach(quote => {
          quoteMap[quote.symbol] = quote;
        });
        setQuotes(quoteMap);
        setCache(quotesKey, quoteMap, 30 * 1000);

        const sparklineResults = await Promise.all(
          watchlistSymbols.map(async symbol => {
            const cacheKey = `sparkline:${symbol}:1D`;
            const cached = getCache(cacheKey);
            if (cached) {
              return [symbol, cached];
            }
            const sparkRes = await axios.post('/api/market/sparkline', {
              symbol,
              range: '1D'
            });
            setCache(cacheKey, sparkRes.data, 60 * 1000);
            return [symbol, sparkRes.data];
          })
        );
        const sparklineMap = {};
        sparklineResults.forEach(([symbol, data]) => {
          sparklineMap[symbol] = data;
        });
        setSparklines(sparklineMap);
      } catch (err) {
        const message = getApiError(err);
        setWatchlistError(message);
        emitToast({
          type: 'error',
          message,
          action: { label: 'Retry', onClick: () => setWatchlistRefresh(prev => prev + 1) }
        });
      }
    };

    fetchMarketData();
  }, [watchlistSymbols]);

  useEffect(() => {
    if (marketStatus !== 'CLOSED' || !nextOpen) {
      setCountdown('');
      return;
    }

    const updateCountdown = () => {
      const diff = new Date(nextOpen).getTime() - Date.now();
      if (diff <= 0) {
        setCountdown('Opening soon');
        return;
      }
      const hours = Math.floor(diff / (1000 * 60 * 60));
      const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      setCountdown(`${hours}h ${minutes}m`);
    };

    updateCountdown();
    const interval = setInterval(updateCountdown, 60 * 1000);
    return () => clearInterval(interval);
  }, [marketStatus, nextOpen]);

  const sortedSymbols = useMemo(() => {
    const pinned = pinnedSymbols.filter(symbol => watchlistSymbols.includes(symbol));
    const rest = watchlistSymbols.filter(symbol => !pinnedSymbols.includes(symbol));
    return [...pinned, ...rest];
  }, [pinnedSymbols, watchlistSymbols]);

  const watchlistRows = useMemo(() => {
    if (watchlistLoading) {
      return Array.from({ length: 8 }).map((_, idx) => (
        <div key={`watch-skel-${idx}`} className="flex items-center justify-between py-3">
          <div>
            <Skeleton className="h-3 w-16 mb-2" />
            <Skeleton className="h-3 w-24" />
          </div>
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-3 w-12" />
        </div>
      ));
    }

    if (watchlistError) {
      return <p className="text-sm text-[#ffb2c1]">{watchlistError}</p>;
    }

    if (!sortedSymbols.length) {
      return (
        <div className="text-sm text-emerald-100/55 py-4">
          No watchlist items yet. Add a symbol to get started.
        </div>
      );
    }

    return sortedSymbols.map(symbol => {
      const item = universeMap[symbol] || { symbol, name: symbol };
      const quote = quotes[symbol] || {};
      const data = sparklines[symbol] || [];
      const isUp = (quote.change || 0) >= 0;
      const priceValue = Number(quote.price);
      const changePctValue = Number(quote.changePercent);
      const displayPrice = Number.isFinite(priceValue) ? `$${priceValue.toFixed(2)}` : '--';
      const displayChangePct = Number.isFinite(changePctValue)
        ? `${changePctValue >= 0 ? '+' : ''}${changePctValue.toFixed(2)}%`
        : '--';

      return (
        <div
          key={symbol}
          onClick={() => navigate(`/stock/${symbol}`)}
          className="group grid grid-cols-[1fr_auto_auto] items-center gap-3 py-3 px-2 rounded-xl border border-transparent hover:border-emerald-900/50 hover:bg-[#16221b]/85 transition cursor-pointer"
        >
          <div>
            <p className="text-sm font-bold tracking-wide text-emerald-50">{item.symbol}</p>
            <p className="text-xs text-emerald-100/55">{item.name}</p>
          </div>
          <div className="h-10 w-24">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data}>
                <Line
                  type="monotone"
                  dataKey="price"
                  stroke={isUp ? '#00c805' : '#ff5c79'}
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="text-right">
            <p className="text-sm font-semibold text-emerald-50">
              {displayPrice}
            </p>
            <p className={`text-xs font-medium ${isUp ? 'text-[#5dff90]' : 'text-[#ff8ea4]'}`}>
              {displayChangePct}
            </p>
          </div>
          <div className="col-span-3 flex items-center gap-1 opacity-100 lg:opacity-0 lg:group-hover:opacity-100 transition">
            <Button
              variant="ghost"
              size="sm"
              className="!text-[11px]"
              onClick={event => {
                event.stopPropagation();
                setPinnedSymbols(prev => (
                  prev.includes(symbol)
                    ? prev.filter(item => item !== symbol)
                    : [...prev, symbol]
                ));
              }}
            >
              {pinnedSymbols.includes(symbol) ? 'Unpin' : 'Pin'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="!text-[11px]"
              onClick={event => {
                event.stopPropagation();
                setWatchlistSymbols(prev => prev.filter(item => item !== symbol));
                setPinnedSymbols(prev => prev.filter(item => item !== symbol));
              }}
            >
              Remove
            </Button>
          </div>
        </div>
      );
    });
  }, [
    watchlistLoading,
    watchlistError,
    sortedSymbols,
    universeMap,
    quotes,
    sparklines,
    navigate,
    pinnedSymbols
  ]);

  const suggestions = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    if (!term) return [];
    return WATCHLIST_UNIVERSE.filter(item => (
      item.symbol.toLowerCase().includes(term) || item.name.toLowerCase().includes(term)
    )).filter(item => !watchlistSymbols.includes(item.symbol)).slice(0, 6);
  }, [searchTerm, watchlistSymbols]);

  const visibleRecs = useMemo(() => {
    if (showBlocked) return trades;
    return trades.filter(rec => rec.qualityGate?.passed);
  }, [showBlocked, trades]);

  const blockedCount = trades.filter(rec => rec.qualityGate && !rec.qualityGate.passed).length;
  const formatLevel = value => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric.toFixed(2) : '--';
  };

  if (loading) {
    return (
      <div className="space-y-7">
        <Card className="p-6">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-9 w-72 mt-4" />
        </Card>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <Card className="p-5">
            <Skeleton className="h-4 w-32" />
            <div className="mt-4 space-y-3">
              {Array.from({ length: 6 }).map((_, idx) => (
                <Skeleton key={`wl-skel-${idx}`} className="h-10 w-full" />
              ))}
            </div>
          </Card>
          <Card className="p-5 lg:col-span-2">
            <Skeleton className="h-6 w-48 mb-4" />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {Array.from({ length: 4 }).map((_, idx) => (
                <Skeleton key={`rec-skel-${idx}`} className="h-32 w-full" />
              ))}
            </div>
          </Card>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <Card className="p-6 border-[#5f2a38] bg-[#2a1119]">
        <p className="text-sm text-[#ffb2c1]">{error}</p>
        <Button variant="secondary" size="sm" className="mt-4" onClick={() => setRefreshKey(prev => prev + 1)}>
          Retry
        </Button>
      </Card>
    );
  }

  return (
    <div className="space-y-7">
      <Card className="p-5 sm:p-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between bg-[linear-gradient(120deg,rgba(10,24,15,0.95)_0%,rgba(14,33,21,0.88)_60%,rgba(0,200,5,0.12)_100%)]">
        <div className="space-y-1">
          <p className="text-[11px] uppercase tracking-[0.22em] text-emerald-100/45">Session Overview</p>
          <p className="text-xl sm:text-2xl font-extrabold tracking-tight text-emerald-50">
            {marketStatus === 'OPEN' ? 'US Market Open' : 'US Market Closed'}
          </p>
          {marketStatus === 'CLOSED' && countdown && (
            <p className="text-sm text-emerald-100/65">Next open in {countdown}</p>
          )}
          {marketStatus === 'OPEN' && nextClose && (
            <p className="text-sm text-emerald-100/65">
              Closes at {new Date(nextClose).toLocaleTimeString()}
            </p>
          )}
        </div>
        <Badge variant={marketStatus === 'OPEN' ? 'success' : 'neutral'}>
          {marketStatus === 'OPEN' ? 'OPEN' : 'CLOSED'}
        </Badge>
      </Card>

      {recommendationWarning && (
        <Card className="p-4 border-[#4b3f1e] bg-[#2b2615]">
          <p className="text-sm text-[#f9d281]">
            {recommendationWarning}
          </p>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="p-5 sm:p-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="text-[11px] uppercase tracking-[0.2em] text-emerald-100/45">Watchlist</p>
              <h2 className="text-xl font-extrabold tracking-tight text-emerald-50">Live Board</h2>
            </div>
            <span className="text-xs text-emerald-100/50">{watchlistSymbols.length} symbols</span>
          </div>

          <div className="relative mb-4">
            <input
              type="text"
              value={searchTerm}
              onChange={event => setSearchTerm(event.target.value)}
              placeholder="Add symbol (AAPL, NVDA...)"
              className="w-full rounded-xl border border-emerald-900/70 bg-[#0f1913] px-3.5 py-2.5 text-sm text-emerald-50 placeholder:text-emerald-100/35 focus:outline-none focus:ring-2 focus:ring-[#00c805]/35"
            />
            {suggestions.length > 0 && (
              <div className="absolute z-10 mt-2 w-full rounded-xl border border-emerald-900/70 bg-[#0f1813] shadow-xl">
                {suggestions.map(item => (
                  <button
                    key={item.symbol}
                    onClick={() => {
                      setWatchlistSymbols(prev => [...prev, item.symbol]);
                      setSearchTerm('');
                    }}
                    className="flex w-full items-center justify-between px-3 py-2 text-sm text-emerald-100/90 hover:bg-[#1a261f]"
                  >
                    <span>{item.symbol}</span>
                    <span className="text-xs text-emerald-100/50">{item.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-1">{watchlistRows}</div>
        </Card>

        <section className="lg:col-span-2 space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-[11px] uppercase tracking-[0.2em] text-emerald-100/45">Setup Feed</p>
              <h1 className="text-3xl font-extrabold tracking-tight text-emerald-50">
                Daily Recommendations
              </h1>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="neutral">{visibleRecs.length} ideas</Badge>
              {blockedCount > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowBlocked(prev => !prev)}
                >
                  {showBlocked ? 'Hide blocked' : `Show blocked (${blockedCount})`}
                </Button>
              )}
            </div>
          </div>
          <div className="grid gap-6 grid-cols-1 sm:grid-cols-2">
            {visibleRecs.map((rec) => {
              const isBuy = rec.bias === 'LONG';
              const isBlocked = rec.qualityGate && !rec.qualityGate.passed;
              return (
                <Card
                  key={rec.ticker}
                  className="p-5 sm:p-6 transition cursor-pointer"
                  variant="default"
                  onClick={() => navigate(`/stock/${rec.ticker}`)}
                >
                  <div className="flex items-center justify-between">
                    <h2 className="text-2xl font-extrabold tracking-tight text-emerald-50">{rec.ticker}</h2>
                    <div className="flex items-center gap-2">
                      <Badge variant={isBuy ? 'success' : 'danger'}>
                        {isBuy ? 'BUY' : 'SHORT'}
                      </Badge>
                      {rec.score && (
                        <Badge variant="neutral">
                          {rec.score.label} {rec.score.value}
                        </Badge>
                      )}
                    </div>
                  </div>
                  <p className="mt-2 text-emerald-100/75 leading-relaxed">
                    {rec.rationale?.[0] || (isBuy
                      ? 'Expect upward movement'
                      : 'Expect downward trend')}
                  </p>
                  {isBlocked && (
                    <p className="mt-2 text-xs text-[#f9d281]">
                      Blocked: {rec.qualityGate.blockedReasons?.[0] || 'Quality gate failed.'}
                    </p>
                  )}
                  <div className="mt-4 grid grid-cols-3 gap-2 text-[11px]">
                    <div className="rounded-lg bg-[#16231b] border border-emerald-900/50 px-2 py-1.5">
                      <p className="text-emerald-100/45 uppercase tracking-wide">Entry</p>
                      <p className="text-emerald-50 font-semibold">{formatLevel(rec.entry?.price)}</p>
                    </div>
                    <div className="rounded-lg bg-[#16231b] border border-emerald-900/50 px-2 py-1.5">
                      <p className="text-emerald-100/45 uppercase tracking-wide">Stop</p>
                      <p className="text-emerald-50 font-semibold">{formatLevel(rec.risk?.stop)}</p>
                    </div>
                    <div className="rounded-lg bg-[#16231b] border border-emerald-900/50 px-2 py-1.5">
                      <p className="text-emerald-100/45 uppercase tracking-wide">Take</p>
                      <p className="text-emerald-50 font-semibold">{formatLevel(rec.risk?.takeProfit?.[0])}</p>
                    </div>
                  </div>
                  {rec.strategy?.strategyId && (
                    <div className="mt-3 text-xs text-emerald-100/50">
                      Strategy {rec.strategy.strategyId}
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
