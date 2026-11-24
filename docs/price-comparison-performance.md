# Ladezeiten im Preisvergleich

## Stand 24.11.2026: Sofortsuche und Hintergrundabgleich

Die vom Nutzer freigegebene Sofortsuche hält den vollständigen Artikelindex nur
im Arbeitsspeicher der geöffneten Preisvergleichsseite. Der Index wird über die
bestehende Rollenprüfung für Admins und Projektleiter geladen und nicht in
LocalStorage, IndexedDB oder im Service-Worker gespeichert. Ein Benutzerwechsel
blendet den alten Index bereits im Render aus; beim Verlassen der Seite werden
Requests und Polling beendet. Der erste Download und Aufbau bleiben notwendig.

### Änderungen

- Der Server erzeugt einmal je Datenrevision einen unveränderlichen Suchindex
  aus DATANORM. Eine Suche braucht keine Angebotsaufbereitung und keine Kopie
  des gesamten Preisbestands mehr. Die vorhandene literale Suche über sämtliche
  Spalten, Trefferreihenfolge, Python-Whitespace- und Unicode-Casefold-Regeln
  bleiben erhalten, auch für gespeicherte Online-Klassifizierungen.
- Der Browser filtert beim Tippen direkt. Die bisherige Wartezeit von 250 ms
  entfällt. Ein geöffnetes Artikeldetail wird beim Tippen dank `memo` nicht
  erneut aufgebaut; seine Statistik wird nur bei geänderten Daten/Filtern
  berechnet.
- `GET /price-comparison/article-search-index` liefert kompakte JSON-Zeilen mit
  privatem `no-store` und optionalem Gzip. Mit `known_revision` liefert ein
  unveränderter Stand nur die Revision zurück. Der Browser prüft alle fünf
  Sekunden, solange die Seite sichtbar ist, und sofort nach erfolgreicher
  Preisvergleichsänderung oder Rückkehr zur Seite. Alte Antworten können einen
  neueren Request nicht überschreiben. Fehler kennzeichnen verbliebene Treffer
  ausdrücklich als vorherigen Datenstand und bieten einen neuen Versuch an.
- OneDrive-Leseansichten verwenden einen Snapshot pro Speicheridentität und
  Cacheverzeichnis. Nach 15 Sekunden startet ein Hintergrundabgleich. Während
  eines bereits laufenden Abgleichs darf der vorherige geprüfte Stand höchstens
  weitere 15 Sekunden überbrücken; bei bekanntem Fehler oder überschrittenem
  Zeitlimit wird er nicht weiter ausgegeben. Pro Prozess existiert nur ein
  Hintergrundthread, maximal 32 Speicherkontexte; nach 60 Sekunden ohne Zugriff
  wird nicht weiter regelmäßig abgeglichen.
- Schreiben, Löschen, Uploads und Wartung behalten die unmittelbare frische
  OneDrive-Prüfung, Sperren und Versionskontrollen. Die Lese-Snapshots werden
  vor und nach jeder Mutation ungültig. Eine atomare Markierung im gemeinsamen
  Cacheverzeichnis erreicht auch andere Backend-Worker und verhindert die
  Veröffentlichung älterer laufender Abfragen. Unabhängige Instanzen ohne
  gemeinsames Cacheverzeichnis erkennen Fremdänderungen beim Hintergrundabgleich.
  Lokale Dateispeicher und explizit übergebene Snapshots behalten ihren bisherigen
  Leseweg. Dateiparser, Preisformeln, Schreib-/Exportformate bleiben unverändert.
- Größere Graph-Dateilistenseiten reduzieren den aktuellen Ordnerabgleich von
  sechs auf fünf Reads. Validierte Pagination bleibt für weitere Seiten aktiv.

### Messungen mit dem übernommenen Online-Datenbestand

Ausgangsstand ist `7114279`, Datenumfang: 12.050 DATANORM-Artikel, 228 Angebote
und 12.188 Angebotspositionen. Die echte OneDrive-Verbindung wurde ausschließlich
lesend verwendet; Schreibmethoden waren im Messadapter ausdrücklich gesperrt.
Die folgenden Servicezeiten schließen JSON-Serialisierung ein, aber keine
Netzwerkstrecke zwischen Azure und einem Nutzerbrowser.

| Operation | Vorher | Nachher |
| --- | ---: | ---: |
| Warme Artikelsuche, Nummer | 744 ms | 8 ms |
| Warme Artikelsuche, Text | 665 ms | 5 ms |
| Warme Artikelsuche, Wiederholung | 683 ms | 7 ms |
| Warme Artikelsuche, leer | 861 ms | 2 ms |
| Artikelhistorie, erster Detailaufbau bei warmen Dateien | 706 ms | 218 ms |
| Angebotsübersicht, warme Dateien | 742 ms | 69 ms |

Ein separater Durchlauf mit 48 warmen Artikelhistorien über 21,8 Sekunden
enthält einen echten Hintergrundabgleich (fünf Graph-Reads): p50 9,8 ms,
p95 18,5 ms, Maximum 40,9 ms. Die acht vergleichbaren API-Antworten vor/nach
sind inhaltlich hashgleich, abgesehen vom absichtlich ausgenommenen Revisionsfeld.

Im Produktions-Frontend der lokalen schreibgeschützten Vorschau wurden 38
Suchvorgänge auf dem vollständigen Online-Index gemessen, überwiegend mit
geöffnetem Artikel und 126 historischen Preisen; zusätzlich 390 × 844 und
1600 × 1000 Pixel sowie ein Tabwechsel. Gemessen wurde vom `input`-Ereignis bis
zum zweiten Animation-Frame mit den aktualisierten Treffern:

- p50 24,2 ms, p95 31,7 ms, Maximum 32,2 ms; keine Such-API-Anfrage pro Eingabe.
- Der kompakte Index umfasst 5.779.905 Bytes, mit Gzip Level 1 841.054 Bytes
  (rund 0,8 MiB). Einmaliger Offline-Indexaufbau: rund 196 ms.
- Der erste Serviceaufbau benötigt weiterhin etwa 2,1 Sekunden nach dem
  erstmaligen Statusabruf; ein vollständig kalter Statusabruf etwa 2,4 Sekunden.
  Das Ziel unter 0,5 Sekunden gilt damit für die bereits geladene Suche, nicht
  für App-Start, Erstdownload oder einen neuen Datenimport.

Die Browsermessungen sind lokale UI-Messungen, keine Zusage über Azure,
Mobilgeräte oder beliebige Netzwerkverbindungen. Die Änderung muss für eine
Produktionsmessung erst ausdrücklich freigegeben und deployt werden.

### Parität und Regressionen

783 Suchbegriffe aus echten sichtbaren und versteckten Spalten, Nummern,
Unicode, Whitespace und Literalzeichen wurden jeweils mit Limits 1, 50 und 500
verglichen. Alle 2.349 Ergebnisse stimmen sowohl im neuen Pythonindex als auch
in der echten JavaScript-Suchfunktion exakt mit der bisherigen Suche überein.
DATANORM, Rohpreise, aufbereitete Preise, Snapshot und Angebotsquellen sind vor
und nach der Änderung vollständig gleich, einschließlich Datentypen und Reihenfolge.

Automatisierte Tests decken Singleflight, Cachegrenzen, workerübergreifende
Invalidierung, Mutation während laufender Abfrage, Hintergrundfehler, Zeitlimits,
Marker-I/O-Fehler mit wartenden Requests und anschließende Wiederherstellung ab.
Frontend-Verhaltenstests prüfen Sessionwechsel, Sichtbarkeit, Abbruch, verspätete
Antworten, Revisionen, Mutation und Retry.

### Verifikation des zweiten Optimierungsschritts

- Vollständige Linux-Backend-Suite: 2.754 bestanden, 16 optionale Tests ohne
  zusätzliche PostgreSQL-Testdatenbank übersprungen.
- Vollständige Frontend-Suite: 1.134 bestanden; TypeScript-/Produktionsbuild grün.
- Backend-Ruff und ESLint aller geänderten Frontenddateien grün. Der globale
  Frontend-Lint meldet weiterhin sechs bereits vorhandene Fehler in unveränderten
  Dateien außerhalb dieser Änderung.
- Browserprüfung mit vollständigem Online-Index auf Desktop und Mobilansicht,
  mit 126 historischen Preisen, leeren Treffern, Umlauten und Tabwechsel.

## Historischer Stand 23.11.2026

Die folgenden Messungen und Aktualitätsregeln dokumentieren den ersten
Optimierungsschritt. Für den aktuellen Stand gelten die Regeln oben.

Die Optimierung vom 23.11.2026 reduziert wiederholte OneDrive-Abfragen und
Berechnungen beim Öffnen, Filtern und Blättern. Parser, Preisformeln,
Importdaten, Originaldateien und Exportformate bleiben unverändert.

### Erkannte Engpässe und Änderungen

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

### Aktualität und Grenzen

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

### Messverfahren

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

### Verifikation

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
