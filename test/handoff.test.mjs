import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compact, summarize, step, show } from '../lib/handoff.mjs';

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'orchestrator.mjs');
const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

function fixture(branch = 'task/T-1') {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-test-'));
  const remote = path.join(base, 'remote.git');
  const work = path.join(base, 'work');
  git(base, 'init', '--bare', '-q', '-b', 'main', remote);
  git(base, 'clone', '-q', remote, work);
  git(work, 'config', 'user.email', 'test@example.org');
  git(work, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(work, 'a.txt'), 'a');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'init');
  git(work, 'push', '-q', 'origin', 'HEAD:main');
  git(work, 'checkout', '-q', '-b', branch);
  return { base, remote, work, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test('step DONE appends the entry, commits everything and pushes in one call', (t) => {
  const f = fixture();
  t.after(f.cleanup);
  fs.writeFileSync(path.join(f.work, 'feature.txt'), 'x');
  const result = step('DONE', 'Funktion fertig, Tests grün', { cwd: f.work, agent: 'codex' });
  assert.equal(result.committed, true);
  assert.equal(result.pushed, true);
  const log = fs.readFileSync(path.join(f.work, '.handoff', 'T-1.md'), 'utf8');
  assert.match(log, /\[codex\] DONE\s+Funktion fertig, Tests grün/);
  assert.equal(git(f.work, 'log', '-1', '--format=%s'), 'T-1: Funktion fertig, Tests grün');
  assert.equal(git(f.remote, 'rev-parse', 'task/T-1'), git(f.work, 'rev-parse', 'HEAD'));
});

test('step NOTE and START only write the entry, nothing is committed', (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const before = git(f.work, 'rev-parse', 'HEAD');
  const result = step('NOTE', 'Annahme: Default 50', { cwd: f.work });
  step('START', 'Teilziel 2', { cwd: f.work });
  assert.equal(result.committed, false);
  assert.equal(git(f.work, 'rev-parse', 'HEAD'), before);
  const open = show({ cwd: f.work });
  assert.match(open, /OFFEN/);
  assert.match(open, /Teilziel 2/);
});

test('step refuses main and non-task branches', (t) => {
  const f = fixture('main2');
  t.after(f.cleanup);
  assert.throws(() => step('NOTE', 'x', { cwd: f.work }), /kein Task-Branch/);
});

test('a failing push is reported but the commit and the entry are kept', (t) => {
  const f = fixture();
  t.after(f.cleanup);
  git(f.work, 'remote', 'set-url', 'origin', path.join(f.base, 'does-not-exist.git'));
  fs.writeFileSync(path.join(f.work, 'b.txt'), 'b');
  assert.throws(() => step('DONE', 'Teil', { cwd: f.work }), /push fehlgeschlagen/);
  assert.equal(git(f.work, 'log', '-1', '--format=%s'), 'T-1: Teil');
});

test('compact folds old entries into one line and keeps the recent ones', () => {
  const lines = ['# T', '', '## Plan', 'p', '## Log'];
  for (let i = 0; i < 100; i++) lines.push(`- 2026-10-17T10:${String(i % 60).padStart(2, '0')}Z [codex] DONE  Schritt ${i}`);
  const out = compact(lines, { keep: 40, above: 80 });
  const entries = out.filter((l) => /^- 2026/.test(l));
  assert.equal(entries.length, 40);
  assert.ok(out.some((l) => l.startsWith('- (verdichtet) 60')));
  assert.match(entries[entries.length - 1], /Schritt 99/);
  assert.equal(compact(lines.slice(0, 20)).length, 20, 'small files stay untouched');
});

test('summarize shows plan, recent entries and open START entries', () => {
  const lines = ['# T', '', '## Plan', '1. a', '2. b', '', '## Log',
    '- 2026-10-17T10:00Z [codex] START  A', '- 2026-10-17T10:05Z [codex] DONE   A', '- 2026-10-17T10:06Z [codex] START  B'];
  const text = summarize(lines, 2);
  assert.match(text, /## Plan/);
  assert.match(text, /Letzte 2 von 3/);
  assert.match(text, /OFFEN[^]*START  B/);
});

test('CLI: step and handoff run from the worktree without a project configuration', (t) => {
  const f = fixture();
  t.after(f.cleanup);
  fs.writeFileSync(path.join(f.work, 'c.txt'), 'c');
  const done = spawnSync('node', [cli, 'step', 'DONE', 'CLI', 'Test'], { cwd: f.work, encoding: 'utf8', env: { ...process.env, ORCHESTRATOR_AGENT: 'claude' } });
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /DONE T-1 \S+ gepusht/);
  const shown = spawnSync('node', [cli, 'handoff'], { cwd: f.work, encoding: 'utf8' });
  assert.equal(shown.status, 0);
  assert.match(shown.stdout, /\[claude\] DONE\s+CLI Test/);
  assert.equal(spawnSync('node', [cli, 'step', 'DONE'], { cwd: f.work, encoding: 'utf8' }).status, 1, 'text is required');
});
