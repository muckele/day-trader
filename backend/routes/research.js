const router = require('express').Router();
const mongoose = require('mongoose');
const auth = require('../middleware/auth');
const requireMongo = require('../middleware/requireMongo');
const ResearchNews = require('../models/ResearchNews');
const ResearchNote = require('../models/ResearchNote');
const ResearchAlert = require('../models/ResearchAlert');
const ResearchEvent = require('../models/ResearchEvent');
const ResearchSnapshot = require('../models/ResearchSnapshot');
const ResearchWatchlist = require('../models/ResearchWatchlist');
const TradePlan = require('../models/TradePlan');
const { DEFAULT_WATCHLIST } = require('../data/defaultWatchlist');
const analysisEngine = require('../analysisEngine');
const paperBroker = require('../paper/paperBrokerClient');
const { getRequestAccountId } = require('../utils/accountScope');
const {
  buildWatchlistResearchSummary,
  compareSymbols,
  getResearchProviderHealth,
  getResearchDashboard,
  getStockResearch,
  normalizeSymbol,
  refreshResearchEvents,
  refreshNews,
  screenStocks
} = require('../services/researchService');
const {
  buildResearchTradePreview,
  createTradePlanFromResearch
} = require('../services/researchTradeWorkflowService');

router.use(requireMongo);
router.use(auth);

function parseSymbols(value, fallback = []) {
  const source = Array.isArray(value) ? value : String(value || '').split(',');
  const symbols = [...new Set(source.map(normalizeSymbol).filter(Boolean))];
  return symbols.length ? symbols : fallback;
}

function parseTags(value) {
  if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(Boolean);
  return String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function getSymbolParam(req, res) {
  const symbol = normalizeSymbol(req.params.symbol);
  if (!symbol) {
    res.status(400).json({ message: 'A valid symbol is required.' });
    return null;
  }
  return symbol;
}

function isValidMongoId(value) {
  return mongoose.Types.ObjectId.isValid(String(value || ''));
}

function parseWatchlistSymbols(value, fallback = []) {
  return parseSymbols(value, fallback).slice(0, 60);
}

function sanitizeWatchlistPayload(body = {}) {
  const update = {};
  if (body.name !== undefined) update.name = String(body.name || '').trim().slice(0, 80);
  if (body.description !== undefined) update.description = String(body.description || '').trim().slice(0, 400);
  if (body.symbols !== undefined) update.symbols = parseWatchlistSymbols(body.symbols);
  if (body.pinnedSymbols !== undefined) update.pinnedSymbols = parseWatchlistSymbols(body.pinnedSymbols);
  return update;
}

async function ensureDefaultResearchWatchlist(accountId, username = null) {
  const defaults = {
    accountId,
    username,
    name: 'Core Research',
    description: 'Default research watchlist seeded from the app watchlist.',
    symbols: DEFAULT_WATCHLIST.map(item => item.symbol),
    pinnedSymbols: DEFAULT_WATCHLIST.slice(0, 4).map(item => item.symbol),
    isDefault: true
  };
  try {
    return await ResearchWatchlist.findOneAndUpdate(
      { accountId, isDefault: true },
      { $setOnInsert: defaults },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
  } catch (err) {
    if (err?.code !== 11000) throw err;
    return ResearchWatchlist.findOne({ accountId, isDefault: true }).lean();
  }
}

router.get('/dashboard', async (req, res, next) => {
  try {
    const symbols = parseSymbols(req.query.symbols);
    const dashboard = await getResearchDashboard({
      symbols: symbols.length ? symbols : undefined,
      ResearchNews,
      ResearchSnapshot,
      forceRefresh: req.query.refresh === 'true'
    });
    res.json(dashboard);
  } catch (err) {
    next(err);
  }
});

router.get('/health', async (_req, res, next) => {
  try {
    res.json(getResearchProviderHealth());
  } catch (err) {
    next(err);
  }
});

router.get('/stock/:symbol', async (req, res, next) => {
  try {
    const symbol = getSymbolParam(req, res);
    if (!symbol) return;
    const accountId = getRequestAccountId(req);
    const [research, notes, alerts] = await Promise.all([
      getStockResearch(symbol, {
        ResearchNews,
        ResearchEvent,
        ResearchSnapshot,
        analysisEngine,
        forceRefresh: req.query.refresh === 'true'
      }),
      ResearchNote.find({ accountId, symbol }).sort({ pinned: -1, updatedAt: -1 }).limit(25).lean(),
      ResearchAlert.find({ accountId, symbol }).sort({ isActive: -1, updatedAt: -1 }).limit(25).lean()
    ]);
    res.json({ ...research, notes, alerts });
  } catch (err) {
    next(err);
  }
});

router.get('/news/:symbol', async (req, res, next) => {
  try {
    const symbol = getSymbolParam(req, res);
    if (!symbol) return;
    const news = await refreshNews([symbol], ResearchNews, {
      limit: Math.min(Math.max(Number(req.query.limit) || 20, 1), 50)
    });
    res.json(news);
  } catch (err) {
    next(err);
  }
});

router.get('/events/:symbol', async (req, res, next) => {
  try {
    const symbol = getSymbolParam(req, res);
    if (!symbol) return;
    const result = await refreshResearchEvents(symbol, ResearchEvent, {
      limit: Math.min(Math.max(Number(req.query.limit) || 50, 1), 100)
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get('/compare', async (req, res, next) => {
  try {
    const symbols = parseSymbols(req.query.symbols, ['AAPL', 'MSFT', 'NVDA']);
    res.json(await compareSymbols(symbols, {
      ResearchNews,
      ResearchSnapshot,
      forceRefresh: req.query.refresh === 'true'
    }));
  } catch (err) {
    next(err);
  }
});

router.post('/trade-workflow/:symbol/preview', async (req, res, next) => {
  try {
    const accountId = getRequestAccountId(req);
    const symbol = getSymbolParam(req, res);
    if (!symbol) return;
    const [research, account, settings] = await Promise.all([
      getStockResearch(symbol, {
        ResearchNews,
        ResearchEvent,
        ResearchSnapshot,
        analysisEngine,
        forceRefresh: req.body?.refresh === true
      }),
      paperBroker.getAccount({ accountId }),
      paperBroker.getSettings({ accountId })
    ]);
    res.json(buildResearchTradePreview({
      research,
      account,
      settings,
      body: req.body || {}
    }));
  } catch (err) {
    next(err);
  }
});

router.post('/trade-workflow/:symbol/plan', async (req, res, next) => {
  try {
    const accountId = getRequestAccountId(req);
    const symbol = getSymbolParam(req, res);
    if (!symbol) return;
    const [research, account, settings] = await Promise.all([
      getStockResearch(symbol, {
        ResearchNews,
        ResearchEvent,
        ResearchSnapshot,
        analysisEngine,
        forceRefresh: req.body?.refresh === true
      }),
      paperBroker.getAccount({ accountId }),
      paperBroker.getSettings({ accountId })
    ]);
    const preview = buildResearchTradePreview({
      research,
      account,
      settings,
      body: req.body || {}
    });
    if (!preview.risk?.eligible) {
      return res.status(400).json({
        message: 'Research trade risk checks must pass before creating a trade plan.',
        preview
      });
    }
    const result = await createTradePlanFromResearch({
      accountId,
      preview,
      TradePlan
    });
    res.status(result.created ? 201 : 200).json({
      ...result,
      preview
    });
  } catch (err) {
    next(err);
  }
});

router.get('/screener', async (req, res, next) => {
  try {
    const symbols = parseSymbols(req.query.symbols);
    const result = await screenStocks({
      symbols: symbols.length ? symbols : undefined,
      filters: req.query,
      ResearchNews,
      ResearchEvent,
      ResearchSnapshot,
      forceRefresh: req.query.refresh === 'true'
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get('/watchlists', async (req, res, next) => {
  try {
    const accountId = getRequestAccountId(req);
    await ensureDefaultResearchWatchlist(accountId, req.user?.username || null);
    const watchlists = await ResearchWatchlist.find({ accountId })
      .sort({ isDefault: -1, updatedAt: -1 })
      .lean();
    res.json(watchlists);
  } catch (err) {
    next(err);
  }
});

router.post('/watchlists', async (req, res, next) => {
  try {
    const accountId = getRequestAccountId(req);
    const payload = sanitizeWatchlistPayload(req.body || {});
    const symbols = payload.symbols || [];
    const name = payload.name || 'Research Watchlist';
    const watchlist = await ResearchWatchlist.create({
      accountId,
      username: req.user?.username || null,
      name,
      description: payload.description || '',
      symbols,
      pinnedSymbols: payload.pinnedSymbols || [],
      isDefault: false
    });
    res.status(201).json(watchlist);
  } catch (err) {
    next(err);
  }
});

router.get('/watchlists/:watchlistId/summary', async (req, res, next) => {
  try {
    if (!isValidMongoId(req.params.watchlistId)) {
      return res.status(400).json({ message: 'Invalid research watchlist id.' });
    }
    const accountId = getRequestAccountId(req);
    const watchlist = await ResearchWatchlist.findOne({ _id: req.params.watchlistId, accountId }).lean();
    if (!watchlist) return res.status(404).json({ message: 'Research watchlist not found.' });
    const summary = await buildWatchlistResearchSummary({
      watchlist,
      ResearchNews,
      ResearchEvent,
      ResearchSnapshot,
      forceRefresh: req.query.refresh === 'true'
    });
    await ResearchWatchlist.updateOne(
      { _id: watchlist._id, accountId },
      { $set: { summarySnapshot: summary, summaryGeneratedAt: new Date(summary.updatedAt || Date.now()) } }
    );
    res.json(summary);
  } catch (err) {
    next(err);
  }
});

router.get('/watchlists/:watchlistId', async (req, res, next) => {
  try {
    if (!isValidMongoId(req.params.watchlistId)) {
      return res.status(400).json({ message: 'Invalid research watchlist id.' });
    }
    const accountId = getRequestAccountId(req);
    const watchlist = await ResearchWatchlist.findOne({ _id: req.params.watchlistId, accountId }).lean();
    if (!watchlist) return res.status(404).json({ message: 'Research watchlist not found.' });
    res.json(watchlist);
  } catch (err) {
    next(err);
  }
});

router.patch('/watchlists/:watchlistId', async (req, res, next) => {
  try {
    if (!isValidMongoId(req.params.watchlistId)) {
      return res.status(400).json({ message: 'Invalid research watchlist id.' });
    }
    const accountId = getRequestAccountId(req);
    const update = sanitizeWatchlistPayload(req.body || {});
    if (update.name !== undefined && !update.name) {
      return res.status(400).json({ message: 'Watchlist name is required.' });
    }
    const watchlist = await ResearchWatchlist.findOneAndUpdate(
      { _id: req.params.watchlistId, accountId },
      { $set: update },
      { new: true }
    );
    if (!watchlist) return res.status(404).json({ message: 'Research watchlist not found.' });
    res.json(watchlist);
  } catch (err) {
    next(err);
  }
});

router.delete('/watchlists/:watchlistId', async (req, res, next) => {
  try {
    if (!isValidMongoId(req.params.watchlistId)) {
      return res.status(400).json({ message: 'Invalid research watchlist id.' });
    }
    const accountId = getRequestAccountId(req);
    const result = await ResearchWatchlist.deleteOne({ _id: req.params.watchlistId, accountId });
    res.json({ deleted: result.deletedCount === 1 });
  } catch (err) {
    next(err);
  }
});

router.get('/notes/:symbol', async (req, res, next) => {
  try {
    const accountId = getRequestAccountId(req);
    const symbol = getSymbolParam(req, res);
    if (!symbol) return;
    const notes = await ResearchNote.find({ accountId, symbol })
      .sort({ pinned: -1, updatedAt: -1 })
      .limit(50)
      .lean();
    res.json(notes);
  } catch (err) {
    next(err);
  }
});

router.post('/notes/:symbol', async (req, res, next) => {
  try {
    const accountId = getRequestAccountId(req);
    const symbol = getSymbolParam(req, res);
    if (!symbol) return;
    const note = await ResearchNote.create({
      accountId,
      username: req.user?.username || null,
      symbol,
      title: String(req.body?.title || '').trim().slice(0, 120),
      body: String(req.body?.body || '').trim().slice(0, 5000),
      tags: parseTags(req.body?.tags).slice(0, 12),
      stance: ['bullish', 'neutral', 'bearish'].includes(req.body?.stance) ? req.body.stance : 'neutral',
      pinned: Boolean(req.body?.pinned)
    });
    res.status(201).json(note);
  } catch (err) {
    next(err);
  }
});

router.patch('/notes/:noteId', async (req, res, next) => {
  try {
    if (!isValidMongoId(req.params.noteId)) {
      return res.status(400).json({ message: 'Invalid research note id.' });
    }
    const accountId = getRequestAccountId(req);
    const update = {};
    if (req.body?.title !== undefined) update.title = String(req.body.title || '').trim().slice(0, 120);
    if (req.body?.body !== undefined) update.body = String(req.body.body || '').trim().slice(0, 5000);
    if (req.body?.tags !== undefined) update.tags = parseTags(req.body.tags).slice(0, 12);
    if (req.body?.stance !== undefined) {
      update.stance = ['bullish', 'neutral', 'bearish'].includes(req.body.stance) ? req.body.stance : 'neutral';
    }
    if (req.body?.pinned !== undefined) update.pinned = Boolean(req.body.pinned);

    const note = await ResearchNote.findOneAndUpdate(
      { _id: req.params.noteId, accountId },
      { $set: update },
      { new: true }
    );
    if (!note) return res.status(404).json({ message: 'Research note not found.' });
    res.json(note);
  } catch (err) {
    next(err);
  }
});

router.delete('/notes/:noteId', async (req, res, next) => {
  try {
    if (!isValidMongoId(req.params.noteId)) {
      return res.status(400).json({ message: 'Invalid research note id.' });
    }
    const accountId = getRequestAccountId(req);
    const result = await ResearchNote.deleteOne({ _id: req.params.noteId, accountId });
    res.json({ deleted: result.deletedCount === 1 });
  } catch (err) {
    next(err);
  }
});

router.get('/alerts/:symbol', async (req, res, next) => {
  try {
    const accountId = getRequestAccountId(req);
    const symbol = getSymbolParam(req, res);
    if (!symbol) return;
    const alerts = await ResearchAlert.find({ accountId, symbol })
      .sort({ isActive: -1, updatedAt: -1 })
      .limit(50)
      .lean();
    res.json(alerts);
  } catch (err) {
    next(err);
  }
});

router.post('/alerts/:symbol', async (req, res, next) => {
  try {
    const accountId = getRequestAccountId(req);
    const symbol = getSymbolParam(req, res);
    if (!symbol) return;
    const type = String(req.body?.type || '').trim();
    const allowed = ['price_above', 'price_below', 'volume_spike', 'rsi_above', 'rsi_below', 'news_keyword', 'thesis_change'];
    if (!allowed.includes(type)) return res.status(400).json({ message: 'Invalid alert type.' });
    const threshold = req.body?.threshold === '' || req.body?.threshold === undefined
      ? null
      : Number(req.body.threshold);
    if (!['news_keyword', 'thesis_change'].includes(type) && (!Number.isFinite(threshold) || threshold <= 0)) {
      return res.status(400).json({ message: 'Numeric threshold is required for this alert type.' });
    }
    const alert = await ResearchAlert.create({
      accountId,
      username: req.user?.username || null,
      symbol,
      type,
      threshold,
      keyword: String(req.body?.keyword || '').trim().slice(0, 80),
      message: String(req.body?.message || '').trim().slice(0, 240),
      isActive: req.body?.isActive !== false
    });
    res.status(201).json(alert);
  } catch (err) {
    next(err);
  }
});

router.patch('/alerts/:alertId', async (req, res, next) => {
  try {
    if (!isValidMongoId(req.params.alertId)) {
      return res.status(400).json({ message: 'Invalid research alert id.' });
    }
    const accountId = getRequestAccountId(req);
    const update = {};
    if (req.body?.isActive !== undefined) update.isActive = Boolean(req.body.isActive);
    if (req.body?.threshold !== undefined) update.threshold = req.body.threshold === '' ? null : Number(req.body.threshold);
    if (req.body?.keyword !== undefined) update.keyword = String(req.body.keyword || '').trim().slice(0, 80);
    if (req.body?.message !== undefined) update.message = String(req.body.message || '').trim().slice(0, 240);
    const alert = await ResearchAlert.findOneAndUpdate(
      { _id: req.params.alertId, accountId },
      { $set: update },
      { new: true }
    );
    if (!alert) return res.status(404).json({ message: 'Research alert not found.' });
    res.json(alert);
  } catch (err) {
    next(err);
  }
});

router.delete('/alerts/:alertId', async (req, res, next) => {
  try {
    if (!isValidMongoId(req.params.alertId)) {
      return res.status(400).json({ message: 'Invalid research alert id.' });
    }
    const accountId = getRequestAccountId(req);
    const result = await ResearchAlert.deleteOne({ _id: req.params.alertId, accountId });
    res.json({ deleted: result.deletedCount === 1 });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
