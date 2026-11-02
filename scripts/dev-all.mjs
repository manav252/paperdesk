#!/usr/bin/env node
// Starts the whole dev stack: compile service (Docker + compiler image), API and frontend.
// Usage: npm run dev:all   (pass --no-docker to skip the compiler checks)
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const IMAGE = process.env.LATEX_DOCKER_IMAGE ?? 'paperdesk-texlive:latest';
const skipDocker = process.argv.includes('--no-docker');
const say = msg => console.log(`\x1b[36m[dev:all]\x1b[0m ${msg}`);
const warn = msg => console.log(`\x1b[33m[dev:all]\x1b[0m ${msg}`);

const dockerUp = () => spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function ensureDocker() {
  if (spawnSync('docker', ['--version'], { stdio: 'ignore' }).error) {
    warn('Docker is not installed. The editor and API will run, but Recompile needs Docker: https://docs.docker.com/get-docker/');
    return false;
  }
  if (dockerUp()) return true;
  if (process.platform === 'darwin') {
    say('Starting Docker Desktop…');
    spawnSync('open', ['-a', 'Docker'], { stdio: 'ignore' });
    for (let i = 0; i < 60 && !dockerUp(); i++) await sleep(2000);
    if (dockerUp()) return true;
  }
  warn('Docker isn’t running. Start Docker, then run “npm run compiler:build” once. The editor and API will run without compiling.');
  return false;
}

function ensureImage() {
  if (spawnSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore' }).status === 0) {
    say(`Compiler image ${IMAGE} is ready.`);
    return;
  }
  say(`Building the compiler image ${IMAGE} (first run only; downloads TeX Live, several GB)…`);
  execFileSync('docker', ['build', '-t', IMAGE, '-f', 'Dockerfile.compiler', '.'], { stdio: 'inherit' });
}

if (!skipDocker && (await ensureDocker())) ensureImage();

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
say(`PaperDesk ${version}: API on http://localhost:3001; open the editor at the “Local:” URL Vite prints below (normally http://localhost:5173).`);
const child = spawn('npx', ['concurrently', '-k', '-n', 'api,web', '-c', 'magenta,green', 'npm:server', 'npm:dev'], { stdio: 'inherit' });
const stop = () => child.kill('SIGINT');
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', code => process.exit(code ?? 0));
