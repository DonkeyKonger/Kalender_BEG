#!/usr/bin/env bash
set -euo pipefail

# Run this script in Azure Cloud Shell or with Azure CLI after `az login`.
# It creates the first staging infrastructure for Kalender BEG.

LOCATION="germanywestcentral"
STATIC_WEB_LOCATION="westeurope"
RESOURCE_GROUP="kalender-beg-staging-rg"
PREFIX="kalender-beg-staging"
PG_SERVER="${PREFIX}-db"
PG_DATABASE="baustellenplaner"
APP_SERVICE_PLAN="${PREFIX}-plan"
BACKEND_APP="${PREFIX}-api"
STATIC_WEB_APP="${PREFIX}-web"
REPO_URL="https://github.com/DonkeyKonger/Kalender_BEG"

printf "\nKalender BEG staging setup\n"
printf "Resource group: %s\n" "$RESOURCE_GROUP"
printf "Backend/database region: %s\n" "$LOCATION"
printf "Static Web Apps region: %s\n" "$STATIC_WEB_LOCATION"
printf "\n"

read -r -p "PostgreSQL admin username: " PG_ADMIN_USER
read -r -s -p "PostgreSQL admin password: " PG_ADMIN_PASSWORD
printf "\n"
read -r -s -p "Staging admin password for app login: " ADMIN_PASSWORD
printf "\n"
read -r -s -p "Default password for seeded demo users: " SEED_DEFAULT_PASSWORD
printf "\n"

SECRET_KEY="$(openssl rand -hex 32)"
DATABASE_URL="postgresql://${PG_ADMIN_USER}:${PG_ADMIN_PASSWORD}@${PG_SERVER}.postgres.database.azure.com:5432/${PG_DATABASE}?sslmode=require"
BACKEND_URL="https://${BACKEND_APP}.azurewebsites.net"
STATIC_WEB_URL="https://${STATIC_WEB_APP}.azurestaticapps.net"

az group create \
  --name "$RESOURCE_GROUP" \
  --location "$LOCATION"

az postgres flexible-server create \
  --resource-group "$RESOURCE_GROUP" \
  --name "$PG_SERVER" \
  --location "$LOCATION" \
  --admin-user "$PG_ADMIN_USER" \
  --admin-password "$PG_ADMIN_PASSWORD" \
  --tier Burstable \
  --sku-name Standard_B1ms \
  --storage-size 32 \
  --version 16 \
  --public-access 0.0.0.0 \
  --yes

az postgres flexible-server db create \
  --resource-group "$RESOURCE_GROUP" \
  --server-name "$PG_SERVER" \
  --database-name "$PG_DATABASE"

az appservice plan create \
  --resource-group "$RESOURCE_GROUP" \
  --name "$APP_SERVICE_PLAN" \
  --location "$LOCATION" \
  --is-linux \
  --sku B1

az webapp create \
  --resource-group "$RESOURCE_GROUP" \
  --plan "$APP_SERVICE_PLAN" \
  --name "$BACKEND_APP" \
  --runtime "PYTHON:3.12"

az webapp config set \
  --resource-group "$RESOURCE_GROUP" \
  --name "$BACKEND_APP" \
  --startup-file "bash startup.sh"

az webapp config appsettings set \
  --resource-group "$RESOURCE_GROUP" \
  --name "$BACKEND_APP" \
  --settings \
    DATABASE_URL="$DATABASE_URL" \
    SECRET_KEY="$SECRET_KEY" \
    ENVIRONMENT="staging" \
    CORS_ORIGINS="$STATIC_WEB_URL" \
    ACCESS_TOKEN_EXPIRE_MINUTES="480" \
    ADMIN_USERNAME="admin" \
    ADMIN_PASSWORD="$ADMIN_PASSWORD" \
    ADMIN_DISPLAY_NAME="Administrator" \
    SEED_DEFAULT_PASSWORD="$SEED_DEFAULT_PASSWORD" \
    SCM_DO_BUILD_DURING_DEPLOYMENT="true"

az staticwebapp create \
  --resource-group "$RESOURCE_GROUP" \
  --name "$STATIC_WEB_APP" \
  --location "$STATIC_WEB_LOCATION" \
  --sku Free

STATIC_WEB_TOKEN="$(az staticwebapp secrets list --resource-group "$RESOURCE_GROUP" --name "$STATIC_WEB_APP" --query properties.apiKey -o tsv)"

printf "\nCreated staging resources.\n"
printf "Backend URL: %s\n" "$BACKEND_URL"
printf "Frontend URL: %s\n" "$STATIC_WEB_URL"
printf "\nNext GitHub values:\n"
printf "Repository variable VITE_API_BASE_URL_STAGING=%s/api\n" "$BACKEND_URL"
printf "Repository secret AZURE_STATIC_WEB_APPS_API_TOKEN_STAGING=%s\n" "$STATIC_WEB_TOKEN"
printf "\nBackend publish profile: download it with this command and paste the XML into GitHub secret AZURE_WEBAPP_PUBLISH_PROFILE_STAGING:\n"
printf "az webapp deployment list-publishing-profiles --resource-group %s --name %s --xml > backend-publish-profile.xml\n" "$RESOURCE_GROUP" "$BACKEND_APP"
printf "\nThen run both GitHub Actions workflows manually once.\n"
