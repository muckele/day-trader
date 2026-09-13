const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { bootstrapOwner } = require('../scripts/bootstrap-owner');
const id = '507f1f77bcf86cd799439011';
test('operator can resolve an explicit existing identity without modifying it', async () => {
  const result = await bootstrapOwner({ existingId: id }, { UserModel: { findById: async value => value === id ? { _id: id } : null } });
  assert.equal(result, id);
});
test('invalid or missing existing owner is refused', async () => {
  await assert.rejects(bootstrapOwner({ existingId: 'bad' }), /identity/i);
  await assert.rejects(bootstrapOwner({ existingId: id }, { UserModel: { findById: async () => null } }), /not found/i);
});
test('new owner is created with password hash and no automatic binding', async () => {
  let created;
  const result = await bootstrapOwner({ username: 'operator', email: 'owner@example.test', password: 'LongPassword123' }, {
    UserModel: { create: async value => { created = value; return { ...value, _id: id }; } }
  });
  assert.equal(result, id);
  assert.equal(created.password, undefined);
  assert.equal(await bcrypt.compare('LongPassword123', created.hash), true);
  assert.equal(created.sessionVersion, 0);
});
test('weak or missing credentials never create an owner', async () => {
  await assert.rejects(bootstrapOwner({ username: 'operator', email: 'owner@example.test', password: '123' }), /password/i);
  await assert.rejects(bootstrapOwner({ username: 'x', email: 'no', password: 'LongPassword123' }), /username/i);
});
