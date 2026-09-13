import { spawnSync } from 'node:child_process';
import { accessSync, constants, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const readJson = relative => JSON.parse(readFileSync(path.join(root, relative), 'utf8'));

function executableOnPath(name) {
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    const candidate = path.resolve(directory || '.', name);
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch { /* Continue to the next PATH entry. */ }
  }
  throw new Error(`${name} executable is missing from PATH`);
}

function output(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message || result.stderr}`);
  return result.stdout.trim();
}

try {
  const expectedNode = readFileSync(path.join(root, '.nvmrc'), 'utf8').trim();
  const backend = readJson('backend/package.json');
  const frontend = readJson('frontend/package.json');
  const expectedNpm = backend.engines.npm;
  if (backend.engines.node !== expectedNode || frontend.engines.node !== expectedNode || frontend.engines.npm !== expectedNpm) {
    throw new Error('Runtime declarations disagree between .nvmrc and package engines');
  }
  if (process.versions.node !== expectedNode) throw new Error(`Required Node ${expectedNode}; got ${process.version}`);
  const nodeExecutable = realpathSync(process.execPath);
  const nodeOnPathExecutable = executableOnPath('node');
  if (nodeOnPathExecutable !== nodeExecutable) throw new Error('Node executable on PATH differs from the verifier runtime');
  const npmExecutable = executableOnPath('npm');
  const bundledNpm = realpathSync(path.resolve(path.dirname(nodeExecutable), '../lib/node_modules/npm/bin/npm-cli.js'));
  if (npmExecutable !== bundledNpm) throw new Error('npm executable must be bundled with the verified Node distribution');
  const npmVersion = output(nodeExecutable, [npmExecutable, '--version']);
  if (npmVersion !== expectedNpm) throw new Error(`Required npm ${expectedNpm}; got ${npmVersion}`);
  console.log(JSON.stringify({
    nodeVersion: process.versions.node,
    npmVersion,
    nodeExecutable,
    nodeOnPathExecutable,
    npmExecutable,
    npmNodeExecutable: nodeExecutable,
    platform: process.platform,
    architecture: process.arch
  }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
