// Token-sparende Helfer für Agenten: ein Aufruf = Handoff-Zeile + Commit + Push.
// Läuft ohne Projektkonfiguration und ohne State, nur im Worktree der Aufgabe (Branch task/<ID>).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const KINDS = new Set(['START', 'DONE', 'NOTE']);
const KEEP_RECENT = 40;
const COMPACT_ABOVE = 80;

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

function context(cwd = process.cwd()) {
  const top = git(cwd, 'rev-parse', '--show-toplevel');
  if (!top.ok) throw new Error('Kein Git-Repository.');
  const branch = git(top.out, 'rev-parse', '--abbrev-ref', 'HEAD').out;
  const match = /^task\/(.+)$/.exec(branch);
  if (!match) throw new Error(`Branch "${branch}" ist kein Task-Branch (task/<ID>).`);
  const id = match[1];
  return { root: top.out, branch, id, file: path.join(top.out, '.handoff', `${id}.md`) };
}

function readLines(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : [];
}

const isEntry = (line) => /^- \d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z \[/.test(line);

// Older entries are folded into one line once the file grows; git history keeps the full text.
export function compact(lines, { keep = KEEP_RECENT, above = COMPACT_ABOVE } = {}) {
  const entryIdx = lines.map((l, i) => (isEntry(l) ? i : -1)).filter((i) => i >= 0);
  if (entryIdx.length <= above) return lines;
  const drop = new Set(entryIdx.slice(0, entryIdx.length - keep));
  const first = entryIdx[0];
  const out = [];
  lines.forEach((line, i) => {
    if (i === first) out.push(`- (verdichtet) ${drop.size} frühere Einträge entfallen; Verlauf: git log -p -- .handoff/`);
    if (!drop.has(i)) out.push(line);
  });
  return out;
}

export function summarize(lines, count = 25) {
  const text = lines.join('\n');
  const planStart = lines.findIndex((l) => /^##\s+Plan/i.test(l));
  let plan = [];
  if (planStart >= 0) {
    const end = lines.findIndex((l, i) => i > planStart && /^##\s/.test(l));
    plan = lines.slice(planStart, end < 0 ? lines.length : end);
  }
  const entries = lines.filter(isEntry);
  const recent = entries.slice(-count);
  const open = [];
  for (const [i, e] of entries.entries()) {
    if (/\]\s+START\s/.test(e) && !entries.slice(i + 1).some((x) => /\]\s+DONE\s/.test(x))) open.push(e);
  }
  const parts = [];
  if (plan.length) parts.push(plan.join('\n').trimEnd());
  parts.push(`Letzte ${recent.length} von ${entries.length} Einträgen:\n${recent.join('\n') || '(keine)'}`);
  if (open.length) parts.push(`OFFEN (START ohne DONE – gegen den Code prüfen):\n${open.join('\n')}`);
  return text.trim() ? parts.join('\n\n') : '(Handoff-Datei leer oder nicht vorhanden)';
}

export function step(kind, message, { commit = kind === 'DONE', push = true, agent = process.env.ORCHESTRATOR_AGENT || 'agent', cwd } = {}) {
  const ctx = context(cwd);
  if (['main', 'master'].includes(ctx.branch)) throw new Error('Nicht auf main/master.');
  fs.mkdirSync(path.dirname(ctx.file), { recursive: true });
  let lines = readLines(ctx.file);
  if (!lines.length) lines = [`# ${ctx.id} Handoff`, '', '## Plan', '', '## Log', ''];
  const stamp = new Date().toISOString().slice(0, 16) + 'Z';
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  lines.push(`- ${stamp} [${agent}] ${kind.padEnd(5)} ${message}`, '');
  lines = compact(lines);
  fs.writeFileSync(ctx.file, lines.join('\n'), 'utf8');
  if (!commit) return { id: ctx.id, committed: false, pushed: false, line: `Eintrag ${kind} notiert (${ctx.id}).` };
  git(ctx.root, 'add', '-A');
  const staged = git(ctx.root, 'diff', '--cached', '--quiet');
  let sha = '';
  if (!staged.ok) {
    const commitResult = git(ctx.root, 'commit', '-q', '-m', `${ctx.id}: ${message}`);
    if (!commitResult.ok) throw new Error(`git commit fehlgeschlagen: ${commitResult.err.slice(0, 300)}`);
    sha = git(ctx.root, 'rev-parse', '--short', 'HEAD').out;
  }
  if (!push) return { id: ctx.id, committed: Boolean(sha), pushed: false, line: `${kind} ${ctx.id} ${sha || '(nichts zu committen)'}, nicht gepusht.` };
  const pushed = git(ctx.root, 'push', '-q', '-u', 'origin', ctx.branch);
  if (!pushed.ok) throw new Error(`git push fehlgeschlagen (Commit ${sha || 'vorhanden'} liegt lokal): ${pushed.err.slice(0, 300)}`);
  return { id: ctx.id, committed: Boolean(sha), pushed: true, line: `${kind} ${ctx.id} ${sha || '(nichts zu committen)'} gepusht.` };
}

export function show({ all = false, count = 25, cwd } = {}) {
  const ctx = context(cwd);
  const lines = readLines(ctx.file);
  return all ? lines.join('\n') : summarize(lines, count);
}

// CLI entry: returns the process exit code.
export function run(cmd, args = []) {
  try {
    if (cmd === 'handoff') {
      const count = Number(args[args.indexOf('--last') + 1]) || 25;
      console.log(show({ all: args.includes('--all'), count }));
      return 0;
    }
    const rest = [...args];
    const kind = (rest.shift() || '').toUpperCase();
    if (!KINDS.has(kind)) {
      console.error('Aufruf: step START|DONE|NOTE "Text" [--no-push] [--commit]');
      return 1;
    }
    const flags = rest.filter((a) => a.startsWith('--'));
    const message = rest.filter((a) => !a.startsWith('--')).join(' ').trim();
    if (!message) {
      console.error('Text fehlt.');
      return 1;
    }
    const result = step(kind, message, { commit: kind === 'DONE' || flags.includes('--commit'), push: !flags.includes('--no-push') });
    console.log(result.line);
    return 0;
  } catch (err) {
    console.error(err.message);
    return 2;
  }
}
