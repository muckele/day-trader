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
  axios.post.mockResolvedValue({ data: {} });
  await submitPaperOrder({ symbol: 'SPY', side: 'buy', qty: 1 });
  await submitPaperOrder({ symbol: 'SPY', side: 'buy', qty: 2 });
  expect(axios.post.mock.calls[0][2].headers['Idempotency-Key']).not.toBe(axios.post.mock.calls[1][2].headers['Idempotency-Key']);
});

test('uncertain states do not claim broker acknowledgement or fill', () => {
  for (const status of ['reserved', 'submitting', 'submission_uncertain', 'reconciliation_required']) {
    expect(paperOrderStatusMessage(status)).toMatch(/confirmation pending/);
  }
  expect(paperOrderStatusMessage('partially_filled')).toMatch(/partially filled/);
});
