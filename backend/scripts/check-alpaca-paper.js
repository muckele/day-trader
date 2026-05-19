#!/usr/bin/env node

require('dotenv').config();

const axios = require('axios');
const {
  getAlpacaTradingConfig,
  isPaperTradingEndpoint
} = require('../services/alpacaTradingClient');

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exit(1);
}

function assertConfigured(config) {
  if (!config.apiKey || !config.apiSecret) {
    fail('Missing Alpaca credentials. Set APCA_API_KEY_ID and APCA_API_SECRET_KEY.');
  }
  if (!isPaperTradingEndpoint(config.baseUrl)) {
    fail('APCA_BASE_URL/ALPACA_BASE_URL must be https://paper-api.alpaca.markets for this paper-account check.');
  }
}

function summarizeAccount(account = {}) {
  return {
    status: account.status || null,
    currency: account.currency || null,
    tradingBlocked: Boolean(account.trading_blocked),
    accountBlocked: Boolean(account.account_blocked),
    transfersBlocked: Boolean(account.transfers_blocked),
    patternDayTrader: Boolean(account.pattern_day_trader)
  };
}

async function main() {
  const config = getAlpacaTradingConfig();
  assertConfigured(config);

  const headers = {
    'APCA-API-KEY-ID': config.apiKey,
    'APCA-API-SECRET-KEY': config.apiSecret
  };

  const accountRes = await axios.get(`${config.baseUrl}/v2/account`, {
    headers,
    timeout: 20000
  });
  const ordersRes = await axios.get(`${config.baseUrl}/v2/orders`, {
    headers,
    params: {
      status: 'all',
      limit: 1,
      direction: 'desc'
    },
    timeout: 20000
  });

  console.log('PASS Alpaca paper account connection');
  console.log(JSON.stringify({
    baseUrl: config.baseUrl,
    account: summarizeAccount(accountRes.data),
    recentOrdersReadable: Array.isArray(ordersRes.data),
    recentOrderCountReturned: Array.isArray(ordersRes.data) ? ordersRes.data.length : null
  }, null, 2));
}

main().catch(err => {
  const message = err?.response?.data?.message || err?.message || 'Unknown Alpaca connection error';
  fail(message);
});
