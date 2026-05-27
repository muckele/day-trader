const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildStockThesis,
  buildStaleWarnings,
  buildChartTimeframes,
  compareSymbols,
  computeTechnicals,
  normalizeNewsItem,
  normalizeResearchEvent,
  scoreSentiment
} = require('../services/researchService');

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
