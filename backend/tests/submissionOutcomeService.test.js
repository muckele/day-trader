const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SUBMISSION_STATES,
  SUBMIT_UNKNOWN,
  buildSubmissionErrorSnapshot,
  classifySubmissionError,
  hasConclusiveBrokerOrder,
  isAmbiguousSubmitError
} = require('../services/submissionOutcomeService');

function responseError(status, data = null) {
  const err = new Error(`request failed with ${status}`);
  err.submissionAttempted = true;
  err.response = { status, data };
  return err;
}

test('submission classifier treats ambiguous HTTP outcomes as SUBMIT_UNKNOWN', () => {
  for (const status of [408, 425, 429, 500, 502, 503, 504]) {
    const err = responseError(status, { message: `broker ${status}` });
    assert.equal(classifySubmissionError(err), SUBMIT_UNKNOWN, `HTTP ${status}`);
    assert.equal(isAmbiguousSubmitError(err), true, `HTTP ${status}`);
  }
});

test('submission classifier treats transport and unknown post-attempt errors as SUBMIT_UNKNOWN', () => {
  const codes = [
    'ECONNABORTED',
    'ECONNREFUSED',
    'ECONNRESET',
    'EAI_AGAIN',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ENOTFOUND',
    'EPIPE',
    'ERR_NETWORK',
    'ETIMEDOUT'
  ];
  for (const code of codes) {
    const err = new Error(code);
    err.code = code;
    err.submissionAttempted = true;
    assert.equal(classifySubmissionError(err), SUBMIT_UNKNOWN, code);
  }

  const unexpected = new Error('unexpected adapter failure');
  unexpected.submissionAttempted = true;
  assert.equal(classifySubmissionError(unexpected), SUBMIT_UNKNOWN);
});

test('duplicate client identity remains unknown even with a 4xx response', () => {
  for (const [status, payload] of [
    [409, { message: 'client_order_id already exists' }],
    [422, { message: 'client_order_id already exists' }],
    [422, {
      code: 40010001,
      message: 'client_order_id must be unique'
    }],
    [422, {
      code: 40010001,
      message: 'unprocessable entity'
    }],
    [422, {
      code: '40010001',
      detail: 'conflict'
    }]
  ]) {
    const err = responseError(status, payload);
    assert.equal(classifySubmissionError(err), SUBMIT_UNKNOWN);
  }
});

test('duplicate identity detection covers broker detail, error_message, and string payloads', () => {
  for (const payload of [
    { detail: 'client_order_id must be unique' },
    { error_message: 'client-order-id is already in use' },
    'client order id duplicate'
  ]) {
    assert.equal(
      classifySubmissionError(responseError(422, payload)),
      SUBMIT_UNKNOWN
    );
  }
});

test('only structured affirmative broker 4xx evidence is confirmed rejection', () => {
  for (const status of [400, 401, 403, 422]) {
    const err = responseError(status, {
      code: 42210000,
      message: 'qty is invalid'
    });
    assert.equal(classifySubmissionError(err), SUBMISSION_STATES.REJECTED, `HTTP ${status}`);
  }

  assert.equal(
    classifySubmissionError(responseError(422)),
    SUBMIT_UNKNOWN,
    'an unstructured intermediary response does not prove broker rejection'
  );
  for (const payload of [
    {},
    [],
    { request_id: 'proxy-only' },
    { message: '' }
  ]) {
    assert.equal(
      classifySubmissionError(responseError(422, payload)),
      SUBMIT_UNKNOWN,
      'empty or proxy-only payload does not prove broker rejection'
    );
  }
});

test('proven pre-submit failures are NOT_ATTEMPTED', () => {
  const err = new Error('invalid local payload');
  err.submissionAttempted = false;
  assert.equal(classifySubmissionError(err), SUBMISSION_STATES.NOT_ATTEMPTED);
});

test('broker acknowledgement must include status and a matching correlation identity', () => {
  assert.equal(hasConclusiveBrokerOrder({
    id: 'broker-1',
    client_order_id: 'client-1',
    status: 'accepted'
  }, 'client-1'), true);
  assert.equal(hasConclusiveBrokerOrder({
    client_order_id: 'client-1',
    status: 'new'
  }, 'client-1'), false);
  assert.equal(hasConclusiveBrokerOrder({
    id: 'broker-1',
    client_order_id: 'other-client',
    status: 'accepted'
  }, 'client-1'), false);
  assert.equal(hasConclusiveBrokerOrder({
    id: 'broker-1',
    status: 'accepted'
  }, 'client-1'), false);
  assert.equal(hasConclusiveBrokerOrder({ id: 'broker-1' }, 'client-1'), false);
  assert.equal(hasConclusiveBrokerOrder({ status: 'accepted' }, 'client-1'), false);
  assert.equal(hasConclusiveBrokerOrder({
    id: 'broker-1',
    client_order_id: 'client-1',
    status: 'not-a-real-alpaca-status'
  }, 'client-1'), false);
  assert.equal(hasConclusiveBrokerOrder({
    id: 'broker-1',
    client_order_id: 'client-1',
    status: 'cancelled'
  }, 'client-1'), false, 'non-canonical local spelling is not a broker acknowledgement status');
  for (const malformedId of [{ proxy: 'bad' }, 123, true, ' broker-1 ']) {
    assert.equal(hasConclusiveBrokerOrder({
      id: malformedId,
      client_order_id: 'client-1',
      status: 'accepted'
    }, 'client-1'), false, `malformed broker id ${JSON.stringify(malformedId)} is inconclusive`);
  }
  for (const malformedClientId of [{ proxy: 'bad' }, 123, true, ' client-1 ']) {
    assert.equal(hasConclusiveBrokerOrder({
      id: 'broker-1',
      client_order_id: malformedClientId,
      status: 'accepted'
    }, 'client-1'), false, `malformed client id ${JSON.stringify(malformedClientId)} is inconclusive`);
  }
  for (const malformedFill of [
    {},
    { filled_qty: '1' },
    { filled_avg_price: '100' },
    { filled_qty: '0', filled_avg_price: '100' },
    { filled_qty: { proxy: 'bad' }, filled_avg_price: '100' },
    { filled_qty: '1', filled_avg_price: { proxy: 'bad' } },
    { filled_qty: 1, filled_avg_price: '100' },
    { filled_qty: '1', filled_avg_price: 100 },
    { filled_qty: true, filled_avg_price: '100' },
    { filled_qty: '1', filled_avg_price: false },
    { filled_qty: '0x10', filled_avg_price: '100' },
    { filled_qty: '+1', filled_avg_price: '100' },
    { filled_qty: '1e0', filled_avg_price: '100' },
    { filled_qty: '1', filled_avg_price: '9'.repeat(400) },
    { filled_qty: '', filled_avg_price: '100' },
    { filled_qty: ' ', filled_avg_price: '100' },
    { filled_qty: '1', filled_avg_price: '' },
    { filled_qty: '1', filled_avg_price: ' ' }
  ]) {
    assert.equal(hasConclusiveBrokerOrder({
      id: 'broker-filled',
      client_order_id: 'client-1',
      status: 'filled',
      ...malformedFill
    }, 'client-1'), false, `malformed fill ${JSON.stringify(malformedFill)} is inconclusive`);
  }
  assert.equal(hasConclusiveBrokerOrder({
    id: 'broker-filled',
    client_order_id: 'client-1',
    status: 'filled',
    filled_qty: '1',
    filled_avg_price: '100.25'
  }, 'client-1', 1), true);
  assert.equal(hasConclusiveBrokerOrder({
    id: 'broker-overfilled',
    client_order_id: 'client-1',
    status: 'filled',
    filled_qty: '999',
    filled_avg_price: '100.25'
  }, 'client-1', 1), false);
  assert.equal(hasConclusiveBrokerOrder({
    id: 'broker-underfilled',
    client_order_id: 'client-1',
    status: 'filled',
    filled_qty: '0.5',
    filled_avg_price: '100.25'
  }, 'client-1', 1), false);
  assert.equal(hasConclusiveBrokerOrder({
    id: 'broker-impossible-partial',
    client_order_id: 'client-1',
    status: 'partially_filled',
    filled_qty: '1',
    filled_avg_price: '100.25'
  }, 'client-1', 1), false);
  assert.equal(hasConclusiveBrokerOrder({
    id: 'broker-accepted-with-fill',
    client_order_id: 'client-1',
    status: 'accepted',
    filled_qty: '0.5',
    filled_avg_price: '100.25'
  }, 'client-1', 1), false);
  assert.equal(hasConclusiveBrokerOrder({
    id: 'broker-canceled-with-fill',
    client_order_id: 'client-1',
    status: 'canceled',
    filled_qty: '0.5',
    filled_avg_price: '100.25'
  }, 'client-1', 1), false);
  assert.equal(hasConclusiveBrokerOrder({
    id: 'broker-zero-fill',
    client_order_id: 'client-1',
    status: 'canceled',
    filled_qty: '0',
    filled_avg_price: null
  }, 'client-1', 1), true);
  assert.equal(hasConclusiveBrokerOrder({
    id: 'broker-notional-filled',
    client_order_id: 'client-1',
    status: 'filled',
    filled_qty: '0.5',
    filled_avg_price: '200'
  }, 'client-1', null, 100), true);
  assert.equal(hasConclusiveBrokerOrder({
    id: 'broker-notional-overfill',
    client_order_id: 'client-1',
    status: 'filled',
    filled_qty: '5',
    filled_avg_price: '200'
  }, 'client-1', null, 100), false);
  assert.equal(hasConclusiveBrokerOrder({
    id: 'broker-notional-underfill',
    client_order_id: 'client-1',
    status: 'filled',
    filled_qty: '0.0001',
    filled_avg_price: '1'
  }, 'client-1', null, 1000), false);
  assert.equal(hasConclusiveBrokerOrder({
    id: 'broker-fill-without-request-bound',
    client_order_id: 'client-1',
    status: 'filled',
    filled_qty: '1',
    filled_avg_price: '100'
  }, 'client-1'), false);
});

test('error snapshot preserves the canonical outcome and original correlation identity', () => {
  const err = responseError(503, { message: 'upstream unavailable' });
  err.code = 'ERR_NETWORK';
  err.clientOrderId = 'client-original';
  const snapshot = buildSubmissionErrorSnapshot(err);

  assert.equal(snapshot.submissionOutcome, SUBMIT_UNKNOWN);
  assert.equal(snapshot.clientOrderId, 'client-original');
  assert.equal(snapshot.status, 503);
  assert.equal(snapshot.data.message, 'upstream unavailable');
});
