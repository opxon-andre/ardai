import test from 'node:test';
import assert from 'node:assert/strict';
import { SourceActionQueue } from '../lib/source-queue.mjs';

const settle = () => new Promise((resolve) => setImmediate(resolve));
test('source queue fills freed lanes, limits parallelism and preserves ticket order', async () => {
  let actions = [{ id: 'A1', taskId: 'A' }, { id: 'A2', taskId: 'A' }, { id: 'B1', taskId: 'B' }, { id: 'C1', taskId: 'C' }];
  const started = [], release = new Map();
  const queue = new SourceActionQueue({ actions: () => actions, concurrency: () => 2, execute: (action) => {
    started.push(action.id);
    return new Promise((resolve) => release.set(action.id, () => { actions = actions.filter((a) => a.id !== action.id); resolve(true); }));
  } });
  queue.pump(); queue.pump();
  assert.deepEqual(started, ['A1', 'B1'], 'I/O must launch before subsequent synchronous Git work');
  await settle();
  assert.deepEqual(started, ['A1', 'B1']);
  release.get('B1')(); await settle();
  assert.deepEqual(started, ['A1', 'B1', 'C1']);
  assert.equal(queue.size, 2);
  release.get('A1')(); await settle();
  assert.deepEqual(started, ['A1', 'B1', 'C1', 'A2']);
  release.get('C1')(); release.get('A2')(); await settle();
  assert.equal(queue.size, 0);
});

test('a delayed retry blocks later changes to its ticket and draining blocks new dispatch', async () => {
  let actions = [{ id: 'A1', taskId: 'A', retryAt: new Date(Date.now() + 60000).toISOString() }, { id: 'A2', taskId: 'A' }, { id: 'B1', taskId: 'B' }];
  let paused = false;
  const started = [];
  const queue = new SourceActionQueue({ actions: () => actions, concurrency: () => 4, canRun: () => !paused, execute: async (action) => {
    started.push(action.id); actions = actions.filter((a) => a.id !== action.id); return true;
  } });
  await Promise.all(queue.pump());
  assert.deepEqual(started, ['B1']);
  actions[0].retryAt = null;
  paused = true;
  assert.deepEqual(queue.pump(), []);
  paused = false;
  await Promise.all(queue.pump()); await settle();
  assert.deepEqual(started, ['B1', 'A1', 'A2']);
  assert.equal(queue.size, 0);
});
