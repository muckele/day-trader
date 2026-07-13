const mongoose = require('mongoose');

const roboExposureSnapshotSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    accountId: { type: String, required: true, index: true },
    environment: { type: String, enum: ['paper', 'shadow', 'live'], required: true, index: true },
    equity: { type: Number, default: 0 },
    lastEquity: { type: Number, default: 0 },
    peakEquity: { type: Number, default: 0 },
    cash: { type: Number, default: 0 },
    buyingPower: { type: Number, default: 0 },
    positionLongExposure: { type: Number, default: 0 },
    positionShortExposure: { type: Number, default: 0 },
    reservedLongExposure: { type: Number, default: 0 },
    reservedShortExposure: { type: Number, default: 0 },
    reservedGrossExposure: { type: Number, default: 0 },
    reservedNetExposure: { type: Number, default: 0 },
    longExposure: { type: Number, default: 0 },
    shortExposure: { type: Number, default: 0 },
    grossExposure: { type: Number, default: 0 },
    netExposure: { type: Number, default: 0 },
    grossExposurePct: { type: Number, default: 0 },
    netExposurePct: { type: Number, default: 0 },
    dailyDrawdownPct: { type: Number, default: 0 },
    totalDrawdownPct: { type: Number, default: 0 },
    positionCount: { type: Number, default: 0 },
    positions: { type: [mongoose.Schema.Types.Mixed], default: [] },
    workingOrderCount: { type: Number, default: 0 },
    workingOrders: { type: [mongoose.Schema.Types.Mixed], default: [] },
    workingOrderGroups: { type: [mongoose.Schema.Types.Mixed], default: [] },
    unpricedWorkingOrderCount: { type: Number, default: 0 },
    limits: { type: mongoose.Schema.Types.Mixed, default: {} },
    checks: { type: [mongoose.Schema.Types.Mixed], default: [] },
    breached: { type: Boolean, default: false, index: true },
    breachReasonCodes: { type: [String], default: [] },
    capturedAt: { type: Date, default: Date.now, index: true },
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      index: { expires: 0 }
    }
  },
  { timestamps: true }
);

roboExposureSnapshotSchema.index({ userId: 1, environment: 1, capturedAt: -1 });
roboExposureSnapshotSchema.index({ accountId: 1, environment: 1, capturedAt: -1 });

module.exports = mongoose.model('RoboExposureSnapshot', roboExposureSnapshotSchema);
