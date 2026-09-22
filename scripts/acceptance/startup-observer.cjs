// Test-process instrumentation only; never loaded by the application image.
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const mongoose = require(root + '/backend/node_modules/mongoose');
if (process.env.STARTUP_SYNTHETIC !== 'true' || !process.env.MONGO_URI?.includes('/mvp_startup_')) {
  throw new Error('Synthetic startup fixture required');
}
const ledger = { commands: [], externalAttempts: [], workerTimers: 0, injectedFaults: 0 };
if (process.env.STARTUP_FAULT === 'index') {
  const createIndex = mongoose.Collection.prototype.createIndex;
  mongoose.Collection.prototype.createIndex = function (...args) {
    if (this.name === 'orderintents') { ledger.injectedFaults++; return Promise.reject(new Error('Synthetic required index failure')); }
    return createIndex.apply(this, args);
  };
}
if (process.env.STARTUP_FAULT === 'write') {
  const updateOne = mongoose.mongo.Collection.prototype.updateOne;
  mongoose.mongo.Collection.prototype.updateOne = function (...args) {
    if (this.collectionName === 'operationalreadiness') { ledger.injectedFaults++; return Promise.reject(new Error('Synthetic majority write failure')); }
    return updateOne.apply(this, args);
  };
}
const net = require('node:net');
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const options = net._normalizeArgs(Array.isArray(args[0]) ? args[0] : args)[0];
  if (!['127.0.0.1', 'localhost', '::1'].includes(options.host || 'localhost') || options.path) {
    ledger.externalAttempts.push('blocked');
    throw new Error('Synthetic startup forbids external egress');
  }
  return connect.apply(this, args);
};
const interval = global.setInterval;
global.setInterval = function (...args) {
  if (new Error().stack.includes('roboScheduler')) ledger.workerTimers++;
  return interval.apply(this, args);
};
const clientConnect = mongoose.mongo.MongoClient.prototype.connect;
mongoose.mongo.MongoClient.prototype.connect = function (...args) {
  this.options.monitorCommands = true;
  this.on('commandStarted', e => ledger.commands.push({ name: e.commandName,
    collection: typeof e.command[e.commandName] === 'string' ? e.command[e.commandName] : null,
    ...(e.command.indexes ? { indexes: e.command.indexes.map(i => ({ key: i.key instanceof Map ? Object.fromEntries(i.key) : i.key, unique: i.unique })) } : {}) }));
  return clientConnect.apply(this, args);
};
process.on('message', async message => {
  if (!message?.startup) return;
  try {
    if (message.startup === 'reconnect') {
      await mongoose.disconnect();
      require(root + '/backend/models/User');
      await mongoose.connect(process.env.MONGO_URI);
      mongoose.connection.emit('reconnected');
    }
    if (message.startup === 'env') Object.assign(process.env, message.values);
    if (message.startup === 'invalidate') require(root + '/backend/services/executionReadiness').executionReadiness.invalidate();
    process.send({ startupReply: message.id, ledger });
  } catch (error) { process.send({ startupReply: message.id, error: error.message }); }
});
