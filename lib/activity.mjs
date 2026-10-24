import fs from 'node:fs';
import path from 'node:path';

// Übersetzt die JSON-Ereignisse aus den Agent-Logs in lesbare Zeilen – das,
// was man im Chat sehen würde: Text des Agenten, Tool-Aufrufe, Fehler, Pushes.
// Rückgabe: Array von { kind, text } (kind: say | tool | error | info).

const short = (s, n = 160) => {
  const one = String(s ?? '').replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

function describeClaudeTool(name, input = {}) {
  const tool = name.replace(/^mcp__([^_]+(?:-[^_]+)*)__/, '$1:');
  if (name === 'Bash') return `${tool}: ${short(input.description || input.command)}`;
  if (['Read', 'Write', 'Edit', 'NotebookEdit'].includes(name)) return `${tool}: ${input.file_path || input.notebook_path || ''}`;
  if (name === 'Grep' || name === 'Glob') return `${tool}: ${short(input.pattern)}${input.path ? ` in ${input.path}` : ''}`;
  if (name === 'ToolSearch') return null; // internes Nachladen von Tools, uninteressant
  if (name === 'TodoWrite') return `Plan: ${(input.todos || []).map((t) => `${t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▶' : '·'} ${t.content}`).join(' | ')}`;
  const args = Object.entries(input)
    .filter(([k]) => !['cloudId'].includes(k))
    .map(([k, v]) => `${k}=${short(typeof v === 'string' ? v : JSON.stringify(v), 60)}`)
    .join(', ');
  return `${tool}${args ? ` (${args})` : ''}`;
}

export function formatClaudeEvent(ev) {
  const out = [];
  if (ev.type === 'assistant') {
    for (const b of ev.message?.content || []) {
      if (b.type === 'text' && b.text.trim()) out.push({ kind: 'say', text: short(b.text, 400) });
      if (b.type === 'tool_use') {
        const t = describeClaudeTool(b.name, b.input);
        if (t) out.push({ kind: 'tool', text: t });
      }
    }
  } else if (ev.type === 'user') {
    for (const b of ev.message?.content || []) {
      if (b.type === 'tool_result' && b.is_error) {
        const c = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
        out.push({ kind: 'error', text: `Tool-Fehler: ${short(c, 240)}` });
      }
    }
  } else if (ev.type === 'system' && ev.subtype === 'vcs_state_changed') {
    out.push({ kind: 'info', text: `git ${ev.kind || 'Änderung'}` });
  } else if (ev.type === 'rate_limit_event' && ev.rate_limit_info && !String(ev.rate_limit_info.status).startsWith('allowed')) {
    out.push({ kind: 'error', text: `Kontingent: ${ev.rate_limit_info.rateLimitType} ${ev.rate_limit_info.status}` });
  } else if (ev.type === 'result') {
    out.push({ kind: ev.is_error ? 'error' : 'info', text: ev.is_error ? `Lauf beendet mit Fehler: ${short(ev.result, 240)}` : 'Lauf beendet' });
  }
  return out;
}

export function formatCodexEvent(ev) {
  const out = [];
  const item = ev.item || {};
  if (ev.type === 'item.started' && item.type === 'command_execution') {
    out.push({ kind: 'tool', text: `$ ${short(item.command)}` });
  } else if (ev.type === 'item.completed') {
    if (item.type === 'agent_message') out.push({ kind: 'say', text: short(item.text, 400) });
    if (item.type === 'command_execution' && item.exit_code) out.push({ kind: 'error', text: `Exit ${item.exit_code}: ${short(item.aggregated_output, 240)}` });
    if (item.type === 'file_change') out.push({ kind: 'tool', text: `Dateien: ${(item.changes || []).map((c) => `${c.kind || ''} ${c.path}`.trim()).join(', ')}` });
    if (item.type === 'mcp_tool_call') out.push({ kind: item.status === 'failed' ? 'error' : 'tool', text: `${item.server}:${item.tool}${item.status === 'failed' ? ' fehlgeschlagen' : ''}` });
    if (item.type === 'todo_list') out.push({ kind: 'tool', text: `Plan: ${(item.items || []).map((t) => `${t.completed ? '✓' : '·'} ${t.text}`).join(' | ')}` });
    if (item.type === 'error' && !/unrecognized configuration/.test(item.message || '')) out.push({ kind: 'error', text: short(item.message, 240) });
  } else if (ev.type === 'turn.failed') {
    out.push({ kind: 'error', text: `Lauf fehlgeschlagen: ${short(ev.error?.message, 240)}` });
  } else if (ev.type === 'turn.completed') {
    out.push({ kind: 'info', text: 'Lauf beendet' });
  }
  return out;
}

// Strip the configured absolute root and the following agent directory.
export function worktreePrefix(root) {
  if (!root) return null;
  const escaped = root.replace(/[\\/]+$/, '').split(/[\\/]/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\\\/]');
  return new RegExp(`${escaped}[\\\\/][^\\\\/\\s"'\x60]+[\\\\/]?`, /^[A-Za-z]:/.test(root) ? 'gi' : 'g');
}

export function formatLine(line, kind, worktreeRoot) {
  let ev;
  try { ev = JSON.parse(line); } catch { return []; }
  const items = kind === 'codex' ? formatCodexEvent(ev) : formatClaudeEvent(ev);
  const prefix = worktreePrefix(worktreeRoot);
  return prefix ? items.map((i) => ({ ...i, text: i.text.replace(prefix, '') })) : items;
}

// Log-Dateien heißen <TASK>-<agent>-<ms>.jsonl bzw. import-<agent>-<ms>.jsonl
export function agentKind(name, agents = {}) {
  return agents[name]?.kind || (/^claude\d*$/.test(name) ? 'claude' : 'codex');
}

export function parseLogName(file, agents = {}) {
  const names = Object.keys(agents).sort((a, b) => b.length - a.length)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const m = path.basename(file).match(new RegExp(`^(.*?)-(${[...names, 'claude\\d*', 'codex\\d*'].join('|')})-(\\d+)\\.jsonl$`));
  return m ? { task: m[1], agent: m[2], startedAt: Number(m[3]), file } : null;
}

export function listLogs(logDir, agents = {}) {
  if (!fs.existsSync(logDir)) return [];
  return fs.readdirSync(logDir)
    .map((f) => parseLogName(path.join(logDir, f), agents))
    .filter(Boolean)
    .sort((a, b) => a.startedAt - b.startedAt);
}

// Letzte n Aktivitätszeilen einer Log-Datei (liest nur das Dateiende).
export function tailActivity(file, n = 30, maxBytes = 2_000_000, worktreeRoot, agents = {}) {
  const info = parseLogName(file, agents);
  const stat = fs.statSync(file);
  const start = Math.max(0, stat.size - maxBytes);
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(stat.size - start);
  fs.readSync(fd, buf, 0, buf.length, start);
  fs.closeSync(fd);
  const lines = buf.toString('utf8').split('\n');
  if (start > 0) lines.shift(); // angeschnittene erste Zeile
  const items = lines.flatMap((l) => formatLine(l.trim(), agentKind(info?.agent, agents), worktreeRoot));
  return { items: items.slice(-n), updatedAt: stat.mtimeMs, ...info };
}
