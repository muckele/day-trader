// backend/aiEngine.js
const { Configuration, OpenAIApi } = require('openai');

// Point the SDK at DeepSeek
const configuration = new Configuration({
  apiKey: process.env.DEESEEK_API_KEY,
  baseOptions: {
    baseURL: process.env.DEESEEK_API_BASE_URL,
  },
});
const deepseek = new OpenAIApi(configuration);

module.exports = {
  async analyze(symbol, quote, news) {
    const prompt = `
You are Bridgewater’s CEO Nir Bar Dea.
Based on the latest quote and headlines for ${symbol}, should we BUY, SELL, or SHORT?
Quote: ${JSON.stringify(quote)}
Top headlines: ${news.slice(0,5).map(a => a.title).join('; ')}
Explain your decision.
`;
    const resp = await deepseek.createCompletion({
      model: 'v3.1',     // ← switch to DeepSeek V3.1 here
      prompt,
      max_tokens: 150,
      temperature: 0.7,  // you can adjust this if you like
    });
    return resp.data.choices[0].text.trim();
  }
};
