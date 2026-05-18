# Azure-Staging ohne lokales Docker

Ziel: Eine fruehe Testversion online bereitstellen, ohne lokal Docker/PostgreSQL installieren zu muessen.

Konkrete Namen fuer dieses Projekt stehen in `docs/AZURE_STAGING_CHECKLIST.md`.

## Ressourcen

Empfohlen fuer diese Testphase:

- Azure Database for PostgreSQL Flexible Server
- Azure App Service fuer das FastAPI-Backend
- Azure Static Web Apps fuer das React-Frontend

## 1. PostgreSQL Flexible Server

Im Azure Portal erstellen:

- Ressource: Azure Database for PostgreSQL flexible server
- Region: moeglichst Deutschland/Europa nah am Betrieb
- Datenbankname: `baustellenplaner`
- Admin-User und Passwort notieren
- Netzwerk: fuer den ersten Test Public access erlauben
- Firewall: Azure Services erlauben

Connection String fuer App Service:

```text
postgresql://USER:PASSWORD@SERVER.postgres.database.azure.com:5432/baustellenplaner?sslmode=require
```

Der Code wandelt `postgresql://` intern fuer SQLAlchemy auf den psycopg-Treiber um.

## 2. Backend App Service

App Service erstellen:

- Runtime stack: Python
- Betriebssystem: Linux
- Startup command:

```bash
bash startup.sh
```

App Settings setzen:

```text
DATABASE_URL=postgresql://USER:PASSWORD@SERVER.postgres.database.azure.com:5432/baustellenplaner?sslmode=require
SECRET_KEY=LANGER-ZUFALLSSTRING
ENVIRONMENT=staging
CORS_ORIGINS=https://DEINE-STATIC-WEB-APP.azurestaticapps.net
ADMIN_USERNAME=admin
ADMIN_PASSWORD=DEIN-ADMIN-PASSWORT
ADMIN_DISPLAY_NAME=Administrator
SEED_DEFAULT_PASSWORD=DEMO-PASSWORT
```

Hinweis: `startup.sh` fuehrt fuer diese fruehe Staging-Version `alembic upgrade head` aus und startet danach FastAPI mit Gunicorn/Uvicorn.

## 3. Frontend Static Web Apps

Static Web App erstellen:

- App location: `frontend`
- Output location: `dist`
- Build command: `npm run build`
- API location leer lassen

Environment Variable fuer den Build setzen:

```text
VITE_API_BASE_URL=https://DEIN-BACKEND.azurewebsites.net/api
```

## 4. Nach dem Deployment testen

- Backend Healthcheck: `https://DEIN-BACKEND.azurewebsites.net/api/health`
- Frontend oeffnen: Static-Web-App-URL
- Login: `ADMIN_USERNAME` und `ADMIN_PASSWORD`
- Matrix unter `/matrix` oeffnen

## Wichtig fuer spaeter

Diese Anleitung ist fuer Staging bequem gehalten. Fuer Produktion sollten Migrationen und Seed-Daten aus dem Startup heraus in eine Deployment-Pipeline wandern.
