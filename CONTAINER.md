# Betrieb direkt mit Node/npm oder als Container

Beide Varianten verwenden denselben ardai-Code und dieselbe Projektkonfiguration.
Direktbetrieb bleibt möglich (`node orchestrator.mjs install-cli` oder
`npm install --global /absoluter/pfad/zu/ardai`). Das Paket wird dabei aus dem
lokalen Checkout installiert; eine Veröffentlichung auf npm ist nicht erforderlich.

## Container auf einem Linux-Docker-Host

Das Image enthält Node 24, Git, SSH-Client, Python, Codex CLI, Claude Code sowie
Docker CLI mit Compose und Buildx. Projektspezifische Werkzeuge können in einem
abgeleiteten Image ergänzt werden. Ein eigener Docker-Daemon wird nicht gestartet.

Die mitgelieferte `compose.yaml` verwendet:

- Host-Netzwerk: ardai bindet unverändert an **127.0.0.1:4711 auf dem Host**.
- Ausschließlich Bind-Mounts für Arbeitsbereich, Benutzerverzeichnis, Secrets und
  Docker-Socket; keine benannten Docker-Volumes.
- Einen Benutzer ohne root-Rechte mit konfigurierbarer UID/GID und zusätzlicher
  Gruppe für den Docker-Socket.
- Einen Supervisor, damit „Änderungen neu laden“ den Container nicht beendet.

Host-Netzwerk ist für Linux vorgesehen. Docker Desktop benötigt dafür separat
aktivierte Host-Netzwerk-Unterstützung. Alternativ ist eine eigene Compose-Override
mit Bridge-Netzwerk und Portfreigabe möglich.

## Einrichtung

Auf dem Docker-Host:

```sh
cp .env.example .env
mkdir -p secrets/home
chmod 700 secrets secrets/home
umask 077
test -s secrets/ui_token || openssl rand -hex 24 > secrets/ui_token
id -u
id -g
stat -c '%g' /var/run/docker.sock
```

Die drei ermittelten Werte in `.env` als `ARDAI_UID`, `ARDAI_GID` und `DOCKER_GID`
eintragen. Der Container-Benutzer benötigt Schreibrechte auf dem Arbeitsbereich und
`secrets/home`, sowie Leserechte auf den verwendeten Secret-Dateien.

Den Arbeitsbereich und das vorhandene Zielprojekt in `.env` eintragen, beispielsweise:

```dotenv
ARDAI_WORKSPACE=/srv/ardai
ARDAI_PROJECT_DIR=/srv/ardai/project
ARDAI_UI_HOST=127.0.0.1
ARDAI_UI_PORT=4711
```

`/srv/ardai/project` muss ein Git-Repository mit erstem Commit und Remote sein.
Auch die Worktrees müssen unterhalb von `/srv/ardai` liegen, beispielsweise
`../ardai-worktrees` relativ zur Projektwurzel. Der Arbeitsbereich wird unter
**demselben absoluten Host- und Container-Pfad** gemountet. Das ist wichtig:
Bind-Mount-Quellpfade von Docker-Befehlen werden vom Host-Daemon ausgewertet.
Zusätzlich benötigte Host-Verzeichnisse entsprechend in Compose einbinden.
Vorhandene verknüpfte Worktrees müssen zum verwendeten Host-Pfad passen.

Keine Datenordner werden automatisch als root angelegt; fehlende Bind-Mount-Quellen
führen zu einem Fehler. `.env` enthält Konfiguration und Secret-Dateipfade, keine
Zugangsdaten. `.env` und `secrets/` sind aus Git und dem Docker-Build-Kontext ausgeschlossen.

## Zugangsdaten

Nur die tatsächlich benötigten Dateien unter `secrets/` ablegen und die passenden
Dateipfade in `.env` aktivieren:

| Variable | Beispielwert | Verwendung |
| --- | --- | --- |
| `CODEX_API_KEY_FILE` | `/run/secrets/codex_api_key` | Codex im nicht interaktiven API-Betrieb |
| `ANTHROPIC_API_KEY_FILE` | `/run/secrets/anthropic_api_key` | Claude über API-Key |
| `CLAUDE_CODE_OAUTH_TOKEN_FILE` | `/run/secrets/claude_oauth_token` | Claude-Abonnement-Token aus `claude setup-token` |
| `ARDAI_JIRA_EMAIL_FILE` | `/run/secrets/jira_email` | Jira-Konto für direkte REST-Aktionen |
| `ARDAI_JIRA_TOKEN_FILE` | `/run/secrets/jira_token` | Jira-API-Token |
| `ARDAI_GIT_TOKEN_FILE` | `/run/secrets/git_token` | HTTPS-Git-Authentifizierung über Askpass |
| `ARDAI_UI_TOKEN_FILE` | `/run/secrets/ui_token` | UI-Token; Compose verwendet standardmäßig diese Datei |

Secrets-Dateien enthalten jeweils nur den Wert. ardai liest die Agenten- und
Jira-Secrets beim Start und gibt sie zur Laufzeit über die von den CLIs benötigten
Umgebungsvariablen weiter. Sie werden nicht in das Image oder die Projekt-Config
geschrieben. Keine direkten Werte gleichzeitig mit der zugehörigen `_FILE`-Variable
setzen. Die Dateien müssen für die konfigurierte UID lesbar sein. Eigene Compose
`secrets:` können statt des Verzeichnismounts ebenfalls nach `/run/secrets` liefern.
Das UI-Token benötigt mindestens 20 URL-sichere Zeichen; bei bereits vorhandenem
`secrets/ui_token` den Generierungsschritt überspringen, um Lesezeichen zu erhalten.

Alternativ können bestehende Agenten-Anmeldungen und MCP-Konfigurationen im
Benutzerverzeichnis `secrets/home` eingerichtet werden. Dieses Verzeichnis wird
schreibbar nach `/home/node` gemountet, damit Token-Erneuerungen und Session-Logs
Neustarts überleben. Nicht beide Claude-Authentifizierungswege gleichzeitig setzen:
Ein API-Key hat Vorrang vor dem Abonnement. Jira-MCP-Zugriff ist zusätzlich zur
Agenten-Anmeldung einzurichten, wenn Aufgaben aus Jira importiert werden sollen.

Für HTTPS-Git `ARDAI_GIT_USERNAME` passend zum Git-Anbieter setzen; das Token liest
der Askpass-Helfer aus der Datei. Für SSH alternativ Schlüssel und `known_hosts`
aus `secrets/` mounten und `GIT_SSH_COMMAND` in einer Compose-Override setzen.
SSH-Dateirechte müssen den Anforderungen von OpenSSH entsprechen.
Git-Identität über die `GIT_AUTHOR_*`-/`GIT_COMMITTER_*`-Variablen in `.env` oder
eine `.gitconfig` in `secrets/home` konfigurieren.

## Start und Bedienung

```sh
docker compose build
# Nur bei der ersten Einrichtung und bei gestopptem Dienst:
docker compose run --rm ardai init
docker compose up -d
docker compose logs -f ardai
```

`init` erstellt Worktrees und einen Hook und versucht, den Integration-Branch zu
pushen. Vorher `ardai.config.json`, Authentifizierung und Git-Identität einrichten.
Nur die benötigten Agenten aktivieren. Die Logs enthalten die URL mit Zugangs-Token.

Steuerbefehle bei laufendem Dienst **im selben Container** ausführen:

```sh
docker compose exec ardai ardai status
docker compose exec ardai ardai work TASK-123
docker compose exec ardai ardai stop
```

Keine zweite `compose run`-Instanz und keinen parallelen nativen Runner auf demselben
Projektzustand betreiben: PID-Dateien gelten jeweils für den eigenen PID-Namensraum.
Vor einem Wechsel zwischen Direkt- und Containerbetrieb den bisherigen Betrieb beenden.
Vor `docker compose down` laufende Arbeit mit `ardai stop` stoppen und das Ende des
Runners abwarten. Projektzustand, Arbeitsdateien und Anmeldungen bleiben in den Bind-Mounts.

## Host-Docker, Netzwerk und Updates

Der Socket `/var/run/docker.sock` wird eingebunden. `DOCKER_GID` muss zur Gruppe
dieses Sockets passen; bei Rootless-Docker `DOCKER_SOCKET` entsprechend setzen.
Damit können Agenten Docker- und Compose-Befehle auf dem Host ausführen. Dieser
Zugriff erlaubt weitreichende Änderungen am Host und ist für vertrauenswürdige
Aufgaben gedacht. Container, die ein Agent startet, benötigen ihre eigene Bereinigung.

Für Remote-Zugriff die Loopback-Bindung beibehalten und einen SSH-Tunnel verwenden:

```sh
ssh -L 4711:127.0.0.1:4711 user@server
```

Abweichende Bindung/Port über `ARDAI_UI_HOST` und `ARDAI_UI_PORT` in `.env` oder
Compose setzen. Für Reverse-Proxies die erlaubten HTTP-Host-Angaben explizit mit
`ARDAI_UI_ALLOWED_HOSTS=ardai.example.com` konfigurieren. Token-Prüfung bleibt aktiv.
Bei Bridge-Netzwerk innerhalb des Containers `ARDAI_UI_HOST=0.0.0.0` setzen und
die Host-Portfreigabe ausdrücklich begrenzen; beim Host-Netzwerk keine `ports:` setzen.
Im Direktbetrieb liest ardai `.env` aus dem Aufrufverzeichnis; explizite
Prozess-Umgebungsvariablen haben Vorrang. Dateien-Secrets funktionieren dort ebenfalls.

„Änderungen neu laden“ startet den ardai-Prozess innerhalb des laufenden Containers
neu und liest Konfiguration und Secrets erneut. Laufende Aufgaben dürfen vorher
fertig werden. Änderungen an den von Compose übergebenen Umgebungsvariablen
benötigen eine Neuerstellung des Containers; Compose liest seine `.env` beim Aufruf.
Neue Image-Versionen werden ebenfalls über Compose installiert:

```sh
# Zuerst laufende Arbeit beenden:
docker compose exec ardai ardai stop
docker compose build --pull --no-cache
docker compose up -d --force-recreate
```

`CODEX_VERSION` und `CLAUDE_CODE_VERSION` können in `.env` auf getestete Versionen
festgelegt werden. Native Nutzung und Container-Nutzung bleiben unabhängig wählbar.

Grundlagen: [Docker Host-Netzwerk](https://docs.docker.com/engine/network/drivers/host/),
[Compose Secrets](https://docs.docker.com/compose/how-tos/use-secrets/),
[Codex nicht interaktiv](https://developers.openai.com/codex/noninteractive),
[Claude-Authentifizierung](https://code.claude.com/docs/en/authentication).
