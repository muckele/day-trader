const router = require('express').Router();
const mongoose = require('mongoose');
const auth = require('../middleware/auth');
const requireMongo = require('../middleware/requireMongo');
const PaperJournalEntry = require('../models/PaperJournalEntry');
const PaperTrade = require('../models/PaperTrade');
const { parseRange } = require('../analytics/analyticsUtils');
const { getRequestAccountId } = require('../utils/accountScope');
const { normalizeMarketSymbol } = require('../utils/marketSymbol');

router.use(requireMongo);
router.use(auth);

function parseTags(tags) {
  if (Array.isArray(tags)) return tags.map(tag => String(tag).trim()).filter(Boolean);
  if (typeof tags === 'string') {
    return tags
      .split(',')
      .map(tag => tag.trim())
      .filter(Boolean);
  }
  return [];
}

function sanitizeJournalPayload(body = {}, username = null) {
  const fields = [
    ['thesis', 5000],
    ['plan', 5000],
    ['emotions', 500],
    ['postTradeNotes', 5000]
  ];
  const payload = { username };
  for (const [field, maxLength] of fields) {
    const value = String(body[field] || '').trim();
    if (value.length > maxLength) return { error: `${field} is limited to ${maxLength} characters.` };
    payload[field] = value;
  }
  const tags = [...new Set(parseTags(body.tags))];
  if (tags.length > 12 || tags.some(tag => tag.length > 40)) {
    return { error: 'tags is limited to 12 unique entries of 40 characters each.' };
  }
  payload.tags = tags;
  if (body.rating === undefined || body.rating === null || body.rating === '') {
    payload.rating = null;
  } else {
    const rating = Number(body.rating);
    if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
      return { error: 'rating must be a number from 1 to 5.' };
    }
    payload.rating = rating;
  }
  return { payload };
}

function validTradeId(value) {
  return mongoose.Types.ObjectId.isValid(String(value || ''));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeSearchQuery(value) {
  const search = String(value || '').trim();
  if (search.length > 80) return null;
  return search;
}

router.get('/:tradeId', async (req, res, next) => {
  try {
    if (!validTradeId(req.params.tradeId)) return res.status(400).json({ error: 'Invalid trade id.' });
    const accountId = getRequestAccountId(req);
    const entry = await PaperJournalEntry.findOne({
      accountId,
      tradeId: req.params.tradeId
    }).lean();
    res.json(entry || null);
  } catch (err) {
    next(err);
  }
});

router.put('/:tradeId', async (req, res, next) => {
  try {
    if (!validTradeId(req.params.tradeId)) return res.status(400).json({ error: 'Invalid trade id.' });
    const accountId = getRequestAccountId(req);
    const sanitized = sanitizeJournalPayload(req.body, req.user?.username || null);
    if (sanitized.error) return res.status(400).json({ error: sanitized.error });

    const entry = await PaperJournalEntry.findOneAndUpdate(
      { accountId, tradeId: req.params.tradeId },
      { $set: sanitized.payload },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
    );
    res.json(entry);
  } catch (err) {
    next(err);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const accountId = getRequestAccountId(req);
    const { range = '30d', symbol = '', strategyId = '', tag = '', search = '' } = req.query;
    const normalizedSearch = normalizeSearchQuery(search);
    if (normalizedSearch === null) {
      return res.status(400).json({ error: 'search is limited to 80 characters.' });
    }
    const startDate = parseRange(range);
    const tradeQuery = { accountId };
    if (startDate) tradeQuery.filledAt = { $gte: startDate };
    if (symbol) {
      const normalizedSymbol = normalizeMarketSymbol(symbol);
      if (!normalizedSymbol) return res.status(400).json({ error: 'Invalid symbol.' });
      tradeQuery.symbol = normalizedSymbol;
    }
    if (String(strategyId).length > 100) return res.status(400).json({ error: 'strategyId is limited to 100 characters.' });
    if (String(tag).length > 40) return res.status(400).json({ error: 'tag is limited to 40 characters.' });
    if (strategyId) tradeQuery.strategyId = strategyId;

    const trades = await PaperTrade.find(tradeQuery).sort({ filledAt: -1 }).lean();
    const tradeIds = trades.map(trade => trade._id);
    const journalQuery = { accountId, tradeId: { $in: tradeIds } };

    if (tag) journalQuery.tags = tag;
    if (normalizedSearch) {
      const regex = new RegExp(escapeRegExp(normalizedSearch), 'i');
      journalQuery.$or = [
        { thesis: regex },
        { plan: regex },
        { emotions: regex },
        { postTradeNotes: regex }
      ];
    }

    const entries = await PaperJournalEntry.find(journalQuery).lean();
    const tradeMap = trades.reduce((acc, trade) => {
      acc[trade._id.toString()] = trade;
      return acc;
    }, {});

    const results = entries.map(entry => {
      const trade = tradeMap[entry.tradeId.toString()];
      return {
        ...entry,
        trade: trade
          ? {
              symbol: trade.symbol,
              filledAt: trade.filledAt,
              realizedPnl: trade.realizedPnl,
              strategyId: trade.strategyId,
              regimeAtTrade: trade.regimeAtTrade
            }
          : null
      };
    });

    res.json(results);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
