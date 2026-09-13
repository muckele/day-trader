const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const image = process.env.RC_BACKEND_IMAGE;
if (!/^sha256:[a-f0-9]{64}$/.test(image || '')) throw new Error('RC_BACKEND_IMAGE must be a verified immutable local image ID');
test('backend image contains the supported runtime closure without build tools', () => {
  const probe = String.raw`
const assert=require('node:assert/strict'),fs=require('node:fs'),dns=require('node:dns').promises;
(async()=>{
for(const p of ['/usr/local/lib/node_modules/npm','/usr/local/bin/npm','/usr/local/bin/npx','/usr/local/bin/corepack','/opt/yarn','/usr/bin/perl','/bin/sh','/usr/bin/apt','/usr/bin/dpkg','/usr/bin/mount','/usr/bin/nsenter','/app/tests','/app/integration','/app/Dockerfile','/app/.env','/app/.npmrc'])assert.equal(fs.existsSync(p),false,'Unexpected production content: '+p);
assert.equal(process.version,'v24.21.0');assert.equal(process.getuid(),1000);
const manifest=JSON.parse(fs.readFileSync('/usr/share/day-trader/runtime-provenance.json'));assert.equal(manifest.node,process.version);assert.deepEqual(manifest.nativeAddons,[]);
for(const p of ['/etc/ssl/certs/ca-certificates.crt','/usr/share/zoneinfo/America/New_York','/etc/nsswitch.conf','/etc/hosts','/etc/resolv.conf'])assert.ok(fs.statSync(p).size>0,p);
assert.equal(fs.statSync('/tmp').mode&0o7777,0o1777);
assert.ok(fs.readFileSync('/etc/ssl/certs/ca-certificates.crt','utf8').includes('BEGIN CERTIFICATE'));
const winter=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'numeric',hourCycle:'h23'}).format(new Date('2026-01-01T12:00:00Z'));
const summer=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'numeric',hourCycle:'h23'}).format(new Date('2026-07-01T12:00:00Z'));
assert.equal(winter,'07');assert.equal(summer,'08');
const resolved=await dns.lookup('localhost');assert.ok(['127.0.0.1','::1'].includes(resolved.address));
const dependencies=Object.keys(require('/app/package.json').dependencies);for(const name of dependencies)require('/app/node_modules/'+name);
const hash=await require('/app/node_modules/bcryptjs').hash('local-image-check',4);assert.equal(await require('/app/node_modules/bcryptjs').compare('local-image-check',hash),true);
console.log(JSON.stringify({node:process.version,components:process.versions,uid:process.getuid(),dependencies,dns:resolved,timezone:{winter,summer},packageProvenance:manifest.packages,removedToolsVerified:true}));
})().catch(e=>{console.error(e);process.exitCode=1});`;
  const args = ['run','--rm','--read-only','--network','none','--entrypoint','/usr/local/bin/node',image,'-e',probe];
  const result = spawnSync('docker', args, { encoding:'utf8', timeout:60000 });
  assert.equal(result.status,0,result.stderr || result.error?.message);
  const proof = JSON.parse(result.stdout);assert.equal(proof.removedToolsVerified,true);
  console.log(JSON.stringify(proof));
});
