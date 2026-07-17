# Performanceprüfung: Werkzeuge und Material

Stand: 17.07.2026

## Messaufbau

Die Vergleichsmessung verwendet 3.000 synthetische Werkzeugdatensätze in einer lokalen
SQLite-Datenbank. Gemessen wurden der Service-Aufruf und die Pydantic-Serialisierung ohne
Netzwerklatenz und Browser-Paint. Die Werte dienen als reproduzierbarer Vergleich des alten
und neuen Datenwegs, nicht als Produktions-SLA.

| Messwert | Vorher | Nachher |
| --- | ---: | ---: |
| Initial geladene Tabellenzeilen | 3.000 | 100 |
| SQL-Abfragen für die Tabellenliste | 7 | 3 |
| Backend-Abfrage | 70,3 ms | 18,8 ms |
| Serialisierung | 22,8 ms | 0,7 ms |
| JSON-Größe der Einträge | 1.315,9 KiB | 43,9 KiB |
| Maximale komplexe DOM-Zeilen | 3.000 | 100 |
| Werkzeug-spezifische Initialrequests | Liste + alle Filterwerte | eine Listenseite |
| Status-Filterwerte | Teil eines 272,4-ms-Gesamtabrufs | 0,3 ms bei Bedarf |

Die technische Zeit bis zu Daten für die erste sichtbare Zeile sinkt im lokalen Messaufbau
damit von rund 93,1 ms auf rund 19,5 ms. Netzwerk, React-Commit und Browser-Paint sind nicht
Bestandteil dieser Service-Messung; die übertragene und zu rendernde Datenmenge ist jedoch
deterministisch auf höchstens 100 Tabellenzeilen begrenzt.

Ein zusätzlicher Lauf mit 5.000 Datensätzen lieferte die erste 100er-Seite lokal in 43,3 ms.

## Erkannte Hauptursachen

- Die API lieferte immer die vollständige Trefferliste.
- React erzeugte für jeden geladenen Eintrag sofort einen Formular-Draft.
- Die Tabelle renderte alle Treffer gleichzeitig in den DOM.
- Filteroptionen sämtlicher Spalten wurden beim Seitenstart vollständig geladen.
- Speichern und Statuswechsel luden erneut die vollständige Trefferliste.
- `selectinload` musste offene Meldungen für alle 3.000 Werkzeug-IDs in mehreren Batches laden.

Es gab keine N+1-Abfrage pro Tabellenzeile: Mitarbeiter wurden bereits per Join und Meldungen
gebündelt geladen. Das Problem war die unbeschränkte Ergebnismenge.

## Umgesetzter Datenweg

- Serverseitige Pagination mit 100 Einträgen pro Seite und separater Gesamtanzahl.
- Suche, Spaltenfilter und manuelle Sortierung bleiben serverseitig.
- Die bestehende natürliche Standardsortierung wird stabil vor der Seitenauswahl angewendet.
- Maximal 100 Werkzeugdatensätze einschließlich Mitarbeiter und offener Meldungen werden geladen.
- Filterwerte werden erst beim Öffnen des jeweiligen Spaltenfilters und nur für diese Spalte geladen.
- Das Suchfeld ist mit 300 ms entprellt.
- Identische laufende Seitenrequests werden dedupliziert; verspätete Antworten verworfen.
- Geladene Seiten werden 30 Sekunden wiederverwendet und nach Mutationen invalidiert.
- Der Bearbeitungs-Drawer lädt den vollständigen Datensatz gezielt über die Werkzeug-ID.
- Nach Mutationen wird nur die aktuelle Seite neu geladen; es werden nicht mehr alle Treffer geladen.
- Pagination begrenzt den DOM auf 100 Zeilen, daher ist keine zusätzliche Tabellenvirtualisierung nötig.

## Indexprüfung

Bereits vorhanden sind Indizes für BEG-Nummer, Fabrikat, Bezeichnung, Typ, Geräte- und
Seriennummer, Mitarbeiter-ID, Lieferant, Rechnungsnummer, Status und Kategorie. Offene
Meldungen besitzen unter anderem einen kombinierten Index auf Werkzeug-ID und Status.

Ergänzt wurde ausschließlich der bisher fehlende Index auf `item_date`, weil dieses Feld
direkt gefiltert und sortiert wird. Werkzeugdatensätze besitzen aktuell kein Soft-Delete- oder
Aktiv-Feld, daher wurde dafür kein künstlicher Index angelegt. Die globale Suche verwendet
bewusst Teilstrings (`%suchbegriff%`); normale B-Tree-Indizes beschleunigen diese Suche nicht.
Bei deutlich größeren Datenmengen als dem geplanten Bereich wäre ein PostgreSQL-Trigrammindex
eine gesondert zu messende Ausbaustufe.

## Automatisierte Absicherung

Der 3.000er-Test prüft Seitengröße, Gesamtzahl, konstante Abfrageanzahl, Payload-Grenze,
Seitenüberschneidungen, Suche, Statusfilter und Sortierung. Weitere Tests prüfen Detailabruf,
spaltenweises Laden der Filterwerte, Berechtigungen, Debounce, Request-Deduplizierung,
Cacheverhalten und die kompakte Seitennavigation.
