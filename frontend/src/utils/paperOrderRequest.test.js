import axios from 'axios';
import { submitPaperOrder, paperOrderStatusMessage } from './paperOrderRequest';
jest.mock('axios');
beforeAll(() => { Object.defineProperty(window, 'crypto', { value: require('crypto').webcrypto, configurable: true }); });
beforeEach(() => { sessionStorage.clear(); jest.clearAllMocks(); });
test('retry after lost response reuses the same stable request key', async () => {
  axios.post.mockRejectedValueOnce(new Error('timeout')).mockResolvedValue({ data: { order: { status: 'acknowledged' } } });
  const payload = { symbol: 'SPY', side: 'buy', qty: 1, orderType: 'limit', limitPrice: 100 };
  await expect(submitPaperOrder(payload)).rejects.toThrow('timeout');
  await submitPaperOrder(payload);
  expect(axios.post.mock.calls[0][2].headers['Idempotency-Key']).toBe(axios.post.mock.calls[1][2].headers['Idempotency-Key']);
});
test('changed quantity creates a different logical request', async () => {
  axios.post.mockResolvedValue({ data: { order: { status: 'filled' } } });
  await submitPaperOrder({ symbol: 'SPY', side: 'buy', qty: 1, orderType: 'limit', limitPrice: 100 });
  await submitPaperOrder({ symbol: 'SPY', side: 'buy', qty: 2, orderType: 'limit', limitPrice: 100 });
  expect(axios.post.mock.calls[0][2].headers['Idempotency-Key']).not.toBe(axios.post.mock.calls[1][2].headers['Idempotency-Key']);
});

test('uncertain states do not claim broker acknowledgement or fill', () => {
  for (const status of ['reserved', 'submitting', 'submission_uncertain', 'reconciliation_required']) {
    expect(paperOrderStatusMessage(status)).toMatch(/confirmation pending/);
  }
  expect(paperOrderStatusMessage('partially_filled')).toMatch(/partially filled/);
});

test('parallel duplicate actions share one in-flight HTTP request', async () => {
  let resolve;
  axios.post.mockReturnValue(new Promise(done => { resolve = done; }));
  const payload = { symbol: 'SPY', side: 'buy', qty: 1, orderType: 'limit', limitPrice: 100 };
  const first = submitPaperOrder(payload);
  const second = submitPaperOrder(payload);
  expect(axios.post).toHaveBeenCalledTimes(1);
  resolve({ data: { order: { status: 'acknowledged' } } });
  await Promise.all([first, second]);
});

test('explicit preparation after terminal response creates one new key without submitting', async () => {
  const { getLatestPaperRequest, prepareAnotherPaperOrder } = require('./paperOrderRequest');
  const payload = { symbol: 'SPY', side: 'buy', qty: 1, orderType: 'limit', limitPrice: 100 };
  axios.post.mockResolvedValue({ data: { order: { status: 'filled', filledQty: 1 } } });
  await submitPaperOrder(payload);
  const prior = getLatestPaperRequest('stock');
  prepareAnotherPaperOrder(prior.key);
  expect(axios.post).toHaveBeenCalledTimes(1);
  expect(() => prepareAnotherPaperOrder(prior.key)).toThrow();
  await submitPaperOrder(payload);
  expect(axios.post.mock.calls[0][2].headers['Idempotency-Key']).not.toBe(axios.post.mock.calls[1][2].headers['Idempotency-Key']);
});

test('uncertain request cannot be replaced with a fresh key or different economic payload', async () => {
  const { getLatestPaperRequest, prepareAnotherPaperOrder } = require('./paperOrderRequest');
  axios.post.mockRejectedValue(new Error('lost response'));
  await expect(submitPaperOrder({ symbol: 'SPY', side: 'buy', qty: 1, orderType: 'limit', limitPrice: 100 })).rejects.toThrow();
  expect(() => prepareAnotherPaperOrder(getLatestPaperRequest('stock').key)).toThrow(/resolved/i);
  await expect(submitPaperOrder({ symbol: 'SPY', side: 'buy', qty: 2, orderType: 'limit', limitPrice: 100 })).rejects.toThrow(/previous/i);
  expect(axios.post).toHaveBeenCalledTimes(1);
});

test('refresh binds persisted server status only to matching request identity', async () => {
  const { getLatestPaperRequest, refreshPaperOrderRequest } = require('./paperOrderRequest');
  axios.post.mockResolvedValue({ data: { order: { status: 'submission_uncertain' } } });
  await submitPaperOrder({ symbol: 'SPY', side: 'buy', qty: 1, orderType: 'limit', limitPrice: 100 });
  const record = getLatestPaperRequest('stock');
  axios.get.mockResolvedValue({ data: [{ idempotencyKey: 'unrelated', status: 'filled' }, { idempotencyKey: record.key, status: 'partially_filled', qty: 1, filledQty: 0.5, executionSource: 'alpaca-paper' }] });
  const refreshed = await refreshPaperOrderRequest(record.key);
  expect(refreshed.status).toBe('partially_filled');
  expect(refreshed.filledQty).toBe(0.5);
});

test('explicit durable rejection outcome permits corrected ticket after pre-admission risk refusal', async () => {
  const { getLatestPaperRequest } = require('./paperOrderRequest');
  axios.post.mockImplementationOnce((url, payload, config) => Promise.reject(Object.assign(new Error('Maximum trade amount exceeded'), { response: { status: 400, data: { admissionOutcome: { state: 'rejected_without_submission', idempotencyKey: config.headers['Idempotency-Key'], intentId: 'durable-rejection' } } } })));
  await expect(submitPaperOrder({ symbol: 'AAPL', side: 'buy', qty: 10, orderType: 'limit', limitPrice: 100 })).rejects.toThrow('Maximum');
  expect(getLatestPaperRequest('stock').status).toBe('rejected');
  axios.post.mockResolvedValueOnce({ data: { order: { status: 'acknowledged' } } });
  await submitPaperOrder({ symbol: 'AAPL', side: 'buy', qty: 1, orderType: 'limit', limitPrice: 100 });
  expect(axios.post.mock.calls[0][2].headers['Idempotency-Key']).not.toBe(axios.post.mock.calls[1][2].headers['Idempotency-Key']);
});

test('HTTP error status alone and a foreign rejection identity remain uncertain', async () => {
  const { getLatestPaperRequest } = require('./paperOrderRequest');
  axios.post.mockRejectedValueOnce(Object.assign(new Error('bad request'), { response: { status: 400, data: { error: 'bad request' } } }));
  await expect(submitPaperOrder({ symbol: 'AAPL', side: 'buy', qty: 1, orderType: 'limit', limitPrice: 100 })).rejects.toThrow();
  expect(getLatestPaperRequest('stock').status).toBe('submission_uncertain');
  axios.post.mockRejectedValueOnce(Object.assign(new Error('conflict'), { response: { status: 409, data: { admissionOutcome: { state: 'rejected_without_submission', idempotencyKey: 'foreign-key', intentId: 'another-intent' } } } }));
  await expect(submitPaperOrder({ symbol: 'AAPL', side: 'buy', qty: 1, orderType: 'limit', limitPrice: 100 })).rejects.toThrow();
  expect(getLatestPaperRequest('stock').status).toBe('submission_uncertain');
  expect(axios.post.mock.calls[0][2].headers['Idempotency-Key']).toBe(axios.post.mock.calls[1][2].headers['Idempotency-Key']);
});

test('invalid paper economics allocate no request key and corrected input submits normally', async () => {
  const { getLatestPaperRequest } = require('./paperOrderRequest');
  const valid = { symbol: 'AAPL', side: 'buy', qty: 1, orderType: 'limit', limitPrice: 100, allowExtendedHours: false };
  for (const patch of [{ qty: 0.5 }, { limitPrice: '' }, { limitPrice: -1 }, { limitPrice: '1.001' }, { orderType: 'market' }, { allowExtendedHours: true }, { orderType: 'stop_limit' }, { takeProfitPrice: 110 }, { assetClass: 'crypto' }, { timeInForce: 'gtd' }, { qty: Number.MAX_SAFE_INTEGER }]) {
    await expect(submitPaperOrder({ ...valid, ...patch })).rejects.toThrow();
    expect(sessionStorage.length).toBe(0);
    expect(getLatestPaperRequest('stock')).toBeNull();
  }
  expect(axios.post).not.toHaveBeenCalled();
  axios.post.mockResolvedValueOnce({ data: { order: { status: 'acknowledged' } } });
  await submitPaperOrder(valid);
  expect(axios.post).toHaveBeenCalledTimes(1);
  expect(getLatestPaperRequest('stock').status).toBe('acknowledged');
});

test('supported capped market entries and reducing market/stop orders pass pure preflight', () => {
  const { validatePaperOrderPayload } = require('./paperOrderRequest');
  expect(() => validatePaperOrderPayload({ symbol: 'AAPL', side: 'buy', qty: 1, orderType: 'market', maxPricePerShare: 100 })).not.toThrow();
  expect(() => validatePaperOrderPayload({ symbol: 'AAPL', side: 'sell', qty: 1, orderType: 'market' })).not.toThrow();
  expect(() => validatePaperOrderPayload({ symbol: 'AAPL', side: 'sell', qty: 1, orderType: 'stop', stopPrice: 90, timeInForce: 'gtc' })).not.toThrow();
  expect(sessionStorage.length).toBe(0);
});

test('local invalid edit does not mutate or rotate an existing uncertain request', async () => {
  const { getLatestPaperRequest } = require('./paperOrderRequest');
  const payload = { symbol: 'AAPL', side: 'buy', qty: 1, orderType: 'limit', limitPrice: 100 };
  axios.post.mockRejectedValueOnce(new Error('lost response'));
  await expect(submitPaperOrder(payload)).rejects.toThrow();
  const saved = getLatestPaperRequest('stock');
  await expect(submitPaperOrder({ ...payload, qty: 0.5 })).rejects.toThrow(/whole-share/);
  expect(getLatestPaperRequest('stock')).toEqual(saved);
  axios.post.mockResolvedValueOnce({ data: { order: { status: 'acknowledged' } } });
  await submitPaperOrder(payload);
  expect(axios.post.mock.calls[0][2].headers['Idempotency-Key']).toBe(axios.post.mock.calls[1][2].headers['Idempotency-Key']);
});
