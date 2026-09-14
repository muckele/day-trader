const Q = require('../services/shareQuantity');
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  intentId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
  accountId: { type: String, required: true, index: true },
  userId: { type: String, required: true },
  symbol: { type: String, required: true },
  state: { type: String, default: 'required', index: true },
  generation: { type: Number, default: 0 },
  clientOrderId: String,
  brokerOrderId: String,
  qty: Q.schemaField(mongoose, { default: 0 }),
  confirmedQty: Q.schemaField(mongoose, { default: 0 }),
  error: String,
  brokerSnapshot: mongoose.Schema.Types.Mixed,
  dispatchClaims: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true, optimisticConcurrency: true });
module.exports = mongoose.model('OrderProtection', schema);
