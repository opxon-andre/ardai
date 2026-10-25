import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { readGraphs, GraphStatistics } from '../lib/graph-stats.mjs';

function fixture(t, dir = '') {
  const root = fs.mkdtempSync(new URL('.graph-stats-', import.meta.url));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, dir, '.code-review-graph', 'graph.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE nodes(kind TEXT, language TEXT);
    CREATE TABLE edges(kind TEXT);
    CREATE TABLE metadata(key TEXT, value TEXT);
    INSERT INTO nodes VALUES ('File','javascript'),('Function','javascript'),('Class','javascript');
    INSERT INTO edges VALUES ('CALLS'),('IMPORTS_FROM');
    INSERT INTO metadata VALUES ('last_updated','2026-10-24T10:00:00'),('build_state','postprocess-pending'),('git_branch','task/DEV-1');`);
  db.close();
  return { root, file };
}

test('graph statistics read existing indexes without migrations or duplicate counting', async (t) => {
  const { file } = fixture(t);
  const before = fs.readFileSync(file);
  const [graph] = await readGraphs([{ name: 'codex', file }]);
  assert.deepEqual(graph, { name: 'codex', status: 'ready', files: 1, nodes: 3, edges: 2,
    functions: 1, classes: 1, languages: ['javascript'], updatedAt: '2026-10-24T10:00:00', branch: 'task/DEV-1', incomplete: true });
  assert.deepEqual(fs.readFileSync(file), before);
});

test('a blocked main loop does not time out a completed graph reader', async (t) => {
  const { file } = fixture(t);
  const pending = readGraphs([{ name: 'Projekt', file }], { timeoutMs: 1000 });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
  assert.equal((await pending)[0].status, 'ready');
});

test('missing, corrupt and busy graph indexes are isolated from healthy ones', async (t) => {
  const { root, file } = fixture(t);
  const missing = path.join(root, 'missing.db'), broken = path.join(root, 'broken.db');
  fs.writeFileSync(broken, 'not sqlite');
  const result = await readGraphs([{ name: 'missing', file: missing }, { name: 'broken', file: broken }, { name: 'healthy', file }]);
  assert.deepEqual(result.map((r) => r.status), ['missing', 'unavailable', 'ready']);
  assert.equal(fs.existsSync(missing), false);
  const lock = new DatabaseSync(file);
  try {
    lock.exec('BEGIN EXCLUSIVE');
    const [busy] = await readGraphs([{ name: 'locked', file }]);
    assert.equal(busy.status, 'busy');
  } finally { lock.exec('ROLLBACK'); lock.close(); }
});

test('graph snapshots keep cached values until a merge invalidates them', async (t) => {
  const { root, file } = fixture(t, 'worktrees/codex');
  let updates = 0;
  const stats = new GraphStatistics({ repoRoot: root, worktreeRoot: path.join(root, 'worktrees'),
    agents: { codex: { enabled: true }, codex2: { enabled: true } }, enabled: true, onUpdate: () => { updates++; } });
  assert.equal(stats.snapshot().loading, true);
  const pending = stats.pending;
  stats.snapshot();
  assert.equal(stats.pending, pending);
  await pending;
  const data = stats.snapshot();
  assert.equal(data.loading, false);
  assert.equal(data.graphs.length, 2);
  assert.equal(data.graphs[0].nodes, 3);
  assert.equal(data.graphs[1].status, 'missing');
  assert.equal(stats.pending, null);
  assert.equal(updates, 1);
  const db = new DatabaseSync(file);
  db.exec("INSERT INTO nodes VALUES ('Function','javascript')");
  db.close();
  t.mock.method(Date, 'now', () => 9999999999999);
  assert.equal(stats.snapshot().graphs[0].nodes, 3, 'elapsed time and UI refresh do not reread the index');
  assert.equal(stats.pending, null);
  stats.invalidate();
  stats.snapshot();
  await stats.pending;
  assert.equal(stats.snapshot().graphs[0].nodes, 4);
  assert.equal(updates, 2);
});

test('merge invalidation during an ongoing read queues a follow-up without overlapping workers', async (t) => {
  const { root } = fixture(t);
  const stats = new GraphStatistics({ repoRoot: root, worktreeRoot: path.join(root, 'trees'), agents: {}, enabled: true });
  stats.snapshot();
  const first = stats.pending;
  stats.invalidate();
  stats.invalidate();
  stats.snapshot();
  assert.equal(stats.pending, first);
  await first;
  const followUp = stats.pending;
  assert.ok(followUp);
  assert.notEqual(followUp, first);
  await followUp;
  assert.equal(stats.pending, null);
  assert.equal(stats.snapshot().graphs[0].nodes, 3);
});

test('CLI reports include completed graph statistics in live and exported reports', (t) => {
  const { root } = fixture(t);
  fs.writeFileSync(path.join(root, 'ardai.config.json'), JSON.stringify({ runtimeDir: 'runtime', resultsDir: 'results',
    worktreeRoot: 'worktrees', agents: { claude: { enabled: false }, codex: { enabled: false } } }));
  const env = { ...process.env };
  delete env.ORCHESTRATOR_CONFIG;
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../orchestrator.mjs', import.meta.url)), 'report'],
    { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const exported = fs.readdirSync(path.join(root, 'results')).find((file) => file.endsWith('.html'));
  for (const file of [path.join(root, 'runtime', 'report.html'), path.join(root, 'results', exported)]) {
    const html = fs.readFileSync(file, 'utf8');
    assert.match(html, /class="agent-card graph-card"/);
    assert.match(html, /<dt>Knoten<\/dt><dd>3<\/dd>/);
    assert.doesNotMatch(html, /Statistik wird geladen/);
  }
});
