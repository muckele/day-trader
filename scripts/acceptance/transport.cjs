// Test-process preload only. Production destination/account validation still runs.
// Never import this from application code or enable it via a production flag.
const axios = require('../../backend/node_modules/axios/dist/node/axios.cjs');
const target = new URL(process.env.ACCEPTANCE_PROVIDER_URL || '');
if (process.env.NODE_ENV !== 'test' || target.hostname !== '127.0.0.1' || target.protocol !== 'http:' || process.env.BROKER_API_KEY !== 'acceptance-dummy') throw new Error('Isolated acceptance transport configuration required');
const adapter = axios.getAdapter('http');
const allowed = new Set(['https://paper-api.alpaca.markets', 'https://data.alpaca.markets', 'https://finnhub.io']);
axios.defaults.adapter = config => {
  const original = new URL(config.url, config.baseURL);
  if (!allowed.has(original.origin) || original.protocol !== 'https:') throw new Error('Acceptance transport blocked unexpected provider destination');
  return adapter({...config,baseURL:undefined,url:target.origin+original.pathname+original.search,proxy:false,headers:{...config.headers,'x-provider-host':original.hostname}});
};

// Controlled server wall-clock advancement exercises expiration of real issued sessions.
const actualNow=Date.now;let clockOffset=0;
Date.now=()=>actualNow()+clockOffset;
process.on('message',message=>{if(message?.type==='acceptance-clock'&&Number.isSafeInteger(message.offsetMs)){clockOffset=message.offsetMs;process.send?.({type:'acceptance-clock-set'});}});
