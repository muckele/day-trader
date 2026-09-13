import { marketFreshness } from './marketFreshness';
test('requires positive price and provider timestamp and labels old observations', () => {
  const now = Date.parse('2026-09-13T12:00:00Z');
  expect(marketFreshness(null, now, now)).toBe('unavailable');
  expect(marketFreshness(0, now, now)).toBe('unavailable');
  expect(marketFreshness(100, null, now)).toBe('unavailable');
  expect(marketFreshness(100, '2026-09-13T11:00:00Z', now)).toBe('stale');
  expect(marketFreshness(100, '2026-09-13T12:00:00Z', now)).toBe('current');
});
