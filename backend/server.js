// backend/server.js

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const { getRecommendations, fetchIntraday } = require('./tradeLogic');

const app = express();
app.use(express.json());
app.use(cors());

// In-memory user store (replace with a real database in production)
const users = [];

// ─── 1. REGISTER ────────────────────────────────────────────────────────────────
app.post('/api/register', async (req, res, next) => {
  try {
    const { username, password } = req.body;
    // Hash the password
    const hash = await bcrypt.hash(password, 10);
    users.push({ username, hash });
    res.json({ message: 'User registered successfully' });
  } catch (err) {
    next(err);
  }
});

// ─── 2. LOGIN ──────────────────────────────────────────────────────────────────
app.post('/api/login', async (req, res, next) => {
  try {
    const { username, password } = req.body;
    const user = users.find(u => u.username === username);
    if (!user) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }
    const valid = await bcrypt.compare(password, user.hash);
    if (!valid) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }
    // Sign a JWT (expires in 1 hour)
    const token = jwt.sign(
      { username },
      process.env.JWT_SECRET || 'your-default-secret',
      { expiresIn: '1h' }
    );
    res.json({ token });
  } catch (err) {
    next(err);
  }
});

// ─── 3. AUTH MIDDLEWARE ─────────────────────────────────────────────────────────
function auth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s/, '');
  if (!token) {
    return res.status(401).json({ message: 'Missing Authorization header' });
  }
  try {
    // Verify and decode
    req.user = jwt.verify(token, process.env.JWT_SECRET || 'your-default-secret');
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
}

// ─── 4. PUBLIC ENDPOINTS ────────────────────────────────────────────────────────
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

// ─── 5. PROTECTED TRADE ENDPOINT ───────────────────────────────────────────────
app.post('/api/trade', auth, async (req, res, next) => {
  try {
    const { symbol, side, qty } = req.body;
    const resp = await axios.post(
      `${process.env.BROKER_BASE_URL}/v2/orders`,
      { symbol, side, qty, type: 'market', time_in_force: 'day' },
      {
        headers: {
          'APCA-API-KEY-ID': process.env.BROKER_API_KEY,
          'APCA-API-SECRET-KEY': process.env.BROKER_API_SECRET
        }
      }
    );
    res.json(resp.data);
  } catch (err) {
    next(err);
  }
});

// ─── 6. ERROR HANDLER ───────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ message: err.message });
});

// ─── 7. START SERVER ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Day Trader API listening on http://localhost:${PORT}`));
