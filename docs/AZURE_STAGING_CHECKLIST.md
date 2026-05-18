# Azure-Staging Checkliste

Diese Checkliste beschreibt den geplanten Staging-Aufbau fuer `kalender-beg-staging` in `Germany West Central`.

## Zielnamen

Backend und Datenbank werden in `Germany West Central` geplant. Die Static Web App wird fuer Staging in `West Europe` angelegt, falls `Germany West Central` im Portal/CLI nicht angeboten wird.

| Zweck | Name |
| --- | --- |
| Resource Group | `kalender-beg-staging-rg` |
| PostgreSQL Flexible Server | `kalender-beg-staging-db` |
| PostgreSQL Datenbank | `baustellenplaner` |
| Backend App Service | `kalender-beg-staging-api` |
| Frontend Static Web App | `kalender-beg-staging-web` |

Hinweis: Einige Azure-Namen muessen weltweit eindeutig sein. Wenn Azure einen Namen ablehnt, den gleichen Namen mit kurzem Zusatz verwenden, zum Beispiel `kalender-beg-staging-api-ce`.

## Alternative: Azure Cloud Shell Script

Statt die Ressourcen manuell im Portal anzulegen, kann `infra/azure/create-staging-resources.sh` in Azure Cloud Shell ausgefuehrt werden. Das Script fragt Passwoerter verdeckt ab, erstellt die Staging-Ressourcen und gibt danach die GitHub-Secrets aus, die noch eingetragen werden muessen.

Wichtig: Das Script erzeugt kostenpflichtige Azure-Ressourcen, insbesondere PostgreSQL und App Service. Nach Tests nicht mehr benoetigte Ressourcen ueber die Resource Group `kalender-beg-staging-rg` loeschen.

## 1. Resource Group

Im Azure Portal anlegen:

- Name: `kalender-beg-staging-rg`
- Region: `Germany West Central`

## 2. PostgreSQL Flexible Server

Anlegen:

- Server name: `kalender-beg-staging-db`
- Region: `Germany West Central`
- PostgreSQL-Version: aktuelle stabile Version
- Authentication: PostgreSQL authentication
- Admin user: selbst waehlen
- Passwort: starkes Passwort, nicht ins Repo schreiben
- Database: `baustellenplaner`
- Public access fuer Staging aktivieren
- Azure services access erlauben

Connection String fuer das Backend:

```text
postgresql://ADMINUSER:PASSWORT@kalender-beg-staging-db.postgres.database.azure.com:5432/baustellenplaner?sslmode=require
```

## 3. Backend App Service

Anlegen:

- Name: `kalender-beg-staging-api`
- Publish: Code
- Runtime stack: Python 3.12
- Operating System: Linux
- Region: `Germany West Central`
- Startup Command: `bash startup.sh`

App Settings setzen:

```text
DATABASE_URL=postgresql://ADMINUSER:PASSWORT@kalender-beg-staging-db.postgres.database.azure.com:5432/baustellenplaner?sslmode=require
SECRET_KEY=<langer-zufallswert>
ENVIRONMENT=staging
CORS_ORIGINS=https://kalender-beg-staging-web.azurestaticapps.net
ACCESS_TOKEN_EXPIRE_MINUTES=480
ADMIN_USERNAME=admin
ADMIN_PASSWORD=<staging-admin-passwort>
ADMIN_DISPLAY_NAME=Administrator
SEED_DEFAULT_PASSWORD=<demo-passwort-fuer-seed-user>
SCM_DO_BUILD_DURING_DEPLOYMENT=true
```

Wichtig: Passwoerter und `SECRET_KEY` nur in Azure App Settings oder GitHub Secrets hinterlegen, nie im Code.

## 4. GitHub Secret fuer Backend Deployment

In Azure App Service:

- App Service `kalender-beg-staging-api` oeffnen
- Download publish profile

In GitHub Repo `DonkeyKonger/Kalender_BEG` anlegen:

- Settings > Secrets and variables > Actions > New repository secret
- Name: `AZURE_WEBAPP_PUBLISH_PROFILE_STAGING`
- Value: kompletter Inhalt der Publish-Profile-Datei

Danach kann `.github/workflows/backend-staging.yml` manuell oder bei Push nach `main` deployen.

## 5. Frontend Static Web App

Anlegen:

- Name: `kalender-beg-staging-web`
- Region: `West Europe`, falls `Germany West Central` nicht angeboten wird
- Deployment source: GitHub
- Repository: `DonkeyKonger/Kalender_BEG`
- Branch: `main`
- App location: `frontend`
- API location: leer lassen
- Output location: `dist`
- Build command: `npm run build`

Falls Azure automatisch einen Workflow anlegt, kann dieser geloescht oder mit `.github/workflows/frontend-staging.yml` abgeglichen werden.

GitHub Actions Secret/Variable setzen:

- Secret: `AZURE_STATIC_WEB_APPS_API_TOKEN_STAGING`
- Variable: `VITE_API_BASE_URL_STAGING=https://kalender-beg-staging-api.azurewebsites.net/api`

## 6. Test nach Deployment

Backend:

```text
https://kalender-beg-staging-api.azurewebsites.net/api/health
```

Frontend:

```text
https://kalender-beg-staging-web.azurestaticapps.net
```

Login:

- Benutzer: Wert aus `ADMIN_USERNAME`
- Passwort: Wert aus `ADMIN_PASSWORD`

## 7. Erster sinnvoller User-Test

Der erste User-Test ist sinnvoll, wenn diese Punkte erfuellt sind:

- Backend Healthcheck funktioniert
- Frontend laedt online
- Login als Admin funktioniert
- Seed-Daten sind sichtbar
- Matrix laedt Daten
- eine Zellaenderung wird gespeichert
- ein harter Konflikt wird vom Backend blockiert

Dann koennen Admin, Projektleiter und Buero den Kernworkflow testen. Monteur-Tests werden nach Schritt 10 aussagekraeftiger.
