import { execFileSync, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const image = 'paperdesk-api-test:local';
const container = `paperdesk-api-test-${process.pid}`;
const port = Number(process.env.API_IMAGE_TEST_PORT ?? 3102);
let started = false;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}

try {
  execFileSync('docker', ['build', '-f', 'Dockerfile.api', '-t', image, '.'], { stdio: 'inherit', env: { ...process.env, BUILDX_GIT_INFO: '0' } });
  execFileSync('docker', [
    'run', '--detach', '--name', container, '--memory=512m', '--cpus=1', '-p', `127.0.0.1:${port}:10000`,
    '-e', 'NODE_ENV=test', '-e', 'PORT=10000', '-e', 'COMPILE_MODE=native', '-e', 'PAPERDESK_DATA=/tmp/paperdesk-api-test',
    '-e', 'MAX_COMPILE_TIMEOUT_MS=120000', '-e', 'COMPILE_MEMORY_MB=448', image,
  ], { stdio: 'inherit' });
  started = true;

  let ready = false;
  for (let i = 0; i < 120; i++) {
    ready = await fetch(`http://127.0.0.1:${port}/api/health`).then(async response => response.ok && (await response.json()).compilerReady).catch(() => false);
    if (ready) break;
    await delay(1_000);
  }
  if (!ready) {
    execFileSync('docker', ['logs', container], { stdio: 'inherit' });
    throw new Error('The API image did not become healthy with its native TeX toolchain.');
  }

  try {
    run('node', ['scripts/compile-fixtures.mjs', ...process.argv.slice(2)], { env: { ...process.env, FIXTURE_API_URL: `http://127.0.0.1:${port}` } });
  } catch (error) {
    execFileSync('docker', ['logs', container], { stdio: 'inherit' });
    throw error;
  }
} finally {
  if (started) { try { execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' }); } catch { /* already exited */ } }
  try { execFileSync('docker', ['image', 'rm', image], { stdio: 'ignore' }); } catch { /* build did not create an image */ }
}
