import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeT } from '../lib/i18n.mjs';
import { buildReportHtml, renderReport } from '../lib/report.mjs';

test('report uses all results from the latest run per task and excludes archived results', () => {
  const state = {
    tasks: [{ id: 'PROJ-1', status: 'done', title: 'active' }, { id: 'PROJ-2', status: 'done', title: 'archived', archivedAt: '2026-01-01' }],
    testResults: [
      { taskId: 'PROJ-1', at: '2026-01-01', result: 'fail', criterion: 'obsolete failure', component: 'lib' },
      { taskId: 'PROJ-1', at: '2026-01-02', result: 'pass', criterion: 'current success', component: 'lib', kind: 'check' },
      { taskId: 'PROJ-1', at: '2026-01-02', result: 'skip', criterion: 'current skip', component: 'lib', kind: 'ac' },
      { taskId: 'PROJ-2', at: '2026-01-03', result: 'fail', criterion: 'archived failure', component: 'lib' },
    ],
  };
  const before = structuredClone(state);
  const html = buildReportHtml(state, { fragmentOnly: true, jiraBaseUrl: 'https://jira.example.invalid/' });
  assert.match(html, /current success/);
  assert.match(html, /current skip/);
  assert.match(html, /2 Läufe/);
  assert.match(html, /<b style="color:var\(--ok\)">1<\/b>grün/);
  assert.match(html, /<b style="color:var\(--bad\)">0<\/b>rot/);
  assert.match(html, /<b>1\/1<\/b>Aufgaben fertig/);
  assert.match(html, /href="https:\/\/jira.example.invalid\/browse\/PROJ-1"/);
  assert.match(html, /id="sec-archive"/);
  assert.doesNotMatch(html, /obsolete failure|archived failure/);
  assert.deepEqual(state, before);
});

test('report escapes untrusted task, question, test and activity content', () => {
  const bad = '<img src=x onerror="bad()">&';
  const state = {
    tasks: [{ id: 'local', title: bad, status: 'failed', lastNote: bad }],
    questions: [{ id: 'Q1', taskId: 'local', blocking: true, question: bad, assumption: bad, context: bad }],
    testResults: [{ taskId: 'local', result: 'fail', at: '2026-01-01', criterion: bad, component: bad, note: bad }],
  };
  const html = buildReportHtml(state, { fragmentOnly: true, activity: [
    { agent: 'codex', task: 'local', updatedAt: Date.now(), items: [{ kind: 'error', text: bad }] },
  ] });
  assert.ok(html.split('&lt;img src=x onerror=&quot;bad()&quot;&gt;&amp;').length > 7);
  assert.doesNotMatch(html, /<img|onerror="bad/);
  assert.match(html, /badge fail">Rot/);
  assert.match(html, /<b>1<\/b>offene Fragen/);
});

test('empty report renders a standalone file and fragment without network or UI controls', (t) => {
  const root = fs.mkdtempSync(new URL('.report-', import.meta.url));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const out = path.join(root, 'nested', 'report.html');
  renderReport({}, out);
  const html = fs.readFileSync(out, 'utf8');
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /Keine aktiven Aufgaben/);
  assert.match(html, /Keine offenen Fragen/);
  assert.match(html, /Keine Testergebnisse zu aktiven Aufgaben/);
  assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+href=|<button|<form/);
  const fragment = buildReportHtml({}, { fragmentOnly: true });
  assert.match(fragment, /<h1>/);
  assert.doesNotMatch(fragment, /<!doctype|<html|<script/);
});

test('report surfaces only unresolved visible questions and retains open archived hints', () => {
  const state = {
    tasks: [{ id: 'archived', archivedAt: '2026-01-01', status: 'done' }],
    questions: [
      { id: 'Q1', taskId: 'archived', blocking: true, question: 'HIDDEN_ARCHIVED' },
      { id: 'Q2', taskId: 'missing', blocking: true, question: 'VISIBLE_BLOCKER' },
      { id: 'Q3', taskId: 'missing', blocking: true, answer: 'yes', question: 'HIDDEN_ANSWERED' },
      { id: 'Q4', taskId: 'archived', question: 'VISIBLE_HINT' },
      { id: 'Q5', taskId: 'archived', agent: 'orchestrator', question: 'HIDDEN_INTERNAL' },
      { id: 'Q6', taskId: 'archived', acknowledgedAt: '2026-01-02', question: 'HIDDEN_ACK' },
    ],
  };
  const html = buildReportHtml(state, { fragmentOnly: true });
  assert.match(html, /VISIBLE_BLOCKER/);
  assert.match(html, /VISIBLE_HINT/);
  assert.doesNotMatch(html, /HIDDEN_/);
  assert.match(html, /<b>1<\/b>offene Fragen/);
  assert.match(html, /<b>1<\/b>Hinweise/);
});


test('task lists show newest additions first without changing scheduler order', () => {
  const state = { tasks: [
    { id: 'OLD', status: 'failed' }, { id: 'ARCHIVE-OLD', status: 'done', archivedAt: '2026-01-03' },
    { id: 'NEW', status: 'ready' }, { id: 'ARCHIVE-NEW', status: 'done', archivedAt: '2026-01-01' },
  ] };
  const before = structuredClone(state);
  for (const fragmentOnly of [true, false]) {
    const html = buildReportHtml(state, { fragmentOnly });
    assert.ok(html.indexOf('<td>NEW</td>') < html.indexOf('<td>OLD</td>'));
    assert.ok(html.indexOf('<td>ARCHIVE-NEW</td>') < html.indexOf('<td>ARCHIVE-OLD</td>'));
  }
  assert.deepEqual(state, before);
});

test('bulk archive selection is available only for eligible active tasks in the live UI', () => {
  const state = { tasks: ['done', 'stopped', 'failed', 'ready', 'running', 'needs-human', 'interrupted'].map((status) => ({ id: status, status })) };
  state.tasks.push({ id: 'archived', status: 'done', archivedAt: '2026-01-01' });
  const html = buildReportHtml(state, { fragmentOnly: true, ui: { t: makeT('en') } });
  assert.match(html, /data-action="archive-selected" disabled>Archive selected/);
  assert.match(html, /data-archive-all/);
  assert.deepEqual([...html.matchAll(/data-archive-task="([^"]+)"/g)].map((m) => m[1]), ['failed', 'stopped', 'done']);
  const staticHtml = buildReportHtml(state, { fragmentOnly: true });
  assert.doesNotMatch(staticHtml, /data-archive-task|data-archive-all|archive-selected/);
  const runningHtml = buildReportHtml({ tasks: [{ id: 'busy', status: 'running' }] }, { fragmentOnly: true, ui: { t: makeT('de') } });
  assert.doesNotMatch(runningHtml, /data-archive-task|data-archive-all|archive-selected/);
});

test('live report offers reload and indicates a pending restart', () => {
  const ui = { t: makeT('de'), instance: '123' };
  assert.match(buildReportHtml({}, { fragmentOnly: true, ui }), /data-action="reload">Änderungen neu laden/);
  assert.match(buildReportHtml({}, { fragmentOnly: true, ui: { ...ui, reloadRequested: true } }), /data-action="reload" disabled>Neuladen vorgemerkt/);
  assert.match(buildReportHtml({}, { ui }), /"instance":"123"/);
  assert.doesNotMatch(buildReportHtml({}), /data-action="reload"/);
});

test('siblings share one card per kind with individual tasks and overage switches', () => {
  const agents = { codex: { kind: 'codex' }, codex2: { kind: 'codex' }, claude: { kind: 'claude' }, helper: { kind: 'claude', enabled: false } };
  const state = { agents: { codex: { runningTask: 'DEV-1' }, codex2: { runningTask: 'DEV-2' }, claude: { blockedUntil: '2099-01-01' } },
    tasks: [{ id: 'DEV-1', title: 'First <task>', status: 'running' }, { id: 'DEV-2', title: 'Second', status: 'running' }] };
  const before = structuredClone(state);
  const html = buildReportHtml(state, { agents, fragmentOnly: true, ui: { t: makeT('de') }, overage: { codex2: true },
    jiraBaseUrl: 'https://jira.example.invalid',
    activity: [{ agent: 'codex2', task: 'DEV-2', updatedAt: Date.now(), items: [{ text: 'Editing <file>' }] }],
    capacity: { codex: { windows: [{ label: '5 Stunden', percent: 42 }] } } });
  assert.equal((html.match(/class="agent-card"/g) || []).length, 2);
  assert.equal((html.match(/class="agent-instance"/g) || []).length, 4);
  const codex = html.slice(html.indexOf('<strong>Codex</strong>'), html.indexOf('<strong>Claude</strong>'));
  assert.match(codex, /data-agent="codex"/);
  assert.match(codex, /data-agent="codex2"/);
  assert.match(codex, /DEV-1.*First &lt;task&gt;/);
  assert.match(codex, /DEV-2.*Second/);
  assert.match(codex, /Editing &lt;file&gt;/);
  assert.equal((codex.match(/role="meter"/g) || []).length, 1);
  assert.match(codex, /data-overage="codex2" checked/);
  assert.match(html, /gesperrt bis/);
  assert.match(html, /deaktiviert/);
  assert.deepEqual(state, before);
  assert.equal((buildReportHtml(state, { agents }).match(/class="agent-card"/g) || []).length, 2);
});
