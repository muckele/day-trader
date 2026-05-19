// backend/server.js

// 1. Load environment variables for local/dev workflows only.
// Production should rely on the runtime environment or Fly secrets rather than a bundled `.env`.
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

// 2. Connect to MongoDB
const dns = require('dns');
const mongoose = require('mongoose');
const requireMongo = require('./middleware/requireMongo');
const mongoState = require('./utils/mongoState');
const { ensureTradingIndexes } = require('./services/tradingIndexService');
const { buildMongoConnectionTargets } = require('./utils/mongoConnectionConfig');
const {
  buildMongoConnectOptions,
  checkMongoSrvRecord,
  normalizeMongoIpFamily
} = require('./utils/mongoNetwork');
const MONGO_RETRY_MS = Math.max(1000, Number(process.env.MONGO_RETRY_MS || 10000));
const MONGO_SERVER_SELECTION_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS || 5000)
);
const mongoConnectionConfig = buildMongoConnectionTargets(process.env);
const MONGO_IP_FAMILY = normalizeMongoIpFamily(
  process.env.MONGO_IP_FAMILY,
  mongoConnectionConfig.isProduction ? 4 : 0
);
const MONGO_DNS_SERVERS = String(process.env.MONGO_DNS_SERVERS || '')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);
let mongoConnectInFlight = false;
let mongoReconnectTimer = null;

mongoose.set('bufferCommands', false);
mongoose.set('bufferTimeoutMS', 0);
mongoState.setMongoConfigured(Boolean(mongoConnectionConfig.targets.length));

if (!mongoConnectionConfig.isProduction && mongoConnectionConfig.preferLocal) {
  console.log('ℹ️ Development Mongo mode enabled: preferring local MongoDB before Atlas.');
}
if (MONGO_IP_FAMILY === 4 || MONGO_IP_FAMILY === 6) {
  console.log(`ℹ️ MongoDB IP family preference set to IPv${MONGO_IP_FAMILY}.`);
}

if (MONGO_DNS_SERVERS.length) {
  try {
    dns.setServers(MONGO_DNS_SERVERS);
    console.log(`ℹ️ Using custom DNS servers for MongoDB lookups: ${MONGO_DNS_SERVERS.join(', ')}`);
  } catch (err) {
    console.error('❌ Invalid MONGO_DNS_SERVERS value:', err?.message || err);
  }
}

function isSrvLookupError(err) {
  const message = String(err?.message || '').toLowerCase();
  return (
    /querysrv/.test(message) ||
    /_mongodb\._tcp/.test(message) ||
    ((err?.code === 'ENOTFOUND' || err?.code === 'ECONNREFUSED') && /mongodb/.test(message))
  );
}

function getMongoTroubleshootingHint(err) {
  const message = String(err?.message || '').toLowerCase();

  if (
    /(127\.0\.0\.1|localhost)/.test(message) &&
    /(econnrefused|connect|server selection timed out)/.test(message)
  ) {
    return 'Local MongoDB is not running. Start a local MongoDB instance or set MONGO_PREFER_LOCAL=false to use Atlas first.';
  }
  if (isSrvLookupError(err)) {
    return [
      'MongoDB SRV lookup failed. Verify Atlas cluster hostname, DNS/network access,',
      'and Atlas Network Access allowlist. If SRV is blocked on this network, set MONGO_URI_DIRECT.'
    ].join(' ');
  }
  if (/authentication failed|bad auth|auth failed/.test(message)) {
    return 'MongoDB authentication failed. Verify Atlas DB user/password in MONGO_URI.';
  }
  if (/getaddrinfo|enotfound/.test(message)) {
    return 'MongoDB host lookup failed. Verify the Atlas cluster hostname or MONGO_URI_DIRECT seed list.';
  }
  if (/ip|whitelist|allowlist|not authorized/.test(message)) {
    return 'MongoDB access blocked by Atlas network rules. Add this machine IP in Atlas Network Access.';
  }
  return null;
}

function scheduleMongoReconnect() {
  if (mongoReconnectTimer) return;
  mongoReconnectTimer = setTimeout(() => {
    mongoReconnectTimer = null;
    connectMongo();
  }, MONGO_RETRY_MS);
}

async function connectMongo() {
  if (!mongoConnectionConfig.targets.length) {
    console.warn('⚠️ No MongoDB connection targets configured. Running without database connectivity.');
    return;
  }
  if (mongoConnectInFlight) return;
  if (mongoose.connection.readyState === 1 || mongoose.connection.readyState === 2) return;
  const connectAttempts = mongoConnectionConfig.targets;

  mongoConnectInFlight = true;
  try {
    let lastErr = null;
    for (let i = 0; i < connectAttempts.length; i += 1) {
      const attempt = connectAttempts[i];
      const hasMoreAttempts = i < connectAttempts.length - 1;
      if (attempt.label === 'MONGO_URI' && String(attempt.uri).startsWith('mongodb+srv://')) {
        const srvCheck = await checkMongoSrvRecord(attempt.uri);
        if (!srvCheck.ok) {
          lastErr = srvCheck.error || new Error(`DNS SRV lookup failed for ${srvCheck.record}`);
          if (hasMoreAttempts) {
            console.warn(
              `⚠️ MongoDB SRV lookup failed for ${srvCheck.record}. Trying fallback Mongo connection target...`
            );
            continue;
          }
        }
      }
      try {
        await mongoose.connect(
          attempt.uri,
          buildMongoConnectOptions({
            serverSelectionTimeoutMS: MONGO_SERVER_SELECTION_TIMEOUT_MS,
            ipFamily: MONGO_IP_FAMILY
          })
        );
        mongoState.markMongoConnected(attempt.label);
        if (attempt.label === 'MONGO_LOCAL_URI') {
          console.log('✅ MongoDB connected via local development instance.');
        } else if (attempt.label === 'MONGO_URI_DIRECT') {
          console.warn('⚠️ MongoDB connected via MONGO_URI_DIRECT fallback.');
        } else {
          console.log('✅ MongoDB connected');
        }
        ensureTradingIndexes().then(results => {
          const failed = results.filter(result => !result.ok);
          if (failed.length) {
            console.error(`⚠️ Trading index bootstrap completed with ${failed.length} failure(s).`);
          }
        }).catch(indexErr => {
          console.error('⚠️ Trading index bootstrap failed:', indexErr?.message || indexErr);
        });
        return;
      } catch (err) {
        lastErr = err;
        if (hasMoreAttempts) {
          if (attempt.label === 'MONGO_LOCAL_URI') {
            console.warn('⚠️ Local MongoDB unavailable. Trying fallback Mongo connection target...');
          } else if (isSrvLookupError(err)) {
            console.warn(
              '⚠️ MongoDB SRV lookup failed on MONGO_URI. Trying MONGO_URI_DIRECT fallback...'
            );
          } else {
            console.warn(`⚠️ ${attempt.label} connection failed. Trying fallback...`);
          }
          continue;
        }
      }
    }

    throw lastErr || new Error('MongoDB connection failed');
  } catch (err) {
    console.error('❌ MongoDB connection error:', err);
    const hint = getMongoTroubleshootingHint(err);
    mongoState.markMongoFailed(err, hint);
    if (hint) {
      console.error(`ℹ️ ${hint}`);
    }
    console.error(`↻ Retrying MongoDB connection in ${MONGO_RETRY_MS}ms`);
    scheduleMongoReconnect();
  } finally {
    mongoConnectInFlight = false;
  }
}

mongoose.connection.on('disconnected', () => {
  console.warn('⚠️ MongoDB disconnected');
  scheduleMongoReconnect();
});

mongoose.connection.on('error', err => {
  console.error('❌ MongoDB driver error:', err?.message || err);
  mongoState.markMongoFailed(err, getMongoTroubleshootingHint(err));
});

connectMongo();

// 3. Import dependencies
const express   = require('express');
const cors      = require('cors');
const axios     = require('axios');
const { ensureSlowBufferCompat } = require('./utils/nodeCompat');
ensureSlowBufferCompat();
const jwt       = require('jsonwebtoken');
const bcrypt    = require('bcryptjs');

// 4. Import your models, trade logic & auth middleware
const User                = require('./models/User');
const Log                 = require('./models/Log');
const { getRecommendations, fetchIntraday } = require('./tradeLogic');
const auth                = require('./middleware/auth');      // ← imported
const debugRoutes         = require('./routes/debug');
const { startRoboScheduler } = require('./services/roboScheduler');

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
app.use('/api/robo', require('./routes/robo'));
app.use('/api/robotrader', require('./routes/robotrader'));
app.use('/api/trading-system', require('./routes/tradingSystem'));
// Trade Recomendations 
app.use('/api/recommendations', require('./routes/recommend'));


// ─── 8. REGISTER ────────────────────────────────────────────────────────────────
app.post('/api/register', requireMongo, async (req, res, next) => {
  try {
    const { username, password, email } = req.body;
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!normalizedEmail) {
      return res.status(400).json({ message: 'Email is required' });
    }
    const hash = await bcrypt.hash(password, 10);
    await User.create({ username, email: normalizedEmail, hash });
    res.json({ message: 'User registered successfully' });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ message: 'Username or email already taken' });
    }
    next(err);
  }
});

// ─── 9. LOGIN ──────────────────────────────────────────────────────────────────
app.post('/api/login', requireMongo, async (req, res, next) => {
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
app.post('/api/logout', auth, requireMongo, async (req, res, next) => {
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
  res.json({
    status: 'ok',
    asOf: new Date().toISOString(),
    services: {
      mongo: mongoState.getMongoServiceState()
    }
  });
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
  const message = String(err?.message || 'Unexpected server error');
  const name = String(err?.name || '');
  const isMongoUnavailable =
    name === 'MongoServerSelectionError' ||
    name === 'MongooseServerSelectionError' ||
    /buffering timed out/i.test(message) ||
    /failed to connect to server/i.test(message) ||
    /connection .* closed/i.test(message);

  if (isMongoUnavailable) {
    return res.status(503).json(mongoState.createMongoUnavailablePayload());
  }

  res.status(500).json({ message });
});

// ─── 13. START SERVER ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
app.listen(PORT, '0.0.0.0', () =>
  console.log(`Day Trader API listening on http://0.0.0.0:${PORT}`)
);
startRoboScheduler();
