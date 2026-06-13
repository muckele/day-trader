const mongoose = require('mongoose');

const DEFAULT_ROBO_AUDIT_LOG_RETENTION_DAYS = 7;
const DAY_SECONDS = 24 * 60 * 60;

function getRoboAuditLogRetentionDays(env = process.env) {
  const parsed = Math.floor(Number(env.ROBOTRADER_AUDIT_LOG_RETENTION_DAYS));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ROBO_AUDIT_LOG_RETENTION_DAYS;
}

function getRoboAuditLogTtlSeconds(env = process.env) {
  return getRoboAuditLogRetentionDays(env) * DAY_SECONDS;
}

const ROBO_AUDIT_LOG_TTL_SECONDS = getRoboAuditLogTtlSeconds();

const roboAuditLogSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    eventType: { type: String, required: true, index: true },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} }
  },
  {
    timestamps: { createdAt: 'createdAt', updatedAt: false }
  }
);

roboAuditLogSchema.index({ userId: 1, createdAt: -1 });
roboAuditLogSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: ROBO_AUDIT_LOG_TTL_SECONDS, name: 'roboAuditLogCreatedAtTtl' }
);

module.exports = mongoose.model('RoboAuditLog', roboAuditLogSchema);
module.exports.DEFAULT_ROBO_AUDIT_LOG_RETENTION_DAYS = DEFAULT_ROBO_AUDIT_LOG_RETENTION_DAYS;
module.exports.getRoboAuditLogRetentionDays = getRoboAuditLogRetentionDays;
module.exports.getRoboAuditLogTtlSeconds = getRoboAuditLogTtlSeconds;
module.exports.ROBO_AUDIT_LOG_TTL_SECONDS = ROBO_AUDIT_LOG_TTL_SECONDS;
