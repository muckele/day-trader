function toFiniteNumber(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function summarizeNewsItems(items = []) {
  return Array.isArray(items)
    ? items.slice(0, 3).map(item => ({
      headline: item.headline || item.title || null,
      sentiment: item.sentiment || null,
      category: item.category || null,
      publishedAt: item.publishedAt || item.createdAt || null,
      source: item.source || null
    }))
    : [];
}

function summarizeResearchSnapshot(research = {}) {
  const indicators = research.indicators || {};
  const barsAvailable = toFiniteNumber(
    research.dataQuality?.barsAvailable,
    Array.isArray(research.bars) ? research.bars.length : null
  );

  return {
    source: 'robotrader_research_summary',
    summaryVersion: 1,
    symbol: research.symbol || null,
    assetClass: research.assetClass || null,
    price: toFiniteNumber(research.price ?? research.quote?.price, null),
    volume: toFiniteNumber(indicators.recentVolume, null),
    averageVolume20: toFiniteNumber(indicators.avgVolume20, null),
    volumeRatio: toFiniteNumber(indicators.volumeRatio, null),
    volatility20: toFiniteNumber(indicators.volatility20, null),
    rsi14: toFiniteNumber(indicators.rsi14, null),
    sma20: toFiniteNumber(indicators.sma20, null),
    sma50: toFiniteNumber(indicators.sma50, null),
    sma200: toFiniteNumber(indicators.sma200, null),
    atr14: toFiniteNumber(indicators.atr14, null),
    atrPct: toFiniteNumber(indicators.atrPct, null),
    fiveDayChangePct: toFiniteNumber(indicators.fiveDayChangePct, null),
    twentyDayChangePct: toFiniteNumber(indicators.twentyDayChangePct, null),
    gap: indicators.gap || null,
    newsSentiment: research.news?.sentiment || null,
    newsItems: summarizeNewsItems(research.news?.items),
    earnings: {
      nextReportDate: research.earnings?.nextReportDate || null,
      source: research.earnings?.source || null
    },
    portfolioExposure: research.marketContext?.portfolioExposure || null,
    marketContext: {
      accountBuyingPower: toFiniteNumber(research.marketContext?.accountBuyingPower, null),
      openOrderCount: toFiniteNumber(research.marketContext?.openOrderCount, null)
    },
    dataQuality: {
      barsAvailable,
      dataError: research.dataQuality?.dataError || null
    },
    asOf: research.asOf || null
  };
}

module.exports = {
  summarizeResearchSnapshot
};
