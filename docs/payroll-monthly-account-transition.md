# Monatliche Stundenkonto-Fortschreibung

Die normale Lohnprüfung benötigt keine bestätigten Tagespläne und keine
Eröffnung zum 31.07.2026 mehr. Bestehende Pläne, Eröffnungen und Buchungen bleiben
erhalten. Wochenprüfung, Wochen-Reset, Deadline-Prüfung und das Rücksetzen nach
einer Eintragslöschung verändern das Konto nicht.

## Betrag und Zeitpunkt

Der persönliche Monatsabschluss bucht die Differenz des normalen Excel-Blatts.
Excel und Kontobuchung verwenden denselben Rechenkern. Die bestehende Rundung,
4-auf-5-Tage-Verteilung ab einschließlich 36 Stunden, Abwesenheits- und
Reisekostenregeln bleiben unverändert. Fehlende Vertragswochenstunden ergeben
eine unbekannte Differenz, nicht null Stunden.

Der Gesamtabschluss verwendet die bereits gespeicherten persönlichen
Abschlussdateien. Er bucht nicht erneut. Das kombinierte Workbook kopiert ihre
Worksheet-XML unverändert; inkompatible alte/raw Workbooks werden mit einem
Konflikt abgewiesen, nicht still umgebaut. Standardexportfehler nehmen die ganze
persönliche Abschluss-Transaktion zurück.

## Übergang und Rücknahme

- Beim ersten Monatsabschluss oder der ersten neuen manuellen Buchung wird der
  dann tatsächlich geführte Bestand übernommen. Das ist keine rückdatierte
  Eröffnung. Die Übernahme speichert Zeitpunkt, alte Eröffnungsreferenz und die
  exakten darin enthaltenen aktiven Buchungs-IDs und Werte.
- Bestätigte alte Eröffnungen bestimmen weiterhin, ob Legacy-Wochenbuchungen
  bereits ausgeschlossen waren. Ein belegter Nullsaldo bleibt bekannt; fehlender
  Anfangsbestand bleibt `null`, auch nach manuellen Bewegungen.
- Eindeutige enthaltene Tagesautomatik bzw. vollständig innerhalb des Monats
  liegende Legacy-Wochenautomatik wird vom neuen Monatsbetrag abgezogen. Beispiel:
  akzeptierter Bestand 100 h enthält schon 5 h Automatik, Excel ergibt 8 h:
  tatsächlich zusätzlich gebucht werden 3 h. Manuelle Beträge werden nie als
  Automatik verrechnet. Monatsergebnis, Altreferenzen und Nettobuchung stehen
  getrennt im Buchungspayload und Ereignistext.
- Legacy-Grenzwochen ohne belastbare Aufteilung werden nicht nach Erstellungsdatum
  oder Tagesanteilen verteilt. Die Monatsdifferenz wird als offener Fall erfasst;
  bis zur fachlichen Klärung gibt es keine Nettobuchung und keinen behaupteten
  absoluten Saldo. Abschluss und Standard-Excel bleiben verfügbar.
- Rücknahme setzt die aktive Monatsversion außer Kraft und hängt die exakt
  entgegengesetzte Nettobuchung an. Alte Beträge/Saldo-Snapshots bleiben erhalten.
  Spätere persönliche oder globale Abschlüsse müssen vor früheren geöffnet
  werden. Historische persönliche Abschlüsse ohne neue Monatsbuchung nutzen nur
  ihre bestehende Tages-Rücknahmereferenz; der Gesamtabschluss erfindet keine neue.
- Personensperre serialisiert Bestandsübernahme, Monats- und manuelle Buchungen.
  Eindeutige Referenzen plus Datenbankindex erlauben nur eine aktive Monatsbuchung
  pro Person/Monat. Manuelle Nachbuchungen ändern keine früheren Saldozeilen.

Die Excel-Felder „Kontostand alt/neu“ stammen aus dem bei Buchung verfügbaren
aktuellen Bestand, bereinigt um ersetzte Monatsautomatik. Sie sind ausdrücklich
keine Rekonstruktion eines historischen Monatsanfangs. Unbekannte Salden bleiben
leer; Büro- und mobile Kontoansicht zeigen „Kontostand offen“.

## Migration und Prüfgrenzen

Migration `20260905_0112` macht absolute Salden und Snapshotbeträge nullable und
ergänzt den aktiven Monatsindex. Sie ändert keine bestehenden Daten. Eine
verlustbehaftete Rückmigration bei vorhandener Monatskontohistorie wird abgewiesen.
Die Migration muss bei einer später separat freigegebenen Auslieferung vor dem
neuen Backend laufen. Sie wurde hier nur in einer isolierten Testdatenbank geprüft.

SQLite-Integration prüft echte Standard-Excel-Dateien, Einzel-/Gesamtabschluss,
Retry, Reopen/Reapprove, Altbuchungen, beide Monatsreihenfolgen, unbekannte Salden,
Export-Rollback und einen simulierten Schreibschutz historischer Kontoeinträge.
Eine isolierte PostgreSQL-Instanz ist lokal nicht verfügbar; echte PostgreSQL-
Konkurrenz- und Triggerprüfung bleibt eine Grenze. Die vorhandene Safari-Sitzung
zeigt den produktiven Altstand; keine Navigation, Anmeldung, Sitzung oder
Produktivdaten wurden geändert. Responsive Quelltests und Build sind geprüft,
die lokale UI-Änderung wurde nicht als im Live-Browser visuell geprüft behauptet.
