const config = {
  priceFloorEnabled: process.env.QUALITY_PRICE_FLOOR_ENABLED === 'true',
  priceFloor: Number(process.env.QUALITY_PRICE_FLOOR || 5),
  minDollarVolume: Number(process.env.QUALITY_MIN_DOLLAR_VOLUME || 20000000),
  maxAtrPct: Number(process.env.QUALITY_MAX_ATR_PCT || 0.08),
  maxRangePct: Number(process.env.QUALITY_MAX_RANGE_PCT || 0.05),
  minBars: Number(process.env.QUALITY_MIN_BARS || 50)
};

module.exports = { config };
