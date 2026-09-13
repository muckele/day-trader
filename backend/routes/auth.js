const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const { getJwtSecret, getOwnerUserId } = require('../middleware/auth');
const { setSessionCookie, clearSessionCookie } = require('../utils/sessionCookie');

function register(req, res) {
  return res.status(403).json({ message: 'Public registration is disabled. Owner access is configured by the operator.' });
}

async function login(req, res) {
  const ownerId = getOwnerUserId();
  const secret = getJwtSecret();
  if (!ownerId || !secret) return res.status(503).json({ message: 'Owner authentication is not configured.' });
  if (mongoose.connection.readyState !== 1) return res.status(503).json({ message: 'Authentication database unavailable.' });
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
    return res.status(400).json({ message: 'Username and password are required.' });
  }
  let user;
  try {
    user = await User.findOne({ _id: ownerId, username: username.trim() });
  } catch {
    return res.status(503).json({ message: 'Authentication database unavailable.' });
  }
  if (!user || String(user._id) !== ownerId || !await bcrypt.compare(password, user.hash)) {
    return res.status(401).json({ message: 'Invalid credentials' });
  }
  const sessionVersion = user.sessionVersion ?? 0;
  if (!Number.isSafeInteger(sessionVersion) || sessionVersion < 0) return res.status(503).json({ message: 'Owner session state is invalid.' });
  const token = jwt.sign(
    { sub: String(user._id), userId: String(user._id), username: user.username, sessionVersion },
    secret, { expiresIn: '1h', algorithm: 'HS256' }
  );
  setSessionCookie(res, token);
  const payload = { user: { id: String(user._id), username: user.username, email: user.email || null } };
  if (process.env.NODE_ENV !== 'production') payload.token = token;
  return res.json(payload);
}

async function logout(req, res) {
  // Revoking the owner generation signs out every browser/device, including bearer sessions.
  // Do not claim success until the revocation has been persisted.
  try {
    const result = await User.updateOne({ _id: req.user.userId }, { $inc: { sessionVersion: 1 } });
    if (result.matchedCount !== 1) throw new Error('Owner unavailable');
  } catch {
    clearSessionCookie(res);
    return res.status(503).json({ message: 'Could not revoke sessions. Retry logout when the database is available.', revoked: false });
  }
  clearSessionCookie(res);
  return res.json({ message: 'Logged out successfully', revoked: true });
}

module.exports = { register, login, logout };
