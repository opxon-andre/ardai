import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (name) => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const defaults = JSON.parse(read('config.json'));
const brand = JSON.parse(read('brand.json'));

function fields(object, prefix = '') {
  return Object.entries(object).flatMap(([name, value]) => {
    const key = prefix ? prefix + '.' + name : name;
    const children = value !== null && typeof value === 'object' && !Array.isArray(value)
      ? fields(value, key) : [];
    return [{ key, value, container: children.length > 0 }, ...children];
  });
}

function checkReference(markdown, entries) {
  const rows = markdown.split(/\r?\n/);
  for (const { key, value, container } of entries) {
    const prefix = '| `' + key + '` | ';
    const row = rows.find((line) => line.startsWith(prefix));
    assert.ok(row, 'Missing configuration field: ' + key);
    // Nonempty objects have their own description and recursively checked children.
    // Arrays, null and empty objects must retain the exact JSON default.
    if (!container) {
      const expected = prefix + '`' + JSON.stringify(value) + '` | ';
      assert.ok(row.startsWith(expected), 'Incorrect documented default: ' + key);
    }
    assert.ok(row.split(' | ').at(-1).replace(/\|$/, '').trim(), 'Missing meaning: ' + key);
  }
}

for (const name of ['README.md', 'README.de.md']) {
  test(name + ': every default-config field and value is documented', () => {
    checkReference(read(name), fields(defaults));
    checkReference(read(name), fields(brand, 'brand'));
  });

  test(name + ': architecture, code states and review/merge sequence are present', () => {
    const blocks = [...read(name).matchAll(/```mermaid\r?\n([\s\S]*?)```/g)].map((m) => m[1]);
    assert.ok(blocks.length >= 3);
    assert.ok(blocks.some((b) => b.startsWith('flowchart') && b.includes('orchestrator.mjs')));
    const state = blocks.find((b) => b.startsWith('stateDiagram-v2'));
    assert.ok(state, 'Missing state machine');
    const runner = read('orchestrator.mjs');
    const codeStates = new Set([...runner.matchAll(/\b(?:task|t)\.status\s*(?:===|!==|=)\s*'([^']+)'/g)].map((m) => m[1]));
    codeStates.add(runner.match(/const DONE = '([^']+)'/)[1]);
    const aliases = new Map([...state.matchAll(/state "([^"]+)" as (\w+)/g)].map((m) => [m[2], m[1]]));
    const diagramStates = new Set();
    for (const edge of state.matchAll(/^\s*(\w+|\[\*\]) --> (\w+|\[\*\]):/gm)) {
      for (const node of [edge[1], edge[2]]) {
        if (node !== '[*]') diagramStates.add(aliases.get(node) || node);
      }
    }
    assert.deepEqual([...diagramStates].sort(), [...codeStates].sort(), 'Diagram states must match runner states');
    const sequence = blocks.find((b) => b.startsWith('sequenceDiagram'));
    assert.ok(sequence?.includes('result.json'));
    assert.ok(sequence.includes('integration'));
    assert.ok(sequence.includes('Human review'));
    assert.ok(sequence.indexOf('merge task branch into integration') < sequence.indexOf('review and merge integration into main'));
  });
}

test('documentation guard detects missing nested fields and stale defaults', () => {
  const doc = read('README.md');
  const missing = doc.split(/\r?\n/).filter((line) => !line.startsWith('| `agents.codex.bySize.S.args` | ')).join('\n');
  assert.throws(() => checkReference(missing, fields(defaults)), /Missing configuration field: agents.codex.bySize.S.args/);
  const changed = structuredClone(defaults);
  changed.maxAttempts += 1;
  assert.throws(() => checkReference(doc, fields(changed)), /Incorrect documented default: maxAttempts/);
});
