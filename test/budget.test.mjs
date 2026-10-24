import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens, budgetFor, budgetState, rebaseBudget, failureFingerprint, parseVerdict, reviewPrompt } from '../lib/budget.mjs';

const done = (id, size, tokens, at) => ({ id, size, status: 'done', tokensUsed: tokens, history: [{ at }] });
const usageOf = (t) => t.tokensUsed;

test('estimate is the moving average of the latest finished tasks of the same size', () => {
  const tasks = [
    done('A', 'L', 1000, '2026-01-01T00:00:00Z'),
    done('B', 'L', 2000, '2026-01-02T00:00:00Z'),
    done('C', 'L', 3000, '2026-01-03T00:00:00Z'),
    done('D', 'L', 6000, '2026-01-04T00:00:00Z'),
    done('S1', 'S', 10, '2026-01-05T00:00:00Z'),
  ];
  assert.deepEqual(estimateTokens(tasks, usageOf, 'L', { window: 8, minSamples: 3 }), { estimate: 3000, samples: 4 });
  // window of 3 drops the oldest task
  assert.deepEqual(estimateTokens(tasks, usageOf, 'L', { window: 3, minSamples: 3 }), { estimate: 3667, samples: 3 });
});

test('no estimate (and therefore no limit) below the minimum number of samples', () => {
  const tasks = [done('A', 'M', 100, '2026-01-01T00:00:00Z'), done('B', 'M', 200, '2026-01-02T00:00:00Z')];
  assert.deepEqual(estimateTokens(tasks, usageOf, 'M', { minSamples: 3 }), { estimate: null, samples: 2 });
  const budget = budgetFor(null, 2);
  assert.equal(budgetState(budget, 1e12), 'ok');
});

test('unfinished tasks and tasks without usage do not count', () => {
  const tasks = [
    done('A', 'L', 1000, '2026-01-01T00:00:00Z'),
    { id: 'R', size: 'L', status: 'running', tokensUsed: 9e9 },
    done('Z', 'L', 0, '2026-01-02T00:00:00Z'),
    done('B', 'L', 3000, '2026-01-03T00:00:00Z'),
    done('C', 'L', 2000, '2026-01-04T00:00:00Z'),
  ];
  assert.deepEqual(estimateTokens(tasks, usageOf, 'L'), { estimate: 2000, samples: 3 });
});

test('limits are 150 percent hard and 160 percent after a positive review', () => {
  const budget = budgetFor(1000, 5);
  assert.equal(budget.hardLimit, 1500);
  assert.equal(budget.graceLimit, 1600);
  assert.equal(budgetState(budget, 1499), 'ok');
  assert.equal(budgetState(budget, 1500), 'review');
  const extended = { ...budget, extended: true };
  assert.equal(budgetState(extended, 1599), 'ok');
  assert.equal(budgetState(extended, 1600), 'exceeded');
});

test('after a human decision the budget is rebased on the current usage', () => {
  const rebased = rebaseBudget({ ...budgetFor(1000, 5), extended: true, reviewedAt: 'x' }, 1500);
  assert.equal(rebased.hardLimit, 2000);
  assert.equal(rebased.graceLimit, 2100);
  assert.equal(rebased.extended, false);
  assert.equal(budgetState(rebased, 1999), 'ok');
  assert.equal(budgetState(rebased, 2000), 'review');
});

test('the same failure on the same branch content has the same fingerprint, digits and spacing are ignored', () => {
  const a = failureFingerprint('Als done gemeldet, aber 1 Test(s) rot:  Gateway-Gesamtsuite 1273 pass', 'tree1');
  const b = failureFingerprint('als done gemeldet, aber 2 test(s) rot: gateway-gesamtsuite 1301 pass', 'tree1');
  assert.equal(a, b);
  assert.notEqual(a, failureFingerprint('als done gemeldet, aber 2 test(s) rot: gateway-gesamtsuite 1301 pass', 'tree2'));
  assert.notEqual(a, failureFingerprint('ein ganz anderer Fehler', 'tree1'));
});

test('verdict parsing only accepts an explicit finishable true', () => {
  assert.deepEqual(parseVerdict('Ergebnis: {"finishable": true, "reason": "nur Schlussprüfung offen"}'), { finishable: true, reason: 'nur Schlussprüfung offen' });
  assert.equal(parseVerdict('{"finishable": "yes"}').finishable, false);
  assert.equal(parseVerdict('kein json').finishable, false);
  assert.equal(parseVerdict(undefined).finishable, false);
});

test('review prompt carries the numbers and the remaining allowance', () => {
  const text = reviewPrompt({ task: { id: 'T-1', title: 'x' }, used: 1500, budget: budgetFor(1000, 3), handoff: 'H', diffStat: 'D' });
  assert.match(text, /T-1/);
  assert.match(text, /100 weiteren Tokens/);
  assert.match(text, /"finishable"/);
});
