import test from 'node:test';
import assert from 'node:assert/strict';
import { depsDone, selectTask } from '../lib/planning.mjs';

const agents = { codex: { enabled: true, preferredDomains: ['tools/'] }, claude: { enabled: true } };
const task = (id, extra = {}) => ({ id, status: 'ready', domain: [`${id}/`], ...extra });
const select = (tasks, opts) => selectTask('codex', tasks, agents, opts);

test('domain and exclusive resource conflicts block even preferred or interrupted work', () => {
  const busy = task('busy', { status: 'running', domain: ['src\\rules\\'], resources: ['docker'] });
  const conflict = task('conflict', { status: 'interrupted', domain: ['src/rules/a.mjs'], preferredAgent: 'codex' });
  const resource = task('resource', { resources: ['docker'] });
  const free = task('free');
  assert.equal(select([busy, conflict, resource, free]), free);
  assert.equal(select([busy, conflict, resource]), null);
  busy.status = 'done';
  assert.equal(select([busy, conflict, resource, free]), conflict);
});

test('dependency order works independently of input order and waits for all predecessors', () => {
  const a = task('A');
  const b = task('B', { dependsOn: ['A'] });
  const c = task('C', { dependsOn: ['A', 'B'] });
  const tasks = [c, b, a];
  assert.equal(select(tasks), a);
  a.status = 'done';
  assert.equal(select(tasks), b);
  b.status = 'done';
  assert.equal(select(tasks), c);
  c.status = 'done';
  assert.equal(select(tasks), null);
  assert.equal(depsDone(task('legacy', { dependsOn: ['archived-away'] }), tasks), true);
  for (const status of ['ready', 'running', 'interrupted', 'failed', 'blocked', 'needs-human', 'stopped']) {
    a.status = status;
    assert.equal(depsDone(c, tasks), false, status);
  }
});

test('cycles and unresolved work states never yield a runnable candidate', () => {
  assert.equal(select([task('A', { dependsOn: ['B'] }), task('B', { dependsOn: ['A'] })]), null);
  for (const status of ['done', 'failed', 'blocked', 'needs-human', 'stopped']) {
    assert.equal(select([task('A', { status })]), null, status);
  }
  assert.equal(select([]), null);
});

test('selection honors scope, owner availability and resume ownership', () => {
  const owned = task('A', { preferredAgent: 'claude' });
  assert.equal(select([owned]), null);
  assert.equal(select([owned], { isAvailable: () => false }), owned);
  assert.equal(select([owned], { inScope: () => false, isAvailable: () => false }), null);
  const resume = task('B', { status: 'interrupted', lastAgent: 'claude' });
  assert.equal(select([resume]), null);
  assert.equal(select([resume], { isAvailable: () => false }), resume);
  assert.equal(selectTask('codex', [owned], { ...agents, claude: { enabled: false } }), owned);
});

test('selection ranks resume, phase test, preferred agent and domain with stable ties', () => {
  const plain = task('plain');
  const domain = task('domain', { domain: ['tools/scheduler/'] });
  const owner = task('owner', { preferredAgent: 'codex' });
  const phase = task('phase', { type: 'phase-test' });
  const resume = task('resume', { status: 'interrupted' });
  const tasks = [plain, domain, owner, phase, resume];
  const before = structuredClone(tasks);
  for (const expected of [resume, phase, owner, domain, plain]) {
    assert.equal(select(tasks.filter((x) => tasks.indexOf(x) <= tasks.indexOf(expected))), expected);
  }
  assert.equal(select([plain, task('tie')]), plain);
  assert.deepEqual(tasks, before);
});

test('a task is not held back for a busy preferred agent, only for an idle one', () => {
  const task = { id: 'T-1', status: 'ready', preferredAgent: 'claude', domain: ['a/'], dependsOn: [], resources: [] };
  const idle = selectTask('codex', [task], agents, { isAvailable: () => true, busyAgents: new Set() });
  assert.equal(idle, null, 'idle preferred agent keeps its task');
  const busy = selectTask('codex', [task], agents, { isAvailable: () => true, busyAgents: new Set(['claude']) });
  assert.equal(busy, task, 'busy preferred agent releases its task to a free agent');
  const strict = selectTask('codex', [task], agents, { isAvailable: () => true, busyAgents: new Set(['claude']), stealWhenBusy: false });
  assert.equal(strict, null, 'stealWhenBusy=false restores the strict reservation');
});

test('soft domains do not serialize tasks that only overlap in append-only areas', () => {
  const agents = { claude: { enabled: true }, codex: { enabled: true } };
  const running = { id: 'A', status: 'running', domain: ['Backend/Gateway/routers/', 'Backend/AdWyse/src/'], dependsOn: [] };
  const sameHard = { id: 'B', status: 'ready', domain: ['Backend/AdWyse/src/', 'Backend/Gateway/routers/'], dependsOn: [] };
  const softOnly = { id: 'C', status: 'ready', domain: ['Backend/DataHub/', 'Backend/Gateway/routers/', 'docs/schnittstellen/'], dependsOn: [] };
  const soft = ['Backend/Gateway/routers/', 'docs/schnittstellen/'];
  assert.equal(selectTask('codex', [running, softOnly], agents, {}), null, 'without soft domains the shared routers area serializes');
  assert.equal(selectTask('codex', [running, softOnly], agents, { softDomains: soft })?.id, 'C');
  assert.equal(selectTask('codex', [running, sameHard], agents, { softDomains: soft }), null, 'a real overlap still serializes');
});
