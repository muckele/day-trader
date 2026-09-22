const mongoose = require('mongoose');
const { executionReadiness } = require('./executionReadiness');
const { getAlpacaTradingConfig } = require('./alpacaTradingClient');
const { isPaperTradingEndpoint } = require('./alpacaSafety');

// Observational only: native projections avoid Mongoose defaults, middleware,
// model initialization and get-or-create helpers. No external transport here.
async function getRuntimeReadiness({ connection = mongoose.connection, env = process.env,
  persistence = executionReadiness } = {}) {
  const initial = persistence.snapshot();
  const checks = {};
  const check = (name, ok, code, stage = 'runtime') => {
    checks[name] = { status: ok ? 'pass' : 'fail', code: ok ? null : code, stage };
  };
  const ownerId = String(env.OWNER_USER_ID || '').trim().toLowerCase();
  check('ownerConfiguration', /^[a-f0-9]{24}$/.test(ownerId), 'OWNER_CONFIGURATION_INVALID');
  check('authenticationConfiguration', typeof env.JWT_SECRET === 'string' && Boolean(env.JWT_SECRET.trim()), 'AUTHENTICATION_NOT_CONFIGURED');
  check('databaseConnected', connection.readyState === 1, 'DATABASE_UNAVAILABLE');
  let owner, settings;
  checks.ownerIdentity = { status: 'unknown', code: 'OWNER_NOT_CHECKED', stage: 'runtime' };
  checks.ownerSettings = { status: 'unknown', code: 'OWNER_SETTINGS_NOT_CHECKED', stage: 'runtime' };
  if (checks.ownerConfiguration.status === 'pass' && connection.readyState === 1) {
    try {
      const id = new mongoose.Types.ObjectId(ownerId);
      owner = await connection.db.collection('users').findOne({ _id: id, hash: { $regex: '^\\$2[aby]\\$(0[4-9]|[12][0-9]|3[01])\\$[./A-Za-z0-9]{53}$' } },
        { projection: { _id: 1, username: 1, sessionVersion: 1 }, maxTimeMS: 1000 });
      check('ownerIdentity', Boolean(owner && String(owner._id) === ownerId && typeof owner.username === 'string' && owner.username.trim() && owner.username === owner.username.trim()
        && Number.isSafeInteger(owner.sessionVersion ?? 0) && (owner.sessionVersion ?? 0) >= 0), 'OWNER_IDENTITY_UNAVAILABLE');
      const records = await connection.db.collection('robosettings').find({ userId: { $in: [id, ownerId] } },
        { projection: { _id: 0, userId: 1, mode: 1, enabled: 1, isEnabled: 1, liveTradingExplicitlyEnabled: 1 }, maxTimeMS: 1000 }).limit(2).toArray();
      const settingsValid = records.length === 1 && records[0].userId instanceof mongoose.Types.ObjectId && records[0].userId.equals(id);
      check('ownerSettings', settingsValid, records.length > 1 ? 'OWNER_SETTINGS_AMBIGUOUS' : records.length ? 'OWNER_SETTINGS_IDENTITY_INVALID' : 'OWNER_SETTINGS_MISSING');
      if (settingsValid) settings = records[0];
    } catch {
      checks.ownerIdentity = { status: 'unknown', code: 'OWNER_READ_UNAVAILABLE', stage: 'runtime' };
      checks.ownerSettings = { status: 'unknown', code: 'OWNER_SETTINGS_READ_UNAVAILABLE', stage: 'runtime' };
    }
  }
  const current = persistence.snapshot();
  check('databaseConnected', connection.readyState === 1, 'DATABASE_UNAVAILABLE');
  check('persistence', initial.ready === true && current.ready === true && current.indexesReady === true && current.writeReady === true
    && String(initial.checkedAt) === String(current.checkedAt), 'STARTUP_PERSISTENCE_NOT_READY');
  check('paperMode', settings?.mode === 'paper', 'PAPER_MODE_REQUIRED', 'maintenance');
  check('automationDisabled', settings?.enabled === false && settings?.isEnabled === false && settings?.liveTradingExplicitlyEnabled === false,
    'AUTOMATION_NOT_CONFIRMED_DISABLED', 'maintenance');
  check('schedulerSuppressed', env.ROBO_SCHEDULER_DISABLED === 'true', 'SCHEDULER_NOT_SUPPRESSED', 'maintenance');
  const config = getAlpacaTradingConfig(env);
  check('paperDestination', isPaperTradingEndpoint(config.baseUrl), 'PAPER_DESTINATION_INVALID', 'maintenance');
  check('paperBindingConfiguration', typeof config.expectedAccountId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(config.expectedAccountId),
    'PAPER_BINDING_CONFIGURATION_INVALID', 'maintenance');
  check('paperCredentialConfiguration', Boolean(String(config.apiKey).trim() && String(config.apiSecret).trim()), 'PAPER_CREDENTIALS_MISSING', 'maintenance');
  const runtimeReady = Object.values(checks).filter(c => c.stage === 'runtime').every(c => c.status === 'pass');
  const maintenanceReady = runtimeReady && Object.values(checks).every(c => c.status === 'pass');
  return {
    contractVersion: 2, profile: 'owner-paper-maintenance', runtimeReady, maintenanceReady,
    persistence: current, checks,
    blockers: Object.values(checks).filter(c => c.status !== 'pass').map(c => c.code),
    warnings: ['USER_UNIQUENESS_DEFERRED'],
    identityIntegrity: { userIndexManagement: 'explicit-migration', uniqueness: 'not_attested', registration: 'closed', authorization: 'configured-owner-id' },
    automation: { enabled: typeof settings?.enabled === 'boolean' ? settings.enabled : null,
      isEnabled: typeof settings?.isEnabled === 'boolean' ? settings.isEnabled : null,
      liveEnabled: typeof settings?.liveTradingExplicitlyEnabled === 'boolean' ? settings.liveTradingExplicitlyEnabled : null,
      schedulerSuppressed: env.ROBO_SCHEDULER_DISABLED === 'true', activationAuthorized: false },
    acceptance: { paperBroker: 'not_evaluated', smtpReceipt: 'not_evaluated', deployed: 'not_evaluated' },
    // Compatibility only, never the runtime/maintenance release-tooling gate.
    releaseReady: false,
    deprecated: { releaseReady: 'External release approval is not evaluated by this endpoint.' },
    releaseBlockers: ['External and deployed acceptance require separately verified candidate/image/environment evidence.'],
    executionEnvironment: 'alpaca-paper',
    accountBindingConfigured: checks.paperBindingConfiguration.status === 'pass',
    notificationConfigured: Boolean(env.SMTP_HOST && env.ROBO_NOTIFICATION_RECIPIENT)
  };
}

module.exports = { getRuntimeReadiness };
