import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { patchTask, followUpIdentity } from '../lib/task-edits.mjs';
import { CONFIG_NAME, loadProject } from '../lib/project.mjs';
import { taskPrompt, resumePrompt } from '../lib/prompts.mjs';
import { prepareReload } from '../lib/reload.mjs';
import { familyOverage } from '../lib/agents.mjs';

const cli = fileURLToPath(new URL('../orchestrator.mjs', import.meta.url));
const agents = { claude: {}, codex: {} };
function fixture(t, config = {}) {
  const root = fs.mkdtempSync(new URL('.reliability-', import.meta.url));
  // Windows can retain the child's cwd briefly after its exit hook removes run.lock.
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(fileURLToPath(new URL('.', import.meta.url))));
    for (let attempt = 0; ; attempt++) {
      try { fs.rmSync(root, { recursive: true, force: true }); break; }
      catch (error) {
        if (!['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error.code) || attempt >= 40) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  });
  fs.writeFileSync(path.join(root, CONFIG_NAME), JSON.stringify({
    runtimeDir: 'runtime', agents: { claude: { enabled: false }, codex: { enabled: false } }, ...config,
  }));
  const runtime = path.join(root, 'runtime');
  fs.mkdirSync(runtime);
  const file = path.join(runtime, 'state.json');
  const state = {
    schemaVersion: 2, tasks: [{ id: 'ARDAI-A1', status: 'failed', domain: ['tools/'], dependsOn: [], jira: false, size: 'M' },
      { id: 'X-FIX-1', status: 'done', domain: ['src/'], jira: false }],
    agents: {}, questions: [{ id: 'Q1', taskId: 'X-FIX-1', question: 'Fix?', blocking: false }], testResults: [], nextQuestion: 2,
  };
  const write = () => fs.writeFileSync(file, JSON.stringify(state));
  write();
  return { root, runtime, file, state, write, read: () => JSON.parse(fs.readFileSync(file)) };
}
function run(root, ...args) {
  const env = { ...process.env };
  delete env.ORCHESTRATOR_CONFIG;
  return spawnSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 15000 });
}
function success(result) { assert.equal(result.status, 0, result.stderr || result.error?.message); }

test('patch applies all fields atomically, rejects cycles and protects running tasks', () => {
  const task = { id: 'A', status: 'ready', domain: ['old/'], dependsOn: ['B'] };
  const tasks = [task, { id: 'B' }, { id: 'C' }];
  assert.equal(patchTask(task, ['--epic', 'E', '--domain', '+new/', '--domain', '-old/', '--note', 'note', '--agent', 'codex', '--depends', '-B', '--depends', '+C', '--size', 'S'], tasks, agents), 'note');
  assert.deepEqual(task, { id: 'A', status: 'ready', domain: ['new/'], dependsOn: ['C'], epic: 'E', preferredAgent: 'codex', size: 'S' });
  for (const args of [['--size', 'XL'], ['--agent', 'other'], ['--depends', '+A'], ['--depends', '+missing'], ['--domain', '-new/'], ['--note'], ['--unknown', 'value'], []]) {
    const before = structuredClone(task);
    assert.throws(() => patchTask(task, args, tasks, agents));
    assert.deepEqual(task, before);
  }
  tasks[1].dependsOn = ['A'];
  assert.throws(() => patchTask(task, ['--depends', '+B'], tasks, agents), /cycle/);
  task.status = 'running';
  for (const args of [['--epic', 'F'], ['--domain', '+x/'], ['--agent', 'claude'], ['--size', 'L'], ['--depends', '-C']]) {
    assert.throws(() => patchTask(task, args, tasks, agents), /running/);
  }
  assert.equal(patchTask(task, ['--note', 'allowed'], tasks, agents), 'allowed');
});

test('paid quota uses one persisted decision for all siblings and clears their blocks', (t) => {
  const f = fixture(t);
  f.state.agents = { codex: { allowOverage: false, blockedUntil: '2099-01-01' },
    codex2: { allowOverage: true, blockedUntil: '2099-01-01' }, claude: { allowOverage: false } };
  f.write();
  const { config } = loadProject({ cwd: f.root, env: {} });
  assert.equal(familyOverage(config.agents, f.state, 'codex2'), false, 'canonical flag wins over legacy sibling differences');
  success(run(f.root, 'overage', 'codex2', 'on'));
  let state = f.read();
  for (const name of ['codex', 'codex2']) {
    assert.equal(state.agents[name].allowOverage, true);
    assert.equal(state.agents[name].blockedUntil, null);
    assert.equal(familyOverage(config.agents, state, name), true);
  }
  assert.equal(state.agents.claude.allowOverage, false);
  success(run(f.root, 'overage', 'codex', 'off'));
  state = f.read();
  assert.equal(state.agents.codex.allowOverage, false);
  assert.equal(state.agents.codex2.allowOverage, false);
  assert.equal(familyOverage({ a: { kind: 'claude', allowOverage: true }, b: { kind: 'claude' } }, { agents: {} }, 'b'), true);
});

test('CLI patch persists notes and rejects invalid changes without writing', (t) => {
  const f = fixture(t);
  success(run(f.root, 'patch', 'ARDAI-A1', '--epic', 'E', '--note', 'operator note', '--domain', '+test/', '--size', 'S'));
  assert.equal(f.read().tasks[0].lastNote, 'operator note');
  assert.equal(f.read().tasks[0].epic, 'E');
  assert.deepEqual(f.read().tasks[0].notes, ['operator note']);
  assert.match(taskPrompt({ task: f.read().tasks[0], agent: 'codex', otherTasks: [] }), /operator note/);
  assert.match(resumePrompt(f.read().tasks[0]), /operator note/);
  const before = fs.readFileSync(f.file, 'utf8');
  assert.equal(run(f.root, 'patch', 'ARDAI-A1', '--size', 'XL').status, 1);
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
});

test('every state-mutating CLI command uses the inbox with a stub runner', (t) => {
  const f = fixture(t);
  f.state.tasks.push({ id: 'local-fix', status: 'ready', domain: ['local/'], jira: false });
  f.write();
  const stub = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  t.after(() => stub.kill());
  fs.writeFileSync(path.join(f.runtime, 'run.lock'), String(stub.pid));
  const before = fs.readFileSync(f.file);
  const commands = [
    ['patch', 'ARDAI-A1', '--note', 'queued'], ['retry', 'ARDAI-A1'], ['answer', 'Q1', 'yes'],
    ['ack', 'Q1'], ['stop', 'ARDAI-A1'], ['clean', 'ARDAI-A1'], ['archive', 'ARDAI-A1'],
    ['unarchive', 'ARDAI-A1'], ['overage', 'codex', 'on'], ['sync'], ['init'], ['report'],
    ['import', 'PROJ-1'], ['import', '--file', 'tasks.json'],
    ['work', 'ARDAI-A1', 'X-FIX-1'], ['work', '--file', 'tasks.json'],
    ['work', 'local-fix'],
  ];
  for (const args of commands) {
    success(run(f.root, ...args));
    assert.deepEqual(fs.readFileSync(f.file), before, args[0]);
  }
  const inbox = fs.readFileSync(path.join(f.runtime, 'inbox.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(inbox.map((x) => x.cmd), commands.map((x) => x[0]));
  assert.deepEqual(inbox[14].args[0].keys, ['ARDAI-A1', 'X-FIX-1']);
  assert.equal(path.isAbsolute(inbox[15].args[0].file), true);
  assert.deepEqual(inbox[16].args[0].keys, ['local-fix']);
  success(run(f.root, 'archive', 'ARDAI-A1', 'X-FIX-1'));
  const batch = fs.readFileSync(path.join(f.runtime, 'inbox.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).at(-1);
  assert.deepEqual(batch, { cmd: 'archive', args: ['ARDAI-A1', 'X-FIX-1'] });
  assert.deepEqual(fs.readFileSync(f.file), before);
});

test('retry and answer default to no background runner and explain explicit start', (t) => {
  const f = fixture(t);
  assert.equal(loadProject({ cwd: f.root, env: {} }).config.autoStartRunner, false);
  for (const args of [['retry', 'ARDAI-A1'], ['answer', 'Q1', 'yes']]) {
    const r = run(f.root, ...args);
    success(r);
    assert.match(r.stdout, /No runner running/);
    assert.match(r.stdout, /run.*--start/);
    assert.equal(fs.existsSync(path.join(f.runtime, 'runner.log')), false);
  }
  assert.equal(f.read().tasks[0].status, 'ready');
  assert.equal(f.read().tasks[2].id, 'X-FIX-1-N1');
});

test('answers on follow-ups use root IDs, root domain and explicit extensions', (t) => {
  const f = fixture(t);
  f.state.tasks.push({ id: 'X-FIX-1-NACHTRAG-3-NACHTRAG-1', parentTicket: 'X-FIX-1', status: 'done', domain: ['narrow/'] });
  f.state.questions[0].taskId = f.state.tasks[2].id;
  f.write();
  success(run(f.root, 'answer', 'Q1', 'fix it', '--domain', '+tests/', '--domain', '+docs/'));
  let saved = f.read();
  const followUp = saved.tasks.at(-1);
  assert.equal(followUp.id, 'X-FIX-1-N4');
  assert.equal(followUp.parentTicket, 'X-FIX-1');
  assert.deepEqual(followUp.domain, ['src/', 'tests/', 'docs/']);
  assert.deepEqual(saved.tasks[1].domain, ['src/']);
  followUp.status = 'done';
  saved.questions.push({ id: 'Q2', taskId: followUp.id, question: 'Again?' });
  fs.writeFileSync(f.file, JSON.stringify(saved));
  success(run(f.root, 'answer', 'Q2', 'again'));
  saved = f.read();
  assert.equal(saved.tasks.at(-1).id, 'X-FIX-1-N5');
  assert.deepEqual(saved.tasks.at(-1).domain, ['src/']);
  saved.tasks = saved.tasks.filter((x) => x.id !== 'X-FIX-1-N5');
  assert.equal(followUpIdentity(followUp, saved.tasks).id, 'X-FIX-1-N6');
});

function initGit(root) {
  for (const args of [['init', '-b', 'main'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'fixture']]) {
    const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, r.stderr);
  }
}
async function until(predicate, message) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(message);
}

test('work resolves known local IDs in a real runner and consumes inbox patches', async (t) => {
  const f = fixture(t, { tickSeconds: 0.1 });
  initGit(f.root);
  const env = { ...process.env };
  delete env.ORCHESTRATOR_CONFIG;
  const child = spawn(process.execPath, [cli, 'work', 'ARDAI-A1', 'X-FIX-1', '--no-ui'], { cwd: f.root, env, windowsHide: true });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  t.after(() => child.kill());
  await until(() => output.includes('Auftrag: ARDAI-A1, X-FIX-1'), `Local work failed: ${output}`);
  success(run(f.root, 'patch', 'ARDAI-A1', '--epic', 'LOCAL', '--note', 'live edit'));
  await until(() => f.read().tasks[0].epic === 'LOCAL', 'Runner did not apply inbox patch');
  assert.equal(f.read().tasks[0].lastNote, 'live edit');
  success(run(f.root, 'stop'));
  await until(() => child.exitCode !== null, 'Runner did not stop');
  assert.equal(child.exitCode, 0, output);
});

for (const command of ['retry', 'answer']) {
  for (const mode of ['--start', 'autoStartRunner']) {
    test(`${command} starts an unscoped background runner with ${mode}`, async (t) => {
      const f = fixture(t, { tickSeconds: 0.1, autoStartRunner: mode === 'autoStartRunner' });
      initGit(f.root);
      const lock = path.join(f.runtime, 'run.lock');
      let pid;
      t.after(() => { if (pid) { try { process.kill(pid); } catch {} } });
      const args = command === 'retry' ? ['retry', 'ARDAI-A1'] : ['answer', 'Q1', 'yes'];
      if (mode === '--start') args.push('--start');
      const r = run(f.root, ...args);
      success(r);
      await until(() => fs.existsSync(lock), 'Background runner did not acquire lock');
      pid = Number(fs.readFileSync(lock, 'utf8'));
      await until(() => fs.readFileSync(path.join(f.runtime, 'runner.log'), 'utf8').includes('Orchestrator gestartet'), 'Background runner did not initialize');
      assert.doesNotMatch(fs.readFileSync(path.join(f.runtime, 'runner.log'), 'utf8'), /Auftrag:/);
      success(run(f.root, 'patch', 'ARDAI-A1', '--note', 'background edit'));
      await until(() => f.read().tasks[0].lastNote === 'background edit', 'Background runner ignored patch');
      success(run(f.root, 'stop'));
      await until(() => !fs.existsSync(lock), 'Background runner did not stop');
      await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 'Background runner did not exit');
      pid = null;
    });
  }
}


test('bulk archive validates the whole batch and supports restoring multiple tasks', (t) => {
  const f = fixture(t);
  const ids = f.state.tasks.map((task) => task.id);
  const before = fs.readFileSync(f.file, 'utf8');
  for (const args of [[], [ids[0], 'missing']]) {
    assert.equal(run(f.root, 'archive', ...args).status, 1);
    assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  }
  f.state.tasks[1].status = 'running';
  f.write();
  assert.equal(run(f.root, 'archive', ...ids).status, 1);
  assert.ok(f.read().tasks.every((task) => !task.archivedAt));
  f.state.tasks[1].status = 'done';
  f.write();
  success(run(f.root, 'archive', ...ids, ids[0]));
  assert.ok(f.read().tasks.every((task) => task.archivedAt));
  assert.equal(f.read().tasks[0].history.filter((entry) => entry.note === 'Archiviert').length, 1);
  success(run(f.root, 'unarchive', ...ids));
  assert.ok(f.read().tasks.every((task) => !task.archivedAt && task.keepActive));
});


test('web archive API accepts batches and rejects invalid input without changing state', async (t) => {
  const f = fixture(t);
  const env = { ...process.env };
  delete env.ORCHESTRATOR_CONFIG;
  const child = spawn(process.execPath, [cli, 'serve', '--no-open'], { cwd: f.root, env, windowsHide: true });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  try {
    await until(() => /http:\/\/127\.0\.0\.1:\d+\/\?t=/.test(output), 'UI did not start: ' + output);
    const url = new URL(output.match(/http:\/\/127\.0\.0\.1:\d+\/\?t=[A-Za-z0-9_-]+/)[0]);
    const post = (body) => fetch(new URL('/api/archive', url), {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Orchestrator-Token': url.searchParams.get('t') }, body: JSON.stringify(body),
    });
    const before = fs.readFileSync(f.file, 'utf8');
    for (const tasks of [[], 'ARDAI-A1', [null], ['ARDAI-A1', 'missing']]) {
      const res = await post({ tasks });
      assert.equal(res.status, 400);
      assert.equal(fs.readFileSync(f.file, 'utf8'), before);
    }
    const res = await post({ tasks: ['ARDAI-A1', 'X-FIX-1'] });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
    assert.ok(f.read().tasks.every((task) => task.archivedAt));
  } finally {
    child.kill();
    await until(() => child.exitCode !== null || child.signalCode !== null, 'UI did not stop');
  }
});

for (const mode of ['serve', 'run', 'work', 'serve-with-runner', 'active-work']) {
  test(`reload replaces ${mode} on the same URL and reads changed configuration`, async (t) => {
    const f = fixture(t, { language: 'en', tickSeconds: 0.1, ui: { port: 47421 } });
    initGit(f.root);
    const active = mode === 'active-work';
    const gate = path.join(f.root, 'release-agent');
    const marker = path.join(f.root, 'agent-started');
    if (active) {
      const configFile = path.join(f.root, CONFIG_NAME);
      const cfg = JSON.parse(fs.readFileSync(configFile));
      const mock = `const fs = require('node:fs'); process.stdin.resume(); fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => { if (fs.existsSync(${JSON.stringify(gate)})) process.exit(1); }, 25);`;
      Object.assign(cfg, { maxAttempts: 1, worktreeRoot: 'worktrees', checkpointMinutes: 0 });
      cfg.agents.claude = { enabled: true, command: process.execPath, commandPrefix: ['-e', mock, '--'], args: [] };
      fs.writeFileSync(configFile, JSON.stringify(cfg));
      Object.assign(f.state.tasks[0], { status: 'ready', branch: 'task/ARDAI-A1' });
      Object.assign(f.state.tasks[1], { status: 'ready', branch: 'task/X-FIX-1' });
      f.write();
    }
    const env = { ...process.env };
    delete env.ORCHESTRATOR_CONFIG;
    let runner, runnerSuccessor;
    if (mode === 'serve-with-runner') {
      runner = spawn(process.execPath, [cli, 'run', '--no-ui'], { cwd: f.root, env, windowsHide: true, stdio: 'ignore' });
    }
    const child = spawn(process.execPath, [cli, mode === 'serve-with-runner' ? 'serve' : active ? 'work' : mode, ...(mode === 'work' || active ? ['ARDAI-A1'] : []), '--no-open'], { cwd: f.root, env, windowsHide: true });
    let output = '', successor;
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    try {
      if (runner) await until(() => fs.existsSync(path.join(f.runtime, 'run.lock')), 'Background runner did not start');
      await until(() => /http:\/\/127\.0\.0\.1:\d+\/\?t=/.test(output), 'UI did not start: ' + output);
      const url = new URL(output.match(/http:\/\/127\.0\.0\.1:\d+\/\?t=[A-Za-z0-9_-]+/)[0]);
      const headers = { 'X-Orchestrator-Token': url.searchParams.get('t') };
      const before = await (await fetch(url)).text();
      assert.match(before, /data-action="reload">Reload changes/);
      if (active) await until(() => fs.existsSync(marker), 'Mock agent did not start: ' + output);
      const configFile = path.join(f.root, CONFIG_NAME);
      const cfg = JSON.parse(fs.readFileSync(configFile));
      cfg.language = 'de';
      fs.writeFileSync(configFile, JSON.stringify(cfg));
      const endpoint = new URL('/api/reload', url);
      assert.equal((await fetch(endpoint, { method: 'POST' })).status, 403);
      assert.equal(child.exitCode, null);
      const res = await fetch(endpoint, { method: 'POST', headers });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).ok, true);
      if (active) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        assert.equal(child.exitCode, null, 'Reload must wait for the running agent');
        assert.equal(f.read().tasks[0].status, 'running');
        assert.equal(f.read().tasks[1].attempts, undefined, 'No other task starts during drain');
        fs.writeFileSync(gate, 'finish');
      }
      await until(() => child.exitCode !== null, 'Old process did not exit: ' + output);
      let html = '';
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        try {
          const page = await fetch(url, { signal: AbortSignal.timeout(1000) });
          html = await page.text();
          const pid = Number(html.match(/data-ui-instance="(\d+)"/)?.[1]);
          if (page.ok && pid && pid !== child.pid) { successor = pid; break; }
        } catch { /* socket may be closed during handoff */ }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(successor, 'Replacement did not serve the same URL: ' + fs.readFileSync(path.join(f.runtime, 'reload.log'), 'utf8'));
      assert.match(html, /data-action="reload">Änderungen neu laden/);
      assert.deepEqual(f.read().tasks.map((task) => task.id), f.state.tasks.map((task) => task.id));
      if (mode === 'run' || mode === 'work' || active) assert.equal(Number(fs.readFileSync(path.join(f.runtime, 'run.lock'), 'utf8')), successor);
      if (active) {
        assert.equal(f.read().tasks[0].status, 'failed', 'Agent result is finalized before handoff');
        assert.equal(f.read().tasks[0].attempts, 1);
        assert.equal(f.read().tasks[1].attempts, undefined, 'Replacement retains the work scope');
      }
      if (runner) {
        await until(() => {
          try {
            const pid = Number(fs.readFileSync(path.join(f.runtime, 'run.lock'), 'utf8'));
            if (pid !== runner.pid) { runnerSuccessor = pid; return true; }
          } catch {}
          return false;
        }, 'Background runner did not reload');
      }
    } finally {
      child.kill();
      if (active && fs.existsSync(marker)) {
        try { process.kill(Number(fs.readFileSync(marker, 'utf8'))); } catch {}
      }
      if (successor) process.kill(successor);
      runner?.kill();
      if (runnerSuccessor) process.kill(runnerSuccessor);
      await until(() => {
        if (child.exitCode === null && child.signalCode === null) return false;
        if (successor) { try { process.kill(successor, 0); return false; } catch {} }
        if (runner && runner.exitCode === null && runner.signalCode === null) return false;
        if (runnerSuccessor) { try { process.kill(runnerSuccessor, 0); return false; } catch {} }
        return true;
      }, 'Reload test processes did not exit');
      // Windows releases a detached process's cwd shortly after its PID disappears.
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  });
}

test('invalid replacement code fails preparation without replacing the live process', async (t) => {
  const f = fixture(t);
  const script = path.join(f.root, 'broken.mjs');
  fs.writeFileSync(script, 'invalid javascript syntax!');
  await assert.rejects(prepareReload({ script, args: [], cwd: f.root, logFile: path.join(f.runtime, 'reload.log'), context: {} }), /Reload failed/);
  assert.match(fs.readFileSync(path.join(f.runtime, 'reload.log'), 'utf8'), /SyntaxError/);
});

test('runner sends independent Jira tickets concurrently without losing inbox edits', async (t) => {
  let active = 0, peak = 0, received = 0, sameTicketOverlap = false;
  const busy = new Set();
  const server = http.createServer((req, res) => {
    const key = req.url.split('/issue/')[1]?.split('?')[0];
    if (busy.has(key)) sameTicketOverlap = true;
    busy.add(key); received++; peak = Math.max(peak, ++active);
    setTimeout(() => {
      busy.delete(key); active--;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ fields: { status: { name: 'In Progress' } } }));
    }, 300);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const f = fixture(t, { tickSeconds: 0.05, jiraBaseUrl: `http://127.0.0.1:${server.address().port}`,
    source: { jiraEmail: 'test@example.invalid', maxConcurrency: 2, requestTimeoutSeconds: 2 }, ollama: { enabled: false },
  });
  initGit(f.root);
  f.state.sourceActions = ['DEV-1', 'DEV-1', 'DEV-2', 'DEV-3'].map((taskId, i) => ({ id: `a${i}`, taskId, type: 'started', tries: 0 }));
  f.write();
  const env = { ...process.env, ARDAI_JIRA_TOKEN: 'fixture-token' };
  delete env.ORCHESTRATOR_CONFIG;
  delete env.ARDAI_JIRA_TOKEN_FILE;
  const child = spawn(process.execPath, [cli, 'run', '--no-ui'], { cwd: f.root, env, windowsHide: true });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  try {
    await until(() => received > 0, 'Jira worker did not send requests: ' + output);
    success(run(f.root, 'patch', 'ARDAI-A1', '--note', 'while Jira is busy'));
    await until(() => f.read().tasks[0].lastNote === 'while Jira is busy' && !f.read().sourceActions?.length, 'Queue did not drain or inbox edit was lost: ' + output);
    assert.equal(received, 4);
    assert.equal(peak, 2);
    assert.equal(sameTicketOverlap, false);
    success(run(f.root, 'stop'));
    await until(() => child.exitCode !== null, 'Runner did not stop');
  } finally {
    child.kill();
    await until(() => child.exitCode !== null || child.signalCode !== null, 'Runner did not exit');
    server.closeAllConnections(); server.close();
  }
});

test('runner executes two Codex tasks concurrently in separate worktrees', async (t) => {
  const f = fixture(t);
  initGit(f.root);
  const gate = path.join(f.root, 'release-codex');
  const mock = `const fs = require('node:fs'), path = require('node:path');
    process.stdin.resume();
    fs.writeFileSync(path.join(${JSON.stringify(f.root)}, process.env.ORCHESTRATOR_AGENT + '.started'), JSON.stringify({ pid: process.pid, cwd: process.cwd() }));
    console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: process.env.ORCHESTRATOR_AGENT + ' working' } }));
    setInterval(() => { if (fs.existsSync(${JSON.stringify(gate)})) process.exit(1); }, 25);`;
  fs.writeFileSync(path.join(f.root, CONFIG_NAME), JSON.stringify({ runtimeDir: 'runtime', worktreeRoot: 'worktrees',
    tickSeconds: 0.05, maxAttempts: 1, checkpointMinutes: 0, budget: { enabled: false },
    agents: { claude: { enabled: false }, codex: { command: process.execPath, commandPrefix: ['-e', mock, '--'], args: ['exec'], sessionsDir: path.join(f.root, 'sessions') } },
  }));
  f.state.tasks.forEach((task, i) => Object.assign(task, { status: 'ready', branch: `task/parallel-${i}`, preferredAgent: 'codex' }));
  f.write();
  const env = { ...process.env };
  delete env.ORCHESTRATOR_CONFIG;
  const child = spawn(process.execPath, [cli, 'run', '--no-ui', '--exit-when-idle'], { cwd: f.root, env, windowsHide: true });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  try {
    await until(() => ['codex', 'codex2'].every((name) => fs.existsSync(path.join(f.root, name + '.started'))), 'Both Codex instances did not start: ' + output);
    const first = JSON.parse(fs.readFileSync(path.join(f.root, 'codex.started')));
    const second = JSON.parse(fs.readFileSync(path.join(f.root, 'codex2.started')));
    assert.notEqual(first.pid, second.pid);
    assert.notEqual(first.cwd, second.cwd);
    const state = f.read();
    assert.deepEqual(state.tasks.map((task) => task.status), ['running', 'running']);
    assert.deepEqual(new Set(state.tasks.map((task) => task.assignedAgent)), new Set(['codex', 'codex2']));
    fs.writeFileSync(gate, 'finish');
    await until(() => child.exitCode !== null, 'Runner did not finish: ' + output);
    assert.equal(child.exitCode, 0, output);
    const html = fs.readFileSync(path.join(f.runtime, 'report.html'), 'utf8');
    assert.equal((html.match(/class="agent-card"/g) || []).length, 2);
  } finally {
    fs.writeFileSync(gate, 'finish');
    child.kill();
    await until(() => child.exitCode !== null || child.signalCode !== null, 'Runner did not exit');
  }
});
