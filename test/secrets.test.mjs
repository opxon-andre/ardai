import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mergeNewSecrets } from '../lib/secrets.mjs';

test('mergeNewSecrets adds only new files and never overwrites existing ones', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ardai-sec-'));
  const from = path.join(root, 'from');
  const to = path.join(root, 'to');
  fs.mkdirSync(path.join(from, 'gateway'), { recursive: true });
  fs.mkdirSync(path.join(to, 'gateway'), { recursive: true });
  fs.writeFileSync(path.join(from, 'gateway', 'old.txt'), 'new-value');
  fs.writeFileSync(path.join(to, 'gateway', 'old.txt'), 'kept');
  fs.writeFileSync(path.join(from, 'gateway', 'fresh.txt'), 'fresh');
  fs.mkdirSync(path.join(from, 'datahub'), { recursive: true });
  fs.writeFileSync(path.join(from, 'datahub', 'token.txt'), 'tok');
  assert.equal(mergeNewSecrets(from, to), 2);
  assert.equal(fs.readFileSync(path.join(to, 'gateway', 'old.txt'), 'utf8'), 'kept');
  assert.equal(fs.readFileSync(path.join(to, 'gateway', 'fresh.txt'), 'utf8'), 'fresh');
  assert.equal(fs.readFileSync(path.join(to, 'datahub', 'token.txt'), 'utf8'), 'tok');
  assert.equal(mergeNewSecrets(path.join(root, 'missing'), to), 0);
  fs.rmSync(root, { recursive: true, force: true });
});
