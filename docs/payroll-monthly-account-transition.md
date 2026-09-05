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
  bereits ausgeschlossen waren. Auch ein reguläres leeres Konto ohne Buchungszeile
  und ohne bestätigte Eröffnung hat nach der bestehenden Kontologik den bekannten
  Anfangsbestand **0**. Explizit unbekannte/inkonsistente tatsächliche Historie
  bleibt davon getrennt `null`, auch nach manuellen Bewegungen.
  Der exakt identifizierbare frühere Fehlerfall einer leeren Null-Übernahme aus
  `8c77461` wird beim Lesen als 0 erkannt; seine alten Zeilen, Payloads und bereits
  gespeicherten Excel-Dateien werden nicht verändert.
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
  pro Person/Monat. Neue manuelle Korrekturen (+/−) und Auszahlungen sind auch bei
  persönlicher/globaler Sperre ihres Wirksamkeitsmonats möglich. Sie sind
  eigenständige Kontobuchungen und ändern weder frühere Saldozeilen noch eingefrorene
  Excel-Dateien oder Zeitmeldungen. Bestehende Rollenrechte bleiben unverändert.

Die Excel-Felder „Kontostand alt/neu“ stammen aus dem bei Buchung verfügbaren
aktuellen Bestand, bereinigt um ersetzte Monatsautomatik. Sie sind ausdrücklich
keine Rekonstruktion eines historischen Monatsanfangs. Unbekannte Salden bleiben
leer; Büro- und mobile Kontoansicht zeigen „Kontostand offen“.

## Wochenfreigabe und monteursweiser Monatsablauf

Eine gültige Gesamtfreigabe der Monteurwoche (`reviewed`) deckt alle datierten
Unterprüfpunkte dieser Person/ISO-Woche ab, einschließlich Zeit, Ort, GPS und
Reisekosten/Übernachtung. Monatsstatus und Freigabevalidierung verwenden dieselbe
Prüfpunktliste. Ungeprüfte oder regulär zurückgesetzte Wochen bleiben prüfpflichtig;
Quelldaten, Diagnosehistorie und Exportberechnung werden nicht überschrieben.
Nicht einer Woche zuordenbare technische Export-/Vorlagenfehler bleiben sichtbar.

Die Monatsoberfläche bietet ausschließlich einzelne Monteurfreigaben an.
Monteursliste und Gesamtfortschritt zählen diese Freigaben, nicht Einzelzeilenhaken.
Sobald alle Monteurmonate freigegeben und ihre gespeicherten Exceldateien vorhanden
sind, ist „Alle Monteure“ ohne zusätzlichen Gesamtabschluss verfügbar. Der Download
verpackt nur die unveränderten Einzeldateien: keine Live-Neuberechnung, Kontobuchung
oder globale Sperre. Fehlende/ungültige aktuelle Einzeldateien führen zum Fehler,
nicht zum Rückgriff auf ältere oder ungeprüfte Daten. Historisch global gesperrte
Monate behalten Snapshotdownloads und die bestehende begründete Wiederöffnung.

## Migration und Prüfgrenzen

Migration `20260905_0112` macht absolute Salden und Snapshotbeträge nullable und
ergänzt den aktiven Monatsindex. Sie ändert keine bestehenden Daten. Eine
verlustbehaftete Rückmigration bei vorhandener Monatskontohistorie wird abgewiesen.
Die Migration muss bei einer später separat freigegebenen Auslieferung vor dem
neuen Backend laufen. Sie wurde hier nur in einer isolierten Testdatenbank geprüft.

Folgemigration `20260905_0113` ergänzt ausschließlich eine PostgreSQL-Trigger-
Ausnahme für neue aktive `daily`-Inserts der Typen `manual_adjustment`/`payout`
mit passender Quelle und ohne Payroll-/Wochenreferenz. Diese Inserts verwenden
dieselbe Personenkontosperre. UPDATE/DELETE vorhandener Buchungen und alle
gewöhnlichen Payroll-/Zeitänderungen unterliegen weiter den bisherigen Sperren.
Keine Datenmigration oder Umschreibung bestehender Historie ist damit verbunden.
Die echten PostgreSQL-Fälle (Erlaubnis plus unveränderte Negativfälle) sind als
isolierte Integrationstests hinterlegt; ohne `PAYROLL_POSTGRES_TEST_URL` werden sie
ausdrücklich übersprungen und nicht als ausgeführt gezählt.

SQLite-Integration prüft echte Standard-Excel-Dateien, Einzel-/Gesamtabschluss,
Retry, Reopen/Reapprove, Altbuchungen, beide Monatsreihenfolgen, unbekannte Salden,
Export-Rollback und einen simulierten Schreibschutz historischer Kontoeinträge.
Eine isolierte PostgreSQL-Instanz ist lokal nicht verfügbar; echte PostgreSQL-
Konkurrenz- und Triggerprüfung bleibt eine Grenze. Die vorhandene Safari-Sitzung
zeigt den produktiven Altstand; keine Navigation, Anmeldung, Sitzung oder
Produktivdaten wurden geändert. Responsive Quelltests und Build sind geprüft,
die lokale UI-Änderung wurde nicht als im Live-Browser visuell geprüft behauptet.
