import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { JiraClient, applyAction, adf, loadJiraAuth } from '../lib/jira.mjs';

function stub(handler) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null, auth: req.headers.authorization });
      const r = handler(req, calls.at(-1)) || { status: 204 };
      res.writeHead(r.status || 200, { 'content-type': 'application/json' });
      res.end(r.json ? JSON.stringify(r.json) : '');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ calls, server, url: `http://127.0.0.1:${server.address().port}` })));
}
const t = (k, v) => `${k}:${v.task}`;

test('review adds a comment and moves the ticket to In Review', async () => {
  const s = await stub((req) => {
    if (req.url.includes('fields=status')) return { json: { fields: { status: { name: 'In Progress' } } } };
    if (req.url.endsWith('/transitions') && req.method === 'GET') return { json: { transitions: [{ id: '31', name: 'Review', to: { name: 'In Review' } }] } };
    return { status: 201, json: {} };
  });
  const client = new JiraClient({ baseUrl: s.url, email: 'a@b.c', token: 'tok' });
  await applyAction(client, { taskId: 'DEV-1', type: 'review', comment: 'Fertig' }, { src: {}, t });
  s.server.close();
  assert.equal(s.calls[0].auth, `Basic ${Buffer.from('a@b.c:tok').toString('base64')}`);
  assert.equal(s.calls.find((c) => c.url.endsWith('/comment')).body.body.content[0].content[0].text, 'Fertig');
  assert.deepEqual(s.calls.at(-1).body, { transition: { id: '31' } });
});

test('transition is a no-op when the status already matches', async () => {
  const s = await stub(() => ({ json: { fields: { status: { name: 'In Progress' } } } }));
  const client = new JiraClient({ baseUrl: s.url, email: 'a@b.c', token: 'tok' });
  await applyAction(client, { taskId: 'DEV-1', type: 'started' }, { src: {}, t });
  s.server.close();
  assert.equal(s.calls.length, 1);
});

test('failed adds the label via update and errors hide the token', async () => {
  const s = await stub((req) => (req.method === 'PUT' ? { status: 401, json: { m: 'bad secret-tok' } } : {}));
  const client = new JiraClient({ baseUrl: s.url, email: 'a@b.c', token: 'secret-tok' });
  await assert.rejects(applyAction(client, { taskId: 'DEV-1', type: 'failed' }, { src: {}, t }), (e) => !e.message.includes('secret-tok') && /401/.test(e.message));
  s.server.close();
  assert.deepEqual(s.calls.at(-1).body, { update: { labels: [{ add: 'AC:Issue' }] } });
});

test('adf splits paragraphs and loadJiraAuth needs email and token', () => {
  assert.equal(adf('a\n\nb').content.length, 2);
  assert.equal(loadJiraAuth({ config: { jiraBaseUrl: 'https://x', source: {} }, env: {} }), null);
  assert.ok(loadJiraAuth({ config: { jiraBaseUrl: 'https://x/', source: { jiraEmail: 'e' } }, env: { ARDAI_JIRA_TOKEN: 't' } }));
});

test('tokenFile resolves "~" to the home directory and everything else against the repo', async () => {
  const { resolveTokenFile } = await import('../lib/jira.mjs');
  const path = await import('node:path');
  assert.equal(resolveTokenFile('~/secrets/jira', '/repo', '/home/u'), path.join('/home/u', '/secrets/jira'));
  assert.equal(resolveTokenFile('~\\jira', '/repo', '/home/u'), path.join('/home/u', '\\jira'));
  assert.equal(resolveTokenFile('secrets/jira', '/repo', '/home/u'), path.resolve('/repo', 'secrets/jira'));
  assert.equal(resolveTokenFile('~other/jira', '/repo', '/home/u'), path.resolve('/repo', '~other/jira'));
});

test('only reads retry a timeout; body timeouts are sanitized too', async () => {
  for (const method of ['GET', 'POST']) {
    let attempts = 0;
    const client = new JiraClient({ baseUrl: 'https://example.invalid', email: 'e', token: 'fixture-secret', fetchImpl: async () => {
      attempts++;
      return { text: async () => { throw Object.assign(new Error('fixture-secret timeout'), { name: 'TimeoutError' }); } };
    } });
    await assert.rejects(client.request(method, '/api', {}), (error) => error.retryable && !error.message.includes('fixture-secret'));
    assert.equal(attempts, method === 'GET' ? 2 : 1);
  }
});

test('rate limiting preserves Retry-After and pauses subsequent requests', async () => {
  let requests = 0;
  const client = new JiraClient({ baseUrl: 'https://example.invalid', email: 'e', token: 'fixture', fetchImpl: async () => {
    requests++;
    return { ok: false, status: 429, headers: new Headers({ 'retry-after': '120' }), text: async () => 'slow down' };
  } });
  await assert.rejects(client.request('GET', '/api'), (error) => error.status === 429 && error.retryAfterMs === 120000);
  await assert.rejects(client.request('GET', '/api'), (error) => error.status === 429 && error.retryAfterMs > 0);
  assert.equal(requests, 1);
});

test('a retry resumes after persisted steps without posting a successful comment twice', async () => {
  const calls = [];
  let fail = true;
  const client = { request: async (method, url) => {
    calls.push([method, url]);
    if (method === 'PUT' && fail) throw new Error('labels failed');
  } };
  const action = { taskId: 'DEV-1', type: 'failed', completedSteps: [] };
  const options = { t, onProgress: (step) => { action.completedSteps.push(step); } };
  await assert.rejects(applyAction(client, action, options), /labels failed/);
  assert.deepEqual(action.completedSteps, ['comment']);
  fail = false;
  await applyAction(client, action, options);
  assert.equal(calls.filter(([method]) => method === 'POST').length, 1);
  assert.deepEqual(action.completedSteps, ['comment', 'labels']);
});
