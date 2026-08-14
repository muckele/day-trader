const buckets = new Map();
const mongoose = require('mongoose');
const RateLimitBucket = require('../models/RateLimitBucket');
const DEFAULT_MAX_BUCKETS = 10000;

function pruneRateLimitBuckets(now = Date.now(), maxBuckets = DEFAULT_MAX_BUCKETS) {
  for (const [key, bucket] of buckets.entries()) {
    if (!bucket || now > bucket.resetAt) {
      buckets.delete(key);
    }
  }

  const bucketLimit = Number.isFinite(Number(maxBuckets)) && Number(maxBuckets) > 0
    ? Number(maxBuckets)
    : DEFAULT_MAX_BUCKETS;
  while (buckets.size > bucketLimit) {
    const oldestKey = buckets.keys().next().value;
    if (!oldestKey) break;
    buckets.delete(oldestKey);
  }
}

function createRateLimit({
  windowMs = 60 * 1000,
  max = 60,
  maxBuckets = DEFAULT_MAX_BUCKETS,
  message = 'Too many requests. Try again shortly.',
  keyPrefix = 'global',
  distributed = false,
  RateLimitBucketModel = RateLimitBucket,
  isDistributedReady = () => mongoose.connection.readyState === 1
} = {}) {
  const windowSizeMs = Number.isFinite(Number(windowMs)) && Number(windowMs) > 0
    ? Number(windowMs)
    : 60 * 1000;
  const maxRequests = Number.isFinite(Number(max)) && Number(max) > 0
    ? Number(max)
    : 60;
  const bucketLimit = Number.isFinite(Number(maxBuckets)) && Number(maxBuckets) > 0
    ? Number(maxBuckets)
    : DEFAULT_MAX_BUCKETS;

  const inMemoryRateLimit = function rateLimit(req, res, next) {
    const now = Date.now();
    pruneRateLimitBuckets(now, bucketLimit);
    const identity = req.user?.username || req.ip || req.socket?.remoteAddress || 'local';
    const key = `${keyPrefix}:${identity}`;
    const bucket = buckets.get(key) || { count: 0, resetAt: now + windowSizeMs };

    if (now > bucket.resetAt) {
      bucket.count = 0;
      bucket.resetAt = now + windowSizeMs;
    }

    bucket.count += 1;
    buckets.set(key, bucket);
    if (buckets.size > bucketLimit) {
      pruneRateLimitBuckets(now, bucketLimit);
    }

    if (bucket.count > maxRequests) {
      return res.status(429).json({ message });
    }

    return next();
  };

  if (!distributed) return inMemoryRateLimit;

  return async function distributedRateLimit(req, res, next) {
    if (!isDistributedReady()) {
      return inMemoryRateLimit(req, res, next);
    }

    const now = new Date();
    const resetAt = new Date(now.getTime() + windowSizeMs);
    const identity = req.user?.username || req.ip || req.socket?.remoteAddress || 'local';
    const key = `${keyPrefix}:${identity}`;
    try {
      const active = await RateLimitBucketModel.findOneAndUpdate(
        { key, resetAt: { $gt: now }, count: { $lt: maxRequests } },
        { $inc: { count: 1 } },
        { new: true }
      ).lean();
      if (active) return next();

      try {
        const reset = await RateLimitBucketModel.findOneAndUpdate(
          {
            key,
            $or: [
              { resetAt: { $lte: now } },
              { resetAt: { $exists: false } }
            ]
          },
          { $set: { count: 1, resetAt } },
          { new: true, upsert: true, setDefaultsOnInsert: true }
        ).lean();
        if (reset) return next();
      } catch (err) {
        if (err?.code !== 11000) throw err;
        const raced = await RateLimitBucketModel.findOneAndUpdate(
          { key, resetAt: { $gt: now }, count: { $lt: maxRequests } },
          { $inc: { count: 1 } },
          { new: true }
        ).lean();
        if (raced) return next();
      }

      return res.status(429).json({ message });
    } catch (err) {
      return next(err);
    }
  };
}

function clearRateLimitBuckets() {
  buckets.clear();
}

module.exports = {
  clearRateLimitBuckets,
  createRateLimit,
  pruneRateLimitBuckets,
  _getRateLimitBucketCount: () => buckets.size
};
