# Monatliche Stundenkonto-Fortschreibung

## Verbindliche Betriebsregel

Mehrarbeit wird über den ganzen Kalendermonat gegen das persönliche Vertragssoll
ermittelt. Bei 48 Wochenstunden und 21 Arbeitstagen sind das 201:36 Stunden Soll.
Urlaub und Krankheit bleiben entsprechend der Nutzervorgabe pauschal bei acht
Stunden je vollem Tag. Die bestehende Viertelstundenrundung je Zeitbuchung,
Fahrtzeitbewertung, Feiertagsbehandlung und 4-auf-5-Tage-Verteilung ab 36 Stunden
bleiben erhalten.

Positive Monatsmehrarbeit füllt das Stundenkonto bis 100 Stunden auf. Nur der
verbleibende Teil kommt in das Excel-Feld „Überstunden 25 %“. Diese Stunden werden
mit 25 % Zuschlag vergütet. Der Zuschlag erhöht den Geldbetrag, nicht die Stunden.
Das Programm übermittelt hier die Zeitstunden; es berechnet oder überweist kein
Geld. Negative Monatsdifferenzen belasten das Konto und erzeugen keine Auszahlung.

| Vorbestand | Monatsdifferenz | Kontobuchung | Excel Überstunden 25 % | Endbestand |
| --- | --- | --- | --- | --- |
| 90:00 | +8:09 | +8:09 | 0:00 | 98:09 |
| 97:00 | +8:09 | +3:00 | 5:09 | 100:00 |
| 100:00 | +8:09 | 0:00 | 8:09 | 100:00 |
| 100:00 | −8:09 | −8:09 | 0:00 | 91:51 |

Die Aufteilung erfolgt in ganzen Minuten. Ein bereits vorhandener oder manuell
hergestellter Bestand über 100 Stunden wird nicht still gekürzt. Neue positive
Monatsmehrarbeit wird in diesem Fall vollständig zur Auszahlung ausgewiesen.
Manuelle Entnahmen aus bestehendem Guthaben bleiben eigenständige negative
Kontobuchungen; der direkt ausgezahlte Monatsüberschuss wird nicht nochmals vom
bereits auf 100 Stunden begrenzten Konto abgezogen.

## Vereinfachte Bestandsübernahme im September 2026

Der Nutzer hat ausdrücklich festgelegt, die aktuell geführten Stundenkonten als
korrekt zu übernehmen. Bei Kollisionen mit alten Wochenprüfungen hat die neue
Monatsregel Vorrang. Ein einmalig falscher Übergangsbetrag wird akzeptiert und bei
Bedarf manuell im September korrigiert.

Deshalb werden alte Tages-/Wochenbuchungen weder neu auf Monate aufgeteilt noch
vom neuen Monatsergebnis abgezogen. Auch unvollständige KW-Referenzen und Wochen
über Monatsgrenzen blockieren die Fortschreibung nicht mehr. Alte Ereignisse,
Saldo-Snapshots und gespeicherte Exceldateien bleiben erhalten. Die Übernahme
speichert die enthaltenen Buchungs-IDs und Beträge; Monatsbuchungen nennen diese
Referenzen unter `accepted_legacy_entry_ids`. Es erfolgt keine direkte Löschung
oder Änderung alter Wochenbuchungen.

Vorhandene aktive Monatszeilen mit den bisherigen Klärungsgründen „Altbuchung KW“,
„Alte Wochenbuchung“ oder „Alte Tagesbuchung“ verbergen den übernommenen numerischen
Bestand nicht mehr. Die nächste Monatsbuchung dokumentiert diese übergangenen
Konflikte. Sie bucht deren alte Monatsdifferenz nicht nachträglich. Ein normaler
Monatsabschluss wird genau einmal für seinen eigenen Monat ausgeführt.

Ein reguläres leeres Konto beginnt bei null. Der genaue frühere Fehlerfall der
leeren Null-Übernahme aus `8c77461` wird weiterhin als null gelesen. Tatsächlich
fehlende Vertragsstunden oder ein explizit unbekannter Ausgangsbetrag werden
nicht in eine behauptete Auszahlung umgewandelt: Sie bleiben separat offen.
Das ist von einer bloßen alten Wochenkollision zu unterscheiden.

## Buchung, Export und Rücknahme

Der persönliche Monatsabschluss verwendet einen gemeinsamen Rechenkern für das
rohe Monatsergebnis und den Excel-Stundennachweis. Die Kontoaufteilung wird genau
einmal ausgeführt und als `monthly_100h_v1` mit folgenden Angaben gespeichert:

- `movement_minutes`: volle Monatsdifferenz;
- `booked_minutes`: tatsächlich dem Konto gutgeschriebener/abgezogener Betrag;
- `payout_minutes`: zur Auszahlung bestimmte Zeitstunden, in Minuten;
- `payout_surcharge_percent`: 25;
- Anfangs-/Endbestand, Kontogrenze und Übergangsreferenzen.

Das Excel liest diese gespeicherte Aufteilung. D47 enthält ausschließlich die
Auszahlungsstunden. Im bestehenden Bemerkungsblock stehen Monatsdifferenz,
Kontobuchung und die Kontogrenze. K50/K51 enthalten die für diesen Abschluss
verwendeten Bestände. Im Konto erscheint die Auszahlung nur im Hinweistext der
Monatszeile; der Buchungsbetrag dieser Zeile enthält ausschließlich die
Kontoveränderung. Auch eine vollständig ausgezahlte Mehrarbeit hat damit eine
Monatszeile mit null Kontowirkung und einem nachvollziehbaren Auszahlungshinweis.

Der einmalig übernommene Bestand ist ausdrücklich keine rekonstruierte
historische Monatseröffnung. Nach der Übernahme werden zusätzliche Bewegungen
für einen Monatsabschluss anhand ihres Wirksamkeitsdatums bis zum Monatsende
berücksichtigt. Eine danach erfasste Septemberkorrektur verändert deshalb nicht
die Aufteilung eines wieder geöffneten Augusts. Der aktuelle Kontostand enthält
weiterhin alle gebuchten Bewegungen. Vor der Übernahme schon enthaltene Beträge
werden entsprechend der akzeptierten Übergangsvereinfachung nicht rückwirkend
auseinandergerechnet.

Freigaben erfolgen zeitlich aufsteigend je Monteur. Ein schon später freigegebener
Monat muss vor einer früheren neuen Freigabe oder Wiederöffnung zurückgenommen
werden. Wiederholung derselben Freigabe bucht nicht erneut. Die Rücknahme hängt
die exakte Gegenbuchung der tatsächlichen Kontowirkung an und hebt den zugehörigen
Auszahlungshinweis auf. Sie bucht keine zusätzliche negative Auszahlung. Bei einer
neuen Freigabe entsteht eine neue Excelversion, während die alte erhalten bleibt.

Die bestehende Personenkontosperre und der eindeutige aktive Monatsindex gelten
weiter. Ein Exportfehler nimmt die vollständige Freigabetransaktion einschließlich
Bestandsübernahme und Monatsbuchung zurück. Manuelle Korrekturen und Entnahmen
bleiben auch bei gesperrten Abrechnungsmonaten eigenständige Buchungen; alte
Abrechnungsdateien ändern sich dadurch nicht.

Bereits gespeicherte persönliche oder globale Abschlüsse werden beim Download
nicht neu berechnet. Soll ein vorhandenes August-Excel nach der neuen Regel
ausgegeben werden, wird der betreffende Abschluss einmal begründet wieder geöffnet
und erneut freigegeben. Bei späteren Abschlüssen gilt die umgekehrte Reihenfolge
für das Wiederöffnen. Die neue Septemberabrechnung kann auf dem akzeptierten
Altbestand aufsetzen, ohne alte abgeschlossene Monate automatisch neu zu buchen.

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

## Prüfung und Auslieferung

Die Änderung verwendet die vorhandenen Kontobuchungen und JSON-Payloads. Eine
zusätzliche Datenbankmigration ist dafür nicht erforderlich. Die bereits
vorhandenen Migrationen `20260905_0112` und `20260905_0113` bleiben Voraussetzung
für nullable Salden, eindeutige aktive Monatsbuchungen und unabhängige manuelle
Buchungen unter PostgreSQL-Sperren.

Die automatisierten Tests prüfen Grenzbeträge auf eine Minute genau, negative und
oberhalb der Grenze übernommene Bestände, unbekannte Werte, alte Grenzwochen,
Septemberkorrekturen, Wiederholung und Rücknahme, die echte 48-Stunden-Abrechnung,
Sammeldownload und unveränderte historische Dateien. Der vollständige lokale
Backend-Testlauf und die Frontend-Tests sowie der Frontend-Build wurden ausgeführt.
Die erzeugten Excel-Kontoblöcke für 90, 97 und 100 Stunden Anfangsbestand wurden
gerendert und visuell geprüft. An den Frontend-Komponenten wurden keine Änderungen
vorgenommen.

Die PostgreSQL-Integrationstests benötigen weiterhin eine ausdrücklich isolierte
Datenbank in `PAYROLL_POSTGRES_TEST_URL`; ohne sie werden diese Tests übersprungen.
Es werden keine Produktivdaten durch die Tests geändert. Auslieferung und Push
erfolgen nur nach dem dafür geltenden separaten Nutzerauftrag.
