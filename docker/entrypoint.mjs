import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { supervise } from '../lib/supervisor.mjs';

const args = process.argv.slice(2);
if (!args.length) args.push('serve', '--no-open');
const script = fileURLToPath(new URL('../orchestrator.mjs', import.meta.url));
if (['serve', 'run', 'work'].includes(args[0])) {
  try { await supervise({ script, args }); }
  catch (error) { console.error(error.message); process.exit(1); }
} else {
  const child = spawn(process.execPath, [script, ...args], { stdio: 'inherit' });
  child.on('error', (error) => { console.error(error.message); process.exit(1); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('exit', (code) => process.exit(code ?? 1));
}
