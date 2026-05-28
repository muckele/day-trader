// backend/middleware/auth.js

const { ensureSlowBufferCompat } = require('../utils/nodeCompat');

ensureSlowBufferCompat();

const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../models/User');
const { readSessionToken } = require('../utils/sessionCookie');

function getJwtSecret() {
  return process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? null : 'daytrader-dev-secret');
}

async function auth(req, res, next) {
  const token = readSessionToken(req);
  if (!token) {
    return res.status(401).json({ message: 'Missing authentication token' });
  }
  try {
    const secret = getJwtSecret();
    if (!secret) {
      return res.status(500).json({ message: 'Authentication is not configured.' });
    }

    req.user = jwt.verify(token, secret);

    if (mongoose.connection.readyState === 1) {
      const query = req.user?.userId || req.user?.sub
        ? { _id: req.user.userId || req.user.sub }
        : { username: req.user?.username };
      const currentUser = await User.findOne(query).lean();
      if (!currentUser) {
        return res.status(401).json({ message: 'User not found.' });
      }
      req.currentUser = currentUser;
      req.user = {
        ...req.user,
        sub: String(currentUser._id),
        userId: String(currentUser._id),
        username: currentUser.username
      };
    }

    return next();
  } catch {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
}

module.exports = auth;
module.exports.getJwtSecret = getJwtSecret;
