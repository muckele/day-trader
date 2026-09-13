const test=require('node:test'); const assert=require('node:assert/strict');
const {createProvider}=require('./provider.cjs');
test('controlled HTTP provider retains accepted timeout and idempotent broker identity',async()=>{
 const p=createProvider();const port=await p.listen();const base=`http://127.0.0.1:${port}`;
 try{await fetch(base+'/control',{method:'POST',body:JSON.stringify({patch:{mode:'timeout'}})});
 await assert.rejects(fetch(base+'/v2/orders',{method:'POST',body:JSON.stringify({symbol:'AAPL',side:'buy',qty:'4',type:'limit',limit_price:'100',client_order_id:'stable'})}));
 const o=await(await fetch(base+'/v2/orders:by_client_order_id?client_order_id=stable')).json();assert.equal(o.client_order_id,'stable');assert.equal(p.state.orders.length,1);
 await fetch(base+'/control',{method:'POST',body:JSON.stringify({fill:{id:o.id,qty:2,price:100}})});assert.equal(p.state.positions[0].qty,'2');assert.equal(p.state.account.cash,'9800.00');
 }finally{await new Promise(r=>p.server.close(r));}
});
