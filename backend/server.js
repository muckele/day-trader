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

// 5. Create the Express app
const app = express();

// 6. Global middleware
app.use(express.json());
app.use(cors());

// 7. Mount the Alpaca trade routes
//    All routes defined in routes/trade.js are now under /api/trade
app.use('/api/trade', require('./routes/trade'));
app.use('/api/market',  require('./routes/market'));
app.use('/api/analyze', require('./routes/analyze'));
app.use('/api/company', require('./routes/company'));
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
app.listen(PORT, () =>
  console.log(`Day Trader API listening on http://localhost:${PORT}`)
);
