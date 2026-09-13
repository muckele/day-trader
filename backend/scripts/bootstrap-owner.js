#!/usr/bin/env node
// Run only from an operator shell. This module never elects or binds an owner on startup.
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../models/User');

async function bootstrapOwner(input, { UserModel = User } = {}) {
  if (input.existingId !== undefined) {
    if (!/^[a-fA-F0-9]{24}$/.test(input.existingId)) throw new Error('Invalid existing owner identity.');
    const existing = await UserModel.findById(input.existingId);
    if (!existing) throw new Error('Existing owner not found.');
    return String(existing._id);
  }
  const username = String(input.username || '').trim();
  const email = String(input.email || '').trim().toLowerCase();
  const password = input.password;
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) throw new Error('Invalid owner username.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Invalid owner email.');
  if (typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password, 'utf8') > 72 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    throw new Error('Owner password must contain letters and numbers, be at least 12 characters, and at most 72 UTF-8 bytes.');
  }
  const hash = await bcrypt.hash(password, 12);
  const user = await UserModel.create({ username, email, hash, sessionVersion: 0 });
  return String(user._id);
}

async function main() {
  if (!process.env.MONGO_URI) throw new Error('Set MONGO_URI explicitly in the operator environment.');
  let input;
  if (process.argv[2] === '--existing' && process.argv.length === 4) {
    input = { existingId: process.argv[3] };
  } else if (process.argv[2] === '--create' && process.argv.length === 3) {
    if (process.env.OWNER_USER_ID) throw new Error('An owner is already configured; use --existing to verify that identity.');
    if (process.stdin.isTTY) throw new Error('Supply JSON credentials through stdin from a secure source; never put passwords in command arguments.');
    let body = '';
    for await (const chunk of process.stdin) {
      body += chunk;
      if (body.length > 8192) throw new Error('Bootstrap input too large.');
    }
    input = JSON.parse(body);
    if (input.existingId !== undefined) throw new Error('Use --existing for an existing identity.');
  } else {
    throw new Error('Usage: node scripts/bootstrap-owner.js --existing USER_ID | --create < protected-credentials.json');
  }
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 5000 });
    await User.init();
    const id = await bootstrapOwner(input);
    console.log(`Verified owner identity. Configure this explicit value in the application runtime: OWNER_USER_ID=${id}`);
  } finally {
    await mongoose.disconnect();
  }
}
if (require.main === module) {
  main().catch(error => {
    // Driver/validation errors may embed connection details or submitted values.
    const safe = /^(Set MONGO_URI|An owner is already configured|Supply JSON|Bootstrap input|Usage:|Use --existing|Invalid (existing owner identity|owner username|owner email)|Owner password|Existing owner not found)/.test(error.message);
    console.error(safe ? error.message : 'Owner bootstrap failed. Verify configuration and database access; no runtime binding was changed.');
    process.exitCode = 1;
  });
}
module.exports = { bootstrapOwner };
