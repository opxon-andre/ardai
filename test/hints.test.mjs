import test from 'node:test';
import assert from 'node:assert/strict';
import { collectHints, hintState, hintsMarkdown } from '../lib/hints.mjs';

test('hints retain archived and missing tasks and resolve answer before acknowledgement', () => {
  const task = { id: 'A', status: 'done', archivedAt: '2026-01-01' };
  const state = { tasks: [task], questions: [
    { id: 'Q1', taskId: 'A', question: '  which\n default? ', assumption: ' use  one ', context: ' old\n schema ' },
    { id: 'Q2', taskId: 'missing', question: 'why?', answer: '  yes\n please ', acknowledgedAt: '2026-01-02' },
    { id: 'Q3', taskId: 'A', question: 'ok?', acknowledgedAt: '2026-01-03T12:00:00Z' },
  ] };
  const before = structuredClone(state);
  const hints = collectHints(state);
  assert.deepEqual(hints.map((h) => h.state), ['open', 'answered', 'acknowledged']);
  assert.equal(hints[0].task, task);
  assert.equal(hints[1].task, null);
  const md = hintsMarkdown(state);
  for (const text of ['## Offen (1)', '## Beantwortet (1)', '## Bestätigt (1)', '### A (done, archiviert)',
    '### missing', 'which default?', 'Annahme des Agenten: use one', 'Kontext: old schema',
    'Antwort: yes please', 'Bestätigt am 2026-01-03']) assert.ok(md.includes(text), text);
  assert.deepEqual(state, before);
  assert.equal(hintState({ answer: '', acknowledgedAt: null }), 'open');
});

test('blocking and orchestrator questions never enter the hint collection or markdown', () => {
  const state = { questions: [
    { question: 'BLOCKED', blocking: true, agent: 'codex' },
    ...['orchestrator'].map((agent) => ({ question: 'INTERNAL', blocking: false, agent })),
  ] };
  assert.deepEqual(collectHints(state), []);
  assert.deepEqual(collectHints({}), []);
  assert.doesNotMatch(hintsMarkdown(state), /BLOCKED|INTERNAL|## Offen/);
  assert.match(hintsMarkdown({}), /# Hinweise der Agenten/);
});
