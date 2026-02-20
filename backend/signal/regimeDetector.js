const { sma, atr, rollingVolatility, slope } = require('./indicators');
const { fetchDaily } = require('../tradeLogic');

function classifyTrend({ sma20, sma50, slope20 }) {
  if (!sma20 || !sma50) return 'CHOP';
  const spread = Math.abs(sma20 - sma50) / sma50;
  if (spread > 0.01 && Math.abs(slope20) > 0.01) return 'TREND';
  return 'CHOP';
}

function classifyVolatility({ atrPct, rollingVol }) {
  if (!atrPct || !rollingVol) return 'CONTRACTION';
  return atrPct > rollingVol ? 'EXPANSION' : 'CONTRACTION';
}

async function detectRegime() {
  const notes = [];
  let spyBars = [];
  let qqqBars = [];

  try {
    spyBars = await fetchDaily('SPY');
  } catch (err) {
    notes.push('SPY data unavailable, using defaults.');
  }

  try {
    qqqBars = await fetchDaily('QQQ');
  } catch (err) {
    notes.push('QQQ data unavailable, using defaults.');
  }

  if (!spyBars.length) {
    return {
      trendChop: 'CHOP',
      vol: 'CONTRACTION',
      risk: 'RISK_OFF',
      notes: [...notes, 'Insufficient market data for regime detection.']
    };
  }

  const spyCloses = spyBars.map(bar => bar.c);
  const spySma20 = sma(spyCloses, 20);
  const spySma50 = sma(spyCloses, 50);
  const spySma200 = sma(spyCloses, 200);
  const slope20 = slope(spyCloses.slice(-20), 10);
  const spyAtr = atr(spyBars, 14);
  const atrPct = spyAtr && spyCloses.length ? spyAtr / spyCloses[spyCloses.length - 1] : null;
  const vol = rollingVolatility(spyCloses, 20);

  const trendChop = classifyTrend({ sma20: spySma20, sma50: spySma50, slope20 });
  const volatility = classifyVolatility({ atrPct, rollingVol: vol });

  let risk = 'RISK_OFF';
  if (spySma200 && spyCloses[spyCloses.length - 1] > spySma200) {
    risk = 'RISK_ON';
  }
  if (qqqBars.length) {
    const qqqCloses = qqqBars.map(bar => bar.c);
    const qqqSma200 = sma(qqqCloses, 200);
    if (!qqqSma200 || qqqCloses[qqqCloses.length - 1] <= qqqSma200) {
      risk = 'RISK_OFF';
    }
  } else {
    notes.push('QQQ unavailable; risk-on uses SPY only.');
  }

  return {
    trendChop,
    vol: volatility,
    risk,
    notes
  };
}

module.exports = { detectRegime, classifyTrend, classifyVolatility };
