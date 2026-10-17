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
