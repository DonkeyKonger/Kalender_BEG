# Preisvergleich im Baustellenkalender

## Verbindliche Grundlage

- Preisviewer: `DonkeyKonger/BEG-Preisviewer`, `main`, Commit
  `4ed988fdb49a4db355d7c2361dbcf8e272ae563d` vom 13.05.2026.
- GitHub-Stand am 19.11.2026 über GitHub Desktop neu abgerufen und mit der
  lokalen Kopie verglichen; gleiche Dateien wie `codex/performance-cache`.
- Kalender-Ausgangsstand: `5d7edd7`; sauberer Arbeitsbaum, keine Stashes,
  `main` und lokal gespeichertes `origin/main` identisch.
- Nutzerentscheidungen: aktuellster Preisviewer; Ordner `Preisvergleich` direkt
  neben den Projektleiterordnern; Zugriff ausschließlich Admin/Projektleiter.

## Arbeitsplan und Abnahmekriterien

1. [x] Quellen, Versionen, Navigation, Berechtigungen und OneDrive-Wurzel prüfen.
2. [x] Vier Arbeitsbereiche und sämtliche Import-/Exportwege erfassen.
3. [x] PDF-/DATANORM-Parser und Rechenfunktionen mit Herkunftsnachweis übernehmen.
4. [x] Excel-, CSV-, PDF- und PN/UGL-Exporte gegen Original prüfen.
5. [x] Dateiadapter für OneDrive und isolierten lokalen Testbestand ergänzen.
6. [x] Authentifizierte API einschließlich konkurrierender Änderungen prüfen.
7. [x] Native Kalenderoberfläche einschließlich Nettopreisrechner und Dateiverwaltung.
8. [x] Fachliche Gleichheit mit Original und Fehlerfälle prüfen.
9. [x] Frontend-/Backend-Prüfungen, Build, Desktop-/schmale visuelle QA.
10. [x] Nach Git-Prüfung lokal auf main übernehmen; Testkalender neu bauen;
    Healthcheck und ausgelieferte Build-Kennung prüfen. Kein Push/Cloud-Deploy.

## Erhaltungsgrenze

Die PDF-Extraktion, DATANORM-V4-Auswertung, Artikelzuordnung, Preis-/Einheiten-
regeln und Exportformate stammen aus dem Original. Reine Funktionen werden
mit identischem Funktionskörper übernommen, soweit möglich. Streamlit-Zustand,
globale Variablen und `__main__`-Importe werden durch explizite Eingaben ersetzt.
Das eigene Preisviewer-Login wird durch die bestehende Kalender-Anmeldung ersetzt.

Arbeitsbereiche: DATANORM/Angebot (einschließlich gewichteter Referenzartikel,
Presets und Nettopreisvorschläge), Angebotsübersicht/Details, Artikelvergleich,
Dateiverwaltung. Rabatt, Nettoabgleich, manuelle Preise, Angebotsarten und
Historienberechnungen bleiben fachlich erhalten. PN/UGL hat unverändert feste
350-Zeichen-Sätze mit CRLF. Der bisher als Excel bezeichnete CSV-Artikelexport
wird als CSV bezeichnet.

## Ablage und Mehrbenutzerbetrieb

Produktiv: `MS_PROJECT_ROOT_FOLDER_ID/Preisvergleich/{angebote,datanorm,cache}`.
Die Anbindung nutzt die bestehende Graph-Konfiguration. Dateinamen/Pfade aus dem
Browser werden auf den Preisvergleichsordner begrenzt. Der Server gibt keine
Graph-Zugangsdaten aus. Quelldateien bleiben in ihrem ursprünglichen Format.

Die Speicheranbindung ist eine notwendige Anpassung: das Original verteilt
Quellen auf SharePoint und persistenten Zustand auf Azure Blob. Im Kalender
liegt der gesamte dauerhafte Bestand im vorgesehenen OneDrive-Unterordner.
Gemeinsame Einstellungen werden atomar in einem JSON-Dokument gespeichert;
vorhandene Rabatt-/Typ-/Netto-/manuelle Preisdateien können unverändert gelesen
werden. Abgeleitete lokale Caches enthalten ausschließlich serverseitig erzeugte
Daten; hochgeladene Pickle-Dateien werden niemals ausgeführt.

Der lokale Testkalender verwendet eigene dauerhafte Datenträger ohne
Netzwerkzugriff und ohne OneDrive-Zugangsdaten. Der interne Parser-Cache liegt
separat unter `/price-cache` (`price_comparison_cache`), die Quelldateien unter
`/price-data` (`price_comparison_data`). Damit bleibt das aufwendige erste
PDF-Einlesen auch über lokale Neubauten hinweg erhalten. Der Cache ist niemals
ein Unterordner des gemeinsamen OneDrive-Bestands. Vorhandene Kalender-Testdaten
bleiben erhalten. Produktionsdateien werden für Tests nicht verändert.

## Erster Datenbestand

Im vorhandenen Kalender-Stammordner wird `Preisvergleich` verwendet. Darunter:

- `angebote`: unveränderte Angebots-PDFs.
- `datanorm`: unveränderte DATANORM-Dateien mit Endung `.txt` oder `.dat`.
- `cache`: vorhandene `rabatte.json`, `offer_types.json`, `align_netto.json`,
  `manual_prices.json` und optional `tab1_net_price_reference_presets.json`.

Fehlende Ordner werden erst beim ersten Schreibvorgang angelegt. Beim Erststart
wird die zuletzt geänderte DATANORM-Datei verwendet; ein neuer DATANORM-Upload
wird anschließend aktiv. Nach der ersten Änderung enthält `calendar_state.json`
den gemeinsamen Stand. Alte JSON-Dateien bleiben erhalten. Alte Pickle-Caches
müssen nicht übertragen werden und werden nicht geladen.

Änderungen prüfen die vorher geladene Revision und OneDrive-Dateiversionen.
Veraltete Browserstände müssen neu geladen werden. Alle Kalender-Worker teilen
sich für Schreibvorgänge eine Datenbanksperre. Beim Fehlschlag der abschließenden
Einstellungsspeicherung werden betroffene Quelldateien wiederhergestellt.
Die OneDrive-Anbindung prüft Ordnerzugehörigkeit, Dateinamen und Folgeseiten.

Wie vom Nutzer bestätigt, zeigt das Bereinigen gleicher Angebotsnummern vor
jeder Löschung die zu behaltende und zu entfernende Datei. Die bestätigte Liste
muss auch beim Ausführen noch aktuell sein. Dasselbe gilt für ersetzende Uploads.
Administrationsaktionen sind zusätzlich auf Admins beschränkt; Projektleiter
können vergleichen, Preise bearbeiten, Dateien verwalten und exportieren.

## Fachlicher Nachweis

- PDF-Parser bytegleich mit der Quelle; SHA-256:
  `700fd43a366ed4e8b4a6e116c56eae2a147aaec13aa566cf9f6a763ee8b1e139`.
- Alle 162 lokalen PDF-Dateien mit Original und Integration eingelesen:
  vollständig gleiche DataFrames mit zusammen 8.753 Positionen, keine
  Parserfehler oder Abweichungen. Eine PDF liefert in beiden Varianten keine
  Positionen; sie bleibt sichtbar und blockiert andere Dateien nicht.
- Beide DATANORM-Dateien vollständig gleich: 12.050 bzw. 12.263 Artikel.
- Aufbereitung mit vorhandenen Rabatten, Nettoabgleich, manuellen Preisen und
  Angebotsarten, DATANORM-Vergleich, gewichtete Vorschläge, Angebotsmetadaten
  und Prozentberechnung gegen das Original verglichen; beide Kataloge gleich.
- PN/UGL bytegleich einschließlich CP850, fester Satzbreite und CRLF.
  Excel-Werte/Formatierung sowie CSV-Spalten geprüft. PDF-Ausgaben nach Text,
  Seitenzahl und gerenderter Darstellung geprüft.
- Zulässige Original-Rechen-/Exportfunktionen liegen als reine Testreferenzen
  im Repository; kein ursprüngliches Login, keine Zugangsdaten und kein
  Streamlit-Startcode. Die Paritätstests benötigen keine lokale Preisviewer-Kopie.

Die native Oberfläche behält die vier Arbeitsbereiche bei. Tabellen zeigen
kompakte Fachspalten; lange Beschreibungen und Referenzlisten sind begrenzt.
Die Exporte behalten ihre Originalspalten. Artikelverläufe zeigen die neuesten
Angebote links sowie den 24-Monats-Median und dessen Nettoabweichung. Fehlende
Vergleichswerte werden berechnet; Preisänderungen aktualisieren die betroffenen
Angebotskennzahlen entsprechend dem Original.

## Prüfprotokoll und Übergabe

Die lokalen Tests verwenden ausschließlich Kopien bzw. synthetische Dateien.
Eine erfolgreiche lokale Prüfung ist kein Nachweis für eine bereits ausgeführte
Cloud-Bereitstellung oder einen Live-Test gegen OneDrive.

Stand der Abnahme vor lokaler Übernahme (19.11.2026):

- 217 Backendprüfungen bestanden (Originalparität, echte Parser, Exporte,
  Berechtigungen, Revisionen, Ersetzungsbestätigung, Fehlerkompensation,
  Graph-Anbindung und betroffene Kalenderregressionen).
- 1.097 Frontendtests bestanden, einschließlich kontrollierter Gateway-Retries,
  Abbruch und ausbleibender Wiederholung von Schreibvorgängen; ESLint und
  Produktionsbuild erfolgreich.
- 17 Prüfungen des isolierten Testkalenders bestanden.
- Ruff und Git-Whitespace-Prüfung erfolgreich. Die unverändert übernommene
  Parserdatei besitzt eng begrenzte, dokumentierte Lint-Ausnahmen.
- Sichtprüfung bei 1.280, 900 und 390 Pixeln: Tabellen, Suche, Kalkulator,
  Angebotsdetails, Artikelverlauf, Dateiverwaltung und Bereinigungsdialog.
  Tabellen scrollen innerhalb ihrer Ansicht; kein horizontaler Seitenüberlauf.
- Neuaufbau/Löschung zeigt bestätigungspflichtige Dateipaare; Abbrechen verändert
  keine Quelldatei. Zwei eigens erzeugte Testdubletten wurden anschließend aus
  der temporären QA-Kopie entfernt.

Lokale Übernahme am 19.11.2026:

- Implementierung per Cherry-Pick als `3b9f6ae` in die normale lokale `main`
  übernommen; zuvor sauber, `main` gleich `origin/main`, keine Stashes.
- `manage.py rebuild` erfolgreich; vorhandene Testdatenbank weiterverwendet.
- Healthcheck `isolated-local-test`; erste bestätigte Build-Kennung
  `3b9f6ae / ce4f12ba`.
- GitHub Desktop zeigt den lokalen, noch nicht gepushten Kalender-Commit.
- Der neue, zuvor leere Preis-Datenträger wurde ausschließlich für lokale Tests
  mit Kopien der 162 PDFs, zwei DATANORM-Dateien und vier Einstellungsdateien
  befüllt. Originaldateien bleiben unverändert.
- Als abschließende Laufzeitverbesserung wird der abgeleitete Parser-Cache im
  separaten privaten Datenträger erhalten. Das lokale Upload-Limit berücksichtigt
  das API-Batchlimit von 160 MB plus Multipart-Overhead. Der lokale Gateway
  lässt lange Erstimporte/Neuaufbauten bis 30 Minuten laufen. Lesende Ansichten
  wiederholen einen Gateway-Timeout höchstens zweimal; Schreibvorgänge werden
  nicht automatisch wiederholt.

Zusätzlich im tatsächlich gebauten Container geprüft: 161 auswertbare Angebote,
38 Historieneinträge für Referenzartikel 6047611, DATANORM-/Angebots-Excel,
UGL, Artikel-CSV und Artikel-PDF. Der Download der Original-PDF war bytegleich.
Der erste Komplettlauf mit leerem Cache dauerte über fünf Minuten; der folgende
Lauf nutzte die vollständigen 163 Cache-Dateien erfolgreich. Der separate
Datenträger erhält diese Daten über Neubauten hinweg.

Kein Push und kein Cloud-Deploy. Die jeweils aktuelle ausgelieferte Kennung ist
unter `/__local-test__/metadata` kontrollierbar.
