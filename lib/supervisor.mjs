import { spawn } from 'node:child_process';

export function receiveSupervisedStart() {
  return new Promise((resolve) => {
    const start = (message) => {
      if (message?.type !== 'supervisor-start') return;
      process.off('message', start);
      resolve(message.context);
    };
    process.on('message', start);
    process.send({ type: 'supervisor-ready' });
  });
}

export async function prepareSupervisedReload(context) {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error('Container reload timed out')), 20_000);
    const done = (error) => {
      clearTimeout(timer); process.off('message', message);
      error ? reject(error) : resolve();
    };
    const message = (value) => {
      if (value?.type === 'supervisor-prepared') done();
      if (value?.type === 'supervisor-error') done(new Error(value.message));
    };
    process.on('message', message);
    process.send({ type: 'supervisor-prepare', context });
  });
  const restart = () => process.send({ type: 'supervisor-commit' }, (error) => {
    if (error) throw error;
    process.exit(0);
  });
  restart.cancel = () => process.send({ type: 'supervisor-cancel' });
  return restart;
}

// Keep a stable container main process while ardai hands off to fresh code.
// The candidate validates imports/config before the current process exits.
export async function supervise({ script, args, cwd = process.cwd(), env = process.env }) {
  let current, candidate, context, committed = false, preparing = false, stopping = false;
  const send = (child, value) => { if (child?.connected) child.send(value, () => {}); };
  const start = (child, value) => { current = child; send(child, { type: 'supervisor-start', context: value }); };
  function create() {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, ...args], {
        cwd, env: { ...env, ARDAI_SUPERVISED: '1' }, stdio: ['inherit', 'inherit', 'inherit', 'ipc'], windowsHide: true,
      });
      let ready = false;
      const timer = setTimeout(() => { child.kill(); reject(new Error('Replacement startup timed out')); }, 15_000);
      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('message', async (message) => {
        if (message?.type === 'supervisor-ready') { ready = true; clearTimeout(timer); resolve(child); return; }
        if (child !== current || stopping) return;
        if (message?.type === 'supervisor-prepare') {
          if (preparing || candidate) { send(child, { type: 'supervisor-error', message: 'Reload already pending' }); return; }
          preparing = true;
          try {
            const replacement = await create();
            if (stopping) { replacement.kill(); return; }
            candidate = replacement; context = message.context;
            send(child, { type: 'supervisor-prepared' });
          } catch (error) { send(child, { type: 'supervisor-error', message: error.message }); }
          finally { preparing = false; }
        }
        if (message?.type === 'supervisor-cancel') { candidate?.kill(); candidate = null; }
        if (message?.type === 'supervisor-commit' && candidate) committed = true;
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (!ready) reject(new Error(`Replacement failed (${code})`));
        if (child !== current) return;
        if (!stopping && committed && candidate) {
          const replacement = candidate;
          candidate = null; committed = false;
          start(replacement, context);
        } else {
          candidate?.kill();
          process.exit(stopping ? 0 : code ?? 1);
        }
      });
    });
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    stopping = true; candidate?.kill();
    if (current) current.kill(signal); else process.exit(0);
  });
  start(await create(), {});
}
