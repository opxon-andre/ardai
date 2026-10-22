import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { JiraExecutor } from '../lib/jira-executor.mjs';

test('Jira networking completes while the main event loop is synchronously blocked', async (t) => {
  const count = new Int32Array(new SharedArrayBuffer(4));
  // The fake remote server must have its own event loop too.
  const server = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const http = require('node:http');
    const count = new Int32Array(workerData);
    http.createServer((req,res) => setTimeout(() => {
      res.writeHead(200, {'content-type':'application/json'});
      res.end(JSON.stringify({ fields: { status: { name: 'In Progress' } } }));
      Atomics.add(count, 0, 1);
    }, 15)).listen(0,'127.0.0.1',function(){ parentPort.postMessage(this.address().port); });
  `, { eval: true, workerData: count.buffer });
  t.after(() => server.terminate());
  const port = await new Promise((resolve, reject) => { server.once('message', resolve); server.once('error', reject); });
  const executor = new JiraExecutor({ auth: { baseUrl: `http://127.0.0.1:${port}`, email: 'test@example.invalid', token: 'fixture', timeoutMs: 200 }, src: {}, ollama: { enabled: false }, language: 'en' });
  t.after(() => executor.close());
  await executor.apply({ taskId: 'DEV-1', type: 'started' });
  const before = Atomics.load(count, 0);
  const pending = executor.apply({ taskId: 'DEV-2', type: 'started' });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800);
  assert.equal(Atomics.load(count, 0), before + 1, 'Remote request must complete despite the blocked main thread');
  await pending;
});

test('worker errors reject outstanding work and the next action creates a fresh worker', async (t) => {
  const executor = new JiraExecutor({ auth: { baseUrl: 'http://127.0.0.1:1', email: 'test@example.invalid', token: 'fixture', timeoutMs: 200 }, src: {}, ollama: { enabled: false }, language: 'en' });
  t.after(() => executor.close());
  const pending = executor.apply({ taskId: 'DEV-1', type: 'started' });
  const rejection = assert.rejects(pending, /worker exited/);
  const original = executor.worker;
  await original.terminate(); await rejection;
  await assert.rejects(executor.apply({ taskId: 'DEV-2', type: 'started' }), /Jira/);
  assert.notEqual(executor.worker, original);
});
