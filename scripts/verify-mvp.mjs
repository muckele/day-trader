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

const mongoMinimums = { 'mvpPersistence.test.js':4, 'orderLifecycle.mongo.test.js':16, 'orderLifecycle.faults.test.js':9, 'orderProtection.test.js':8, 'phase3Financial.mongo.test.js':17, 'phase3Smtp.mongo.test.js':4 };
export function buildMongoChecks(files) {
  return files.filter(name => name.endsWith('.test.js')).sort().map(name => ({
    name: name === 'mvpPersistence.test.js' ? 'mongo-integration' : `mongo-${name.replace(/\.test\.js$/, '')}`,
    command: process.execPath,
    args: ['--test', `backend/integration/${name}`],
    summary: 'tap', minimumTests: mongoMinimums[name] || 1
  }));
}

export const REQUIRED_LOCAL_GATES = [
  'runtime', 'backend-install', 'frontend-install', 'verification-tests', 'backend-tests',
  'mongo-integration', 'mongo-orderLifecycle.mongo', 'mongo-orderLifecycle.faults', 'mongo-orderProtection',
  'mongo-phase3Financial.mongo', 'mongo-phase3Admission.mongo', 'mongo-phase3Smtp.mongo', 'mongo-nonOwnerAuthorization.fullstack',
  'frontend-tests', 'frontend-build', 'provider-contract', 'process-acceptance', 'browser-lifecycle', 'browser-core-screens'
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
  const ok=totalsValid&&Number.isInteger(passed)&&passed>=check.minimumTests&&failed===0&&skipped===0&&flaky===0;
  return {ok,passedTests:passed,failedTests:failed,skippedTests:skipped,flakyTests:flaky,...(!ok?{error:`Expected at least ${check.minimumTests} passing tests with no failures, skips, or flakes and a complete runner summary`}:{})};
}

export function buildReleaseChecks({backendTests,integrationFiles}) {
  const mongo = buildMongoChecks(integrationFiles);
  const needsFrontend = check => check.name.includes('.fullstack') || check.name==='mongo-phase3Admission.mongo';
  const browserMongo = mongo.filter(needsFrontend);
  const regularMongo = mongo.filter(check => !needsFrontend(check));
  return [
    { name:'runtime',command:process.execPath,args:['-e','if (process.versions.node.split(".")[0] !== "20") { console.error("Required Node 20 to match Dockerfiles; got " + process.version); process.exit(1); }'] },
    ...['backend','frontend'].map(dir=>({name:`${dir}-install`,command:'npm',args:['ci','--ignore-scripts','--no-audit','--no-fund'],cwd:path.join(root,dir)})),
    {name:'verification-tests',command:process.execPath,args:['--test','scripts/tests/verify-mvp.test.mjs'],summary:'tap',minimumTests:10},
    {name:'backend-tests',command:process.execPath,args:['--test',...backendTests.map(name=>`tests/${name}`)],cwd:path.join(root,'backend'),summary:'tap',minimumTests:369},
    ...regularMongo,
    {name:'frontend-tests',command:'npm',args:['test','--','--watchAll=false','--runInBand'],cwd:path.join(root,'frontend'),summary:'jest',minimumTests:26},
    {name:'frontend-build',command:'npm',args:['run','build'],cwd:path.join(root,'frontend')},
    ...browserMongo,
    {name:'provider-contract',command:process.execPath,args:['--test','scripts/acceptance/provider.test.cjs'],summary:'tap',minimumTests:1},
    {name:'process-acceptance',command:process.execPath,args:['--test','scripts/acceptance/process.test.cjs'],summary:'tap',minimumTests:9,timeoutMs:600000},
    ...[['browser-lifecycle','browser.spec.cjs',14],['browser-core-screens','screens.spec.cjs',8]].map(([name,file,minimumTests])=>({name,command:process.execPath,args:['frontend/node_modules/@playwright/test/cli.js','test','--config=scripts/acceptance/playwright.config.cjs',file,'--reporter=list,json'],summary:'playwright',minimumTests,timeoutMs:900000}))
  ];
}

async function main() {
  const reportDir=path.join(root,'docs/evidence/verification');
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
