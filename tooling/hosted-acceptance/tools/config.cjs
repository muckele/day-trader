'use strict';
const fs=require('fs'),crypto=require('crypto'),net=require('net');
const {VERSION,F,B}=require('./policy.cjs');
const SOURCE='852fb22d9facf4bfe0bca7f419e22ee4bfbba17f';
function globalIP(ip){if(net.isIP(ip)!==4)return false;const [a,b]=ip.split('.').map(Number);return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0||b===2||b===88)||a===198&&(b===18||b===19||b===51)||a===203&&b===0||a===100&&b>=64&&b<=127);}
function validate(c){
 if(!c||c.version!==VERSION||c.source!==SOURCE||!['production','production-rehearsal'].includes(c.profile)||!/^dapt-[a-z0-9-]+$/.test(c.run)||!Number.isInteger(c.paperAlready)||c.paperAlready<0||c.paperAlready>48||c.paperMaximum!==60||c.dataMaximum!==60||!/^[a-f0-9]{24}$/.test(c.expectedOwner||'')||typeof c.username!=='string'||!c.username||c.username.length>100||!c.capability||c.capability.length<48)throw Error('CONFIG_REJECTED');
 const keys=['version','source','profile','run','paperAlready','paperMaximum','dataMaximum','expectedOwner','username','capability','upstreams','testCA','lock','approvedProduction','backendImage'];if(Object.keys(c).some(k=>!keys.includes(k)))throw Error('CONFIG_REJECTED');
 if(Object.keys(c.upstreams||{}).sort().join(',')!==[F,B].sort().join(','))throw Error('CONFIG_REJECTED');
 for(const [host,ips] of Object.entries(c.upstreams)){if(!Array.isArray(ips)||!ips.length||ips.length>8||ips.some(ip=>net.isIP(ip)!==4||(c.profile==='production'&&!globalIP(ip))||(c.profile!=='production'&&!/^172\.29\.93\./.test(ip))))throw Error('CONFIG_REJECTED');}
 if(c.profile==='production'){if(c.testCA||c.approvedProduction!==true)throw Error('PRODUCTION_ACTIVATION_REJECTED');}
 else if(c.testCA!=='/upstream-trust/ca.pem'||c.approvedProduction)throw Error('TEST_CONFIG_REJECTED');
 return c;
}
function load(){const c=validate(JSON.parse(fs.readFileSync('/config/run.json')));if(c.profile!=='production-rehearsal'||!/^sha256:[a-f0-9]{64}$/.test(c.backendImage||''))throw Error('HOSTED_REHEARSAL_ONLY');const lock=JSON.parse(fs.readFileSync('/config/lock.json'));if(lock.version!==VERSION||c.lock!==crypto.createHash('sha256').update(fs.readFileSync('/config/lock.json')).digest('hex'))throw Error('LOCK_REJECTED');for(const [p,h] of Object.entries(lock.hashes)){if(!p.startsWith('/tools/')&&!p.startsWith('/config/assets'))throw Error('LOCK_REJECTED');if(crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')!==h)throw Error('LOCK_REJECTED');}if(process.env.NODE_TLS_REJECT_UNAUTHORIZED||process.env.HTTPS_PROXY||process.env.NODE_EXTRA_CA_CERTS)throw Error('TLS_ENV_REJECTED');return c;}
module.exports={validate,load,globalIP,SOURCE};
