import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { protocolAddendum } from '../lib/brand.mjs';
import { taskPrompt, resumePrompt } from '../lib/prompts.mjs';
import { loadProject, CONFIG_NAME } from '../lib/project.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(new URL('.protocol-', import.meta.url));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, CONFIG_NAME), JSON.stringify({ schemaVersion: 2 }));
  return root;
}

function prompts(root) {
  const { config } = loadProject({ cwd: root, env: {} });
  const addendum = protocolAddendum(root, config.brand, config.protocolAddendum);
  return [
    taskPrompt({ task: { id: 'TASK-1', domain: [] }, agent: 'codex', otherTasks: [], protocolAddendum: addendum }),
    resumePrompt({ id: 'TASK-1' }, addendum),
  ];
}

test('prompts work without a project addendum', (t) => {
  const root = fixture(t);
  const [task, resume] = prompts(root);
  assert.match(task, /Arbeitsprotokoll für orchestrierte Agenten/);
  assert.match(resume, /TASK-1/);
  assert.doesNotMatch(task, /Example project rules|docs\/api\//);
});

test('default project addendum follows the core in task and resume prompts', (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'ardai.protocol.md'), '# Project rules\nunique-project-rule');
  for (const prompt of prompts(root)) {
    assert.ok(prompt.endsWith('# Project rules\nunique-project-rule'));
    assert.equal(prompt.split('unique-project-rule').length, 2);
  }
});

test('project config path overrides branding and missing configured file gives no addendum', (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'docs', 'rules.md'), 'configured-project-rule');
  fs.writeFileSync(path.join(root, 'ardai.protocol.md'), 'branding-rule');
  fs.writeFileSync(path.join(root, 'old.protocol.md'), 'legacy-rule');
  fs.writeFileSync(path.join(root, CONFIG_NAME), JSON.stringify({ protocolAddendum: 'docs/rules.md' }));
  for (const prompt of prompts(root)) {
    assert.ok(prompt.endsWith('configured-project-rule'));
    assert.doesNotMatch(prompt, /branding-rule|legacy-rule/);
  }
  fs.unlinkSync(path.join(root, 'docs', 'rules.md'));
  for (const prompt of prompts(root)) assert.doesNotMatch(prompt, /configured-project-rule|branding-rule|legacy-rule/);
});

test('invalid configured addendum paths fail explicitly', (t) => {
  const root = fixture(t);
  for (const value of [null, '', 42, '../outside.md', path.resolve(root, 'rules.md')]) {
    assert.throws(() => protocolAddendum(root, undefined, value), /protocolAddendum/);
  }
});

test('fixture addendum is appended once after the core protocol in both prompts', () => {
  const root = new URL('./fixtures/example-project/', import.meta.url);
  const addendum = fs.readFileSync(new URL('ardai.protocol.md', root), 'utf8');
  for (const prompt of prompts(fileURLToPath(root))) {
    assert.ok(prompt.endsWith(addendum));
    assert.equal(prompt.split('# Example project rules').length, 2);
    assert.ok(prompt.indexOf('Arbeitsprotokoll') < prompt.indexOf('# Example project rules'));
    assert.match(prompt, /docs\/api\//);
  }
});

test('jira duty in the protocol is a placeholder filled by the prompt', () => {
  const base = { task: { id: 'TASK-1', domain: [] }, agent: 'codex', otherTasks: [] };
  const own = taskPrompt(base);
  const managed = taskPrompt({ ...base, jiraManaged: true });
  assert.ok(!own.includes('{{jira}}') && !managed.includes('{{jira}}'));
  assert.match(own, /„In Progress“/);
  assert.match(managed, /setzt ardai selbst – du änderst das Ticket nicht/);
  assert.ok(!managed.includes('AC:Issue'));
});

test('web server accepts a caller-supplied stable token', async () => {
  const { startServer } = await import('../lib/server.mjs');
  const ui = await startServer({ port: 47311, t: (k) => k, page: () => 'ok', fragment: () => 'ok', onAction: () => 'ok', token: 'stable-token-0123456789' });
  try {
    assert.equal(ui.token, 'stable-token-0123456789');
    assert.equal((await fetch(ui.url)).status, 200);
    assert.equal((await fetch(ui.url.replace('stable', 'wrong'))).status, 403);
  } finally { ui.server.close(); }
});
