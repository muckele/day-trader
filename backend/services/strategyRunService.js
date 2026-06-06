const crypto = require('crypto');
const mongoState = require('../utils/mongoState');
const StrategyParameterVersion = require('../models/StrategyParameterVersion');
const StrategyRun = require('../models/StrategyRun');

function stableSerialize(value) {
  if (Array.isArray(value)) {
    return `[${value.map(item => stableSerialize(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function computeParameterHash(parameters = {}) {
  return crypto.createHash('sha256').update(stableSerialize(parameters)).digest('hex');
}

function normalizeAccountId(accountId) {
  const normalized = String(accountId || '').trim();
  return normalized || null;
}

async function getOrCreateParameterVersion({ accountId, strategyId, parameters = {}, source = 'system', notes = '' } = {}) {
  const scopedAccountId = normalizeAccountId(accountId);
  if (!mongoState.isMongoReady() || !scopedAccountId || !strategyId) return null;
  try {
    const parameterHash = computeParameterHash(parameters);
    const existing = await StrategyParameterVersion.findOne({
      accountId: scopedAccountId,
      strategyId,
      parameterHash
    });
    if (existing) return existing;

    const latest = await StrategyParameterVersion.findOne({
      accountId: scopedAccountId,
      strategyId
    }).sort({ version: -1 }).lean();
    const version = Number(latest?.version || 0) + 1;
    return await StrategyParameterVersion.create({
      accountId: scopedAccountId,
      strategyId,
      version,
      parameterHash,
      source,
      parameters,
      notes
    });
  } catch (_err) {
    return null;
  }
}

async function createStrategyRun({
  accountId,
  strategyId,
  strategyName = null,
  runType,
  mode = 'paper',
  symbol = null,
  universe = [],
  parameters = {},
  source = 'system',
  summary = {},
  context = {}
} = {}) {
  const scopedAccountId = normalizeAccountId(accountId);
  if (!mongoState.isMongoReady() || !scopedAccountId || !strategyId || !runType) return null;
  try {
    const parameterVersion = await getOrCreateParameterVersion({
      accountId: scopedAccountId,
      strategyId,
      parameters,
      source
    });
    return await StrategyRun.create({
      accountId: scopedAccountId,
      strategyId,
      strategyName,
      runType,
      mode,
      symbol,
      universe,
      parameterVersionId: parameterVersion?._id || null,
      summary,
      context,
      startedAt: new Date(),
      status: 'running'
    });
  } catch (_err) {
    return null;
  }
}

async function finalizeStrategyRun(run, { status = 'completed', metrics = {}, summary = {}, result = {}, error = null } = {}) {
  if (!run || !mongoState.isMongoReady()) return null;
  try {
    const runId = run._id || run;
    return await StrategyRun.findByIdAndUpdate(
      runId,
      {
        $set: {
          status,
          completedAt: new Date(),
          metrics,
          summary,
          result,
          error: error || null
        }
      },
      { new: true }
    );
  } catch (_err) {
    return null;
  }
}

async function listRecentStrategyRuns({ accountId, limit = 25, runType = null } = {}) {
  const scopedAccountId = normalizeAccountId(accountId);
  if (!scopedAccountId) return [];
  if (!mongoState.isMongoReady()) return [];
  try {
    const query = {
      accountId: scopedAccountId,
      ...(runType ? { runType } : {})
    };
    return await StrategyRun.find(query)
      .populate('parameterVersionId')
      .sort({ startedAt: -1 })
      .limit(Math.min(Math.max(Number(limit) || 25, 1), 100))
      .lean();
  } catch (_err) {
    return [];
  }
}

async function listRecentParameterVersions({ accountId, limit = 25, strategyId = null } = {}) {
  const scopedAccountId = normalizeAccountId(accountId);
  if (!scopedAccountId) return [];
  if (!mongoState.isMongoReady()) return [];
  try {
    const query = {
      accountId: scopedAccountId,
      ...(strategyId ? { strategyId } : {})
    };
    return await StrategyParameterVersion.find(query)
      .sort({ createdAt: -1, version: -1 })
      .limit(Math.min(Math.max(Number(limit) || 25, 1), 100))
      .lean();
  } catch (_err) {
    return [];
  }
}

module.exports = {
  computeParameterHash,
  createStrategyRun,
  finalizeStrategyRun,
  getOrCreateParameterVersion,
  listRecentParameterVersions,
  listRecentStrategyRuns,
  normalizeAccountId,
  stableSerialize
};
