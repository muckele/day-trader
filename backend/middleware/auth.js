const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../models/User');
const { readSessionToken } = require('../utils/sessionCookie');

function getJwtSecret() {
  return process.env.JWT_SECRET || null;
}

// The operator binds an existing database identity. HTTP onboarding never elects an owner.
function getOwnerUserId() {
  const id = String(process.env.OWNER_USER_ID || '').trim();
  return /^[a-fA-F0-9]{24}$/.test(id) ? id.toLowerCase() : null;
}

async function auth(req, res, next) {
  let claims;
  try {
    const token = readSessionToken(req);
    if (!token) return res.status(401).json({ message: 'Missing authentication token' });
    const secret = getJwtSecret();
    if (!secret || !getOwnerUserId()) {
      return res.status(503).json({ message: 'Owner authentication is not configured.' });
    }
    claims = jwt.verify(token, secret, { algorithms: ['HS256'] });
  } catch {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }

  const userId = claims.sub || claims.userId;
  if (userId !== getOwnerUserId() || (claims.userId && claims.userId !== userId)) {
    return res.status(403).json({ message: 'Owner access required.' });
  }
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ message: 'Authentication database unavailable.' });
  }
  let currentUser;
  try {
    currentUser = await User.findOne({ _id: userId }).lean();
  } catch {
    return res.status(503).json({ message: 'Authentication database unavailable.' });
  }
  if (!currentUser || !Number.isSafeInteger(claims.sessionVersion) ||
      claims.sessionVersion !== (currentUser.sessionVersion ?? 0)) {
    return res.status(401).json({ message: 'Invalid or expired session. Sign in again.' });
  }
  req.currentUser = currentUser;
  req.user = { ...claims, sub: String(currentUser._id), userId: String(currentUser._id), username: currentUser.username };
  return next();
}

module.exports = auth;
module.exports.getJwtSecret = getJwtSecret;
module.exports.getOwnerUserId = getOwnerUserId;
