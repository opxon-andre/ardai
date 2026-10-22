import test from 'node:test';
import assert from 'node:assert/strict';
import { planPhaseTests } from '../lib/phasetests.mjs';

const impl = (id, extra = {}) => ({ id, epic: 'E', status: 'done', domain: ['src/'], acceptanceCriteria: ['works'], ...extra });

test('completed epic bundles fresh tasks, domains and acceptance criteria without mutation', () => {
  const tasks = [impl('A'), impl('B', { domain: ['src/', 'docs/'] }), impl('C', { epic: null })];
  const before = structuredClone(tasks);
  const [planned] = planPhaseTests(tasks);
  assert.deepEqual(planned, {
    id: 'E-PHASENTEST', type: 'phase-test', jira: false, epic: 'E',
    title: 'Phasentest E (Playwright + Container)', size: 'S', branch: 'task/E-PHASENTEST',
    status: 'ready', resources: ['docker'], dependsOn: ['A', 'B'],
    domain: ['testing/', 'src/', 'docs/'], acceptanceCriteria: ['A: works', 'B: works'], preferredAgent: null,
  });
  assert.deepEqual(tasks, before);
});

test('unfinished, skipped, already covered and pending epics do not get another phase test', () => {
  assert.deepEqual(planPhaseTests([]), []);
  assert.deepEqual(planPhaseTests([impl('A', { status: 'ready' })]), []);
  assert.deepEqual(planPhaseTests([impl('A')], { skipEpics: ['E'] }), []);
  assert.deepEqual(planPhaseTests([impl('A'), impl('E-PHASENTEST', { type: 'phase-test', dependsOn: ['A'] })]), []);
  for (const status of ['ready', 'running', 'interrupted', 'needs-human', 'blocked']) {
    assert.deepEqual(planPhaseTests([impl('A'), impl('E-PHASENTEST', { type: 'phase-test', status })]), [], status);
  }
});

test('follow-up covers only new work, honors custom done status and avoids ID collisions', () => {
  const tasks = [impl('A', { status: 'merged' }), impl('B', { status: 'merged', domain: undefined, acceptanceCriteria: undefined }),
    impl('E-PHASENTEST', { type: 'phase-test', dependsOn: ['A'] }), { id: 'E-PHASENTEST-2' }];
  const [planned] = planPhaseTests(tasks, { doneStatus: 'merged' });
  assert.equal(planned.id, 'E-PHASENTEST-3');
  assert.deepEqual(planned.dependsOn, ['B']);
  assert.deepEqual(planned.domain, ['testing/']);
  assert.deepEqual(planned.acceptanceCriteria, []);
  assert.deepEqual(planPhaseTests([...tasks, planned], { doneStatus: 'merged' }), []);
});

test('runtimeDomains: only tasks touching runtime areas trigger a phase test', () => {
  const tasks = [impl('A', { domain: ['Frontend/SPA/src/pages/'] }), impl('B', { domain: ['docs/', 'Backend/Gateway/core/'] })];
  const [planned] = planPhaseTests(tasks, { runtimeDomains: ['Backend/Gateway/', 'Backend/Streamer/'] });
  assert.deepEqual(planned.dependsOn, ['B']);
  assert.deepEqual(planPhaseTests([tasks[0]], { runtimeDomains: ['Backend/Gateway/'] }), []);
  // ohne Konfiguration verhält sich alles wie bisher
  assert.deepEqual(planPhaseTests(tasks)[0].dependsOn, ['A', 'B']);
  // ein Nachlauf wird nicht für bereits ignorierte Aufgaben geplant
  const withTest = [...tasks, impl('E-PHASENTEST', { type: 'phase-test', dependsOn: ['B'] })];
  assert.deepEqual(planPhaseTests(withTest, { runtimeDomains: ['Backend/Gateway/'] }), []);
});

test('phase test prompt states the time budget only when configured', async () => {
  const { taskPrompt } = await import('../lib/prompts.mjs');
  const task = { id: 'E-PHASENTEST', type: 'phase-test', epic: 'E', title: 't', branch: 'b', domain: [], acceptanceCriteria: [] };
  assert.match(taskPrompt({ task, agent: 'claude', otherTasks: [], phaseTestBudgetMinutes: 45 }), /Zeitbudget:\*\* Der Phasentest hat höchstens 45 Minuten/);
  assert.doesNotMatch(taskPrompt({ task, agent: 'claude', otherTasks: [] }), /Zeitbudget/);
});
