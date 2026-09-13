import axios from 'axios';
const pending = new Map();
const storageKey = symbol => `alpaca-position-close:${symbol}`;
export const terminalClose = record => Boolean(record && ['filled', 'flat', 'rejected', 'canceled'].includes(record.state));
export function readPositionClose(symbol) { const raw = sessionStorage.getItem(storageKey(symbol)); return raw ? JSON.parse(raw) : null; }
function save(symbol, record) { sessionStorage.setItem(storageKey(symbol), JSON.stringify(record)); return record; }
function fresh(symbol) {
  const bytes = new Uint8Array(16); window.crypto.getRandomValues(bytes);
  return save(symbol, { symbol, key: `web-close-${Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')}`, state: 'prepared' });
}
export function preparePositionClose(symbol) {
  const record = readPositionClose(symbol);
  if (!terminalClose(record) || pending.has(record.key)) throw new Error('The previous coordinated close must be resolved first.');
  return fresh(symbol);
}
export async function requestPositionClose(symbol) {
  const record = readPositionClose(symbol) || fresh(symbol);
  if (pending.has(record.key)) return pending.get(record.key);
  const operation = axios.post(`/api/robotrader/positions/${encodeURIComponent(symbol)}/close`, { idempotencyKey: record.key }, { headers: { 'Idempotency-Key': record.key } })
    .then(response => save(symbol, { ...record, ...response.data.close, key: record.key, executionSource: response.data.executionSource || 'alpaca-paper' }))
    .catch(error => { save(symbol, { ...record, state: 'submission_uncertain', error: error.response?.data?.error || error.message }); throw error; })
    .finally(() => pending.delete(record.key));
  pending.set(record.key, operation);
  return operation;
}
export async function refreshPositionClose(symbol) {
  const record = readPositionClose(symbol);
  if (!record || record.state === 'prepared') return record;
  const { data } = await axios.get('/api/robotrader/position-closes');
  const close = (data.closes || []).find(item => item.idempotencyKey === record.key);
  if (!close) throw new Error('Close request not yet confirmed. Retry the same request; do not start another close.');
  return save(symbol, { ...record, ...close, key: record.key });
}
