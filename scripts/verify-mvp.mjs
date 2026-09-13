#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function buildTestEnvironment(source = process.env) {
  const env = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'SystemRoot']) {
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

async function main() {
  const reportDir = path.join(root, 'docs/evidence/verification');
  await mkdir(reportDir, { recursive: true });
  const env = buildTestEnvironment();
  const backendTests = (await readdir(path.join(root, 'backend/tests'))).filter(name => name.endsWith('.test.js')).map(name => `tests/${name}`);
  const checks = [
    { name: 'runtime', command: process.execPath, args: ['-e', 'if (process.versions.node.split(".")[0] !== "20") { console.error("Required Node 20 to match Dockerfiles; got " + process.version); process.exit(1); }'] },
    ...['backend', 'frontend'].map(dir => ({ name: `${dir}-install`, command: 'npm', args: ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], cwd: path.join(root, dir) })),
    { name: 'verification-tests', command: process.execPath, args: ['--test', 'scripts/tests/verify-mvp.test.mjs'] },
    { name: 'backend-tests', command: process.execPath, args: ['--test', ...backendTests], cwd: path.join(root, 'backend') },
    { name: 'mongo-integration', command: process.execPath, args: ['--test', 'backend/integration/mvpPersistence.test.js'] },
    { name: 'frontend-tests', command: 'npm', args: ['test', '--', '--watchAll=false', '--runInBand'], cwd: path.join(root, 'frontend') },
    { name: 'frontend-build', command: 'npm', args: ['run', 'build'], cwd: path.join(root, 'frontend') },
  ];
  const result = await runChecks(checks, check => new Promise(resolve => {
    const start = Date.now();
    const child = spawn(check.command, check.args, { cwd: check.cwd || root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    child.on('error', error => { output += error.message; });
    const timer = setTimeout(() => child.kill('SIGTERM'), 300_000);
    child.on('close', async (code, signal) => {
      clearTimeout(timer);
      const log = path.join(reportDir, `${check.name}.log`);
      await writeFile(log, output);
      console.log(`${check.name}: ${code === 0 ? 'PASS' : 'FAIL'} (${Date.now() - start}ms) ${log}`);
      resolve({ code: code ?? 1, signal, durationMs: Date.now() - start, command: [check.command, ...check.args], log });
    });
  }));
  // Never promote unit/build success into a release claim. These requirements have
  // no complete executable harness yet; record them as blocked rather than skips.
  result.requiredAcceptance = [
    { name: 'Mongo persistence, reservation and restart integration', status: 'BLOCKED', reason: 'Full lifecycle integration suite not implemented' },
    { name: 'Actual frontend/backend/auth/database lifecycle E2E', status: 'BLOCKED', reason: 'Existing Playwright suite mocks API responses' },
    { name: 'Fault/concurrency/protection acceptance', status: 'BLOCKED', reason: 'Complete acceptance coverage not implemented' }
  ];
  result.generatedAt = new Date().toISOString();
  result.runtime = process.version;
  result.deterministicChecksPass = result.ok;
  result.releaseCandidate = false;
  await writeFile(path.join(reportDir, 'report.json'), JSON.stringify(result, null, 2) + '\n');
  await writeFile(path.join(reportDir, 'report.md'), `# MVP verification\n\nRuntime: ${process.version}\n\n${result.checks.map(check => `- ${check.name}: ${check.code === 0 ? 'PASS' : 'FAIL'} (exit ${check.code})`).join('\n')}\n\n${result.requiredAcceptance.map(item => `- ${item.name}: ${item.status} — ${item.reason}`).join('\n')}\n\nRelease candidate: NO.\n`);
  process.exitCode = result.ok && (process.argv.includes('--checks-only') || result.requiredAcceptance.every(item => item.status === 'VERIFIED')) ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
