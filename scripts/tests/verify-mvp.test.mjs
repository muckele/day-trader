import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTestEnvironment, runChecks, buildMongoChecks } from '../verify-mvp.mjs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('runtime gate accepts the pinned supported runtime and records Node/npm executable provenance', async () => {
  const { buildReleaseChecks } = await import('../verify-mvp.mjs');
  const gate = buildReleaseChecks({ backendTests: [], integrationFiles: [] }).find(check => check.name === 'runtime');
  const result = spawnSync(gate.command, gate.args, { encoding: 'utf8', env: process.env });
  assert.equal(result.status, 0, result.stderr);
  const proof = JSON.parse(result.stdout);
  assert.equal(proof.nodeVersion, '24.21.0');
  assert.equal(proof.npmVersion, '11.19.0');
  assert.equal(proof.nodeExecutable, proof.nodeOnPathExecutable);
  assert.equal(proof.npmNodeExecutable, proof.nodeExecutable);
});

test('runtime gate rejects a different npm executable even when its version text matches', async () => {
  const { buildReleaseChecks } = await import('../verify-mvp.mjs');
  const gate = buildReleaseChecks({ backendTests: [], integrationFiles: [] }).find(check => check.name === 'runtime');
  const directory = mkdtempSync(path.join(tmpdir(), 'day-trader-runtime-gate-'));
  try {
    writeFileSync(path.join(directory, 'npm'), '#!/bin/sh\nprintf "11.19.0\\n"\n', { mode: 0o755 });
    const result = spawnSync(gate.command, gate.args, { encoding: 'utf8', env: { ...process.env, PATH: directory + path.delimiter + process.env.PATH } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /npm executable/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('every TAP acceptance gate emits actual TAP on the supported Node runtime', async () => {
  const { buildReleaseChecks, validateAcceptanceExecution } = await import('../verify-mvp.mjs');
  const directory = mkdtempSync(path.join(tmpdir(), 'day-trader-tap-protocol-'));
  const fixture = path.join(directory, 'protocol.test.cjs');
  const scenario = 'required runtime protocol assertion';
  try {
    writeFileSync(fixture, `const test = require('node:test'); const assert = require('node:assert/strict'); test('${scenario}', () => assert.equal(2 + 2, 4));\n`);
    const gates = buildReleaseChecks({ backendTests: ['example.test.js'], integrationFiles: ['mvpPersistence.test.js', 'phase3Admission.mongo.test.js', 'rc002Exposure.mongo.test.js'] }).filter(check => check.summary === 'tap');
    for (const gate of gates) {
      // Exercise the real Node options from each gate without launching its application fixture.
      const args = [...gate.args.filter(argument => argument.startsWith('--')), fixture];
      const result = spawnSync(gate.command, args, { encoding: 'utf8', env: buildTestEnvironment(process.env) });
      assert.equal(result.status, 0, `${gate.name}: ${result.stderr}`);
      const check = { ...gate, minimumTests: 1, requiredScenarios: [scenario] };
      assert.equal(validateAcceptanceExecution(check, result.stdout).ok, true, `${gate.name}: ${result.stdout}`);
      assert.ok(gate.args.includes('--test-reporter=tap'), gate.name);
      for (const replacement of ['ok 1 - another scenario', `not ok 1 - ${scenario}`, `ok 1 - ${scenario} # SKIP`]) {
        assert.equal(validateAcceptanceExecution(check, result.stdout.replace(`ok 1 - ${scenario}`, replacement)).ok, false, `${gate.name}: ${replacement}`);
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('verification drops real credentials and scheduler activation', () => {
  const env = buildTestEnvironment({ PATH: '/bin', HOME: '/tmp', APCA_API_KEY_ID: 'real', SMTP_PASS: 'real', MONGO_URI: 'production', ROBO_SCHEDULER_DISABLED: 'false', NODE_OPTIONS: '--require evil' });
  assert.equal(env.APCA_API_KEY_ID, undefined);
  assert.equal(env.SMTP_PASS, undefined);
  assert.equal(env.MONGO_URI, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.ROBO_SCHEDULER_DISABLED, 'true');
  assert.equal(env.NODE_ENV, 'test');
});

test('verification preserves failures and continues independent checks', async () => {
  const seen = [];
  const result = await runChecks([{ name: 'bad' }, { name: 'good' }], async check => {
    seen.push(check.name);
    return { code: check.name === 'bad' ? 3 : 0 };
  });
  assert.deepEqual(seen, ['bad', 'good']);
  assert.equal(result.ok, false);
  assert.equal(result.checks[0].code, 3);
  assert.equal(result.checks[1].code, 0);
});

test('integration discovery runs each Mongo fixture in its own sequential check', async () => {
  const { buildMongoChecks } = await import('../verify-mvp.mjs');
  const checks = buildMongoChecks(['phase2Lifecycle.test.js', 'README.md', 'mvpPersistence.test.js', 'phase2Protection.test.js']);
  assert.deepEqual(checks.map(check => check.args), [
    ['--test', '--test-reporter=tap', 'backend/integration/mvpPersistence.test.js'],
    ['--test', '--test-reporter=tap', 'backend/integration/phase2Lifecycle.test.js'],
    ['--test', '--test-reporter=tap', 'backend/integration/phase2Protection.test.js']
  ]);
  assert.equal(new Set(checks.map(check => check.name)).size, 3);
});

test('complete local Phase 3 gates permit candidate status without external acceptance', async () => {
  const { buildRequiredAcceptance, assessRelease, REQUIRED_LOCAL_GATES } = await import('../verify-mvp.mjs');
  const passing = REQUIRED_LOCAL_GATES.map(name => ({name,code:0}));
  assert.ok(buildRequiredAcceptance(passing).every(item => item.status === 'VERIFIED'));
  assert.equal(assessRelease(passing).releaseCandidate,true);
  assert.equal(assessRelease(passing).status,'VERIFIED RELEASE CANDIDATE');
  assert.ok(assessRelease(passing).externalAcceptance.every(item => item.status === 'NOT RUN'));
  for (const name of REQUIRED_LOCAL_GATES) {
    assert.equal(assessRelease(passing.filter(item=>item.name!==name)).releaseCandidate,false,name);
    assert.equal(assessRelease(passing.map(item=>item.name===name?{...item,code:1}:item)).releaseCandidate,false,name);
  }
  assert.equal(assessRelease([...passing,{name:'additional-failing-check',code:2}]).releaseCandidate,false);
});

test('only explicit safe browser runtime paths survive environment scrubbing', () => {
 const env=buildTestEnvironment({PLAYWRIGHT_CHROMIUM_EXECUTABLE:'/local/chromium',PLAYWRIGHT_BROWSERS_PATH:'/local/cache',PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD:'1',SMTP_HOST:'external',OWNER_USER_ID:'owner'});
 assert.equal(env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,'/local/chromium');
 assert.equal(env.PLAYWRIGHT_BROWSERS_PATH,'/local/cache');
 assert.equal(env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD,undefined);
 assert.equal(env.OWNER_USER_ID,undefined);
 assert.equal(env.SMTP_HOST,undefined);
});

test('real process and browser-dependent acceptance run only after production frontend build', async () => {
 const {buildReleaseChecks}=await import('../verify-mvp.mjs');
 const checks=buildReleaseChecks({backendTests:['safe.test.js'],integrationFiles:['mvpPersistence.test.js','nonOwnerAuthorization.fullstack.test.js','phase3Admission.mongo.test.js','phase3Financial.mongo.test.js','phase3Smtp.mongo.test.js']});
 const build=checks.findIndex(c=>c.name==='frontend-build');
 for(const name of ['mongo-nonOwnerAuthorization.fullstack','mongo-phase3Admission.mongo','provider-contract','process-acceptance','browser-lifecycle','browser-core-screens'])assert.ok(checks.findIndex(c=>c.name===name)>build,name);
 assert.equal(checks.find(c=>c.name==='process-acceptance').minimumTests,9);
 assert.equal(checks.find(c=>c.name==='browser-lifecycle').minimumTests,14);
 assert.equal(checks.find(c=>c.name==='browser-core-screens').minimumTests,8);
});

test('acceptance rejects zero tests, omitted summaries, skipped tests and flaky browser runs', async () => {
 const {validateAcceptanceExecution}=await import('../verify-mvp.mjs');
 const nodeCheck={minimumTests:9,summary:'tap'};
 assert.equal(validateAcceptanceExecution(nodeCheck,'# tests 9\n# pass 9\n# fail 0\n# skipped 0\n# cancelled 0\n# todo 0').ok,true);
 for(const output of ['', '# tests 9\n# pass 8\n# fail 0\n# skipped 1','# tests 0\n# pass 0\n# fail 0\n# skipped 0'])assert.equal(validateAcceptanceExecution(nodeCheck,output).ok,false);
 const browser={minimumTests:6,summary:'playwright'};
 assert.equal(validateAcceptanceExecution(browser,'',{stats:{expected:6,unexpected:0,skipped:0,flaky:0}}).ok,true);
 assert.equal(validateAcceptanceExecution(browser,'',{stats:{expected:6,unexpected:0,skipped:1,flaky:0}}).ok,false);
 assert.equal(validateAcceptanceExecution(browser,'',{stats:{expected:6,unexpected:0,skipped:0,flaky:1}}).ok,false);
});

test('node acceptance requires consistent complete unique top-level TAP totals', async()=>{
 const {validateAcceptanceExecution}=await import('../verify-mvp.mjs');const check={minimumTests:9,summary:'tap'};
 for(const output of [
  '# pass 9\n# fail 0\n# skipped 0\n# cancelled 0\n# todo 0',
  '# tests 10\n# pass 9\n# fail 0\n# skipped 0\n# cancelled 1\n# todo 0',
  '# tests 10\n# pass 9\n# fail 0\n# skipped 0\n# cancelled 0\n# todo 1',
  '# tests 10\n# pass 9\n# fail 0\n# skipped 0\n# cancelled 0\n# todo 0',
  '# tests 9\n# pass 9\n# pass 0\n# fail 0\n# skipped 0\n# cancelled 0\n# todo 0'
 ])assert.equal(validateAcceptanceExecution(check,output).ok,false,output);
});

test('financial and SMTP gates cannot silently shrink to one parent test',()=>{
 const checks=buildMongoChecks(['mvpPersistence.test.js','orderLifecycle.mongo.test.js','orderLifecycle.faults.test.js','orderProtection.test.js','phase3Financial.mongo.test.js','phase3Smtp.mongo.test.js']);
 assert.deepEqual(checks.map(c=>c.minimumTests),[4,9,16,8,17,4]);
});

test('frontend release gate requires complete Jest totals without skipped tests',async()=>{
 const {validateAcceptanceExecution}=await import('../verify-mvp.mjs');const check={summary:'jest',minimumTests:26};
 assert.equal(validateAcceptanceExecution(check,'Tests:       36 passed, 36 total\n').ok,true);
 for(const output of ['', 'Tests: 1 skipped, 36 passed, 37 total\n','Tests: 1 failed, 36 passed, 37 total\n'])assert.equal(validateAcceptanceExecution(check,output).ok,false);
});

test('required RC scenario outcomes cannot be omitted or replaced by high aggregate totals', async () => {
  const { validateAcceptanceExecution } = await import('../verify-mvp.mjs');
  const check = { minimumTests: 2, summary: 'tap', requiredScenarios: ['RC-test-first', 'RC-test-second'] };
  const totals = '# tests 100\n# pass 100\n# fail 0\n# skipped 0\n# cancelled 0\n# todo 0\n';
  const complete = 'ok 1 - RC-test-first\nok 2 - RC-test-second\n';
  assert.equal(validateAcceptanceExecution(check, complete + totals).ok, true);
  for (const results of [
    'ok 1 - RC-test-first\n',
    'ok 1 - RC-test-first\nok 2 - RC-unrelated\n',
    'ok 1 - RC-test-first\nok 2 - RC-test-second # SKIP disabled\n',
    'ok 1 - RC-test-first\nnot ok 2 - RC-test-second\n',
    complete + 'ok 3 - RC-test-second\n',
    'ok 1 - RC-test-first\n# ok 2 - RC-test-second\n',
    'ok 1 - RC-test-first\nok 2 - RC-test-second # TODO later\n'
  ]) assert.equal(validateAcceptanceExecution(check, results + totals).ok, false, results);
});

test('both RC suites and every critical scenario are mandatory release requirements', async () => {
  const { buildReleaseChecks, REQUIRED_LOCAL_GATES, validateAcceptanceExecution, RC001_REQUIRED_SCENARIOS, RC002_REQUIRED_SCENARIOS } = await import('../verify-mvp.mjs');
  const checks = buildReleaseChecks({ backendTests: [], integrationFiles: ['rc002Exposure.mongo.test.js'] });
  for (const name of ['rc-dispatch', 'mongo-rc002Exposure.mongo', 'rc-exposure-process', 'rc-exit-dispatch']) {
    assert.ok(REQUIRED_LOCAL_GATES.includes(name));
    const check = checks.find(item => item.name === name);
    assert.ok(check);
    assert.ok(check.requiredScenarios.length > 0);
    const totals = '# tests 1000\n# pass 1000\n# fail 0\n# skipped 0\n# cancelled 0\n# todo 0\n';
    const records = check.requiredScenarios.map((scenario, index) => `ok ${index + 1} - ${scenario}\n`);
    assert.equal(validateAcceptanceExecution(check, records.join('') + totals).ok, true);
    for (let index = 0; index < records.length; index++) {
      assert.equal(validateAcceptanceExecution(check, records.filter((_, n) => n !== index).join('') + totals).ok, false, check.requiredScenarios[index]);
      assert.equal(validateAcceptanceExecution(check, records.map((record, n) => n === index ? record.trimEnd() + ' # SKIP omitted\n' : record).join('') + totals).ok, false);
      assert.equal(validateAcceptanceExecution(check, records.map((record, n) => n === index ? 'not ' + record : record).join('') + totals).ok, false);
    }
  }
  assert.ok(RC001_REQUIRED_SCENARIOS.includes('RC001-final-account-emergency-stop'));
  assert.ok(RC002_REQUIRED_SCENARIOS.some(name => name.startsWith('RC002-original-race:')));
});

test('verification output directory can preserve historical evidence without changing gates', async () => {
  const { resolveReportDirectory } = await import('../verify-mvp.mjs');
  assert.equal(resolveReportDirectory([], '/test/repository'), '/test/repository/docs/evidence/verification');
  assert.equal(resolveReportDirectory(['--report-dir', 'docs/evidence/rc-repair/safety-verifier'], '/test/repository'), '/test/repository/docs/evidence/rc-repair/safety-verifier');
  assert.equal(resolveReportDirectory(['--checks-only', '--report-dir', '/private/tmp/isolated-report'], '/test/repository'), '/private/tmp/isolated-report');
  assert.throws(() => resolveReportDirectory(['--report-dir'], '/test/repository'), /directory/i);
  assert.throws(() => resolveReportDirectory(['--report-dir', '--checks-only'], '/test/repository'), /directory/i);
  assert.throws(() => resolveReportDirectory(['--report-dir', 'a', '--report-dir', 'b'], '/test/repository'), /once/i);
});

test('canonical external harness is a mandatory gate with named scenario enforcement', async()=>{
 const {buildRequiredAcceptance,buildMongoChecks,validateAcceptanceExecution}=await import('../verify-mvp.mjs');
 assert.equal(buildRequiredAcceptance([]).find(x=>x.name==='mongo-externalPaperHarness.mongo')?.status,'BLOCKED');
 const gate=buildMongoChecks(['externalPaperHarness.mongo.test.js'])[0];
 assert.ok(gate.minimumTests>=21);
 assert.ok(gate.requiredScenarios.includes('closed market reads baseline, skips occupied fixture and returns PARTIAL without intent or write'));
 assert.ok(gate.requiredScenarios.includes('unattributed active order is blocked by actual canonical exposure guard'));
 assert.equal(validateAcceptanceExecution(gate,'# tests 21\n# pass 21\n# fail 0\n# skipped 0\n# cancelled 0\n# todo 0\n').ok,false);
});
test('fractional and guarded acceptance scenarios cannot be replaced by aggregate counts',async()=>{
 const v=await import('../verify-mvp.mjs');
 assert.ok(v.REQUIRED_LOCAL_GATES.includes('mongo-fractionalExecution.mongo'));
 const gate=v.buildMongoChecks(['fractionalExecution.mongo.test.js'])[0];
 for(const name of ['fractional broker fill accepted','cumulative fractional fill idempotency','partial-fill remainder cancellation','fractional exposure delayed-position coverage','fractional position coverage no double count','fractional exact reduce-only cleanup','fractional over-close rejection','no duplicate POST during fractional recovery'])assert.ok(gate.requiredScenarios.includes(name),name);
 for(const name of ['acceptance 30-minute boundary','acceptance fixture price ceiling','acceptance stale quote rejection','acceptance final quote revalidation','canonical standalone cancel and cancellation identity match','unexpected partial-fill acceptance cleanup','unexpected full-fill acceptance cleanup','acceptance mutation-budget enforcement'])assert.ok(v.EXTERNAL_PAPER_REQUIRED_SCENARIOS.includes(name),name);
 const fake='# tests 100\n# pass 100\n# fail 0\n# skipped 0\n';assert.equal(v.validateAcceptanceExecution(gate,fake).ok,false);
});

test('fractional mandatory gate rejects omission failure skipped names and malformed output',async()=>{
 const v=await import('../verify-mvp.mjs'),gate=v.buildMongoChecks(['fractionalExecution.mongo.test.js'])[0];
 const checks=v.REQUIRED_LOCAL_GATES.map(name=>({name,code:0}));assert.equal(v.assessRelease(checks).releaseCandidate,true);
 assert.equal(v.assessRelease(checks.filter(c=>c.name!==gate.name)).releaseCandidate,false);
 assert.equal(v.assessRelease(checks.map(c=>c.name===gate.name?{...c,code:1}:c)).releaseCandidate,false);
 const summary='# tests 100\n# pass 100\n# fail 0\n# skipped 0\n# cancelled 0\n# todo 0\n';
 for(const check of [gate,v.buildMongoChecks(['externalPaperHarness.mongo.test.js'])[0],v.buildReleaseChecks({backendTests:[],integrationFiles:[]}).find(c=>c.name==='backend-tests')]){
  const footer=summary.replaceAll('100',String(Math.max(100,check.minimumTests)));
  const rows=check.requiredScenarios.map((name,i)=>`ok ${i+1} - ${name}\n`);
  assert.equal(v.validateAcceptanceExecution(check,rows.join('')+footer).ok,true);
  for(let i=0;i<rows.length;i++){
   assert.equal(v.validateAcceptanceExecution(check,rows.filter((_,n)=>n!==i).join('')+footer).ok,false,check.requiredScenarios[i]);
   assert.equal(v.validateAcceptanceExecution(check,rows.map((r,n)=>n===i?r.trimEnd()+' # SKIP\n':r).join('')+footer).ok,false);
  }
  assert.equal(v.validateAcceptanceExecution(check,rows.join('')+rows[0]+footer).ok,false);
  assert.equal(v.validateAcceptanceExecution(check,rows.join('')).ok,false);
 }
});

test('guarded acceptance requires every global cancellation scenario',async()=>{
 const v=await import('../verify-mvp.mjs'),gate=v.buildMongoChecks(['externalPaperHarness.mongo.test.js'])[0];
 for(const name of ['global one-cancellation budget','second cancellation rejected before transport','uncertain cancellation consumes budget','unexpected partial fill uses at most one cancellation','full fill uses zero cancellation','no per-order cancellation reset']){
  assert.ok(gate.requiredScenarios.includes(name),name);
  const rows=gate.requiredScenarios.filter(s=>s!==name).map((s,i)=>`ok ${i+1} - ${s}\n`).join('');
  assert.equal(v.validateAcceptanceExecution(gate,rows+'# tests 1000\n# pass 1000\n# fail 0\n# skipped 0\n# cancelled 0\n# todo 0\n').ok,false);
 }
});

test('held fixture and precision safety scenarios are individually mandatory',async()=>{
 const v=await import('../verify-mvp.mjs');
 const suites=[
  [v.buildMongoChecks(['externalPaperHarness.mongo.test.js'])[0],['clean fixture preferred over held fallback','position-cap-neutral held fixture','held fixture exact baseline restoration','fractional held-fixture cleanup 0.5','fractional held-fixture cleanup 0.333333333','ambiguous baseline drift blocks cleanup: unrelated extra buy','held fixture still obeys maxPositionSize','held baseline drift at final account authorization blocks first POST']],
  [v.buildReleaseChecks({backendTests:[],integrationFiles:[]}).find(c=>c.name==='backend-tests'),['baseline-floor protection','canonical acceptance fill identity is required rather than symbol match','sub-cent bar observations supported','exact market-data range calculation','widened bounded bar lookback','five most recent valid bars selected','five-bar requirement preserved']]
 ];
 for(const [gate,names]of suites)for(const name of names){
  assert.ok(gate.requiredScenarios.includes(name),name);
  const rows=gate.requiredScenarios.filter(s=>s!==name).map((s,i)=>`ok ${i+1} - ${s}\n`).join('');
  assert.equal(v.validateAcceptanceExecution(gate,rows+'# tests 1000\n# pass 1000\n# fail 0\n# skipped 0\n# cancelled 0\n# todo 0\n').ok,false,name);
 }
});

test('clock-skew safety cases are individually mandatory',async()=>{
 const v=await import('../verify-mvp.mjs');
 const suites=[
  [v.buildReleaseChecks({backendTests:[],integrationFiles:[]}).find(x=>x.name==='backend-tests'),['31ms broker future skew accepted','maximum allowed future skew boundary','stale clock still rejected','closed market remains blocked','insufficient session time remains blocked']],
  [v.buildMongoChecks(['externalPaperHarness.mongo.test.js'])[0],['excessive future skew rejected before transport','final-dispatch skew tolerance','final-dispatch excessive future skew zero POST']]
 ];
 for(const [gate,names] of suites)for(const name of names){
  assert.ok(gate.requiredScenarios.includes(name),name);
  const rows=gate.requiredScenarios.filter(n=>n!==name).map((n,i)=>`ok ${i+1} - ${n}\n`).join('');
  assert.equal(v.validateAcceptanceExecution(gate,rows+'# tests 1000\n# pass 1000\n# fail 0\n# skipped 0\n# cancelled 0\n# todo 0\n').ok,false,name);
 }
});

test('acceptance convergence requires every named race and hard-failure scenario',async()=>{
 const v=await import('../verify-mvp.mjs'),gate=v.buildMongoChecks(['externalPaperHarness.mongo.test.js'])[0];
 const required=['position ahead of canonical fill converges','lagging order discovery converges','broker execution ahead of canonical fill remains risk-blocking but retryable','explainable holdings disagreement converges','persistent reconciliation disagreement exhausts bound','aggregate convergence deadline preserves last exposure reason','identity mismatch fails immediately: id','baseline drift fails immediately: increase exceeds order maximum','overfill fails immediately','convergence adds zero broker mutations','convergence preserves global mutation budget','fractional visibility race preserves exact execution and exhausted cancellation budget','delayed position visibility converges without weakening exposure'];
 for(const name of required)assert.ok(gate.requiredScenarios.includes(name),name);
 const tap=names=>names.map((n,i)=>`ok ${i+1} - ${n}`).join('\n')+`\n# tests ${names.length}\n# pass ${names.length}\n# fail 0\n# skipped 0\n# cancelled 0\n# todo 0\n`;
 assert.equal(v.validateAcceptanceExecution(gate,tap(gate.requiredScenarios)).ok,true);
 for(const name of required)assert.equal(v.validateAcceptanceExecution(gate,tap(gate.requiredScenarios.filter(n=>n!==name))).ok,false,name);
});

test('targeted SMTP gate requires each notification scenario and cannot be omitted', async () => {
  const { SMTP_REQUIRED_SCENARIOS, REQUIRED_LOCAL_GATES, buildMongoChecks, validateAcceptanceExecution } = await import('../verify-mvp.mjs');
  assert.ok(SMTP_REQUIRED_SCENARIOS?.length >= 14);
  const gate = buildMongoChecks(['targetedNotification.mongo.test.js'])[0];
  assert.ok(REQUIRED_LOCAL_GATES.includes(gate.name));
  assert.deepEqual(gate.requiredScenarios, SMTP_REQUIRED_SCENARIOS);
  const output = SMTP_REQUIRED_SCENARIOS.map((s, i) => `ok ${i + 1} - ${s}`).join('\n') + `\n# tests ${SMTP_REQUIRED_SCENARIOS.length}\n# pass ${SMTP_REQUIRED_SCENARIOS.length}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`;
  assert.equal(validateAcceptanceExecution(gate, output).ok, true);
  for (const scenario of SMTP_REQUIRED_SCENARIOS) assert.equal(validateAcceptanceExecution(gate, output.replace(scenario, 'missing scenario')).ok, false);
});

test('PF001 real-nginx gate requires every scenario without skips or duplicates', async () => {
  const v = await import('../verify-mvp.mjs');
  const gate = v.buildReleaseChecks({ backendTests: [], integrationFiles: [] }).find(c => c.name === 'frontend-nginx');
  assert.ok(v.REQUIRED_LOCAL_GATES.includes(gate.name));
  assert.equal(v.PF001_REQUIRED_SCENARIOS.length, 11);
  assert.deepEqual(gate.requiredScenarios, v.PF001_REQUIRED_SCENARIOS);
  const rows = gate.requiredScenarios.map((name, i) => `ok ${i + 1} - ${name}\n`);
  const summary = '# tests 11\n# pass 11\n# fail 0\n# skipped 0\n# cancelled 0\n# todo 0\n';
  assert.equal(v.validateAcceptanceExecution(gate, rows.join('') + summary).ok, true);
  for (let i = 0; i < rows.length; i++) {
    for (const replacement of ['', rows[i].replace('ok ', 'not ok '), rows[i].trimEnd() + ' # SKIP\n', rows[i] + rows[i]]) {
      assert.equal(v.validateAcceptanceExecution(gate, rows.map((r, n) => n === i ? replacement : r).join('') + summary).ok, false);
    }
  }
  assert.equal(v.buildRequiredAcceptance([]).find(c => c.name === gate.name).status, 'BLOCKED');
});

test('startup and readiness named evidence cannot be omitted skipped duplicated or replaced by totals', async () => {
  const v = await import('../verify-mvp.mjs');
  const checks = v.buildReleaseChecks({ backendTests: ['runtimeReadiness.test.js'], integrationFiles: ['startupReadiness.mongo.test.js'] });
  for (const [name, names] of [['mongo-startupReadiness.mongo', v.STARTUP_REQUIRED_SCENARIOS], ['backend-tests', v.READINESS_REQUIRED_SCENARIOS]]) {
    const check = checks.find(c => c.name === name); assert.ok(check);
    for (const n of names) assert.ok(check.requiredScenarios.includes(n));
    const required = check.requiredScenarios;
    const records = required.map((n, i) => `ok ${i+1} - ${n}`);
    const count = Math.max(check.minimumTests, records.length);
    const summary = `\n# tests ${count}\n# pass ${count}\n# fail 0\n# skipped 0\n# cancelled 0\n# todo 0\n`;
    assert.equal(v.validateAcceptanceExecution(check, records.join('\n') + summary).ok, true);
    for (const n of names) {
      const index = required.indexOf(n);
      for (const replacement of ['', `ok 999 - ${n} # SKIP`, `not ok 999 - ${n}`, `${records[index]}\n${records[index]}`]) {
        const changed = [...records]; changed[index] = replacement;
        assert.equal(v.validateAcceptanceExecution(check, changed.join('\n') + summary).ok, false, n);
      }
    }
    assert.equal(v.validateAcceptanceExecution(check, records.join('\n')).ok, false);
  }
  assert.ok(v.REQUIRED_LOCAL_GATES.includes('mongo-startupReadiness.mongo'));
});

test('runtime verifier children deny external sockets while dependency fetch stage remains explicit', async () => {
  const { acceptanceNetworkEnvironment } = await import('../verify-mvp.mjs');
  assert.deepEqual(acceptanceNetworkEnvironment({ name: 'backend-install' }), {});
  const env = { ...buildTestEnvironment(process.env), ...acceptanceNetworkEnvironment({ name: 'backend-tests' }) };
  const child = spawnSync(process.execPath, ['-e', "const assert=require('assert');const net=require('net');assert.throws(()=>net.connect({host:'api.alpaca.markets',port:443}),/non-loopback/);"], { env, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
});
