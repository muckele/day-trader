const {
  buildClientOrderId,
  normalizeAlpacaSymbol
} = require('../services/alpacaTradingClient');
const { validateAlpacaOrderRequest } = require('./alpacaCapabilities');

function toOrderString(value) {
  return Number(value).toString();
}

function hasNumericValue(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0;
}

function mapOrderFields(input, normalized) {
  const payload = {
    symbol: normalizeAlpacaSymbol(
      input.symbol,
      normalized.assetClass === 'crypto' ? 'crypto' : 'equity'
    ),
    side: normalized.side,
    type: normalized.orderType,
    time_in_force: normalized.timeInForce,
    client_order_id: input.clientOrderId || input.client_order_id || buildClientOrderId({
      origin: 'robotrader',
      symbol: input.symbol
    })
  };

  if (normalized.orderClass !== 'simple') payload.order_class = normalized.orderClass;
  if (hasNumericValue(input.qty)) payload.qty = toOrderString(input.qty);
  if (hasNumericValue(input.notional)) payload.notional = toOrderString(input.notional);
  if (hasNumericValue(input.limitPrice ?? input.limit_price)) {
    payload.limit_price = toOrderString(input.limitPrice ?? input.limit_price);
  }
  if (hasNumericValue(input.stopPrice ?? input.stop_price)) {
    payload.stop_price = toOrderString(input.stopPrice ?? input.stop_price);
  }
  if (hasNumericValue(input.trailPrice ?? input.trail_price)) {
    payload.trail_price = toOrderString(input.trailPrice ?? input.trail_price);
  }
  if (hasNumericValue(input.trailPercent ?? input.trail_percent)) {
    payload.trail_percent = toOrderString(input.trailPercent ?? input.trail_percent);
  }
  if (input.extendedHours || input.extended_hours) payload.extended_hours = true;
  if (input.takeProfit || input.take_profit) payload.take_profit = input.takeProfit || input.take_profit;
  if (input.stopLoss || input.stop_loss) payload.stop_loss = input.stopLoss || input.stop_loss;
  if (Array.isArray(input.legs)) payload.legs = input.legs;

  return payload;
}

function buildRoboAlpacaOrderPayload(input = {}) {
  const validation = validateAlpacaOrderRequest(input);
  if (!validation.ok) {
    const err = new Error(validation.errors.join(' '));
    err.code = 'INVALID_ALPACA_ORDER_COMBINATION';
    err.validation = validation;
    throw err;
  }
  const payload = mapOrderFields(input, validation.normalized);
  if (!payload.symbol) {
    throw new Error('Symbol is required for Alpaca order submission.');
  }
  return {
    payload,
    normalized: validation.normalized,
    capability: validation.capability
  };
}

module.exports = {
  buildRoboAlpacaOrderPayload
};
