// Plans bundled phase-test tasks (Playwright + container tests) per epic.
//
// A phase test is planned when every implementation task of an epic is done and
// at least one of them is not yet covered by an earlier phase test of that epic.
// Tasks added to an epic later therefore get their own follow-up phase test
// (<EPIC>-PHASENTEST-2, -3, ...) instead of never being tested end to end.
// "Covered" = listed in the dependsOn of an existing phase test of the epic.

// A phase test in one of these states is still to be run or waiting for the
// human; no further one is planned for the epic until it finishes.
const PENDING = new Set(['ready', 'running', 'interrupted', 'needs-human', 'blocked']);

export function planPhaseTests(tasks, { skipEpics = [], doneStatus = 'done' } = {}) {
  const skip = new Set(skipEpics);
  const planned = [];
  const epics = new Set(tasks.filter((t) => t.type !== 'phase-test' && t.epic).map((t) => t.epic));

  for (const epic of epics) {
    if (skip.has(epic)) continue;
    const impl = tasks.filter((t) => t.epic === epic && t.type !== 'phase-test');
    const tests = tasks.filter((t) => t.type === 'phase-test' && t.epic === epic);
    if (tests.some((t) => PENDING.has(t.status))) continue;
    if (!impl.every((t) => t.status === doneStatus)) continue;

    const covered = new Set(tests.flatMap((t) => t.dependsOn || []));
    const fresh = impl.filter((t) => !covered.has(t.id));
    if (!fresh.length) continue;

    let n = tests.length + 1;
    let id;
    do {
      id = n === 1 ? `${epic}-PHASENTEST` : `${epic}-PHASENTEST-${n}`;
      n += 1;
    } while (tasks.some((t) => t.id === id) || planned.some((p) => p.id === id));

    planned.push({
      id,
      type: 'phase-test',
      jira: false,
      epic,
      title: `Phasentest ${epic}${tests.length ? ` (Nachlauf ${tests.length + 1})` : ''} (Playwright + Container)`,
      size: 'S',
      branch: `task/${id}`,
      status: 'ready',
      resources: ['docker'],
      dependsOn: fresh.map((t) => t.id),
      domain: [...new Set(['testing/', ...fresh.flatMap((t) => t.domain || [])])],
      acceptanceCriteria: fresh.flatMap((t) => (t.acceptanceCriteria || []).map((c) => `${t.id}: ${c}`)),
      preferredAgent: null,
    });
  }
  return planned;
}
