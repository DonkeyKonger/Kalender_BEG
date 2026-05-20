# Zwischenprompt V1: Stammdaten, Admin und Bedienbarkeit

Stand: Nach Umsetzung von Schritt 10 bis 12 aus dem Ursprungsprompt.

Die Grundfunktionen laufen:
- Desktop-Planmatrix
- direkte Zellbearbeitung
- Backend-Konfliktpruefung
- mobile Monteuransicht
- Projektakte light
- PDF-Fallback-Exporte
- Azure-Staging

Der Ursprungsprompt endet in der Umsetzungsreihenfolge bei Schritt 12. Die folgenden Punkte sind daher kein neuer Produktumfang, sondern die notwendige V1-Rundung, damit die App ohne Seed-Datenbank-Tricks im Alltag bedienbar wird.

## Ziel dieses Zwischenabschnitts

Baue die fehlenden Verwaltungsoberflaechen und Backend-Ergaenzungen fuer Version 1.0 so, dass Admin, Projektleiter und Buero die wichtigsten Stammdaten selbst pflegen koennen.

Fokus bleibt weiterhin:

**Wer ist wann auf welcher Baustelle?**

Keine neuen Nebenmodule starten. Keine Dokumente, Fotos, Kommentare, GPS, Stundenfreigabe oder Excel-Importe einbauen.

## Reihenfolge

### 1. Admin-Benutzerverwaltung

V1 braucht eine echte Benutzerverwaltung in der App.

Admin soll koennen:
- Benutzer anzeigen
- Benutzer anlegen
- Anmeldenamen vergeben
- Anzeigenamen vergeben
- Rollen zuweisen
- Person optional zuordnen
- Benutzer aktivieren/deaktivieren
- Passwort setzen
- Passwort zuruecksetzen

Regeln:
- Passwort-Hashing bleibt im Backend.
- Passwoerter werden nie im Klartext gespeichert.
- Nur Admin darf Benutzer verwalten.
- Monteure koennen ihr Passwort in V1 nicht selbst aendern.
- Kein E-Mail-Reset.

### 2. Personenverwaltung

Admin und Projektleiter sollen Personen pflegen koennen.

Funktionen:
- Personen anzeigen
- Person anlegen
- Person bearbeiten
- Person deaktivieren/aktivieren
- interne Mitarbeiter, externe Mitarbeiter und external_temp sauber unterscheiden
- Kuerzel pflegen
- Telefonnummer, E-Mail und Notizen pflegen

Regeln:
- Deaktivierte Personen duerfen nicht eingeplant werden.
- Bestehende Einsaetze bleiben historisch erhalten.
- Keine freie Loeschung, wenn dadurch Historie unklar wird.

### 3. Baustellenverwaltung

Projektleiter und Admin sollen Baustellen sauber verwalten koennen.

Funktionen:
- Baustelle anlegen
- Baustelle bearbeiten
- Projektleiter zuweisen
- Status pflegen: active, paused, closed, archived
- Baustelle schliessen
- Baustelle reaktivieren
- geschlossene/archivierte Baustellen ueber Suche/Archiv sichtbar machen

Regeln:
- Geschlossene/archivierte Baustellen verschwinden aus der Standardmatrix.
- Historie bleibt erhalten.
- Normale Planung auf geschlossene/archivierte Baustellen bleibt backendseitig blockiert.

### 4. Abwesenheitsverwaltung

Admin und Projektleiter sollen Abwesenheiten pflegen koennen. Buero darf lesen/pruefen.

Funktionen:
- Abwesenheiten anzeigen
- Urlaub, Krankheit, Schule, Frei, Sonstiges anlegen
- Abwesenheiten bearbeiten
- Abwesenheiten loeschen oder stornieren, je nachdem was zur bestehenden Datenlogik passt

Regeln:
- Urlaub und Krankheit blockieren Einsatzplanung hart.
- Schule, Frei und Sonstiges erzeugen Warnungen.
- Konfliktlogik bleibt im Backend.
- Matrix zeigt Abwesenheiten weiterhin nur als Planungsinformation.

## Architekturregeln fuer diesen Zwischenabschnitt

- Frontend und Backend bleiben strikt getrennt.
- API-Routen bleiben schlank.
- Fachlogik gehoert in Services.
- Rechtepruefung gehoert ins Backend.
- Validierung und Konfliktpruefung gehoeren ins Backend.
- Keine Geschaeftslogik wild in React-Komponenten verteilen.
- Keine Excel-Datei als Datenquelle.
- Keine neuen Azure-Sonderwege ohne Not.
- Keine Secrets im Code.
- Auditierbare Aenderungen dort ergaenzen, wo Planungs- oder Stammdatenhistorie relevant ist.

## Qualitaet

Vor jedem Teilabschnitt:
- pruefen, welche Backend-Endpunkte bereits existieren
- vorhandene Services wiederverwenden
- kleine, testbare Schritte bauen
- keine grossen Monolith-Komponenten
- UI schlicht, arbeitsnah und nicht marketingartig halten
- nach jedem abgeschlossenen Abschnitt Tests/Linter laufen lassen

## Guter User-Test-Zeitpunkt

Ein sinnvoller Test mit echten Anwendern ist erreicht, wenn mindestens diese Punkte bedienbar sind:
- Admin kann Benutzer und Passwoerter selbst pflegen
- Projektleiter kann Personen, Baustellen und Abwesenheiten pflegen
- Projektleiter kann in der Matrix planen
- Monteur sieht seine eigenen Einsaetze mobil
- Buero kann lesen und PDF-Exporte erzeugen

Dann kann ein kleiner Testkreis mit 1 Admin, 1 Projektleiter, 1 Buero-Nutzer und 2 Monteuren sinnvoll testen.
