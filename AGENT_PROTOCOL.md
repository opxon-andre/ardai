# Arbeitsprotokoll für orchestrierte Agenten

Du arbeitest unbeaufsichtigt im Auftrag des Orchestrators ardai.
Ein zweiter Agent arbeitet parallel in einem anderen Bereich des Repos. Dein
Kontingent kann jederzeit mitten in der Arbeit enden – dann übernimmt der andere
Agent deine Aufgabe ab dem letzten gepushten Stand. Halte dich deshalb genau an
diese Regeln.

## 1. Handoff und Sicherung: ein Aufruf pro Teilziel

Datei: `.handoff/<TASK-ID>.md` im Task-Branch. **Lies sie zuerst, aber nur so:**
`{{cli}} handoff` (zeigt den Plan, die letzten Einträge und offene `START`-Einträge; mit `--all` die ganze
Datei, nur wenn nötig). Ein `START` ohne zugehöriges `DONE` wurde durch einen Outage unterbrochen: prüfe den
tatsächlichen Stand im Code, bevor du ihn wiederholst.

Arbeite in **Teilzielen** (3 bis 6 je Aufgabe, jeweils ein sinnvoll abgeschlossener Block: Funktion samt Test,
nicht jede Datei einzeln). Lege vor dem ersten Teilziel einmalig den Abschnitt `## Plan` in der Handoff-Datei an
(Datei bearbeiten, ein paar Zeilen). Danach nur noch diese Aufrufe:

```
{{cli}} step START "Teilziel 2: Validierung der Eingaben"   # optional, nur bei längeren Teilzielen
{{cli}} step DONE  "Validierung implementiert, Tests grün"    # Zeile anhängen + git add -A + commit + push, ein Aufruf
{{cli}} step NOTE  "Annahme: Default-Seitengröße 50"          # nur Eintrag, kein Commit
```

`step DONE` ersetzt Handoff-Bearbeitung, `git add`, `git commit` und `git push`. Die Commit-Nachricht lautet
`<TASK-ID>: <Text>`. Gib dem DONE-Text das Ergebnis mit (was ist fertig, welche Tests liefen). Die Datei wird
vom Werkzeug bei Bedarf verdichtet, bearbeite sie außer beim Plan nicht von Hand.

## 2. Push und Grenzen der Sicherung

Spätestens nach jedem Teilziel muss alles gepusht sein: das erledigt `step DONE`. **Niemals nach `main`
pushen** (ein Hook blockiert das zusätzlich). Kein Force-Push, kein Rebase gepushter Commits. Hat `step`
einen Fehler gemeldet (zum Beispiel Push abgelehnt), behebe ihn zuerst; nur dann sind eigene
`git`-Befehle nötig.

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
- Jira: {{jira}}

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

## 8. Kontext sparen (spart Kontingent für alle)

Jeder Werkzeugaufruf und jede Ausgabe bleibt für den Rest des Laufs im Kontext und wird bei jedem weiteren
Schritt erneut gelesen. Deshalb:

- Ausgaben begrenzen: Tests mit knapper Ausgabe starten und filtern (`| tail -n 40`, `grep -E "fail|error"`),
  nie komplette Logs, Diffs oder Dateien ausgeben. Große Dateien nur bereichsweise lesen (Read mit Zeilenbereich,
  `sed -n 'a,bp'`), Dateien nicht mehrfach lesen.
- Tests gezielt: erst die betroffenen Testdateien, die komplette Suite einmal am Ende.
- Jira: nur wie in Abschnitt 3 beschrieben; Abfragen wie getAccessibleAtlassianResources entfallen, wenn die
  cloudId im Auftrag steht.
- Suche im Code zuerst mit gezieltem `grep`/Glob; bei strukturellen Fragen (Aufrufer, Auswirkungen) die
  Graph-Werkzeuge (Abschnitt 4), statt viele Dateien zu lesen.
