// Harte Grenzen gegen Endlosschleifen: Wiederholungen ohne Änderung erkennen und ein Token-Budget je Aufgabe.
// Reine Funktionen ohne Zugriff auf State, Git oder Prozesse, damit sie einzeln testbar bleiben.

export const BUDGET_DEFAULTS = Object.freeze({
  enabled: true,
  window: 8, // Anzahl der zuletzt fertigen Aufgaben gleicher Größe für den gleitenden Durchschnitt
  minSamples: 3, // darunter gibt es keine Schätzung und damit keine Grenze (Kalibrierung)
  hardFactor: 1.5, // harte Grenze: 150 % der Schätzung
  graceFactor: 1.6, // äußerste Grenze nach positiver Prüfung: 160 % der Schätzung
  reviewerModel: 'sonnet',
});

const finishedAtMs = (task) => {
  const at = task.doneAt || [...(task.history || [])].reverse().find((h) => h?.at)?.at;
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? ms : 0;
};

// Schätzung = Mittel der Tokens der letzten `window` fertigen Aufgaben derselben Größe.
// usageOf(task) liefert den Gesamtverbrauch oder null/undefined, wenn er unbekannt ist.
export function estimateTokens(tasks, usageOf, size, options = {}) {
  const { window, minSamples } = { ...BUDGET_DEFAULTS, ...options };
  const samples = tasks
    .filter((t) => t.status === 'done' && (t.size || null) === (size || null))
    .map((t) => ({ at: finishedAtMs(t), tokens: Number(usageOf(t)) }))
    .filter((s) => Number.isFinite(s.tokens) && s.tokens > 0)
    .sort((a, b) => a.at - b.at)
    .slice(-window);
  if (samples.length < minSamples) return { estimate: null, samples: samples.length };
  const mean = samples.reduce((sum, s) => sum + s.tokens, 0) / samples.length;
  return { estimate: Math.round(mean), samples: samples.length };
}

export function budgetFor(estimate, samples, options = {}) {
  const { hardFactor, graceFactor } = { ...BUDGET_DEFAULTS, ...options };
  if (!estimate) return { estimate: null, samples, setAt: new Date().toISOString() };
  return {
    estimate,
    samples,
    hardLimit: Math.round(estimate * hardFactor),
    graceLimit: Math.round(estimate * graceFactor),
    extended: false,
    setAt: new Date().toISOString(),
  };
}

// ok: unter der harten Grenze. review: harte Grenze erreicht, Stand muss geprüft werden.
// exceeded: nach positiver Prüfung auch die äußerste Grenze erreicht, kein weiterer Aufschub.
export function budgetState(budget, used) {
  if (!budget?.estimate || !(used > 0)) return 'ok';
  if (budget.extended) return used >= budget.graceLimit ? 'exceeded' : 'ok';
  return used >= budget.hardLimit ? 'review' : 'ok';
}

// Nach einer Entscheidung des Menschen: halbe Schätzung zusätzlich zum bisherigen Verbrauch, dann wieder Prüfung.
export function rebaseBudget(budget, used, options = {}) {
  const { hardFactor, graceFactor } = { ...BUDGET_DEFAULTS, ...options };
  const extra = Math.round(budget.estimate * (hardFactor - 1));
  return {
    ...budget,
    hardLimit: Math.round(used + extra),
    graceLimit: Math.round(used + extra + budget.estimate * (graceFactor - hardFactor)),
    extended: false,
    reviewedAt: null,
    rebasedAt: new Date().toISOString(),
  };
}

// Fingerabdruck eines Fehlschlags: gleiche Meldung auf gleichem Inhalt des Task-Branches (Baum-Hash) heißt: es hat sich nichts geändert.
export function failureFingerprint(reason, tree) {
  const key = String(reason || '').toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 200);
  return `${key}|${tree || ''}`;
}

export function reviewPrompt({ task, used, budget, handoff, diffStat }) {
  return `Du bist der Wächter eines Orchestrators. Die Aufgabe ${task.id} ("${task.title}") hat ihr Token-Budget erreicht: verbraucht ${used}, Schätzung ${budget.estimate}, harte Grenze ${budget.hardLimit}.
Entscheide NUR anhand der folgenden Angaben, ob die Aufgabe mit höchstens ${Math.max(0, budget.graceLimit - used)} weiteren Tokens (etwa 10 % der Schätzung) sicher abgeschlossen wird.
Antworte mit "finishable": true nur bei EINDEUTIGEM Signal: alle Teilziele sind erledigt und gepusht, die letzten Einträge zeigen grüne Tests, und es fehlen nur Schlussprüfung, Zusammenfassung oder result.json. Bei offenen Teilzielen, wiederholten Fehlschlägen, roten Tests ohne erkennbare Ursache oder unklarem Stand: false.
Antworte ausschließlich mit einer JSON-Zeile: {"finishable": true|false, "reason": "ein Satz"}.

## Handoff
${handoff || '(keine Handoff-Datei)'}

## Änderungen gegenüber dem Integrationszweig
${diffStat || '(keine)'}
`;
}

export function parseVerdict(text) {
  const match = /\{[^{}]*"finishable"[^{}]*\}/s.exec(String(text || ''));
  if (!match) return { finishable: false, reason: 'Keine auswertbare Antwort der Prüfung.' };
  try {
    const v = JSON.parse(match[0]);
    return { finishable: v.finishable === true, reason: String(v.reason || '').slice(0, 300) };
  } catch {
    return { finishable: false, reason: 'Keine auswertbare Antwort der Prüfung.' };
  }
}

export const fmtTokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} Mio.` : `${Math.round(n / 1e3)} Tsd.`);
