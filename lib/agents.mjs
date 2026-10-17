import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { expandEnv } from './util.mjs';

// Textmuster als Rückfall, falls kein strukturiertes Rate-Limit-Signal kommt.
// Echte Fehlertexte bei erschöpftem Kontingent lagen beim Bau (2026-10-14)
// nicht vor; Muster bei der ersten echten Sperre gegen das Log prüfen.
const LIMIT_TEXT = /usage limit|rate[ _-]?limit|limit reached|quota|too many requests|\b429\b|hit your limit|try again (in|at)/i;

export class AgentRun {
  constructor({ name, agentCfg, cwd, prompt, resumeSessionId, logFile, maxRunMinutes, codeGraph, onEvent, extraArgs = [] }) {
    Object.assign(this, { name, agentCfg, cwd, prompt, resumeSessionId, logFile, maxRunMinutes, codeGraph, onEvent, extraArgs });
    this.kind = agentCfg.kind;
    this.sessionId = resumeSessionId || null;
    this.rateLimit = null; // { exhausted, resetsAt (ms), detail }
    this.errorText = '';
    this.completed = false;
    this.timedOut = false;
  }

  // code-review-graph-MCP pro Lauf auf den Graphen DIESES Worktrees zeigen
  // lassen (die DB enthält absolute Pfade, jeder Worktree hat seine eigene).
  graphArgs() {
    if (!this.codeGraph?.python) return [];
    const py = expandEnv(this.codeGraph.python).replace(/\\/g, '/');
    const repo = this.cwd.replace(/\\/g, '/');
    const serveArgs = ['-m', 'code_review_graph', 'serve', '--auto-watch', '--repo', repo];
    if (this.kind === 'claude') {
      const mcp = { mcpServers: { 'code-review-graph': { type: 'stdio', command: py, args: serveArgs, cwd: repo } } };
      return ['--mcp-config', JSON.stringify(mcp)];
    }
    const q = (v) => JSON.stringify(v);
    return [
      '-c', `mcp_servers.code-review-graph.command=${q(py)}`,
      '-c', `mcp_servers.code-review-graph.args=[${serveArgs.map(q).join(',')}]`,
      '-c', `mcp_servers.code-review-graph.cwd=${q(repo)}`,
    ];
  }

  buildArgs() {
    const cfg = this.agentCfg;
    const prefix = (cfg.commandPrefix || []).map(expandEnv);
    if (this.kind === 'claude') {
      const args = [...cfg.args, ...this.extraArgs, ...this.graphArgs()];
      if (this.resumeSessionId) args.push('--resume', this.resumeSessionId);
      return [...prefix, ...args];
    }
    // codex: Prompt kommt über stdin ("-")
    const [sub, ...base] = cfg.args;
    const rest = [...base, ...this.extraArgs, ...this.graphArgs()];
    if (this.resumeSessionId) return [...prefix, sub, 'resume', ...rest, this.resumeSessionId, '-'];
    return [...prefix, sub, ...rest, '-C', this.cwd, '-'];
  }

  start() {
    fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
    const logStream = fs.createWriteStream(this.logFile, { flags: 'a' });
    const child = spawn(resolveCommand(this.agentCfg), this.buildArgs(), {
      cwd: this.cwd,
      windowsHide: true,
      env: { ...process.env, ORCHESTRATOR_AGENT: this.name },
    });
    this.pid = child.pid;
    child.stdin.end(this.prompt);

    let buf = '';
    child.stdout.on('data', (chunk) => {
      logStream.write(chunk);
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) this.onLine(line);
      }
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      logStream.write(chunk);
      stderr = (stderr + chunk.toString('utf8')).slice(-4000);
    });

    const timer = setTimeout(() => {
      this.timedOut = true;
      child.kill();
    }, this.maxRunMinutes * 60_000);

    return new Promise((resolve) => {
      child.on('close', (code) => {
        clearTimeout(timer);
        clearTimeout(this.killTimer);
        if (buf.trim()) this.onLine(buf.trim());
        logStream.end();
        this.exitCode = code;
        if (!this.errorText && code !== 0) this.errorText = stderr;
        if (this.kind === 'codex') this.readCodexQuota();
        resolve(this.outcome());
      });
      child.on('error', (err) => {
        this.errorText = String(err);
      });
    });
  }

  onLine(line) {
    try { this.onEvent?.(line); } catch { /* Anzeige darf den Lauf nie stören */ }
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    if (this.kind === 'claude') this.onClaudeEvent(ev);
    else this.onCodexEvent(ev);
  }

  onClaudeEvent(ev) {
    if (ev.session_id) this.sessionId = ev.session_id;
    if (ev.type === 'rate_limit_event' && ev.rate_limit_info) {
      const info = ev.rate_limit_info;
      // "rejected" + isUsingOverage: Abo-Fenster voll, Claude Code rechnet über das
      // kostenpflichtige Zusatzkontingent ab. Nur mit allowOverage weiterarbeiten.
      const overLimit = info.status && !String(info.status).startsWith('allowed');
      const onOverage = Boolean(info.isUsingOverage);
      this.rateLimit = {
        exhausted: overLimit,
        // kostenpflichtiges Zusatzkontingent verfügbar/aktiv (Claude: "extra usage")
        paidAvailable: onOverage || info.overageStatus === 'allowed',
        resetsAt: info.resetsAt ? info.resetsAt * 1000 : null,
        detail: `${info.rateLimitType || ''} ${info.status}${onOverage ? ' (Zusatzkontingent aktiv)' : ''}`.trim(),
        windows: info.unifiedWindows || null,
      };
    }
    if (ev.type === 'result') {
      this.completed = ev.subtype === 'success' && !ev.is_error;
      if (!this.completed) this.errorText = typeof ev.result === 'string' ? ev.result : JSON.stringify(ev).slice(0, 2000);
    }
  }

  onCodexEvent(ev) {
    if (ev.type === 'thread.started' && ev.thread_id) this.sessionId = ev.thread_id;
    if (ev.type === 'turn.completed') this.completed = true;
    if (ev.type === 'turn.failed') {
      this.completed = false;
      this.errorText = ev.error?.message || JSON.stringify(ev);
      this.killLater();
    }
    if (ev.type === 'error' && ev.message) {
      this.errorText = ev.message;
      if (LIMIT_TEXT.test(ev.message)) this.killLater();
    }
  }

  // codex exec can stay alive after a fatal error (for example "usage limit"), which would keep the
  // task "running" forever. After a short grace period the process tree is ended so that the run
  // resolves and the outage handling can take over.
  killLater(delayMs = 20_000) {
    if (this.killTimer || !this.pid) return;
    this.killTimer = setTimeout(() => {
      spawnSync('taskkill', ['/PID', String(this.pid), '/T', '/F'], { windowsHide: true });
    }, delayMs);
    this.killTimer.unref?.();
  }

  // Codex gibt den Kontingentstand nicht im JSON-Stream aus, sondern nur in der
  // Session-Datei (rollout-*-<thread_id>.jsonl) als token_count-Ereignis.
  readCodexQuota() {
    if (!this.sessionId) return;
    const quota = readCodexRateLimits(expandEnv(this.agentCfg.sessionsDir), this.sessionId);
    if (quota) this.rateLimit = quota;
  }

  outcome() {
    const limitByText = LIMIT_TEXT.test(this.errorText || '');
    // Inkludiertes Kontingent erschöpft zählt nur dann nicht als Outage, wenn der
    // Nutzer kostenpflichtige Kontingente freigegeben hat UND solche verfügbar sind.
    const paidOk = Boolean(this.agentCfg.allowOverage && this.rateLimit?.paidAvailable);
    const outage = (Boolean(this.rateLimit?.exhausted) && !paidOk) || (!this.completed && limitByText);
    return {
      completed: this.completed && !outage,
      outage,
      timedOut: this.timedOut,
      resetsAt: this.rateLimit?.resetsAt || null,
      rateLimit: this.rateLimit,
      sessionId: this.sessionId,
      error: (this.errorText || '').slice(0, 2000),
      exitCode: this.exitCode,
    };
  }
}

// "...\bin\*\codex.exe": neueste Installation wählen (die Desktop-App legt
// jede Version in einen Ordner mit wechselndem Hash). Direkter Start statt über
// cmd.exe, damit Argumente mit Anführungszeichen unverändert ankommen.
export function resolveCommand(cfg) {
  const cmd = expandEnv(cfg.command);
  const star = cmd.indexOf('*');
  if (star < 0) return cmd;
  const dir = cmd.slice(0, star);
  const suffix = cmd.slice(star + 1);
  let best = null;
  for (const e of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
    const file = path.join(dir, e.name + suffix);
    if (e.isDirectory() && fs.existsSync(file)) {
      const m = fs.statSync(file).mtimeMs;
      if (!best || m > best.m) best = { file, m };
    }
  }
  return best?.file || expandEnv(cfg.fallbackCommand || cmd);
}

export function readCodexRateLimits(sessionsDir, threadId, thresholdPercent = 100) {
  const file = findRollout(sessionsDir, threadId);
  if (!file) return null;
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"rate_limits"')) continue;
    let rl;
    try { rl = JSON.parse(lines[i]).payload?.rate_limits; } catch { continue; }
    if (!rl) continue;
    return codexQuotaFromLimits(rl, thresholdPercent);
  }
  return null;
}

export function codexQuotaFromLimits(rl, thresholdPercent = 100) {
  const windows = ['primary', 'secondary'].map((k) => rl[k]).filter(Boolean);
  const full = windows.filter((w) => w.used_percent >= thresholdPercent);
  const exhausted = Boolean(rl.rate_limit_reached_type) || full.length > 0;
  const resetsAt = exhausted
    ? Math.max(...(full.length ? full : windows).map((w) => (w.resets_at || 0) * 1000))
    : null;
  return {
    exhausted,
    paidAvailable: Boolean(rl.credits?.has_credits || rl.credits?.unlimited), // Codex-Credits
    resetsAt: resetsAt || null,
    detail: windows.map((w) => `${w.window_minutes}min:${w.used_percent}%`).join(' '),
  };
}

// Neueste Session-Datei finden (für die Vorab-Prüfung des Kontingents).
export function latestCodexRateLimits(sessionsDir, thresholdPercent) {
  const files = listRollouts(sessionsDir).slice(-3).reverse();
  for (const f of files) {
    const id = f.match(/([0-9a-f-]{36})\.jsonl$/)?.[1];
    const q = id && readCodexRateLimits(sessionsDir, id, thresholdPercent);
    if (q) return q;
  }
  return null;
}

export function listRollouts(dir) {
  const out = [];
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(dir);
  return out.sort(); // Dateinamen enthalten den Zeitstempel
}

function findRollout(dir, threadId) {
  return listRollouts(dir).reverse().find((f) => f.endsWith(`${threadId}.jsonl`)) || null;
}
