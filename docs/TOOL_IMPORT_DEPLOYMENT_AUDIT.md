# Werkzeugimport: Deployment-Audit vom 17.07.2026

## Verifizierte Ausgangslage

- Letztes erfolgreiches Backend-Deployment vor der Automatisierung: Workflow `#299`,
  Commit `eeb744a`. Dieser Lauf deployte nur die Anwendung und führte keinen
  Werkzeugimport aus.
- Die Build- und Test-Jobs sowie das eigentliche Azure-ZIP-Deployment waren auch in
  den Läufen `#300` bis `#305` erfolgreich. Ausschließlich der anschließend über die
  Kudu Command API gestartete Importschritt schlug fehl.
- Das von Lauf `#304` heruntergeladene GitHub-Artefakt enthält eine äußere Datei
  `backend-release.zip`. Deren App-Root enthält 342 Einträge mit folgenden relevanten
  Root-Elementen:
  `alembic/`, `alembic.ini`, `app/`, `pyproject.toml`, `requirements.txt`,
  `startup.sh`.
- Relevante Dateien im Deployment-ZIP von `#304`:
  - `app/import_data/BEG-Maschinen+Werkzeugliste.xlsx` (522871 Bytes)
  - `app/scripts/import_tools_from_excel.py`
  - `app/scripts/run_deployed_tool_import.sh`
  - `startup.sh`

Damit war weder die Groß-/Kleinschreibung noch das Fehlen der Exceldatei im
Build-Artefakt die Ursache.

## Fehlerfolge

| Lauf | Änderung | Erster tatsächlicher Fehler |
| --- | --- | --- |
| #300 | Import nach dem Deployment über Kudu in `/home/site/wwwroot` gestartet | `bash: app/scripts/run_deployed_tool_import.sh: No such file or directory` |
| #301 | Absoluter Pfad und VFS-Warteprüfung ergänzt | `Azure import helper is missing after deployment: /home/site/wwwroot/app/scripts/run_deployed_tool_import.sh` |
| #302 | Build-Artefakt zusätzlich über Kudu VFS hochgeladen | `AttributeError: 'NoneType' object has no attribute 'strip'` verdeckte die eigentliche Kudu-Antwort |
| #303 | Kudu-Antwort nullsicher verarbeitet | Kudu konnte `starter.sh` mit Arbeitsverzeichnis `/home/data` nicht starten: `No such file or directory` |
| #304 | VFS- und Arbeitsverzeichnispfade geändert | `mkdir: invalid option -- 'e'` |
| #305 | Kommandokette in ein Kudu-Bootstrap-Skript verschoben | `/home/tool-import-...sh: line 4: python: command not found` |

## Lauf #304 im Detail

- Fehlgeschlagener Schritt: `Import verified tool master data`
- Kudu-Befehl:

  ```text
  mkdir -p /home/data/tool-material-import/releases/<SHA> &&
  python -m zipfile -e /home/tool-import-<SHA>.zip
    /home/data/tool-material-import/releases/<SHA> &&
  PROJECT_ROOT=/home/data/tool-material-import/releases/<SHA>
    bash /home/data/tool-material-import/releases/<SHA>/app/scripts/run_deployed_tool_import.sh
  ```

- An Kudu übergebenes Arbeitsverzeichnis: `/home`
- Erwartete Kudu-Datei: `/home/tool-import-<SHA>.zip`
- Erwartetes extrahiertes Importskript:
  `/home/data/tool-material-import/releases/<SHA>/app/scripts/run_deployed_tool_import.sh`
- Tatsächlich belegt:
  - `/home` existierte als Kudu-Arbeitsverzeichnis.
  - Der Upload der ZIP-Datei über `/api/vfs/tool-import-<SHA>.zip` war erfolgreich.
  - Das Release-Verzeichnis wurde nicht zuverlässig erzeugt, weil Kudu die Zeichenkette
    nicht als Shell-Pipeline ausführte. `-e` aus dem ZIP-Befehl wurde als Argument an
    `mkdir` weitergereicht.
- Vollständige erste Fehlermeldung:

  ```text
  Azure tool import exited with 1: mkdir: invalid option -- 'e'
  Try 'mkdir --help' for more information.
  ```

## Root Cause

Der Import wurde nach erfolgreichem Deployment über die Kudu Command API ausgeführt.
Kudu ist bei diesem Linux-Python-App-Service jedoch nicht der laufende App-/Oryx-
Container:

- Der durch `SCM_DO_BUILD_DURING_DEPLOYMENT=true` erzeugte Python-App-Kontext wird
  beim Start der Anwendung aktiviert.
- Der konfigurierte Startup-Befehl ist `bash startup.sh`.
- Kudu sah den deployten App-Root nicht zuverlässig unter seinem
  `/home/site/wwwroot` und stellte in Lauf `#305` auch kein `python` bereit.
- Weitere Kudu-Pfadkorrekturen konnten deshalb die eigentliche Architekturgrenze
  nicht beheben.

## Korrigierter Ablauf

1. Der GitHub-Runner installiert Abhängigkeiten und führt alle Backend-Tests aus.
2. Das Deployment-ZIP wird aus dem Inhalt von `backend/` erstellt.
3. Der Workflow entpackt genau dieses fertige ZIP in ein temporäres App-Verzeichnis.
4. `python -m app.scripts.import_bundled_tools --check-only` löst den App-Root aus
   `Path(__file__)` auf und prüft relativen Pfad, SHA-256 und Quelldaten.
5. Azure deployt dasselbe geprüfte ZIP.
6. `startup.sh` führt Migrationen und danach den idempotenten Werkzeugimport im
   echten Python-App-Kontext aus.
   Berichte und Sicherungen liegen unter dem aus `HOME` abgeleiteten Datenpfad;
   `TOOL_IMPORT_DATA_ROOT` kann diesen Pfad explizit überschreiben.
7. Erst danach startet Gunicorn/FastAPI.
8. Der Workflow wartet auf `/api/health/tool-import`. Der Endpunkt wird erst vom
   neuen Deployment angeboten und bestätigt Prüfsumme sowie vollständige Anzahl der
   importierten Quellschlüssel.

Es werden keine absoluten Kudu-Pfade und keine Kudu Command API mehr verwendet.
