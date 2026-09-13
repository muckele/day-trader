import axios from 'axios';
const fields = ['symbol', 'side', 'qty', 'assetClass', 'orderType', 'timeInForce', 'goodTilDate', 'limitPrice', 'stopPrice', 'stopLossPrice', 'takeProfitPrice', 'trailingStopPct', 'maxPricePerShare', 'allowExtendedHours', 'strategyId', 'origin'];
const terminal = new Set(['filled', 'canceled', 'cancelled', 'rejected', 'expired']);
const inFlight = new Map();
const recordKey = key => `alpaca-request-state:${key}`;
export const PAPER_REQUEST_EVENT = 'paper-request-changed';
function requestIdentity(payload) {
  return JSON.stringify(fields.map(field => [field, payload[field] ?? null]).concat([
    ['tradePlanId', payload.metadata?.tradePlanId || null], ['tradeIdeaId', payload.metadata?.tradeIdeaId || null]
  ]));
}
function newKey() {
  const bytes = new Uint8Array(16);
  window.crypto.getRandomValues(bytes);
  return `web-${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`;
}
function read(key) {
  if (!key) return null;
  const stored = sessionStorage.getItem(recordKey(key));
  return stored ? JSON.parse(stored) : null;
}
function save(record) {
  sessionStorage.setItem(recordKey(record.key), JSON.stringify(record));
  sessionStorage.setItem(`alpaca-request-latest:${record.surface}`, record.key);
  sessionStorage.setItem(`alpaca-request-latest:${record.surface}:${record.payload.symbol}`, record.key);
  window.dispatchEvent(new Event(PAPER_REQUEST_EVENT));
  return record;
}
export function getLatestPaperRequest(surface = 'stock', symbol) {
  return read(sessionStorage.getItem(`alpaca-request-latest:${surface}${symbol ? `:${symbol}` : ''}`));
}
export function canPrepareAnotherPaperOrder(record) {
  return Boolean(record && terminal.has(record.status) && sessionStorage.getItem(record.storageKey) === record.key && !inFlight.has(record.key));
}
function observe(record, data) {
  const order = data?.order || data?.intent;
  const admissionRejected = data?.admissionOutcome?.state === 'rejected_without_submission'
    && data.admissionOutcome.idempotencyKey === record.key && Boolean(data.admissionOutcome.intentId);
  return save({ ...record, status: order?.status || (admissionRejected ? 'rejected' : 'submission_uncertain'),
    intentId: order?.intentId || order?._id || record.intentId,
    filledQty: order?.filledQty ?? record.filledQty ?? 0,
    executionSource: data?.executionSource || order?.executionSource || record.executionSource,
    updatedAt: new Date().toISOString() });
}
// Pure preflight for the paper MVP's accepted economics. Invalid inputs never
// allocate an identity, so correcting a ticket cannot be trapped as uncertainty.
export function validatePaperOrderPayload(payload = {}) {
  const symbol = String(payload.symbol || '').trim().toUpperCase();
  const qty = Number(payload.qty);
  if (!/^[A-Z][A-Z0-9.]{0,14}$/.test(symbol) || !['buy', 'sell'].includes(payload.side) || !Number.isSafeInteger(qty) || qty <= 0) throw new Error('Choose a stock symbol, buy or sell, and a positive whole-share quantity.');
  if (payload.assetClass && !['equity', 'stocks', 'us_equity'].includes(payload.assetClass)) throw new Error('Only stock orders are supported for Alpaca paper trading.');
  let type = payload.orderType || 'market';
  let limit = payload.limitPrice;
  if (payload.side === 'buy' && type === 'market' && payload.maxPricePerShare) { type = 'limit'; limit = payload.maxPricePerShare; }
  if (payload.side === 'buy' && type !== 'limit') throw new Error('A paper entry needs an explicit limit price or maximum price per share.');
  if (payload.notional || payload.extendedHours || payload.extended_hours || (payload.orderClass && payload.orderClass !== 'simple') || (payload.order_class && payload.order_class !== 'simple') || payload.legs || payload.takeProfit || payload.take_profit || payload.stopLoss || payload.stop_loss || !['limit', 'market', 'stop'].includes(type) || payload.takeProfitPrice || payload.trailingStopPct || payload.allowExtendedHours) throw new Error('Advanced orders and extended-hours execution are unavailable for this paper release.');
  if (!['day', 'gtc'].includes(payload.timeInForce || 'day')) throw new Error('Choose day or good-till-canceled duration.');
  const priceCents = value => {
    const text = String(value ?? '');
    if (!/^\d+(\.\d{1,2})?$/.test(text)) throw new Error('Prices must be positive dollar amounts with at most two decimal places.');
    const [whole, fraction = ''] = text.split('.');
    const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('Prices must be positive safe dollar amounts.');
    return amount;
  };
  const limitCents = type === 'limit' ? priceCents(limit) : 0;
  if (payload.side === 'buy' && !Number.isSafeInteger(limitCents * qty)) throw new Error('Order amount exceeds safe monetary precision.');
  if (type === 'stop') priceCents(payload.stopPrice);
  if (payload.riskStopPrice || payload.stopLossPrice) priceCents(payload.riskStopPrice || payload.stopLossPrice);
}
export async function submitPaperOrder(payload, { surface = 'stock' } = {}) {
  validatePaperOrderPayload(payload);
  const storageKey = `alpaca-intent:${requestIdentity(payload)}`;
  const previous = getLatestPaperRequest(surface, payload.symbol);
  if (previous && previous.storageKey !== storageKey && !terminal.has(previous.status) && previous.status !== 'prepared') {
    throw new Error('Resolve or retry the previous order request before changing this ticket.');
  }
  let key = sessionStorage.getItem(storageKey);
  if (!key) { key = newKey(); sessionStorage.setItem(storageKey, key); }
  if (inFlight.has(key)) return inFlight.get(key);
  const record = save({ ...(read(key) || {}), key, storageKey, payload, surface, status: read(key)?.status || 'submitting' });
  const pending = axios.post('/api/paper-trades/order', payload, { headers: { 'Idempotency-Key': key } })
    .then(response => { observe(record, response.data); return response; })
    .catch(error => { observe(record, error.response?.data); throw error; })
    .finally(() => { inFlight.delete(key); window.dispatchEvent(new Event(PAPER_REQUEST_EVENT)); });
  inFlight.set(key, pending);
  return pending;
}
export function prepareAnotherPaperOrder(key) {
  const prior = read(key);
  if (!canPrepareAnotherPaperOrder(prior)) throw new Error('The previous request must be visibly resolved before preparing another order.');
  const next = { ...prior, key: newKey(), status: 'prepared', intentId: null, filledQty: 0, updatedAt: new Date().toISOString() };
  sessionStorage.setItem(prior.storageKey, next.key);
  return save(next);
}
export async function retryPaperOrder(key) {
  const record = read(key);
  if (!record || sessionStorage.getItem(record.storageKey) !== key) throw new Error('This request is no longer the active ticket.');
  return submitPaperOrder(record.payload, { surface: record.surface });
}
export async function refreshPaperOrderRequest(key) {
  const record = read(key);
  if (!record || record.status === 'prepared') return record;
  const { data } = await axios.get('/api/paper-trades/orders');
  const order = (Array.isArray(data) ? data : []).find(item => item.idempotencyKey === key || (record.intentId && String(item.intentId || item._id) === String(record.intentId)));
  if (!order) throw new Error('The previous request is not yet visible in persisted orders. Keep its request key and retry safely.');
  // Ignore a late refresh for a request that the user has already replaced explicitly.
  if (sessionStorage.getItem(record.storageKey) !== key) return read(sessionStorage.getItem(record.storageKey));
  return observe(record, { order });
}
export function paperOrderStatusMessage(status) {
  if (['intent_created', 'reserved', 'submitting', 'submission_uncertain', 'reconciliation_required', 'replace_pending'].includes(status)) return 'Broker confirmation pending. Capacity remains reserved; retrying this request reuses the same order intent.';
  if (status === 'filled') return 'Paper trade filled.';
  if (status === 'partially_filled') return 'Paper order partially filled; remaining quantity is pending.';
  if (status === 'cancel_pending') return 'Cancellation pending. The order may still fill.';
  if (['canceled', 'cancelled'].includes(status)) return 'Paper order canceled. Any confirmed fills remain.';
  if (status === 'rejected') return 'Paper order rejected.';
  if (status === 'expired') return 'Paper order expired. Any confirmed fills remain.';
  if (status === 'prepared') return 'New identical request prepared. Review and submit it explicitly.';
  if (['acknowledged', 'new', 'accepted'].includes(status)) return 'Paper order acknowledged; no fill is implied.';
  return 'Order status unavailable. Refresh or retry the existing request safely.';
}
