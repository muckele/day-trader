const router = require('express').Router();
const PaperJournalEntry = require('../models/PaperJournalEntry');
const PaperTrade = require('../models/PaperTrade');
const { parseRange } = require('../analytics/analyticsUtils');

const ACCOUNT_ID = 'default';

function parseTags(tags) {
  if (Array.isArray(tags)) return tags;
  if (typeof tags === 'string') {
    return tags
      .split(',')
      .map(tag => tag.trim())
      .filter(Boolean);
  }
  return [];
}

router.get('/:tradeId', async (req, res, next) => {
  try {
    const entry = await PaperJournalEntry.findOne({
      accountId: ACCOUNT_ID,
      tradeId: req.params.tradeId
    }).lean();
    res.json(entry || null);
  } catch (err) {
    next(err);
  }
});

router.put('/:tradeId', async (req, res, next) => {
  try {
    const payload = {
      thesis: req.body?.thesis || '',
      plan: req.body?.plan || '',
      emotions: req.body?.emotions || '',
      postTradeNotes: req.body?.postTradeNotes || '',
      rating: req.body?.rating ?? null,
      tags: parseTags(req.body?.tags),
      username: req.user?.username || null
    };

    const entry = await PaperJournalEntry.findOneAndUpdate(
      { accountId: ACCOUNT_ID, tradeId: req.params.tradeId },
      { $set: payload },
      { new: true, upsert: true }
    );
    res.json(entry);
  } catch (err) {
    next(err);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const { range = '30d', symbol = '', strategyId = '', tag = '', search = '' } = req.query;
    const startDate = parseRange(range);
    const tradeQuery = { accountId: ACCOUNT_ID };
    if (startDate) tradeQuery.filledAt = { $gte: startDate };
    if (symbol) tradeQuery.symbol = symbol.toUpperCase();
    if (strategyId) tradeQuery.strategyId = strategyId;

    const trades = await PaperTrade.find(tradeQuery).sort({ filledAt: -1 }).lean();
    const tradeIds = trades.map(trade => trade._id);
    const journalQuery = { accountId: ACCOUNT_ID, tradeId: { $in: tradeIds } };

    if (tag) journalQuery.tags = tag;
    if (search) {
      const regex = new RegExp(search, 'i');
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
