import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { patchTask, followUpIdentity } from '../lib/task-edits.mjs';
import { CONFIG_NAME, loadProject } from '../lib/project.mjs';
import { taskPrompt, resumePrompt } from '../lib/prompts.mjs';

const cli = fileURLToPath(new URL('../orchestrator.mjs', import.meta.url));
const agents = { claude: {}, codex: {} };
function fixture(t, config = {}) {
  const root = fs.mkdtempSync(new URL('.reliability-', import.meta.url));
  // Windows can retain the child's cwd briefly after its exit hook removes run.lock.
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 40, retryDelay: 25 }));
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
