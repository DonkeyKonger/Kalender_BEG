# Frontend

React-, TypeScript- und Vite-Grundlage fuer Kalender Baustellen.

## Lokal starten

```bash
cd frontend
cp .env.example .env
npm install
npm run dev
```

Die App erwartet das Backend unter `VITE_API_BASE_URL`, lokal standardmaessig:

```text
http://localhost:8000/api
```

## Enthalten in Schritt 7

- Vite + React + TypeScript
- Routing mit geschuetzten Bereichen
- API-Client fuer Login und aktuelle Userdaten
- Auth-Kontext mit Token-Speicherung im Browser
- rollenabhaengige Navigation
- erste mobile-first App-Huelle
- PWA-Manifest als Grundlage fuer spaetere Monteuransicht
