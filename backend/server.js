// backend/server.js

// 1. Load environment variables
require('dotenv').config();

// 2. Connect to MongoDB
const mongoose = require('mongoose');
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => {
    console.error('❌ MongoDB connection error:', err);
    process.exit(1);
  });

// 3. Import dependencies
const express   = require('express');
const cors      = require('cors');
const axios     = require('axios');
const jwt       = require('jsonwebtoken');
const bcrypt    = require('bcryptjs');

// 4. Import your models, trade logic & auth middleware
const User                = require('./models/User');
const Log                 = require('./models/Log');
const { getRecommendations, fetchIntraday } = require('./tradeLogic');
const auth                = require('./middleware/auth');      // ← imported
const debugRoutes         = require('./routes/debug');

// 5. Create the Express app
const app = express();

// 6. Global middleware
app.use(express.json());
const isProduction = process.env.NODE_ENV === 'production';
const configuredOrigins = (process.env.FRONTEND_ORIGIN || '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);
const defaultDevOrigins = ['http://localhost:3000', 'http://127.0.0.1:3000'];
const allowedOrigins = new Set(
  isProduction
    ? configuredOrigins
    : [...configuredOrigins, ...defaultDevOrigins]
);
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (!isProduction && configuredOrigins.length === 0) return callback(null, true);
    if (allowedOrigins.has(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  }
}));

// 7. Mount the Alpaca trade routes
//    All routes defined in routes/trade.js are now under /api/trade
app.use('/api/trade', require('./routes/trade'));
app.use('/api/market',  require('./routes/market'));
app.use('/api/analyze', require('./routes/analyze'));
app.use('/api/company', require('./routes/company'));
app.use('/api/watchlist', require('./routes/watchlist'));
app.use('/api/paper-trades', require('./routes/paperTrades'));
app.use('/api/regime', require('./routes/regime'));
app.use('/api/backtest', require('./routes/backtest'));
app.use('/api/strategies', require('./routes/strategies'));
app.use('/api/analytics', require('./routes/analytics'));
app.use('/api/journal', require('./routes/journal'));
app.use('/api/trade-plan', require('./routes/tradePlan'));
app.use('/api/execution', require('./routes/execution'));
app.use('/api/debug', debugRoutes);
// Trade Recomendations 
app.use('/api/recommendations', require('./routes/recommend'));


// ─── 8. REGISTER ────────────────────────────────────────────────────────────────
app.post('/api/register', async (req, res, next) => {
  try {
    const { username, password } = req.body;
    const hash = await bcrypt.hash(password, 10);
    await User.create({ username, hash });
    res.json({ message: 'User registered successfully' });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ message: 'Username already taken' });
    }
    next(err);
  }
});

// ─── 9. LOGIN ──────────────────────────────────────────────────────────────────
app.post('/api/login', async (req, res, next) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }
    const valid = await bcrypt.compare(password, user.hash);
    if (!valid) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }
    const token = jwt.sign(
      { username: user.username },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
    res.json({ token });
  } catch (err) {
    next(err);
  }
});

// ─── 10. LOGOUT ────────────────────────────────────────────────────────────────
app.post('/api/logout', auth, async (req, res, next) => {
  try {
    await Log.create({ username: req.user.username, action: 'logout' });
    res.json({ message: 'Logged out successfully' });
  } catch (err) {
    next(err);
  }
});

// ─── 11. PUBLIC ENDPOINTS ────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.send('📈 Day Trader API — public endpoint');
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', asOf: new Date().toISOString() });
});

app.get('/api/recommend/:symbol', async (req, res, next) => {
  try {
    const recs = await getRecommendations(req.params.symbol.toUpperCase());
    res.json(recs);
  } catch (err) {
    next(err);
  }
});

app.get('/api/intraday/:symbol', async (req, res, next) => {
  try {
    const data = await fetchIntraday(req.params.symbol.toUpperCase());
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// ─── 12. ERROR HANDLER ───────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ message: err.message });
});

// ─── 13. START SERVER ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
app.listen(PORT, '0.0.0.0', () =>
  console.log(`Day Trader API listening on http://0.0.0.0:${PORT}`)
);
