import { pathsOverlap } from './util.mjs';

export const RUNNABLE = new Set(['ready', 'interrupted']);

// Missing dependencies are historical/externally completed tasks, as in the runner.
export function depsDone(task, tasks) {
  return (task.dependsOn || []).every((id) => {
    const dependency = tasks.find((t) => t.id === id);
    return !dependency || dependency.status === 'done';
  });
}

// Selection has no agent/Jira side effects; availability and scope belong to the runner.
export function selectTask(agent, tasks, agents, { inScope = () => true, isAvailable = () => true } = {}) {
  const busy = tasks.filter((t) => t.status === 'running');
  const busyResources = new Set(busy.flatMap((t) => t.resources || []));
  const prefs = agents[agent].preferredDomains || [];

  const candidates = tasks.filter((t) => {
    if (!inScope(t) || !RUNNABLE.has(t.status) || !depsDone(t, tasks)) return false;
    if (busy.some((b) => pathsOverlap(b.domain, t.domain))) return false;
    if ((t.resources || []).some((r) => busyResources.has(r))) return false;
    const owner = t.preferredAgent || (t.status === 'interrupted' ? t.lastAgent : null);
    if (owner && owner !== agent && agents[owner]?.enabled && isAvailable(owner)) return false;
    return true;
  });

  const score = (t) =>
    (t.status === 'interrupted' ? 100 : 0) +
    (t.type === 'phase-test' ? 50 : 0) +
    (t.preferredAgent === agent ? 20 : 0) +
    (t.domain.some((d) => prefs.some((p) => d.startsWith(p))) ? 10 : 0);
  return candidates.sort((a, b) => score(b) - score(a))[0] || null;
}
