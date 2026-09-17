const test=require('node:test');
const assert=require('node:assert/strict');
const {createOrderLifecycle}=require('../services/orderLifecycleService');
const receipt=Date.parse('2026-09-17T17:36:30.562Z');
for(const [name,clock,expected] of [
 ['bounded future skew',{is_open:true,timestamp:'2026-09-17T17:36:30.593806133Z'},/Persisted spending settings/],
 ['maximum allowed future skew',{is_open:true,timestamp:'2026-09-17T17:36:31.562Z'},/Persisted spending settings/],
 ['excessive future skew',{is_open:true,timestamp:'2026-09-17T17:36:31.563Z'},/Fresh open market clock required/],
 ['stale clock',{is_open:true,timestamp:'2026-09-17T17:35:30.561Z'},/Fresh open market clock required/],
 ['malformed timestamp',{is_open:true,timestamp:'invalid'},/Fresh open market clock required/],
 ['closed market',{is_open:false,timestamp:'2026-09-17T17:36:30.593806133Z'},/Fresh open market clock required/]
]) test(`canonical admission ${name} applies shared clock safety`,async t=>{
 t.mock.method(require('../models/OrderIntent'),'findOne',async()=>null);
 // Database is outside this admission unit: rejection persistence is exercised by Mongo integration.
 t.mock.method(require('mongoose'),'startSession',async()=>{throw new Error('Unit test has no database');});
 let posts=0;
 const lifecycle=createOrderLifecycle({ownerId:'clock-owner',expectedAccountId:'clock-account',now:()=>new Date(receipt),broker:{getAccount:async()=>({id:'clock-account'}),getClock:async()=>clock,submitOrder:async()=>{posts++;throw new Error('Unexpected transport');}}});
 await assert.rejects(lifecycle.submit({userId:'clock-owner',idempotencyKey:'clock-key',orderInput:{symbol:'AAPL',side:'buy',qty:1,orderType:'limit',limitPrice:'1'}}),expected);
 assert.equal(posts,0);
});
