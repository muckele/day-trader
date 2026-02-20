// backend/aiEngine.js
const axios = require('axios');

// read DeepSeek settings (validated at call time)
const DEEPSEEK_BASE = process.env.DEEPSEEK_API_BASE_URL;
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;

/**
 * Calls DeepSeek to get an AI rationale for a stock recommendation.
 */
async function analyze(symbol, quote, news) {
  if (!DEEPSEEK_BASE || !DEEPSEEK_KEY) {
    throw new Error('Missing DeepSeek configuration (DEEPSEEK_API_BASE_URL / DEEPSEEK_API_KEY).');
  }
  const prompt = `
You are Bridgewater’s CEO Nir Bar Dea.
Based on the latest price and these headlines for ${symbol}, should we BUY, SELL, or SHORT? Explain why.

Latest Bar: ${JSON.stringify(quote)}
Headlines:
${news.slice(0,5).map((a,i) => `${i+1}. ${a.title}`).join("\n")}
`;

  try {
    const { data } = await axios.post(
      `${DEEPSEEK_BASE}/completions`,
      {
        model: 'v1',           // on free-tier use v1
        prompt,
        max_tokens: 150,
        temperature: 0.7
      },
      {
        headers: {
          Authorization: `Bearer ${DEEPSEEK_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    return data.choices?.[0]?.text?.trim() || '';
  } catch (err) {
    console.error('DeepSeek API error:', err.response?.data || err.message);
    throw new Error(
      'AI analysis failed: ' +
      (err.response?.data?.error?.message || err.message)
    );
  }
}

module.exports = { analyze };
