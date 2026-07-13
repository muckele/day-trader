const test = require('node:test');
const assert = require('node:assert/strict');

const mongoState = require('../utils/mongoState');

test('mongoState tracks failure metadata for health responses', () => {
  mongoState.resetMongoRuntimeState();
  mongoState.setMongoConfigured(true);
  mongoState.markMongoFailed(new Error('querySrv ECONNREFUSED'), 'Atlas network access blocked');

  const state = mongoState.getMongoServiceState();

  assert.equal(state.configured, true);
  assert.equal(state.state, 'disconnected');
  assert.equal(typeof state.lastErrorAt, 'string');
  assert.equal(state.lastHint, 'Atlas network access blocked');

  const payload = mongoState.createMongoUnavailablePayload();
  assert.equal(payload.message, 'Database temporarily unavailable');
  assert.equal(payload.service, 'mongo');
  assert.equal(payload.state, 'disconnected');
  assert.equal(payload.hint, 'Atlas network access blocked');
});

test('mongoState clears failure metadata after a successful connection', () => {
  mongoState.resetMongoRuntimeState();
  mongoState.setMongoConfigured(true);
  mongoState.markMongoFailed(new Error('old error'), 'old hint');
  mongoState.markMongoConnected('MONGO_URI_DIRECT');

  const state = mongoState.getMongoServiceState();

  assert.equal(state.activeUriLabel, 'MONGO_URI_DIRECT');
  assert.equal(typeof state.lastConnectedAt, 'string');
  assert.equal(state.lastErrorAt, null);
  assert.equal(state.lastHint, null);
});

test('mongoState exposes and fails closed on index bootstrap status', () => {
  mongoState.resetMongoRuntimeState();
  mongoState.markMongoIndexesBuilding();
  assert.equal(mongoState.getMongoServiceState().indexes.state, 'building');
  assert.equal(mongoState.isMongoRequestReady(), false);
  mongoState.markMongoIndexesFailed([{ model: 'TradeAuthorization', error: 'duplicate values' }]);
  const state = mongoState.getMongoServiceState();
  assert.equal(state.indexes.state, 'failed');
  assert.equal(state.indexes.failures[0].model, 'TradeAuthorization');
});
