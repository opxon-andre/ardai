import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { killTree, isAlive, openBrowser, cliLaunchers } from '../lib/platform.mjs';
import { AgentRun } from '../lib/agents.mjs';

test('process termination selects taskkill or the isolated POSIX process group', () => {
  const calls = [];
  const kill = (...args) => calls.push(args);
  assert.equal(killTree(12345, { platform: 'linux', kill }), true);
  assert.deepEqual(calls, [[-12345, 'SIGKILL']]);
  assert.equal(killTree(12345, { platform: 'win32', run: (...args) => { calls.push(args); return { status: 0 }; } }), true);
  assert.deepEqual(calls[1].slice(0, 2), ['taskkill', ['/PID', '12345', '/T', '/F']]);
  for (const pid of [undefined, 0, 1, -1, '12345', NaN, process.pid]) assert.equal(killTree(pid, { kill }), false);
  assert.equal(calls.length, 2);
  const fallback = [];
  assert.equal(killTree(12345, { platform: 'linux', kill: (pid) => {
    fallback.push(pid);
    if (pid < 0) throw Object.assign(new Error(), { code: 'ESRCH' });
  } }), true);
  assert.deepEqual(fallback, [-12345, 12345]);
  assert.equal(killTree(12345, { platform: 'linux', kill: () => { throw Object.assign(new Error(), { code: 'EPERM' }); } }), false);
});

test('browser launch supports Linux desktops, headless hosts and missing launchers', () => {
  const calls = [], errors = [];
  const child = new EventEmitter();
  child.unref = () => {};
  const launch = (...args) => { calls.push(args); return child; };
  const url = 'http://127.0.0.1:4711/?t=example';
  assert.equal(openBrowser(url, { platform: 'linux', env: {}, launch }), false);
  assert.equal(calls.length, 0);
  assert.equal(openBrowser(url, { platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' }, launch, onError: (e) => errors.push(e) }), true);
  assert.deepEqual(calls[0].slice(0, 2), ['xdg-open', [url]]);
  child.emit('error', new Error('ENOENT'));
  assert.equal(errors[0].message, 'ENOENT');
  openBrowser(url, { platform: 'win32', launch });
  assert.deepEqual(calls[1].slice(0, 2), ['cmd.exe', ['/c', 'start', '""', url]]);
});

test('POSIX launchers preserve literal paths and arguments with shell metacharacters', { skip: process.platform === 'win32' }, (t) => {
  const root = fs.mkdtempSync(new URL('.platform-', import.meta.url));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, 'script with spaces \' $HOME `literal`.mjs');
  fs.writeFileSync(script, 'console.log(JSON.stringify(process.argv.slice(2)))');
  const launcher = path.join(root, 'ardai');
  fs.writeFileSync(launcher, cliLaunchers(script)[''], { mode: 0o755 });
  const args = ['with spaces', '$HOME', '"quoted"', "one'two", '`literal`', ''];
  const result = spawnSync(launcher, args, { encoding: 'utf8', cwd: root });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), args);
});

async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Process did not reach the expected state');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

for (const mode of ['stop', 'timeout', 'quota-error']) {
  test(`Linux ${mode} terminates the agent and its child process`, { skip: process.platform !== 'linux' }, async (t) => {
    const root = fs.mkdtempSync(new URL('.platform-', import.meta.url));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const marker = path.join(root, 'child.pid');
    const grandchild = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);`;
    const code = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' }); process.stdin.resume(); setInterval(() => {}, 1000);`;
    const run = new AgentRun({ name: 'test', cwd: root,
      agentCfg: { kind: 'claude', command: process.execPath, args: ['-e', code], bySize: {} },
      prompt: 'test', logFile: path.join(root, 'agent.log'), maxRunMinutes: mode === 'timeout' ? 0.025 : 1,
    });
    const result = run.start();
    let childPid;
    try {
      await until(() => fs.existsSync(marker));
      childPid = Number(fs.readFileSync(marker, 'utf8'));
      assert.ok(isAlive(childPid));
      if (mode === 'stop') assert.equal(killTree(run.pid), true);
      if (mode === 'quota-error') run.killLater(25);
      const outcome = await result;
      assert.equal(outcome.completed, false);
      assert.equal(outcome.timedOut, mode === 'timeout');
      await until(() => !isAlive(childPid));
    } finally {
      killTree(run.pid);
      if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch {} }
      await result;
    }
  });
}
