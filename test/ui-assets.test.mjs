import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { UI_SCRIPT } from '../lib/ui-assets.mjs';

test('reload button requests a restart and a changed server instance reloads the whole page', async () => {
  let click, interval, reloads = 0;
  const requests = [], toast = {}, button = { disabled: false,
    closest() { return this; }, getAttribute: (key) => key === 'data-action' ? 'reload' : null,
  };
  vm.runInNewContext(UI_SCRIPT, {
    document: {
      querySelectorAll: () => [], querySelector: () => null,
      getElementById: (id) => id === 'toast' ? toast : null,
      addEventListener: (type, fn) => { if (type === 'click') click = fn; },
    },
    window: { ORCHESTRATOR: { token: 'secret', instance: 'old', texts: {} } },
    location: { reload: () => { reloads++; } }, localStorage: { getItem: () => '[]' },
    setInterval: (fn) => { interval = fn; }, setTimeout() {}, clearTimeout() {},
    fetch: async (url, options) => {
      requests.push({ url, options });
      return url === '/api/reload'
        ? { json: async () => ({ ok: true, message: 'Reload requested' }) }
        : { ok: true, text: async () => '<div data-ui-instance="new"></div>' };
    },
  });
  click({ target: button });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(button.disabled, true);
  assert.equal(requests[0].url, '/api/reload');
  assert.equal(requests[0].options.headers['X-Orchestrator-Token'], 'secret');
  assert.equal(reloads, 1);
  interval();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reloads, 2, 'periodic reconnect also detects a restarted server');
});

test('bulk archive preserves selection across refresh, selects all and submits one batch', async () => {
  function element(attrs = {}) {
    return { checked: false, disabled: false, textContent: '', listeners: {},
      getAttribute: (key) => attrs[key] ?? null,
      addEventListener(type, listener) { this.listeners[type] = listener; },
      closest() { return this; },
    };
  }
  let boxes, all, button, count;
  const render = (ids) => {
    boxes = ids.map((id) => element({ 'data-archive-task': id }));
    all = element();
    button = element({ 'data-action': 'archive-selected' });
    count = element();
  };
  render(['NEW', 'OLD']);
  const toast = element(), listeners = {}, requests = [];
  let interval, responseOk = false, nextIds = ['NEW', 'OLD'];
  const app = { set innerHTML(html) { render(JSON.parse(html)); } };
  const document = {
    querySelectorAll: (selector) => selector === 'input[data-archive-task]' ? boxes : [],
    querySelector: (selector) => ({ 'input[data-archive-all]': all, 'button[data-action="archive-selected"]': button, '[data-archive-count]': count })[selector],
    getElementById: (id) => ({ app, toast })[id],
    addEventListener: (type, listener) => { listeners[type] = listener; },
  };
  vm.runInNewContext(UI_SCRIPT, {
    document, window: { ORCHESTRATOR: { token: 'test', texts: { error: 'Error' } }, scrollTo() {} },
    localStorage: { getItem: () => '[]' }, setInterval: (fn) => { interval = fn; }, setTimeout() {}, clearTimeout() {},
    fetch: async (url, options) => {
      if (url === '/fragment') return { ok: true, text: async () => JSON.stringify(nextIds) };
      requests.push({ url, body: JSON.parse(options.body) });
      return { json: async () => ({ ok: responseOk }) };
    },
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  assert.equal(button.disabled, true);
  boxes[0].checked = true;
  boxes[0].listeners.change();
  assert.equal(count.textContent, 1);
  assert.equal(all.indeterminate, true);
  interval();
  await settle();
  assert.equal(boxes[0].checked, true);
  assert.equal(boxes[1].checked, false);
  all.checked = true;
  all.listeners.change();
  assert.ok(boxes.every((box) => box.checked));
  assert.equal(count.textContent, 2);
  listeners.click({ target: button });
  await settle();
  assert.deepEqual(requests, [{ url: '/api/archive', body: { tasks: ['NEW', 'OLD'] } }]);
  assert.equal(count.textContent, 2, 'failed request keeps the selection');
  responseOk = true;
  listeners.click({ target: button });
  await settle();
  assert.equal(count.textContent, 0);
  assert.equal(button.disabled, true);
  all.checked = true;
  all.listeners.change();
  nextIds = ['OLD'];
  interval();
  await settle();
  assert.equal(count.textContent, 1, 'tasks that become ineligible are removed from the selection');
  all.checked = false;
  all.listeners.change();
  assert.equal(button.disabled, true);
});
