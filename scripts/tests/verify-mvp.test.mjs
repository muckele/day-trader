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
