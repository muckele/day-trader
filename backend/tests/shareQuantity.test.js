const test=require('node:test'),assert=require('node:assert/strict');
const {fillNotionalCents,normalizeOrder}=require('../services/orderLifecycleFinancial');
test('fractional spend rounding uses exact cumulative execution economics',()=>{
 for(const [q,p,c]of [['0.5','10.00',500],['0.25','10.01',250],['0.333333333','10',333],['0.5','0.01',1],['0.499999999','0.01',0],['0.500000001','0.01',1],['1','100.01',10001]])assert.equal(fillNotionalCents(q,p),c);
});
test('whole-share opening policy preserved',()=>{
 for(const qty of [1,2,'1.000000000'])assert.equal(normalizeOrder({symbol:'AAPL',side:'buy',qty,orderType:'limit',limitPrice:10}).qty,Number(qty));
 for(const qty of ['0.5','1.000000001',0,-1])assert.throws(()=>normalizeOrder({symbol:'AAPL',side:'buy',qty,orderType:'limit',limitPrice:10}));
 assert.throws(()=>normalizeOrder({symbol:'AAPL',side:'sell',qty:'0.5',orderType:'market',reduceOnly:true}));
});
test('quantity domain preserves nine decimals and canonical equivalence without floating addition',()=>{
 const Q=require('../services/shareQuantity');
 assert.equal(Q.normalize('1.000000000'),'1');assert.equal(Q.normalize('0.500000000'),'0.5');
 assert.equal(Q.add('0.1','0.2'),'0.3');assert.equal(Q.subtract('1','0.333333333'),'0.666666667');
 assert.equal(Q.compare('17.582774','17.582774000'),0);assert.equal(Q.normalize('9007199254740991.000000001'),'9007199254740991.000000001');
 assert.equal(Q.persist('1.0'),1);assert.equal(Q.persist('0.500000000'),'0.5');
 for(const v of ['-1','NaN','Infinity','1e-9','0.0000000001','',null,{},true])assert.throws(()=>Q.normalize(v));
 assert.throws(()=>Q.subtract('0.4','0.5'));assert.throws(()=>Q.opening('0.5'));assert.equal(Q.opening('2.000'),2);
});
