const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeCsvCell } = require('../routes/analytics');

test('CSV export neutralizes spreadsheet formulas while preserving ordinary values', () => {
  for (const value of ['=1+1', '+SUM(A1:A2)', '-2+3', '@cmd', '  =HYPERLINK("https://example.com")', '\t+1']) {
    assert.equal(sanitizeCsvCell(value).startsWith("'"), true, value);
  }
  assert.equal(sanitizeCsvCell('ROBO_TREND'), 'ROBO_TREND');
  assert.equal(sanitizeCsvCell(42), 42);
});
