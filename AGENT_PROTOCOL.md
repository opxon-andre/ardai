# Arbeitsprotokoll für orchestrierte Agenten

Du arbeitest unbeaufsichtigt im Auftrag des Orchestrators ardai.
Ein zweiter Agent arbeitet parallel in einem anderen Bereich des Repos. Dein
Kontingent kann jederzeit mitten in der Arbeit enden – dann übernimmt der andere
Agent deine Aufgabe ab dem letzten gepushten Stand. Halte dich deshalb genau an
diese Regeln.

## 1. Handoff-Datei (Pflicht, kleinteilig)

Datei: `.handoff/<TASK-ID>.md` im Task-Branch. Lies sie **zuerst**, bevor du
irgendetwas änderst. Steht dort ein `START` ohne zugehöriges `DONE`, wurde
dieser Schritt durch einen Outage unterbrochen: prüfe den tatsächlichen Stand im
Code, bevor du ihn wiederholst oder fortsetzt.

Format, eine Zeile pro Ereignis, nur anhängen, nie umschreiben:

```
- 2026-10-14T10:15Z [claude] START  Schritt 3: Funktion der zugewiesenen Komponente implementieren
- 2026-10-14T10:32Z [claude] DONE   Schritt 3: Funktion implementiert, Unit-Test grün (commit a1b2c3d)
- 2026-10-14T10:33Z [claude] NOTE   Offene Frage Q zur Paginierung, arbeite mit Default 50 weiter
```

Ein Schritt ist klein: eine Datei, eine Funktion, ein Test – maximal etwa
15 Minuten Arbeit. Lege zu Beginn einen Abschnitt `## Plan` mit den geplanten
Schritten an, falls er noch fehlt.

## 2. Commit und Push nach jedem Schritt

Nach jedem `DONE`: `git add -A`, `git commit` (Nachricht beginnt mit der
Task-ID), `git push -u origin <Task-Branch>`. Spätestens nach jedem Subtask
muss alles gepusht sein. **Niemals nach `main` pushen** (ein Hook blockiert
das zusätzlich). Kein Force-Push, kein Rebase gepushter Commits.

## 3. Grenzen

- Arbeite nur in deinem zugewiesenen Bereich (siehe Auftrag). Musst du
  außerhalb etwas ändern, notiere es als Frage (Abschnitt 6) statt es zu tun.
- Keine Secrets lesen oder schreiben: nichts unter `secrets/`,
  `deploy/secrets/`, keine Dateien außerhalb des Repos, keine Zugangsdaten in
  Code, Logs oder Commits. **Einzige Ausnahme:** In einer Phasentest-Aufgabe
  stellt der Orchestrator den im Auftrag genannten Config-Pfad bereit; diese lokalen Test-Secrets
  darfst du dort zum Hochfahren des lokalen Stacks lesen (Details im Auftrag).
- Docker-Stack starten/neu bauen ist erlaubt, wenn der Auftrag es braucht.
  Beim Einzel-Deploy `--no-deps` verwenden.
- Jira: beim Start Ticket auf „In Progress“, bei Erfüllung aller
  Akzeptanzkriterien auf „In Review“ plus kurzer Kommentar mit Ergebnis und
  Branch. Nicht erfüllbares Kriterium: Kommentar + Label `AC:Issue`
  (beachte gegebenenfalls die Jira-Richtlinien des Projekts).

## 4. Code erkunden: zuerst code-review-graph

Der Orchestrator stellt dir das MCP `code-review-graph` mit dem Graphen
**deines Worktrees** bereit. Er wird vor jedem Lauf aktualisiert und während
des Laufs automatisch nachgeführt. Nutze ihn vor Grep/Glob/Read:

- Code finden: `semantic_search_nodes_tool`, `query_graph_tool`
- Auswirkungen einer Änderung: `get_impact_radius_tool`, `get_affected_flows_tool`
- Tests zu einer Funktion: `query_graph_tool` mit `tests_for`
- Vor dem Commit: `detect_changes_tool`

Dateien liest du nur, wenn der Graph nicht reicht. Ist das MCP nicht
erreichbar, arbeite normal weiter und notiere es als `NOTE` in der Handoff-Datei.

## 5. Tests

- **Direkt pro Aufgabe:** Code-Checks (Lint/Typecheck/Unit-Tests der
  betroffenen Komponente) und einfache Akzeptanzkriterien, die ohne laufenden
  Gesamt-Stack prüfbar sind.
- **Nicht pro Aufgabe:** Playwright- und Container-/Integrationstests. Die laufen
  gebündelt in einer eigenen Phasentest-Aufgabe am Ende eines Epics.
- Jedes geprüfte Kriterium kommt als Eintrag in die Ergebnisdatei (Abschnitt 7).

## 6. Fragen an den Menschen

Blockiere nicht. Wenn eine Entscheidung vom Menschen nötig ist:
1. Trage die Frage in die Ergebnisdatei ein (`questions`).
2. Triff, wo vertretbar, eine vorläufige Annahme, notiere sie als `NOTE` in der
   Handoff-Datei und arbeite weiter.
3. Nur wenn ohne Antwort wirklich nichts Sinnvolles mehr geht: `blocking: true`
   setzen und die Aufgabe mit `status: "needs-human"` beenden. Alles bis dahin
   Erledigte ist committet und gepusht.

## 7. Ergebnisdatei (am Ende jedes Laufs)

Schreibe `.orchestrator-run/result.json` im Worktree-Root (nicht committen, ist
in `.gitignore`). Format:

```json
{
  "taskId": "TASK-123",
  "status": "done | needs-human | failed",
  "summary": "Was wurde erledigt (2-4 Sätze, Deutsch)",
  "questions": [
    { "question": "…", "context": "…", "assumption": "womit ich weitergearbeitet habe", "blocking": false }
  ],
  "tests": [
    { "component": "src/component", "criterion": "Das angeforderte Verhalten ist durch einen Unit-Test geprüft", "kind": "check | ac | playwright | container", "result": "pass | fail | skip", "note": "bei fail: Ursache/Hinweis" }
  ]
}
```

`status: "done"` nur, wenn alle direkt prüfbaren Kriterien `pass` sind. Sonst
`failed` mit Hinweis im jeweiligen Test-Eintrag.
