import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadProject, CONFIG_NAME } from '../lib/project.mjs';
import { formatLine, tailActivity } from '../lib/activity.mjs';
import { importPrompt, taskPrompt } from '../lib/prompts.mjs';
import { buildReportHtml } from '../lib/report.mjs';
import { selectTask } from '../lib/planning.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = fileURLToPath(new URL('../orchestrator.mjs', import.meta.url));
const defaults = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url)));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(here, '.fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function config(root, value) {
  fs.writeFileSync(path.join(root, CONFIG_NAME), JSON.stringify(value));
}
function env() {
  const result = { ...process.env };
  delete result.ORCHESTRATOR_CONFIG;
  delete result.ORCHESTRATOR_AGENT;
  return result;
}
function run(root, ...args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: root, env: env(), encoding: 'utf8', windowsHide: true, timeout: 15_000 });
}

test('public defaults are neutral; fixture config customizes project behavior', () => {
  assert.equal(defaults.jiraBaseUrl, '');
  assert.equal(defaults.source.cloudId, '');
  assert.equal(defaults.resultsDir, '.orchestrator/results');
  assert.equal(defaults.phaseTestLocalSecrets, null);
  assert.equal(defaults.keyPattern, '[A-Z][A-Z0-9]+-\\d+');
  assert.deepEqual(defaults.agents.claude.preferredDomains, []);
  assert.deepEqual(defaults.agents.codex.preferredDomains, []);
  assert.doesNotMatch(JSON.stringify(defaults), /Backend\/|Frontend\//i);
  const project = loadProject({ cwd: path.join(here, 'fixtures/example-project'), env: {} });
  assert.equal(project.config.resultsDir, 'testing/results');
  assert.equal(project.config.phaseTestLocalSecrets, null);
  assert.equal(project.config.keyPattern, 'PROJ-\\d+');
  assert.deepEqual(project.config.agents.codex.preferredDomains, ['Backend/']);
  assert.deepEqual(project.config.agents.claude.preferredDomains, ['Frontend/']);
  assert.deepEqual(project.config.exampleDomains, ['Backend/Api/']);
  const prompt = importPrompt({ keys: ['PROJ-123'] }, 'out.json', project.config);
  assert.match(prompt, /Backend\/Api\//);
  assert.match(prompt, /"codex" für Backend\//);
  assert.match(prompt, /"claude" für Frontend\//);
  const backend = { id: 'backend', status: 'ready', domain: ['Backend/Api/'] };
  const frontend = { id: 'frontend', status: 'ready', domain: ['Frontend/Views/'] };
  assert.equal(selectTask('codex', [frontend, backend], project.config.agents), backend);
  assert.equal(selectTask('claude', [backend, frontend], project.config.agents), frontend);
});

test('import prompt uses configured examples and preferences, including disabled agents', () => {
  const neutral = importPrompt({ keys: ['TASK-123'] }, 'out.json', defaults);
  assert.match(neutral, /src\/component\//);
  assert.match(neutral, /keine Domänenpräferenzen/);
  assert.doesNotMatch(neutral, /Backend\/|Frontend\/|Projekt DEV/);
  const prompt = importPrompt({ jql: 'project = SAMPLE' }, 'out.json', {
    exampleDomains: ['packages/api/'], source: { cloudId: 'sample-cloud' },
    agents: { alpha: { preferredDomains: ['packages/api/'] }, beta: { enabled: false, preferredDomains: ['hidden/'] } },
  });
  assert.match(prompt, /cloudId sample-cloud/);
  assert.match(prompt, /"alpha" für packages\/api\//);
  assert.doesNotMatch(prompt, /hidden\/|beta|Backend\//);
});

test('phase-test prompt grants only the configured secrets path when provided', () => {
  const base = { task: { id: 'TASK-123', epic: 'TASK-100', type: 'phase-test', domain: [], acceptanceCriteria: [] }, agent: 'alpha', otherTasks: [] };
  const supplied = taskPrompt({ ...base, secretsProvided: true, localSecrets: 'test-data/private', composeProject: 'isolated' });
  assert.match(supplied, /Unter `test-data\/private`/);
  assert.match(supplied, /COMPOSE_PROJECT_NAME=isolated/);
  assert.doesNotMatch(supplied, /secrets\/local|Projekt DEV/);
  for (const options of [{ secretsProvided: false, localSecrets: 'test-data/private' }, { secretsProvided: true, localSecrets: null }]) {
    const prompt = taskPrompt({ ...base, ...options });
    assert.match(prompt, /Lokale Test-Secrets stehen nicht zur Verfügung/);
    assert.doesNotMatch(prompt, /Unter `test-data\/private`/);
  }
});

test('invalid ticket regex and unsafe secrets directories fail before execution', (t) => {
  const root = fixture(t);
  for (const keyPattern of ['[', '', null]) {
    config(root, { keyPattern });
    assert.throws(() => loadProject({ cwd: root, env: {} }), /keyPattern/);
  }
  for (const phaseTestLocalSecrets of ['../private', '/private', 'C:\\private', '.', 'a/../b', '']) {
    config(root, { phaseTestLocalSecrets });
    assert.throws(() => loadProject({ cwd: root, env: {} }), /phaseTestLocalSecrets/);
  }
  config(root, {
    phaseTestLocalSecrets: 'test-data/private', keyPattern: 'CASE_[0-9]+', worktreeRoot: 'worktrees',
    agents: { claude: { enabled: false }, codex: { enabled: false } },
  });
  assert.equal(loadProject({ cwd: root, env: {} }).config.phaseTestLocalSecrets, 'test-data/private');
  const rejected = run(root, 'work', 'TASK-123', '--no-ui');
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /Ungültige Ticket-Keys: TASK-123/);
  const accepted = run(root, 'import', 'CASE_42');
  assert.equal(accepted.status, 1);
  assert.match(accepted.stderr, /Kein Agent verfügbar/);
  assert.doesNotMatch(accepted.stderr, /Ungültige Ticket-Keys/);
  const invalidImport = run(root, 'import', 'TASK-123');
  assert.match(invalidImport.stderr, /Ungültige Ticket-Keys/);
});

test('Jira report links honor custom key patterns and phase-test suffixes', () => {
  const state = { tasks: [], testResults: [], agents: {}, questions: [] };
  const activity = [{ task: 'CASE_42-PHASENTEST', agent: 'alpha', items: [], updatedAt: Date.now() }];
  const options = { jiraBaseUrl: 'https://jira.example.invalid', keyPattern: 'CASE_[0-9]+', activity };
  assert.match(buildReportHtml(state, options), /href="https:\/\/jira.example.invalid\/browse\/CASE_42"/);
  assert.doesNotMatch(buildReportHtml(state, { ...options, keyPattern: 'OTHER-[0-9]+' }), /\/browse\/CASE_42/);
});

test('activity strips only configured Windows/POSIX roots with literal regex characters', (t) => {
  const event = (text) => JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } });
  for (const [root, file] of [
    ['C:\\Project [one]\\agent.trees', 'c:/Project [one]/agent.trees/codex/src/a.js'],
    ['/tmp/Project [one]/agent.trees', '/tmp/Project [one]/agent.trees/alpha/src/a.js'],
  ]) {
    assert.equal(formatLine(event(file), 'codex', root)[0].text, 'src/a.js');
    assert.equal(formatLine(event(file), 'codex')[0].text, file);
    assert.equal(formatLine(event(file.replace('agent.trees', 'agentXtrees')), 'codex', root)[0].text, file.replace('agent.trees', 'agentXtrees'));
  }
  const root = fixture(t);
  const log = path.join(root, 'TASK-123-codex-1.jsonl');
  fs.writeFileSync(log, event('/custom/trees/codex/src/a.js') + '\n');
  assert.equal(tailActivity(log, 10, 2_000_000, '/custom/trees').items[0].text, 'src/a.js');
  const claude = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/custom/trees/claude/src/a.js' } }] } });
  assert.equal(formatLine(claude, 'claude', '/custom/trees')[0].text, 'Read: src/a.js');
});

test('installed default hook blocks agent main pushes and permits main-directory and task pushes', (t) => {
  const root = fixture(t);
  const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, ...args], { env: env(), encoding: 'utf8', windowsHide: true });
  const ok = (r) => { assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  ok(git(root, 'init', '-b', 'main'));
  ok(git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'fixture'));
  config(root, { worktreeRoot: "trees [one] with 'quote", agents: { claude: { enabled: false }, codex: { enabled: false } } });
  const remote = path.join(root, 'remote.git');
  ok(git(root, 'init', '--bare', remote));
  ok(run(root, 'init'));
  const installed = fs.readFileSync(path.join(root, '.git', 'hooks', 'pre-push'), 'utf8');
  assert.doesNotMatch(installed, /__ARDAI_WORKTREE_ROOT__|\r/);
  assert.match(installed, /trees \[one\] with/);
  const wt = path.join(root, "trees [one] with 'quote", 'integration');
  const blocked = git(wt, 'push', remote, 'HEAD:refs/heads/main');
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /Push nach main ist/);
  ok(git(root, 'push', remote, 'HEAD:refs/heads/main'));
  ok(git(wt, 'push', remote, 'HEAD:refs/heads/task/sample'));
  // A different ref ensures Git invokes the hook even after main already exists.
  ok(git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'next'));
  const agentUpdate = spawnSync('git', ['-C', root, 'push', remote, 'HEAD:refs/heads/main'], { env: { ...env(), ORCHESTRATOR_AGENT: 'codex' }, encoding: 'utf8', windowsHide: true });
  assert.notEqual(agentUpdate.status, 0);
  assert.match(agentUpdate.stderr, /Push nach main ist/);
});
