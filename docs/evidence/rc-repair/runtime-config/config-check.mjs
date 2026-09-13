import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const root=process.cwd(), base='d620aab5e56fdf41a986734bdf516ec028889f15';
const read=p=>readFileSync(p,'utf8');
const old=p=>execFileSync('git',['show',`${base}:${p}`],{encoding:'utf8'});
const current=await import(pathToFileURL(path.join(root,'scripts/verify-mvp.mjs')));
const temporary=mkdtempSync('/private/tmp/day-trader-runtime-baseline-');
let baseline;
try { writeFileSync(path.join(temporary,'baseline.mjs'),old('scripts/verify-mvp.mjs')); baseline=await import(pathToFileURL(path.join(temporary,'baseline.mjs'))); }
finally {rmSync(temporary,{recursive:true});}
for(const key of ['REQUIRED_LOCAL_GATES','RC001_REQUIRED_SCENARIOS','RC001_EXIT_REQUIRED_SCENARIOS','RC002_REQUIRED_SCENARIOS']) assert.deepEqual(current[key],baseline[key],key);
assert.equal(current.REQUIRED_LOCAL_GATES.length,23);
assert.equal(read('.nvmrc').trim(),'24.21.0');
const engines={node:'24.21.0',npm:'11.19.0'};
const graphProof=[];
for(const dir of ['backend','frontend']) {
 for(const file of ['package.json','package-lock.json']) {
  const name=`${dir}/${file}`, value=JSON.parse(read(name)), original=JSON.parse(old(name));
  const metadata=file==='package.json'?value:value.packages[''];
  assert.deepEqual(metadata.engines,engines,name);
  delete metadata.engines;
  assert.deepEqual(value,original,`${name}: unexpected change beyond root engines`);
  graphProof.push({path:name,onlyRootEnginesChanged:true});
 }
 const docker=read(`${dir}/Dockerfile`);
 assert.match(docker,/FROM node:24\.21\.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553/);
 assert.match(docker,/RUN npm ci(?: --omit=dev)? --ignore-scripts --no-audit --no-fund/);
 const ignore=new Set(read(`${dir}/.dockerignore`).trim().split('\n'));
 for(const rule of ['.env*','**/.env*','node_modules','**/node_modules','build','**/build','.npmrc','**/.npmrc']) assert.ok(ignore.has(rule),`${dir} excludes ${rule}`);
}
assert.match(read('frontend/Dockerfile'),/FROM nginx:1\.30\.4-alpine@sha256:dc5069ad14f19660b141b21236140b91656bf89bbc3e2417c70ae650cd66104c/);
assert.match(read('.github/workflows/mvp.yml'),/node-version-file: '\.nvmrc'/);
const files=['.nvmrc','.github/workflows/mvp.yml','backend/Dockerfile','backend/.dockerignore','backend/package.json','backend/package-lock.json','frontend/Dockerfile','frontend/.dockerignore','frontend/package.json','frontend/package-lock.json','scripts/verify-runtime.mjs','scripts/verify-mvp.mjs','scripts/tests/verify-mvp.test.mjs','docs/runtime-setup.md'];
const hashes=files.map(file=>({path:file,sha256:createHash('sha256').update(readFileSync(file)).digest('hex')}));
const command=['node','scripts/verify-runtime.mjs'];
const runtime=JSON.parse(execFileSync(command[0],command.slice(1),{encoding:'utf8'}));
console.log(JSON.stringify({checkedAt:new Date().toISOString(),baseline:base,head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),runtime,mandatoryGateIds:current.REQUIRED_LOCAL_GATES,mandatoryScenarioArraysUnchanged:true,graphProof,dockerPinsAndExclusionsVerified:true,sourceFiles:hashes},null,2));
