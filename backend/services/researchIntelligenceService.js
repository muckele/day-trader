const OpenAI = require('openai');

const DISCLAIMER = 'Research intelligence is informational and based on available market data, news, and strategy rules. Trading involves risk, including possible loss of principal. Past performance does not guarantee future results.';
const DEFAULT_RESEARCH_AI_MODEL = 'gpt-4o-mini';
const MAX_CASE_ITEMS = 5;
const MAX_CHANGE_ITEMS = 6;
const MAX_CITATIONS = 12;

function getResearchAiConfig() {
  return {
    apiKey: process.env.OPENAI_API_KEY || process.env.RESEARCH_AI_API_KEY || '',
    model: process.env.RESEARCH_AI_MODEL || DEFAULT_RESEARCH_AI_MODEL,
    enabled: process.env.RESEARCH_AI_ENABLED !== 'false'
  };
}

function toDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toIso(value) {
  const date = toDate(value);
  return date ? date.toISOString() : null;
}

function normalizeSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase().replace(/[^A-Z0-9./-]/g, '');
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(the|a|an|and|or|but|to|of|for|with|on|in|as|by|from|after|over|under|amid|says|said)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(value) {
  return normalizeText(value)
    .split(' ')
    .filter(token => token.length > 2);
}

function jaccardSimilarity(left, right) {
  const a = new Set(tokenize(left));
  const b = new Set(tokenize(right));
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  a.forEach(token => {
    if (b.has(token)) intersection += 1;
  });
  return intersection / (a.size + b.size - intersection);
}

function stableId(input) {
  const source = JSON.stringify(input || {});
  let hash = 0;
  for (let index = 0; index < source.length; index += 1) {
    hash = ((hash << 5) - hash + source.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function getSourceHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (_err) {
    return null;
  }
}

function buildNewsCitation(item = {}, index = 0) {
  const publishedAt = toIso(item.publishedAt || item.createdAt);
  return {
    id: `news-${item.externalId || stableId({ headline: item.headline, publishedAt })}`,
    type: 'news',
    label: `News ${index + 1}`,
    source: item.source || getSourceHost(item.url) || 'news',
    title: item.headline || 'Untitled headline',
    url: item.url || null,
    timestamp: publishedAt
  };
}

function buildEventCitation(item = {}, index = 0) {
  const eventDate = toIso(item.eventDate || item.createdAt);
  return {
    id: `event-${item.externalId || stableId({ title: item.title, eventDate })}`,
    type: item.type || 'event',
    label: `Event ${index + 1}`,
    source: item.source || 'corporate_events',
    title: item.title || item.type || 'Corporate event',
    url: item.url || null,
    timestamp: eventDate
  };
}

function mergeSentiment(items = []) {
  const score = items.reduce((sum, item) => {
    if (item.sentiment === 'positive') return sum + 1;
    if (item.sentiment === 'negative') return sum - 1;
    return sum;
  }, 0);
  if (score > 0) return 'positive';
  if (score < 0) return 'negative';
  return 'neutral';
}

function shouldClusterTogether(cluster, item) {
  const headline = item.headline || '';
  const normalizedHeadline = normalizeText(headline);
  if (!normalizedHeadline) return false;
  const primary = normalizeText(cluster.primaryHeadline);
  if (primary && (primary.includes(normalizedHeadline) || normalizedHeadline.includes(primary))) return true;
  if (item.url && cluster.urls.has(item.url)) return true;
  const similarity = jaccardSimilarity(`${headline} ${item.summary || ''}`, `${cluster.primaryHeadline} ${cluster.summary || ''}`);
  return similarity >= 0.58;
}

function clusterNewsItems(news = []) {
  const sorted = [...(Array.isArray(news) ? news : [])]
    .filter(item => item && item.headline)
    .sort((a, b) => {
      const bTime = toDate(b.publishedAt || b.createdAt)?.getTime() || 0;
      const aTime = toDate(a.publishedAt || a.createdAt)?.getTime() || 0;
      return bTime - aTime;
    });
  const clusters = [];
  sorted.forEach((item, index) => {
    const existing = clusters.find(cluster => shouldClusterTogether(cluster, item));
    const citation = buildNewsCitation(item, index);
    if (existing) {
      existing.count += 1;
      existing.items.push(citation);
      existing.sentiments.push(item.sentiment || 'neutral');
      existing.sources = [...new Set([...existing.sources, citation.source].filter(Boolean))];
      existing.symbols = [...new Set([...existing.symbols, ...(Array.isArray(item.symbols) ? item.symbols.map(normalizeSymbol).filter(Boolean) : [])])];
      existing.urls.add(item.url);
      existing.sentiment = mergeSentiment(existing.sentiments.map(sentiment => ({ sentiment })));
      const itemTime = toDate(item.publishedAt || item.createdAt)?.getTime() || 0;
      const clusterTime = toDate(existing.latestPublishedAt)?.getTime() || 0;
      if (itemTime > clusterTime) {
        existing.primaryHeadline = item.headline;
        existing.summary = item.summary || existing.summary;
        existing.latestPublishedAt = toIso(item.publishedAt || item.createdAt);
      }
      return;
    }
    clusters.push({
      id: `cluster-${stableId({ headline: item.headline, publishedAt: item.publishedAt || item.createdAt })}`,
      primaryHeadline: item.headline,
      summary: item.summary || '',
      category: item.category || 'general',
      sentiment: item.sentiment || 'neutral',
      sentimentScore: Number(item.sentimentScore || 0),
      latestPublishedAt: toIso(item.publishedAt || item.createdAt),
      count: 1,
      sources: [citation.source].filter(Boolean),
      symbols: Array.isArray(item.symbols) ? item.symbols.map(normalizeSymbol).filter(Boolean) : [],
      sentiments: [item.sentiment || 'neutral'],
      items: [citation],
      urls: new Set(item.url ? [item.url] : [])
    });
  });

  return clusters.map(cluster => ({
    id: cluster.id,
    primaryHeadline: cluster.primaryHeadline,
    summary: cluster.summary,
    category: cluster.category,
    sentiment: cluster.sentiment,
    sentimentScore: cluster.sentimentScore,
    latestPublishedAt: cluster.latestPublishedAt,
    count: cluster.count,
    sources: cluster.sources.slice(0, 5),
    symbols: cluster.symbols.slice(0, 8),
    citations: cluster.items.slice(0, 5).map(({ sentiment, ...citation }) => citation)
  }));
}

function buildCitations(news = [], events = []) {
  return [
    ...news.slice(0, 8).map(buildNewsCitation),
    ...events.slice(0, 4).map(buildEventCitation)
  ].slice(0, MAX_CITATIONS);
}

function confidenceFromInputs({ technicals = {}, news = [], events = [], analysis = null } = {}) {
  let score = 30;
  if (Number(technicals.dataPoints || 0) >= 120) score += 20;
  if (Number.isFinite(Number(technicals.latestPrice))) score += 10;
  if (news.length >= 3) score += 15;
  if (events.length > 0) score += 10;
  if (analysis?.qualityGate?.passed || analysis?.recommendation) score += 10;
  if (technicals.trend === 'insufficient_data') score -= 15;
  const label = score >= 70 ? 'High' : (score >= 45 ? 'Medium' : 'Low');
  return {
    label,
    score: Math.max(0, Math.min(100, score)),
    rationale: label === 'High'
      ? 'Multiple data sources are available and recent enough for a structured research view.'
      : (label === 'Medium'
          ? 'Core market data is available, but some news or event context may be incomplete.'
          : 'The available data is limited, stale, or missing important context.')
  };
}

function buildWhatChangedToday({ technicals = {}, news = [], events = [] } = {}) {
  const now = Date.now();
  const lastDay = 24 * 60 * 60 * 1000;
  const items = [];
  if (Number.isFinite(Number(technicals.changePercent))) {
    items.push(`Latest daily move is ${technicals.changePercent}%.`);
  }
  news
    .filter(item => {
      const time = toDate(item.publishedAt || item.createdAt)?.getTime();
      return Number.isFinite(time) && now - time <= lastDay;
    })
    .slice(0, 3)
    .forEach(item => items.push(`News: ${item.headline}`));
  events
    .filter(item => {
      const time = toDate(item.eventDate || item.createdAt)?.getTime();
      return Number.isFinite(time) && Math.abs(now - time) <= lastDay;
    })
    .slice(0, 2)
    .forEach(item => items.push(`Event: ${item.title || item.type}`));
  return items.length ? items.slice(0, MAX_CHANGE_ITEMS) : ['No major same-day news or event changes were detected in the available providers.'];
}

function stripProfitPromises(value) {
  return String(value || '')
    .replace(/guaranteed\s+(profit|profits|return|returns|roi)/ig, 'potential outcome')
    .replace(/risk[-\s]?free/ig, 'lower-risk')
    .replace(/cannot\s+lose/ig, 'can still lose principal')
    .trim();
}

function sanitizeTextList(value, fallback = []) {
  const source = Array.isArray(value) ? value : [];
  const cleaned = source
    .map(stripProfitPromises)
    .filter(Boolean)
    .slice(0, MAX_CASE_ITEMS);
  return cleaned.length ? cleaned : fallback;
}

function sanitizeIntelligencePayload(payload = {}, fallback = {}) {
  const { model: configuredModel } = getResearchAiConfig();
  const confidence = payload.confidence && typeof payload.confidence === 'object'
    ? payload.confidence
    : {};
  const normalizedLabel = String(confidence.label || '').toLowerCase();
  const label = normalizedLabel === 'high'
    ? 'High'
    : (normalizedLabel === 'medium'
        ? 'Medium'
        : (normalizedLabel === 'low' ? 'Low' : fallback.confidence?.label || 'Low'));
  return {
    ...fallback,
    provider: payload.provider || fallback.provider || 'openai',
    model: payload.model || fallback.model || configuredModel,
    aiGenerated: Boolean(payload.aiGenerated),
    generatedAt: payload.generatedAt || new Date().toISOString(),
    summary: stripProfitPromises(payload.summary) || fallback.summary,
    bullCase: sanitizeTextList(payload.bullCase, fallback.bullCase),
    bearCase: sanitizeTextList(payload.bearCase, fallback.bearCase),
    keyRisks: sanitizeTextList(payload.keyRisks, fallback.keyRisks),
    whatChangedToday: sanitizeTextList(payload.whatChangedToday, fallback.whatChangedToday).slice(0, MAX_CHANGE_ITEMS),
    watchItems: sanitizeTextList(payload.watchItems, fallback.watchItems),
    confidence: {
      label,
      score: Number.isFinite(Number(confidence.score)) ? Math.max(0, Math.min(100, Number(confidence.score))) : fallback.confidence?.score || null,
      rationale: stripProfitPromises(confidence.rationale) || fallback.confidence?.rationale || ''
    },
    riskNote: DISCLAIMER,
    citations: Array.isArray(fallback.citations) ? fallback.citations : [],
    newsClusters: Array.isArray(fallback.newsClusters) ? fallback.newsClusters : []
  };
}

function buildFallbackResearchIntelligence({
  symbol,
  company = {},
  technicals = {},
  news = [],
  events = [],
  analysis = null,
  newsClusters = null
} = {}) {
  const clusters = newsClusters || clusterNewsItems(news);
  const positiveNews = clusters.filter(item => item.sentiment === 'positive').length;
  const negativeNews = clusters.filter(item => item.sentiment === 'negative').length;
  const trend = technicals.trend || 'insufficient_data';
  const bullCase = [];
  const bearCase = [];
  const keyRisks = [];

  if (trend === 'uptrend') bullCase.push('Moving averages are stacked in an uptrend.');
  if (trend === 'downtrend') bearCase.push('Moving averages are stacked in a downtrend.');
  if (Number(technicals.rsi14) < 35) bullCase.push('RSI is near oversold territory, which can attract mean-reversion buyers.');
  if (Number(technicals.rsi14) > 70) bearCase.push('RSI is elevated, so pullback or consolidation risk is higher.');
  if (Number(technicals.volumeRatio) > 1.5) bullCase.push('Volume is running above the 20-day average, confirming active participation.');
  if (positiveNews > negativeNews) bullCase.push('Recent clustered headlines skew positive.');
  if (negativeNews > positiveNews) bearCase.push('Recent clustered headlines skew negative.');
  if (Number(technicals.atrPercent) > 5) keyRisks.push('ATR is elevated, requiring smaller position sizing and wider stops.');
  if (!news.length) keyRisks.push('Live news coverage is limited, so catalyst context may be incomplete.');
  if (!events.length) keyRisks.push('Corporate event coverage is limited; earnings, filing, dividend, split, and insider activity may be incomplete.');

  const citations = buildCitations(news, events);
  const confidence = confidenceFromInputs({ technicals, news, events, analysis });
  const companyName = company?.name && company.name !== symbol ? `${company.name} (${symbol})` : symbol;

  return {
    symbol,
    provider: 'deterministic_fallback',
    model: null,
    aiGenerated: false,
    generatedAt: new Date().toISOString(),
    summary: [
      `${companyName} is currently in a ${String(trend).replace('_', ' ')} technical regime.`,
      Number.isFinite(Number(technicals.changePercent)) ? `Latest daily move is ${technicals.changePercent}%.` : null,
      clusters.length ? `${clusters.length} deduped news cluster${clusters.length === 1 ? '' : 's'} were reviewed.` : 'No recent provider news was available.',
      events.length ? `${events.length} normalized corporate events are available.` : 'Corporate event data is limited.',
      analysis?.recommendation ? `Existing strategy signal: ${analysis.recommendation}.` : null
    ].filter(Boolean).join(' '),
    bullCase: bullCase.length ? bullCase : ['Wait for stronger trend, volume, or catalyst confirmation.'],
    bearCase: bearCase.length ? bearCase : ['Broad-market weakness, failed breakout attempts, and surprise negative news remain the main bear-case drivers.'],
    keyRisks: keyRisks.length ? keyRisks : ['Position sizing, event gaps, and market-wide volatility remain the primary risks to monitor.'],
    whatChangedToday: buildWhatChangedToday({ technicals, news, events }),
    watchItems: [
      technicals.support20 ? `Support near ${technicals.support20}` : null,
      technicals.resistance20 ? `Resistance near ${technicals.resistance20}` : null,
      technicals.rsi14 ? `RSI 14 at ${technicals.rsi14}` : null,
      technicals.volumeRatio ? `Volume ratio ${technicals.volumeRatio}x` : null
    ].filter(Boolean),
    confidence,
    citations,
    newsClusters: clusters,
    riskNote: DISCLAIMER
  };
}

function buildPromptContext({ symbol, company, technicals, newsClusters, events, citations, analysis }) {
  return {
    symbol,
    company: {
      name: company?.name || symbol,
      exchange: company?.exchange || null,
      tradable: company?.tradable ?? null,
      fractionable: company?.fractionable ?? null,
      shortable: company?.shortable ?? null
    },
    technicals: {
      latestPrice: technicals.latestPrice,
      changePercent: technicals.changePercent,
      trend: technicals.trend,
      rsi14: technicals.rsi14,
      atrPercent: technicals.atrPercent,
      volumeRatio: technicals.volumeRatio,
      support20: technicals.support20,
      resistance20: technicals.resistance20,
      dataPoints: technicals.dataPoints
    },
    newsClusters: newsClusters.slice(0, 8).map(cluster => ({
      id: cluster.id,
      headline: cluster.primaryHeadline,
      sentiment: cluster.sentiment,
      category: cluster.category,
      count: cluster.count,
      latestPublishedAt: cluster.latestPublishedAt,
      sources: cluster.sources,
      citationIds: cluster.citations.map(item => item.id)
    })),
    events: events.slice(0, 8).map(event => ({
      id: `event-${event.externalId || stableId(event)}`,
      type: event.type,
      title: event.title,
      summary: event.summary,
      sentiment: event.sentiment,
      eventDate: toIso(event.eventDate || event.createdAt)
    })),
    citations,
    deterministicSignal: analysis?.recommendation || analysis?.setup?.bias || null
  };
}

function parseJsonContent(content) {
  const text = String(content || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_err) {
    const match = text.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
  }
}

function createOpenAiClient() {
  const { apiKey } = getResearchAiConfig();
  if (!apiKey) return null;
  return new OpenAI({ apiKey });
}

async function buildAiResearchIntelligence(context, options = {}) {
  const config = getResearchAiConfig();
  const aiClient = options.aiClient || null;
  const model = options.model || config.model;
  const client = aiClient || createOpenAiClient();
  if (!config.enabled || !client) {
    return {
      payload: null,
      providerHealth: {
        provider: 'openai_research_intelligence',
        category: 'ai',
        rank: 1,
        configured: Boolean(config.apiKey || aiClient),
        status: 'disabled',
        message: !config.enabled
          ? 'Research AI generation is disabled by RESEARCH_AI_ENABLED=false.'
          : 'Missing OPENAI_API_KEY or RESEARCH_AI_API_KEY.'
      }
    };
  }

  const startedAt = Date.now();
  const response = await client.chat.completions.create({
    model,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: [
          'You generate concise equity research intelligence for a trading dashboard.',
          'Return only valid JSON.',
          'Do not promise profit, ROI, certainty, or risk-free outcomes.',
          'Use confidence labels only: High, Medium, Low.',
          'Base claims only on supplied market data, news clusters, events, and citations.'
        ].join(' ')
      },
      {
        role: 'user',
        content: JSON.stringify({
          task: 'Create a research intelligence summary with summary, bullCase, bearCase, keyRisks, whatChangedToday, watchItems, and confidence.',
          requiredSchema: {
            summary: 'string, 2-4 sentences',
            bullCase: ['string'],
            bearCase: ['string'],
            keyRisks: ['string'],
            whatChangedToday: ['string'],
            watchItems: ['string'],
            confidence: { label: 'High|Medium|Low', score: '0-100 number', rationale: 'string' }
          },
          context
        })
      }
    ]
  });
  const content = response.choices?.[0]?.message?.content;
  const parsed = parseJsonContent(content);
  if (!parsed) {
    throw new Error('AI research intelligence returned empty or invalid JSON.');
  }
  return {
    payload: {
      ...parsed,
      provider: 'openai',
      model,
      aiGenerated: true,
      generatedAt: new Date().toISOString()
    },
    providerHealth: {
      provider: 'openai_research_intelligence',
      category: 'ai',
      rank: 1,
      configured: true,
      status: 'ok',
      latencyMs: Date.now() - startedAt,
      model,
      message: 'Generated structured research intelligence.'
    }
  };
}

async function buildResearchIntelligence(input = {}, options = {}) {
  const normalizedSymbol = normalizeSymbol(input.symbol);
  const newsClusters = input.newsClusters || clusterNewsItems(input.news || []);
  const fallback = buildFallbackResearchIntelligence({
    ...input,
    symbol: normalizedSymbol,
    newsClusters
  });
  const context = buildPromptContext({
    ...input,
    symbol: normalizedSymbol,
    newsClusters,
    citations: fallback.citations
  });

  try {
    const ai = await buildAiResearchIntelligence(context, options);
    if (!ai.payload) {
      return {
        intelligence: fallback,
        providerHealth: ai.providerHealth
      };
    }
    return {
      intelligence: sanitizeIntelligencePayload(ai.payload, fallback),
      providerHealth: ai.providerHealth
    };
  } catch (err) {
    return {
      intelligence: {
        ...fallback,
        provider: 'deterministic_fallback',
        aiGenerated: false,
        aiError: err.message
      },
      providerHealth: {
        provider: 'openai_research_intelligence',
        category: 'ai',
        rank: 1,
        configured: true,
        status: 'error',
        message: err.message
      }
    };
  }
}

module.exports = {
  DISCLAIMER,
  buildFallbackResearchIntelligence,
  buildResearchIntelligence,
  clusterNewsItems,
  confidenceFromInputs,
  sanitizeIntelligencePayload
};
