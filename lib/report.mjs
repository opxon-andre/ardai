import fs from 'node:fs';
import path from 'node:path';
import { formatTokens, formatDuration } from './usage.mjs';
import { STATIC_SCRIPT, UI_SCRIPT, UI_CSS } from './ui-assets.mjs';

import { DEFAULT_BRAND, resolveBrand, isOrchestratorAgent } from './brand.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmt = (iso) => (iso ? new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : '');

const RESULT_LABEL = { pass: 'Grün', fail: 'Rot', skip: 'Übersprungen' };
const KIND_LABEL = { check: 'Code-Check', ac: 'Akzeptanzkriterium', playwright: 'Playwright', container: 'Container' };
const STATUS_LABEL = {
  ready: 'Bereit', running: 'Läuft', interrupted: 'Unterbrochen', 'needs-human': 'Wartet auf Mensch',
  failed: 'Fehlgeschlagen', stopped: 'Gestoppt', done: 'Fertig (in integration)', blocked: 'Wartet auf Abhängigkeit',
};

// Pro Aufgabe zählen nur die Ergebnisse ihres letzten Laufs (alle Einträge
// eines Laufs tragen denselben Zeitstempel). Ein Abgleich über den Wortlaut des
// Kriteriums reicht nicht: Agenten formulieren dasselbe Kriterium je Lauf anders,
// alte rote Einträge blieben sonst stehen, obwohl der letzte Lauf grün war.
function latestResults(results) {
  const lastRun = new Map();
  for (const r of results) if (!lastRun.has(r.taskId) || r.at > lastRun.get(r.taskId)) lastRun.set(r.taskId, r.at);
  const runCount = new Map();
  for (const r of results) {
    const runs = runCount.get(r.taskId) || new Set();
    runs.add(r.at);
    runCount.set(r.taskId, runs);
  }
  return results
    .filter((r) => r.at === lastRun.get(r.taskId))
    .map((r) => ({ ...r, runs: runCount.get(r.taskId).size }));
}

// Ticket-Keys (auch als Präfix in Phasentest-IDs) werden zu
// Jira-Links, die in einem neuen Tab öffnen.
function makeJiraLink(baseUrl, keyPattern) {
  return (text) => {
    const key = String(text ?? '').match(new RegExp(`^(?:${keyPattern})`))?.[0];
    if (!baseUrl || !key) return esc(text);
    const rest = String(text).slice(key.length);
    return `<a href="${esc(baseUrl.replace(/\/$/, ''))}/browse/${esc(key)}" target="_blank" rel="noopener">${esc(key)}</a>${esc(rest)}`;
  };
}

const ACT_MARK = { say: '💬', tool: '🔧', error: '❗', info: '•' };

// Kapazitäts-Messbalken: Füllung nach Lage (normal → knapp → kritisch), die
// Spur ist eine hellere Stufe desselben Farbtons; Lage steht immer auch als
// Text + Symbol daneben, nie nur als Farbe.
function meterLevel(percent) {
  if (percent >= 90) return { cls: 'crit', label: 'kritisch', icon: '⛔' };
  if (percent >= 70) return { cls: 'warn', label: 'knapp', icon: '⚠' };
  return { cls: 'norm', label: 'normal', icon: '✓' };
}

function renderOverage(name, overageOn, ui) {
  return ui ? `<label class="switch-row"><input type="checkbox" role="switch" data-overage="${esc(name)}"${overageOn ? ' checked' : ''}>
    <span class="switch" aria-hidden="true"></span><span>${esc(ui.t('ui.overage'))}</span>
    <strong class="switch-state">${esc(ui.t(overageOn ? 'ui.on' : 'ui.off'))}</strong></label>`
    : `<span class="muted">Kostenpflichtige Kontingente: ${overageOn ? '<strong>an</strong>' : 'aus'}</span>`;
}

function renderCapacity(name, members, cap, threshold, overage, ui, brand, jira, activity, tasks, consumption) {
  const now = Date.now();
  const rows = members.map(([agent, agentState, cfg]) => {
    const blocked = agentState?.blockedUntil && new Date(agentState.blockedUntil).getTime() > now;
    const taskId = agentState?.runningTask;
    const task = tasks.find((t) => t.id === taskId);
    const last = activity.find((a) => a.agent === agent && a.task === taskId)?.items.at(-1);
    const status = taskId ? `arbeitet an ${jira(taskId)}${task?.title ? ` · ${esc(task.title)}` : ''}`
      : cfg.enabled === false ? 'deaktiviert' : blocked ? `gesperrt bis ${esc(fmt(agentState.blockedUntil))}` : 'frei';
    return `<div class="agent-instance" data-agent="${esc(agent)}">
      <strong>${esc(agent)}</strong><span class="agent-task">${status}${last ? `<span class="muted agent-latest">${esc(last.text)}</span>` : ''}</span>
    </div>`;
  }).join('');
  const owner = members.find(([agent]) => agent === name)?.[0] || members[0][0];
  const overageOn = Boolean(overage[owner]);
  const tokenStats = [['In', 'input', 'Eingabe insgesamt (New + Cache)'], ['Out', 'output', 'Ausgabe inklusive Reasoning/Thinking'], ['Cache', 'cached', 'Eingabe aus dem Cache'], ['New', 'fresh', 'Neu verarbeitete Eingabe']]
    .map(([label, field, hint]) => `<div title="${esc(hint)}${consumption ? `: ${consumption[field].toLocaleString('de-DE')} Tokens` : ''}"><dt>${label}</dt><dd>${consumption ? `${consumption.final ? '' : '≈ '}${esc(formatTokens(consumption[field]))}` : '–'}</dd></div>`).join('');
  const age = cap?.at ? Math.round((now - cap.at) / 60000) : null;
  const meters = (cap?.windows || []).map((w) => {
    const lvl = meterLevel(w.percent);
    const reset = w.resetsAt ? new Date(w.resetsAt).toLocaleString('de-DE', { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '–';
    const tip = w.reset
      ? `${name}, ${w.label}: Fenster zurückgesetzt, 0 % genutzt · der genaue Wert kommt mit dem nächsten Lauf`
      : `${name}, ${w.label}: ${w.percent} % genutzt · Reset ${reset} · ${brand.name} pausiert den Agenten ab ${threshold} %`;
    return `<div class="meter-row" title="${esc(tip)}">
      <span class="meter-label">${esc(w.label)}</span>
      <span class="meter ${lvl.cls}" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${w.percent}" aria-label="${esc(tip)}">
        <span class="fill" style="width:${Math.min(100, Math.max(0, w.percent))}%"></span>
        <span class="limit" style="left:${threshold}%"></span>
      </span>
      <span class="meter-value">${w.percent} %</span>
      <span class="meter-state ${lvl.cls}">${lvl.icon} ${lvl.label}</span>
      <span class="muted meter-reset">${w.reset ? 'neues Fenster · genauer Wert mit dem nächsten Lauf' : `Reset ${esc(reset)}`}</span>
    </div>`;
  }).join('');
  return `<div class="agent-card">
    <div class="agent-head"><strong>${esc(name === 'codex' ? 'Codex' : name === 'claude' ? 'Claude' : name)}</strong></div>
    <div class="agent-instances">${rows}</div>
    ${meters || '<p class="muted">Noch keine Kapazitätsdaten.</p>'}
    <div class="family-overage${overageOn ? ' on' : ''}">${renderOverage(owner, overageOn, ui)}
      ${ui ? `<div class="muted overage-hint">${esc(ui.t('ui.overage.hint'))}</div>` : ''}
    </div>
    ${age !== null ? `<div class="muted">Stand der Kapazität: vor ${age < 1 ? 'weniger als 1' : age} min</div>` : ''}
    <div class="agent-consumption"><div class="muted">Tokenverbrauch · Projekt gesamt (inkl. Archiv)${consumption && !consumption.final ? ' · vorläufig' : ''}</div>
      <dl class="token-usage">${tokenStats}</dl>
    </div>
  </div>`;
}

function renderUsageCell(u) {
  if (!u) return '<td class="muted">–</td><td class="muted">–</td>';
  const pre = u.final ? '' : '≈ ';
  const tip = `Neu verarbeitet: ${u.fresh.toLocaleString('de-DE')}\nAus Cache: ${u.cached.toLocaleString('de-DE')}\nAusgabe: ${u.output.toLocaleString('de-DE')}${u.costUsd ? `\nAPI-Gegenwert: ${u.costUsd.toFixed(2)} $` : ''}${u.final ? '' : '\nLauf noch nicht abgeschlossen: vorläufig, Ausgabe zu niedrig'}`;
  return `<td class="num" title="${esc(tip)}">${pre}${esc(formatTokens(u.total))}
      <div class="muted">neu ${esc(formatTokens(u.fresh))} · Cache ${esc(formatTokens(u.cached))} · aus ${esc(formatTokens(u.output))}${u.costUsd ? ` · ${u.costUsd.toFixed(2)} $` : ''}</div></td>
    <td class="num" title="Agentenzeit: ${esc(formatDuration(u.agentMs))} in ${u.runs} Lauf/Läufen">${esc(formatDuration(u.endMs - u.startMs))}
      <div class="muted">${u.runs > 1 ? `${u.runs} Läufe · ` : ''}Agent ${esc(formatDuration(u.agentMs))}</div></td>`;
}

function renderQuality(q) {
  if (!q) return '';
  if (q.loading) return '<div class="agent-card quality-card"><div class="agent-head"><strong>Qualität</strong></div><p class="muted" role="status">Qualitätsdaten werden geladen …</p></div>';
  if (q.empty) return `<div class="agent-card quality-card"><div class="agent-head"><strong>Qualität</strong><span class="muted">noch keine Prüfung gelaufen</span></div><p class="muted">Sobald ein Prüflauf die Zusammenfassungsdatei schreibt, erscheinen hier Coverage, Befunde und Gate mit Link zur Detailansicht.</p></div>`;
  if (q.error) return `<div class="agent-card quality-card"><div class="agent-head"><strong>Qualität</strong><span class="muted">${esc(q.error)}</span></div></div>`;
  const pct = (v) => (v === null ? '–' : `${v.toLocaleString('de-DE', { maximumFractionDigits: 1 })} %`);
  const num = (v) => (v === null ? '–' : v.toLocaleString('de-DE'));
  const gate = (g) => (g ? `<span class="badge ${g === 'passed' ? 'pass' : 'fail'}">${g === 'passed' ? 'bestanden' : 'nicht bestanden'}</span>` : '<span class="muted">–</span>');
  const link = (url, label) => (url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(label)}</a>` : '');
  const rows = q.components.map((c) => {
    const low = c.coverage.lines !== null && c.coverage.baseline !== null && c.coverage.lines < c.coverage.baseline;
    const f = c.findings;
    return `<tr><td>${esc(c.name)}</td>
      <td class="num${low ? ' bad' : ''}" title="${c.coverage.baseline !== null ? `Baseline ${esc(pct(c.coverage.baseline))}` : 'ohne Baseline'}">${esc(pct(c.coverage.lines))}</td>
      <td class="num">${esc(pct(c.coverage.branches))}</td>
      <td class="num" title="${f.new !== null ? `${esc(num(f.new))} neu` : ''}">${esc(num(f.total))}${f.new ? ` <span class="badge fail">${esc(num(f.new))} neu</span>` : ''}</td>
      <td class="num">${esc(num(f.error))} / ${esc(num(f.warning))} / ${esc(num(f.info))}</td>
      <td>${gate(c.gate)}</td><td>${link(c.url, 'Details')}</td></tr>`;
  }).join('');
  return `<div class="agent-card quality-card"><div class="agent-head"><strong>Qualität</strong><span>${gate(q.gate)} ${link(q.url, 'Gesamtbericht')}</span></div>
    <div class="scroll"><table><thead><tr><th>Baustein</th><th>Zeilen</th><th>Zweige</th><th>Befunde</th><th>Fehler / Warnungen / Hinweise</th><th>Gate</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="muted">${q.revision ? `Stand ${esc(q.revision)} · ` : ''}${q.generatedAt ? `erzeugt ${esc(q.generatedAt)}` : ''}</div>
  </div>`;
}

function renderGraphStatistics(stats) {
  if (!stats || (!stats.enabled && !stats.loading && !stats.graphs?.length)) return '';
  const messages = { missing: 'Noch kein Index aufgebaut.', busy: 'Index wird gerade aktualisiert; Abfrage später erneut.', unavailable: 'Index derzeit nicht lesbar.' };
  const reasons = { timeout: 'Zeitlimit der Statistikabfrage überschritten.', 'worker-error': 'Statistikprozess konnte nicht ausgeführt werden.', schema: 'Das Datenbankschema wird nicht unterstützt.', corrupt: 'Die Indexdatei ist keine lesbare SQLite-Datenbank.', access: 'Zugriff auf die Indexdatei nicht möglich.', 'database-error': 'Fehler beim Lesen der Indexdatenbank.' };
  const graphs = (stats.graphs || []).map((graph) => `<details class="graph-index" id="graph-index-${esc(encodeURIComponent(graph.name))}">
    <summary><strong>${esc(graph.name)}</strong><span class="muted">${graph.status === 'ready' ? `${esc(graph.files.toLocaleString('de-DE'))} Dateien · Indexstand: ${esc(fmt(graph.updatedAt)) || 'unbekannt'}${graph.incomplete ? ' · unvollständig' : ''}` : messages[graph.status] || messages.unavailable}</span></summary>
    <div class="graph-index-body">
    ${graph.status === 'ready' ? `
      <dl class="graph-counts">${[['Dateien', graph.files], ['Knoten', graph.nodes], ['Beziehungen', graph.edges]].map(([label, value]) => `<div><dt>${label}</dt><dd>${esc(value.toLocaleString('de-DE'))}</dd></div>`).join('')}</dl>
      <div class="muted">${esc(graph.functions.toLocaleString('de-DE'))} Funktionen · ${esc(graph.classes.toLocaleString('de-DE'))} Klassen</div>
      ${graph.languages.length ? `<div class="muted">${esc(graph.languages.join(', '))}</div>` : ''}
      ${graph.branch ? `<div class="muted">Branch: ${esc(graph.branch)}</div>` : ''}
      ${graph.incomplete ? '<div class="status needs-human">Indexaufbau unvollständig</div>' : ''}
      <div class="muted">Indexstand: ${esc(fmt(graph.updatedAt)) || 'unbekannt'}</div>`
      : `<p class="muted">${messages[graph.status] || messages.unavailable}${graph.reason ? ` ${reasons[graph.reason] || reasons['database-error']}` : ''}</p>`}
    </div></details>`).join('');
  return `<div class="agent-card graph-card"><div class="agent-head"><strong>Code Review Graph</strong><span class="muted">${stats.enabled ? 'aktiviert' : 'Integration deaktiviert'}</span></div>
    ${graphs || `<p class="muted">${stats.loading ? 'Statistik wird geladen …' : 'Noch kein Index aufgebaut.'}</p>`}
    <p class="muted">Je Index gezählt; Worktree-Kopien werden nicht addiert.</p>
    ${stats.checkedAt ? `<div class="muted">Statistik abgefragt: ${esc(fmt(stats.checkedAt))}</div>` : ''}
    <div class="muted graph-freshness">Indexstand = letzte Indexaktualisierung. Die Statistikabfrage liest den vorhandenen Index; sie baut ihn nicht neu auf.</div>
  </div>`;
}

export function renderReport(state, outFile, opts = {}) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, buildReportHtml(state, opts), 'utf8');
}

// Steuerelemente der Web-Oberfläche (nur wenn ardai die Seite selbst ausliefert)
function taskActions(task, ui) {
  if (!ui) return '';
  const { t } = ui;
  const b = (action, label, extra = '') => `<button type="button" class="btn" data-action="${action}" data-task="${esc(task.id)}" data-branch="${esc(task.branch || '')}"${extra}>${esc(label)}</button>`;
  const out = [];
  if (['running', 'ready', 'interrupted', 'needs-human'].includes(task.status)) out.push(b('stop', t('ui.stop')));
  if (['stopped', 'failed', 'needs-human', 'interrupted'].includes(task.status)) out.push(b('retry', t('ui.retry')));
  if (task.status === 'ready' && !ui.runnerAlive) out.push(b('retry', t('ui.start')));
  if (task.archivedAt) {
    out.push(b('unarchive', t('ui.unarchive')));
    return `<td class="actions">${out.join(' ')}</td>`;
  }
  if (task.status !== 'done') out.push(b('clean', t('ui.clean'), ' data-danger="1"'));
  if (['done', 'stopped', 'failed'].includes(task.status)) out.push(b('archive', t('ui.archive')));
  return `<td class="actions">${out.join(' ')}</td>`;
}

export function buildReportHtml(state, { jiraBaseUrl, keyPattern = '[A-Z][A-Z0-9]+-\\d+', activity = [], usage = {}, agentUsage = {}, graphStats = null, quality = null, statisticsLoading = false, error = false, capacity = {}, overage = {}, agents = {}, quotaThresholdPercent = 97, ui = null, fragmentOnly = false, brand: brandOverride = DEFAULT_BRAND } = {}) {
  const jira = makeJiraLink(jiraBaseUrl, keyPattern);
  const refreshSeconds = activity.length ? 10 : 60;

  const activityHtml = activity.map((a) => {
    const ago = Math.round((Date.now() - a.updatedAt) / 1000);
    const agoText = ago < 120 ? `${ago} s` : `${Math.round(ago / 60)} min`;
    const last = a.items[a.items.length - 1];
    return `<details class="act" id="act-${esc(a.agent)}-${esc(a.task)}">
      <summary><span class="chev" aria-hidden="true">▸</span><strong>${esc(a.agent)}</strong> · ${jira(a.task)} <span class="muted">· letzte Aktivität vor ${esc(agoText)}${last ? ` · ${esc(last.text.slice(0, 90))}` : ''}</span></summary>
      <ol class="activity">${[...a.items].reverse().map((i) => `<li class="${esc(i.kind)}"><span class="mark">${ACT_MARK[i.kind] || '•'}</span>${esc(i.text)}</li>`).join('')}</ol>
    </details>`;
  }).join('');

  // Archivierte Aufgaben (in main übernommen oder von Hand archiviert) verschwinden
  // aus den Arbeitslisten und Kennzahlen; sie stehen nur noch im Archiv-Abschnitt.
  const allTasks = [...(state.tasks || [])].reverse();
  const active = allTasks.filter((x) => !x.archivedAt);
  const archived = allTasks.filter((x) => x.archivedAt);
  const activeIds = new Set(active.map((x) => x.id));

  const rows = latestResults((state.testResults || []).filter((r) => activeIds.has(r.taskId)));
  const byEpic = new Map();
  for (const r of rows) {
    const k = r.epic || 'Ohne Epic';
    if (!byEpic.has(k)) byEpic.set(k, []);
    byEpic.get(k).push(r);
  }
  const pass = rows.filter((r) => r.result === 'pass').length;
  const fail = rows.filter((r) => r.result === 'fail').length;
  // Frage = der Agent wartet wirklich auf dich (blocking). Hinweis = er hat mit
  // einer Annahme weitergearbeitet; du kannst bestätigen oder widersprechen.
  const visibleQ = (q) => activeIds.has(q.taskId) || !allTasks.some((x) => x.id === q.taskId);
  const openQ = (state.questions || []).filter((q) => q.blocking && !q.answer && visibleQ(q));
  // Hinweise bleiben auch nach dem Archivieren der Aufgabe sichtbar, bis sie bestätigt oder beantwortet sind.
  const brand = resolveBrand(brandOverride);
  const hints = (state.questions || []).filter((q) => !q.blocking && !q.answer && !q.acknowledgedAt && !isOrchestratorAgent(q.agent, brand));

  const groups = new Map();
  for (const name of new Set([...Object.keys(agents), ...Object.keys(state.agents || {})])) {
    const cfg = agents[name] || {};
    const kind = cfg.kind || name.replace(/\d+$/, '');
    if (!groups.has(kind)) groups.set(kind, []);
    groups.get(kind).push([name, state.agents?.[name] || {}, cfg]);
  }
  const agentCards = [...groups].map(([kind, members]) => renderCapacity(kind, members, capacity[kind], quotaThresholdPercent, overage, ui, brand, jira, activity, state.tasks || [], agentUsage[kind])).join('');

  // Einklappbarer Abschnitt; die Zusammenfassung zeigt die Kennzahlen auch eingeklappt.
  const section = (id, title, summary, body, cls = '') => `<details class="sec ${cls}" id="${esc(id)}">
    <summary><span class="chev" aria-hidden="true">▸</span><span class="sec-title">${title}</span><span class="sec-sum">${summary}</span></summary>
    <div class="sec-body">${body}</div>
  </details>`;
  const countBadges = (list) => {
    const c = (k) => list.filter((r) => r.result === k).length;
    return [c('fail') ? `<span class="badge fail">${c('fail')} rot</span>` : '', `<span class="badge pass">${c('pass')} grün</span>`, c('skip') ? `<span class="badge skip">${c('skip')} übersprungen</span>` : ''].join(' ');
  };

  const testTables = [...byEpic.entries()].map(([epic, list]) => section(`tests-${epic}`, jira(epic), countBadges(list), `
    <div class="scroll"><table>
      <thead><tr><th>Komponente</th><th>Akzeptanzkriterium</th><th>Ergebnis</th><th>Hinweis</th><th>Ticket</th><th>Art</th><th>Stand</th></tr></thead>
      <tbody>${list.sort((a, b) => (a.result === 'fail' ? -1 : 1) - (b.result === 'fail' ? -1 : 1) || a.component.localeCompare(b.component)).map((r) => `
        <tr>
          <td>${esc(r.component)}</td>
          <td>${esc(r.criterion)}</td>
          <td><span class="badge ${esc(r.result)}">${esc(RESULT_LABEL[r.result] || r.result)}</span></td>
          <td>${r.result === 'fail' ? esc(r.note) : `<span class="muted">${esc(r.note)}</span>`}</td>
          <td>${jira(r.taskId)}</td>
          <td>${esc(KIND_LABEL[r.kind] || r.kind)}</td>
          <td class="muted">${esc(fmt(r.at))} · ${esc(r.agent)}${r.runs > 1 ? ` · ${r.runs} Läufe` : ''}</td>
        </tr>`).join('')}
      </tbody>
    </table></div>`, fail ? 'has-fail' : '')).join('');

  const questions = openQ.length ? `<div class="scroll"><table>
      <thead><tr><th>ID</th><th>Aufgabe</th><th>Frage</th><th>Annahme des Agenten</th><th>Blockiert</th>${ui ? `<th>${esc(ui.t('ui.answer'))}</th>` : ''}</tr></thead>
      <tbody>${openQ.map((q) => `<tr><td>${esc(q.id)}</td><td>${jira(q.taskId)}</td><td>${esc(q.question)}${q.context ? `<div class="muted">${esc(q.context)}</div>` : ''}</td><td>${esc(q.assumption)}</td><td>${q.blocking ? '<span class="badge fail">Ja</span>' : 'Nein'}</td>${ui ? `<td class="answer"><form data-answer="${esc(q.id)}"><textarea name="text" rows="2" placeholder="${esc(ui.t('ui.answer.placeholder'))}"></textarea><button type="submit" class="btn">${esc(ui.t('ui.answer'))}</button></form></td>` : ''}</tr>`).join('')}</tbody>
    </table></div>
    ${ui ? '' : `<p class="muted">Beantworten: <code>${esc(brand.cli)} answer &lt;ID&gt; "Antwort"</code></p>`}`
    : '<p class="muted">Keine offenen Fragen.</p>';

  const canArchive = (x) => !x.archivedAt && ['done', 'stopped', 'failed'].includes(x.status);
  const bulkArchive = ui && active.some(canArchive);
  const taskRow = (x, selectable) => `<tr data-sort-ticket="${esc(x.id)}" data-sort-epic="${esc(x.epic)}" data-sort-agent="${esc(x.assignedAgent || x.lastAgent || '')}" data-sort-status="${esc(STATUS_LABEL[x.status] || x.status)}">
      ${selectable ? `<td>${canArchive(x) ? `<input type="checkbox" data-archive-task="${esc(x.id)}" aria-label="${esc(ui.t('ui.selectTask', { task: x.id }))}">` : ''}</td>` : ''}
      <td>${jira(x.id)}</td><td>${esc(x.title)}</td><td>${jira(x.epic)}</td>
      <td><span class="status ${esc(x.status)}">${esc(STATUS_LABEL[x.status] || x.status)}</span>${x.archivedAt ? `<div class="muted">archiviert ${esc(fmt(x.archivedAt))}</div>` : ''}</td>
      <td>${esc(x.assignedAgent || x.lastAgent || '')}</td>
      ${renderUsageCell(usage[x.id])}
      <td class="muted">${esc(x.lastNote || '')}</td>${taskActions(x, ui)}</tr>`;
  const sortHeader = (field, label, sortable) => sortable ? `<th aria-sort="none"><button type="button" class="sort-button" data-task-sort="${field}" title="Sortieren: aufsteigend, absteigend, neueste zuerst">${label}<span class="sort-mark" aria-hidden="true"> ↕</span></button></th>` : `<th>${label}</th>`;
  const taskTable = (list, selectable = false, sortable = false) => `<div class="scroll"><table><thead><tr>${selectable ? `<th><input type="checkbox" data-archive-all aria-label="${esc(ui.t('ui.selectAll'))}"></th>` : ''}${sortHeader('ticket', 'Ticket', sortable)}<th>Titel</th>${sortHeader('epic', 'Epic', sortable)}${sortHeader('status', 'Status', sortable)}${sortHeader('agent', 'Agent', sortable)}<th>Tokens</th><th>Dauer</th><th>Letzte Notiz</th>${ui ? `<th>${esc(ui.t('ui.actions'))}</th>` : ''}</tr></thead><tbody>${list.map((x) => taskRow(x, selectable)).join('')}</tbody></table></div>`;
  const byStatus = (k) => active.filter((x) => x.status === k).length;
  const taskSummary = [
    byStatus('running') ? `<span class="status running">${byStatus('running')} läuft</span>` : '',
    active.filter((x) => ['needs-human', 'failed'].includes(x.status)).length ? `<span class="status needs-human">${active.filter((x) => ['needs-human', 'failed'].includes(x.status)).length} wartet auf dich</span>` : '',
    byStatus('stopped') ? `<span class="status stopped">${byStatus('stopped')} gestoppt</span>` : '',
    `<span class="muted">${byStatus('done')} fertig (Review) · ${active.length} aktiv</span>`,
  ].filter(Boolean).join(' · ');

  const controls = ui ? `<div class="controls" data-ui-instance="${esc(ui.instance || '')}">
    <span class="runner ${ui.runnerAlive ? 'on' : 'off'}">● ${esc(ui.t(ui.runnerAlive ? 'ui.runner.on' : 'ui.runner.off'))}</span>
    <form id="newjob" class="newjob">
      <strong>${esc(ui.t('ui.newJob'))}</strong>
      <label><input type="radio" name="mode" value="keys" checked> ${esc(ui.t('ui.newJob.keys'))}</label>
      <label><input type="radio" name="mode" value="jql"> ${esc(ui.t('ui.newJob.jql'))}</label>
      <input type="text" name="q" required placeholder="${esc(ui.t('ui.newJob.placeholderKeys'))}" data-ph-keys="${esc(ui.t('ui.newJob.placeholderKeys'))}" data-ph-jql="${esc(ui.t('ui.newJob.placeholderJql'))}">
      <button type="submit" class="btn primary">${esc(ui.t('ui.newJob.start'))}</button>
    </form>
    <button type="button" class="btn" data-action="reload"${ui.reloadRequested ? ' disabled' : ''}>${esc(ui.t(ui.reloadRequested ? 'ui.reloading' : 'ui.reload'))}</button>
    <button type="button" class="btn" data-danger="1" data-action="stop-all">${esc(ui.t('ui.stopAll'))}</button>
  </div>` : '';

  const main = `
<h1>${ui ? esc(ui.t('ui.title')) : `${esc(brand.name)} – Status`}</h1>
<div class="muted">Stand: ${esc(fmt(new Date().toISOString()))}${ui ? '' : ` · aktualisiert sich alle ${refreshSeconds} s`}</div>
${controls}
<div class="summary">
  <div class="tile"><b style="color:var(--ok)">${pass}</b>grün</div>
  <div class="tile"><b style="color:var(--bad)">${fail}</b>rot</div>
  <div class="tile"><b>${openQ.length}</b>offene Fragen</div>
  <div class="tile"><b>${hints.length}</b>Hinweise</div>
  <div class="tile"><b>${byStatus('done')}/${active.length}</b>Aufgaben fertig</div>
</div>
<h2>Agenten und Kapazität</h2>
${statisticsLoading ? '<p class="muted" role="status">Verbrauch, Kontingente und Qualität werden im Hintergrund geladen …</p>' : error ? '<p class="muted" role="status">Statistik derzeit nicht verfügbar; erneuter Versuch beim nächsten Aktualisieren.</p>' : ''}
<div class="agents">${agentCards}${renderGraphStatistics(graphStats)}${renderQuality(quality)}</div>
<p class="muted">Der Strich im Balken markiert ${quotaThresholdPercent} %: Ab dort startet ${esc(brand.name)} keine neuen Läufe für diesen Agenten, bis das Fenster zurückgesetzt wird.</p>
<h2>Offene Fragen an dich</h2>
${questions}
${hints.length ? `<h2>Hinweise der Agenten</h2>
${section('sec-hints', 'Annahmen, mit denen weitergearbeitet wurde', `<span class="muted">${hints.length} Hinweise · bestätigen oder widersprechen; ein Widerspruch zu einer fertigen Aufgabe erzeugt einen Nachtrag</span>`, `<div class="scroll"><table>
      <thead><tr><th>ID</th><th>Aufgabe</th><th>Hinweis</th><th>Annahme des Agenten</th>${ui ? `<th>${esc(ui.t('ui.actions'))}</th>` : ''}</tr></thead>
      <tbody>${hints.map((q) => `<tr><td>${esc(q.id)}</td><td>${jira(q.taskId)}</td><td>${esc(q.question)}${q.context ? `<div class="muted">${esc(q.context)}</div>` : ''}</td><td>${esc(q.assumption)}</td>${ui ? `<td class="answer"><button type="button" class="btn" data-action="ack" data-task="${esc(q.id)}">${esc(ui.t('ui.ack'))}</button><form data-answer="${esc(q.id)}"><textarea name="text" rows="2" placeholder="${esc(ui.t('ui.disagree.placeholder'))}"></textarea><button type="submit" class="btn">${esc(ui.t('ui.disagree'))}</button></form></td>` : ''}</tr>`).join('')}</tbody>
    </table></div>${ui ? '' : `<p class="muted">Bestätigen: <code>${esc(brand.cli)} ack &lt;ID&gt;</code> · widersprechen: <code>${esc(brand.cli)} answer &lt;ID&gt; "…"</code></p>`}`)}` : ''}
${section('sec-tests', 'Testergebnisse', countBadges(rows), testTables || '<p class="muted">Keine Testergebnisse zu aktiven Aufgaben.</p>', fail ? 'has-fail' : '')}
<h2>Aufgaben</h2>
${active.length ? section('sec-tasks', 'Aktive Aufgaben', taskSummary, `${bulkArchive ? `<div class="bulk-actions"><button type="button" class="btn" data-action="archive-selected" disabled>${esc(ui.t('ui.archiveSelected'))} (<span data-archive-count>0</span>)</button></div>` : ''}${taskTable(active, bulkArchive, true)}
<p class="muted">Tokens: Summe aller Läufe einer Aufgabe; „≈“ = Lauf noch nicht abgeschlossen. Dauer: vom ersten Start bis zur letzten Aktivität, darunter die reine Laufzeit der Agenten.</p>`) : '<p class="muted">Keine aktiven Aufgaben.</p>'}
${archived.length ? section('sec-archive', 'Archiv', `<span class="muted">${archived.length} Aufgaben · in main übernommen oder von Hand archiviert</span>`, taskTable(archived)) : ''}
${activityHtml ? `<h2>Live-Verlauf</h2><p class="muted">Zum Aufklappen auf eine Zeile klicken. Neueste Einträge oben – das, was der Agent im Chat schreiben und tun würde.</p>${activityHtml}` : ''}`;
  if (fragmentOnly) return main;

  const html = `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<noscript><meta http-equiv="refresh" content="${refreshSeconds}"></noscript>
<title>${ui ? esc(ui.t('ui.title')) : `${esc(brand.name)} – Status`}</title>
<style>
:root { --bg:#f7f7f5; --fg:#1d1d1b; --muted:#6b6b66; --card:#fff; --line:#e3e3df; --ok:#1e7d3a; --okbg:#e3f4e8; --bad:#b42318; --badbg:#fde8e6; --warn:#9a6700; --warnbg:#fff4d6;
  --m-norm:#2a6fdb; --m-warn:#fab219; --m-crit:#d03b3b; --m-norm-text:#1f56ad; --m-warn-text:#8a5a00; --m-crit-text:#b42318; }
@media (prefers-color-scheme: dark) { :root { --bg:#141413; --fg:#ecece8; --muted:#a3a39c; --card:#1e1e1c; --line:#33332f; --ok:#6fd38d; --okbg:#17331f; --bad:#ff8a7d; --badbg:#3a1714; --warn:#f0c454; --warnbg:#3a2e0e;
  --m-norm:#5b95f0; --m-warn:#fab219; --m-crit:#e25c5c; --m-norm-text:#8fb6f5; --m-warn-text:#f0c454; --m-crit-text:#ff8a7d; } }
* { box-sizing:border-box; }
body { margin:0; padding:24px clamp(16px, 2vw, 32px); background:var(--bg); color:var(--fg); font:15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { width:100%; }
h1 { font-size:22px; margin:0 0 4px; } h2 { font-size:18px; margin:32px 0 8px; } h3 { font-size:15px; margin:20px 0 8px; }
.muted { color:var(--muted); font-size:13px; }
.summary { display:flex; gap:12px; flex-wrap:wrap; margin:16px 0; }
.tile { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:10px 16px; min-width:120px; }
.tile b { display:block; font-size:22px; }
.scroll { overflow-x:auto; }
table { width:100%; border-collapse:collapse; background:var(--card); border:1px solid var(--line); border-radius:8px; }
th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; overflow-wrap:break-word; }
td.muted, td .muted { overflow-wrap:anywhere; }
th { font-size:13px; color:var(--muted); font-weight:600; }
.sort-button { font:inherit; color:inherit; background:none; border:0; padding:0; cursor:pointer; white-space:nowrap; }
.sort-button:hover { color:var(--fg); }
.sort-button:focus-visible { outline:2px solid var(--m-norm); outline-offset:3px; }
td.num { white-space:nowrap; font-variant-numeric:tabular-nums; }
a[href*="/browse/"] { white-space:nowrap; }
.badge { display:inline-block; padding:2px 8px; border-radius:999px; font-size:13px; font-weight:600; white-space:nowrap; }
.badge.pass { background:var(--okbg); color:var(--ok); } .badge.fail { background:var(--badbg); color:var(--bad); } .badge.skip { background:var(--warnbg); color:var(--warn); }
.status.needs-human, .status.failed { color:var(--bad); font-weight:600; } .status.done { color:var(--ok); }
.agents { display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)); gap:12px; align-items:start; }
.agent-card { min-width:0; background:var(--card); border:1px solid var(--line); border-radius:8px; padding:12px 16px; }
.agent-head { display:flex; justify-content:space-between; gap:12px; margin-bottom:8px; flex-wrap:wrap; }
.agent-instances { margin-bottom:12px; }
.agent-instance { display:grid; grid-template-columns:75px minmax(0,1fr); gap:4px 10px; padding:8px 0; border-bottom:1px solid var(--line); align-items:baseline; }
.agent-instance > strong, .agent-task { overflow-wrap:anywhere; }
.agent-latest { display:block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-size:13px; }
.family-overage { margin:12px 0; }
.overage-hint { margin-top:10px; }
.agent-consumption { margin-top:12px; padding-top:12px; border-top:1px solid var(--line); }
.token-usage { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:8px; margin:8px 0 0; }
.token-usage dt { color:var(--muted); font-size:13px; }
.token-usage dd { margin:4px 0 0; font-weight:600; font-variant-numeric:tabular-nums; overflow-wrap:anywhere; }
.quality-card td.bad { color:var(--bad); font-weight:600; }
.graph-index { padding:10px 0; border-bottom:1px solid var(--line); }
.graph-index > summary { cursor:pointer; }
.graph-index > summary > .muted { margin-left:8px; font-size:13px; overflow-wrap:anywhere; }
.graph-index-body { padding:8px 0 0; }
.graph-freshness { margin-top:8px; font-size:13px; }
.graph-counts { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; margin:8px 0; }
.graph-counts dt { color:var(--muted); font-size:13px; overflow-wrap:anywhere; }
.graph-counts dd { margin:4px 0 0; font-weight:600; font-variant-numeric:tabular-nums; }
.meter-row { display:grid; grid-template-columns:64px minmax(0,1fr) 44px; grid-template-areas:"label bar value" ". state state" ". reset reset"; align-items:center; column-gap:10px; margin:6px 0 10px; }
.meter-label { grid-area:label; font-size:13px; }
.meter { grid-area:bar; position:relative; height:12px; border-radius:6px; overflow:visible; }
.meter.norm { background:color-mix(in srgb, var(--m-norm) 18%, var(--card)); }
.meter.warn { background:color-mix(in srgb, var(--m-warn) 22%, var(--card)); }
.meter.crit { background:color-mix(in srgb, var(--m-crit) 18%, var(--card)); }
.meter .fill { position:absolute; inset:0 auto 0 0; border-radius:6px; }
.meter.norm .fill { background:var(--m-norm); } .meter.warn .fill { background:var(--m-warn); } .meter.crit .fill { background:var(--m-crit); }
.meter .limit { position:absolute; top:-3px; bottom:-3px; width:2px; background:var(--fg); opacity:.45; border-radius:1px; }
.meter-value { grid-area:value; text-align:right; font-variant-numeric:tabular-nums; font-weight:600; }
.meter-state { grid-area:state; font-size:13px; white-space:nowrap; }
.meter-state.norm { color:var(--m-norm-text); } .meter-state.warn { color:var(--m-warn-text); } .meter-state.crit { color:var(--m-crit-text); font-weight:600; }
.meter-reset { grid-area:reset; }
details.act { background:var(--card); border:1px solid var(--line); border-radius:8px; margin:8px 0; }
details.sec { background:var(--card); border:1px solid var(--line); border-radius:8px; margin:8px 0; }
details.sec > summary { cursor:pointer; padding:10px 14px; list-style:none; display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
details.sec > summary::-webkit-details-marker { display:none; }
details.sec > summary .sec-title { font-weight:600; }
details.sec .sec-sum { display:flex; gap:6px; align-items:center; flex-wrap:wrap; font-size:13px; }
details.sec .sec-body { border-top:1px solid var(--line); }
details.sec .sec-body table { border:0; border-radius:0; }
details.sec .sec-body > p { margin:8px 14px; }
details.sec.has-fail { border-color:color-mix(in srgb, var(--bad) 45%, var(--line)); }
details.sec .chev, details.act .chev { display:inline-block; transition:transform .15s; color:var(--muted); }
details.sec[open] > summary .chev { transform:rotate(90deg); }
.status.running { color:var(--m-norm-text); font-weight:600; }
details.act summary { cursor:pointer; padding:8px 12px; list-style:none; display:flex; gap:8px; align-items:baseline; flex-wrap:wrap; }
details.act summary::-webkit-details-marker { display:none; }
details.act .chev { display:inline-block; transition:transform .15s; color:var(--muted); }
details.act[open] .chev { transform:rotate(90deg); }
.activity { list-style:none; padding:0; margin:0; border-top:1px solid var(--line); max-height:420px; overflow-y:auto; }
.activity li { padding:6px 12px; border-bottom:1px solid var(--line); display:flex; gap:8px; font-size:14px; overflow-wrap:anywhere; }
.activity li:last-child { border-bottom:0; }
.activity li.say { font-weight:500; }
.activity li.tool { color:var(--muted); font-family:ui-monospace, Consolas, monospace; font-size:13px; }
.activity li.error { color:var(--bad); }
.activity .mark { flex:none; }
ul { padding-left:20px; }
a { color:inherit; text-decoration:underline; text-decoration-color:var(--muted); text-underline-offset:2px; } a:hover { text-decoration-color:currentColor; }
${ui ? UI_CSS : ''}
.status.stopped { color:var(--warn); font-weight:600; }
.switch-row { display:flex; align-items:center; gap:10px; cursor:pointer; font-size:14px; flex-wrap:wrap; }
.switch-row input { position:absolute; opacity:0; width:1px; height:1px; }
.switch { position:relative; flex:none; width:36px; height:20px; border-radius:10px; background:color-mix(in srgb, var(--muted) 55%, var(--card)); transition:background .15s; }
.switch::after { content:''; position:absolute; top:2px; left:2px; width:16px; height:16px; border-radius:50%; background:var(--card); box-shadow:0 1px 2px rgba(0,0,0,.3); transition:transform .15s; }
.switch-row input:checked + .switch { background:var(--m-warn); }
.switch-row input:checked + .switch::after { transform:translateX(16px); }
.switch-row input:focus-visible + .switch { outline:2px solid var(--m-norm); outline-offset:2px; }
.family-overage.on .switch-state { color:var(--m-warn-text); }
@media (max-width:520px) { .meter-row { grid-template-columns:64px 1fr 44px; grid-template-areas:"label bar value" ". state state" ". reset reset"; } }
</style></head>
<body><main id="app">${main}</main>
<div id="toast" role="status" aria-live="polite"></div>
${ui ? `<script>
window.ORCHESTRATOR = ${JSON.stringify({ token: ui.token, instance: ui.instance, lazy: ui.lazy, texts: { stopConfirm: ui.t('ui.stop.confirm'), stopAllConfirm: ui.t('ui.stopAll.confirm'), cleanPrompt: ui.t('ui.clean.prompt'), error: ui.t('ui.error') } }).replace(/</g, '\u003c')};
${UI_SCRIPT}
</script>` : `<script>
${STATIC_SCRIPT.replace('__REFRESH__', String(refreshSeconds))}
</script>`}
</body></html>
`;
  return html;
}
