// Client-side assets of the status page / web UI (plain ES5, no build step).

// Static report file: reload periodically, keep expanded logs and scroll position.
export const STATIC_SCRIPT = `
(function () {
  var KEY = 'orchestrator-open';
  var open = [];
  try { open = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) {}
  document.querySelectorAll('details[id]').forEach(function (d) {
    if (open.indexOf(d.id) >= 0) d.open = true;
    d.addEventListener('toggle', function () {
      var ids = Array.prototype.map.call(document.querySelectorAll('details[id][open]'), function (x) { return x.id; });
      try { localStorage.setItem(KEY, JSON.stringify(ids)); } catch (e) {}
    });
  });
  try { var y = sessionStorage.getItem('orchestrator-scroll'); if (y) window.scrollTo(0, Number(y)); } catch (e) {}
  setTimeout(function () {
    try { sessionStorage.setItem('orchestrator-scroll', String(window.scrollY)); } catch (e) {}
    location.reload();
  }, __REFRESH__ * 1000);
})();`;

// Web UI served by orchestrator: actions via POST /api/<action>, content refresh via
// GET /fragment. Refresh pauses while the user is typing so input is never lost.
export const UI_SCRIPT = `
(function () {
  var K = window.ORCHESTRATOR, OPEN_KEY = 'orchestrator-open';
  var openIds = [], archiveSelection = [], reloadPending = false;
  try { openIds = JSON.parse(localStorage.getItem(OPEN_KEY) || '[]'); } catch (e) {}

  function fill(s, v) { return s.replace(/\\{(\\w+)\\}/g, function (_, k) { return v[k] != null ? v[k] : ''; }); }
  function toast(msg, bad) {
    var el = document.getElementById('toast');
    el.textContent = msg; el.className = 'show' + (bad ? ' bad' : '');
    clearTimeout(el._t); el._t = setTimeout(function () { el.className = ''; }, 7000);
  }
  function post(action, body, onSuccess) {
    return fetch('/api/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Orchestrator-Token': K.token }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json(); })
      .then(function (j) { toast(j.message || (j.ok ? 'OK' : K.texts.error), !j.ok); if (action === 'reload' && !j.ok) reloadPending = false; if (j.ok && onSuccess) onSuccess(); refresh(true); })
      .catch(function (e) { toast(K.texts.error + ': ' + e, true); });
  }
  function archiveBoxes() { return Array.prototype.slice.call(document.querySelectorAll('input[data-archive-task]')); }
  function updateArchiveSelection() {
    var boxes = archiveBoxes(), count = archiveSelection.length;
    boxes.forEach(function (cb) { cb.checked = archiveSelection.indexOf(cb.getAttribute('data-archive-task')) >= 0; });
    var all = document.querySelector('input[data-archive-all]');
    if (all) { all.checked = count > 0 && count === boxes.length; all.indeterminate = count > 0 && count < boxes.length; }
    var button = document.querySelector('button[data-action="archive-selected"]');
    if (button) button.disabled = count === 0;
    var label = document.querySelector('[data-archive-count]');
    if (label) label.textContent = count;
  }
  function bind() {
    document.querySelectorAll('details[id]').forEach(function (d) {
      if (openIds.indexOf(d.id) >= 0) d.open = true;
      d.addEventListener('toggle', function () {
        openIds = Array.prototype.map.call(document.querySelectorAll('details[id][open]'), function (x) { return x.id; });
        try { localStorage.setItem(OPEN_KEY, JSON.stringify(openIds)); } catch (e) {}
      });
    });
    var boxes = archiveBoxes();
    var ids = boxes.map(function (cb) { return cb.getAttribute('data-archive-task'); });
    archiveSelection = archiveSelection.filter(function (id) { return ids.indexOf(id) >= 0; });
    boxes.forEach(function (cb) {
      cb.addEventListener('change', function () {
        var id = cb.getAttribute('data-archive-task');
        archiveSelection = archiveSelection.filter(function (x) { return x !== id; });
        if (cb.checked) archiveSelection.push(id);
        updateArchiveSelection();
      });
    });
    var all = document.querySelector('input[data-archive-all]');
    if (all) all.addEventListener('change', function () { archiveSelection = all.checked ? ids.slice() : []; updateArchiveSelection(); });
    updateArchiveSelection();
    var f = document.getElementById('newjob');
    if (f) {
      Array.prototype.forEach.call(f.querySelectorAll('input[name=mode]'), function (r) {
        r.addEventListener('change', function () { var q = f.elements.q; q.placeholder = f.elements.mode.value === 'jql' ? q.getAttribute('data-ph-jql') : q.getAttribute('data-ph-keys'); });
      });
      f.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var q = f.elements.q.value.trim(); if (!q) return;
        var body = f.elements.mode.value === 'jql' ? { jql: q } : { keys: q.split(/[\\s,;]+/).filter(Boolean) };
        f.reset(); post('work', body);
      });
    }
    Array.prototype.forEach.call(document.querySelectorAll('input[data-overage]'), function (cb) {
      cb.addEventListener('change', function () { post('overage', { agent: cb.getAttribute('data-overage'), enabled: cb.checked }); });
    });
    Array.prototype.forEach.call(document.querySelectorAll('form[data-answer]'), function (fm) {
      fm.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var text = fm.elements.text.value.trim(); if (!text) return;
        var id = fm.getAttribute('data-answer'); fm.reset(); post('answer', { id: id, text: text });
      });
    });
  }
  document.addEventListener('click', function (ev) {
    var b = ev.target.closest && ev.target.closest('button[data-action]'); if (!b) return;
    var a = b.getAttribute('data-action'), task = b.getAttribute('data-task'), v = { task: task, branch: b.getAttribute('data-branch') };
    if (a === 'reload') { reloadPending = true; b.disabled = true; post('reload', {}); return; }
    if (a === 'archive-selected') {
      var selected = archiveSelection.slice();
      if (selected.length) post('archive', { tasks: selected }, function () {
        archiveSelection = archiveSelection.filter(function (id) { return selected.indexOf(id) < 0; });
      });
      return;
    }
    if (a === 'stop-all') { if (confirm(K.texts.stopAllConfirm)) post('stop', {}); return; }
    if (a === 'stop') { if (confirm(fill(K.texts.stopConfirm, v))) post('stop', { task: task }); return; }
    if (a === 'clean') { var typed = prompt(fill(K.texts.cleanPrompt, v)); if (typed !== null && typed.trim() === task) post('clean', { task: task, confirm: task }); return; }
    post(a, { task: task });
  });
  function userBusy() {
    var el = document.activeElement;
    if (el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.type === 'text'))) return true;
    return Array.prototype.some.call(document.querySelectorAll('#app input[type=text], #app textarea'), function (i) { return i.value.trim() !== ''; });
  }
  function refresh(force) {
    if (!force && !reloadPending && userBusy()) return;
    fetch('/fragment', { headers: { 'X-Orchestrator-Token': K.token } })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.text(); })
      .then(function (html) {
        var instance = html.match(/data-ui-instance="([^"]+)"/);
        if (K.instance && instance && instance[1] !== K.instance) { location.reload(); return; }
        var y = window.scrollY; document.getElementById('app').innerHTML = html; bind(); window.scrollTo(0, y);
      })
      .catch(function () {});
  }
  bind();
  setInterval(function () { refresh(false); }, 4000);
})();`;

export const UI_CSS = `
.controls { display:flex; flex-wrap:wrap; gap:12px; align-items:center; margin:16px 0; padding:12px 16px; background:var(--card); border:1px solid var(--line); border-radius:8px; }
.newjob { display:flex; flex-wrap:wrap; gap:8px 12px; align-items:center; flex:1; min-width:280px; }
.newjob label { font-size:13px; white-space:nowrap; }
.newjob input[type=text] { flex:1; min-width:180px; }
input[type=text], textarea { font:inherit; font-size:14px; padding:6px 8px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--fg); }
textarea { width:100%; min-width:180px; resize:vertical; }
.btn { font:inherit; font-size:13px; padding:5px 12px; border-radius:6px; border:1px solid var(--line); background:var(--card); color:var(--fg); cursor:pointer; white-space:nowrap; }
.bulk-actions { margin-bottom:10px; }
.btn:disabled { opacity:.5; cursor:default; }
.btn:hover { border-color:var(--muted); }
.btn:focus-visible, input:focus-visible, textarea:focus-visible { outline:2px solid var(--m-norm); outline-offset:1px; }
.btn.primary { background:var(--m-norm); border-color:var(--m-norm); color:#fff; }
.btn[data-danger] { color:var(--bad); border-color:color-mix(in srgb, var(--bad) 45%, var(--line)); }
td.actions { white-space:nowrap; }
td.actions .btn { margin:2px 0; }
td.answer form { display:flex; flex-direction:column; gap:6px; align-items:flex-start; }
.runner { font-size:13px; white-space:nowrap; }
.runner.on { color:var(--ok); font-weight:600; } .runner.off { color:var(--muted); }
#toast { position:fixed; left:50%; bottom:20px; transform:translate(-50%, 20px); opacity:0; transition:opacity .2s, transform .2s; background:var(--fg); color:var(--bg); padding:10px 16px; border-radius:8px; max-width:min(90vw, 640px); pointer-events:none; z-index:10; font-size:14px; }
#toast.show { opacity:1; transform:translate(-50%, 0); }
#toast.bad { background:var(--bad); color:#fff; }
`;
