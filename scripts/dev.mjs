// Runs the API (tsx watch) and the Vite dev server together, cross-platform, without shell scripts.
import { spawn } from 'node:child_process';
const isWin = process.platform === 'win32';
const run = (args) => spawn(isWin ? 'npm.cmd' : 'npm', args, { stdio: 'inherit', shell: isWin });
const procs = [run(['run', 'dev:api']), run(['run', 'dev:web'])];
const stop = () => { for (const p of procs) p.kill(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const p of procs) p.on('exit', (code) => { if (code) { console.error(`A dev process exited with code ${code}`); stop(); } });
