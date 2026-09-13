const fail = (message, code='ORDER_INVALID') => Object.assign(new Error(message), {code,status:400});
function cents(value, allowZero=false) {
 const text=String(value ?? '');
 if(!/^\d+(\.\d{1,2})?$/.test(text)) throw fail('Currency must be finite exact cents.');
 const [a,b='']=text.split('.'); const n=Number(a)*100+Number(b.padEnd(2,'0'));
 if(!Number.isSafeInteger(n) || n < (allowZero?0:1)) throw fail('Currency must be positive safe integer cents.');
 return n;
}
function periodKeys(now) { const d=new Date(now);const day=d.toISOString().slice(0,10); d.setUTCHours(0,0,0,0);d.setUTCDate(d.getUTCDate()-((d.getUTCDay()+6)%7));return {day,week:d.toISOString().slice(0,10),month:day.slice(0,7)}; }
function normalizeOrder(x={}) {
 const symbol=String(x.symbol||'').trim().toUpperCase(),side=x.side,qty=Number(x.qty);
 if(!/^[A-Z][A-Z0-9.]{0,14}$/.test(symbol)||!['buy','sell'].includes(side)||!Number.isSafeInteger(qty)||qty<=0)throw fail('A valid symbol, side and positive whole share quantity are required.');
 if(x.assetClass && !['equity','stocks','us_equity'].includes(x.assetClass))throw fail('Only equity orders are supported.');
 let orderType=x.orderType||x.type||'market';let limitPrice=x.limitPrice??x.limit_price;
 if(side==='buy' && orderType==='market' && x.maxPricePerShare) {orderType='limit';limitPrice=x.maxPricePerShare;}
 if(side==='buy'&&orderType!=='limit')throw fail('Entry requires an explicit price-capped limit order.');
 if(x.notional||x.extendedHours||x.extended_hours||x.orderClass&&x.orderClass!=='simple'||x.order_class&&x.order_class!=='simple'||x.legs||x.takeProfit||x.take_profit||x.stopLoss||x.stop_loss)throw fail('Unsupported native advanced order fields.');
 if(!['limit','market','stop'].includes(orderType)||x.takeProfitPrice||x.trailingStopPct||x.allowExtendedHours)throw fail('Unsupported order features.');
 const timeInForce=x.timeInForce||x.time_in_force||'day'; if(!['day','gtc'].includes(timeInForce))throw fail('Only day and gtc are supported.');
 const limitCents=orderType==='limit'?cents(limitPrice):0;
 const ceilingCents=side==='buy'?limitCents*qty:0;if(!Number.isSafeInteger(ceilingCents))throw fail('Order exceeds safe monetary precision.');
 return {symbol,side,qty,assetClass:'equity',orderType,timeInForce,limitPrice:limitCents?limitCents/100:undefined,stopPrice:orderType==='stop'?cents(x.stopPrice)/100:undefined,stopLossPrice:(x.riskStopPrice||x.stopLossPrice)?cents(x.riskStopPrice||x.stopLossPrice)/100:undefined,allowExtendedHours:false,ceilingCents};
}
function fillNotionalCents(qty,price){
 const p=String(price??''); if(!/^\d+(\.\d{1,12})?$/.test(p)||!Number.isSafeInteger(qty)||qty<0)throw fail('Invalid broker cumulative execution.');
 const [a,b='']=p.split('.');const scale=10n**BigInt(b.length);const raw=(BigInt(a)*scale+BigInt(b||'0'))*BigInt(qty)*100n;
 const result=Number((raw+scale/2n)/scale);if(!Number.isSafeInteger(result))throw fail('Broker execution exceeds monetary precision.');return result;
}
module.exports={fillNotionalCents,cents,periodKeys,normalizeOrder,fail};
