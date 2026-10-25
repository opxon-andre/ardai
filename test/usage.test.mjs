import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { taskUsage, projectUsage, agentUsage, capacity, formatTokens, formatDuration } from '../lib/usage.mjs';
import { parseLogName, tailActivity } from '../lib/activity.mjs';

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

test('sibling and custom agent logs contribute activity, usage and family capacity', (t) => {
  const root = fixture(t);
  const agents = { 'review-claude': { kind: 'claude' }, codex2: { kind: 'codex' } };
  const file = log(root, 'DEV-1-review-claude-1000.jsonl', [
    { type: 'result', usage: { input_tokens: 10, output_tokens: 2 } },
    { type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: 9999999999 } } } },
  ]);
  const codex = log(root, 'DEV-1-codex2-1200.jsonl', [
    { type: 'item.completed', item: { type: 'agent_message', text: 'Working in second Codex' } },
    { type: 'turn.completed', usage: { input_tokens: 20, output_tokens: 3 } },
  ]);
  assert.equal(parseLogName(file, agents).agent, 'review-claude');
  assert.equal(parseLogName(codex).agent, 'codex2');
  assert.equal(parseLogName(codex).task, 'DEV-1');
  assert.equal(tailActivity(codex).items[0].text, 'Working in second Codex');
  assert.equal(tailActivity(file, 30, 2000000, undefined, agents).items[0].text, 'Lauf beendet');
  assert.equal(taskUsage(root, 'DEV-1', agents).total, 35);
  assert.deepEqual(taskUsage(root, 'DEV-1', agents).byAgent, { 'review-claude': 12, codex2: 23 });
  assert.equal(capacity(root, undefined, agents).claude.windows[0].percent, 10);
});

test('family token totals count each run once, include imports and refresh partial usage', (t) => {
  const root = fixture(t);
  const agents = { helper: { kind: 'claude' } };
  assert.deepEqual(agentUsage(root, agents), {});
  log(root, 'ARCHIVED-1-codex-1000.jsonl', [{ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 } }]);
  log(root, 'ARCHIVED-1-codex2-1200.jsonl', [{ type: 'turn.completed', usage: { input_tokens: 20, cached_input_tokens: 5, output_tokens: 2 } }]);
  const partial = log(root, 'import-helper-1500.jsonl', [
    { type: 'assistant', message: { id: 'm', usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 20, output_tokens: 3 } } },
    { type: 'assistant', message: { id: 'm', usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 20, output_tokens: 3 } } },
  ]);
  let totals = agentUsage(root, agents);
  assert.deepEqual(totals.codex, { input: 120, fresh: 75, cached: 45, output: 12, total: 132, final: true, runs: 2 });
  assert.deepEqual(totals.claude, { input: 35, fresh: 15, cached: 20, output: 3, total: 38, final: false, runs: 1 });
  fs.appendFileSync(partial, JSON.stringify({ type: 'result', usage: { input_tokens: 12, cache_read_input_tokens: 20, output_tokens: 8 } }) + '\n');
  totals = agentUsage(root, agents);
  assert.deepEqual(totals.claude, { input: 32, fresh: 12, cached: 20, output: 8, total: 40, final: true, runs: 1 });
});

test('report usage scans logs once for all tickets and preserves task and family totals', (t) => {
  const root = fixture(t);
  const agents = { helper: { kind: 'claude' } };
  log(root, 'A-codex-1000.jsonl', [{ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } }]);
  log(root, 'A-codex2-1500.jsonl', [{ type: 'turn.completed', usage: { input_tokens: 20, cached_input_tokens: 5, output_tokens: 3 } }]);
  const file = log(root, 'B-helper-1800.jsonl', [{ type: 'assistant', message: { id: 'm', usage: { input_tokens: 10, output_tokens: 1 } } }]);
  const expected = { tasks: Object.fromEntries(['A', 'B'].map((id) => [id, taskUsage(root, id, agents)])), agents: agentUsage(root, agents) };
  const readdir = fs.readdirSync;
  let scans = 0;
  t.mock.method(fs, 'readdirSync', (...args) => { if (args[0] === root) scans++; return readdir(...args); });
  assert.deepEqual(projectUsage(root, agents), expected);
  assert.equal(scans, 1);
  fs.appendFileSync(file, JSON.stringify({ type: 'result', usage: { input_tokens: 12, output_tokens: 4 } }) + '\n');
  const updated = projectUsage(root, agents);
  assert.equal(scans, 2);
  assert.equal(updated.tasks.B.total, 16);
  assert.equal(updated.agents.claude.total, 16);
});
