const mongoose = require('mongoose');

const runtimeState = {
  configured: false,
  activeUriLabel: null,
  lastConnectedAt: null,
  lastError: null,
  lastErrorAt: null,
  lastHint: null,
  indexState: 'not_started',
  indexFailures: [],
  indexesVerifiedAt: null
};

function getMongoStateName(readyState) {
  const mongoStates = {
    0: 'disconnected',
    1: 'connected',
    2: 'connecting',
    3: 'disconnecting'
  };
  return mongoStates[readyState] || 'unknown';
}

function setMongoConfigured(configured) {
  runtimeState.configured = Boolean(configured);
}

function markMongoConnected(activeUriLabel) {
  runtimeState.activeUriLabel = activeUriLabel || null;
  runtimeState.lastConnectedAt = new Date().toISOString();
  runtimeState.lastError = null;
  runtimeState.lastErrorAt = null;
  runtimeState.lastHint = null;
}

function markMongoFailed(err, hint) {
  runtimeState.lastError = String(err?.message || err || 'MongoDB connection failed');
  runtimeState.lastErrorAt = new Date().toISOString();
  runtimeState.lastHint = hint || null;
}

function markMongoIndexesBuilding() {
  runtimeState.indexState = 'building';
  runtimeState.indexFailures = [];
  runtimeState.indexesVerifiedAt = null;
}

function markMongoIndexesReady() {
  runtimeState.indexState = 'ready';
  runtimeState.indexFailures = [];
  runtimeState.indexesVerifiedAt = new Date().toISOString();
}

function markMongoIndexesFailed(failures = []) {
  runtimeState.indexState = 'failed';
  runtimeState.indexFailures = failures.map(item => ({
    model: item.model || 'unknown',
    error: item.error || 'Index verification failed.'
  }));
  runtimeState.indexesVerifiedAt = new Date().toISOString();
}

function isMongoReady() {
  return mongoose.connection.readyState === 1;
}

function isMongoRequestReady() {
  return isMongoReady() && !['building', 'failed'].includes(runtimeState.indexState);
}

function getMongoServiceState() {
  const readyState = mongoose.connection.readyState;
  return {
    state: getMongoStateName(readyState),
    readyState,
    configured: runtimeState.configured,
    activeUriLabel: runtimeState.activeUriLabel,
    lastConnectedAt: runtimeState.lastConnectedAt,
    lastErrorAt: runtimeState.lastErrorAt,
    lastHint: runtimeState.lastHint,
    indexes: {
      state: runtimeState.indexState,
      failures: runtimeState.indexFailures,
      verifiedAt: runtimeState.indexesVerifiedAt
    }
  };
}

function createMongoUnavailablePayload() {
  const serviceState = getMongoServiceState();
  return {
    message: 'Database temporarily unavailable',
    service: 'mongo',
    state: serviceState.state,
    readyState: serviceState.readyState,
    hint: serviceState.lastHint || 'Verify MongoDB connectivity and Atlas network access.'
  };
}

function resetMongoRuntimeState() {
  runtimeState.configured = false;
  runtimeState.activeUriLabel = null;
  runtimeState.lastConnectedAt = null;
  runtimeState.lastError = null;
  runtimeState.lastErrorAt = null;
  runtimeState.lastHint = null;
  runtimeState.indexState = 'not_started';
  runtimeState.indexFailures = [];
  runtimeState.indexesVerifiedAt = null;
}

module.exports = {
  createMongoUnavailablePayload,
  getMongoServiceState,
  isMongoRequestReady,
  isMongoReady,
  markMongoIndexesBuilding,
  markMongoIndexesFailed,
  markMongoIndexesReady,
  markMongoConnected,
  markMongoFailed,
  resetMongoRuntimeState,
  setMongoConfigured
};
