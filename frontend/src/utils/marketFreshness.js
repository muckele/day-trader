export function marketFreshness(price, asOf, now = Date.now()) {
  if (price == null || !Number.isFinite(Number(price)) || Number(price) <= 0 || !asOf) return 'unavailable';
  const observed = new Date(asOf).getTime();
  if (!Number.isFinite(observed)) return 'unavailable';
  return Math.abs(now - observed) > 15 * 60 * 1000 ? 'stale' : 'current';
}
