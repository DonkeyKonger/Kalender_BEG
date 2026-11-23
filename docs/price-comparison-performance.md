# Ladezeiten im Preisvergleich

Die Optimierung vom 23.11.2026 reduziert wiederholte OneDrive-Abfragen und
Berechnungen beim Öffnen, Filtern und Blättern. Parser, Preisformeln,
Importdaten, Originaldateien und Exportformate bleiben unverändert.

## Erkannte Engpässe und Änderungen

- Ein bereits geladener Preisvergleich benötigte pro API-Anfrage 15 Graph-Reads:
  zehn Dateilisten, vier Metadatenabfragen und einen Download der Einstellungen.
  Der gemeinsame Ordnerpfad wird jetzt einmal pro Snapshot aufgelöst. Die drei
  unabhängigen Unterordner werden parallel gelesen; Folgeseiten bleiben vollständig
  validiert. Unveränderte Einstellungsbytes werden anhand ihrer Dateiversion
  wiederverwendet. Dadurch bleiben beim vorhandenen Bestand sechs aktuelle
  Dateilisten-Abfragen pro warmem Request.
- Preise und abgeleitete Tabellen wurden für jede Ansicht erneut aufgebaut.
  Ein pro Prozess begrenzter Cache verwendet jetzt die frisch ermittelte Revision,
  Speicheridentität, Graph-Konfiguration und Operationsparameter als Schlüssel.
  Gleichzeitige Anfragen berechnen dasselbe Ergebnis nur einmal. Bei der
  Angebotsübersicht ersetzt eine Gruppierung 228 wiederholte Vollscans.
- Speichern sendete auch unveränderte Angebotsfelder und löste damit unnötige
  globale Kennzahlenberechnungen aus. Das Frontend sendet nur geänderte Felder;
  Detail- und Listenaktualisierung laufen anschließend parallel. Presetaktionen
  laden nur Presets neu, Dateiaktionen verwenden ihre aktuelle Dateiliste für
  die Kopfzeile. Direkte Artikelaufrufe vermeiden eine zusätzliche leere Suche.
- Zahlen- und Datumsformatierer werden wiederverwendet. Überholte Leseanfragen
  werden abgebrochen. Bereits geladene Daten bleiben beim Nachladen sichtbar;
  betroffene Änderungen sind währenddessen gesperrt.

## Aktualität und Grenzen

Es gibt keinen zeitbasierten Cache für OneDrive-Snapshots: Jeder Request prüft
weiterhin die aktuellen Dateien und Versionen. Externe Änderungen werden beim
nächsten Request erkannt. Schreibaktionen behalten die vorhandenen Sperren,
Versionsprüfung und bedingten Graph-Schreibzugriffe. Explizite, im Speicher
veränderte Snapshots sowie erzwungenes Neueinlesen umgehen den Berechnungscache.

Cachewerte werden als unabhängige Kopien ausgegeben. Der Berechnungscache ist
auf 64 Einträge und geschätzt 128 MiB pro Backend-Prozess begrenzt, der
Einstellungsbytecache auf 16 Einträge und 8 MiB. Historische Zeitfenster erhalten
zusätzlich einen Tagesschlüssel. Ein Neustart oder eine neue Revision benötigt
weiterhin einen ersten Aufbau; Cloud-Latenz und große Erstimporte bleiben
Bestandteile der Ladezeit.

## Messverfahren

Verglichen wird mit dem unveränderten Ausgangsstand `6aa06e1` und dem übernommenen
Online-Datenbestand: 233 PDFs, eine DATANORM-Datei, 228 aktive Angebote,
12.188 Angebotszeilen und 12.050 DATANORM-Zeilen. Jede Messung erzeugt neue
requestbezogene Storage- und Service-Instanzen. Die Pagination umfasst zwei
Angebots-Dateilistenseiten.

Der lokale Vergleich verwendet dieselben geprüften Online-Bytes und Dateiversionen
über einen ausschließlich lesenden Graph-Ersatz. Fünf Wiederholungen je Operation
trennen Rechenzeit von einem kontrollierten Netzwerkanteil. Zusätzlich wird der
echte OneDrive-Speicher ausschließlich lesend gemessen. Diese Servicelaufzeiten
sind keine Messung der vollständigen Browserladezeit auf Azure.

| Warme Ansicht | Rechenzeit vorher, Median | Rechenzeit nachher, Median |
| --- | ---: | ---: |
| Angebotsübersicht | 195,0 ms | 11,2 ms |
| Angebotsdetail | 230,2 ms | 9,4 ms |
| DATANORM | 122,3 ms | 14,1 ms |
| Artikelsuche | 71,1 ms | 42,7 ms |

Ein zusätzlicher Vergleich über den echten OneDrive-Speicher ergab folgende
Servicelaufzeiten. Es handelt sich um einzelne Vergleichsmessungen vom lokalen
Rechner; schwankende Netzwerklatenz und der erste Cacheaufbau beeinflussen sie.

| Operation | Vorher | Nachher | Graph-Abfragen vorher → nachher |
| --- | ---: | ---: | ---: |
| Status, erster Aufruf | 3.182 ms | 2.349 ms | 15 → 11 |
| Angebotsübersicht, erster Aufbau | 3.732 ms | 2.556 ms | 18 → 11 |
| Angebotsübersicht, bereits geladen | 2.449 ms | 707 ms | 15 → 6 |
| DATANORM, bereits geladen | 2.273 ms | 827 ms | 15 → 6 |

Alle verglichenen Antwort-Hashes stimmen vor und nach der Änderung überein.
Auch vollständige Rohpreise, aufbereitete Preise und DATANORM einschließlich
Spalten, Datentypen und Zeilenreihenfolge sowie alle 228 Angebotszusammenfassungen
sind hashgleich. Die Prüfung umfasst Einstellungen, eingefrorene Kennzahlen,
die 353 gespeicherten Klassifizierungen und die Quelle ohne Original-PDF.
Automatisierte Regressionstests decken Cache-Isolation, parallele Aufrufe,
Speichergrenzen, Versionswechsel, Tageswechsel, defensive Kopien und den
Mutations-Bypass ab.

## Verifikation

- Vollständige Linux-Backend-Suite: 2.673 bestanden; 16 optionale
  PostgreSQL-Integrationstests ohne zusätzliche Testdatenbank übersprungen.
- Preisvergleich-Suite: 131 bestanden.
- Vollständige Frontend-Suite: 1.097 bestanden.
- Frontend-Produktion und vollständiges Docker-Anwendungsimage erfolgreich gebaut.
- Visuelle Prüfung aller Preisvergleichsansichten auf Desktop und bei 390 × 844
  Pixeln: Tabellen, Suche, Blättern, Angebotsdetail, direkter Artikelaufruf und
  Dateien funktionieren; keine Browser-Konsolenfehler.
- Backend-Ruff und ESLint der geänderten Frontenddatei ohne Befund. Der globale
  Frontend-Lint enthält weiterhin sechs vorhandene Fehler außerhalb dieser Änderung.

Die Messung greift auf OneDrive ausschließlich lesend zu. Es werden keine
Originaldateien, Preise oder Cloud-Einstellungen für den Test verändert.
