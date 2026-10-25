import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import { localAddresses } from '../lib/network.mjs';
import { loadEnvironment, uiEnvironment } from '../lib/environment.mjs';
import { startServer } from '../lib/server.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(new URL('.environment-', import.meta.url));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('dotenv preserves explicit environment values and reloads file-owned values', (t) => {
  const root = fixture(t), file = path.join(root, '.env');
  const env = { ARDAI_UI_PORT: '4800', GIT_AUTHOR_NAME: '', GIT_AUTHOR_EMAIL: '', GIT_COMMITTER_NAME: '', GIT_COMMITTER_EMAIL: '' };
  fs.writeFileSync(file, 'ARDAI_UI_HOST=127.0.0.1\nARDAI_UI_PORT=4900\n');
  loadEnvironment({ cwd: root, env });
  for (const name of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) assert.equal(env[name], undefined);
  assert.deepEqual(uiEnvironment({}, env), { host: '127.0.0.1', port: 4800, allowedHosts: [] });
  fs.writeFileSync(file, 'ARDAI_UI_HOST=0.0.0.0\nARDAI_UI_PORT=4901\nARDAI_UI_ALLOWED_HOSTS=example.test,localhost\n');
  loadEnvironment({ cwd: root, env });
  assert.deepEqual(uiEnvironment({}, env), { host: '0.0.0.0', port: 4800, allowedHosts: ['example.test', 'localhost'] });
  fs.unlinkSync(file);
  loadEnvironment({ cwd: root, env });
  assert.equal(env.ARDAI_UI_HOST, undefined);
  assert.deepEqual(uiEnvironment({}, {}), { host: '127.0.0.1', port: 4711, allowedHosts: [] });
});

test('secret files load without exposing values and can rotate across restarts', (t) => {
  const root = fixture(t), secret = path.join(root, 'key');
  const env = { CODEX_API_KEY_FILE: secret };
  fs.writeFileSync(secret, 'fixture-key-one\n');
  loadEnvironment({ cwd: root, env });
  assert.equal(env.CODEX_API_KEY, 'fixture-key-one');
  fs.writeFileSync(secret, 'fixture-key-two\n');
  loadEnvironment({ cwd: root, env });
  assert.equal(env.CODEX_API_KEY, 'fixture-key-two');
  assert.throws(() => loadEnvironment({ cwd: root, env: { CODEX_API_KEY_FILE: secret, CODEX_API_KEY: 'do-not-print' } }), (error) => !error.message.includes('do-not-print') && /not both/.test(error.message));
  fs.writeFileSync(secret, '');
  assert.throws(() => loadEnvironment({ cwd: root, env: { CODEX_API_KEY_FILE: secret } }), /empty secret/);
});

test('UI environment rejects invalid ports and wildcard host exceptions', () => {
  for (const port of ['abc', '-1', '0', '65536']) assert.throws(() => uiEnvironment({}, { ARDAI_UI_PORT: port }));
  assert.throws(() => uiEnvironment({}, { ARDAI_UI_ALLOWED_HOSTS: '*' }));
});

test('explicit remote bind retains token checks and Host protection', async (t) => {
  const ui = await startServer({ port: 47441, host: '0.0.0.0', allowedHosts: ['ardai.example.test'],
    t: (k) => k, page: () => 'page', fragment: () => 'fragment', onAction: () => 'done', token: 'fixture-token-123456789012345',
  });
  t.after(() => ui.server.close());
  const status = (url, options = {}) => new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(ui.server.address().address, '0.0.0.0');
  assert.equal((await fetch(ui.url)).status, 200);
  assert.equal(await status(ui.url, { headers: { Host: 'untrusted.example.test' } }), 403);
  assert.equal(await status(ui.url, { headers: { Host: 'ardai.example.test' } }), 200);
  assert.equal(await status(ui.url.split('?')[0], { headers: { Host: 'ardai.example.test' } }), 403);
  assert.equal(await status(new URL('/api/reload', ui.url), { method: 'POST', headers: { Host: 'ardai.example.test' } }), 403);
});

test('LAN mode advertises private interfaces while retaining Host and token checks', async (t) => {
  const interfaces = { lan: [{ address: '192.168.50.4', internal: false }, { address: '192.168.50.4', internal: false }],
    vpn: [{ address: '100.90.1.2', internal: false }], loopback: [{ address: '127.0.0.1', internal: true }],
    public: [{ address: '203.0.113.4', internal: false }] };
  assert.deepEqual(localAddresses(interfaces), ['192.168.50.4', '100.90.1.2']);
  t.mock.method(os, 'networkInterfaces', () => interfaces);
  const ui = await startServer({ port: 47443, host: '0.0.0.0', t: (k) => k,
    page: () => 'page', fragment: () => 'fragment', onAction: () => 'done', token: 'fixture-token' });
  t.after(() => ui.server.close());
  assert.equal(ui.lanUrls.length, 2);
  assert.ok(ui.lanUrls[0].startsWith('http://192.168.50.4:'));
  const status = (host, token = true) => new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${ui.port}/${token ? '?t=fixture-token' : ''}`, { headers: { Host: `${host}:${ui.port}` } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(await status('192.168.50.4'), 200);
  assert.equal(await status('100.90.1.2'), 200);
  assert.equal(await status('192.168.50.4', false), 403);
  assert.equal(await status('203.0.113.4'), 403);
  assert.equal(await status('attacker.example'), 403);
});

test('Berichte werden nur mit Token, nur direkt aus dem Ordner und nur als bekannte Dateitypen ausgeliefert', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ardai-reports-'));
  fs.writeFileSync(path.join(dir, 'bericht.html'), '<p>ok</p>');
  fs.writeFileSync(path.join(dir, 'geheim.txt'), 'x');
  const ui = await startServer({ port: 47461, host: '0.0.0.0', reportsDir: dir, t: (k) => k, page: () => 'p', fragment: () => 'f', onAction: () => 'ok' });
  try {
    const get = (p, headers = {}) => fetch(`http://127.0.0.1:${ui.port}${p}`, { headers });
    const ok = await get(`/reports/bericht.html?t=${ui.token}`);
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('content-security-policy'), /sandbox/);
    assert.equal(await ok.text(), '<p>ok</p>');
    assert.equal((await get('/reports/bericht.html')).status, 403);
    assert.equal((await get(`/reports/geheim.txt?t=${ui.token}`)).status, 404);
    assert.equal((await get(`/reports/..%2Fbericht.html?t=${ui.token}`)).status, 404);
    assert.equal((await get(`/reports/fehlt.html?t=${ui.token}`)).status, 404);
  } finally { ui.server.close(); }
});
