# Umsetzung der technischen Prüfung der Lohnprüfung

Ausgangspunkt: Analyse vom 7. September 2026; Umsetzung auf dem lokalen Stand
`6065c59` einschließlich der anschließend gewünschten UI- und Einzelprüfungsanpassungen.

## Änderungen und fachliche Grenzen

| Befund | Umsetzung |
| --- | --- |
| F1 – veraltete Wochenprüfung | Gemeinsame Invalidierung für lohnrelevante Zeit-, Tages- und Abwesenheitsänderungen. Bei Personen- und Datumswechseln werden beide Seiten berücksichtigt. Änderungen an Quelldaten nehmen auch die Einzelprüfung des betroffenen Tages zurück; eine ausdrückliche Einzelprüfung bleibt erhalten und setzt nur den übergeordneten Wochenstatus zurück. |
| F2 – ausgeschiedene Monteure | Monatsumfang aus aktuellen berechtigten Personen, gespeicherten Personenfreigaben und tatsächlichen Zeitraumdaten interner Personen. Gespeicherte Freigaben bleiben nach Archivierung oder Rollenänderung erreichbar. Abgeschlossene Gesamtmonate verwenden ihren Snapshotbestand; freigegebene Einzeldateien und gespeicherte Namen bleiben maßgeblich. |
| F3 – verspätete Antworten | Wochenwerte und Aktionen sind erst bereit, wenn Einträge, Abwesenheiten, Summen, Reviews und Monatssperren zum ausgewählten Zeitraum gehören. Antworten auf Änderungen werden anhand ihres ursprünglichen Kontexts übernommen. |
| F4 – veraltete Monatshinweise | Erfolgreiche Änderungen aktualisieren betroffene Monatsstände. Bei einer Verschiebung werden Ausgangs- und Zielzeitraum berücksichtigt. Eine abgewiesene Abschlussbestätigung lädt die Hinweise erneut und verlangt eine neue Bestätigung. |
| F5 – Abwesenheitsfehler | Fehlgeschlagene Abwesenheitsabfragen gelten nicht mehr als erfolgreicher Leerbestand. Die Ansicht zeigt einen Fehler mit Wiederholung; abhängige Aktionen bleiben bis zu einer vollständigen Datengrundlage gesperrt. |
| F6 – Bestätigung konkreter Hinweise | Der Server liefert einen stabilen SHA-256-Fingerprint der fachlichen Hinweisfelder. Der Abschluss verlangt Anzahl und Fingerprint und vergleicht beides erneut unter den vorhandenen Transaktionssperren. |
| F7 – Download-Anmeldung | JSON und Binärdownloads teilen einen kontrollierten Token-Refresh mit genau einem erneuten Versuch. Gleichzeitige Anfragen teilen die Erneuerung. Abbruch, Abmeldung und Wechsel auf eine andere Anmeldung verhindern eine unpassende Wiederholung. |
| F8 – GPS im Wochenexport | Ein vorhandener GPS-Batch-Aufruf ersetzt die Auswertung pro Zeiteintrag. Vergleichstests prüfen sämtliche Workbook-Inhalte gegen das bisherige Ergebnis. |
| F9 – Statusabfragen | Monatsstatus verwendet Metadaten der aktuellen Artefakte und gebündelte Folgefreigaben, ohne historische Excel-Binärinhalte zu laden. |
| F10 – wiederholte Monatsgrundlagen | Innerhalb der Abschlusstransaktion werden identische Quellgrundlagen wiederverwendet. Der nach dem Commit zurückgegebene Gesamtstatus wird weiterhin frisch ermittelt. |
| F11 – zusätzliche N+1-Abfragen | Sperrprüfung liest die höchstens zwei Monate einer Woche gebündelt unter den bisherigen Sperren. Der Paketbau lädt zugehörige Buchungen und Abschlussnachweise gesammelt. |
| F12 – Review-Nachladen | Jahresreviews werden während der Sitzung gezielt wiederverwendet, konkurrierende Ladevorgänge zusammengeführt und nach Änderungen invalidiert. Eine manuelle Monatsanlage lädt keine sachfremde Wochensumme. |
| F13 – verwaistes Frontend | Unbenutzter Einrichtungsdialog einschließlich exklusiver API-/Typ-/Style-Helfer und der alte Baustellenverlauf entfernt. Aktive Arbeitszeit-, Portfolio- und Formatierhilfen bleiben bestehen. |

Zusätzlich verwendet die Stundenkontoanzeige ihren bereits geladenen historischen
Lesebestand für Saldo und Hinweise. Veränderliche Monatsabfragen und unversionierte
Exporte erhalten explizite Cache-Regeln. Explizite Exportversionen verlangen einen
passenden gesperrten Snapshot; ein alter Link darf keine aktuelle Live- oder
Personenfreigabedatei unter einer anderen Version liefern.

Die Invalidierung verändert Prüfstände, keine historischen Kontobuchungen. Eine
Woche mit abgeschlossenem Augusttag und offenen Septembertagen bleibt pro Datum
und Person geschützt. Versionierte Excel-Dateien werden weiter aus gespeicherten
Artefakten gelesen und ihre vorhandenen Inhaltsprüfsummen geprüft.

## Bewusst getrennte Folgethemen

Die Analyse kennzeichnet mehrere Ideen ausdrücklich als bedingt oder später zu
bewerten. Diese Umsetzung entfernt keine alten Backend-Schreibwege ohne vorherige
Inventur externer Wartungsskripte und ändert keine Person-Fremdschlüssel per
Datenmigration. Historische Ledgerdaten, Gegenbuchungen und Lesepfade bleiben
erhalten. Ebenso erfolgt kein pauschaler Komponentenumbau, keine Virtualisierung
und kein Einführen zusätzlicher Infrastruktur oder Datenbankindizes.

Ein gemeinsamer GPS-Kontext über mehrere unterschiedliche Auswertungen und ein
bedarfsgesteuertes Laden der Baustellenstammdaten bleiben separate Optimierungen;
die gezielt nachgewiesenen Exportabfragen sind bereits gebündelt.

## Validierung

- Vollständige Backend-Suite im zusammengeführten Stand: **1.383 bestanden**.
  Nach der letzten eng begrenzten Korrektur versionierter Legacy-Exporte bestehen
  zusätzlich alle **19 Export-/Integritätstests**, darunter zwei neue Fälle.
- **14 PostgreSQL-Tests bestanden** auf einer separaten, vollständig migrierten
  PostgreSQL-16-Testdatenbank. Enthalten sind echte Transaktionssperren und Trigger,
  die gemischte August-/Septemberwoche sowie ein vollständiger Personenabschluss
  mit echter Excel-Erzeugung, Archivierung, Namensänderung und Wiederöffnung unter
  Erhalt der Originalbuchung und ihrer Gegenbuchung.
- Ruff für das gesamte Backend erfolgreich. Ein unabhängiges Review prüfte
  insbesondere Anmeldungswechsel, Monatsbestand, gespeicherte Artefakte und
  Versionslinks.
- Isolierte SQL-Vergleiche: Monatsstatus **13 / 13 Abfragen** bei einer bzw.
  20 Personenfreigaben, ohne Excel-Binärinhalt; Paketgrundlagen **9 / 9 Abfragen**.
  Das sind Abfragezählungen, keine Messungen der Produktionslatenz.

In der allgemeinen Backend-Suite sind die 14 separat ausgeführten PostgreSQL-
Tests und ein unabhängiger, hier nicht benötigter Extra-Work-Parallelitätstest
ohne dessen spezielle Test-URL übersprungen.

- **613 Frontend-Tests bestanden** im endgültig zusammengeführten Stand; keine
  übersprungen. TypeScript mit erzwungenem Neuaufbau, Vite-Produktionsbuild und
  ESLint für die geänderten Frontendmodule erfolgreich.
- Unabhängige Browserprüfung am Integrations-Produktionsbuild mit vollständig
  simulierten API-Antworten: verzögerter KW-Wechsel, Abwesenheitsfehler und
  Wiederholung, Monteurwechsel während einer Tagesprüfung, anschließender
  Monatsstatus-GET, geänderter Fingerprint bei gleicher Hinweiszahl sowie erneute
  Bestätigung. Ein reiner Tabwechsel verwendet Jahresreviews erneut; nach
  Änderungen wird genau das betroffene Jahr neu geladen.
- Visuelle QA und Layoutmessung bei **1.680, 1.280 und 390 px**: kein horizontaler
  Seitenüberlauf, Bemerkungs- und Excel-Button jeweils **180 px** breit,
  Monatsbereichs-Tabs, Jahresauswahl und beide Aktionsbuttons rechts bündig.

Tests verwenden isolierte Datenbanken beziehungsweise simulierte API-Antworten;
keine Testabschlüsse werden im lokalen Nutzerdatenbestand angelegt.
