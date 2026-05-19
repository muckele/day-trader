const mongoose = require('mongoose');

const runtimeState = {
  configured: false,
  activeUriLabel: null,
  lastConnectedAt: null,
  lastError: null,
  lastErrorAt: null,
  lastHint: null
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

function isMongoReady() {
  return mongoose.connection.readyState === 1;
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
    lastHint: runtimeState.lastHint
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
}

module.exports = {
  createMongoUnavailablePayload,
  getMongoServiceState,
  isMongoReady,
  markMongoConnected,
  markMongoFailed,
  resetMongoRuntimeState,
  setMongoConfigured
};
