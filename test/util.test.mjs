import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJsonAtomic, expandEnv, pathsOverlap, sh } from '../lib/util.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(new URL('.util-', import.meta.url));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, 'state.json');
}
const error = (code) => Object.assign(new Error(code), { code });

test('atomic JSON roundtrip and fallback only for missing files', (t) => {
  const file = fixture(t);
  const fallback = { tasks: [] };
  assert.equal(readJson(file, fallback), fallback);
  assert.throws(() => readJson(file), { code: 'ENOENT' });
  writeJsonAtomic(file, { tasks: ['A'] });
  assert.deepEqual(readJson(file), { tasks: ['A'] });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['state.json']);
  fs.writeFileSync(file, '{bad');
  assert.throws(() => readJson(file, fallback), SyntaxError);
});

test('EPERM reads retry and transient atomic renames preserve the old file until success', (t) => {
  const file = fixture(t);
  writeJsonAtomic(file, { old: true });
  const read = fs.readFileSync;
  const rename = fs.renameSync;
  let reads = 0;
  t.mock.method(Atomics, 'wait', () => 'timed-out');
  const reader = t.mock.method(fs, 'readFileSync', (...args) => {
    if (++reads === 1) throw error('EPERM');
    return read(...args);
  });
  assert.deepEqual(readJson(file), { old: true });
  assert.equal(reads, 2);
  reader.mock.restore();
  let renames = 0;
  t.mock.method(fs, 'renameSync', (...args) => {
    assert.deepEqual(JSON.parse(read(file, 'utf8')), { old: true });
    if (++renames <= 3) throw error(['EPERM', 'EBUSY', 'EACCES'][renames - 1]);
    return rename(...args);
  });
  writeJsonAtomic(file, { new: true });
  assert.equal(renames, 4);
  assert.deepEqual(readJson(file), { new: true });
});

test('permanent EPERM exhausts bounded retries and removes temp file without replacing state', (t) => {
  const file = fixture(t);
  writeJsonAtomic(file, { keep: true });
  const pause = t.mock.method(Atomics, 'wait', () => 'timed-out');
  const rename = t.mock.method(fs, 'renameSync', () => { throw error('EPERM'); });
  assert.throws(() => writeJsonAtomic(file, {}), { code: 'EPERM' });
  assert.equal(rename.mock.callCount(), 41);
  assert.equal(pause.mock.callCount(), 40);
  assert.deepEqual(readJson(file), { keep: true });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['state.json']);
});

test('nontransient errors propagate immediately, even with a read fallback', (t) => {
  const file = fixture(t);
  const pause = t.mock.method(Atomics, 'wait', () => 'timed-out');
  const read = t.mock.method(fs, 'readFileSync', () => { throw error('EIO'); });
  assert.throws(() => readJson(file, {}), { code: 'EIO' });
  assert.equal(read.mock.callCount(), 1);
  assert.equal(pause.mock.callCount(), 0);
});

test('domain overlap normalizes Windows paths, wildcards and global domains', () => {
  for (const [a, b] of [[['src\\rules\\'], ['src/rules/a.mjs']], [['src/*'], ['src/a']], [['*'], ['other/']]]) {
    assert.equal(pathsOverlap(a, b), true);
    assert.equal(pathsOverlap(b, a), true);
  }
  assert.equal(pathsOverlap(['src/'], ['test/']), false);
  assert.equal(pathsOverlap([], ['src/']), false);
});

test('environment expansion preserves unknown variables; shell helper reports local failures', (t) => {
  t.mock.property(process, 'env', { ...process.env, ARDAI_A5_TEST_VALUE: 'fixture' });
  assert.equal(expandEnv('%ARDAI_A5_TEST_VALUE%/%ARDAI_A5_UNKNOWN%'), 'fixture/%ARDAI_A5_UNKNOWN%');
  assert.deepEqual(sh(process.execPath, ['-e', 'console.log(" ok ")']), { code: 0, stdout: 'ok', stderr: '' });
  const args = ['-e', 'console.error("failed"); process.exit(7)'];
  assert.throws(() => sh(process.execPath, args), (e) => e.result.code === 7 && e.result.stderr === 'failed');
  assert.equal(sh(process.execPath, args, { check: false }).code, 7);
});
