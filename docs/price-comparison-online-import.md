# Bestehenden Online-Preisstand erhalten

Der Streamlit-Preisviewer speichert einen Teil seines fachlichen Datenstands im
Online-Cache: entfernte Positionen, eingefrorene Vergleichswerte und die zuletzt
eingelesenen DATANORM-Klassifizierungen. Außerdem kann ein Angebot im Cache noch
vorhanden sein, obwohl seine Original-PDF inzwischen fehlt. Erneutes Einlesen der
Quelldateien allein stellt diesen Stand deshalb nicht immer wieder her.

Der Kalender kann dafür zusätzlich zu den unveränderten PDF-/DATANORM-Dateien
einen geprüften JSON-Import unter `Preisvergleich/cache/online_import.json`
verwenden. Es werden keine fremden Pickle-Dateien aus OneDrive eingelesen. Die
vorhandenen Parser und Preisberechnungen bleiben erhalten.

## Aktivierung und Dateiversionen

`calendar_state.json` aktiviert den Import über `online_import`. Das Manifest
enthält Formatversion, Dateiname, SHA-256 des JSON-Inhalts, die Zielversionen der
physischen Dateien und die ausdrücklich übernommenen Quellen ohne Original-PDF.
Die Zielversionen müssen aus dem tatsächlich verwendeten Speicher stammen; die
eTags des alten Preisviewer-Ordners sind keine gültigen Zielversionen.

- Eine unveränderte Datei mit Bindung `snapshot` verwendet die übernommenen
  Positionen bzw. DATANORM-Daten.
- Eine unveränderte Datei mit Bindung `excluded` bleibt in der Dateiverwaltung
  erhalten, gehört aber noch nicht zum übernommenen Online-Vergleich.
- Neue oder geänderte Dateien werden durch die bestehenden Parser eingelesen.
  Der Import darf eine neue Dateiversion nicht verdecken.
- Nur ausdrücklich als virtuelle Quelle übernommene Angebote bleiben ohne
  Originaldatei sichtbar. Das spätere Entfernen einer regulären PDF erzeugt
  keine neue virtuelle Quelle.

Die Preisvergleich-Revision berücksichtigt auch die Importdatei. Fehlende,
veränderte oder ungültige Importdaten führen zu einer nachvollziehbaren
Fehlermeldung; sie werden nicht stillschweigend durch einen abweichenden
Neuaufbau ersetzt.

## Bearbeitung und Wartung

Rabatte, Angebotstypen, manuelle Preise, Referenzartikel und weitere
Positionslöschungen bleiben in `calendar_state.json` bearbeitbar. Ein Angebot
ohne Original-PDF lässt sich weiterhin vergleichen und exportieren. Die
Oberfläche kennzeichnet den fehlenden Originaldownload.

Ein ausdrücklich ausgelöster Angebots-Neuaufbau liest die physischen PDFs neu
ein und setzt deren bisherigen Positionslöschungen wie bisher zurück. Quellen
ohne Original-PDF bleiben erhalten. Die vorhandene Bestätigung für das Löschen
doppelter Angebotsdateien gilt weiterhin. Ein DATANORM-Neueinlesen beendet nur
die Übernahme des bisherigen DATANORM-Frames.

## Prüfung einer Datenübernahme

Vor einer Aktivierung alle Quelldateien und den JSON-Import sichern und ihre
Hashes prüfen. Dateien konfliktfrei übertragen, vollständig zurücklesen und
die unveränderten Bytes bestätigen. Erst danach den an die neuen Dateiversionen
gebundenen Zustand veröffentlichen.

Für den fachlichen Abgleich die vollständigen übernommenen Frames einschließlich
Zeilenfolge, Nullwerten, Zeitstempeln und Klassifizierungen vergleichen. Außerdem
Angebotsquellen, Positionszahlen, eingefrorene Kennzahlen, Einstellungen und
gezielte manuelle Preise prüfen. Ein bloßer Vergleich der Dateianzahl reicht
nicht aus. Produktive Preisdateien und lokale Testkalenderdaten sind getrennt
zu behandeln.
