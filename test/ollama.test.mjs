import test from 'node:test';
import assert from 'node:assert/strict';
import { createPolisher } from '../lib/ollama.mjs';

const reply = (content, ok = true) => async () => ({ ok, json: async () => ({ message: { content } }) });
const action = { comment: 'ardai: fertig (Branch task/T-1).\n\nTests: 3 von 5 bestanden.', branch: 'task/T-1' };

test('polisher is off by default', () => {
  assert.equal(createPolisher({}), null);
  assert.equal(createPolisher(), null);
});

test('polisher returns the rewritten text when branch and test counts survive', async () => {
  const polish = createPolisher({ enabled: true }, { fetchImpl: reply('Fertig auf task/T-1. Tests: 3 von 5 bestanden.') });
  assert.equal(await polish(action), 'Fertig auf task/T-1. Tests: 3 von 5 bestanden.');
});

test('polisher falls back (null) on errors, timeouts, lost facts or overlong answers', async () => {
  const bad = [
    reply('x', false),
    reply('Fertig. Tests: 3 von 5 bestanden.'), // branch lost
    reply('Fertig auf task/T-1.'), // test count lost
    reply('task/T-1 3 von 5 ' + 'x'.repeat(2000)),
    async () => { throw new Error('ECONNREFUSED'); },
  ];
  for (const fetchImpl of bad) assert.equal(await createPolisher({ enabled: true }, { fetchImpl })(action), null);
});

test('polisher handles one request at a time', async () => {
  let active = 0; let peak = 0;
  const fetchImpl = async () => {
    peak = Math.max(peak, ++active);
    await new Promise((r) => setTimeout(r, 10));
    active--;
    return { ok: true, json: async () => ({ message: { content: 'task/T-1 3 von 5' } }) };
  };
  const polish = createPolisher({ enabled: true }, { fetchImpl });
  const results = await Promise.all([polish(action), polish(action), polish(action)]);
  assert.equal(peak, 1);
  assert.equal(results.filter((r) => r === null).length, 2, 'busy model falls back to templates instead of blocking the ticket queue');
});
