import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { UI_SCRIPT, STATIC_SCRIPT } from '../lib/ui-assets.mjs';

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

test('task sorting handles natural ticket order, all fields, reset and live refresh', async () => {
  const storage = new Map();
  let table, body, buttons, interval;
  const tasks = [
    { ticket: 'DEV-10', epic: 'EPIC-2', agent: 'codex2', status: 'Bereit' },
    { ticket: 'DEV-2', epic: 'EPIC-1', agent: 'claude', status: 'Läuft' },
    { ticket: 'DEV-1', epic: '', agent: '', status: 'Fertig' },
  ];
  function render() {
    body = { rows: tasks.map((task) => ({ checked: true, getAttribute: (key) => task[key.slice('data-sort-'.length)] })),
      appendChild(row) { this.rows.splice(this.rows.indexOf(row), 1); this.rows.push(row); } };
    buttons = Object.fromEntries(['ticket', 'epic', 'agent', 'status'].map((field) => [field, {
      parentNode: { setAttribute(key, value) { this[key] = value; } }, mark: {},
      getAttribute: () => field, querySelector() { return this.mark; },
      addEventListener(type, handler) { this[type] = handler; },
    }]));
    table = { querySelector: () => body, querySelectorAll: () => Object.values(buttons) };
  }
  render();
  const document = { querySelector: (selector) => selector === '#sec-tasks table' ? table : null,
    querySelectorAll: () => [], addEventListener() {},
    getElementById: (id) => id === 'app' ? { set innerHTML(value) { render(); } } : null };
  const context = { document, localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    window: { ORCHESTRATOR: { texts: {} }, scrollTo() {} }, sessionStorage: { getItem: () => null },
    setInterval: (fn) => { interval = fn; }, setTimeout() {}, clearTimeout() {},
    fetch: async () => ({ ok: true, text: async () => 'updated fragment' }),
  };
  const order = () => body.rows.map((row) => row.getAttribute('data-sort-ticket'));
  vm.runInNewContext(UI_SCRIPT, context);
  assert.deepEqual(order(), ['DEV-10', 'DEV-2', 'DEV-1']);
  const originalRows = body.rows.slice();
  buttons.ticket.click();
  assert.deepEqual(order(), ['DEV-1', 'DEV-2', 'DEV-10']);
  assert.equal(buttons.ticket.parentNode['aria-sort'], 'ascending');
  assert.ok(body.rows.every((row) => originalRows.includes(row) && row.checked));
  buttons.ticket.click();
  assert.deepEqual(order(), ['DEV-10', 'DEV-2', 'DEV-1']);
  assert.equal(buttons.ticket.parentNode['aria-sort'], 'descending');
  buttons.ticket.click();
  assert.equal(JSON.parse(storage.get('ardai-task-sort')), null);
  assert.equal(buttons.ticket.parentNode['aria-sort'], 'none');
  buttons.epic.click();
  assert.deepEqual(order(), ['DEV-2', 'DEV-10', 'DEV-1']);
  buttons.epic.click();
  assert.deepEqual(order(), ['DEV-10', 'DEV-2', 'DEV-1'], 'missing epic stays last in either direction');
  buttons.agent.click();
  assert.deepEqual(order(), ['DEV-2', 'DEV-10', 'DEV-1']);
  buttons.status.click();
  assert.deepEqual(order(), ['DEV-10', 'DEV-1', 'DEV-2']);
  buttons.ticket.click();
  interval();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order(), ['DEV-1', 'DEV-2', 'DEV-10']);
  assert.equal(buttons.ticket.parentNode['aria-sort'], 'ascending');
  render();
  vm.runInNewContext(STATIC_SCRIPT.replace('__REFRESH__', '60'), context);
  assert.deepEqual(order(), ['DEV-1', 'DEV-2', 'DEV-10'], 'saved choice also works in file reports');
});

test('mobile tabs persist across lazy updates and support keyboard navigation', async () => {
  const names = ['overview', 'tasks', 'questions', 'tests', 'activity'], storage = new Map();
  let tabs, panels, interval, requests = 0;
  function element(attrs) {
    return { attrs, listeners: {}, getAttribute(key) { return this.attrs[key]; },
      setAttribute(key, value) { this.attrs[key] = value; }, addEventListener(key, fn) { this.listeners[key] = fn; }, focus() { this.focused = true; } };
  }
  function render() { tabs = names.map((name) => element({ 'data-mobile-tab': name })); panels = names.map((name) => element({ 'data-mobile-panel': name })); }
  render();
  const app = { set innerHTML(value) { render(); } };
  vm.runInNewContext(UI_SCRIPT, {
    document: { querySelector: () => null, querySelectorAll: (selector) => selector === '[data-mobile-tab]' ? tabs : selector === '[data-mobile-panel]' ? panels : [],
      getElementById: (id) => id === 'app' ? app : null, addEventListener() {} },
    window: { ORCHESTRATOR: { lazy: true, texts: {} }, scrollTo() {} },
    localStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    setInterval: (fn) => { interval = fn; }, setTimeout() {}, clearTimeout() {},
    fetch: async () => { requests++; return { ok: true, text: async () => 'new fragment' }; },
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  await settle();
  assert.equal(requests, 1, 'lazy page requests content immediately');
  tabs[1].listeners.click();
  assert.equal(panels[1].attrs['data-mobile-active'], 'true');
  assert.equal(panels[0].attrs['data-mobile-active'], 'false');
  interval(); await settle();
  assert.equal(tabs[1].attrs['aria-selected'], 'true');
  assert.equal(storage.get('ardai-mobile-tab'), 'tasks');
  tabs[1].listeners.keydown({ key: 'ArrowRight', preventDefault() {} });
  assert.equal(tabs[2].attrs['aria-selected'], 'true');
  assert.equal(tabs[2].focused, true);
});
