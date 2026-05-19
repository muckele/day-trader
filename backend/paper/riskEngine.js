const {
  mapSymbolSector,
  mapCorrelationCluster,
  normalizeCompactSymbol
} = require('./marketMeta');

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toPositivePct(value, fallback = 0) {
  const numeric = toFiniteNumber(value, fallback);
  if (numeric <= 0) return 0;
  return numeric;
}

function getDailyLossLimitPct(assetClass, settings = {}) {
  if (assetClass === 'crypto') {
    return toPositivePct(settings.cryptoMaxDailyLossPct, settings.maxDailyLossPct || 2);
  }
  return toPositivePct(settings.maxDailyLossPct, 2);
}

function getSymbolExposureCapPct(assetClass, settings = {}) {
  if (assetClass === 'crypto') {
    return toPositivePct(settings.cryptoMaxPositionPct, settings.maxSymbolExposurePct || settings.maxPositionPct || 10);
  }
  return toPositivePct(settings.maxSymbolExposurePct, settings.maxPositionPct || 10);
}

function getVarVolatilityPct(assetClass, settings = {}) {
  if (assetClass === 'crypto') {
    return toPositivePct(settings.cryptoVarVolPct, (settings.varVolatilityPct || 2.5) * 1.5);
  }
  return toPositivePct(settings.varVolatilityPct, 2.5);
}

function deriveProjectedAbsoluteExposure({
  currentAbsExposure,
  currentQty,
  side,
  orderNotional
}) {
  const safeCurrent = Math.max(0, toFiniteNumber(currentAbsExposure, 0));
  const safeNotional = Math.max(0, toFiniteNumber(orderNotional, 0));
  if (!safeCurrent) return safeNotional;

  const increasing = (currentQty > 0 && side === 'buy') || (currentQty < 0 && side === 'sell');
  if (increasing) {
    return safeCurrent + safeNotional;
  }
  return Math.max(0, safeCurrent - safeNotional);
}

function aggregateExposureByGroup(positions = [], mapper, assetClassBySymbol = {}) {
  return positions.reduce((acc, position) => {
    const symbol = normalizeCompactSymbol(position.symbol);
    const assetClass = assetClassBySymbol[symbol] || 'equity';
    const key = mapper(symbol, assetClass);
    const exposure = Math.abs(toFiniteNumber(position.marketValue, 0));
    acc[key] = (acc[key] || 0) + exposure;
    return acc;
  }, {});
}

function evaluateUnifiedRisk({
  symbol,
  side,
  assetClass = 'equity',
  orderNotional,
  account,
  settings,
  currentPositionQty = 0
}) {
  const normalizedSymbol = normalizeCompactSymbol(symbol);
  const positions = Array.isArray(account?.positions) ? account.positions : [];
  const equity = Math.max(
    0,
    toFiniteNumber(account?.equity, settings?.startingCash || 0)
  );
  if (!equity) {
    return {
      ok: false,
      reason: 'Account equity is unavailable for risk checks.',
      reasonsBlocked: ['Account equity is unavailable for risk checks.'],
      metrics: {}
    };
  }

  const dailyPnl = toFiniteNumber(account?.dailyPnl, 0);
  const dailyLossLimitPct = getDailyLossLimitPct(assetClass, settings);
  const maxDailyLossDollar = equity * (dailyLossLimitPct / 100);
  if (dailyLossLimitPct > 0 && dailyPnl <= -maxDailyLossDollar) {
    const reason = `Global daily loss limit reached (${dailyLossLimitPct}% of equity).`;
    return {
      ok: false,
      reason,
      reasonsBlocked: [reason],
      metrics: {
        dailyPnl,
        maxDailyLossDollar: Number(maxDailyLossDollar.toFixed(2))
      }
    };
  }

  const currentSymbolPosition = positions.find(pos => normalizeCompactSymbol(pos.symbol) === normalizedSymbol);
  const currentSymbolExposure = Math.abs(toFiniteNumber(currentSymbolPosition?.marketValue, 0));
  const projectedSymbolExposure = deriveProjectedAbsoluteExposure({
    currentAbsExposure: currentSymbolExposure,
    currentQty: toFiniteNumber(currentPositionQty, 0),
    side,
    orderNotional
  });

  const symbolExposureCapPct = getSymbolExposureCapPct(assetClass, settings);
  const symbolCapDollar = equity * (symbolExposureCapPct / 100);
  if (symbolExposureCapPct > 0 && projectedSymbolExposure > symbolCapDollar) {
    const reason = `Per-symbol exposure cap exceeded (${symbolExposureCapPct}% of equity).`;
    return {
      ok: false,
      reason,
      reasonsBlocked: [reason],
      metrics: {
        projectedSymbolExposure: Number(projectedSymbolExposure.toFixed(2)),
        symbolCapDollar: Number(symbolCapDollar.toFixed(2))
      }
    };
  }

  const assetClassBySymbol = positions.reduce((acc, position) => {
    const key = normalizeCompactSymbol(position.symbol);
    acc[key] = position.assetClass || 'equity';
    return acc;
  }, {});
  assetClassBySymbol[normalizedSymbol] = assetClass;

  const currentSectorExposureMap = aggregateExposureByGroup(
    positions,
    mapSymbolSector,
    assetClassBySymbol
  );
  const sector = mapSymbolSector(normalizedSymbol, assetClass);
  const projectedSectorExposure = deriveProjectedAbsoluteExposure({
    currentAbsExposure: currentSectorExposureMap[sector] || 0,
    currentQty: toFiniteNumber(currentPositionQty, 0),
    side,
    orderNotional
  });
  const sectorCapPct = toPositivePct(settings?.maxSectorExposurePct, 35);
  const sectorCapDollar = equity * (sectorCapPct / 100);
  if (sectorCapPct > 0 && projectedSectorExposure > sectorCapDollar) {
    const reason = `Sector exposure cap exceeded (${sectorCapPct}% of equity).`;
    return {
      ok: false,
      reason,
      reasonsBlocked: [reason],
      metrics: {
        sector,
        projectedSectorExposure: Number(projectedSectorExposure.toFixed(2)),
        sectorCapDollar: Number(sectorCapDollar.toFixed(2))
      }
    };
  }

  const currentClusterExposureMap = aggregateExposureByGroup(
    positions,
    mapCorrelationCluster,
    assetClassBySymbol
  );
  const cluster = mapCorrelationCluster(normalizedSymbol, assetClass);
  const projectedClusterExposure = deriveProjectedAbsoluteExposure({
    currentAbsExposure: currentClusterExposureMap[cluster] || 0,
    currentQty: toFiniteNumber(currentPositionQty, 0),
    side,
    orderNotional
  });
  const clusterCapPct = toPositivePct(settings?.maxCorrelationClusterPct, 45);
  const clusterCapDollar = equity * (clusterCapPct / 100);
  if (clusterCapPct > 0 && projectedClusterExposure > clusterCapDollar) {
    const reason = `Correlation cluster cap exceeded (${clusterCapPct}% of equity).`;
    return {
      ok: false,
      reason,
      reasonsBlocked: [reason],
      metrics: {
        cluster,
        projectedClusterExposure: Number(projectedClusterExposure.toFixed(2)),
        clusterCapDollar: Number(clusterCapDollar.toFixed(2))
      }
    };
  }

  const currentTotalExposure = positions.reduce(
    (sum, position) => sum + Math.abs(toFiniteNumber(position.marketValue, 0)),
    0
  );
  const projectedTotalExposure = Math.max(
    0,
    currentTotalExposure + (projectedSymbolExposure - currentSymbolExposure)
  );
  const varVolatilityPct = getVarVolatilityPct(assetClass, settings);
  const maxVarPct = toPositivePct(settings?.maxVarPct, 6);
  const var95Dollar = projectedTotalExposure * (varVolatilityPct / 100) * 1.65;
  const var95Pct = equity ? (var95Dollar / equity) * 100 : 0;
  if (maxVarPct > 0 && var95Pct > maxVarPct) {
    const reason = `Projected VaR guardrail exceeded (${maxVarPct}% of equity).`;
    return {
      ok: false,
      reason,
      reasonsBlocked: [reason],
      metrics: {
        projectedTotalExposure: Number(projectedTotalExposure.toFixed(2)),
        projectedVar95Dollar: Number(var95Dollar.toFixed(2)),
        projectedVar95Pct: Number(var95Pct.toFixed(2)),
        maxVarPct
      }
    };
  }

  return {
    ok: true,
    reason: null,
    reasonsBlocked: [],
    metrics: {
      projectedSymbolExposure: Number(projectedSymbolExposure.toFixed(2)),
      projectedSectorExposure: Number(projectedSectorExposure.toFixed(2)),
      projectedClusterExposure: Number(projectedClusterExposure.toFixed(2)),
      projectedVar95Pct: Number(var95Pct.toFixed(2))
    }
  };
}

module.exports = {
  evaluateUnifiedRisk,
  deriveProjectedAbsoluteExposure
};
