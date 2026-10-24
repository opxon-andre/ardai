import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { CONFIG_NAME, SCHEMA_VERSION, deepMerge, resolveAgents, findProjectRoot, loadProject, loadState, saveConfig, saveState } from '../lib/project.mjs';
import { Git } from '../lib/git.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const cli = fileURLToPath(new URL('../orchestrator.mjs', import.meta.url));

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(testDir, '.fixture-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function json(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function run(cwd, ...args) {
  const env = { ...process.env };
  delete env.ORCHESTRATOR_CONFIG;
  return spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: 'utf8', windowsHide: true });
}

test('root discovery walks upwards and prefers the nearest project', (t) => {
  const root = fixture(t);
  const nested = path.join(root, 'child');
  const cwd = path.join(nested, 'a', 'b');
  fs.mkdirSync(cwd, { recursive: true });
  json(path.join(root, CONFIG_NAME), {});
  assert.equal(findProjectRoot(cwd), root);
  json(path.join(nested, CONFIG_NAME), {});
  assert.equal(findProjectRoot(cwd), nested);
  assert.equal(findProjectRoot(nested), nested);
});

test('missing project gives an actionable CLI error', (t) => {
  const dir = fixture(t);
  // A fake filesystem root avoids inheriting this repository's project marker.
  const missing = path.parse(dir).root;
  assert.equal(findProjectRoot(missing), null);
  assert.throws(() => loadProject({ cwd: missing, env: {} }), /ardai init/);
  const result = run(missing, 'status');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ardai init/);
});

test('init creates a current project marker when discovery finds no project', (t) => {
  const root = fixture(t);
  const exists = fs.existsSync;
  // Hide ancestor project markers, keeping every test write inside the fixture.
  t.mock.method(fs, 'existsSync', (file) => [CONFIG_NAME, 'demo-alias.config.json'].includes(path.basename(file)) ? false : exists(file));
  const p = loadProject({ cwd: root, env: {}, init: true });
  assert.equal(p.repoRoot, root);
  assert.deepEqual(JSON.parse(fs.readFileSync(p.projectFile)), { schemaVersion: SCHEMA_VERSION });
});

test('CLI init installs the configured project hook using core.hooksPath', (t) => {
  const root = fixture(t);
  const git = (...args) => {
    const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git('init', '-b', 'main');
  git('config', 'core.hooksPath', '.hooks');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'fixture');
  const hook = '#!/bin/sh\n# orchestrator-pre-push custom project hook\nexit 0\n';
  fs.writeFileSync(path.join(root, 'hook.sh'), hook);
  json(path.join(root, CONFIG_NAME), {
    hooks: { prePush: 'hook.sh' }, runtimeDir: 'runtime', worktreeRoot: 'worktrees',
    agents: { codex: { enabled: false }, claude: { enabled: false } },
  });
  const cwd = path.join(root, 'nested');
  fs.mkdirSync(cwd);
  const result = run(cwd, 'init');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(root, '.hooks', 'pre-push'), 'utf8'), hook);
  assert.equal(fs.existsSync(path.join(root, 'worktrees', 'integration', '.git')), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'runtime', 'state.json'))).schemaVersion, SCHEMA_VERSION);
  const worktree = path.join(root, 'worktrees', 'integration');
  assert.equal(fs.statSync(path.join(worktree, '.git')).isFile(), true);
  json(path.join(worktree, CONFIG_NAME), {
    runtimeDir: 'runtime', worktreeRoot: path.join(root, 'worktrees'),
    agents: { codex: { enabled: false }, claude: { enabled: false } },
  });
  const linked = run(worktree, 'init');
  assert.equal(linked.status, 0, linked.stderr);
  assert.match(fs.readFileSync(path.join(worktree, '.hooks', 'pre-push'), 'utf8'), /orchestrator-pre-push/);
  const remote = path.join(root, 'remote.git');
  git('init', '--bare', remote);
  const env = { ...process.env };
  delete env.ORCHESTRATOR_AGENT;
  const push = spawnSync('git', ['-C', worktree, 'push', remote, 'HEAD:refs/heads/main'], { encoding: 'utf8', windowsHide: true, env });
  assert.notEqual(push.status, 0);
  assert.match(push.stderr, /Push nach main ist/);
});

test('deep merge preserves nested defaults and replaces arrays, scalars and null', () => {
  const base = { agent: { args: ['a'], size: { S: 1, M: 2 } }, list: [1], flag: true, nullable: {} };
  const copy = structuredClone(base);
  const result = deepMerge(base, { agent: { args: [], size: { S: 3 } }, list: [2], flag: false, nullable: null });
  assert.deepEqual(result, { agent: { args: [], size: { S: 3, M: 2 } }, list: [2], flag: false, nullable: null });
  assert.deepEqual(base, copy);
  assert.deepEqual(deepMerge({}, JSON.parse('{"__proto__":{"polluted":true},"constructor":{}}')), {});
  assert.equal({}.polluted, undefined);
});

test('project and environment layers override defaults without relocating root', (t) => {
  const root = fixture(t);
  const cwd = path.join(root, 'subdir');
  fs.mkdirSync(cwd);
  json(path.join(root, CONFIG_NAME), { source: { cloudId: 'project' }, agents: { codex: { enabled: false } } });
  json(path.join(cwd, 'override.json'), { source: { todoStatus: 'Ready' }, ui: { port: 9999 } });
  const project = loadProject({ cwd, env: { ORCHESTRATOR_CONFIG: 'override.json' } });
  assert.equal(project.repoRoot, root);
  assert.equal(project.overrideFile, path.join(cwd, 'override.json'));
  const runner = loadProject({ cwd: root, env: { ORCHESTRATOR_CONFIG: project.overrideFile } });
  assert.deepEqual(runner.config, project.config);
  assert.equal(project.config.source.cloudId, 'project');
  assert.equal(project.config.source.todoStatus, 'Ready');
  assert.equal(project.config.source.type, 'jira');
  assert.equal(project.config.ui.port, 9999);
  assert.equal(project.config.ui.enabled, true);
  assert.equal(project.config.agents.codex.enabled, false);
  assert.ok(project.config.agents.codex.args.length);
  assert.equal(project.config.schemaVersion, SCHEMA_VERSION);
});

test('runtime, reports and worktrees are relative to project root', (t) => {
  const root = fixture(t);
  json(path.join(root, CONFIG_NAME), { runtimeDir: 'var/demo-alias', resultsDir: 'reports', worktreeRoot: 'worktrees' });
  const p = loadProject({ cwd: root, env: {} });
  const runtime = path.join(root, 'var', 'demo-alias');
  for (const [key, name] of Object.entries({ stateFile: 'state.json', reportFile: 'report.html', hintsFile: 'hints.md', lockFile: 'run.lock', inboxFile: 'inbox.jsonl', logDir: 'logs' })) {
    assert.equal(p[key], path.join(runtime, name));
  }
  assert.equal(p.resultsDir, path.join(root, 'reports'));
  assert.equal(new Git(root, p.config).worktreePath('codex'), path.join(root, 'worktrees', 'codex'));
  const absolute = path.join(root, 'absolute');
  json(p.projectFile, { runtimeDir: absolute, resultsDir: absolute, worktreeRoot: absolute });
  const custom = loadProject({ cwd: root, env: {} });
  assert.equal(custom.runtimeDir, absolute);
  assert.equal(custom.resultsDir, absolute);
  assert.equal(new Git(root, custom.config).worktreeRoot, absolute);
});

test('second Codex inherits final project settings and can be disabled independently', (t) => {
  const root = fixture(t);
  const file = path.join(root, CONFIG_NAME);
  json(file, { agents: { codex: { command: 'project-codex', args: ['exec', '--json'], env: { EXAMPLE: 'yes' } } } });
  let { config } = loadProject({ cwd: root, env: {} });
  assert.equal(config.agents.codex2.enabled, true);
  assert.deepEqual(config.agents.codex2, config.agents.codex);
  const git = new Git(root, config);
  assert.notEqual(git.worktreePath('codex'), git.worktreePath('codex2'));
  json(file, { agents: { codex: { enabled: false } } });
  ({ config } = loadProject({ cwd: root, env: {} }));
  assert.equal(config.agents.codex2.enabled, false);
  json(file, { agents: { codex2: { enabled: false, args: ['custom'] } } });
  ({ config } = loadProject({ cwd: root, env: {} }));
  assert.equal(config.agents.codex.enabled, true);
  assert.equal(config.agents.codex2.enabled, false);
  assert.deepEqual(config.agents.codex2.args, ['custom']);
  assert.notDeepEqual(config.agents.codex.args, ['custom']);
});

test('agent inheritance rejects unknown parents and cycles', () => {
  assert.throws(() => resolveAgents({ child: { extends: 'missing' } }), /Unknown parent/);
  assert.throws(() => resolveAgents({ a: { extends: 'b' }, b: { extends: 'a' } }), /cycle/);
});

test('legacy state is unchanged on read and backed up exactly once on first save', (t) => {
  const file = path.join(fixture(t), 'state.json');
  const legacy = { tasks: [{ id: 'A', status: 'interrupted', history: [{ note: 'keep' }] }], agents: { codex: { blockedUntil: '2030-01-01' } }, questions: [], testResults: [], nextQuestion: 4, extra: 'keep' };
  const original = JSON.stringify(legacy, null, 2) + '\r\n';
  fs.writeFileSync(file, original);
  const state = loadState(file);
  assert.equal(state.schemaVersion, SCHEMA_VERSION);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(fs.existsSync(`${file}.bak`), false);
  saveState(file, state);
  assert.equal(fs.readFileSync(`${file}.bak`, 'utf8'), original);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { ...legacy, schemaVersion: SCHEMA_VERSION });
  state.tasks[0].status = 'done';
  saveState(file, state);
  assert.equal(fs.readFileSync(`${file}.bak`, 'utf8'), original);
  // A restored legacy state must not replace the original backup either.
  json(file, { ...legacy, extra: 'restored' });
  saveState(file, loadState(file));
  assert.equal(fs.readFileSync(`${file}.bak`, 'utf8'), original);
});

test('explicit v1 migrates; new/current states need no backup', (t) => {
  const file = path.join(fixture(t), 'runtime', 'state.json');
  const state = loadState(file);
  assert.deepEqual(state.tasks, []);
  saveState(file, state);
  assert.equal(fs.existsSync(`${file}.bak`), false);
  saveState(file, loadState(file));
  assert.equal(fs.existsSync(`${file}.bak`), false);
  json(file, { ...state, schemaVersion: 1 });
  saveState(file, loadState(file));
  assert.equal(JSON.parse(fs.readFileSync(`${file}.bak`)).schemaVersion, 1);
});

test('legacy config upgrades on save, preserving project-specific values', (t) => {
  const root = fixture(t);
  const file = path.join(root, CONFIG_NAME);
  const old = { source: { cloudId: 'legacy' }, extra: { value: 42 } };
  json(file, old);
  assert.equal(loadProject({ cwd: root, env: {} }).config.source.cloudId, 'legacy');
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), old);
  saveConfig(file, old);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { ...old, schemaVersion: SCHEMA_VERSION });
});

test('unsupported or invalid versions and malformed JSON cannot be overwritten', (t) => {
  const root = fixture(t);
  const config = path.join(root, CONFIG_NAME);
  const state = path.join(root, 'state.json');
  for (const version of [SCHEMA_VERSION + 1, 0, -1, '2', null, 1.5]) {
    json(config, { schemaVersion: version });
    json(state, { schemaVersion: version });
    const before = fs.readFileSync(state, 'utf8');
    assert.throws(() => loadProject({ cwd: root, env: {} }), /schemaVersion/);
    assert.throws(() => loadState(state), /schemaVersion/);
    assert.throws(() => saveState(state, { schemaVersion: SCHEMA_VERSION }), /schemaVersion/);
    assert.throws(() => saveConfig(config, {}), /schemaVersion/);
    assert.equal(fs.readFileSync(state, 'utf8'), before);
    assert.equal(fs.existsSync(`${state}.bak`), false);
  }
  json(config, {});
  json(path.join(root, 'override.json'), { schemaVersion: SCHEMA_VERSION + 1 });
  assert.throws(() => loadProject({ cwd: root, env: { ORCHESTRATOR_CONFIG: 'override.json' } }), /schemaVersion/);
  fs.writeFileSync(state, '{broken');
  assert.throws(() => loadState(state), SyntaxError);
  assert.throws(() => saveState(state, {}), SyntaxError);
  assert.equal(fs.readFileSync(state, 'utf8'), '{broken');
});

test('CLI from a nested directory resumes legacy state and writes configured reports', (t) => {
  const root = fixture(t);
  const cwd = path.join(root, 'nested');
  fs.mkdirSync(cwd);
  json(path.join(root, CONFIG_NAME), { runtimeDir: 'runtime', resultsDir: 'reports' });
  const file = path.join(root, 'runtime', 'state.json');
  const state = { tasks: [], agents: {}, questions: [], testResults: [], nextQuestion: 7, custom: 'preserved' };
  json(file, state);
  const original = fs.readFileSync(file, 'utf8');
  const status = run(cwd, 'status');
  assert.equal(status.status, 0, status.stderr);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  const report = run(cwd, 'report');
  assert.equal(report.status, 0, report.stderr);
  assert.equal(JSON.parse(fs.readFileSync(file)).custom, 'preserved');
  assert.equal(JSON.parse(fs.readFileSync(file)).nextQuestion, 7);
  assert.equal(JSON.parse(fs.readFileSync(file)).schemaVersion, SCHEMA_VERSION);
  assert.equal(fs.readFileSync(`${file}.bak`, 'utf8'), original);
  assert.ok(fs.existsSync(path.join(root, 'runtime', 'report.html')));
  assert.ok(fs.existsSync(path.join(root, 'runtime', 'hints.md')));
  assert.equal(fs.readdirSync(path.join(root, 'reports')).length, 1);
  json(file, { ...state, schemaVersion: SCHEMA_VERSION + 1 });
  const future = fs.readFileSync(file, 'utf8');
  const rejected = run(cwd, 'report');
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /schemaVersion/);
  assert.equal(fs.readFileSync(file, 'utf8'), future);
});
