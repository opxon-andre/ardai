import fs from 'node:fs';

// Zusammenfassung einer Qualitätsprüfung (Coverage, Befunde, Gate) für die Statusseite.
// Erzeugt wird die Datei vom Projekt (z. B. durch dessen Prüfskript); ardai kennt kein bestimmtes Werkzeug.
//
// Schema 1:
//   { schema: 1, generated_at, revision, overall_gate: "passed"|"failed", report_url,
//     components: [{ name, coverage: { lines_percent, branches_percent, baseline_lines_percent },
//                    findings: { total, new, error, warning, info }, gate: "passed"|"failed", detail_url }] }
// Nur Zahlen und Links; Links sind auf http(s) und file begrenzt.

const GATES = new Set(['passed', 'failed']);
const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const text = (value, max = 200) => (typeof value === 'string' ? value.slice(0, max) : '');
export const safeUrl = (value) => (typeof value === 'string' && /^(https?|file):\/\//i.test(value.trim()) ? value.trim().slice(0, 500) : '');

export function normalizeQualitySummary(raw) {
  if (!raw || typeof raw !== 'object' || raw.schema !== 1 || !Array.isArray(raw.components)) return null;
  const components = raw.components.slice(0, 50).map((c) => ({
    name: text(c?.name, 80),
    coverage: {
      lines: number(c?.coverage?.lines_percent),
      branches: number(c?.coverage?.branches_percent),
      baseline: number(c?.coverage?.baseline_lines_percent),
    },
    findings: {
      total: number(c?.findings?.total),
      new: number(c?.findings?.new),
      error: number(c?.findings?.error),
      warning: number(c?.findings?.warning),
      info: number(c?.findings?.info),
    },
    gate: GATES.has(c?.gate) ? c.gate : null,
    url: safeUrl(c?.detail_url),
  })).filter((c) => c.name);
  if (!components.length) return null;
  return {
    generatedAt: text(raw.generated_at, 40),
    revision: text(raw.revision, 40),
    gate: GATES.has(raw.overall_gate) ? raw.overall_gate : null,
    url: safeUrl(raw.report_url),
    components,
  };
}

// null: nicht konfiguriert; { empty } wenn die Datei noch fehlt (noch keine Prüfung gelaufen); { error } bei unlesbarer Datei;
// sonst die normalisierte Zusammenfassung.
export function readQualitySummary(file) {
  if (!file) return null;
  if (!fs.existsSync(file)) return { empty: true };
  try {
    const summary = normalizeQualitySummary(JSON.parse(fs.readFileSync(file, 'utf8')));
    return summary || { error: 'unlesbar oder falsches Schema' };
  } catch {
    return { error: 'unlesbar oder falsches Schema' };
  }
}
