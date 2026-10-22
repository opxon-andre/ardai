import fs from 'node:fs';
import { spawn } from 'node:child_process';

// A replacement loads its modules and configuration before announcing readiness.
// It reads mutable state only after its predecessor has exited and released locks.
export function receiveReload() {
  if (process.env.ARDAI_RELOAD !== '1' || !process.send) return null;
  delete process.env.ARDAI_RELOAD;
  return new Promise((resolve) => {
    let context;
    const timer = setTimeout(() => process.exit(1), 30_000);
    process.on('message', (message) => {
      if (message?.type === 'reload-continue') context = message.context;
    });
    process.once('disconnect', () => {
      clearTimeout(timer);
      if (!context) process.exit(1);
      resolve(context);
    });
    process.send({ type: 'reload-ready' });
  });
}

export async function prepareReload({ script, args, cwd, env = process.env, logFile, context, onError = console.error }) {
  const out = fs.openSync(logFile, 'a');
  let child;
  try {
    child = spawn(process.execPath, [script, ...args], {
      cwd, env: { ...env, ARDAI_RELOAD: '1' }, detached: true,
      stdio: ['ignore', out, out, 'ipc'], windowsHide: true,
    });
  } finally { fs.closeSync(out); }
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => fail(new Error('Reload timed out; see ' + logFile)), 15_000);
    const cleanup = () => { clearTimeout(timer); child.off('error', fail); child.off('exit', exited); child.off('message', ready); };
    const fail = (error) => { cleanup(); child.kill(); reject(error); };
    const exited = (code) => fail(new Error(`Reload failed (${code}); see ${logFile}`));
    const ready = (message) => { if (message?.type === 'reload-ready') { cleanup(); resolve(); } };
    child.once('error', fail);
    child.once('exit', exited);
    child.on('message', ready);
  });
  const restart = () => {
    child.send({ type: 'reload-continue', context }, (error) => {
      if (error) { child.kill(); onError(error); return; }
      // Keep IPC connected until exit: disconnect is the successor's start signal.
      process.exit(0);
    });
  };
  restart.cancel = () => child.kill();
  return restart;
}
