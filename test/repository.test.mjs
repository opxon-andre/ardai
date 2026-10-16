import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('repository contains no removed brand in filenames or file contents', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const pattern = new RegExp(['kara', 'jan'].join(''), 'i');
  function scan(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['.git', 'node_modules'].includes(entry.name)) continue;
      const file = path.join(dir, entry.name);
      assert.doesNotMatch(path.relative(root, file), pattern);
      if (entry.isDirectory()) scan(file);
      else if (entry.isFile()) assert.doesNotMatch(fs.readFileSync(file).toString('utf8'), pattern, path.relative(root, file));
    }
  }
  scan(root);
});
