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
// Soft domains (config scheduling.softDomains) are append-only shared areas (route registries, docs, tests):
// tasks that only overlap there may run in parallel; merge conflicts are resolved by the agents.
export function hardDomain(domain, softDomains = []) {
  const norm = (x) => String(x).replace(/\\/g, '/').replace(/\*+$/, '');
  const soft = softDomains.map(norm).filter(Boolean);
  return (domain || []).filter((d) => !soft.some((s) => norm(d).startsWith(s)));
}

export function selectTask(agent, tasks, agents, { inScope = () => true, isAvailable = () => true, busyAgents = new Set(), stealWhenBusy = true, softDomains = [], phaseTestsLockDomains = true } = {}) {
  const busy = tasks.filter((t) => t.status === 'running');
  const busyResources = new Set(busy.flatMap((t) => t.resources || []));
  // Phasentests laufen im eigenen Worktree mit eigenem Compose-Projekt: sie sperren (und werden von) keine Codebereiche
  // (config scheduling.phaseTestsLockDomains = false); die Ressource docker serialisiert sie weiterhin.
  const lockDomain = (task) => (task.type === 'phase-test' && !phaseTestsLockDomains ? [] : hardDomain(task.domain, softDomains));
  const prefs = agents[agent].preferredDomains || [];

  const candidates = tasks.filter((t) => {
    if (!inScope(t) || !RUNNABLE.has(t.status) || !depsDone(t, tasks)) return false;
    if (busy.some((b) => pathsOverlap(lockDomain(b), lockDomain(t)))) return false;
    if ((t.resources || []).some((r) => busyResources.has(r))) return false;
    const owner = t.preferredAgent || (t.status === 'interrupted' ? t.lastAgent : null);
    // A task is only held back for its preferred agent while that agent is idle: an agent that is
    // busy (or stuck) must not block free capacity elsewhere.
    if (owner && owner !== agent && agents[owner]?.enabled && isAvailable(owner) && !(stealWhenBusy && busyAgents.has(owner))) return false;
    return true;
  });

  const score = (t) =>
    (t.status === 'interrupted' ? 100 : 0) +
    (t.type === 'phase-test' ? 50 : 0) +
    (t.preferredAgent === agent ? 20 : 0) +
    (t.domain.some((d) => prefs.some((p) => d.startsWith(p))) ? 10 : 0);
  return candidates.sort((a, b) => score(b) - score(a))[0] || null;
}
