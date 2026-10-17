#!/usr/bin/env node
// Orchestrator für Claude + Codex. Läuft ohne KI und damit unabhängig vom
// Kontingent der Agenten. Bedienung: siehe README.md in diesem Ordner.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readJson, nowIso, log, expandEnv, sh } from './lib/util.mjs';
import { Git, renderPrePushHook } from './lib/git.mjs';
import { AgentRun, latestCodexRateLimits } from './lib/agents.mjs';
import { taskPrompt, resumePrompt, importPrompt } from './lib/prompts.mjs';
import { spawn } from 'node:child_process';
import { renderReport, buildReportHtml } from './lib/report.mjs';
import { runSourceAction, killTree, isAlive } from './lib/sources.mjs';
import { createPolisher } from './lib/ollama.mjs';
import { JiraClient, loadJiraAuth, applyAction, REST_ACTIONS } from './lib/jira.mjs';
import { startServer } from './lib/server.mjs';
import { makeT } from './lib/i18n.mjs';
import { planPhaseTests } from './lib/phasetests.mjs';
import { RUNNABLE, depsDone as dependenciesDone, selectTask as selectPlannedTask } from './lib/planning.mjs';
import { hintsMarkdown, collectHints } from './lib/hints.mjs';
import { formatLine, listLogs, tailActivity, parseLogName } from './lib/activity.mjs';
import { taskUsage, capacity } from './lib/usage.mjs';
import { loadProject, loadState, saveState } from './lib/project.mjs';
import { parseEdits, patchTask, followUpIdentity, extendDomain } from './lib/task-edits.mjs';

import { DEFAULT_BRAND, loadToolBrand, ORCHESTRATOR_AGENT, cliNames, protocolAddendum, hasStoppedLabel } from './lib/brand.mjs';

const ACTIVITY_MARK = { say: '💬', tool: '🔧', error: '❗', info: '•' };
function printActivity(agent, taskId, a) {
  const t = new Date().toLocaleTimeString('de-DE');
  console.log(`${t} ${agent}/${taskId} ${ACTIVITY_MARK[a.kind] || '•'} ${a.text}`);
}

const [cmd, ...args] = process.argv.slice(2);
if (!cmd || ['help', '--help', '-h'].includes(cmd)) {
  let brand = loadToolBrand();
  try { brand = loadProject().config.brand; }
  catch (err) { if (!err.message.startsWith('No ')) throw err; }
  printHelp(brand); process.exit(0);
}
// Installing the launcher is independent of a project and never reads its state.
if (cmd === 'install-cli') {
  let brand = loadToolBrand();
  try { brand = loadProject().config.brand; }
  catch (err) { if (!err.message.startsWith('No ')) throw err; }
  cmdInstallCli(args, brand); process.exit(0);
}
// step/handoff are used by the agents inside their worktree: no project config, no state, minimal output.
if (cmd === 'step' || cmd === 'handoff') {
  const { run } = await import('./lib/handoff.mjs');
  process.exit(run(cmd, args));
}
let project;
try { project = loadProject({ init: cmd === 'init' }); }
catch (err) { console.error(err.message); process.exit(1); }
const { repoRoot, config, runtimeDir, stateFile, reportFile, hintsFile, resultsDir, lockFile, inboxFile, logDir } = project;
const link = (file) => pathToFileURL(file).href; // in VS Code/Windows Terminal per Strg+Klick öffnbar
const git = new Git(repoRoot, config);
const brand = config.brand;
process.title = brand.processName;
const t = makeT(config.language, brand);

const DONE = 'done';

let state;
try { state = loadState(stateFile); }
catch (err) { console.error(err.message); process.exit(1); }
for (const name of Object.keys(config.agents)) state.agents[name] ||= {};

const verbose = process.argv.includes('--verbose') || process.argv.includes('-v');

// Letzte Schritte jedes laufenden Agenten, gelesen aus seinem aktuellen Log.
function liveActivity(n = 40) {
  const logs = listLogs(logDir);
  return running().map((t) => {
    const file = logs.filter((l) => l.task === t.id && l.agent === t.assignedAgent).pop()?.file;
    return file ? tailActivity(file, n, 2_000_000, git.worktreeRoot) : null;
  }).filter(Boolean);
}

function save() {
  if (!isRunner && runnerAlive()) throw new Error('State owned by runner / State gehört dem Runner; Inbox verwenden.');
  saveState(stateFile, state);
  try { fs.writeFileSync(hintsFile, hintsMarkdown(state, brand), 'utf8'); } catch (err) { log('hints.md nicht geschrieben:', err.message); }
  try { renderLiveReport(); } catch (err) { log('Statusseite nicht geschrieben:', err.message); }
}

// Verbrauch je Aufgabe und Kapazität je Agent – beides aus den Logs gelesen.
function reportData() {
  const usage = {};
  for (const t of state.tasks) {
    const u = taskUsage(logDir, t.id);
    if (u) usage[t.id] = u;
  }
  const codexSessions = config.agents.codex?.sessionsDir && expandEnv(config.agents.codex.sessionsDir);
  const { ui: _uiConfig, ...cfg } = config; // "ui" ist hier die Server-Konfiguration, nicht die Seitensteuerung
  const overage = Object.fromEntries(Object.keys(config.agents).map((n) => [n, agentCfgFor(n).allowOverage]));
  return { ...cfg, usage, overage, capacity: capacity(logDir, codexSessions) };
}

function renderLiveReport() {
  renderReport(state, reportFile, { ...reportData(), activity: liveActivity() });
}

// Während Agenten arbeiten, die Statusseite höchstens alle 5 s neu schreiben.
let reportTimer = null;
function scheduleReport() {
  if (reportTimer) return;
  reportTimer = setTimeout(() => {
    reportTimer = null;
    try { renderLiveReport(); } catch { /* nächster Versuch beim nächsten Ereignis */ }
  }, 5000);
}

// Testbericht als Momentaufnahme unter config.resultsDir.
// Der Dateiname sortiert lexikalisch = chronologisch (absteigend = neu nach alt).
function writeResultsSnapshot() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const base = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
  let file = path.join(resultsDir, `${base}.html`);
  for (let i = 2; fs.existsSync(file); i++) file = path.join(resultsDir, `${base}_${i}.html`);
  renderReport(state, file, reportData());
  return file;
}

const taskById = (id) => state.tasks.find((t) => t.id === id);
const depsDone = (t) => dependenciesDone(t, state.tasks);
const running = () => state.tasks.filter((t) => t.status === 'running');

// Wirksame Agenten-Konfiguration: der Schalter "kostenpflichtige Kontingente"
// liegt im State (über Web/CLI umschaltbar), config.json liefert nur den Standard.
function agentCfgFor(name) {
  const base = config.agents[name];
  const flag = state.agents[name]?.allowOverage;
  return { ...base, allowOverage: typeof flag === 'boolean' ? flag : Boolean(base.allowOverage) };
}

function addNote(task, note) {
  task.lastNote = note;
  (task.history ||= []).push({ at: nowIso(), note });
}

// ---------------------------------------------------------------- Verfügbarkeit

function isAvailable(name) {
  const cfg = config.agents[name];
  const a = state.agents[name];
  if (!cfg.enabled) return false;
  const now = Date.now();
  if (a.blockedUntil && new Date(a.blockedUntil).getTime() > now) return false;

  // Vorab-Prüfung: nicht erst losschicken, wenn das Fenster schon voll ist.
  const threshold = config.quotaThresholdPercent;
  if (cfg.kind === 'codex') {
    const q = latestCodexRateLimits(expandEnv(cfg.sessionsDir), threshold);
    if (q) a.quota = q.detail;
    if (q?.exhausted && q.resetsAt > now && !(agentCfgFor(name).allowOverage && q.paidAvailable)) return block(name, q.resetsAt, `Kontingent ${q.detail}`);
  }
  if (cfg.kind === 'claude' && a.windows) {
    const full = Object.entries(a.windows).filter(([, w]) => w.utilization * 100 >= threshold && w.resetsAt * 1000 > now);
    if (full.length && !agentCfgFor(name).allowOverage) return block(name, Math.max(...full.map(([, w]) => w.resetsAt * 1000)), `Kontingent ${full.map(([k]) => k).join(',')}`);
  }
  return true;
}

function block(name, untilMs, reason) {
  state.agents[name].blockedUntil = new Date(untilMs).toISOString();
  state.agents[name].blockReason = reason;
  log(`${name} gesperrt bis ${new Date(untilMs).toLocaleString('de-DE')} (${reason})`);
  save();
  return false;
}

// ---------------------------------------------------------------- Auswahl

function selectTask(agent) {
  return selectPlannedTask(agent, state.tasks, config.agents, { inScope, isAvailable, busyAgents: new Set(activeRuns.keys()), stealWhenBusy: config.scheduling?.stealWhenBusy !== false });
}

// ---------------------------------------------------------------- Ausführung

const activeRuns = new Map();
let wake = () => {};

function startTask(agent, task) {
  const wt = git.ensureWorktree(agent);
  try {
    git.checkoutTaskBranch(wt, task.branch);
  } catch (err) {
    addNote(task, `Checkout fehlgeschlagen: ${err.message.split('\n')[0]}`);
    log(`${task.id}: Checkout in ${agent}-Worktree fehlgeschlagen`, err.message);
    save();
    return;
  }
  refreshCodeGraph(wt);
  fs.rmSync(path.join(wt, '.orchestrator-run'), { recursive: true, force: true });
  fs.mkdirSync(path.join(wt, '.orchestrator-run'), { recursive: true });

  const resume = task.status === 'interrupted' && task.lastAgent === agent && task.sessions?.[agent];
  const takeover = task.lastAgent && task.lastAgent !== agent
    ? `Der Agent "${task.lastAgent}" hat diese Aufgabe begonnen und wurde unterbrochen (${task.lastNote || 'Outage'}). Sein letzter Stand ist gepusht.`
    : null;
  const answers = state.questions.filter((q) => q.taskId === task.id && q.answer);
  const isPhaseTest = task.type === 'phase-test';
  // Phasentest: bereits grüne Checks der Umsetzung nicht wiederholen
  const priorResults = isPhaseTest
    ? state.testResults.filter((r) => r.epic === task.epic && r.result === 'pass' && ['check', 'ac'].includes(r.kind))
    : [];
  const secretsProvided = isPhaseTest && provideLocalSecrets(wt);
  const prompt = resume
    ? resumePrompt(task, protocolAddendum(repoRoot, brand, config.protocolAddendum), brand.cli)
    : taskPrompt({ task, agent, otherTasks: running(), takeover, answers, contextDocs: config.contextDocs || [], cli: brand.cli, jiraCloudId: config.source?.cloudId || '', jiraManaged: Boolean(jiraRest()), priorResults, secretsProvided, localSecrets: config.phaseTestLocalSecrets, composeProject: config.phaseTestComposeProject, protocolAddendum: protocolAddendum(repoRoot, brand, config.protocolAddendum) });

  // Kleine Aufgaben laufen mit einem schnelleren Modell bzw. weniger Reasoning (config: agents.<name>.bySize)
  const sizeArgs = config.agents[agent].bySize?.[task.size]?.args || [];
  const sizeLabel = config.agents[agent].bySize?.[task.size]?.label;

  task.status = 'running';
  if (!task.jiraStarted) { task.jiraStarted = true; queueSourceAction(task, 'started'); }
  task.assignedAgent = agent;
  task.attempts = (task.attempts || 0) + 1;
  addNote(task, `${resume ? 'Fortsetzung' : takeover ? 'Übernahme' : 'Start'} durch ${agent} (Versuch ${task.attempts}${task.size ? `, Größe ${task.size}` : ''}${sizeLabel ? ` → ${sizeLabel}` : ''})`);
  state.agents[agent].runningTask = task.id;
  save();
  log(`${task.id} → ${agent} (${resume ? 'resume' : takeover ? 'Übernahme' : 'neu'})`);

  const run = new AgentRun({
    name: agent,
    agentCfg: agentCfgFor(agent),
    cwd: wt,
    prompt,
    resumeSessionId: resume ? task.sessions[agent] : null,
    logFile: path.join(runtimeDir, 'logs', `${task.id}-${agent}-${Date.now()}.jsonl`),
    maxRunMinutes: config.maxRunMinutes,
    codeGraph: config.codeGraph,
    extraArgs: sizeArgs,
    onEvent: (line) => {
      scheduleReport();
      if (verbose) for (const a of formatLine(line, config.agents[agent].kind, git.worktreeRoot)) printActivity(agent, task.id, a);
    },
  });
  const p = run.start()
    .then((outcome) => finishTask(agent, task, wt, outcome))
    .catch((err) => log(`${task.id}: Fehler bei Auswertung`, err.stack))
    .finally(() => { activeRuns.delete(agent); wake(); });
  activeRuns.set(agent, p);
  // PID im State, damit "ardai stop" auch aus einem anderen Prozess (CLI/Web) abbrechen kann
  task.pid = run.pid;
  state.agents[agent].pid = run.pid;
  save();
}

// Graph vor jedem Lauf auf den Stand des Task-Branches bringen: beim ersten
// Mal Vollaufbau (~25 s), danach inkrementell (~1 s). Fehler sind nicht fatal,
// der Agent arbeitet dann eben ohne aktuellen Graphen.
function refreshCodeGraph(wt) {
  const py = config.codeGraph?.python && expandEnv(config.codeGraph.python);
  if (!py) return;
  const hasGraph = fs.existsSync(path.join(wt, '.code-review-graph', 'graph.db'));
  const res = sh(py, ['-m', 'code_review_graph', hasGraph ? 'update' : 'build', '--repo', wt], { check: false, timeout: 15 * 60_000 });
  if (res.code !== 0) log(`code-review-graph ${hasGraph ? 'update' : 'build'} in ${wt} fehlgeschlagen:`, (res.stderr || res.stdout).split('\n').slice(-2).join(' '));
}

// Copy only the configured, git-ignored local test secrets for phase tests.
function provideLocalSecrets(wt) {
  const rel = config.phaseTestLocalSecrets;
  if (!rel) return false;
  const src = path.join(repoRoot, rel);
  if (!fs.existsSync(src)) { log(`Lokale Test-Secrets fehlen (${src}), Phasentest läuft ohne.`); return false; }
  const ignored = sh('git', ['-C', wt, 'check-ignore', '-q', path.join(rel, 'probe.txt')], { check: false }).code === 0;
  if (!ignored) { log(`${rel} ist im Worktree nicht per .gitignore ausgeschlossen – Secrets werden NICHT kopiert.`); return false; }
  fs.cpSync(src, path.join(wt, rel), { recursive: true });
  return true;
}

function removeLocalSecrets(wt) {
  if (config.phaseTestLocalSecrets) fs.rmSync(path.join(wt, config.phaseTestLocalSecrets), { recursive: true, force: true });
}

function readResult(wt) {
  try {
    return JSON.parse(fs.readFileSync(path.join(wt, '.orchestrator-run', 'result.json'), 'utf8'));
  } catch {
    return null;
  }
}

function finishTask(agent, task, wt, outcome) {
  (task.sessions ||= {})[agent] = outcome.sessionId;
  if (stopRequested.delete(task.id)) {
    // vom Nutzer abgebrochen: Arbeit sichern, nicht als Fehlschlag/Outage werten
    finalizeStop(task, agent);
    save();
    return;
  }
  const a = state.agents[agent];
  a.runningTask = null;
  a.pid = null;
  task.pid = null;
  task.assignedAgent = null;
  task.lastAgent = agent;
  (task.sessions ||= {})[agent] = outcome.sessionId;
  if (outcome.rateLimit?.windows) a.windows = outcome.rateLimit.windows;
  if (outcome.rateLimit?.detail) a.quota = outcome.rateLimit.detail;

  if (task.type === 'phase-test') removeLocalSecrets(wt);
  const result = readResult(wt);
  const at = nowIso();
  for (const t of result?.tests || []) {
    state.testResults.push({ ...t, taskId: task.id, epic: task.epic, agent, at });
  }
  for (const q of result?.questions || []) {
    state.questions.push({ id: `Q${state.nextQuestion++}`, taskId: task.id, agent, at, ...q, answer: null });
  }

  const release = (reason) => {
    try { git.autosaveAndRelease(wt, task.branch, reason); } catch (err) { log('Autosave fehlgeschlagen', err.message); }
  };

  if (outcome.outage) {
    const until = outcome.resetsAt || Date.now() + config.fallbackBackoffMinutes * 60_000;
    block(agent, until, outcome.rateLimit?.detail || outcome.error.slice(0, 120) || 'Rate-Limit');
    release('Token-Outage');
    task.status = 'interrupted';
    task.attempts = Math.max(0, task.attempts - 1); // Outage zählt nicht als Fehlversuch
    addNote(task, `Token-Outage bei ${agent}, gesperrt bis ${new Date(until).toLocaleString('de-DE')}`);
  } else if (outcome.timedOut) {
    release('Timeout');
    task.status = 'interrupted';
    addNote(task, `Timeout nach ${config.maxRunMinutes} min bei ${agent}`);
  } else if (outcome.completed && result?.status === 'done') {
    const failed = (result.tests || []).filter((t) => t.result === 'fail');
    release('Abschluss');
    if (failed.length) {
      retryOrFail(task, `Als done gemeldet, aber ${failed.length} Test(s) rot: ${failed[0].criterion}`);
    } else {
      const merge = git.mergeIntoIntegration(task.branch, `Merge ${task.branch}: ${task.title}`);
      if (merge.ok) {
        task.status = DONE;
        addNote(task, `Fertig, in ${config.integrationBranch} gemergt. ${result.summary || ''}`.trim());
        const tests = result.tests || [];
        const passed = tests.filter((x) => x.result === 'pass').length;
        queueSourceAction(task, 'review', { comment: [
          t('jira.comment.review', { task: task.id, branch: task.branch, target: config.integrationBranch }),
          result.summary || '',
          tests.length ? t('jira.comment.tests', { passed, total: tests.length }) : '',
        ].filter(Boolean).join('\n\n') });
      } else {
        task.mergeConflicts = (task.mergeConflicts || 0) + 1;
        task.notes = [...(task.notes || []), `Merge-Konflikt mit ${config.integrationBranch}: zuerst "git merge ${config.integrationBranch}" im Task-Branch ausführen, Konflikte lösen, Tests erneut prüfen.`];
        retryOrFail(task, `Merge-Konflikt mit ${config.integrationBranch}`);
      }
    }
  } else if (result?.status === 'needs-human') {
    release('Rückfrage');
    task.status = 'needs-human';
    addNote(task, 'Wartet auf Antwort des Menschen');
  } else {
    release('Fehlschlag');
    retryOrFail(task, result?.summary || outcome.error.slice(0, 300) || `Lauf ohne Ergebnisdatei beendet (Exit ${outcome.exitCode})`);
  }
  log(`${task.id}: ${task.status} – ${task.lastNote}`);
  ensurePhaseTests();
  save();
  if (result?.tests?.length) log(`Testbericht: ${link(writeResultsSnapshot())}`);
}

function retryOrFail(task, reason) {
  if (task.attempts >= config.maxAttempts) {
    task.status = 'failed';
    queueSourceAction(task, 'failed', { comment: t('jira.comment.failed', { task: task.id, branch: task.branch, attempts: task.attempts, reason: String(reason).slice(0, 500) }) });
    addNote(task, `Aufgegeben nach ${task.attempts} Versuchen: ${reason}`);
    state.questions.push({
      id: `Q${state.nextQuestion++}`, taskId: task.id, agent: ORCHESTRATOR_AGENT, at: nowIso(), blocking: true, answer: null,
      question: `${task.id} ist nach ${task.attempts} Versuchen gescheitert. Wie weiter?`,
      context: reason,
      assumption: 'Aufgabe ruht, andere Aufgaben laufen weiter. Nach Antwort: Befehl "retry".',
    });
  } else {
    task.status = 'ready';
    addNote(task, `Erneuter Versuch geplant: ${reason}`);
  }
}

// Fertige Aufgaben, deren Branch in main übernommen ist (also nach deinem
// Review), wandern automatisch ins Archiv. Nur Git, kein Jira-Aufruf.
function refreshArchive() {
  let changed = false;
  for (const task of state.tasks) {
    if (task.archivedAt || task.keepActive || task.status !== DONE) continue;
    const ref = `refs/heads/${task.branch}`;
    if (!git.branchExists(ref)) continue;
    if (git.git(repoRoot, ['merge-base', '--is-ancestor', ref, config.baseBranch], { check: false }).code === 0) {
      task.archivedAt = nowIso();
      addNote(task, t('archive.auto', { task: task.id, base: config.baseBranch }));
      log(t('archive.auto', { task: task.id, base: config.baseBranch }));
      changed = true;
    }
  }
  return changed;
}

// Wenn alle Umsetzungsaufgaben eines Epics fertig sind, folgt der gebündelte
// Playwright-/Container-Test als eigene Aufgabe.
function ensurePhaseTests() {
  for (const phaseTest of planPhaseTests(state.tasks, { skipEpics: config.phaseTests?.skipEpics, doneStatus: DONE })) {
    state.tasks.push(phaseTest);
    log(`Phasentest ${phaseTest.id} eingeplant`);
  }
}

// ---------------------------------------------------------------- Befehle

// Umfang eines "work"-Auftrags: nur diese Aufgaben (plus Phasentests ihrer
// Epics). null = alles, was im State steht (Befehl "run").
let scope = null;
const inScope = (t) => !scope || scope.has(t.id)
  || (t.type === 'phase-test' && state.tasks.some((x) => scope.has(x.id) && x.epic === t.epic));

function runnerAlive() {
  if (!fs.existsSync(lockFile)) return false;
  const pid = Number(fs.readFileSync(lockFile, 'utf8'));
  if (pid === process.pid) return false;
  try { process.kill(pid, 0); return pid; } catch { return false; }
}

// Läuft ardai, gehen alle steuernden Befehle (answer, retry, stop, clean, work)
// über eine Inbox-Datei an den laufenden Prozess – sonst würde der die Änderung
// beim nächsten Speichern überschreiben. Ohne laufenden Prozess wirken sie direkt.
async function processInbox() {
  if (!fs.existsSync(inboxFile)) return;
  const work = `${inboxFile}.${process.pid}`;
  try { fs.renameSync(inboxFile, work); } catch { return; }
  for (const line of fs.readFileSync(work, 'utf8').split('\n').filter(Boolean)) {
    try {
      const { cmd, args } = JSON.parse(line);
      log(await applyCommand(cmd, args));
    } catch (err) {
      log('Inbox:', err.message);
    }
  }
  fs.rmSync(work, { force: true });
  save();
}

function reloadState() {
  if (sourceBusy || flushing) return; // laufende Ticket-Aktualisierung nicht unter den Füßen wegziehen
  state = loadState(stateFile);
  for (const a of state.sourceActions || []) a.id ||= `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  for (const name of Object.keys(config.agents)) state.agents[name] ||= {};
}

let isRunner = false;               // true im Prozess von run/work
const stopRequested = new Set();    // Aufgaben, deren Agent gerade beendet wird
const cleanAfterStop = new Set();   // nach dem Stoppen gleich bereinigen
let shutdownRequested = false;      // "alles stoppen": danach beendet sich ardai

async function applyCommand(cmd, args = []) {
  if (cmd === 'patch') {
    const task = taskById(args[0]);
    if (!task) throw new Error(`Unknown task / Unbekannte Aufgabe: ${args[0]}`);
    const note = patchTask(task, args.slice(1), state.tasks, config.agents);
    if (note !== undefined) (task.notes ||= []).push(note);
    addNote(task, note ?? 'Task patched / Aufgabe korrigiert');
    return `${task.id}: patched / korrigiert`;
  }
  if (cmd === 'import') { await importTasks(args[0]); return 'Import complete / Import abgeschlossen'; }
  if (cmd === 'init') { cmdInit(); return 'Init complete'; }
  if (cmd === 'report') { renderLiveReport(); return link(writeResultsSnapshot()); }
  if (cmd === 'sync') {
    for (const action of state.sourceActions || []) delete action.retryAt;
    await flushSourceActions();
    return 'Sync complete / Sync abgeschlossen';
  }
  if (cmd === 'answer') {
    const [id, ...rest] = args;
    const { edits, text } = parseEdits(rest, { answer: true });
    const q = state.questions.find((x) => x.id === id);
    if (!q || !text.length) throw new Error('Aufruf: answer <Q-ID> "Antwort"');
    const task = taskById(q.taskId);
    if (edits.domain.length && !(task && (task.status === DONE || task.archivedAt))) throw new Error('--domain requires a follow-up / --domain benötigt einen Nachtrag');
    q.answer = text.join(' ');
    q.answeredAt = nowIso();
    const stillBlocking = state.questions.some((x) => x.taskId === q.taskId && x.blocking && !x.answer);
    if (task && ['needs-human', 'failed'].includes(task.status) && !stillBlocking) {
      task.status = 'ready';
      task.attempts = 0;
      addNote(task, `Antwort auf ${id} erhalten, wieder bereit`);
    }
    // Antwort auf eine bereits fertige Aufgabe: sonst setzt sie niemand mehr um.
    if (task && (task.status === DONE || task.archivedAt)) {
      const followUp = createFollowUp(task, q, edits.domain);
      return `${id} beantwortet. ${t('followup.created', { task: followUp.id })}`;
    }
    return `${id} beantwortet.${task ? ` ${task.id}: ${task.status}` : ''}`;
  }
  if (cmd === 'ack') {
    const q = state.questions.find((x) => x.id === args[0]);
    if (!q) throw new Error(`Unbekannter Hinweis ${args[0]}`);
    q.acknowledgedAt = nowIso();
    return t('ack.done', { id: q.id });
  }
  if (cmd === 'retry') {
    const task = taskById(args[0]);
    if (!task) throw new Error(t('clean.unknown', { task: args[0] }));
    if (task.status === 'running') throw new Error(`${task.id}: running / läuft; erst stoppen.`);
    const wasStopped = task.status === 'stopped';
    if (task.archivedAt) { delete task.archivedAt; task.keepActive = true; }
    // Gestoppt mit vorhandener Session: dieselbe Session fortsetzen (Kontext bleibt erhalten)
    const resumable = wasStopped && task.lastAgent && task.sessions?.[task.lastAgent];
    task.status = resumable ? 'interrupted' : 'ready';
    task.attempts = 0;
    addNote(task, 'Manuell neu gestartet');
    if (wasStopped) queueSourceAction(task, 'resumed');
    scope?.add(task.id);
    return t('retry.done', { task: task.id });
  }
  if (cmd === 'overage') {
    const [name, value] = args;
    if (!config.agents[name]) throw new Error(`Unbekannter Agent ${name}`);
    const enabled = value === true || ['on', 'an', 'true', '1'].includes(String(value).toLowerCase());
    state.agents[name].allowOverage = enabled;
    // Beim Einschalten eine Kontingent-Sperre aufheben, damit der Agent sofort weiterarbeiten kann
    if (enabled && state.agents[name].blockedUntil) Object.assign(state.agents[name], { blockedUntil: null, blockReason: null });
    return t('overage.set', { agent: name, state: t(enabled ? 'ui.on' : 'ui.off') });
  }
  if (cmd === 'archive' || cmd === 'unarchive') {
    const task = taskById(args[0]);
    if (!task) throw new Error(t('clean.unknown', { task: args[0] }));
    if (cmd === 'archive') {
      if (task.status === 'running') throw new Error(`${task.id} läuft noch – erst stoppen.`);
      task.archivedAt = nowIso();
      delete task.keepActive;
      addNote(task, 'Archiviert');
      return t('archive.done', { task: task.id });
    }
    delete task.archivedAt;
    task.keepActive = true; // nicht sofort wieder automatisch archivieren
    addNote(task, 'Aus dem Archiv zurückgeholt');
    return t('archive.restored', { task: task.id });
  }
  if (cmd === 'stop') return stopCommand(args[0]);
  if (cmd === 'clean') return cleanCommand(args[0]);
  if (cmd === 'work') return workCommand(args[0]);
  throw new Error(`Unbekannter Befehl ${cmd}`);
}

// Nachtrag zu einer fertigen Aufgabe: kleine Folgeaufgabe auf deren Bereich,
// die die Antwort des Menschen auf dem bereits gemergten Stand umsetzt.
function createFollowUp(task, q, domainEdits = []) {
  const { root, rootId, number, id } = followUpIdentity(task, state.tasks);
  root.followUpSequence = number;
  const followUp = {
    id, type: 'impl', jira: false, parentTicket: rootId, epic: root.epic,
    title: `Nachtrag zu ${task.id}: ${q.question.slice(0, 90)}`,
    description: [
      `Nachtrag zu ${task.id} (bereits umgesetzt und in ${config.integrationBranch}).`,
      `Der Agent hatte gefragt: "${q.question}"${q.context ? ` (Kontext: ${q.context})` : ''}.`,
      q.assumption ? `Weitergearbeitet wurde mit der Annahme: ${q.assumption}` : '',
      `Antwort des Menschen: "${q.answer}"`,
      `Setze die Antwort um, soweit sie vom bisherigen Stand abweicht. Jira-Ticket zur Einordnung: ${task.id}.`,
    ].filter(Boolean).join('\n'),
    acceptanceCriteria: [`Die Antwort des Menschen auf ${q.id} ist umgesetzt`, 'Bestehende Tests bleiben grün'],
    domain: extendDomain(root.domain, domainEdits), dependsOn: [], resources: [], size: 'S',
    preferredAgent: task.lastAgent || task.preferredAgent || null,
    branch: `task/${id}`, status: 'ready',
  };
  state.tasks.push(followUp);
  scope?.add(id);
  addNote(task, `Nachtrag ${id} aus Antwort auf ${q.id}`);
  return followUp;
}

async function sendOrApply(cmd, args) {
  if (runnerAlive()) {
    fs.appendFileSync(inboxFile, JSON.stringify({ cmd, args }) + '\n');
    return cmd === 'stop' ? t('stop.requested', { tasks: args[0] || '*' }) : t('ui.accepted', { action: cmd });
  }
  reloadState();
  const message = await applyCommand(cmd, args);
  if (['stop', 'clean'].includes(cmd)) await flushSourceActions();
  save();
  if (['retry', 'answer'].includes(cmd) && !isRunner && !runnerAlive()) {
    if (config.autoStartRunner || args.includes('--start')) return `${message} ${spawnRunner()}`;
    return `${message} No runner running / Kein Runner läuft. Start: ${brand.cli} run (oder --start).`;
  }
  return message;
}

// ---------------------------------------------------------------- Stop / Clean

function stopCommand(taskId) {
  const targets = taskId ? [taskById(taskId)].filter(Boolean) : running();
  if (taskId && !targets.length) throw new Error(t('clean.unknown', { task: taskId }));
  if (!taskId && isRunner) shutdownRequested = true;
  if (!targets.length) return shutdownRequested ? t('stop.all') : t('stop.none');
  for (const task of targets) {
    if (task.status === 'running') {
      if (isRunner && activeRuns.has(task.assignedAgent)) {
        stopRequested.add(task.id);
        killTree(task.pid); // finishTask erkennt den Stopp und sichert die Arbeit
      } else {
        // verwaister Lauf (ardai lief nicht oder wurde hart beendet)
        if (isAlive(task.pid)) { killTree(task.pid); log(t('stop.orphan', { task: task.id, pid: task.pid })); }
        finalizeStop(task, task.assignedAgent);
      }
    } else if (['ready', 'interrupted', 'needs-human', 'failed', 'blocked'].includes(task.status)) {
      task.status = 'stopped';
      addNote(task, t('stop.note', { branch: task.branch }));
      queueSourceAction(task, 'stopped');
    }
  }
  if (shutdownRequested) return t('stop.all');
  return t('stop.requested', { tasks: targets.map((x) => x.id).join(', ') });
}

// Arbeit sichern (Autosave-Commit + Push), Worktree freigeben, Status "stopped".
function finalizeStop(task, agent) {
  const wt = agent ? git.worktreePath(agent) : null;
  if (task.type === 'phase-test') {
    if (wt) removeLocalSecrets(wt);
    composeDown();
  }
  if (wt && fs.existsSync(wt)) {
    try { git.autosaveAndRelease(wt, task.branch, 'Stop'); } catch (err) { log('Autosave fehlgeschlagen', err.message); }
  }
  if (agent && state.agents[agent]) Object.assign(state.agents[agent], { runningTask: null, pid: null });
  task.pid = null;
  task.lastAgent = agent || task.lastAgent;
  task.assignedAgent = null;
  task.status = 'stopped';
  task.attempts = Math.max(0, (task.attempts || 1) - 1);
  addNote(task, t('stop.note', { branch: task.branch }));
  queueSourceAction(task, 'stopped');
  log(t('stop.done', { task: task.id, branch: task.branch }));
  if (cleanAfterStop.delete(task.id)) log(cleanTask(task));
}

function composeDown() {
  const project = config.phaseTestComposeProject;
  if (project) sh('docker', ['compose', '-p', project, 'down', '--remove-orphans'], { check: false, timeout: 180_000 });
}

function isMergedIntoIntegration(task) {
  if (task.status === DONE) return true;
  const res = git.git(repoRoot, ['log', config.integrationBranch, '--fixed-strings', `--grep=Merge ${task.branch}:`, '--format=%h', '-1'], { check: false });
  return Boolean(res.stdout);
}

function cleanCommand(taskId) {
  const task = taskById(taskId);
  if (!task) throw new Error(t('clean.unknown', { task: taskId }));
  if (isMergedIntoIntegration(task)) throw new Error(t('clean.merged', { task: task.id, integration: config.integrationBranch }));
  if (task.status === 'running') {
    if (isRunner && activeRuns.has(task.assignedAgent)) {
      cleanAfterStop.add(task.id);
      stopRequested.add(task.id);
      killTree(task.pid);
      return t('stop.requested', { tasks: task.id });
    }
    if (isAlive(task.pid)) killTree(task.pid);
    finalizeStop(task, task.assignedAgent);
  }
  return cleanTask(task);
}

// Branch lokal und remote löschen, Aufgabe samt Fragen/Testergebnissen entfernen.
function cleanTask(task) {
  const { branch } = task;
  for (const name of [...Object.keys(config.agents), 'integration']) {
    const wt = git.worktreePath(name);
    if (fs.existsSync(wt) && git.currentBranch(wt) === branch) git.git(wt, ['switch', '--detach'], { check: false });
  }
  git.git(repoRoot, ['branch', '-D', branch], { check: false });
  git.git(repoRoot, ['push', config.remote, '--delete', branch], { check: false });
  queueSourceAction(task, 'cleaned');
  state.tasks = state.tasks.filter((x) => x.id !== task.id);
  state.questions = state.questions.filter((q) => q.taskId !== task.id);
  state.testResults = state.testResults.filter((r) => r.taskId !== task.id);
  for (const imp of Object.values(state.imports || {})) imp.ids = imp.ids.filter((i) => i !== task.id);
  scope?.delete(task.id);
  return t('clean.done', { task: task.id, branch, remote: config.remote });
}

// ---------------------------------------------------------------- Neue Aufträge

const KEY_RE = new RegExp(`^(?:${config.keyPattern})$`);
function normalizeSource(src = {}) {
  const keys = (Array.isArray(src.keys) ? src.keys : String(src.keys || '').split(/[\s,;]+/))
    .map((k) => k.trim()).filter(Boolean).map((k) => taskById(k) ? k : k.toUpperCase());
  const jql = src.jql ? String(src.jql).trim() : null;
  if (!jql && !keys.length) throw new Error('Ticket-Keys oder JQL angeben.');
  const bad = keys.filter((k) => !taskById(k) && !KEY_RE.test(k));
  if (bad.length) throw new Error(`Ungültige Ticket-Keys: ${bad.join(', ')}`);
  return { keys: jql ? [] : keys, jql, file: null, force: Boolean(src.force) };
}
const describeSource = (s) => (s.jql ? `JQL "${s.jql}"` : s.keys.join(', '));

async function workCommand(src) {
  const source = src.file ? src : normalizeSource(src);
  if (!isRunner) return spawnRunner(source);
  const ids = await importTasks(source);
  if (scope) for (const id of ids) scope.add(id);
  wake();
  return t('work.queued', { source: describeSource(source) });
}

// Startet "ardai work …" als eigenen Hintergrundprozess (z. B. aus der Web-Oberfläche).
let runnerSpawnedAt = 0;
function spawnRunner(source = null) {
  runnerSpawnedAt = Date.now();
  const logFile = path.join(runtimeDir, 'runner.log');
  fs.mkdirSync(runtimeDir, { recursive: true });
  const out = fs.openSync(logFile, 'a');
  const args = [fileURLToPath(import.meta.url), ...(source ? ['work', ...(source.jql ? ['--jql', source.jql] : source.file ? ['--file', source.file] : source.keys)] : ['run']), '--no-ui'];
  // The runner changes cwd to the root; retain a caller-relative config override.
  const env = { ...process.env };
  if (project.overrideFile) env.ORCHESTRATOR_CONFIG = project.overrideFile;
  if (project.brandFile) env.ARDAI_BRAND_FILE = project.brandFile;
  const child = spawn(process.execPath, args, { cwd: repoRoot, detached: true, stdio: ['ignore', out, out], windowsHide: true, env });
  child.unref();
  fs.closeSync(out);
  return t('work.started', { source: source ? describeSource(source) : 'all / alle', log: link(logFile) });
}

// ---------------------------------------------------------------- Ticket-Aktualisierungen

// Direkter REST-Zugang (kein Agent, keine Tokens); null ohne E-Mail/API-Token.
let jiraClientCache;
function jiraRest() {
  if (jiraClientCache === undefined) {
    const auth = config.source ? loadJiraAuth({ config, repoRoot }) : null;
    jiraClientCache = auth ? new JiraClient(auth) : null;
  }
  return jiraClientCache;
}

let polisherCache;
const polisher = () => (polisherCache === undefined ? (polisherCache = createPolisher(config.ollama)) : polisherCache);

const REST_ONLY = new Set(['started', 'review', 'failed']);

function queueSourceAction(task, type, extra = {}) {
  if (!config.source || task.jira === false || task.type === 'phase-test') return;
  if (REST_ONLY.has(type) && !jiraRest()) return; // ohne REST-Zugang übernehmen die Agenten das Ticket selbst
  const q = (state.sourceActions ||= []);
  const pendingStop = q.findIndex((a) => a.taskId === task.id && a.type === 'stopped' && !a.sending);
  if (type === 'resumed' && pendingStop >= 0) { q.splice(pendingStop, 1); return; } // Stopp nie gesendet: nichts zu tun
  if (type === 'cleaned' && pendingStop >= 0) q.splice(pendingStop, 1);
  q.push({ id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, taskId: task.id, type, branch: task.branch, at: nowIso(), tries: 0, ...extra });
  log(t('source.pending', { task: task.id, action: type }));
}

let sourceBusy = false;
// Jede Aktion hat eine feste ID; Änderungen werden immer am aktuellen State
// vorgenommen (der kann zwischenzeitlich von der Platte neu geladen worden sein).
const findAction = (id) => (state.sourceActions || []).find((a) => a.id === id);
const dropAction = (id) => { state.sourceActions = (state.sourceActions || []).filter((a) => a.id !== id); };

async function processSourceActions() {
  if (sourceBusy) return false;
  // Ein laufender (oder gerade gestarteter) ardai ist allein zuständig
  if (!isRunner && (runnerAlive() || Date.now() - runnerSpawnedAt < 20_000)) return false;
  const next = (state.sourceActions || []).find((a) => !a.retryAt || new Date(a.retryAt).getTime() <= Date.now());
  if (!next) return false;
  const rest = jiraRest();
  const agent = rest ? null : Object.keys(config.agents).find((n) => config.agents[n].enabled && isAvailable(n));
  if (!rest && !agent) return false;
  sourceBusy = true;
  const { id, taskId, type } = next;
  try {
    let r;
    if (rest && REST_ACTIONS.has(type)) {
      try {
        await applyAction(rest, next, { src: config.source, t: (k, v) => t(k, v), polish: polisher() });
        r = { ok: true };
      } catch (err) {
        r = { ok: false, error: err.message };
      }
    } else if (agent) {
      r = await runSourceAction(next, { src: config.source, t, agent, agentCfg: agentCfgFor(agent), runtimeDir });
    } else {
      r = { ok: false, error: 'kein Agent frei' };
    }
    if (r.ok) {
      dropAction(id);
      log(t('source.sent', { task: taskId, action: type }));
    } else {
      const cur = findAction(id) || next;
      cur.tries = (cur.tries || 0) + 1;
      cur.lastError = r.error;
      cur.retryAt = new Date(Date.now() + 2 ** cur.tries * 60_000).toISOString(); // 2, 4 min …
      log(t('source.failed', { task: taskId, action: type, error: r.error }));
      if (r.outage && agent) block(agent, r.resetsAt || Date.now() + config.fallbackBackoffMinutes * 60_000, 'Outage bei Ticket-Aktualisierung');
      if (cur.tries >= 3) {
        dropAction(id);
        state.questions.push({
          id: `Q${state.nextQuestion++}`, taskId, agent: ORCHESTRATOR_AGENT, at: nowIso(), blocking: false, answer: null,
          question: t('source.failed', { task: taskId, action: type, error: '' }).replace(/:\s*$/, ''),
          context: r.error, assumption: 'Bitte das Ticket von Hand aktualisieren.',
        });
      }
    }
    save();
    return r.ok;
  } finally {
    sourceBusy = false;
  }
}

// Alle fälligen Ticket-Aktualisierungen senden (z. B. vor dem Beenden).
// Wartet, falls gerade eine im Hintergrund läuft; höchstens 5 Minuten.
let flushing = 0;
async function flushSourceActions() {
  flushing += 1;
  try {
    const deadline = Date.now() + 5 * 60_000;
    while ((state.sourceActions || []).length && Date.now() < deadline) {
      if (sourceBusy) { await new Promise((r) => setTimeout(r, 500)); continue; }
      const before = state.sourceActions.length;
      const ok = await processSourceActions();
      if (!ok && state.sourceActions.length === before) break; // kein Agent frei, nichts fällig oder ardai läuft
    }
  } finally {
    flushing -= 1;
  }
}

async function importTasks({ keys = [], jql = null, file = null, force = false }) {
  if (!file) ({ keys, jql } = normalizeSource({ keys, jql }));
  // Local IDs never go through the external ticket source, including mixed work orders.
  const localIds = !file && !jql ? keys.filter((id) => taskById(id) && !KEY_RE.test(id)) : [];
  keys = keys.filter((id) => !localIds.includes(id));
  if (localIds.length && !keys.length) return localIds;
  // Gerade erst importiert? Dann den Agenten-Import (~1 min) überspringen.
  const sourceKey = file ? null : jql ? `jql:${jql}` : `keys:${[...keys].sort().join(',')}`;
  if (!file && !jql && !force && keys.length && keys.every((k) => taskById(k))) {
    log(`Import übersprungen: ${keys.join(', ')} bereits bekannt (--reimport erzwingt neuen Import).`);
    return [...localIds, ...keys];
  }
  const cached = sourceKey && state.imports?.[sourceKey];
  if (cached && !force && Date.now() - cached.at < config.reimportMinutes * 60_000) {
    log(`Import übersprungen: vor ${Math.round((Date.now() - cached.at) / 60_000)} min bereits importiert (--reimport erzwingt neuen Import).`);
    return [...localIds, ...cached.ids];
  }
  let items;
  if (file) {
    items = readJson(path.resolve(file));
  } else {
    const agent = Object.keys(config.agents).find((n) => isAvailable(n));
    if (!agent) throw new Error('Kein Agent verfügbar.');
    const out = path.join(runtimeDir, `import-${Date.now()}.json`);
    log(`Import über ${agent}: ${jql ? `JQL "${jql}"` : keys.join(', ')}`);
    const run = new AgentRun({
      name: agent, agentCfg: agentCfgFor(agent), cwd: repoRoot, prompt: importPrompt({ keys, jql }, out, config),
      logFile: path.join(runtimeDir, 'logs', `import-${agent}-${Date.now()}.jsonl`), maxRunMinutes: 30,
    });
    const outcome = await run.start();
    if (outcome.outage) block(agent, outcome.resetsAt || Date.now() + config.fallbackBackoffMinutes * 60_000, 'Outage beim Import');
    if (!fs.existsSync(out)) throw new Error(`Import fehlgeschlagen: ${outcome.error || 'keine Datei erzeugt'}`);
    items = readJson(out);
  }
  let added = 0, updated = 0;
  for (const it of items) {
    const existing = taskById(it.id);
    const fields = {
      title: it.title, epic: it.epic, description: it.description, acceptanceCriteria: it.acceptanceCriteria || [],
      domain: it.domain?.length ? it.domain : [''], dependsOn: it.dependsOn || [], preferredAgent: it.preferredAgent || null,
      resources: it.resources || [], size: ['S', 'M', 'L'].includes(it.size) ? it.size : 'M',
    };
    if (existing) {
      if (['ready', 'blocked'].includes(existing.status)) {
        Object.assign(existing, fields);
        if (hasStoppedLabel(it.labels, brand) || it.labels?.includes(config.source.stoppedLabel)) existing.status = 'stopped';
        updated++;
      }
    } else {
      state.tasks.push({ id: it.id, type: 'impl', branch: `task/${it.id}`, status: hasStoppedLabel(it.labels, brand) || it.labels?.includes(config.source.stoppedLabel) ? 'stopped' : 'ready', ...fields });
      added++;
    }
  }
  const ids = items.map((it) => it.id);
  if (sourceKey) (state.imports ||= {})[sourceKey] = { at: Date.now(), ids };
  save();
  log(`Import: ${added} Aufgaben neu, ${updated} aktualisiert.`);
  return [...localIds, ...ids];
}

// Gemeinsame Optionen von import/work: Ticket-Keys, --jql "<JQL>" oder --file <json>
function parseSource(args) {
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const jql = opt('--jql');
  const file = opt('--file');
  const keys = args.filter((a, i) => !a.startsWith('--') && !['--jql', '--file'].includes(args[i - 1]));
  if (!jql && !file && !keys.length) throw new Error('Ticket-Keys, --jql "<JQL>" oder --file <json> angeben.');
  return { keys, jql, file, force: args.includes('--reimport') };
}

async function cmdImport(args) {
  // Ein ausdrücklicher Import holt immer frisch aus Jira.
  const source = { ...parseSource(args), force: true };
  if (source.file) source.file = path.resolve(source.file);
  console.log(await sendOrApply('import', [source]));
}

// run: arbeitet alles im State ab und läuft dauerhaft (oder bis leer mit --exit-when-idle).
// work: importiert die angegebenen Tickets und arbeitet NUR diese ab, bis alle
// fertig sind – über Outages hinweg und inklusive Warten auf deine Antworten.
async function cmdRun(args, { source = null } = {}) {
  const other = runnerAlive();
  if (other) { console.error(`Orchestrator läuft bereits (PID ${other}).`); process.exit(1); }
  isRunner = true;
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(lockFile, String(process.pid));
  const cleanup = () => { try { fs.rmSync(lockFile); } catch { /* egal */ } };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { log(`Beende (laufende Agenten laufen weiter; "${brand.cli} stop" beendet sie, ein Neustart setzt sie fort)`); process.exit(0); });

  // Nach einem Neustart des Orchestrators sind vorher laufende Aufgaben verwaist:
  // noch lebende Agenten beenden, die Aufgabe wird per Resume fortgesetzt.
  for (const task of running()) {
    if (isAlive(task.pid)) killTree(task.pid);
    task.status = 'interrupted';
    task.lastAgent = task.assignedAgent;
    task.assignedAgent = null;
    task.pid = null;
    addNote(task, 'Orchestrator wurde neu gestartet');
  }
  for (const a of Object.values(state.agents)) Object.assign(a, { runningTask: null, pid: null });
  git.ensureIntegrationBranch();
  for (const [name, cfg] of Object.entries(config.agents)) if (cfg.enabled) git.ensureWorktree(name);
  save();

  if (!args.includes('--no-ui') && config.ui?.enabled !== false) await startUi({ open: args.includes('--open') });

  // Import für work: bei Outage aller Agenten warten statt abbrechen.
  let lastImport = 0;
  const reimport = async () => {
    try {
      const ids = await importTasks(source);
      scope ||= new Set();
      for (const id of ids) scope.add(id);
      lastImport = Date.now();
      return true;
    } catch (err) {
      log(`Import nicht möglich (${err.message.split('\n')[0]}), neuer Versuch im nächsten Takt.`);
      return false;
    }
  };
  if (source) {
    scope = new Set();
    while (!(await reimport())) await new Promise((r) => setTimeout(r, config.tickSeconds * 1000));
    if (!scope.size) { log('Keine Aufgaben gefunden.'); process.exit(0); }
    log(`Auftrag: ${[...scope].join(', ')}`);
  }
  log(`Orchestrator gestartet. Live-Bericht: ${link(reportFile)}`);

  // Steuerbefehle (CLI/Web) sofort aufgreifen statt erst beim nächsten Takt.
  setInterval(() => { if (fs.existsSync(inboxFile)) wake(); }, 1000).unref();

  const exitWhenIdle = args.includes('--exit-when-idle');
  let lastWaitingLog = 0;
  for (;;) {
    try {
    await processInbox();
    processSourceActions().catch((err) => log('Ticket-Aktualisierung:', err.message)); // läuft nebenher

    if (shutdownRequested) {
      if (activeRuns.size === 0) {
        await flushSourceActions();
        save();
        log(`${brand.name} beendet.`);
        process.exit(0);
      }
    } else {
      // Bei JQL-Aufträgen regelmäßig neu abfragen, damit später gelabelte Tickets dazukommen.
      if (source?.jql && Date.now() - lastImport > config.reimportMinutes * 60_000 && !activeRuns.size) await reimport();
      for (const task of state.tasks) if (task.status === 'blocked' && depsDone(task)) task.status = 'ready';
      ensurePhaseTests();
      refreshArchive();
      checkpointRunning();
      for (const agent of Object.keys(config.agents)) {
        if (activeRuns.has(agent) || !isAvailable(agent)) continue;
        const task = selectTask(agent);
        if (task) startTask(agent, task);
      }
    }
    save();

    const mine = state.tasks.filter(inScope);
    if (source && !shutdownRequested && activeRuns.size === 0 && mine.every((x) => [DONE, 'stopped'].includes(x.status))) {
      await flushSourceActions();
      log(`Auftrag beendet: ${mine.filter((x) => x.status === DONE).length} fertig und in ${config.integrationBranch}, ${mine.filter((x) => x.status === 'stopped').length} gestoppt.`);
      writeResultsSnapshot();
      process.exit(0);
    }
    if (exitWhenIdle && activeRuns.size === 0 && !mine.some((x) => RUNNABLE.has(x.status))) {
      await flushSourceActions();
      log('Nichts mehr zu tun.');
      process.exit(0);
    }
    const waiting = mine.filter((x) => ['needs-human', 'failed'].includes(x.status));
    if (activeRuns.size === 0 && waiting.length && !mine.some((x) => RUNNABLE.has(x.status)) && Date.now() - lastWaitingLog > 30 * 60_000) {
      log(`Warte auf deine Antworten (${waiting.map((x) => x.id).join(', ')}). Siehe "${brand.cli} status" bzw. ${link(reportFile)}`);
      lastWaitingLog = Date.now();
    }
    } catch (err) {
      // Ein Fehler in einem Takt darf ardai nicht beenden (unbeaufsichtigter Betrieb).
      log(`Fehler im Takt, ${brand.name} läuft weiter:`, err.stack || err.message);
    }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, config.tickSeconds * 1000);
      wake = () => { clearTimeout(timer); resolve(); };
    });
  }
}

// Sichert den Stand laufender Aufgaben unter refs/ardai/wip/<Aufgabe>; Fehler dürfen den Takt nie stören.
const lastCheckpoint = new Map();
function checkpointRunning() {
  const minutes = Number(config.checkpointMinutes);
  if (!(minutes > 0)) return;
  for (const task of running()) {
    if (Date.now() - (lastCheckpoint.get(task.id) || 0) < minutes * 60_000) continue;
    lastCheckpoint.set(task.id, Date.now());
    try {
      const commit = git.checkpoint(git.worktreePath(task.assignedAgent), task.id);
      if (commit) log(`${task.id}: Checkpoint ${commit.slice(0, 8)} unter refs/ardai/wip/${task.id}`);
    } catch (err) {
      log(`${task.id}: Checkpoint fehlgeschlagen (${err.message.split('\n')[0]})`);
    }
  }
}

async function cmdWork(args) {
  const source = parseSource(args);
  if (!source.file) Object.assign(source, normalizeSource(source));
  // Läuft bereits ein ardai, den Auftrag an ihn übergeben statt abzubrechen.
  if (runnerAlive()) {
    const job = source.file ? { ...source, file: path.resolve(source.file) } : source;
    fs.appendFileSync(inboxFile, JSON.stringify({ cmd: 'work', args: [job] }) + '\n');
    console.log(t('work.queued', { source: describeSource(job) }));
    return;
  }
  await cmdRun(args, { source });
}

// ---------------------------------------------------------------- Web-Oberfläche

function uiHtml(token, fragmentOnly) {
  if (!isRunner) {
    reloadState();
    if (!runnerAlive() && refreshArchive()) save();
  }
  return buildReportHtml(state, { ...reportData(), activity: liveActivity(), ui: { t, token, runnerAlive: isRunner || Boolean(runnerAlive()) }, fragmentOnly });
}

async function startUi({ open = false } = {}) {
  const ui = await startServer({
    port: config.ui?.port || 4711,
    t,
    log,
    page: (token) => uiHtml(token, false),
    fragment: (token) => uiHtml(token, true),
    onAction: async (action, body) => {
      const args = action === 'answer' ? [body.id, body.text] : action === 'work' ? [body] : action === 'overage' ? [body.agent, body.enabled] : [body.task];
      if (action === 'clean' && body.confirm !== body.task) throw new Error('Bestätigung fehlt.');
      if (isRunner || runnerAlive()) {
        if (action === 'work') normalizeSource(body); // Eingabe gleich prüfen, Fehler sofort zurückmelden
        fs.appendFileSync(inboxFile, JSON.stringify({ cmd: action, args }) + '\n');
        if (isRunner) wake();
        return action === 'stop' ? t('stop.requested', { tasks: body.task || '*' }) : t('ui.accepted', { action });
      }
      reloadState();
      if (action !== 'work') return sendOrApply(action, args);
      return workCommand(body); // Explicit work starts a runner; it owns subsequent state writes.
    },
  });
  log(t('serve.url', { url: ui.url }));
  if (open) spawn('cmd.exe', ['/c', 'start', '""', ui.url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  return ui;
}

// ardai serve: nur die Web-Oberfläche (z. B. um neue Aufträge zu starten, wenn ardai gerade nicht läuft)
async function cmdServe(args) {
  fs.mkdirSync(runtimeDir, { recursive: true });
  await startUi({ open: !args.includes('--no-open') });
  log('Strg+C beendet die Web-Oberfläche.');
  await new Promise(() => {}); // läuft, bis der Prozess beendet wird
}

async function cmdStop([taskId]) {
  console.log(await sendOrApply('stop', [taskId]));
}

// ardai sync: vorgemerkte Ticket-Aktualisierungen jetzt senden (Wartezeit ignorieren)
async function cmdSync() {
  if (runnerAlive()) { console.log(await sendOrApply('sync', [])); return; }
  const pending = state.sourceActions || [];
  if (!pending.length) { console.log('Keine vorgemerkten Ticket-Aktualisierungen.'); return; }
  for (const a of pending) delete a.retryAt;
  console.log(`Sende ${pending.length} Ticket-Aktualisierung(en): ${pending.map((a) => `${a.taskId} (${a.type})`).join(', ')}`);
  await flushSourceActions();
  save();
  const left = state.sourceActions || [];
  console.log(left.length ? `Noch offen: ${left.map((a) => `${a.taskId} (${a.type}): ${a.lastError || ''}`).join('; ')}` : 'Alle gesendet.');
}

// ardai hints [--all]: gesammelte Hinweise der Agenten (auch archivierter Aufgaben)
function cmdHints(args) {
  const all = args.includes('--all');
  const list = collectHints(state, brand).filter((h) => all || h.state === 'open');
  if (!list.length) { console.log(all ? 'Keine Hinweise gesammelt.' : 'Keine offenen Hinweise. (--all zeigt auch beantwortete und bestätigte)'); return; }
  let last = null;
  for (const h of list) {
    if (h.taskId !== last) { console.log(`
${h.taskId}${h.task ? ` (${h.task.status}${h.task.archivedAt ? ', archiviert' : ''})` : ''}`); last = h.taskId; }
    console.log(`  ${h.id}${all ? ` [${h.state}]` : ''}: ${h.question}`);
    if (h.assumption) console.log(`      Annahme: ${h.assumption}`);
  }
  console.log(`
Vollständige Sammlung: ${link(hintsFile)}`);
}

async function cmdClean([taskId]) {
  if (!taskId) throw new Error(`Aufruf: ${brand.cli} clean <TASK-ID>`);
  console.log(await sendOrApply('clean', [taskId]));
}

function cmdStatus() {
  const cap = reportData().capacity;
  for (const [name, a] of Object.entries(state.agents)) {
    const blocked = a.blockedUntil && new Date(a.blockedUntil) > new Date() ? `gesperrt bis ${new Date(a.blockedUntil).toLocaleString('de-DE')}` : 'verfügbar';
    const windows = (cap[name]?.windows || []).map((w) => `${w.label} ${w.percent} %`).join(' · ');
    console.log(`${name.padEnd(8)} ${(a.runningTask ? `arbeitet an ${a.runningTask}` : blocked).padEnd(32)} ${windows}`);
  }
  console.log('');
  for (const t of state.tasks) console.log(`${t.id.padEnd(20)} ${t.status.padEnd(12)} ${(t.assignedAgent || t.lastAgent || '').padEnd(7)} ${t.lastNote || ''}`);
  const open = state.questions.filter((q) => q.blocking && !q.answer);
  const hintList = state.questions.filter((q) => !q.blocking && !q.answer && !q.acknowledgedAt);
  if (open.length) {
    console.log('\nOffene Fragen:');
    for (const q of open) console.log(`${q.id} [${q.taskId}]: ${q.question}`);
  }
  const pendingActions = state.sourceActions || [];
  if (pendingActions.length) {
    console.log(`\nVorgemerkte Ticket-Aktualisierungen ("${brand.cli} sync" sendet sofort):`);
    for (const a of pendingActions) console.log(`${a.taskId} (${a.type})${a.tries ? `, ${a.tries} Fehlversuch(e): ${a.lastError || ''}` : ''}`);
  }
  if (hintList.length) {
    console.log(`\nHinweise (Agent hat mit Annahme weitergearbeitet; "${brand.cli} ack <ID>" bestätigt, "${brand.cli} answer <ID> …" widerspricht):`);
    for (const q of hintList) console.log(`${q.id} [${q.taskId}]: ${q.question}`);
  }
  for (const a of liveActivity(5)) {
    const ago = Math.round((Date.now() - a.updatedAt) / 1000);
    console.log(`\nAktivität ${a.agent}/${a.task} (zuletzt vor ${ago < 120 ? `${ago} s` : `${Math.round(ago / 60)} min`}):`);
    for (const i of a.items) console.log(`  ${ACTIVITY_MARK[i.kind] || '•'} ${i.text}`);
  }
  console.log(`\nOrchestrator ${runnerAlive() ? 'läuft' : 'läuft nicht'}.\nLive-Bericht: ${link(reportFile)}\nLive-Verlauf im Terminal: ${brand.cli} log -f`);
}

// ardai log [TASK|AGENT] [-f] [-n N]: Verlauf der Agenten wie im Chat.
// Ohne Filter: alle gerade laufenden Aufgaben (bzw. das jüngste Log).
async function cmdLog(args) {
  const follow = args.includes('-f') || args.includes('--follow');
  const nIdx = args.indexOf('-n');
  const n = nIdx >= 0 ? Number(args[nIdx + 1]) : 30;
  const filter = args.find((a, i) => !a.startsWith('-') && args[i - 1] !== '-n');

  const pickFiles = () => {
    const logs = listLogs(logDir);
    if (filter) {
      const hit = logs.filter((l) => l.task === filter || l.agent === filter || l.task.startsWith(filter)).pop();
      return hit ? [hit.file] : [];
    }
    const current = loadState(stateFile).tasks.filter((t) => t.status === 'running');
    const files = current.map((t) => logs.filter((l) => l.task === t.id && l.agent === t.assignedAgent).pop()?.file).filter(Boolean);
    return files.length ? files : logs.slice(-1).map((l) => l.file);
  };

  const offsets = new Map();
  const print = (file, items) => {
    const info = parseLogName(file);
    for (const i of items) console.log(`${info.agent}/${info.task} ${ACTIVITY_MARK[i.kind] || '•'} ${i.text}`);
  };
  const initial = pickFiles();
  if (!initial.length) { console.log('Noch keine Agent-Logs vorhanden.'); return; }
  for (const file of initial) {
    print(file, tailActivity(file, n, 2_000_000, git.worktreeRoot).items);
    offsets.set(file, fs.statSync(file).size);
  }
  if (!follow) return;

  console.log('— folge dem Verlauf (Strg+C beendet) —');
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000));
    for (const file of pickFiles()) {
      const size = fs.statSync(file).size;
      const from = offsets.get(file) ?? 0; // neue Datei (z. B. Übernahme): von Anfang an
      if (size <= from) { offsets.set(file, from); continue; }
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      fs.closeSync(fd);
      const text = buf.toString('utf8');
      const end = text.lastIndexOf('\n') + 1; // nur vollständige Zeilen
      offsets.set(file, from + Buffer.byteLength(text.slice(0, end)));
      const info = parseLogName(file);
      print(file, text.slice(0, end).split('\n').flatMap((l) => formatLine(l.trim(), info.agent, git.worktreeRoot)));
    }
  }
}

function cmdInit() {
  // The bundled hook is a tool asset; a custom hook is project-relative.
  const hookSrc = config.hooks.prePush
    ? path.resolve(repoRoot, config.hooks.prePush)
    : fileURLToPath(new URL('./hooks/pre-push', import.meta.url));
  // Respect core.hooksPath and linked worktrees (.git can be a file).
  const hookDst = path.resolve(repoRoot, git.git(repoRoot, ['rev-parse', '--git-path', 'hooks/pre-push']).stdout);
  if (fs.existsSync(hookDst) && !fs.readFileSync(hookDst, 'utf8').includes('orchestrator-pre-push')) {
    throw new Error(`Es gibt schon einen eigenen pre-push-Hook (${hookDst}). Bitte manuell zusammenführen.`);
  }
  fs.mkdirSync(path.dirname(hookDst), { recursive: true });
  if (config.hooks.prePush) fs.copyFileSync(hookSrc, hookDst);
  else fs.writeFileSync(hookDst, renderPrePushHook(fs.readFileSync(hookSrc, 'utf8'), git.worktreeRoot));
  fs.chmodSync(hookDst, 0o755);
  git.ensureIntegrationBranch();
  git.git(repoRoot, ['push', '-u', config.remote, config.integrationBranch], { check: false });
  for (const [name, cfg] of Object.entries(config.agents)) if (cfg.enabled) git.ensureWorktree(name);
  git.ensureWorktree('integration');
  save();
  console.log(`Init fertig: Hook installiert, Branch ${config.integrationBranch}, Worktrees unter ${git.worktreeRoot}`);
}

// Legt den Befehl "ardai" in einem PATH-Verzeichnis an (für PowerShell/cmd
// und Git Bash), damit der Orchestrator aus jedem Verzeichnis aufrufbar ist.
function cmdInstallCli([dir], brand = DEFAULT_BRAND) {
  const target = dir || path.join(process.env.USERPROFILE || process.env.HOME, '.local', 'bin');
  const script = fileURLToPath(import.meta.url);
  fs.mkdirSync(target, { recursive: true });
  for (const name of cliNames(brand)) {
    fs.writeFileSync(path.join(target, `${name}.cmd`), `@echo off\r\nnode "${script}" %*\r\n`);
    const shell = path.join(target, name);
    fs.writeFileSync(shell, `#!/bin/sh\nexec node "${script.split(path.sep).join('/')}" "$@"\n`);
    fs.chmodSync(shell, 0o755);
  }
  const norm = (p) => path.resolve(p).toLowerCase();
  const onPath = (process.env.PATH || '').split(path.delimiter).filter(Boolean).some((p) => norm(p) === norm(target));
  console.log(`${brand.cli} installiert in ${target}${onPath ? '' : ' – ACHTUNG: Verzeichnis liegt nicht im PATH'}`);
}

const commands = { 'install-cli': cmdInstallCli, log: cmdLog, run: cmdRun, work: cmdWork, import: cmdImport, status: cmdStatus, patch: async (a) => console.log(await sendOrApply('patch', a)), answer: async (a) => console.log(await sendOrApply('answer', a)), retry: async (a) => console.log(await sendOrApply('retry', a)), stop: cmdStop, clean: cmdClean, hints: cmdHints, sync: cmdSync, ack: async (a) => console.log(await sendOrApply('ack', a)), serve: cmdServe, archive: async (a) => console.log(await sendOrApply('archive', a)), unarchive: async (a) => console.log(await sendOrApply('unarchive', a)), overage: async (a) => console.log(await sendOrApply('overage', a)), init: async () => console.log(await sendOrApply('init', [])), report: async () => console.log(await sendOrApply('report', [])) };
function printHelp(brand = DEFAULT_BRAND) {
  console.log([
    `${brand.name} – Orchestrator für Claude + Codex`,
    '',
    `  ${brand.cli} work <KEY...>               Tickets importieren und bis zum Ende bearbeiten`,
    `  ${brand.cli} work --jql "<JQL>"          alle Tickets einer JQL-Abfrage, alle 30 min neu abgefragt`,
    `  ${brand.cli} import <KEY...>|--jql|--file  nur importieren (zum Prüfen)`,
    `  ${brand.cli} run [--exit-when-idle]      alles im State abarbeiten (work/run mit -v: Verlauf im Terminal)`,
    `  ${brand.cli} status                      Stand und offene Fragen`,
    `  ${brand.cli} log [TASK|AGENT] [-f] [-n N]  Verlauf der Agenten wie im Chat (-f: live folgen)`,
    `  ${brand.cli} answer <Q-ID> "<Text>"      Frage beantworten / Hinweis widersprechen`,
    `  ${brand.cli} answer <Q-ID> "<Text>" [--domain +pfad] [--start]`,
    `  ${brand.cli} step START|DONE|NOTE "<Text>"  (für Agenten im Worktree) Handoff-Eintrag; DONE committet und pusht`,
    `  ${brand.cli} handoff [--all] [--last N]    (für Agenten) Plan und letzte Handoff-Einträge`,
    `  ${brand.cli} patch <TASK> --epic E --domain +pfad/-pfad --note "Text" --agent claude|codex --depends +ID/-ID --size S|M|L`,
    `  ${brand.cli} ack <Q-ID>                  Hinweis bestätigen (Annahme passt)`,
    `  ${brand.cli} hints [--all]               gesammelte Hinweise der Agenten (auch archivierter Aufgaben)`,
    `  ${brand.cli} sync                        vorgemerkte Ticket-Aktualisierungen jetzt senden`,
    `  ${brand.cli} retry <TASK-ID> [--start]   gestoppte/gescheiterte Aufgabe fortsetzen`,
    `  ${brand.cli} stop [TASK-ID]              Agent abbrechen, Arbeit auf dem Branch sichern (ohne ID: alles, ${brand.name} endet)`,
    `  ${brand.cli} clean <TASK-ID>             Aufgabe verwerfen: Branch löschen, Ticket auf To Do`,
    `  ${brand.cli} serve [--no-open]           Web-Oberfläche (auch ohne laufenden Auftrag)`,
    `  ${brand.cli} overage <agent> on|off      kostenpflichtige Kontingente für einen Agenten erlauben (Standard: off)`,
    `  ${brand.cli} archive|unarchive <TASK-ID> Aufgabe ins Archiv / zurückholen (fertige Aufgaben in main: automatisch)`,
    `  ${brand.cli} report                      Testbericht nach resultsDir schreiben`,
    `  ${brand.cli} init | install-cli          Einrichtung`,
    `Alias: ${brand.aliases.join(', ')}`,
  ].join('\n'));
}
if (!commands[cmd]) { printHelp(brand); process.exit(1); }
try {
  await commands[cmd](args);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
