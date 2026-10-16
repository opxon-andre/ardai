// Collection of agent hints (non-blocking questions): assumptions an agent made
// while it kept working. Kept for the whole project, also after the task was
// archived, so they can be reviewed at the end of the implementation phase.

import { DEFAULT_BRAND, isOrchestratorAgent } from './brand.mjs';

const isHint = (q, brand) => !q.blocking && !isOrchestratorAgent(q.agent, brand);
export const hintState = (q) => (q.answer ? 'answered' : q.acknowledgedAt ? 'acknowledged' : 'open');

export function collectHints(state, brand = DEFAULT_BRAND) {
  const tasks = new Map((state.tasks || []).map((t) => [t.id, t]));
  return (state.questions || []).filter((q) => isHint(q, brand)).map((q) => ({
    ...q,
    state: hintState(q),
    task: tasks.get(q.taskId) || null,
  }));
}

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

function line(h) {
  const parts = [`- **${h.id}** — ${clean(h.question)}`];
  if (h.assumption) parts.push(`  - Annahme des Agenten: ${clean(h.assumption)}`);
  if (h.context) parts.push(`  - Kontext: ${clean(h.context)}`);
  if (h.state === 'answered') parts.push(`  - Antwort: ${clean(h.answer)}`);
  if (h.state === 'acknowledged') parts.push(`  - Bestätigt am ${h.acknowledgedAt.slice(0, 10)}`);
  return parts.join('\n');
}

export function hintsMarkdown(state, brand = DEFAULT_BRAND) {
  const hints = collectHints(state, brand);
  const open = hints.filter((h) => h.state === 'open');
  const byTask = (list) => {
    const groups = new Map();
    for (const h of list) {
      if (!groups.has(h.taskId)) groups.set(h.taskId, []);
      groups.get(h.taskId).push(h);
    }
    return groups;
  };
  const section = (title, list) => {
    if (!list.length) return '';
    const body = [...byTask(list)].map(([taskId, items]) => {
      const t = items[0].task;
      const info = t ? ` (${t.status}${t.archivedAt ? ', archiviert' : ''})` : '';
      return `### ${taskId}${info}\n\n${items.map(line).join('\n')}`;
    }).join('\n\n');
    return `## ${title} (${list.length})\n\n${body}\n`;
  };
  return [
    '# Hinweise der Agenten',
    '',
    `Gesammelt von ${brand.name}, Stand ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC. Hinweise sind Annahmen, mit denen ein Agent weitergearbeitet hat. Sie bleiben auch nach dem Archivieren einer Aufgabe erhalten.`,
    '',
    section('Offen', open),
    section('Beantwortet', hints.filter((h) => h.state === 'answered')),
    section('Bestätigt', hints.filter((h) => h.state === 'acknowledged')),
  ].filter((x) => x !== '').join('\n') + '\n';
}
