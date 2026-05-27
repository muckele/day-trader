const axios = require('axios');
const crypto = require('crypto');
const { DEFAULT_WATCHLIST } = require('../data/defaultWatchlist');
const { fetchDaily, fetchIntraday } = require('../tradeLogic');
const { fetchQuotes } = require('./marketData');
const {
  atr,
  rsi,
  rollingVolatility,
  sma
} = require('../signal/indicators');
const { createAlpacaBroker } = require('../robotrader/alpacaBroker');

const RAW_DATA_URL =
  process.env.APCA_DATA_URL ||
  process.env.ALPACA_DATA_URL ||
  'https://data.alpaca.markets';
const DATA_URL = RAW_DATA_URL.replace(/\/v2\/?$/, '').replace(/\/$/, '');
const API_KEY =
  process.env.BROKER_API_KEY ||
  process.env.APCA_API_KEY_ID ||
  process.env.ALPACA_API_KEY;
const API_SECRET =
  process.env.BROKER_API_SECRET ||
  process.env.APCA_API_SECRET_KEY ||
  process.env.ALPACA_API_SECRET;
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY || '';
const FINNHUB_BASE_URL = (process.env.FINNHUB_BASE_URL || 'https://finnhub.io').replace(/\/$/, '');
const STOCK_SNAPSHOT_TTL_MS = positiveNumber(process.env.RESEARCH_STOCK_CACHE_TTL_MS, 5 * 60 * 1000);
const DASHBOARD_SNAPSHOT_TTL_MS = positiveNumber(process.env.RESEARCH_DASHBOARD_CACHE_TTL_MS, 2 * 60 * 1000);
const COMPARE_SNAPSHOT_TTL_MS = positiveNumber(process.env.RESEARCH_COMPARE_CACHE_TTL_MS, 2 * 60 * 1000);
const NEWS_STALE_MINUTES = positiveNumber(process.env.RESEARCH_NEWS_STALE_MINUTES, 24 * 60);
const DAILY_BARS_STALE_MINUTES = positiveNumber(process.env.RESEARCH_DAILY_STALE_MINUTES, 5 * 24 * 60);
const INTRADAY_STALE_MINUTES = positiveNumber(process.env.RESEARCH_INTRADAY_STALE_MINUTES, 8 * 60);
const EVENT_LOOKBACK_DAYS = positiveNumber(process.env.RESEARCH_EVENT_LOOKBACK_DAYS, 90);
const EVENT_LOOKAHEAD_DAYS = positiveNumber(process.env.RESEARCH_EVENT_LOOKAHEAD_DAYS, 180);

const POSITIVE_TERMS = [
  'beat', 'beats', 'raise', 'raises', 'raised', 'upgrade', 'upgraded', 'growth',
  'record', 'surge', 'launch', 'partnership', 'approval', 'profit', 'bullish',
  'strong', 'outperform', 'expands', 'wins'
];
const NEGATIVE_TERMS = [
  'miss', 'misses', 'cut', 'cuts', 'downgrade', 'downgraded', 'lawsuit', 'probe',
  'investigation', 'recall', 'warning', 'loss', 'bearish', 'weak', 'decline',
  'slump', 'halts', 'delay'
];

function normalizeSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase().replace(/[^A-Z0-9./-]/g, '');
}

function positiveNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function uniqueSymbols(symbols = []) {
  return [...new Set((symbols || []).map(normalizeSymbol).filter(Boolean))];
}

function toFiniteNumber(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function round(value, digits = 2) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Number(numeric.toFixed(digits));
}

function normalizeBar(bar = {}) {
  return {
    time: bar.t || bar.time || bar.timestamp || bar.date || null,
    open: toFiniteNumber(bar.o ?? bar.open, 0),
    high: toFiniteNumber(bar.h ?? bar.high, 0),
    low: toFiniteNumber(bar.l ?? bar.low, 0),
    close: toFiniteNumber(bar.c ?? bar.close ?? bar.price, 0),
    volume: toFiniteNumber(bar.v ?? bar.volume, 0)
  };
}

function toIndicatorBar(bar = {}) {
  return {
    t: bar.time,
    o: bar.open,
    h: bar.high,
    l: bar.low,
    c: bar.close,
    v: bar.volume
  };
}

function percentChange(from, to) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === 0) return null;
  return ((to - from) / from) * 100;
}

function average(values = []) {
  const filtered = values.map(Number).filter(Number.isFinite);
  if (!filtered.length) return null;
  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
}

function toDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function toIsoDate(value) {
  return toDate(value)?.toISOString() || null;
}

function toDateInput(value) {
  return toDate(value)?.toISOString().slice(0, 10) || null;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function ageMinutes(value) {
  const date = toDate(value);
  if (!date) return null;
  return (Date.now() - date.getTime()) / 60000;
}

function clonePayload(value) {
  return value ? JSON.parse(JSON.stringify(value)) : value;
}

function providerHealth({
  provider,
  category,
  rank,
  status,
  configured = true,
  fallback = false,
  latencyMs = null,
  itemCount = null,
  message = ''
}) {
  return {
    provider,
    category,
    rank,
    configured,
    fallback,
    status,
    latencyMs,
    itemCount,
    message,
    checkedAt: new Date().toISOString()
  };
}

function providerDisabled(provider, category, rank, message) {
  return providerHealth({
    provider,
    category,
    rank,
    configured: false,
    fallback: true,
    status: 'disabled',
    message
  });
}

function errorMessage(err) {
  return err?.response?.data?.message || err?.message || 'Provider request failed';
}

function stableId(parts) {
  const serialized = JSON.stringify(parts, Object.keys(parts || {}).sort());
  return crypto.createHash('sha256').update(serialized || '').digest('hex').slice(0, 24);
}

function researchCacheKey(scope, symbols) {
  return `${scope}:${uniqueSymbols(symbols).join(',') || 'default'}:v2`;
}

async function readResearchSnapshot(ResearchSnapshot, key, { allowExpired = false } = {}) {
  if (!ResearchSnapshot || !key) return null;
  const doc = await ResearchSnapshot.findOne({ key }).lean();
  if (!doc) return null;
  const expired = doc.expiresAt && new Date(doc.expiresAt).getTime() <= Date.now();
  if (expired && !allowExpired) return null;
  const payload = clonePayload(doc.payload);
  if (!payload) return null;
  const existingQuality = payload.dataQuality || {};
  const existingWarnings = Array.isArray(existingQuality.staleWarnings)
    ? existingQuality.staleWarnings
    : [];
  payload.dataQuality = {
    ...existingQuality,
    cache: {
      status: expired ? 'stale_hit' : 'hit',
      key,
      generatedAt: toIsoDate(doc.generatedAt),
      expiresAt: toIsoDate(doc.expiresAt)
    },
    staleWarnings: expired
      ? [...new Set([...existingWarnings, 'Cached research snapshot is expired; live providers were not refreshed for this response.'])]
      : existingWarnings,
    hasWarnings: existingQuality.hasWarnings || expired || existingWarnings.length > 0
  };
  return payload;
}

async function writeResearchSnapshot(ResearchSnapshot, { key, scope, symbols, payload, ttlMs }) {
  if (!ResearchSnapshot || !key || !payload) return payload;
  const generatedAt = new Date();
  const expiresAt = new Date(generatedAt.getTime() + ttlMs);
  await ResearchSnapshot.findOneAndUpdate(
    { key },
    {
      $set: {
        key,
        scope,
        symbols: uniqueSymbols(symbols),
        payload,
        providerHealth: payload.dataQuality?.providerHealth || [],
        staleWarnings: payload.dataQuality?.staleWarnings || [],
        generatedAt,
        expiresAt
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return payload;
}

function buildProviderRankings(providerHealthRecords = []) {
  return providerHealthRecords.reduce((acc, item) => {
    const category = item.category || 'other';
    if (!acc[category]) acc[category] = [];
    acc[category].push({
      provider: item.provider,
      rank: item.rank,
      status: item.status,
      fallback: Boolean(item.fallback),
      configured: Boolean(item.configured)
    });
    acc[category].sort((a, b) => a.rank - b.rank);
    return acc;
  }, {});
}

function buildDataQuality({ providerHealth: records = [], staleWarnings = [], cache = null } = {}) {
  const uniqueWarnings = [...new Set(staleWarnings.filter(Boolean))];
  return {
    generatedAt: new Date().toISOString(),
    cache: cache || { status: 'miss' },
    providerHealth: records,
    providerRankings: buildProviderRankings(records),
    staleWarnings: uniqueWarnings,
    hasWarnings: uniqueWarnings.length > 0 || records.some(item => ['error', 'disabled'].includes(item.status))
  };
}

function buildStaleWarnings({
  dailyBars = null,
  intradayBars = null,
  news = null,
  events = null,
  quotes = null,
  providerHealth: records = []
} = {}) {
  const warnings = [];
  const hasDailyBars = Array.isArray(dailyBars);
  const hasIntradayBars = Array.isArray(intradayBars);
  const hasNews = Array.isArray(news);
  const hasEvents = Array.isArray(events);
  const hasQuotes = Array.isArray(quotes);
  const latestDaily = hasDailyBars ? dailyBars[dailyBars.length - 1] : null;
  const latestIntraday = hasIntradayBars ? intradayBars[intradayBars.length - 1] : null;
  const latestNews = (hasNews ? news : [])
    .map(item => item.publishedAt || item.createdAt)
    .filter(Boolean)
    .sort((a, b) => new Date(b) - new Date(a))[0];

  if (hasDailyBars && !dailyBars.length) warnings.push('Daily bar history is unavailable; technical signals may be incomplete.');
  if (latestDaily && ageMinutes(latestDaily.time || latestDaily.t) > DAILY_BARS_STALE_MINUTES) {
    warnings.push('Daily bar history appears stale relative to the current date.');
  }
  if (hasIntradayBars && !intradayBars.length) warnings.push('Intraday bars are unavailable; short-term context may be incomplete.');
  if (latestIntraday && ageMinutes(latestIntraday.time || latestIntraday.t) > INTRADAY_STALE_MINUTES) {
    warnings.push('Intraday bars appear stale; price action may not reflect the latest session.');
  }
  if (hasQuotes && (!quotes.length || quotes.every(item => !Number(item.price)))) {
    warnings.push('Latest quote data is unavailable or returned zero pricing.');
  }
  if (hasNews && !news.length) warnings.push('No current news items were available for this research view.');
  if (latestNews && ageMinutes(latestNews) > NEWS_STALE_MINUTES) {
    warnings.push('Latest news is older than the configured freshness threshold.');
  }
  if (hasNews && news.some(item => item.source === 'research_fallback')) {
    warnings.push('News is using fallback research placeholders because the live news provider was unavailable.');
  }
  if (hasEvents && !events.length) {
    warnings.push('Corporate event data is unavailable; earnings, filings, dividends, splits, and insider activity may be incomplete.');
  }
  records
    .filter(item => item.status === 'error')
    .forEach(item => warnings.push(`${item.provider} ${item.category} provider error: ${item.message}`));
  records
    .filter(item => item.status === 'disabled')
    .forEach(item => warnings.push(`${item.provider} ${item.category} provider is not configured.`));
  return [...new Set(warnings)];
}

function computeVwap(bars = []) {
  const totals = bars.reduce((acc, bar) => {
    const typical = (bar.high + bar.low + bar.close) / 3;
    const volume = toFiniteNumber(bar.volume, 0) || 0;
    acc.dollars += typical * volume;
    acc.volume += volume;
    return acc;
  }, { dollars: 0, volume: 0 });
  return totals.volume > 0 ? totals.dollars / totals.volume : null;
}

function classifyCategory(text) {
  const value = String(text || '').toLowerCase();
  if (/earnings|revenue|eps|guidance/.test(value)) return 'earnings';
  if (/upgrade|downgrade|rating|price target|analyst/.test(value)) return 'analyst';
  if (/lawsuit|probe|investigation|sec|doj|regulator/.test(value)) return 'legal';
  if (/fed|inflation|rates|jobs|macro|treasury|gdp/.test(value)) return 'macro';
  if (/launch|product|partnership|deal|contract|approval/.test(value)) return 'catalyst';
  return 'general';
}

function scoreSentiment(text) {
  const value = String(text || '').toLowerCase();
  const positive = POSITIVE_TERMS.reduce((count, term) => count + (value.includes(term) ? 1 : 0), 0);
  const negative = NEGATIVE_TERMS.reduce((count, term) => count + (value.includes(term) ? 1 : 0), 0);
  const score = Math.max(-1, Math.min(1, (positive - negative) / 3));
  return {
    sentimentScore: round(score, 2),
    sentiment: score > 0.15 ? 'positive' : (score < -0.15 ? 'negative' : 'neutral')
  };
}

function buildWhyItMatters({ category, sentiment, symbols }) {
  const primary = symbols?.[0] || 'the company';
  if (category === 'earnings') return `${primary} earnings or guidance can reset valuation, trend, and near-term volatility.`;
  if (category === 'analyst') return `Analyst revisions can change institutional expectations and short-term flows in ${primary}.`;
  if (category === 'legal') return `Legal or regulatory headlines can widen risk premiums and pressure position sizing for ${primary}.`;
  if (category === 'macro') return `Macro news can move discount rates, sector rotation, and market-wide risk appetite.`;
  if (category === 'catalyst') return `Catalysts can alter demand assumptions, momentum, and event-driven trading interest.`;
  return sentiment === 'negative'
    ? `This headline may add downside risk or uncertainty for ${primary}.`
    : `This headline may affect sentiment, liquidity, or the current trading narrative for ${primary}.`;
}

function normalizeNewsItem(item = {}, requestedSymbols = []) {
  const symbols = uniqueSymbols(item.symbols?.length ? item.symbols : requestedSymbols);
  const headline = String(item.headline || item.title || 'Untitled market update').trim();
  const summary = String(item.summary || item.description || '').trim();
  const category = classifyCategory(`${headline} ${summary}`);
  const sentiment = scoreSentiment(`${headline} ${summary}`);
  const publishedAt = item.created_at || item.published_at || item.updated_at || null;
  return {
    externalId: String(item.id || item.uuid || item.url || `news-${stableId({ headline, summary, symbols, publishedAt })}`),
    source: item.source || 'alpaca',
    symbols,
    headline,
    summary,
    url: item.url || null,
    author: item.author || null,
    images: Array.isArray(item.images) ? item.images : [],
    category,
    ...sentiment,
    whyItMatters: buildWhyItMatters({ category, sentiment: sentiment.sentiment, symbols }),
    publishedAt,
    rawPayload: item
  };
}

function mockNews(symbol) {
  const normalized = normalizeSymbol(symbol);
  return [
    normalizeNewsItem({
      id: `mock-${normalized}-market-brief`,
      source: 'research_fallback',
      symbols: [normalized],
      headline: `${normalized} trading narrative updates as investors watch volume and trend confirmation`,
      summary: 'Fallback research item generated because live news credentials or provider data were unavailable.',
      created_at: new Date().toISOString()
    }, [normalized]),
    normalizeNewsItem({
      id: `mock-${normalized}-risk-watch`,
      source: 'research_fallback',
      symbols: [normalized],
      headline: `${normalized} risk watch focuses on support, resistance, and upcoming catalysts`,
      summary: 'Use this placeholder as a prompt to review earnings, analyst revisions, and sector context.',
      created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString()
    }, [normalized])
  ];
}

async function fetchNewsFromProviderDetailed(symbols, { limit = 20 } = {}) {
  const normalized = uniqueSymbols(symbols);
  if (!normalized.length) {
    return { items: [], providerHealth: [], fallbackUsed: false };
  }
  if (!API_KEY || !API_SECRET) {
    const items = normalized.flatMap(symbol => mockNews(symbol));
    return {
      items,
      fallbackUsed: true,
      providerHealth: [
        providerDisabled('alpaca_news', 'news', 1, 'Missing Alpaca market data credentials.'),
        providerHealth({
          provider: 'research_fallback',
          category: 'news',
          rank: 3,
          status: 'ok',
          fallback: true,
          itemCount: items.length,
          message: 'Generated placeholder research headlines.'
        })
      ]
    };
  }

  const startedAt = Date.now();
  try {
    const response = await axios.get(`${DATA_URL}/v1beta1/news`, {
      headers: {
        'APCA-API-KEY-ID': API_KEY,
        'APCA-API-SECRET-KEY': API_SECRET
      },
      params: {
        symbols: normalized.join(','),
        limit,
        sort: 'desc'
      },
      timeout: 15000
    });
    const items = Array.isArray(response.data?.news) ? response.data.news : [];
    const normalizedItems = items.map(item => normalizeNewsItem(item, normalized));
    return {
      items: normalizedItems,
      fallbackUsed: false,
      providerHealth: [
        providerHealth({
          provider: 'alpaca_news',
          category: 'news',
          rank: 1,
          status: 'ok',
          latencyMs: Date.now() - startedAt,
          itemCount: normalizedItems.length
        })
      ]
    };
  } catch (err) {
    const items = normalized.flatMap(symbol => mockNews(symbol));
    return {
      items,
      fallbackUsed: true,
      providerHealth: [
        providerHealth({
          provider: 'alpaca_news',
          category: 'news',
          rank: 1,
          status: 'error',
          latencyMs: Date.now() - startedAt,
          message: errorMessage(err)
        }),
        providerHealth({
          provider: 'research_fallback',
          category: 'news',
          rank: 3,
          status: 'ok',
          fallback: true,
          itemCount: items.length,
          message: 'Generated placeholder research headlines.'
        })
      ]
    };
  }
}

async function fetchNewsFromProvider(symbols, options = {}) {
  const result = await fetchNewsFromProviderDetailed(symbols, options);
  return result.items;
}

async function persistNews(items = [], ResearchNews) {
  if (!ResearchNews || !items.length) return items;
  const saved = [];
  for (const item of items) {
    const doc = await ResearchNews.findOneAndUpdate(
      { source: item.source, externalId: item.externalId },
      { $set: item },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).lean();
    saved.push(doc);
  }
  return saved;
}

async function refreshNewsDetailed(symbols, ResearchNews, options = {}) {
  const result = await fetchNewsFromProviderDetailed(symbols, options);
  const saved = await persistNews(result.items, ResearchNews);
  return {
    news: saved,
    providerHealth: result.providerHealth,
    fallbackUsed: result.fallbackUsed
  };
}

function computeTechnicals(rawBars = []) {
  const bars = rawBars.map(normalizeBar).filter(bar => Number.isFinite(bar.close) && bar.close > 0);
  const indicatorBars = bars.map(toIndicatorBar);
  const closes = bars.map(bar => bar.close);
  const volumes = bars.map(bar => bar.volume || 0);
  const latest = bars[bars.length - 1] || null;
  const previous = bars[bars.length - 2] || null;
  const latestPrice = latest?.close ?? null;
  const atr14 = atr(indicatorBars, 14);
  const recent20 = bars.slice(-20);
  const support20 = recent20.length ? Math.min(...recent20.map(bar => bar.low)) : null;
  const resistance20 = recent20.length ? Math.max(...recent20.map(bar => bar.high)) : null;
  const avgVolume20 = average(volumes.slice(-20));
  const currentVolume = latest?.volume ?? null;
  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const sma200 = sma(closes, 200);
  const rsi14 = rsi(closes, 14);
  const trend = sma20 && sma50 && sma200
    ? (sma20 > sma50 && sma50 > sma200 ? 'uptrend' : (sma20 < sma50 && sma50 < sma200 ? 'downtrend' : 'mixed'))
    : 'insufficient_data';

  return {
    bars,
    latestPrice,
    previousClose: previous?.close ?? null,
    change: latest && previous ? round(latest.close - previous.close, 2) : null,
    changePercent: latest && previous ? round(percentChange(previous.close, latest.close), 2) : null,
    sma20: round(sma20, 2),
    sma50: round(sma50, 2),
    sma200: round(sma200, 2),
    vwap20: round(computeVwap(recent20), 2),
    rsi14: round(rsi14, 2),
    atr14: round(atr14, 2),
    atrPercent: latestPrice && atr14 ? round((atr14 / latestPrice) * 100, 2) : null,
    volatility20: round((rollingVolatility(closes, Math.min(20, Math.max(2, closes.length - 1))) || 0) * 100, 2),
    avgVolume20: avgVolume20 ? Math.round(avgVolume20) : null,
    volumeRatio: avgVolume20 && currentVolume ? round(currentVolume / avgVolume20, 2) : null,
    support20: round(support20, 2),
    resistance20: round(resistance20, 2),
    fiveDayChangePercent: closes.length >= 6 ? round(percentChange(closes[closes.length - 6], latestPrice), 2) : null,
    twentyDayChangePercent: closes.length >= 21 ? round(percentChange(closes[closes.length - 21], latestPrice), 2) : null,
    trend,
    dataPoints: bars.length
  };
}

function buildStockThesis({ symbol, technicals, news = [], events = [], analysis = null }) {
  const positiveNews = news.filter(item => item.sentiment === 'positive').length;
  const negativeNews = news.filter(item => item.sentiment === 'negative').length;
  const upcomingEvents = events
    .filter(item => item.eventDate && new Date(item.eventDate).getTime() >= Date.now())
    .slice(0, 3);
  const trend = technicals.trend;
  const bull = [];
  const bear = [];

  if (trend === 'uptrend') bull.push('Moving averages are stacked in an uptrend.');
  if (trend === 'downtrend') bear.push('Moving averages are stacked in a downtrend.');
  if (technicals.rsi14 !== null && technicals.rsi14 < 35) bull.push('RSI is near oversold territory, which can attract mean-reversion buyers.');
  if (technicals.rsi14 !== null && technicals.rsi14 > 70) bear.push('RSI is elevated, so a pullback or consolidation risk is higher.');
  if (technicals.volumeRatio && technicals.volumeRatio > 1.5) bull.push('Volume is running above the 20-day average, confirming active participation.');
  if (positiveNews > negativeNews) bull.push('Recent headlines skew positive.');
  if (negativeNews > positiveNews) bear.push('Recent headlines skew negative.');
  if (technicals.atrPercent && technicals.atrPercent > 5) bear.push('ATR is elevated, requiring smaller position sizing and wider stops.');

  return {
    symbol,
    summary: [
      `${symbol} is currently in a ${trend.replace('_', ' ')} technical regime.`,
      technicals.changePercent !== null ? `Latest daily move is ${technicals.changePercent}%.` : null,
      news.length ? `${news.length} recent news items were reviewed.` : 'No recent provider news was available.',
      events.length ? `${events.length} normalized corporate events are available.` : 'Corporate event data is limited.',
      analysis?.recommendation ? `Existing strategy signal: ${analysis.recommendation}.` : null
    ].filter(Boolean).join(' '),
    bullCase: bull.length ? bull : ['Wait for stronger trend, volume, or catalyst confirmation.'],
    bearCase: bear.length ? bear : ['Primary risks are broad-market weakness, failed breakout attempts, and surprise news.'],
    watchItems: [
      technicals.support20 ? `Support near ${technicals.support20}` : null,
      technicals.resistance20 ? `Resistance near ${technicals.resistance20}` : null,
      technicals.rsi14 ? `RSI 14 at ${technicals.rsi14}` : null,
      technicals.volumeRatio ? `Volume ratio ${technicals.volumeRatio}x` : null,
      ...upcomingEvents.map(item => `${item.type.replace('_', ' ')} on ${toDateInput(item.eventDate)}`),
      'Next earnings or material company event'
    ].filter(Boolean),
    riskNote: 'Research outputs are informational and should be paired with position sizing, stop discipline, and independent review.'
  };
}

async function fetchCompany(symbol) {
  try {
    const broker = createAlpacaBroker({ mode: 'paper' });
    const asset = await broker.getAsset(symbol);
    return {
      symbol: asset.symbol || symbol,
      name: asset.name || symbol,
      exchange: asset.exchange || null,
      status: asset.status || null,
      tradable: asset.tradable ?? null,
      fractionable: asset.fractionable ?? null,
      shortable: asset.shortable ?? null
    };
  } catch (_err) {
    return {
      symbol,
      name: symbol,
      exchange: null,
      status: null,
      tradable: null,
      fractionable: null,
      shortable: null
    };
  }
}

async function getPersistedNewsForSymbols(symbols, ResearchNews, { limit = 20 } = {}) {
  if (!ResearchNews) return [];
  return ResearchNews.find({ symbols: { $in: uniqueSymbols(symbols) } })
    .sort({ publishedAt: -1, createdAt: -1 })
    .limit(limit)
    .lean();
}

async function refreshNews(symbols, ResearchNews, options = {}) {
  const fetched = await fetchNewsFromProvider(symbols, options);
  return persistNews(fetched, ResearchNews);
}

function normalizeResearchEvent(type, item = {}, requestedSymbol = '', source = 'finnhub') {
  const symbol = normalizeSymbol(item.symbol || requestedSymbol);
  const eventDate = toIsoDate(
    item.date ||
    item.period ||
    item.filedDate ||
    item.acceptedDate ||
    item.exDate ||
    item.paymentDate ||
    item.transactionDate
  );
  const externalId = String(
    item.id ||
    item.accessionNumber ||
    item.filingId ||
    item.url ||
    `${source}-${type}-${symbol}-${stableId({
      eventDate,
      form: item.form || item.type || null,
      name: item.name || item.ownerName || null,
      period: item.period || null,
      share: item.share || null,
      change: item.change || null,
      transactionCode: item.transactionCode || null
    })}`
  );
  const numericValues = {};
  [
    'epsActual', 'epsEstimate', 'revenueActual', 'revenueEstimate',
    'strongBuy', 'buy', 'hold', 'sell', 'strongSell',
    'amount', 'dividend', 'fromFactor', 'toFactor', 'share', 'change',
    'transactionPrice'
  ].forEach(key => {
    const value = toFiniteNumber(item[key]);
    if (value !== null) numericValues[key] = value;
  });

  if (type === 'earnings') {
    const surprise = toFiniteNumber(item.epsActual) !== null && toFiniteNumber(item.epsEstimate) !== null
      ? round(toFiniteNumber(item.epsActual) - toFiniteNumber(item.epsEstimate), 2)
      : null;
    return {
      externalId,
      source,
      symbol,
      type,
      eventDate,
      title: `${symbol} earnings${item.quarter ? ` Q${item.quarter}` : ''}${item.year ? ` ${item.year}` : ''}`,
      summary: surprise !== null
        ? `EPS surprise ${surprise >= 0 ? '+' : ''}${surprise}.`
        : 'Upcoming or recent earnings event.',
      url: item.url || null,
      sentiment: surprise === null ? 'neutral' : (surprise >= 0 ? 'positive' : 'negative'),
      numericValues,
      rawPayload: item
    };
  }

  if (type === 'analyst_rating') {
    const positive = (toFiniteNumber(item.strongBuy, 0) || 0) + (toFiniteNumber(item.buy, 0) || 0);
    const negative = (toFiniteNumber(item.sell, 0) || 0) + (toFiniteNumber(item.strongSell, 0) || 0);
    return {
      externalId,
      source,
      symbol,
      type,
      eventDate,
      title: `${symbol} analyst rating mix`,
      summary: `${positive} buy-side recommendations, ${toFiniteNumber(item.hold, 0) || 0} holds, ${negative} sell-side recommendations.`,
      url: item.url || null,
      sentiment: positive > negative ? 'positive' : (negative > positive ? 'negative' : 'neutral'),
      numericValues,
      rawPayload: item
    };
  }

  if (type === 'sec_filing') {
    const form = item.form || item.type || 'SEC filing';
    return {
      externalId,
      source,
      symbol,
      type,
      eventDate,
      title: `${symbol} ${form} filing`,
      summary: item.description || item.reportTitle || `${form} filed with the SEC.`,
      url: item.reportUrl || item.filingUrl || item.url || null,
      sentiment: 'neutral',
      numericValues,
      rawPayload: item
    };
  }

  if (type === 'dividend') {
    const amount = toFiniteNumber(item.amount ?? item.dividend);
    return {
      externalId,
      source,
      symbol,
      type,
      eventDate,
      title: `${symbol} dividend`,
      summary: amount !== null ? `Dividend amount ${amount}.` : 'Dividend event.',
      url: item.url || null,
      sentiment: 'neutral',
      numericValues,
      rawPayload: item
    };
  }

  if (type === 'split') {
    const fromFactor = toFiniteNumber(item.fromFactor);
    const toFactor = toFiniteNumber(item.toFactor);
    return {
      externalId,
      source,
      symbol,
      type,
      eventDate,
      title: `${symbol} stock split`,
      summary: fromFactor && toFactor ? `Split ratio ${fromFactor}:${toFactor}.` : 'Stock split event.',
      url: item.url || null,
      sentiment: 'neutral',
      numericValues,
      rawPayload: item
    };
  }

  const insiderName = item.name || item.ownerName || 'Insider';
  const change = toFiniteNumber(item.change);
  return {
    externalId,
    source,
    symbol,
    type: 'insider_activity',
    eventDate,
    title: `${symbol} insider activity`,
    summary: `${insiderName}${change !== null ? ` changed holdings by ${change} shares` : ' reported a transaction'}.`,
    url: item.url || null,
    sentiment: change === null ? 'neutral' : (change >= 0 ? 'positive' : 'negative'),
    numericValues,
    rawPayload: item
  };
}

function extractFinnhubItems(type, payload) {
  if (type === 'earnings') return payload?.earningsCalendar || payload?.earnings || [];
  if (type === 'insider_activity') return payload?.data || [];
  return Array.isArray(payload) ? payload : [];
}

async function fetchFinnhubEventsForSymbol(symbol) {
  const normalized = normalizeSymbol(symbol);
  const now = new Date();
  const from = toDateInput(addDays(now, -EVENT_LOOKBACK_DAYS));
  const to = toDateInput(addDays(now, EVENT_LOOKAHEAD_DAYS));
  const definitions = [
    { type: 'earnings', path: '/api/v1/calendar/earnings', params: { symbol: normalized, from, to } },
    { type: 'analyst_rating', path: '/api/v1/stock/recommendation', params: { symbol: normalized } },
    { type: 'sec_filing', path: '/api/v1/stock/filings', params: { symbol: normalized, from, to } },
    { type: 'dividend', path: '/api/v1/stock/dividend', params: { symbol: normalized, from, to } },
    { type: 'split', path: '/api/v1/stock/split', params: { symbol: normalized, from, to } },
    { type: 'insider_activity', path: '/api/v1/stock/insider-transactions', params: { symbol: normalized, from, to } }
  ];

  if (!FINNHUB_API_KEY) {
    return {
      events: [],
      providerHealth: definitions.map((definition, index) => providerDisabled(
        `finnhub_${definition.type}`,
        'events',
        index + 1,
        'Missing FINNHUB_API_KEY.'
      ))
    };
  }

  const results = await Promise.all(definitions.map(async (definition, index) => {
    const startedAt = Date.now();
    try {
      const response = await axios.get(`${FINNHUB_BASE_URL}${definition.path}`, {
        params: { ...definition.params, token: FINNHUB_API_KEY },
        timeout: 12000
      });
      const items = extractFinnhubItems(definition.type, response.data);
      const normalizedItems = items
        .map(item => normalizeResearchEvent(definition.type, item, normalized, 'finnhub'))
        .filter(item => item.symbol);
      return {
        events: normalizedItems,
        health: providerHealth({
          provider: `finnhub_${definition.type}`,
          category: 'events',
          rank: index + 1,
          status: 'ok',
          latencyMs: Date.now() - startedAt,
          itemCount: normalizedItems.length
        })
      };
    } catch (err) {
      return {
        events: [],
        health: providerHealth({
          provider: `finnhub_${definition.type}`,
          category: 'events',
          rank: index + 1,
          status: 'error',
          latencyMs: Date.now() - startedAt,
          message: errorMessage(err)
        })
      };
    }
  }));
  const events = results.flatMap(result => result.events);
  const health = results.map(result => result.health);
  return { events, providerHealth: health };
}

async function persistResearchEvents(items = [], ResearchEvent) {
  if (!ResearchEvent || !items.length) return items;
  const saved = [];
  for (const item of items) {
    const doc = await ResearchEvent.findOneAndUpdate(
      { source: item.source, externalId: item.externalId, type: item.type, symbol: item.symbol },
      { $set: item },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).lean();
    saved.push(doc);
  }
  return saved;
}

async function getPersistedEvents(symbol, ResearchEvent, { limit = 50 } = {}) {
  if (!ResearchEvent) return [];
  return ResearchEvent.find({ symbol: normalizeSymbol(symbol) })
    .sort({ eventDate: -1, updatedAt: -1 })
    .limit(limit)
    .lean();
}

async function refreshResearchEvents(symbol, ResearchEvent, options = {}) {
  const result = await fetchFinnhubEventsForSymbol(symbol);
  await persistResearchEvents(result.events, ResearchEvent);
  const events = await getPersistedEvents(symbol, ResearchEvent, { limit: options.limit || 50 });
  return {
    events: events.length ? events : result.events,
    providerHealth: result.providerHealth
  };
}

async function captureProviderResult({ provider, category, rank, fn, fallbackValue }) {
  const startedAt = Date.now();
  try {
    const data = await fn();
    const count = Array.isArray(data) ? data.length : (data ? 1 : 0);
    return {
      data,
      health: providerHealth({
        provider,
        category,
        rank,
        status: 'ok',
        latencyMs: Date.now() - startedAt,
        itemCount: count
      })
    };
  } catch (err) {
    return {
      data: fallbackValue,
      health: providerHealth({
        provider,
        category,
        rank,
        status: 'error',
        latencyMs: Date.now() - startedAt,
        message: errorMessage(err)
      })
    };
  }
}

function getResearchProviderHealth() {
  return {
    providers: [
      providerHealth({
        provider: 'alpaca_market_data',
        category: 'marketData',
        rank: 1,
        configured: Boolean(API_KEY && API_SECRET),
        status: API_KEY && API_SECRET ? 'configured' : 'disabled',
        message: API_KEY && API_SECRET ? 'Alpaca market data credentials are present.' : 'Missing Alpaca market data credentials.'
      }),
      providerHealth({
        provider: 'alpaca_news',
        category: 'news',
        rank: 1,
        configured: Boolean(API_KEY && API_SECRET),
        status: API_KEY && API_SECRET ? 'configured' : 'disabled',
        message: API_KEY && API_SECRET ? 'Alpaca news credentials are present.' : 'Missing Alpaca news credentials.'
      }),
      providerHealth({
        provider: 'research_snapshot_cache',
        category: 'cache',
        rank: 1,
        configured: true,
        status: 'configured',
        message: 'Mongo-backed research snapshots are enabled.'
      }),
      providerHealth({
        provider: 'finnhub_events',
        category: 'events',
        rank: 1,
        configured: Boolean(FINNHUB_API_KEY),
        status: FINNHUB_API_KEY ? 'configured' : 'disabled',
        message: FINNHUB_API_KEY ? 'Finnhub corporate event credentials are present.' : 'Missing FINNHUB_API_KEY.'
      }),
      providerHealth({
        provider: 'research_fallback',
        category: 'news',
        rank: 3,
        configured: true,
        fallback: true,
        status: 'configured',
        message: 'Fallback research placeholders are available when primary news is unavailable.'
      })
    ],
    checkedAt: new Date().toISOString()
  };
}

async function getStockResearch(symbol, {
  ResearchNews,
  ResearchEvent,
  ResearchSnapshot,
  analysisEngine = null,
  forceRefresh = false
} = {}) {
  const normalized = normalizeSymbol(symbol);
  const cacheKey = researchCacheKey('stock', [normalized]);
  if (!forceRefresh) {
    const cached = await readResearchSnapshot(ResearchSnapshot, cacheKey);
    if (cached) return cached;
  }

  const [dailyResult, intradayResult, companyResult, quoteResult, newsResult, eventsResult] = await Promise.all([
    captureProviderResult({
      provider: 'alpaca_daily_bars',
      category: 'marketData',
      rank: 1,
      fn: () => fetchDaily(normalized),
      fallbackValue: []
    }),
    captureProviderResult({
      provider: 'alpaca_intraday_bars',
      category: 'marketData',
      rank: 2,
      fn: () => fetchIntraday(normalized),
      fallbackValue: []
    }),
    captureProviderResult({
      provider: 'alpaca_asset_profile',
      category: 'profile',
      rank: 1,
      fn: () => fetchCompany(normalized),
      fallbackValue: {
        symbol: normalized,
        name: normalized,
        exchange: null,
        status: null,
        tradable: null,
        fractionable: null,
        shortable: null
      }
    }),
    captureProviderResult({
      provider: 'alpaca_latest_quote',
      category: 'marketData',
      rank: 3,
      fn: () => fetchQuotes([normalized], { assetClass: 'equity' }),
      fallbackValue: []
    }),
    refreshNewsDetailed([normalized], ResearchNews, { limit: 20 }),
    refreshResearchEvents(normalized, ResearchEvent, { limit: 50 })
  ]);

  const dailyBars = dailyResult.data || [];
  const intradayBars = intradayResult.data || [];
  const quoteItems = quoteResult.data || [];
  const company = companyResult.data;
  const news = newsResult.news || [];
  const events = eventsResult.events || [];
  const providerHealthRecords = [
    dailyResult.health,
    intradayResult.health,
    companyResult.health,
    quoteResult.health,
    ...(newsResult.providerHealth || []),
    ...(eventsResult.providerHealth || [])
  ].filter(Boolean);

  const technicals = computeTechnicals(dailyBars);
  const intraday = intradayBars.map(normalizeBar);
  const analysis = analysisEngine?.analyzeDeterministic
    ? await analysisEngine.analyzeDeterministic({ symbol: normalized }).catch(() => null)
    : null;
  const thesis = buildStockThesis({
    symbol: normalized,
    technicals,
    news,
    events,
    analysis
  });
  const staleWarnings = buildStaleWarnings({
    dailyBars: technicals.bars,
    intradayBars: intraday,
    news,
    events,
    quotes: quoteItems,
    providerHealth: providerHealthRecords
  });

  const payload = {
    symbol: normalized,
    company,
    quote: quoteItems[0] || null,
    technicals,
    chart: {
      daily: technicals.bars.slice(-252),
      intraday: intraday.slice(-120)
    },
    news,
    events,
    thesis,
    analysis,
    updatedAt: new Date().toISOString(),
    dataQuality: buildDataQuality({
      providerHealth: providerHealthRecords,
      staleWarnings,
      cache: { status: 'miss', key: cacheKey }
    })
  };
  return writeResearchSnapshot(ResearchSnapshot, {
    key: cacheKey,
    scope: 'stock',
    symbols: [normalized],
    payload,
    ttlMs: STOCK_SNAPSHOT_TTL_MS
  });
}

async function getResearchDashboard({
  symbols = DEFAULT_WATCHLIST.slice(0, 8).map(item => item.symbol),
  ResearchNews,
  ResearchSnapshot,
  forceRefresh = false
} = {}) {
  const normalized = uniqueSymbols(symbols).slice(0, 12);
  const cacheKey = researchCacheKey('dashboard', normalized);
  if (!forceRefresh) {
    const cached = await readResearchSnapshot(ResearchSnapshot, cacheKey);
    if (cached) return cached;
  }

  const [quoteResult, newsResult] = await Promise.all([
    captureProviderResult({
      provider: 'alpaca_watchlist_quotes',
      category: 'marketData',
      rank: 1,
      fn: () => fetchQuotes(normalized, { assetClass: 'equity' }),
      fallbackValue: []
    }),
    refreshNewsDetailed(normalized, ResearchNews, { limit: 30 })
  ]);
  const benchmarkSymbols = ['SPY', 'QQQ', 'DIA', 'IWM'];
  const benchmarkResult = await captureProviderResult({
    provider: 'alpaca_benchmark_quotes',
    category: 'marketData',
    rank: 2,
    fn: () => fetchQuotes(benchmarkSymbols, { assetClass: 'equity' }),
    fallbackValue: []
  });
  const quotes = quoteResult.data || [];
  const benchmarks = benchmarkResult.data || [];
  const news = newsResult.news || [];
  const providerHealthRecords = [
    quoteResult.health,
    benchmarkResult.health,
    ...(newsResult.providerHealth || [])
  ].filter(Boolean);
  const sentimentCounts = news.reduce((acc, item) => {
    acc[item.sentiment] = (acc[item.sentiment] || 0) + 1;
    return acc;
  }, {});
  const staleWarnings = buildStaleWarnings({
    news,
    quotes: [...quotes, ...benchmarks],
    providerHealth: providerHealthRecords
  });

  const payload = {
    symbols: normalized,
    watchlist: quotes,
    benchmarks,
    news,
    sentiment: {
      positive: sentimentCounts.positive || 0,
      neutral: sentimentCounts.neutral || 0,
      negative: sentimentCounts.negative || 0
    },
    updatedAt: new Date().toISOString(),
    dataQuality: buildDataQuality({
      providerHealth: providerHealthRecords,
      staleWarnings,
      cache: { status: 'miss', key: cacheKey }
    })
  };
  return writeResearchSnapshot(ResearchSnapshot, {
    key: cacheKey,
    scope: 'dashboard',
    symbols: normalized,
    payload,
    ttlMs: DASHBOARD_SNAPSHOT_TTL_MS
  });
}

async function compareSymbols(symbols, { ResearchNews, ResearchSnapshot, forceRefresh = false } = {}) {
  const normalized = uniqueSymbols(symbols).slice(0, 6);
  const cacheKey = researchCacheKey('compare', normalized);
  if (!forceRefresh) {
    const cached = await readResearchSnapshot(ResearchSnapshot, cacheKey);
    if (cached) return cached;
  }

  const rows = await Promise.all(normalized.map(async symbol => {
    const [bars, quoteItems, news] = await Promise.all([
      fetchDaily(symbol).catch(() => []),
      fetchQuotes([symbol], { assetClass: 'equity' }).catch(() => []),
      getPersistedNewsForSymbols([symbol], ResearchNews, { limit: 5 })
    ]);
    const technicals = computeTechnicals(bars);
    return {
      symbol,
      price: quoteItems[0]?.price ?? technicals.latestPrice,
      changePercent: quoteItems[0]?.changePercent ?? technicals.changePercent,
      trend: technicals.trend,
      rsi14: technicals.rsi14,
      atrPercent: technicals.atrPercent,
      volumeRatio: technicals.volumeRatio,
      support20: technicals.support20,
      resistance20: technicals.resistance20,
      positiveNews: news.filter(item => item.sentiment === 'positive').length,
      negativeNews: news.filter(item => item.sentiment === 'negative').length
    };
  }));
  const payload = {
    symbols: normalized,
    rows,
    updatedAt: new Date().toISOString(),
    dataQuality: buildDataQuality({
      cache: { status: 'miss', key: cacheKey }
    })
  };
  return writeResearchSnapshot(ResearchSnapshot, {
    key: cacheKey,
    scope: 'compare',
    symbols: normalized,
    payload,
    ttlMs: COMPARE_SNAPSHOT_TTL_MS
  });
}

module.exports = {
  buildStockThesis,
  buildDataQuality,
  buildStaleWarnings,
  compareSymbols,
  computeTechnicals,
  getResearchProviderHealth,
  getResearchDashboard,
  getStockResearch,
  normalizeResearchEvent,
  normalizeNewsItem,
  normalizeSymbol,
  refreshResearchEvents,
  refreshNews,
  scoreSentiment
};
