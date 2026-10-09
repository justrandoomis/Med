// Runs the API server and the Vite dev server together (no extra dependency).
import { spawn } from 'node:child_process';

const procs = [
  spawn('npm', ['run', 'dev', '-w', '@medlevo/server'], { stdio: 'inherit' }),
  spawn('npm', ['run', 'dev', '-w', '@medlevo/web'], { stdio: 'inherit' }),
];
const stop = () => procs.forEach((p) => p.kill('SIGTERM'));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
procs.forEach((p) => p.on('exit', (code) => { if (code) { stop(); process.exitCode = code; } }));
