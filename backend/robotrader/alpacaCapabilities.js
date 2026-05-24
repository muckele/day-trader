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

function isFractional(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 && !Number.isInteger(numeric);
}

function getNestedNumeric(input, objectKey, fieldKey) {
  const camelKey = fieldKey.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
  const value = input[objectKey]?.[fieldKey] ?? input[objectKey]?.[camelKey];
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
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
  if (hasNotional && assetClass === 'stocks' && !['market', 'limit', 'stop', 'stop_limit'].includes(orderType)) {
    errors.push('Equity notional orders require market, limit, stop, or stop_limit order type.');
  }
  if (hasNotional && assetClass === 'crypto' && !['market', 'limit', 'stop_limit'].includes(orderType)) {
    errors.push('Crypto notional orders require market, limit, or stop_limit order type.');
  }
  if (hasNotional && !['stocks', 'crypto'].includes(assetClass) && orderType !== 'market') {
    errors.push('Notional orders must use market order type for this asset class.');
  }
  if (hasNotional && assetClass === 'stocks' && timeInForce !== 'day') {
    errors.push('Equity notional orders require day time_in_force.');
  }
  if (hasNotional && orderClass !== 'simple') {
    errors.push('Notional orders require simple order_class.');
  }
  if (isFractional(input.qty) && assetClass === 'stocks') {
    if (orderClass !== 'simple') {
      errors.push('Fractional equity qty orders require simple order_class.');
    }
    if (!['market', 'limit', 'stop', 'stop_limit'].includes(orderType) || timeInForce !== 'day') {
      errors.push('Fractional equity qty orders require market, limit, stop, or stop_limit order type with day time_in_force.');
    }
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
  if (assetClass === 'stocks' && ['bracket', 'oco', 'oto'].includes(orderClass)) {
    const takeProfitLimit = getNestedNumeric(input, input.take_profit ? 'take_profit' : 'takeProfit', 'limit_price');
    const stopLossStop = getNestedNumeric(input, input.stop_loss ? 'stop_loss' : 'stopLoss', 'stop_price');
    const stopLossLimit = getNestedNumeric(input, input.stop_loss ? 'stop_loss' : 'stopLoss', 'limit_price');
    if (input.extendedHours || input.extended_hours) {
      errors.push('Advanced equity order classes do not support extended_hours.');
    }
    if (!['day', 'gtc'].includes(timeInForce)) {
      errors.push('Advanced equity order classes require day or gtc time_in_force.');
    }
    if (orderClass === 'oco' && orderType !== 'limit') {
      errors.push('OCO equity orders require limit order type.');
    }
    if (orderClass === 'bracket' || orderClass === 'oco') {
      if (!takeProfitLimit || !stopLossStop) {
        errors.push(`${orderClass} equity orders require take_profit.limit_price and stop_loss.stop_price.`);
      }
    }
    if (orderClass === 'oto' && !takeProfitLimit && !stopLossStop) {
      errors.push('OTO equity orders require take_profit or stop_loss.');
    }
    if (takeProfitLimit && stopLossStop) {
      if (side === 'buy' && takeProfitLimit <= stopLossStop) {
        errors.push('Buy advanced orders require take_profit.limit_price above stop_loss.stop_price.');
      }
      if (side === 'sell' && takeProfitLimit >= stopLossStop) {
        errors.push('Sell advanced orders require take_profit.limit_price below stop_loss.stop_price.');
      }
    }
    if (stopLossLimit && !stopLossStop) {
      errors.push('stop_loss.limit_price requires stop_loss.stop_price.');
    }
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
