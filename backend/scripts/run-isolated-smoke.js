#!/usr/bin/env node

const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const axios = require('axios');

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitFor(url, expectedStatus, child, label) {
  let lastError = null;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`${label} exited with code ${child.exitCode}`);
    try {
      const response = await axios.get(url, { timeout: 250, validateStatus: () => true });
      if (expectedStatus.includes(response.status)) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (err) {
      lastError = err;
    }
    await delay(100);
  }
  throw new Error(`${label} did not become ready: ${lastError?.message || 'unknown error'}`);
}

async function waitForTcp(port, child, label) {
  let lastError = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`${label} exited with code ${child.exitCode}`);
    try {
      await new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
          socket.destroy();
          resolve();
        });
        socket.once('error', reject);
      });
      return;
    } catch (err) {
      lastError = err;
      await delay(50);
    }
  }
  throw new Error(`${label} did not accept TCP connections: ${lastError?.message || 'unknown error'}`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    delay(5000).then(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    })
  ]);
}

async function run() {
  const mongoBinary = process.env.MONGOD_BINARY || '/usr/local/bin/mongod';
  const mongoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'paper-mvp-smoke-'));
  const mongoPort = await reservePort();
  const apiPort = await reservePort();
  const mongo = spawn(mongoBinary, [
    '--dbpath', mongoPath,
    '--bind_ip', '127.0.0.1',
    '--port', String(mongoPort),
    '--nounixsocket',
    '--quiet'
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let backend = null;
  try {
    const mongoUri = `mongodb://127.0.0.1:${mongoPort}/paper_mvp_smoke`;
    await waitForTcp(mongoPort, mongo, 'isolated mongod');

    backend = spawn(process.execPath, ['server.js'], {
      cwd: path.resolve(__dirname, '..'),
      env: {
        ...process.env,
        NODE_ENV: 'production',
        ROBOTRADER_DEPLOYMENT_ENV: 'local-smoke',
        PORT: String(apiPort),
        JWT_SECRET: 'local-smoke-secret-not-for-deployment',
        MONGO_URI: mongoUri,
        MONGO_URI_DIRECT: '',
        MONGO_PREFER_LOCAL: 'false',
        ROBO_SCHEDULER_DISABLED: 'true',
        ROBOTRADER_WORKER_DISABLED: 'true',
        ROBOTRADER_LIVE_RECONCILIATION_DISABLED: 'true',
        LIVE_TRADING_ENABLED: 'false',
        APCA_API_KEY_ID: '',
        APCA_API_SECRET_KEY: '',
        APCA_PAPER_API_KEY_ID: '',
        APCA_PAPER_API_SECRET_KEY: '',
        RELEASE_COMMIT: 'local-smoke',
        BUILD_ID: 'isolated-smoke'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let backendOutput = '';
    for (const stream of [backend.stdout, backend.stderr]) {
      stream.on('data', chunk => {
        backendOutput = `${backendOutput}${chunk}`.slice(-8000);
      });
    }
    await waitFor(`http://127.0.0.1:${apiPort}/ready`, [200], backend, 'isolated backend')
      .catch(err => {
        err.message = `${err.message}\n${backendOutput}`;
        throw err;
      });

    const smoke = spawn('npm', [
      'run', 'smoke:api', '--', '--base-url', `http://127.0.0.1:${apiPort}`
    ], {
      cwd: path.resolve(__dirname, '..'),
      env: process.env,
      stdio: 'inherit'
    });
    const exitCode = await new Promise(resolve => smoke.once('exit', resolve));
    if (exitCode !== 0) throw new Error(`smoke:api exited with code ${exitCode}`);
  } finally {
    await stopChild(backend);
    await stopChild(mongo);
    await fs.rm(mongoPath, { recursive: true, force: true });
  }
}

run().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
