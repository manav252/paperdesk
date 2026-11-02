import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';

rmSync('/tmp/paperdesk-playwright-data', { recursive: true, force: true });
const runner = spawn('npx', ['playwright', 'test'], { stdio: 'inherit', env: process.env });
runner.on('exit', code => process.exit(code ?? 1));
