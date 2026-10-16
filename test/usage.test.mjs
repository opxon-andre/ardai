import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { taskUsage, capacity, formatTokens, formatDuration } from '../lib/usage.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(new URL('.usage-', import.meta.url));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function log(root, name, events, end = 2000) {
  const file = path.join(root, name);
  fs.writeFileSync(file, events.map((e) => typeof e === 'string' ? e : JSON.stringify(e)).join('\n') + '\n');
  fs.utimesSync(file, end / 1000, end / 1000);
  return file;
}

test('usage sums resumed runs for both agents and prefers final Claude totals', (t) => {
  const root = fixture(t);
  log(root, 'A-claude-1000.jsonl', [
    { type: 'assistant', message: { id: 'm1', usage: { input_tokens: 999 } } },
    { type: 'result', usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 20, output_tokens: 3 }, total_cost_usd: 0.25 },
  ]);
  log(root, 'A-codex-3000.jsonl', [
    { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 5, reasoning_output_tokens: 2 } },
    { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 20, output_tokens: 1 } },
  ], 5000);
  log(root, 'B-codex-1000.jsonl', [{ type: 'turn.completed', usage: { input_tokens: 9999 } }]);
  assert.deepEqual(taskUsage(root, 'A'), {
    fresh: 75, cached: 80, output: 11, costUsd: 0.25, final: true, runs: 2,
    agentMs: 3000, startMs: 1000, endMs: 5000, byAgent: { claude: 38, codex: 128 }, total: 166,
  });
});

test('partial logs deduplicate Claude messages, ignore corrupt events and refresh after append', (t) => {
  const root = fixture(t);
  const ev = { type: 'assistant', message: { id: 'same', usage: { input_tokens: 7, output_tokens: 2 } } };
  const file = log(root, 'A-claude-1000.jsonl', ['{"usage":broken', ev, ev, { type: 'unrelated', usage: {} }]);
  const u = taskUsage(root, 'A');
  assert.equal(u.fresh, 7);
  assert.equal(u.output, 2);
  assert.equal(u.final, false);
  fs.appendFileSync(file, JSON.stringify({ type: 'result', usage: { input_tokens: 12 }, total_cost_usd: 1 }) + '\n');
  assert.equal(taskUsage(root, 'A').fresh, 12);
  assert.equal(taskUsage(root, 'A').final, true);
  assert.equal(taskUsage(root, 'missing'), null);
  assert.equal(taskUsage(path.join(root, 'missing'), 'A'), null);
});

test('capacity reads newest valid windows and clears expired quotas at a fixed time', (t) => {
  const root = fixture(t);
  t.mock.method(Date, 'now', () => 2000000);
  log(root, 'A-claude-1000.jsonl', [{ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: {
    five_hour: { utilization: 0.975, resetsAt: 3000 }, seven_day: { utilization: 1, resetsAt: 1000 },
  } } }], 1800000);
  log(root, 'A-claude-2000.jsonl', ['{"usage":bad']);
  log(root, 'rollout-001.jsonl', [{ timestamp: '1970-01-01T00:25:00Z', payload: { rate_limits: {
    primary: { window_minutes: 300, used_percent: 45, resets_at: 3000 },
    secondary: { window_minutes: 10080, used_percent: 99, resets_at: 1000 },
  } } }, '{"rate_limits":broken']);
  log(root, 'rollout-002.jsonl', [{ payload: { rate_limits: null } }]);
  assert.deepEqual(capacity(root, root), {
    claude: { at: 1800000, windows: [
      { label: '5 Stunden', percent: 98, resetsAt: 3000000 },
      { label: 'Woche', percent: 0, resetsAt: null, reset: true, resetAt: 1000000 },
    ] },
    codex: { at: 1500000, windows: [
      { label: '5 Stunden', percent: 45, resetsAt: 3000000 },
      { label: 'Woche', percent: 0, resetsAt: null, reset: true, resetAt: 1000000 },
    ] },
  });
});

test('capacity without logs stays unknown and missing windows are omitted', (t) => {
  const root = fixture(t);
  assert.deepEqual(capacity(root, root), {});
  log(root, 'A-claude-1000.jsonl', [{ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: {} } } }]);
  assert.deepEqual(capacity(root).claude.windows, []);
});

test('usage formatting handles thresholds and invalid durations', () => {
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(1000), '1 Tsd.');
  assert.equal(formatTokens(1500000), '1,5 Mio.');
  for (const ms of [0, -1, NaN, Infinity]) assert.equal(formatDuration(ms), '–');
  assert.equal(formatDuration(1000), '< 1 min');
  assert.equal(formatDuration(60000), '1 min');
  assert.equal(formatDuration(3660000), '1 h 01 min');
});
