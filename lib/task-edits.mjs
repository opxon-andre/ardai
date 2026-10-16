// Validate the entire patch before changing the task. Used by CLI and runner.
export function parseEdits(args, { answer = false } = {}) {
  const edits = { domain: [], depends: [] };
  const text = [];
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    if (option === '--start') { edits.start = true; continue; }
    if (!option.startsWith('--') && answer) { text.push(option); continue; }
    const name = option.slice(2);
    const allowed = answer ? ['domain'] : ['epic', 'domain', 'note', 'agent', 'depends', 'size'];
    if (!allowed.includes(name)) throw new Error(`Unknown option / Unbekannte Option: ${option}`);
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value / Wert fehlt: ${option}`);
    if (['domain', 'depends'].includes(name)) {
      if (!/^[+-].+/.test(value) || (answer && value[0] !== '+')) throw new Error(`${option}: use / verwende ${answer ? '+value' : '+value/-value'}`);
      edits[name].push(value);
    } else edits[name] = value;
  }
  if (edits.agent && !['claude', 'codex'].includes(edits.agent)) throw new Error('agent: claude|codex');
  if (edits.size && !['S', 'M', 'L'].includes(edits.size)) throw new Error('size: S|M|L');
  return { edits, text };
}

function changeList(current = [], edits) {
  const result = new Set(current);
  for (const edit of edits) {
    if (edit[0] === '+') result.add(edit.slice(1));
    else result.delete(edit.slice(1));
  }
  return [...result];
}

export function patchTask(task, args, tasks, agents) {
  const { edits } = parseEdits(args);
  const changes = {};
  if (edits.epic !== undefined) changes.epic = edits.epic;
  if (edits.agent !== undefined) {
    if (!agents[edits.agent]) throw new Error(`Unknown agent / Unbekannter Agent: ${edits.agent}`);
    changes.preferredAgent = edits.agent;
  }
  if (edits.size !== undefined) changes.size = edits.size;
  if (edits.domain.length) {
    changes.domain = changeList(task.domain, edits.domain);
    if (!changes.domain.length) throw new Error('domain must not be empty / Domain darf nicht leer sein');
  }
  if (edits.depends.length) {
    changes.dependsOn = changeList(task.dependsOn, edits.depends);
    const visited = new Set();
    const reachesTask = (id) => {
      if (id === task.id) return true;
      if (visited.has(id)) return false;
      visited.add(id);
      return (tasks.find((x) => x.id === id)?.dependsOn || []).some(reachesTask);
    };
    for (const id of changes.dependsOn) {
      if (!tasks.some((x) => x.id === id)) throw new Error(`Unknown dependency / Unbekannte Abhängigkeit: ${id}`);
      if (reachesTask(id)) throw new Error('Dependency cycle / Zyklische Abhängigkeit');
    }
  }
  if (!Object.keys(changes).length && edits.note === undefined) throw new Error('Empty patch / Leerer Patch');
  if (task.status === 'running' && Object.keys(changes).length) throw new Error(`${task.id}: running; only --note allowed / läuft; nur --note erlaubt`);
  Object.assign(task, changes);
  return edits.note;
}

// Follow parent metadata first, then legacy suffixes for states predating it.
export function followUpIdentity(task, tasks) {
  let root = task;
  const seen = new Set();
  while (root.parentTicket && !seen.has(root.id)) {
    seen.add(root.id);
    const parent = tasks.find((x) => x.id === root.parentTicket);
    if (!parent) break;
    root = parent;
  }
  const rootId = root.id.replace(/(?:-NACHTRAG-\d+|-N\d+)+$/, '');
  root = tasks.find((x) => x.id === rootId) || root;
  let number = root.followUpSequence || 0;
  for (const item of tasks) {
    if (!item.id.startsWith(`${rootId}-`)) continue;
    const suffix = item.id.slice(rootId.length);
    if (/^(?:-NACHTRAG-\d+|-N\d+)+$/.test(suffix)) {
      number = Math.max(number, ...[...suffix.matchAll(/(?:-NACHTRAG-|-N)(\d+)/g)].map((m) => Number(m[1])));
    }
  }
  return { root, rootId, number: number + 1, id: `${rootId}-N${number + 1}` };
}

export function extendDomain(domain, edits) {
  return changeList(domain, edits);
}
