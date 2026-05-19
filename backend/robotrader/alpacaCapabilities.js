const { normalizeAssetClass } = require('./settingsService');

const ALPACA_CAPABILITY_MATRIX = Object.freeze({
  stocks: {
    orderTypes: ['market', 'limit', 'stop', 'stop_limit', 'trailing_stop'],
    orderClasses: ['simple', 'bracket', 'oco', 'oto'],
    timeInForce: ['day', 'gtc', 'opg', 'cls', 'ioc', 'fok'],
    supportsNotional: true,
    supportsFractionalQty: true,
    supportsExtendedHours: true,
    supportsTakeProfitStopLoss: true,
    supportsMultiLeg: false
  },
  crypto: {
    orderTypes: ['market', 'limit', 'stop_limit'],
    orderClasses: ['simple'],
    timeInForce: ['gtc', 'ioc'],
    supportsNotional: true,
    supportsFractionalQty: true,
    supportsExtendedHours: false,
    supportsTakeProfitStopLoss: false,
    supportsMultiLeg: false
  },
  options: {
    orderTypes: ['market', 'limit'],
    orderClasses: ['simple', 'mleg'],
    timeInForce: ['day'],
    supportsNotional: false,
    supportsFractionalQty: false,
    supportsExtendedHours: false,
    supportsTakeProfitStopLoss: false,
    supportsMultiLeg: true
  }
});

function hasNumericValue(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0;
}

function validateAlpacaOrderRequest(input = {}) {
  const assetClass = normalizeAssetClass(input.assetClass) || 'stocks';
  const capability = ALPACA_CAPABILITY_MATRIX[assetClass];
  const orderType = String(input.orderType || input.type || 'market').trim().toLowerCase();
  const orderClass = String(input.orderClass || input.order_class || 'simple').trim().toLowerCase();
  const timeInForce = String(input.timeInForce || input.time_in_force || (assetClass === 'crypto' ? 'gtc' : 'day')).trim().toLowerCase();
  const side = String(input.side || '').trim().toLowerCase();
  const errors = [];

  if (!capability) errors.push(`Unsupported asset class ${assetClass}.`);
  if (!['buy', 'sell'].includes(side)) errors.push('Order side must be buy or sell.');
  if (!capability?.orderTypes.includes(orderType)) {
    errors.push(`${assetClass} orders do not support order type ${orderType}.`);
  }
  if (!capability?.orderClasses.includes(orderClass)) {
    errors.push(`${assetClass} orders do not support order class ${orderClass}.`);
  }
  if (!capability?.timeInForce.includes(timeInForce)) {
    errors.push(`${assetClass} orders do not support time_in_force ${timeInForce}.`);
  }

  if (input.extendedHours || input.extended_hours) {
    if (!capability?.supportsExtendedHours) {
      errors.push(`${assetClass} orders do not support extended_hours.`);
    }
    if (assetClass === 'stocks' && !(orderType === 'limit' && ['day', 'gtc'].includes(timeInForce))) {
      errors.push('Equity extended-hours orders must be limit orders with day or gtc time_in_force.');
    }
  }

  const hasQty = hasNumericValue(input.qty);
  const hasNotional = hasNumericValue(input.notional);
  if (hasQty && hasNotional) errors.push('Specify either qty or notional, not both.');
  if (!hasQty && !hasNotional) errors.push('Order requires qty or notional.');
  if (hasNotional && !capability?.supportsNotional) {
    errors.push(`${assetClass} orders do not support notional orders.`);
  }
  if (hasNotional && orderType !== 'market') {
    errors.push('Notional orders must use market order type.');
  }
  if (hasNotional && orderClass !== 'simple') {
    errors.push('Notional orders require simple order_class.');
  }

  if ((orderType === 'limit' || orderType === 'stop_limit') && !hasNumericValue(input.limitPrice ?? input.limit_price)) {
    errors.push(`${orderType} orders require limit_price.`);
  }
  if ((orderType === 'stop' || orderType === 'stop_limit') && !hasNumericValue(input.stopPrice ?? input.stop_price)) {
    errors.push(`${orderType} orders require stop_price.`);
  }
  if (orderType === 'trailing_stop') {
    const hasTrailPrice = hasNumericValue(input.trailPrice ?? input.trail_price);
    const hasTrailPercent = hasNumericValue(input.trailPercent ?? input.trail_percent);
    if (hasTrailPrice === hasTrailPercent) {
      errors.push('Trailing stop orders require exactly one of trail_price or trail_percent.');
    }
  }

  if (assetClass === 'crypto' && orderClass !== 'simple') {
    errors.push('Crypto orders only support simple order_class.');
  }
  if (assetClass === 'crypto' && orderType === 'trailing_stop') {
    errors.push('Crypto orders do not support trailing_stop.');
  }
  if (assetClass === 'crypto' && ['bracket', 'oco', 'oto'].includes(orderClass)) {
    errors.push('Crypto orders do not support bracket, oco, or oto order classes.');
  }
  if (assetClass === 'options') {
    const invalidOptionFields = [
      input.stopPrice ?? input.stop_price,
      input.trailPrice ?? input.trail_price,
      input.trailPercent ?? input.trail_percent,
      input.takeProfit ?? input.take_profit,
      input.stopLoss ?? input.stop_loss
    ].some(value => value !== undefined && value !== null && value !== '');
    if (invalidOptionFields) {
      errors.push('Options orders cannot include equity-only stop, trailing, take_profit, or stop_loss fields.');
    }
    if (orderClass === 'mleg' && (!Array.isArray(input.legs) || input.legs.length < 2)) {
      errors.push('Multi-leg options orders require at least two legs.');
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    normalized: {
      assetClass,
      orderType,
      orderClass,
      timeInForce,
      side
    },
    capability
  };
}

module.exports = {
  ALPACA_CAPABILITY_MATRIX,
  validateAlpacaOrderRequest
};
