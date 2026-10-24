import fs from 'node:fs';
import { listLogs, agentKind } from './activity.mjs';
import { listRollouts } from './agents.mjs';

// Token-Verbrauch, Laufzeit und Kapazität – alles aus den vorhandenen Logs
// abgeleitet, damit es auch für bereits gelaufene Aufgaben stimmt.
//
// Normalisierte Tokenfelder (beide Agenten):
//   fresh  = neu verarbeitete Eingabe (Claude: input + cache_creation; Codex: input - cached)
//   cached = aus dem Prompt-Cache gelesene Eingabe (deutlich günstiger)
//   output = erzeugte Ausgabe inkl. Reasoning/Thinking
//   costUsd = nur Claude: API-Gegenwert laut Claude Code (bei Abo nur Richtwert)
//   final  = false, solange der Lauf noch keine Abschluss-Zahlen geliefert hat

const cache = new Map(); // file -> { size, result }

function parseLog(file, agent) {
  const stat = fs.statSync(file);
  const hit = cache.get(file);
  if (hit && hit.size === stat.size && hit.kind === agent) return hit.result;

  const u = { fresh: 0, cached: 0, output: 0, costUsd: 0, final: false, rate: null, rateAt: null };
  const claudeMsgs = new Map(); // message.id -> usage (stream-json wiederholt pro Content-Block)
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('usage') && !line.includes('rate_limit')) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (agent === 'claude') {
      if (ev.type === 'assistant' && ev.message?.usage) claudeMsgs.set(ev.message.id, ev.message.usage);
      if (ev.type === 'result' && ev.usage) {
        Object.assign(u, claudeUsage(ev.usage), { costUsd: ev.total_cost_usd || 0, final: true });
      }
      if (ev.type === 'rate_limit_event' && ev.rate_limit_info?.unifiedWindows) {
        u.rate = ev.rate_limit_info.unifiedWindows;
        u.rateAt = stat.mtimeMs;
      }
    } else if (ev.type === 'turn.completed' && ev.usage) {
      const x = ev.usage;
      u.fresh += Math.max(0, (x.input_tokens || 0) - (x.cached_input_tokens || 0));
      u.cached += x.cached_input_tokens || 0;
      u.output += (x.output_tokens || 0) + (x.reasoning_output_tokens || 0);
      u.final = true;
    }
  }
  if (agent === 'claude' && !u.final) {
    // Zwischenstand: Summe der bisherigen API-Antworten (Ausgabe fällt dabei zu niedrig aus)
    for (const x of claudeMsgs.values()) {
      const c = claudeUsage(x);
      u.fresh += c.fresh; u.cached += c.cached; u.output += c.output;
    }
  }
  const result = { ...u, startMs: null, endMs: stat.mtimeMs };
  cache.set(file, { size: stat.size, kind: agent, result });
  return result;
}

function claudeUsage(x) {
  return {
    fresh: (x.input_tokens || 0) + (x.cache_creation_input_tokens || 0),
    cached: x.cache_read_input_tokens || 0,
    output: x.output_tokens || 0,
  };
}

// Summe über alle Läufe einer Aufgabe (inkl. Übernahmen/Fortsetzungen).
export function taskUsage(logDir, taskId, agents = {}) {
  const runs = listLogs(logDir, agents).filter((l) => l.task === taskId);
  if (!runs.length) return null;
  const sum = { fresh: 0, cached: 0, output: 0, costUsd: 0, final: true, runs: runs.length, agentMs: 0, startMs: Infinity, endMs: 0, byAgent: {} };
  for (const r of runs) {
    const u = parseLog(r.file, agentKind(r.agent, agents));
    sum.fresh += u.fresh; sum.cached += u.cached; sum.output += u.output; sum.costUsd += u.costUsd;
    sum.final &&= u.final;
    sum.agentMs += Math.max(0, u.endMs - r.startedAt);
    sum.startMs = Math.min(sum.startMs, r.startedAt);
    sum.endMs = Math.max(sum.endMs, u.endMs);
    sum.byAgent[r.agent] = (sum.byAgent[r.agent] || 0) + u.fresh + u.cached + u.output;
  }
  sum.total = sum.fresh + sum.cached + sum.output;
  return sum;
}

// Project totals across all retained logs, including archived tickets and imports.
// A run contributes only to the family that actually performed it.
export function agentUsage(logDir, agents = {}) {
  const totals = {};
  for (const run of listLogs(logDir, agents)) {
    const kind = agentKind(run.agent, agents);
    const u = parseLog(run.file, kind);
    const sum = totals[kind] ||= { input: 0, output: 0, cached: 0, fresh: 0, total: 0, final: true, runs: 0 };
    sum.fresh += u.fresh;
    sum.cached += u.cached;
    sum.output += u.output;
    sum.input += u.fresh + u.cached;
    sum.total += u.fresh + u.cached + u.output;
    sum.final &&= u.final;
    sum.runs++;
  }
  return totals;
}

// Kapazität je Agent: 5-Stunden- und Wochenfenster in Prozent mit Reset-Zeit.
export function capacity(logDir, codexSessionsDir, agents = {}) {
  const out = {};

  // Claude: jüngstes rate_limit_event aus den Claude-Logs
  for (const r of listLogs(logDir, agents).filter((l) => agentKind(l.agent, agents) === 'claude').reverse()) {
    const u = parseLog(r.file, 'claude');
    if (u.rate) {
      out.claude = {
        at: u.rateAt,
        windows: [
          win('5 Stunden', u.rate.five_hour?.utilization, u.rate.five_hour?.resetsAt),
          win('Woche', u.rate.seven_day?.utilization, u.rate.seven_day?.resetsAt),
        ].filter(Boolean),
      };
      break;
    }
  }

  // Codex: jüngster token_count mit rate_limits aus den Session-Dateien
  if (codexSessionsDir) {
    const dirs = Array.isArray(codexSessionsDir) ? codexSessionsDir : [codexSessionsDir];
    const files = [...new Set(dirs.flatMap((dir) => listRollouts(dir)))];
    files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    for (const file of files.slice(0, 5)) {
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('"rate_limits"')) continue;
        let ev;
        try { ev = JSON.parse(lines[i]); } catch { continue; }
        const rl = ev.payload?.rate_limits;
        if (!rl) continue;
        const label = (w) => (w.window_minutes <= 300 ? '5 Stunden' : w.window_minutes >= 10080 ? 'Woche' : `${Math.round(w.window_minutes / 60)} Stunden`);
        out.codex = {
          at: Date.parse(ev.timestamp) || fs.statSync(file).mtimeMs,
          windows: [rl.primary, rl.secondary].filter(Boolean).map((w) => win(label(w), w.used_percent / 100, w.resets_at)),
        };
        break;
      }
      if (out.codex) break;
    }
  }
  return out;
}

// Liegt der Reset-Zeitpunkt in der Vergangenheit, ist der zuletzt gemeldete
// Wert überholt: Das Fenster ist zurückgesetzt, der echte Stand kommt erst mit
// dem nächsten Lauf. Dann 0 % und "reset" statt des alten Werts anzeigen.
function win(label, fraction, resetsAtSec) {
  if (typeof fraction !== 'number') return null;
  const resetsAt = resetsAtSec ? resetsAtSec * 1000 : null;
  // Fenster zurückgesetzt: 0 % anzeigen; der echte Wert kommt mit dem nächsten Lauf.
  if (resetsAt && resetsAt <= Date.now()) return { label, percent: 0, resetsAt: null, reset: true, resetAt: resetsAt };
  return { label, percent: Math.round(fraction * 100), resetsAt };
}

export function formatTokens(n) {
  if (n >= 1e6) return `${(n / 1e6).toLocaleString('de-DE', { maximumFractionDigits: 1 })} Mio.`;
  if (n >= 1e3) return `${Math.round(n / 1e3).toLocaleString('de-DE')} Tsd.`;
  return String(n);
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '–';
  const min = Math.round(ms / 60000);
  if (min < 1) return '< 1 min';
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
}
