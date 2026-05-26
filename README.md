# Baustellenplaner

Webbasierte Einsatzplanung fuer den Elektrobetrieb.

Ziel von Version 1.0: **Wer ist wann auf welcher Baustelle?**

Die Anwendung wird getrennt aufgebaut:

- `backend/`: FastAPI, SQLAlchemy, Alembic, PostgreSQL
- `frontend/`: spaeter React, TypeScript und Vite
- `docs/Prompt_Kalender_V1.rtf`: hinterlegter Projektprompt als fachliche Leitplanke
- `docs/reference/Baustellenplan_25_Master.xlsm`: bestehender Excel-Planer als Referenz

## Lokal starten

Voraussetzungen:

- Docker Desktop
- Python 3.12+

Erstkonfiguration:

```bash
cp .env.example .env
docker compose up -d db
```

Backend vorbereiten und starten:

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -e ".[dev]"
alembic upgrade head
python3 -m app.seed_data
uvicorn app.main:app --reload
```

Healthcheck:

- http://localhost:8000/api/health

## Microsoft Graph Verbindungstest

Die SharePoint-/OneDrive-Anbindung ist als sicherer Backend-Test vorbereitet. Es werden noch keine produktiven Baustellenordner automatisch erstellt und keine Dateien hochgeladen. Alle Werte gehoeren in `.env` oder Azure App Settings, niemals ins Repo.

Benötigte App Settings / `.env`-Werte:

```env
MS_GRAPH_ENABLED=false
MS_GRAPH_CREATE_TEST_FOLDERS_ENABLED=false
MS_GRAPH_CREATE_PROJECT_FOLDERS_ENABLED=false
MS_TENANT_ID=
MS_CLIENT_ID=
MS_CLIENT_SECRET=
MS_PROJECT_SITE_ID=
MS_PROJECT_DRIVE_ID=
MS_PROJECT_ROOT_FOLDER_ID=
MS_GRAPH_TIMEOUT_SECONDS=15
MS_GRAPH_BASE_URL=https://graph.microsoft.com/v1.0
```

Admin-Test-Endpunkte:

- `GET /api/admin/integrations/microsoft-graph/test` prueft Token, Drive und Root-Ordner.
- `POST /api/admin/integrations/microsoft-graph/create-test-project-folder` erstellt nur bei `MS_GRAPH_ENABLED=true` und `MS_GRAPH_CREATE_TEST_FOLDERS_ENABLED=true` einen Testordner mit 15 Unterordnern.
- Produktive Projektordner fuer neue Baustellen werden nur bei `MS_GRAPH_ENABLED=true` und `MS_GRAPH_CREATE_PROJECT_FOLDERS_ENABLED=true` erstellt. Bestehende Baustellen werden nicht automatisch nachgeruestet.

Lokale Pruefung:

1. `.env` mit `MS_GRAPH_ENABLED=false` starten.
2. Als Admin `GET /api/admin/integrations/microsoft-graph/test` aufrufen. Erwartung: `graph_enabled=false`.
3. Echte Entra-/Graph-Werte in `.env` setzen und `MS_GRAPH_ENABLED=true` aktivieren.
4. Backend neu starten und den Test-Endpunkt erneut aufrufen. Erwartung: `connected=true`, Drive und Root-Ordner werden angezeigt.
5. `MS_GRAPH_CREATE_TEST_FOLDERS_ENABLED=false` lassen und den Testordner-Endpunkt aufrufen. Erwartung: blockiert.
6. Flag kurz auf `true` setzen, Backend neu starten und den Testordner-Endpunkt aufrufen. Danach in SharePoint den Testordner pruefen.
7. Flag wieder auf `false` setzen.

Azure-Pruefung:

1. App Service → Configuration / Environment variables oeffnen.
2. Alle `MS_GRAPH_*` Werte setzen.
3. Speichern und App Service neu starten.
4. Als Admin den Test-Endpunkt pruefen.
5. Logs pruefen: keine Secrets, keine Tokens, keine Authorization Header.

Empfehlung fuer produktive Berechtigungen: moeglichst eingeschraenkte App-Berechtigung, idealerweise `Sites.Selected` beziehungsweise Zugriff nur auf die konkrete SharePoint-Site/Bibliothek.

## Architekturregeln

- Keine Excel-Datei als Datenquelle.
- Die Excel-Datei in `docs/reference/` ist nur Referenz, keine Datenhaltung.
- Keine SQLite-Abkuerzung.
- Keine Tabellenanlage per `create_all()` beim App-Start.
- Migrationen laufen ueber Alembic.
- Fachlogik gehoert in Backend-Services, API-Routen bleiben schlank.
- Secrets liegen in `.env` beziehungsweise spaeter in Azure App Settings.

Login:

- `POST /api/auth/login`
- `GET /api/auth/me`
- `GET /api/users` ist admin-geschuetzt

Seed-Daten:

- Admin-Zugang kommt aus `ADMIN_USERNAME` und `ADMIN_PASSWORD`.
- Demo-Benutzer nutzen `SEED_DEFAULT_PASSWORD`.
- Die Seed-Daten enthalten bewusst vorbereitete Konfliktfaelle fuer die spaetere Backend-Pruefung.

Kern-API Schritt 5:

- `GET/POST/PATCH /api/persons`
- `GET/POST/PATCH /api/sites`
- `GET/POST/PATCH/DELETE /api/assignments`
- `GET/POST/PATCH/DELETE /api/absences`
- `GET /api/matrix?start=YYYY-MM-DD&end=YYYY-MM-DD`


Konfliktpruefung Schritt 6:

- Assignment-Schreiboperationen pruefen Konflikte im Backend.
- Harte Konflikte liefern `409 Conflict` mit Blockiergruenden.
- Weiche Konflikte und Hinweise werden bei erfolgreichem Speichern mitgegeben.
- Konfliktregeln sind mit Unit-Tests abgesichert.


Frontend Schritt 7:

- React-, TypeScript- und Vite-Grundlage liegt in `frontend/`.
- Login, geschuetzte Routen und rollenabhaengige Navigation sind vorbereitet.
- Die erste sichtbare Matrix kommt in Schritt 8.


Planmatrix Schritt 8:

- Erste Desktop-Matrix unter `/matrix`.
- Zeitraum: vergangene Woche, aktuelle Woche und naechste fuenf Wochen.
- Baustellenzeilen, Tagespalten, sticky linke Spalten und Kurzcode-Anzeige.
- Wochenenden sind umschaltbar und werden bei geplanten Einsaetzen automatisch sichtbar.


Direkte Zellbearbeitung Schritt 9:

- Klick auf eine Matrixzelle oeffnet den Zell-Editor.
- Interne Personen koennen aus der Liste ergaenzt werden.
- Externe Namen erzeugen im Backend `external_temp` Personen.
- Aenderungen speichern automatisch nach kurzer Verzoegerung.
- Harte Konflikte kommen aus dem Backend und blockieren das Speichern.
- Undo gilt fuer die aktuelle Browser-Session.


Azure-Staging:

- Das Projekt ist fuer Azure App Service, Azure Static Web Apps und Azure Database for PostgreSQL vorbereitet.
- Allgemeine Anleitung: `docs/AZURE_STAGING_DEPLOYMENT.md`
- Konkrete Checkliste fuer `kalender-beg-staging`: `docs/AZURE_STAGING_CHECKLIST.md`
- Backend-Startup fuer App Service: `backend/startup.sh`
- Frontend-SPA-Fallback: `frontend/staticwebapp.config.json`
- GitHub Actions: `.github/workflows/backend-staging.yml` und `.github/workflows/frontend-staging.yml`
