const test=require('node:test'),assert=require('node:assert/strict');
const {parseRequest,VERSION}=require('../tools/policy.cjs');
const B='day-trader-backend.fly.dev',F='day-trader-frontend.fly.dev';
function go(path,method='GET',host=B,extra={}){return parseRequest({method,target:path,rawHeaders:['host',host,...Object.entries(extra).flat()]},['/static/js/main.js']);}
for(const path of ['/api/me','/api/readiness','/api/robotrader/settings','/api/robotrader/decisions?limit=25&environment=paper','/api/robotrader/decisions?environment=paper&limit=25','/api/robotrader/performance?environment=paper','/api/robotrader/audit?limit=25','/api/paper-trades/account','/api/robotrader/notifications'])test('allow '+path,()=>assert.ok(go(path)));
for(const path of ['/api/robotrader/performance?environment=live','/api/robotrader/decisions?limit=25&limit=25&environment=paper','/api/robotrader/decisions?limit=26&environment=paper','/api/me?owner=x','/api/me?','/api/%6de','/api/../api/me','//api/me','https://day-trader-backend.fly.dev/api/me','/api/recommendations','/api/robotrader/settings?x=','/api/robotrader/performance?environment[]=paper','/api/robotrader/performance?environment=%70aper'])test('deny '+path,()=>assert.equal(go(path),null));
test('canonical same query forwarded',()=>assert.equal(go('/api/robotrader/decisions?environment=paper&limit=25').target,'/api/robotrader/decisions?environment=paper&limit=25'));
test('duplicate Host rejected',()=>assert.equal(parseRequest({method:'GET',target:'/api/me',rawHeaders:['Host',B,'host',B]},[]),null));
for(const extra of [{'x-forwarded-host':'evil'},{'transfer-encoding':'chunked'},{connection:'upgrade'},{'content-length':'1'}])test('unsafe header '+Object.keys(extra),()=>assert.equal(go('/api/me','GET',B,extra),null));
test('login exact preflight',()=>assert.ok(go('/api/login','OPTIONS',B,{origin:'https://'+F,'access-control-request-method':'POST','access-control-request-headers':'content-type'})));
test('login exact origin length type',()=>assert.ok(go('/api/login','POST',B,{origin:'https://'+F,'content-type':'application/json','content-length':'20'})));
test('no economic writes',()=>assert.equal(go('/api/paper-trades/order','POST',B,{origin:'https://'+F,'content-type':'application/json','content-length':'20'}),null));
