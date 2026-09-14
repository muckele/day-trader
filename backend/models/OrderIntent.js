const Q = require('../services/shareQuantity');
const mongoose = require('mongoose');

const orderIntentSchema = new mongoose.Schema(
  {
    accountId: { type: String, default: 'default', index: true },
    origin: { type: String, default: 'manual', index: true },
    broker: { type: String, enum: ['paper', 'alpaca'], default: 'paper', index: true },
    symbol: { type: String, required: true, index: true },
    assetClass: { type: String, default: 'equity' },
    side: { type: String, enum: ['buy', 'sell'], required: true },
    qty: Q.schemaField(mongoose, { required: true }),
    orderType: { type: String, default: 'market' },
    timeInForce: { type: String, default: 'day' },
    limitPrice: { type: Number, default: null },
    stopPrice: { type: Number, default: null },
    takeProfitPrice: { type: Number, default: null },
    stopLossPrice: { type: Number, default: null },
    trailingStopPct: { type: Number, default: null },
    maxPricePerShare: { type: Number, default: null },
    allowExtendedHours: { type: Boolean, default: true },
    strategyId: { type: String, default: null },
    setupType: { type: String, default: null },
    status: { type: String, default: 'created', index: true },
    userId: String, environment: String, executionSource: String, idempotencyKey: String, payloadFingerprint: String, clientOrderId: String,
    orderInput: mongoose.Schema.Types.Mixed, periodKeys: mongoose.Schema.Types.Mixed,
    reservedCents: {type:Number,default:0}, filledQty:Q.schemaField(mongoose,{default:0}), filledNotionalCents:{type:Number,default:0},
    uncertainSince: Date, protectionState: mongoose.Schema.Types.Mixed, replacement: mongoose.Schema.Types.Mixed,
    dispatchClaims: { type: mongoose.Schema.Types.Mixed, default: {} }, controlGeneration: Number,
    stopCancelRequested: Boolean, stopCancelAttempted: Boolean,
    rejectionReason: { type: String, default: null },
    requestedAt: { type: Date, default: Date.now },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
  },
  { timestamps: true }
);

orderIntentSchema.index({ accountId: 1, requestedAt: -1 });

orderIntentSchema.index({accountId:1,environment:1,idempotencyKey:1},{unique:true,partialFilterExpression:{executionSource:'alpaca-paper'}});
module.exports = mongoose.model('OrderIntent', orderIntentSchema);
