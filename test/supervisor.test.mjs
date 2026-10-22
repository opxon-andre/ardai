import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

test('container supervisor reloads on the same URL, survives bad config and keeps state', { skip: process.platform !== 'linux' }, async () => {
  const root = fs.mkdtempSync(new URL('.supervisor-', import.meta.url));
  const config = path.join(root, 'ardai.config.json');
  fs.mkdirSync(path.join(root, '.orchestrator'));
  fs.writeFileSync(path.join(root, '.orchestrator', 'state.json'), JSON.stringify({ schemaVersion: 2, tasks: [{ id: 'kept', status: 'ready' }], agents: {}, questions: [] }));
  fs.writeFileSync(config, JSON.stringify({ schemaVersion: 2, language: 'en', ui: { port: 47461 }, agents: { claude: { enabled: false }, codex: { enabled: false } } }));
  const env = { ...process.env };
  for (const key of ['ORCHESTRATOR_CONFIG', 'ARDAI_SUPERVISED', 'ARDAI_RELOAD', 'ARDAI_UI_HOST', 'ARDAI_UI_PORT', 'ARDAI_UI_TOKEN', 'ARDAI_UI_TOKEN_FILE']) delete env[key];
  const child = spawn(process.execPath, [fileURLToPath(new URL('../docker/entrypoint.mjs', import.meta.url)), 'serve', '--no-open'], { cwd: root, env, windowsHide: true });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  async function until(fn) {
    const end = Date.now() + 15000;
    while (!(await fn())) { assert.ok(Date.now() < end, output); await new Promise((r) => setTimeout(r, 50)); }
  }
  try {
    await until(() => /http:\/\/127\.0\.0\.1:\d+\/\?t=/.test(output));
    const url = new URL(output.match(/http:\/\/127\.0\.0\.1:\d+\/\?t=[A-Za-z0-9_-]+/)[0]);
    const headers = { 'X-Orchestrator-Token': url.searchParams.get('t') };
    const page = () => fetch(url, { signal: AbortSignal.timeout(1000) }).then((r) => r.text());
    const first = (await page()).match(/data-ui-instance="(\d+)"/)[1];
    fs.writeFileSync(config, '{ invalid');
    let response = await fetch(new URL('/api/reload', url), { method: 'POST', headers });
    assert.equal(response.status, 400);
    await response.json();
    assert.match(await page(), new RegExp(`data-ui-instance="${first}"`));
    fs.writeFileSync(config, JSON.stringify({ schemaVersion: 2, language: 'de', ui: { port: 47461 } }));
    response = await fetch(new URL('/api/reload', url), { method: 'POST', headers });
    assert.equal(response.status, 200);
    await response.json();
    await until(async () => {
      try { return !(await page()).includes(`data-ui-instance="${first}"`); } catch { return false; }
    });
    assert.equal(child.exitCode, null, 'Supervisor must remain alive during reload');
    assert.match(await page(), /Änderungen neu laden/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.orchestrator', 'state.json'))).schemaVersion, 2);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.orchestrator', 'state.json'))).tasks[0].id, 'kept');
  } finally {
    child.kill();
    await until(() => child.exitCode !== null || child.signalCode !== null);
    // The supervisor forwards termination to its child; let Windows release cwd.
    for (let attempt = 0; ; attempt++) {
      try { fs.rmSync(root, { recursive: true, force: true }); break; }
      catch (error) { if (attempt >= 40) throw error; await new Promise((r) => setTimeout(r, 100)); }
    }
  }
});
