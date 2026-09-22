#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function buildTestEnvironment(source = process.env) {
  const env = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'SystemRoot', 'PLAYWRIGHT_CHROMIUM_EXECUTABLE', 'PLAYWRIGHT_BROWSERS_PATH']) {
    if (source[key]) env[key] = source[key];
  }
  return { ...env, CI: 'true', NODE_ENV: 'test', ROBO_SCHEDULER_DISABLED: 'true', ROBOTRADER_WORKER_DISABLED: 'true', ROBO_EMAIL_PROVIDER: 'log', BROWSER: 'none', DOTENV_CONFIG_PATH: '/dev/null' };
}

export async function runChecks(checks, execute) {
  const results = [];
  for (const check of checks) {
    try { results.push({ name: check.name, ...await execute(check) }); }
    catch (error) { results.push({ name: check.name, code: 1, error: error.message }); }
  }
  return { ok: results.every(result => result.code === 0), checks: results };
}

const mongoMinimums = { 'mvpPersistence.test.js':4, 'orderLifecycle.mongo.test.js':16, 'orderLifecycle.faults.test.js':9, 'orderProtection.test.js':8, 'phase3Financial.mongo.test.js':17, 'phase3Smtp.mongo.test.js':4, 'externalPaperHarness.mongo.test.js':24, 'fractionalExecution.mongo.test.js':24 };
export const RC001_REQUIRED_SCENARIOS = [
  'RC001-final-account-emergency-stop', 'RC001-final-account-disable',
  'RC001-final-account-lease-takeover', 'RC001-final-account-lease-expiry',
  'RC001-final-account-heartbeat-loss', 'RC001-awaited-renewal-stop',
  'RC001-awaited-renewal-reenable-generation', 'RC001-claim-before-stop-resume',
  'RC001-claim-before-stop-process-death', 'RC001-claim-before-stop-lease-takeover',
  'RC001-transmitted-acknowledge', 'RC001-transmitted-accepted500',
  'RC001-ambiguous-claim-commit', 'RC001-disable-preserves-manual-protection-reduction',
  'RC001-protection-final-account-takeover', 'RC001-protection-final-account-expiry',
  'RC001-reduction-final-account-takeover', 'RC001-reduction-final-account-expiry',
  'RC001-run-once-final-account-stop', 'RC001-legacy-control-writer-generation',
  'RC001-process-death-before-claim', 'RC001-process-death-after-acceptance-before-persistence',
  'RC001-held-post-response-stop-then-fill', 'RC001-dispatch-transaction-retry', 'RC001-dispatch-transaction-abort'
];
export const RC001_EXIT_REQUIRED_SCENARIOS = [
  'RC001-protection-cancel-final-account-takeover', 'RC001-protection-cancel-final-account-expiry',
  'RC001-close-post-final-account-takeover', 'RC001-close-post-final-account-expiry',
  'RC001-close-protection-cancel-final-account-takeover', 'RC001-close-protection-cancel-final-account-expiry',
  'RC001-close-exit-cancel-final-account-takeover', 'RC001-close-exit-cancel-final-account-expiry',
  'RC001-reducing-replacement-final-account-disable', 'RC001-reducing-replacement-final-account-emergency-stop'
];
export const RC002_REQUIRED_SCENARIOS = [
  'RC002-original-race: captured empty snapshot cannot admit a second $60 into a $100 position',
  'RC002-origin-manual-manual', 'RC002-origin-manual-robo', 'RC002-origin-robo-manual', 'RC002-origin-robo-robo',
  'RC002-lag-full', 'RC002-lag-partial', 'RC002-terminal-cancel', 'RC002-terminal-expiry',
  'RC002-headroom', 'RC002-symbol-slot', 'RC002-retry', 'RC002-replacement',
  'RC002-fill-during-cancel', 'RC002-external-conflict', 'RC002-close-headroom',
  'RC002-protection-generations', 'RC002-invalid-observation', 'RC002-incomplete-discovery',
  'RC002-bootstrap-uncovered', 'RC002-uningested-fill', 'RC002-stale-reducing-quantity',
  'RC002-reduce-while-disabled', 'RC002-emergency-supersedes-replacement'
];
export const FRACTIONAL_REQUIRED_SCENARIOS = [
  "fractional broker fill accepted",
  "cumulative fractional fill idempotency",
  "partial-fill remainder cancellation",
  "fractional exposure delayed-position coverage",
  "fractional position coverage no double count",
  "fractional exact reduce-only cleanup",
  "fractional over-close rejection",
  "fractional protection remains explicitly unprotected without a GTC fractional stop",
  "fractional cleanup rejects non-fractionable assets without rounding",
  "invalid broker cumulative quantity -0.1",
  "invalid broker cumulative quantity 1.000000001",
  "invalid broker cumulative quantity 0.0000000001",
  "invalid broker cumulative quantity bad",
  "fractional canonical Fill index collapses equivalent cumulative formatting",
  "no duplicate POST during fractional recovery",
  "fractional cumulative spending is independent of intermediate observations",
  "manual and Robo fractional opening authority cannot be spoofed",
  "manual API rejects fractional opening through the canonical lifecycle",
  "fractional partial reduction preserves the exact remaining owned position",
  "external fractional baseline retains 17.582774 without fabricating fills",
  "concurrent equivalent fractional cumulative reconciliation persists one fill",
  "conflicting fractional position coverage blocks opening risk",
  "fractional position flip and invalid reducing quantities are rejected"
];
export const QUANTITY_REQUIRED_SCENARIOS = [
  '31ms broker future skew accepted',
  'maximum allowed future skew boundary',
  'stale clock still rejected',
  'closed market remains blocked',
  'insufficient session time remains blocked',
  'baseline-floor protection',
  'baseline consistency alone cannot mint acceptance ownership',
  'canonical acceptance fill identity is required rather than symbol match',
  'sub-cent bar observations supported',
  'exact market-data range calculation',
  'widened bounded bar lookback',
  'five most recent valid bars selected',
  'five-bar requirement preserved',
  "whole-share opening policy preserved",
  "robotrader risk gate rejects simple fractional stock entries with internal risk stop",
  "robotrader risk gate rejects fractional short-opening stock orders",
  "fractional spend rounding uses exact cumulative execution economics",
  "quantity domain preserves nine decimals and canonical equivalence without floating addition",
  "acceptance mutation-budget enforcement prohibits fourth submit and duplicate cancellation",
  "acceptance fixture price ceiling and stale quote rejection"
];
export const EXTERNAL_PAPER_REQUIRED_SCENARIOS = [
  'cancellation fixture partial fill visibility converges before exact cleanup',
  'cancellation fixture full fill visibility converges before exact cleanup',
  'convergence account binding change fails before further reconciliation',
  'interrupted convergence run cannot reset mutation authority',
  'convergence deadline is not reset after cancellation observation',
  'held fixture convergence restores protected baseline',
  'convergence rejects duplicate position observations',
  'stalled database convergence returns deadline and fences late work',
  ...['filled_qty','id','client_order_id'].map(field=>'terminal all-order discovery fails closed: '+field),
  'position ahead of canonical fill converges',
  'lagging order discovery converges',
  'broker execution ahead of canonical fill remains risk-blocking but retryable',
  'explainable holdings disagreement converges',
  'persistent reconciliation disagreement exhausts bound',
  'aggregate convergence deadline preserves last exposure reason',
  ...['id','client_order_id','symbol','side','qty'].map(field=>'identity mismatch fails immediately: '+field),
  ...['foreign extra quantity','protected baseline decreased','fixture disappears','increase exceeds order maximum'].map(kind=>'baseline drift fails immediately: '+kind),
  'unattributed open order during convergence fails immediately',
  'overfill fails immediately',
  'convergence adds zero broker mutations',
  'convergence preserves global mutation budget',
  'fractional visibility race preserves exact execution and exhausted cancellation budget',
  'delayed position visibility converges without weakening exposure',

  'excessive future skew rejected before transport',
  'final-dispatch skew tolerance',
  'final-dispatch excessive future skew zero POST',
  'clean fixture preferred over held fallback',
  'position cap full blocks canonical new symbol without changing policy',
  'position-cap-neutral held fixture',
  'held fixture exact baseline restoration',
  'fractional held-fixture cleanup 0.5',
  'fractional held-fixture cleanup 0.333333333',
  'held fixture still obeys maxPositionSize',
  'canonical held add obeys total maxPositionSize without changing policy',
  'held unexpected full fill restores baseline without cancellation',
  'held fallback refuses ask over ceiling and conflicting baseline order',
  'held baseline drift at final account authorization blocks first POST',
  'held fallback skips first symbol prohibited by blockedSymbols',
  'held fallback skips first symbol prohibited by allowedSymbols',
  'held fresh market_value at final account authorization blocks first POST',
  'held fresh maxPositionSize at final account authorization blocks first POST',
  'held fresh maxTradeAmount at final account authorization blocks first POST',
  'held final authorization rejects malformed market_value: null',
  'held final authorization rejects malformed market_value: empty string',
  'held final authorization rejects malformed market_value: false',
  'held final SELL authorization rejects changed baseline floor',
  'held final SELL authorization rejects changed owned fill quantity',
  'ambiguous baseline drift blocks cleanup: unrelated extra buy',
  'ambiguous baseline drift blocks cleanup: unrelated sell',
  'ambiguous baseline drift blocks cleanup: position disappears',
  'ambiguous baseline drift blocks cleanup: wrong cumulative quantity',
  "global one-cancellation budget",
  "second cancellation rejected before transport",
  "uncertain cancellation consumes budget",
  "unexpected partial fill uses at most one cancellation",
  "full fill uses zero cancellation",
  "no per-order cancellation reset",
  "acceptance 30-minute boundary",
  "acceptance below 30 minutes makes zero mutation",
  "acceptance above 30 minutes by one millisecond",
  "acceptance fixture price ceiling",
  "acceptance exactly $250 executable fixture remains eligible",
  "acceptance stale quote rejection",
  "acceptance rejects invalid-quote",
  "acceptance rejects missing-quote",
  "acceptance rejects stale-clock",
  "acceptance rejects malformed-clock",
  "acceptance final quote revalidation",
  "cancellation fixture becoming marketable at final dispatch makes zero POST",
  "canonical standalone cancel and cancellation identity match",
  "unexpected partial-fill acceptance cleanup",
  "unexpected full-fill acceptance cleanup",
  "unexpected fractional cleanup 0.1",
  "unexpected fractional cleanup 0.333333333",
  "unexpected fractional cleanup 0.500000000",
  "partial-fill reducing timeout preserves residual exposure",
  "acceptance mutation-budget enforcement",
  "controlled acceptance performs zero live-host or external network transport",
  "live origin fails before HTTP",

  "lookup cannot replace the acknowledged broker identity",
  "closed market reads baseline, skips occupied fixture and returns PARTIAL without intent or write",
  "production closed-market admission is still rejected",
  "unattributed active order is blocked by actual canonical exposure guard",
  "open market uses canonical buy and reducing fill, restores nonempty baseline and reloads identity",
  "configuration drift blocks next request",
  "control generation changes before dispatch block the acceptance order",
  "market closure between admission and final check still blocks dispatch",
  "accepted-response uncertainty recovers stable identity without duplicate buy",
  "unfilled opening is canonically canceled with reservation released",
  "cancellation uncertainty never retries or reports clean",
  "reducing timeout is bounded and residual holding is not declared restored",
  "lookup failure stops writes and retains durable identity",
  "malformed lookup never authorizes cleanup",
  "optional request ID absence does not fabricate IDs"
];
export const SMTP_REQUIRED_SCENARIOS = [
  "SMTP custom notification event-key idempotency",
  "SMTP custom content rejects empty oversized and transport fields",
  "SMTP targeted delivery sends only requested outbox record",
  "SMTP historical pending records untouched",
  "SMTP missing recipient zero transport",
  "SMTP missing config zero transport",
  "SMTP configured recipient only no caller overrides",
  "SMTP target not found zero unrelated claim",
  "SMTP already sent target zero resend",
  "SMTP active lease blocks targeted duplicate",
  "SMTP concurrent target claim sends once",
  "SMTP provider accepted persists provider identity",
  "SMTP uncertain post-transport state is not auto-retried",
  "SMTP batch dispatcher skips uncertain record",
  "SMTP crash after transport boundary stays fenced after lease expiry",
  "SMTP generic CONN timeout after DATA is uncertain",
  "SMTP definitive pre-acceptance failure remains retryable",
  "SMTP ambiguous provider result is uncertain",
  "SMTP accepted response persistence failure cannot resend",
  "SMTP negative DATA response is definitive rejection",
  "SMTP production transport path uses only configured recipient",
  "SMTP existing deliverNext behavior preserved",
  "SMTP existing notification tick behavior preserved"
];
export function buildMongoChecks(files) {
  return files.filter(name => name.endsWith('.test.js')).sort().map(name => ({
    name: name === 'mvpPersistence.test.js' ? 'mongo-integration' : `mongo-${name.replace(/\.test\.js$/, '')}`,
    command: process.execPath,
    args: ['--test', '--test-reporter=tap', `backend/integration/${name}`],
    summary: 'tap', minimumTests: mongoMinimums[name] || 1,
    ...(name === 'targetedNotification.mongo.test.js' ? { requiredScenarios: SMTP_REQUIRED_SCENARIOS, minimumTests: SMTP_REQUIRED_SCENARIOS.length } : {}),
    ...(name === 'fractionalExecution.mongo.test.js' ? { requiredScenarios: FRACTIONAL_REQUIRED_SCENARIOS } : {}),
    ...(name === 'externalPaperHarness.mongo.test.js' ? { requiredScenarios: EXTERNAL_PAPER_REQUIRED_SCENARIOS } : {}),
    ...(name === 'rc002Exposure.mongo.test.js' ? { requiredScenarios: RC002_REQUIRED_SCENARIOS } : {})
  }));
}

export const PF001_REQUIRED_SCENARIOS = [
  "PF001 valid JavaScript MIME",
  "PF001 valid CSS MIME",
  "PF001 missing JavaScript",
  "PF001 missing CSS",
  "PF001 missing nested resource",
  "PF001 query string missing JavaScript",
  "PF001 query string missing CSS",
  "PF001 application deep and dotted routes",
  "PF001 static directories have no listing",
  "PF001 browser missing script onerror without parsing SPA",
  "PF001 nginx config and graceful shutdown"
];

export const REQUIRED_LOCAL_GATES = [
  'frontend-nginx',
  'mongo-targetedNotification.mongo', 'runtime', 'backend-install', 'frontend-install', 'verification-tests', 'backend-tests',
  'mongo-integration', 'mongo-orderLifecycle.mongo', 'mongo-orderLifecycle.faults', 'mongo-orderProtection',
  'mongo-phase3Financial.mongo', 'mongo-phase3Admission.mongo', 'mongo-phase3Smtp.mongo', 'mongo-nonOwnerAuthorization.fullstack',
  'frontend-tests', 'frontend-build', 'provider-contract', 'process-acceptance', 'browser-lifecycle', 'browser-core-screens',
  'mongo-externalPaperHarness.mongo', 'mongo-fractionalExecution.mongo', 'rc-dispatch', 'mongo-rc002Exposure.mongo', 'rc-exposure-process', 'rc-exit-dispatch'
];
export function buildRequiredAcceptance(checks) {
  return REQUIRED_LOCAL_GATES.map(name => {
    const matches = checks.filter(check => check.name === name);
    const verified = matches.length === 1 && matches[0].code === 0;
    return { name, status: verified ? 'VERIFIED' : 'BLOCKED', reason: verified ? 'Required deterministic local check executed and passed' : 'Required local check is missing, duplicated, incomplete, or failed' };
  });
}
export function assessRelease(checks) {
  const requiredAcceptance = buildRequiredAcceptance(checks);
  const releaseCandidate = checks.every(check => check.code === 0) && requiredAcceptance.every(item => item.status === 'VERIFIED');
  return {
    requiredAcceptance, releaseCandidate,
    status: releaseCandidate ? 'VERIFIED RELEASE CANDIDATE' : 'LOCAL RELEASE ACCEPTANCE INCOMPLETE',
    externalAcceptance: [
      {name:'External Alpaca paper acceptance',status:'NOT RUN',reason:'Requires explicit operator authorization; the verifier uses only the controlled local provider'},
      {name:'External SMTP inbox receipt',status:'NOT RUN',reason:'Local SMTP acceptance proves the capture boundary, not external delivery or inbox receipt'},
      {name:'Deployed-environment and operational acceptance',status:'NOT RUN',reason:'No deployment is performed by this verifier'}
    ]
  };
}

export function validateAcceptanceExecution(check, output, report) {
  if (!check.minimumTests) return {ok:true};
  let passed, failed, skipped, flaky = 0, totalsValid = true;
  if (check.summary === 'tap') {
    const number = label => {const matches=[...output.matchAll(new RegExp(`^# ${label} (\\d+)[ \t]*$`,'gm'))];return matches.length===1 ? Number(matches[0][1]) : NaN;};
    passed=number('pass');failed=number('fail');skipped=number('skipped');
    totalsValid=number('tests')===passed&&number('cancelled')===0&&number('todo')===0;
  } else if (check.summary === 'jest') {
    const line = output.replace(/\x1b\[[0-9;]*m/g, '').match(/^Tests:\s+(.+)$/m)?.[1];
    const count = (label, fallback = NaN) => { const match = line?.match(new RegExp(`(\\d+) ${label}`)); return match ? Number(match[1]) : fallback; };
    passed = count('passed'); failed = count('failed', 0); skipped = count('skipped', 0);
    if (count('total') !== passed + failed + skipped) passed = NaN;
  } else {
    passed=report?.stats?.expected;failed=report?.stats?.unexpected;skipped=report?.stats?.skipped;flaky=report?.stats?.flaky;
  }
  const requiredScenarioResults = (check.requiredScenarios || []).map(name => {
    // Actual TAP result records only: comments, diagnostics and inflated totals
    // cannot substitute for an executed assertion-bearing required scenario.
    const records = [...output.matchAll(/^\s*(not ok|ok) \d+ - (.+?)(?:\s+#\s+(SKIP|TODO)\b.*)?\s*$/gmi)]
      .filter(match => match[2] === name);
    return { name, passed: records.length === 1 && records[0][1] === 'ok' && !records[0][3] };
  });
  const scenariosValid = requiredScenarioResults.every(result => result.passed);
  const ok=scenariosValid&&totalsValid&&Number.isInteger(passed)&&passed>=check.minimumTests&&failed===0&&skipped===0&&flaky===0;
  return {ok,passedTests:passed,failedTests:failed,skippedTests:skipped,flakyTests:flaky,requiredScenarioResults,...(!ok?{error:`Expected every required scenario exactly once and at least ${check.minimumTests} passing tests with no failures, skips, or flakes and a complete runner summary`}:{})};
}

export function buildReleaseChecks({backendTests,integrationFiles}) {
  const mongo = buildMongoChecks(integrationFiles);
  const needsFrontend = check => check.name.includes('.fullstack') || check.name==='mongo-phase3Admission.mongo';
  const browserMongo = mongo.filter(needsFrontend);
  const regularMongo = mongo.filter(check => !needsFrontend(check));
  return [
    { name:'runtime',command:process.execPath,args:[path.join(root,'scripts/verify-runtime.mjs')] },
    ...['backend','frontend'].map(dir=>({name:`${dir}-install`,command:'npm',args:['ci','--ignore-scripts','--no-audit','--no-fund'],cwd:path.join(root,dir)})),
    {name:'verification-tests',command:process.execPath,args:['--test','--test-reporter=tap','scripts/tests/verify-mvp.test.mjs'],summary:'tap',minimumTests:10},
    {name:'backend-tests',command:process.execPath,args:['--test','--test-reporter=tap',...backendTests.map(name=>`tests/${name}`)],cwd:path.join(root,'backend'),summary:'tap',minimumTests:369,requiredScenarios:QUANTITY_REQUIRED_SCENARIOS},
    ...regularMongo,
    {name:'frontend-tests',command:'npm',args:['test','--','--watchAll=false','--runInBand'],cwd:path.join(root,'frontend'),summary:'jest',minimumTests:26},
    {name:'frontend-build',command:'npm',args:['run','build'],cwd:path.join(root,'frontend')},
    {name:'frontend-nginx',command:process.execPath,args:['--test','--test-reporter=tap','scripts/acceptance/pf001.test.mjs'],summary:'tap',minimumTests:PF001_REQUIRED_SCENARIOS.length,requiredScenarios:PF001_REQUIRED_SCENARIOS},
    ...browserMongo,
    {name:'provider-contract',command:process.execPath,args:['--test','--test-reporter=tap','scripts/acceptance/provider.test.cjs'],summary:'tap',minimumTests:1},
    {name:'process-acceptance',command:process.execPath,args:['--test','--test-reporter=tap','scripts/acceptance/process.test.cjs'],summary:'tap',minimumTests:9,timeoutMs:600000},
    {name:'rc-dispatch',command:process.execPath,args:['--test','--test-reporter=tap','scripts/acceptance/rcDispatch.test.cjs'],summary:'tap',minimumTests:1,requiredScenarios:RC001_REQUIRED_SCENARIOS,timeoutMs:900000},
    {name:'rc-exit-dispatch',command:process.execPath,args:['--test','--test-reporter=tap','scripts/acceptance/rcExitDispatch.test.cjs'],summary:'tap',minimumTests:1,requiredScenarios:RC001_EXIT_REQUIRED_SCENARIOS,timeoutMs:900000},
    {name:'rc-exposure-process',command:process.execPath,args:['--test','--test-reporter=tap','scripts/acceptance/rc002.process.test.cjs'],summary:'tap',minimumTests:1,requiredScenarios:['RC002-real-worker-lock-and-coverage'],timeoutMs:180000},
    ...[['browser-lifecycle','browser.spec.cjs',14],['browser-core-screens','screens.spec.cjs',8]].map(([name,file,minimumTests])=>({name,command:process.execPath,args:['frontend/node_modules/@playwright/test/cli.js','test','--config=scripts/acceptance/playwright.config.cjs',file,'--reporter=list,json'],summary:'playwright',minimumTests,timeoutMs:900000}))
  ];
}

export function resolveReportDirectory(args = process.argv.slice(2), repositoryRoot = root) {
  const positions = args.flatMap((argument, index) => argument === '--report-dir' ? [index] : []);
  if (positions.length > 1) throw new Error('--report-dir may be specified only once.');
  if (!positions.length) return path.join(repositoryRoot, 'docs/evidence/verification');
  const directory = args[positions[0] + 1];
  if (!directory || directory.startsWith('--')) throw new Error('--report-dir requires a directory.');
  return path.resolve(repositoryRoot, directory);
}

async function main() {
  const reportDir=resolveReportDirectory();
  await mkdir(reportDir,{recursive:true});
  const env=buildTestEnvironment();
  const backendTests=(await readdir(path.join(root,'backend/tests'))).filter(name=>name.endsWith('.test.js'));
  const checks=buildReleaseChecks({backendTests,integrationFiles:await readdir(path.join(root,'backend/integration'))});
  const result=await runChecks(checks,async check=>{
    const jsonReport=path.join(reportDir,`${check.name}.json`);
    if(check.summary==='playwright')await rm(jsonReport,{force:true});
    return new Promise(resolve=>{
      const start=Date.now();
      const child=spawn(check.command,check.args,{cwd:check.cwd||root,detached:process.platform!=='win32',env:{...env,...(check.summary==='playwright'?{PLAYWRIGHT_JSON_OUTPUT_NAME:jsonReport}:{})},stdio:['ignore','pipe','pipe']});
      let output='',timedOut=false,killTimer;
      child.stdout.on('data',data=>{output+=data;});child.stderr.on('data',data=>{output+=data;});child.on('error',error=>{output+=error.message;});
      const terminate=signal=>{try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,signal);else child.kill(signal);}catch{}};
      const timer=setTimeout(()=>{timedOut=true;terminate('SIGTERM');killTimer=setTimeout(()=>terminate('SIGKILL'),5000);},check.timeoutMs||300000);
      child.on('close',async(code,signal)=>{
        clearTimeout(timer);clearTimeout(killTimer);
        const log=path.join(reportDir,`${check.name}.log`);
        try {
          let report;
          if(check.summary==='playwright'){try{report=JSON.parse(await readFile(jsonReport,'utf8'));}catch{}}
          const validation=validateAcceptanceExecution(check,output,report);
          const finalCode=code===0&&!timedOut&&validation.ok?0:code||1;
          if(!validation.ok)output+=`\nAcceptance summary rejected: ${validation.error}\n`;
          await writeFile(log,output);
          console.log(`${check.name}: ${finalCode===0?'PASS':'FAIL'} (${Date.now()-start}ms) ${log}`);
          resolve({code:finalCode,processCode:code,signal,timedOut,durationMs:Date.now()-start,command:[check.command,...check.args],log,...validation});
        }catch(error){resolve({code:1,error:error.message,log});}
      });
    });
  });
  Object.assign(result,assessRelease(result.checks),{generatedAt:new Date().toISOString(),runtime:process.version,deterministicChecksPass:result.ok});
  await writeFile(path.join(reportDir,'report.json'),JSON.stringify(result,null,2)+'\n');
  await writeFile(path.join(reportDir,'report.md'),`# MVP verification\n\nRuntime: ${process.version}\n\n${result.checks.map(check=>`- ${check.name}: ${check.code===0?'PASS':'FAIL'} (exit ${check.code})`).join('\n')}\n\n${result.requiredAcceptance.map(item=>`- ${item.name}: ${item.status} — ${item.reason}`).join('\n')}\n\nLocal status: **${result.status}**\n\n${result.externalAcceptance.map(item=>`- ${item.name}: ${item.status} — ${item.reason}`).join('\n')}\n\nThis verifier does not claim DEPLOYED PAPER MVP VERIFIED. Live trading remains disabled.\n`);
  // --checks-only no longer weakens the release gate; all local requirements apply.
  process.exitCode=result.releaseCandidate?0:1;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
