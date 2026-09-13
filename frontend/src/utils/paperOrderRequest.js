import axios from 'axios';
const fields = ['symbol', 'side', 'qty', 'assetClass', 'orderType', 'timeInForce', 'limitPrice', 'stopPrice', 'stopLossPrice', 'takeProfitPrice', 'maxPricePerShare', 'allowExtendedHours', 'strategyId', 'origin'];
function requestIdentity(payload) {
  return JSON.stringify(fields.map(field => [field, payload[field] ?? null]).concat([
    ['tradePlanId', payload.metadata?.tradePlanId || null], ['tradeIdeaId', payload.metadata?.tradeIdeaId || null]
  ]));
}
export async function submitPaperOrder(payload) {
  const storageKey = `alpaca-intent:${requestIdentity(payload)}`;
  let key = sessionStorage.getItem(storageKey);
  if (!key) {
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    key = `web-${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`;
    // Persist before network I/O. Lost responses, reloads and retries retain it.
    sessionStorage.setItem(storageKey, key);
  }
  return axios.post('/api/paper-trades/order', payload, { headers: { 'Idempotency-Key': key } });
}

export function paperOrderStatusMessage(status) {
  if (['intent_created', 'reserved', 'submitting', 'submission_uncertain', 'reconciliation_required', 'replace_pending'].includes(status)) {
    return 'Broker confirmation pending. Capacity remains reserved; retrying this request reuses the same order intent.';
  }
  if (status === 'filled') return 'Paper trade filled.';
  if (status === 'partially_filled') return 'Paper order partially filled; remaining quantity is pending.';
  return 'Paper order acknowledged.';
}
