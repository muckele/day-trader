// Independent fixed-point fixture arithmetic; do not mirror the production utility.
const shareScale=1000000000n;
const shareUnits=x=>{const [a,b='']=String(x).split('.');return BigInt(a)*shareScale+BigInt(b.padEnd(9,'0'));};
const shareText=x=>{const f=String(x%shareScale).padStart(9,'0').replace(/0+$/,'');return String(x/shareScale)+(f?'.'+f:'');};
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const terminal = new Set(['filled', 'canceled', 'rejected', 'expired', 'replaced']);
function createProvider() {
  let state;
  let pendingHolds = [];
  const releaseHolds = () => { for (const release of pendingHolds) release(); pendingHolds = []; };
  const reset = () => state = { account: { id: 'acceptance-paper', status: 'ACTIVE', cash: '10000.00', equity: '10000.00', last_equity: '10000.00', buying_power: '10000.00', trading_blocked: false, account_blocked: false }, orders: [], posts: [], positions: [], mode: 'acknowledge', marketOpen: true, unavailable: false, requests: [] };
  reset();
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    let data = {}; try { data = body ? JSON.parse(body) : {}; } catch { res.writeHead(400); return res.end(); }
    const url = new URL(req.url, 'http://localhost');
    const reply = (value, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (url.pathname === '/control' && req.method === 'POST') {
      if (data.reset) { releaseHolds(); reset(); }
      if (data.releaseHold) releaseHolds();
      if (data.patch) Object.assign(state, data.patch);
      if (data.orderStatus) { const order = state.orders.find(o => o.id === data.orderStatus.id); if (!order) return reply({error:'unknown order'},404); order.status = data.orderStatus.status; }
      if (data.fill) {
        const order = state.orders.find(o => o.id === data.fill.id);
        if (!order) return reply({error:'unknown order'},404);
        const oldQty = shareUnits(order.filled_qty); const qty = shareUnits(data.fill.qty); const price = Number(data.fill.price || order.limit_price || 100);
        Object.assign(order, { filled_qty: shareText(qty), filled_avg_price: String(price), status: qty === shareUnits(order.qty) ? 'filled' : 'partially_filled', updated_at: new Date().toISOString(), filled_at: new Date().toISOString() });
        const change = qty - oldQty; const signed = order.side === 'buy' ? change : -change;
        let position = state.positions.find(p => p.symbol === order.symbol);
        if (!position) { position = {symbol:order.symbol,qty:'0',avg_entry_price:String(price),current_price:String(price),market_value:'0',unrealized_pl:'0'}; state.positions.push(position); }
        position.qty = shareText(shareUnits(position.qty) + signed); position.market_value = String(Number(position.qty) * price);
        state.positions = state.positions.filter(p => shareUnits(p.qty) > 0n);
        state.account.cash = (Number(state.account.cash) - Number(shareText(signed<0n?-signed:signed)) * (signed<0n?-1:1) * price).toFixed(2);
      }
      return reply(state);
    }
    if (url.pathname === '/control') return reply(state);
    state.requests.push({method:req.method,path:url.pathname,host:req.headers['x-provider-host']});
    if (state.holdPath && req.method === 'GET' && url.pathname.includes(state.holdPath)) {
      state.holdSeen = (state.holdSeen || 0) + 1;
      if (state.holdSeen === (state.holdOccurrence || 1)) {
        state.held = { path: url.pathname, occurrence: state.holdSeen };
        await new Promise(resolve => pendingHolds.push(resolve));
        state.held = null;
      }
    }
    if (state.unavailable) return reply({message:'Controlled provider unavailable'},503);
    if (url.pathname === '/v2/account') return reply({...state.account,updated_at:new Date().toISOString()});
    if (url.pathname === '/v2/clock') return reply({is_open:state.marketOpen,timestamp:new Date().toISOString(),next_close:new Date(Date.now()+3600000).toISOString(),next_open:new Date(Date.now()+86400000).toISOString()});
    if (url.pathname.startsWith('/v2/assets/')) return reply({id:'asset-'+url.pathname.split('/').pop(),symbol:url.pathname.split('/').pop(),name:'Acceptance equity',class:'us_equity',status:'active',tradable:true,marginable:false,shortable:false,fractionable:false});
    if (url.pathname === '/v2/positions') return reply(state.positions.map(p => ({...p,qty_available:shareText([shareUnits(p.qty)-state.orders.filter(o=>o.symbol===p.symbol&&o.side==='sell'&&!terminal.has(o.status)).reduce((s,o)=>s+shareUnits(o.qty)-shareUnits(o.filled_qty),0n),0n].reduce((a,b)=>a>b?a:b))})));
    if (url.pathname === '/v2/account/portfolio/history') return reply({timestamp:[Math.floor(Date.now()/1000)],equity:[Number(state.account.equity)]});
    if (url.pathname === '/v2/orders' && req.method === 'POST') {
      state.posts.push(data);
      if (state.mode === 'reject') return reply({message:'Controlled order rejection'},422);
      if (state.orders.some(o=>o.client_order_id===data.client_order_id)) return reply({message:'Duplicate client identity'},422);
      const order = {...data,id:randomUUID(),status:'new',filled_qty:'0',filled_avg_price:null,submitted_at:new Date().toISOString(),created_at:new Date().toISOString(),updated_at:new Date().toISOString()};
      state.orders.push(order);
      if (state.mode === 'timeout') return req.socket.destroy();
      if (state.mode === 'accepted500') return reply({message:'Accepted response lost'},500);
      if (state.holdPostResponse) {
        state.postResponseHeld = { clientOrderId: order.client_order_id, orderId: order.id };
        await new Promise(resolve => pendingHolds.push(resolve));
        state.postResponseHeld = null;
      }
      if (state.delayAckMs) await new Promise(resolve => setTimeout(resolve, state.delayAckMs));
      return reply(order);
    }
    const visibleOrders = state.orders.filter(o => !(state.hideHeldOrder && state.postResponseHeld?.clientOrderId === o.client_order_id));
    if (url.pathname === '/v2/orders' && req.method === 'GET') return reply(visibleOrders.filter(o=>url.searchParams.get('status')!=='open'||!terminal.has(o.status)));
    if (url.pathname === '/v2/orders:by_client_order_id') { const o=visibleOrders.find(o=>o.client_order_id===url.searchParams.get('client_order_id')); return reply(o||{message:'Not found'},o?200:404); }
    if (url.pathname.startsWith('/v2/orders/')) {
      const o = visibleOrders.find(o=>o.id===url.pathname.split('/').pop()); if (!o) return reply({message:'Not found'},404);
      if(req.method==='DELETE'){if(state.cancelUncertain)return req.socket.destroy();o.status='canceled';return reply({});}
      if(req.method==='PATCH'){const next={...o,...data,id:randomUUID(),status:'new',replaces:o.id};o.status='replaced';o.replaced_by=next.id;state.orders.push(next);return reply(next);}
      return reply(o);
    }
    const symbols = (url.searchParams.get('symbols') || 'AAPL,SPY,QQQ').split(',');
    if (url.pathname.includes('/quotes/latest')) return reply({quotes:state.emptyMarketData ? {} : Object.fromEntries(symbols.map(s=>[s,{ap:100,bp:99.99,t:new Date(Date.now()-(state.staleMarketData ? 3*86400000 : 0)).toISOString()}]))});
    if (url.pathname.endsWith('/bars')) {
      const bars=state.emptyMarketData ? [] : Array.from({length:240},(_,i)=>{const c=state.trend ? 75+i*0.1 : 100;return {t:new Date(Date.now()-(239-i)*60000-(state.staleMarketData ? 3*86400000 : 0)).toISOString(),o:c,h:c+0.1,l:c-0.1,c,v:100000,vw:c,n:100};});
      return reply({bars,next_page_token:null});
    }
    if(url.pathname.includes('/news'))return reply({news:[]});
    return reply({message:'Unimplemented controlled provider endpoint',path:url.pathname},503);
  });
  return {server,get state(){return state;},listen:()=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)))};
}
module.exports={createProvider};
