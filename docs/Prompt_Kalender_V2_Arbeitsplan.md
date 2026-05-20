# Prompt Kalender V2 - Arbeitsplan

Ziel: Die Verwaltungsseiten werden von dauerhaft aufgeklappten Formularlisten auf kompakte Cards/Bubbles mit Detailbearbeitung per Side Drawer umgebaut. Backend, Datenmodell und API bleiben unverändert, sofern kein Bugfix zwingend nötig ist.

## Schritte

1. Frontend-Struktur prüfen - erledigt am 2026-05-20.
2. Allgemeine Card/Bubble-Komponente anlegen - erledigt am 2026-05-20.
3. Detailfenster-Komponente anlegen - erledigt am 2026-05-20.
4. Baustellen-Seite umbauen - erledigt am 2026-05-20.
5. Personen-Seite umbauen - erledigt am 2026-05-20.
6. Benutzer-Seite umbauen - erledigt am 2026-05-20.
7. Abwesenheiten-Seite umbauen.
8. Such- und Filterverhalten erhalten oder verbessern.
9. Listenlayout responsiv verdichten.
10. Planmatrix-UX vorbereiten, ohne Matrix-Architektur umzubauen.
11. Status-/Badge-Darstellung vereinheitlichen - Basis-Komponente vorbereitet am 2026-05-20.
12. Keine Funktionalität verlieren.
13. Leere Zustände, klare Primärbuttons und Drawer-Titel berücksichtigen.
14. Build und Tests prüfen.

## Analyse Schritt 1

- Seiten liegen unter `frontend/src/pages`: `SitesPage.tsx`, `PersonsPage.tsx`, `AdminUsersPage.tsx`, `AbsencesPage.tsx`, `MatrixPage.tsx`.
- Große Eingabe- und Bearbeitungsboxen werden aktuell direkt in den jeweiligen Seiten gerendert.
- Ein zentrales Modal-/Drawer-System existierte vor V2 nicht.
- Wiederverwendbare Formularfelder existieren noch nicht zentral; die Formularlogik bleibt vorerst in den Seiten, damit keine Speicherlogik verloren geht.
- Status-Badges existierten bisher überwiegend als CSS-Klassen. Eine gemeinsame `StatusBadge`-Komponente ist nun vorbereitet.
- Daten werden frontendseitig geladen und nach Speichern lokal aktualisiert; bestehende API-Endpunkte bleiben erhalten.

## Umsetzung Schritt 4

- Die Baustellen-Seite zeigt Datensätze nun als kompakte `EntityCard`-Liste.
- `Neue Baustelle` öffnet einen leeren `EntityDetailDrawer` statt ein dauerhaft sichtbares Formular.
- Klick auf eine Baustellen-Card öffnet den Detail-Drawer mit den bestehenden Feldern und der bestehenden Speicherlogik.
- Archiv-Schalter, Suche, Statuswechsel, Farbe, Projektleiter, Projektakte-Link sowie Schließen/Reaktivieren bleiben erhalten.
- Für Benutzer ohne Bearbeitungsrechte ist der Drawer lesend nutzbar.

## Umsetzung Schritt 5

- Die Personen-Seite zeigt Datensätze nun als kompakte `EntityCard`-Liste.
- `Neue Person` öffnet einen leeren `EntityDetailDrawer` statt ein dauerhaft sichtbares Formular.
- Klick auf eine Personen-Card öffnet den Detail-Drawer mit allen bestehenden Feldern.
- Suche durchsucht Name, Anzeigename, Kürzel, Typ, Kontaktfelder und Aktivstatus.
- Aktiv/Inaktiv ist direkt auf der Card sichtbar; inaktive Personen werden optisch zurückgenommen.
- Bestehende API- und Speicherlogik bleibt erhalten.

## Umsetzung Schritt 6

- Die Benutzer-Seite zeigt Datensätze nun als kompakte `EntityCard`-Liste.
- `Neuer Benutzer` öffnet einen leeren `EntityDetailDrawer` mit Startpasswort-Feld.
- Klick auf eine Benutzer-Card öffnet den Detail-Drawer mit Stammdaten, Rollen, Personen-Zuordnung und Passwort-Reset.
- Passwortfelder sind nicht mehr in der Listenansicht sichtbar.
- Suche durchsucht Anmeldename, Anzeigename, Rolle, zugeordnete Person und Aktivstatus.
- Bestehende API- und Speicherlogik bleibt erhalten.
