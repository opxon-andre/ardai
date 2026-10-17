import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_BRAND, stoppedLabels } from './brand.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const protocol = fs.readFileSync(path.join(here, '..', 'AGENT_PROTOCOL.md'), 'utf8');

const JIRA_DUTY = 'Beim Start Ticket auf „In Progress“, bei Erfüllung aller Akzeptanzkriterien auf „In Review“ plus kurzer Kommentar mit Ergebnis und Branch. Nicht erfüllbares Kriterium: Kommentar + Label `AC:Issue` (beachte gegebenenfalls die Jira-Richtlinien des Projekts).';

function list(items) {
  return items?.length ? items.map((x) => `- ${x}`).join('\n') : '- (keine angegeben)';
}

function phaseTestInstructions(task, priorResults, secretsProvided, localSecrets, composeProject = `${DEFAULT_BRAND.cli}-phasetest`) {
  const done = priorResults.length
    ? `\n\nBereits in den Umsetzungsaufgaben ausgeführt und grün – NICHT wiederholen und nicht erneut in die Ergebnisdatei schreiben:\n${priorResults.map((r) => `- [${r.taskId}] ${r.component}: ${r.criterion}`).join('\n')}`
    : '';
  const secrets = secretsProvided && localSecrets
    ? `\n\n**Lokale Test-Secrets:** Unter \`${localSecrets}\` in deinem Worktree liegen die lokalen Secrets (vom Orchestrator bereitgestellt, per .gitignore ausgeschlossen). Du darfst sie verwenden, um den lokalen Stack für die Tests hochzufahren. Nur lesen; nie committen, nie in Ausgaben, Logs, Handoff, Jira oder die Ergebnisdatei kopieren. Andere Secrets bleiben tabu.`
    : '\n\nLokale Test-Secrets stehen nicht zur Verfügung: Tests, die sie brauchen, mit result "skip" und Hinweis melden – nicht als blockierende Frage.';
  return `Dies ist die **Phasentest-Aufgabe** für ${task.epic}. Führe **nur** die Playwright- und Container-/Integrationstests für alle Komponenten des Epics gebündelt aus. Unit-Tests, Lint und Code-Checks sind Sache der Umsetzungsaufgaben und laufen hier nicht noch einmal.

Docker: Verwende einen eigenen Compose-Projektnamen \`COMPOSE_PROJECT_NAME=${composeProject}\` (bzw. \`docker compose -p ${composeProject}\`), damit ein laufender lokaler Stack des Menschen nicht ersetzt wird. Belegte Ports oder fremde Container nicht stoppen, sondern als Frage melden. Was du startest, fährst du am Ende wieder herunter.

Behebe nur kleine, eindeutige Fehler selbst; alles andere als Test-Eintrag mit result "fail" und aussagekräftigem Hinweis melden.${secrets}${done}`;
}

export function taskPrompt({ task, agent, otherTasks, takeover, answers, contextDocs = [], priorResults = [], secretsProvided = false, localSecrets = null, composeProject, protocolAddendum = '', cli = DEFAULT_BRAND.cli, jiraCloudId = '', jiraManaged = false }) {
  const kind = task.type === 'phase-test'
    ? phaseTestInstructions(task, priorResults, secretsProvided, localSecrets, composeProject)
    : 'Implementiere die Aufgabe vollständig gemäß Beschreibung und Akzeptanzkriterien.';

  const parts = [
    `Du bist der Agent "${agent}". Aufgabe: ${task.id} – ${task.title}`,
    `Epic/Phase: ${task.epic || '-'} | Branch: ${task.branch} (bereits ausgecheckt)`,
    `Dein Arbeitsbereich (nur hier ändern):\n${list(task.domain)}`,
    kind,
  ];
  if (contextDocs.length) {
    const docs = contextDocs.map((d) => `- \`${d.path}\`${d.note ? ` – ${d.note}` : ''}`).join('\n');
    parts.push(`## Projektkontext (vor Arbeitsbeginn lesen)\n${docs}\nDiese Dokumente sind Hintergrund. Dein Auftrag ist ausschließlich die Aufgabe in dieser Nachricht.`);
  }
  if (task.description) parts.push(`## Beschreibung\n${task.description}`);
  parts.push(`## Akzeptanzkriterien\n${list(task.acceptanceCriteria)}`);
  if (task.jira !== false) parts.push(jiraManaged ? `Details stehen im Jira-Ticket ${task.id}; lies es bei Bedarf über das Atlassian-MCP${jiraCloudId ? ` (cloudId ${jiraCloudId})` : ""}. Status, Kommentare und Labels setzt ${cli} selbst: ändere das Ticket NICHT (dieser Punkt aus dem Protokoll entfällt).` : `Details stehen im Jira-Ticket ${task.id}; lies es über das Atlassian-MCP, falls die Beschreibung hier knapp ist.${jiraCloudId ? ` Jira-cloudId: ${jiraCloudId} (nicht erneut abfragen).` : ''}`);
  if (takeover) {
    parts.push(`## Übernahme\n${takeover}\nLies den Stand mit \`${cli} handoff\` und setze am letzten DONE fort. Prüfe einen offenen START gegen den tatsächlichen Code.`);
  }
  if (task.notes?.length) parts.push(`## Hinweise des Orchestrators\n${list(task.notes)}`);
  if (answers?.length) {
    parts.push(`## Antworten des Menschen auf frühere Fragen\n${answers.map((a) => `- F: ${a.question}\n  A: ${a.answer}`).join('\n')}`);
  }
  if (otherTasks.length) {
    parts.push(`## Parallel laufend (nicht anfassen)\n${otherTasks.map((t) => `- ${t.id} (${t.assignedAgent}): ${t.domain.join(', ')}`).join('\n')}`);
  }
  const jiraDuty = jiraManaged ? `Status, Kommentare und Labels setzt ${cli} selbst – du änderst das Ticket nicht.` : JIRA_DUTY;
  parts.push(protocol.replaceAll('{{cli}}', cli).replaceAll('{{jira}}', jiraDuty));
  if (protocolAddendum) parts.push(protocolAddendum);
  return parts.join('\n\n');
}

export function resumePrompt(task, addendum = '', cli = DEFAULT_BRAND.cli) {
  return `Dein vorheriger Lauf an ${task.id} wurde unterbrochen (Kontingent/Timeout). Lies den Stand mit \`${cli} handoff\`, prüfe offene START-Einträge gegen den Code und mach weiter. Halte dich weiter an das Arbeitsprotokoll und schreibe am Ende .orchestrator-run/result.json.
Aktuelles Epic/Phase: ${task.epic || '-'}
Aktueller Arbeitsbereich (nur hier ändern):
${list(task.domain)}
Hinweise des Orchestrators:
${list(task.notes)}${addendum ? `\n\n${addendum}` : ''}`;
}

export function importPrompt({ keys = [], jql = null }, outFile, config = {}) {
  const domains = config.exampleDomains || [];
  const preferences = Object.entries(config.agents || {})
    .filter(([, cfg]) => cfg.enabled !== false && cfg.preferredDomains?.length)
    .map(([name, cfg]) => `${JSON.stringify(name)} für ${cfg.preferredDomains.join(', ')}`);
  const source = jql
    ? `alle Tickets, die die JQL-Abfrage \`${jql}\` liefert (bei Epics/Features samt aller Kind-Tickets)`
    : `die folgenden Tickets samt aller Kind-Tickets (bei Epics/Features: Features und Subtasks): ${keys.join(', ')}`;
  return `Lies über das Atlassian-MCP (Jira${config.source?.cloudId ? `, cloudId ${config.source.cloudId}` : ''}) ${source}.

Erzeuge daraus eine Aufgabenliste für einen Orchestrator und schreibe sie als JSON-Array nach:
${outFile}

Eine Aufgabe pro umsetzbarem Ticket (in der Regel Subtasks; ein Feature ohne Subtasks ist selbst eine Aufgabe). Felder:
- "id": Ticket-Key
- "labels": Array der Ticket-Labels (unverändert übernehmen); Tickets mit einem dieser Stopp-Labels ebenfalls importieren: ${JSON.stringify(config.source?.stoppedLabels || stoppedLabels(config.brand || DEFAULT_BRAND))}. Sie bleiben gestoppt, bis der Mensch sie explizit fortsetzt.
- "title": Ticket-Titel
- "epic": Key des Epics (bei Tickets ohne Epic: Key des Elterntickets oder des Tickets selbst)
- "description": Umsetzungsanforderung, knapp (max. 15 Zeilen)
- "acceptanceCriteria": Array von Strings (abgedeckte AC des Features + Tests des Subtasks)
- "domain": Array von Repo-relativen Pfad-Präfixen, die die Aufgabe ändert${domains.length ? `, z. B. ${JSON.stringify(domains)}` : ''}. So eng wie möglich, damit zwei Agenten parallel arbeiten können.
- "dependsOn": Array von Ticket-Keys, die vorher fertig sein müssen (aus Jira-Links oder fachlich zwingend)
- "preferredAgent": ${preferences.length ? preferences.join('; ') + '; sonst null' : 'null (keine Domänenpräferenzen konfiguriert)'}
- "resources": ["docker"], falls die Aufgabe den Docker-Stack braucht, sonst []
- "size": Umfang der Umsetzung, bestimmt das Modell des Agenten:
  "S" = klein und klar umrissen (eine Komponente, wenige Dateien, keine Design-Entscheidungen),
  "M" = mehrere Dateien oder zwei Komponenten, überschaubare Abwägungen,
  "L" = neue Komponente, mehrere Ebenen (z. B. Backend + API + UI), Architektur- oder Sicherheitsfragen.
  Im Zweifel die größere Stufe wählen. Akzeptanzkriterien, die zusätzliche Ebenen verlangen, zählen mit.

Keine Tickets aufnehmen, die bereits erledigt sind oder in "In Review" stehen. Ändere nichts in Jira. Gib zum Schluss nur die Anzahl der Aufgaben aus.`;
}
