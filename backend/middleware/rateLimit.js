const buckets = new Map();

function createRateLimit({
  windowMs = 60 * 1000,
  max = 60,
  message = 'Too many requests. Try again shortly.',
  keyPrefix = 'global'
} = {}) {
  const windowSizeMs = Number.isFinite(Number(windowMs)) && Number(windowMs) > 0
    ? Number(windowMs)
    : 60 * 1000;
  const maxRequests = Number.isFinite(Number(max)) && Number(max) > 0
    ? Number(max)
    : 60;

  return function rateLimit(req, res, next) {
    const now = Date.now();
    const identity = req.user?.username || req.ip || req.socket?.remoteAddress || 'local';
    const key = `${keyPrefix}:${identity}`;
    const bucket = buckets.get(key) || { count: 0, resetAt: now + windowSizeMs };

    if (now > bucket.resetAt) {
      bucket.count = 0;
      bucket.resetAt = now + windowSizeMs;
    }

    bucket.count += 1;
    buckets.set(key, bucket);

    if (bucket.count > maxRequests) {
      return res.status(429).json({ message });
    }

    return next();
  };
}

function clearRateLimitBuckets() {
  buckets.clear();
}

module.exports = {
  clearRateLimitBuckets,
  createRateLimit
};
