import axios from 'axios';
import { requestPositionClose, preparePositionClose, readPositionClose } from './positionCloseRequest';
beforeAll(() => { Object.defineProperty(window, 'crypto', { value: require('crypto').webcrypto, configurable: true }); });
beforeEach(() => { sessionStorage.clear(); jest.clearAllMocks(); });
test('ambiguous coordinated close retains key and default broker-derived quantity on retry', async () => {
  axios.post.mockRejectedValueOnce(new Error('timeout')).mockResolvedValue({ data: { close: { state: 'acknowledged' } } });
  await expect(requestPositionClose('AAPL')).rejects.toThrow();
  await requestPositionClose('AAPL');
  expect(axios.post.mock.calls[0][1]).not.toHaveProperty('qty');
  expect(axios.post.mock.calls[0][2].headers['Idempotency-Key']).toBe(axios.post.mock.calls[1][2].headers['Idempotency-Key']);
  expect(() => preparePositionClose('AAPL')).toThrow(/resolved/i);
});
test('terminal close requires explicit preparation to obtain new identity', async () => {
  axios.post.mockResolvedValue({ data: { close: { state: 'filled', active: false } } });
  await requestPositionClose('AAPL');
  const prior = readPositionClose('AAPL').key;
  preparePositionClose('AAPL');
  expect(axios.post).toHaveBeenCalledTimes(1);
  expect(readPositionClose('AAPL').key).not.toBe(prior);
});
