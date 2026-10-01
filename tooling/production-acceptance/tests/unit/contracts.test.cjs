'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { decodeFrame, canonicalBytes, PublicRunBudget } = require('../../guest/contracts.cjs');
const vectors = JSON.parse(readFileSync(resolve(__dirname, '../../contracts/vectors.json'), 'utf8'));
for (const group of ['unknown_field_rejected', 'duplicate_key_rejected', 'oversized_frame_rejected', 'arbitrary_url_host_rejected', 'invalid_phase_event_rejected', 'private_fields_not_public', 'runtime_identity_requires_exact_hashes', 'malformed_values_rejected']) {
  test(group, () => {
    const cases = vectors.rejected.filter(v => v.group === group);
    assert.ok(cases.length > 0, `missing rejection group ${group}`);
    for (const v of cases) {
      assert.throws(() => decodeFrame(Buffer.from(v.json), v.kind), { code: 'INVALID_FRAME' }, v.name);
    }
  });
}
test('canonical_receipt_bytes_equal', () => {
  assert.ok(vectors.accepted.length > 0, 'canonical vectors must be present');
  for (const v of vectors.accepted) {
    const decoded = decodeFrame(Buffer.from(` \n${v.json} \t`), v.kind);
    assert.equal(canonicalBytes(decoded).toString('utf8'), v.canonical, v.name);
  }
});
test('public_run_total_bounded', () => {
  const v = vectors.accepted.find(v => v.name === 'public_phase');
  const frame = decodeFrame(Buffer.from(v.json), v.kind);
  const bytes = Buffer.byteLength(v.canonical);
  const budget = new PublicRunBudget();
  const count = Math.floor(262144 / bytes);
  for (let i = 0; i < count; i++) budget.append(frame);
  assert.equal(budget.usedBytes, count * bytes);
  assert.throws(() => budget.append(frame), { code: 'INVALID_FRAME' });
  assert.equal(budget.usedBytes, count * bytes);
  assert.throws(() => budget.append(decodeFrame(Buffer.from(vectors.accepted[0].json), 'CONTROL')), { code: 'INVALID_FRAME' });
});
test('strict_utf8_and_validated_immutable_canonical_boundary', () => {
  assert.throws(() => decodeFrame(Buffer.from([0xff]), 'CONTROL'), { code: 'INVALID_FRAME' });
  assert.throws(() => canonicalBytes(JSON.parse(vectors.accepted[0].json)), { code: 'INVALID_FRAME' });
  const frame = decodeFrame(Buffer.from(vectors.accepted[0].json), 'CONTROL');
  assert.throws(() => { frame.payload.event = 'login'; }, TypeError);
  assert.equal(canonicalBytes(frame).toString(), vectors.accepted[0].canonical);
});
