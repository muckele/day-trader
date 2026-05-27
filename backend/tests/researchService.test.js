const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildStockThesis,
  buildStaleWarnings,
  buildChartTimeframes,
  buildWatchlistResearchSummary,
  compareSymbols,
  computeTechnicals,
  normalizeNewsItem,
  normalizeResearchEvent,
  scoreSentiment,
  screenStocks
} = require('../services/researchService');
const {
  buildResearchIntelligence,
  clusterNewsItems
} = require('../services/researchIntelligenceService');

function makeBars(count = 220) {
  let price = 100;
  return Array.from({ length: count }).map((_, index) => {
    price += 0.4;
    return {
      t: new Date(Date.UTC(2025, 0, index + 1)).toISOString(),
      o: price - 0.5,
      h: price + 1,
      l: price - 1,
      c: price,
      v: 1000000 + index * 1000
    };
  });
}

function makeDowntrendBars(count = 220) {
  let price = 180;
  return Array.from({ length: count }).map((_, index) => {
    price -= 0.35;
    return {
      t: new Date(Date.UTC(2025, 0, index + 1)).toISOString(),
      o: price + 0.5,
      h: price + 1,
      l: price - 1,
      c: price,
      v: 900000 + index * 500
    };
  });
}

function makeIntradayBars(count = 160) {
  let price = 120;
  return Array.from({ length: count }).map((_, index) => {
    price += Math.sin(index / 8) * 0.2 + 0.05;
    return {
      time: new Date(Date.UTC(2026, 4, 20, 13, index * 5)).toISOString(),
      open: price - 0.15,
      high: price + 0.4,
      low: price - 0.4,
      close: price,
      volume: 100000 + index * 100
    };
  });
}

test('research service computes stock technical summary fields', () => {
  const technicals = computeTechnicals(makeBars());

  assert.equal(technicals.dataPoints, 220);
  assert.equal(technicals.trend, 'uptrend');
  assert.ok(technicals.sma20 > technicals.sma50);
  assert.ok(technicals.support20 > 0);
  assert.ok(technicals.resistance20 > technicals.support20);
  assert.ok(technicals.volumeRatio > 0);
});

test('research service builds pro chart timeframes with indicators and markers', () => {
  const dailyBars = makeBars(320).map(bar => ({
    time: bar.t,
    open: bar.o,
    high: bar.h,
    low: bar.l,
    close: bar.c,
    volume: bar.v
  }));
  const timeframes = buildChartTimeframes({
    dailyBars,
    intradayBars: makeIntradayBars(),
    news: [{
      externalId: 'news-chart-1',
      headline: 'AAPL product catalyst',
      sentiment: 'positive',
      category: 'catalyst',
      publishedAt: dailyBars[dailyBars.length - 4].time
    }],
    events: [{
      externalId: 'event-chart-1',
      type: 'earnings',
      title: 'AAPL earnings',
      sentiment: 'neutral',
      eventDate: dailyBars[dailyBars.length - 2].time
    }]
  });

  assert.deepEqual(Object.keys(timeframes), ['1D', '5D', '1M', '3M', '6M', 'YTD', '1Y', '5Y']);
  assert.ok(timeframes['1Y'].bars.length > 0);
  assert.ok(Object.hasOwn(timeframes['1Y'].bars.at(-1), 'macd'));
  assert.ok(timeframes['1Y'].volumeProfile.length > 0);
  assert.ok(timeframes['1Y'].support > 0);
  assert.ok(timeframes['1Y'].markers.length > 0);
});

test('research screener filters momentum, sentiment, volume, sector, and trend', async () => {
  const result = await screenStocks({
    symbols: ['AAPL', 'JPM'],
    filters: {
      minMomentum: 3,
      minVolumeRatio: 0.8,
      newsSentiment: 'positive',
      sector: 'TECHNOLOGY',
      trend: 'uptrend'
    },
    fetchDailyFn: async symbol => (symbol === 'AAPL' ? makeBars(240) : makeDowntrendBars(240)),
    fetchQuotesFn: async symbols => symbols.map(symbol => ({
      symbol,
      assetClass: 'equity',
      price: symbol === 'AAPL' ? 195 : 120,
      changePercent: symbol === 'AAPL' ? 1.2 : -0.8
    })),
    newsItems: [
      normalizeNewsItem({
        id: 'aapl-positive',
        symbols: ['AAPL'],
        headline: 'AAPL beats guidance as analysts upgrade shares',
        created_at: '2026-05-27T12:00:00.000Z'
      }, ['AAPL']),
      normalizeNewsItem({
        id: 'jpm-negative',
        symbols: ['JPM'],
        headline: 'JPM downgraded after weak outlook',
        created_at: '2026-05-27T12:00:00.000Z'
      }, ['JPM'])
    ],
    eventItems: []
  });

  assert.equal(result.matchedCount, 1);
  assert.equal(result.rows[0].symbol, 'AAPL');
  assert.equal(result.rows[0].newsSentiment, 'positive');
  assert.equal(result.rows[0].sector, 'TECHNOLOGY');
  assert.equal(result.rows[0].technicalTrend, 'uptrend');
});

test('research screener treats empty numeric filters as disabled filters', async () => {
  const result = await screenStocks({
    symbols: ['AAPL'],
    filters: {
      minMomentum: '',
      maxVolatility: '',
      minVolumeRatio: '',
      earningsWithinDays: '',
      newsSentiment: 'any',
      trend: 'any'
    },
    fetchDailyFn: async () => makeBars(240),
    fetchQuotesFn: async symbols => symbols.map(symbol => ({
      symbol,
      assetClass: 'equity',
      price: 195,
      changePercent: 1.2
    })),
    newsItems: [],
    eventItems: []
  });

  assert.equal(result.totalCandidates, 1);
  assert.equal(result.matchedCount, 1);
  assert.equal(result.filters.minMomentum, null);
  assert.equal(result.filters.maxVolatility, null);
});

test('research watchlist summary aggregates screener rows and event risks', async () => {
  const result = await buildWatchlistResearchSummary({
    watchlist: {
      _id: 'watchlist-test',
      name: 'AI Leaders',
      symbols: ['AAPL', 'MSFT']
    },
    fetchDailyFn: async () => makeBars(240),
    fetchQuotesFn: async symbols => symbols.map(symbol => ({
      symbol,
      assetClass: 'equity',
      price: 210,
      changePercent: 1
    })),
    newsItems: [
      normalizeNewsItem({
        id: 'watchlist-news',
        symbols: ['AAPL', 'MSFT'],
        headline: 'AAPL and MSFT shares rise after product catalyst',
        created_at: '2026-05-27T12:00:00.000Z'
      }, ['AAPL', 'MSFT'])
    ],
    eventItems: [
      normalizeResearchEvent('earnings', {
        symbol: 'AAPL',
        date: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
        epsActual: 2.1,
        epsEstimate: 2
      }, 'AAPL')
    ]
  });

  assert.match(result.summary, /AI Leaders/);
  assert.equal(result.metrics.symbolCount, 2);
  assert.ok(result.topMomentum.length > 0);
  assert.ok(result.watchItems.length > 0);
  assert.ok(result.riskFlags.some(item => /earnings/i.test(item)));
});

test('research service excludes chart markers outside the visible bar range', () => {
  const dailyBars = makeBars(80).map(bar => ({
    time: bar.t,
    open: bar.o,
    high: bar.h,
    low: bar.l,
    close: bar.c,
    volume: bar.v
  }));
  const timeframes = buildChartTimeframes({
    dailyBars,
    news: [{
      externalId: 'old-news',
      headline: 'AAPL old headline',
      sentiment: 'neutral',
      publishedAt: '2020-01-01T00:00:00.000Z'
    }],
    events: [{
      externalId: 'future-event',
      type: 'earnings',
      title: 'AAPL future earnings',
      eventDate: '2030-01-01T00:00:00.000Z'
    }]
  });

  assert.equal(timeframes['1M'].markers.length, 0);
  assert.equal(timeframes['1Y'].markers.length, 0);
});

test('research service normalizes news with sentiment and category', () => {
  const item = normalizeNewsItem({
    id: 'news-1',
    symbols: ['AAPL'],
    headline: 'AAPL beats earnings and raises guidance',
    summary: 'Analysts upgrade shares after record revenue.',
    created_at: '2026-05-24T12:00:00.000Z'
  }, ['AAPL']);

  assert.equal(item.externalId, 'news-1');
  assert.equal(item.symbols[0], 'AAPL');
  assert.equal(item.category, 'earnings');
  assert.equal(item.sentiment, 'positive');
  assert.match(item.whyItMatters, /earnings/i);
});

test('research intelligence clusters duplicate headlines and preserves citations', () => {
  const clusters = clusterNewsItems([
    {
      externalId: 'aapl-1',
      source: 'alpaca',
      symbols: ['AAPL'],
      headline: 'Apple shares rise after earnings beat',
      summary: 'Investors reacted to stronger revenue.',
      sentiment: 'positive',
      category: 'earnings',
      url: 'https://example.test/apple-earnings-1',
      publishedAt: '2026-05-27T12:00:00.000Z'
    },
    {
      externalId: 'aapl-2',
      source: 'alpaca',
      symbols: ['AAPL'],
      headline: 'Apple shares rise after earnings beat, analyst says',
      summary: 'A similar update from another source.',
      sentiment: 'positive',
      category: 'earnings',
      url: 'https://example.test/apple-earnings-2',
      publishedAt: '2026-05-27T12:05:00.000Z'
    },
    {
      externalId: 'msft-1',
      source: 'alpaca',
      symbols: ['MSFT'],
      headline: 'Microsoft announces new cloud contract',
      sentiment: 'neutral',
      category: 'catalyst',
      publishedAt: '2026-05-27T13:00:00.000Z'
    }
  ]);

  assert.equal(clusters.length, 2);
  const appleCluster = clusters.find(item => item.symbols.includes('AAPL'));
  assert.equal(appleCluster.count, 2);
  assert.equal(appleCluster.citations.length, 2);
  assert.equal(appleCluster.citations.every(item => item.timestamp), true);
});

test('research service builds a balanced stock thesis from technicals and news', () => {
  const technicals = computeTechnicals(makeBars());
  const news = [
    { sentiment: 'positive' },
    { sentiment: 'neutral' }
  ];
  const events = [
    { type: 'earnings', eventDate: '2026-06-01T00:00:00.000Z' }
  ];
  const thesis = buildStockThesis({
    symbol: 'AAPL',
    technicals,
    news,
    events,
    analysis: { recommendation: 'LONG' }
  });

  assert.match(thesis.summary, /AAPL/);
  assert.match(thesis.summary, /corporate events/i);
  assert.ok(thesis.bullCase.length > 0);
  assert.ok(thesis.bearCase.length > 0);
  assert.ok(thesis.watchItems.length > 0);
  assert.ok(thesis.keyRisks.length > 0);
  assert.ok(thesis.confidence.label);
});

test('research intelligence uses AI output when a client is configured and strips profit promises', async () => {
  const technicals = computeTechnicals(makeBars());
  const news = [{
    externalId: 'news-ai-1',
    source: 'alpaca',
    symbols: ['AAPL'],
    headline: 'AAPL raises guidance after services strength',
    summary: 'Management commentary was stronger than expected.',
    sentiment: 'positive',
    category: 'earnings',
    publishedAt: '2026-05-27T12:00:00.000Z'
  }];
  const aiClient = {
    chat: {
      completions: {
        create: async request => {
          assert.equal(request.response_format.type, 'json_object');
          assert.equal(request.model, 'test-research-model');
          return {
            choices: [{
              message: {
                content: JSON.stringify({
                  summary: 'AAPL has stronger services momentum, but this is not a guaranteed profit.',
                  bullCase: ['Services growth and positive headlines support the bull case.'],
                  bearCase: ['Valuation and elevated expectations can pressure the stock.'],
                  keyRisks: ['Macro weakness can still override company-specific strength.'],
                  whatChangedToday: ['Guidance-related news improved the near-term narrative.'],
                  watchItems: ['Watch price reaction near resistance.'],
                  confidence: {
                    label: 'High',
                    score: 82,
                    rationale: 'Market data and news are both available.'
                  }
                })
              }
            }]
          };
        }
      }
    }
  };

  const result = await buildResearchIntelligence({
    symbol: 'AAPL',
    technicals,
    news,
    events: [],
    analysis: { recommendation: 'LONG' }
  }, {
    aiClient,
    model: 'test-research-model'
  });

  assert.equal(result.providerHealth.status, 'ok');
  assert.equal(result.intelligence.aiGenerated, true);
  assert.equal(result.intelligence.confidence.label, 'High');
  assert.doesNotMatch(result.intelligence.summary, /guaranteed profit/i);
  assert.equal(result.intelligence.citations.length > 0, true);
});

test('research intelligence reads AI model configuration at call time', async t => {
  const originalModel = process.env.RESEARCH_AI_MODEL;
  t.after(() => {
    if (originalModel === undefined) delete process.env.RESEARCH_AI_MODEL;
    else process.env.RESEARCH_AI_MODEL = originalModel;
  });
  process.env.RESEARCH_AI_MODEL = 'call-time-model';
  const technicals = computeTechnicals(makeBars());
  const aiClient = {
    chat: {
      completions: {
        create: async request => {
          assert.equal(request.model, 'call-time-model');
          return {
            choices: [{
              message: {
                content: JSON.stringify({
                  summary: 'AAPL research context is available.',
                  bullCase: ['Technical data is available.'],
                  bearCase: ['News context may remain incomplete.'],
                  keyRisks: ['Market volatility can change the setup.'],
                  whatChangedToday: ['No major same-day update was detected.'],
                  watchItems: ['Watch support and resistance.'],
                  confidence: { label: 'Medium', score: 61, rationale: 'Some data is available.' }
                })
              }
            }]
          };
        }
      }
    }
  };

  const result = await buildResearchIntelligence({
    symbol: 'AAPL',
    technicals,
    news: [],
    events: []
  }, { aiClient });

  assert.equal(result.providerHealth.model, 'call-time-model');
  assert.equal(result.intelligence.model, 'call-time-model');
});

test('research sentiment scorer distinguishes negative headlines', () => {
  const result = scoreSentiment('Company downgraded after weak guidance and lawsuit risk');
  assert.equal(result.sentiment, 'negative');
  assert.ok(result.sentimentScore < 0);
});

test('research service normalizes corporate event payloads', () => {
  const earnings = normalizeResearchEvent('earnings', {
    symbol: 'AAPL',
    date: '2026-05-24',
    epsActual: 2.1,
    epsEstimate: 1.9,
    quarter: 2,
    year: 2026
  }, 'AAPL');
  const filing = normalizeResearchEvent('sec_filing', {
    symbol: 'AAPL',
    accessionNumber: '0000320193-26-000001',
    form: '10-Q',
    filedDate: '2026-05-20',
    reportUrl: 'https://example.test/aapl-10q'
  }, 'AAPL');
  const insider = normalizeResearchEvent('insider_activity', {
    symbol: 'AAPL',
    name: 'Example Officer',
    transactionDate: '2026-05-22',
    change: -1000
  }, 'AAPL');

  assert.equal(earnings.type, 'earnings');
  assert.equal(earnings.sentiment, 'positive');
  assert.equal(earnings.numericValues.epsActual, 2.1);
  assert.equal(filing.type, 'sec_filing');
  assert.match(filing.title, /10-Q/);
  assert.equal(insider.sentiment, 'negative');
});

test('research event fallback ids are stable when provider ids are missing', () => {
  const first = normalizeResearchEvent('insider_activity', {
    symbol: 'AAPL',
    name: 'Example Officer',
    change: 100
  }, 'AAPL');
  const second = normalizeResearchEvent('insider_activity', {
    symbol: 'AAPL',
    name: 'Example Officer',
    change: 100
  }, 'AAPL');

  assert.equal(first.externalId, second.externalId);
});

test('research service emits stale warnings for missing provider data', () => {
  const warnings = buildStaleWarnings({
    dailyBars: [],
    intradayBars: [],
    news: [{ source: 'research_fallback', publishedAt: '2024-01-01T00:00:00.000Z' }],
    events: [],
    quotes: [{ symbol: 'AAPL', price: 0 }],
    providerHealth: [{ provider: 'finnhub_events', category: 'events', status: 'disabled', message: 'Missing key' }]
  });

  assert.ok(warnings.some(item => /Daily bar history/i.test(item)));
  assert.ok(warnings.some(item => /fallback/i.test(item)));
  assert.ok(warnings.some(item => /Corporate event data/i.test(item)));
  assert.ok(warnings.some(item => /not configured/i.test(item)));
});

test('research service only warns for requested data scopes', () => {
  const warnings = buildStaleWarnings({
    news: [{ source: 'alpaca', publishedAt: new Date().toISOString() }],
    quotes: [{ symbol: 'AAPL', price: 101 }]
  });

  assert.equal(warnings.some(item => /Daily bar history/i.test(item)), false);
  assert.equal(warnings.some(item => /Corporate event data/i.test(item)), false);
});

test('research compare returns row objects after parallel fetches', async () => {
  const result = await compareSymbols(['AAPL', 'MSFT']);

  assert.deepEqual(result.symbols, ['AAPL', 'MSFT']);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows.every(row => row && typeof row.symbol === 'string'), true);
});
