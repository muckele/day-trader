// Verifier-only boundary. Never installed in the qualified application runtime.
const net = require('node:net');
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const options = net._normalizeArgs(Array.isArray(args[0]) ? args[0] : args)[0];
  if (!['127.0.0.1', 'localhost', '::1'].includes(options.host || 'localhost') || options.path) {
    throw new Error('Deterministic acceptance forbids non-loopback sockets');
  }
  return connect.apply(this, args);
};
