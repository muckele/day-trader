const mongoose = require('mongoose');
module.exports = mongoose.model('OrderProtectionLock', new mongoose.Schema({
  accountId: { type: String, required: true, unique: true },
  owner: String,
  expiresAt: Date
}));
