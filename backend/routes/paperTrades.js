const router = require('express').Router();
const paperBroker = require('../paper/paperBrokerClient');

router.post('/order', async (req, res) => {
  try {
    const {
      symbol,
      side,
      qty,
      orderType,
      limitPrice,
      strategyId,
      setupType,
      strategyTags,
      stopPrice
    } = req.body || {};
    const result = await paperBroker.placeOrder({
      symbol,
      side,
      qty,
      orderType,
      limitPrice,
      strategyId,
      setupType,
      strategyTags,
      stopPrice
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/account', async (req, res, next) => {
  try {
    const account = await paperBroker.getAccount();
    res.json(account);
  } catch (err) {
    next(err);
  }
});

router.get('/positions', async (req, res, next) => {
  try {
    const positions = await paperBroker.getPositions();
    res.json(positions);
  } catch (err) {
    next(err);
  }
});

router.get('/orders', async (req, res, next) => {
  try {
    const orders = await paperBroker.getOrders();
    res.json(orders);
  } catch (err) {
    next(err);
  }
});

router.get('/trades', async (req, res, next) => {
  try {
    const trades = await paperBroker.getTrades();
    res.json(trades);
  } catch (err) {
    next(err);
  }
});

router.get('/equity', async (req, res, next) => {
  try {
    const equity = await paperBroker.getEquityCurve();
    res.json(equity);
  } catch (err) {
    next(err);
  }
});

router.get('/settings', async (req, res, next) => {
  try {
    const settings = await paperBroker.getSettings();
    res.json(settings);
  } catch (err) {
    next(err);
  }
});

router.put('/settings', async (req, res, next) => {
  try {
    const settings = await paperBroker.updateSettings(req.body || {});
    res.json(settings);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
