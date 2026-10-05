# Lagerzugang und Werkzeugausgabe

Im Adminbereich unter **Benutzer → Neuer Benutzer → Rolle: Lager** anlegen.
Anmeldename, Anzeigename und Passwort werden vom Admin vergeben. Es wird keine
Person zugeordnet; das Formular blendet die Auswahl aus und die API weist
explizite Personenverknüpfungen zurück. Auch die Datenbank verhindert solche
Verknüpfungen.

Das Admin-Passwort ist direkt verwendbar. Weder bei der ersten Anmeldung noch
nach einer Passwortzurücksetzung durch den Admin ist ein Pflichtwechsel nötig.
Die Regel gilt nur für Lager. Beim Wechsel von Lager zu einer anderen Rolle wird
der Pflichtwechsel wieder gesetzt. Beim Wechsel zu Lager werden die bisherige
Personenverknüpfung und Büro-Seitenberechtigungen entfernt, nicht die Person.

Lagerkonten öffnen `/warehouse`, einen separaten Bereich außerhalb der normalen
Kalendernavigation. Die Tablet-Oberfläche bietet Ausgabe und Rückgabe.
Bestehende Kalender-, Büro- und Monteur-APIs bleiben für Lager gesperrt.
Anmeldung, Sitzungserneuerung, Deaktivierung und Abmeldung verwenden die
bestehende Authentifizierung. Es wird kein Standardkonto und kein Passwort
automatisch angelegt.

Die Migration `20260930_0125` ergänzt `warehouse` im PostgreSQL-Enum `user_role`
und den Constraint `ck_warehouse_user_without_person`. Vor dem Start der neuen
Backend-Version `alembic upgrade head` ausführen (wie im bestehenden Deployment).
Ein Downgrade entfernt nur den Constraint; vorhandene Lagerkonten und der Enumwert
bleiben erhalten. Eine ältere App-Version kennt diese Konten nicht – ein
Versionsrollback muss deshalb vorher gesondert vorbereitet werden.

Geprüft: Kontoanlage, echter Login/Refresh, Passwortreset, Rollenwechsel,
Personenverknüpfungsschutz, Deaktivierung und Zugriffssperre über sämtliche
bisherigen Business-/Monteur-Routen. Visuelle QA erfolgte mit flüchtigen
Testkonten, darunter Tablets in 1024×768 und 768×1024.

## Werkzeugausgabe / Rückgabe

1. Auf dem Startbildschirm **Werkzeug abholen** oder **Werkzeug zurückgeben** wählen.
2. Monteur über Name oder Kürzel auswählen. Für Ausgaben stehen ausschließlich
   aktive interne Monteure aus den vorhandenen Stammdaten zur Verfügung (kein
   eigenes Benutzerkonto erforderlich). Externe einschließlich Aushilfen sowie
   Personen mit Büro-, Projektleiter- oder Admin-Zuordnung sind ausgeschlossen,
   auch wenn deren Benutzerkonto deaktiviert ist. Als Projektleiter einer
   Baustelle hinterlegte Personen ohne Benutzerkonto werden ebenfalls ausgeschlossen.
   Die Regel wird bei Auswahl und Buchung serverseitig geprüft. Rückgaben sind
   weiterhin für alle Personen mit noch zugeordneten Werkzeugen möglich, auch
   für externe, ausgeschiedene oder inzwischen anders zugeordnete Mitarbeiter.
3. Werkzeuge über **BEG-Nr.**, Bezeichnung, Hersteller, Geräte- oder Seriennummer
   suchen und einzeln auswählen. Gleiche BEG-Nummern werden nicht zusammengefasst,
   weil sie in Altbeständen verschiedene Geräte eines Sets bezeichnen können.
4. Auswahl prüfen. Bei Rückgaben rechts neben jedem Werkzeug einen Rückgabegrund
   wählen: **Gerät defekt**, **Gerät verloren** oder **Rückgabe Lager** (Vorgabe).
   Unterschreiben und **Ausgabe/Rückgabe bestätigen** antippen. Eine nachträgliche
   Änderung eines Grundes leert die Unterschrift; während einer laufenden oder
   unklaren Bestätigung bleiben Gründe und Unterschrift gesperrt.
5. Die Erfolgsseite zeigt die Belegnummer. **Fertig** leert den Vorgang für die
   nächste Person; das gemeinsame Lagerkonto bleibt angemeldet.

Ausgaben bieten ausschließlich Lagerbestand ohne offene Defekt-/Verlustmeldung
an. Rückgaben zeigen ausschließlich dem ausgewählten Mitarbeiter zugeordnete
Einträge. Eine Rückgabe hebt eine bestehende Defekt-/Verlustmeldung nicht auf.
Defekte oder verlorene Geräte erzeugen bei Bestätigung eine offene Werkzeugmeldung
an den hinterlegten Werkzeug-Beauftragten und sind damit für eine erneute Ausgabe
gesperrt. Eine solche Rückgabe benötigt einen gültigen Beauftragten. Die Sperre
wird über das bestehende Erledigen der Werkzeugmeldung aufgehoben, nicht über den
Prüfhaken am Lagerbeleg. Es erfolgt keine automatische Abschreibung. „Verloren“
wird ausdrücklich von „entwendet“ unterschieden.
Gebucht wird jeweils der vollständige Inventareintrag; eine Mengenaufteilung von
Verbrauchsmaterial oder Sets ist kein Bestandteil dieses ersten Ablaufs.

Die erlaubten APIs sind `GET /api/warehouse/people`, `GET /api/warehouse/tools`
und `POST /api/warehouse/movements`. Sie geben nur für die Übergabe benötigte
Felder frei, keine Einkaufs-, Rechnungs- oder Personaldaten. Nur die Rolle Lager
darf diese APIs benutzen. Die vorhandene Büro-Inventarverwaltung bleibt unverändert.

Die Migration `20260930_0126` ergänzt `warehouse_movements`. Jede Buchung speichert
Richtung, Zeitpunkt, Lagerbenutzer, Mitarbeiter-/Werkzeugsnapshots und normalisierte
Unterschriftszüge. Bestandsänderungen und Beleg werden in derselben Transaktion
gespeichert. Eine nicht mehr verfügbare Auswahl wird vollständig abgelehnt.
Request-UUID und Payload-Prüfsumme schützen Wiederholungen vor Doppelbuchungen.
Bei unklarer Netzwerkantwort bleibt die signierte Auswahl gesperrt und kann mit
derselben Kennung erneut bestätigt werden. Unterschriften werden weder in
Browser-Storage noch in API-Konsolenlogs abgelegt. Eine Belegexport-Oberfläche
ist nicht Bestandteil dieses Ablaufs.

Ein Downgrade von `0126` löscht die neue Belegtabelle samt Unterschriften. Deshalb
nicht nach produktiven Buchungen ohne Sicherung ausführen. Die Migration selbst
verändert keine vorhandenen Inventar- oder Mitarbeiterdaten.

## Desktop-Protokoll

Unter **Sonstige → Werkzeuge und Material** stehen die Untertabs
**Ausgaben / Rückgaben** und **Bestand** zur Verfügung. Bestand enthält die
bisherige Inventarverwaltung; vorhandene Links zu Mitarbeitern oder einzelnen
Werkzeugen öffnen weiterhin direkt diesen Bereich.

Das Protokoll zeigt abgeschlossene Lagerbuchungen, neueste zuerst. Suche nach
Monteur, Lagerkonto, Belegnummer oder Werkzeugdaten sowie Vorgangs-, Prüfstatus- und
Datumsfilter grenzen die Ergebnisse ein. Datumsgrenzen und Uhrzeiten verwenden
Europe/Berlin. Je Seite werden 50 Belege geladen. Solange der Tab sichtbar ist,
wird alle 15 Sekunden und bei Rückkehr ins Fenster aktualisiert; zusätzlich
steht eine manuelle Aktualisierung zur Verfügung.

Ein Klick auf einen Beleg öffnet die damals gespeicherten Mitarbeiter-,
Lagerkonto- und Werkzeugdaten einschließlich Geräte-/Seriennummern und
Unterschrift. Die Unterschrift wird erst beim Öffnen geladen. Die signierten
Beleginhalte bleiben unveränderlich: Umbenennungen oder Bestandsänderungen schreiben
alte Belege nicht um. Abgebrochene, noch nicht bestätigte Tablet-Vorgänge erzeugen keinen Beleg.
Bei Rückgaben zeigt der Beleg den gespeicherten Grund pro Artikel. Ältere Belege
ohne diese Angabe zeigen **Nicht erfasst**; ihnen wird kein Grund nachträglich
unterstellt. Gründe und gegebenenfalls Werkzeugmeldungen werden atomar mit
Unterschrift und Bestandsänderung gespeichert. Die API akzeptiert `return_reasons`
als Zuordnung von Werkzeug-ID zu `defective`, `lost` oder `warehouse`; bei Angabe
muss die Zuordnung exakt alle ausgewählten Werkzeuge umfassen. Ausgaben dürfen
keine Rückgabegründe enthalten. Alte Clients ohne Zuordnung buchen unverändert
eine normale Lagerrückgabe. Wiederholungen einer Buchung ändern keinen Grund.

Neue und bisherige Belege beginnen **Ungeprüft**. Rechts setzt der aus der
Lohnprüfung bekannte Prüfhaken den Status auf **Geprüft**; ein weiterer Klick
setzt ihn zurück. Nur der gültige, unter Bestand hinterlegte Werkzeug-Beauftragte
und Admins dürfen den Status ändern. Andere freigeschaltete Büronutzer sehen ihn
lesend. Prüfername und Zeitpunkt erscheinen im Beleg; Prüfung und Rücksetzung
werden ohne Unterschriftsdaten im Audit-Protokoll aufgezeichnet.

`PATCH /api/admin/tool-material-items/movements/{id}/review` erhält den expliziten
Zielwert `reviewed` und `expected_version`. Wiederholungen desselben Zustands
sind idempotent; veraltete Änderungen an einem anderen Zustand werden abgewiesen.
Die Prüfung verändert weder Bestände noch Monteurunterschriften.

Die APIs `GET /api/admin/tool-material-items/movements` und
`GET /api/admin/tool-material-items/movements/{id}` verwenden dieselben Rechte
wie die Bestandsverwaltung: Admin oder Büro mit Freigabe für Sonstige.
Lagerkonten und Monteure haben keinen Zugriff auf das Desktop-Protokoll.
Beide Antworten sind mit `Cache-Control: no-store` versehen.

Migration `20260930_0127` ergänzt nur einen Index für die chronologische
Belegabfrage. Upgrade und Downgrade verändern keine gespeicherten Belege.
Migration `20261005_0128` ergänzt die Prüffelder. Bestehende Belege und Signaturen
bleiben erhalten. Ein Downgrade entfernt nur die neuen Prüffelder; deren aktueller
Status geht dabei verloren, das Audit-Protokoll bleibt erhalten.

Migration `20261005_0129` ergänzt `LOST` in den erlaubten Werkzeugmeldegründen.
Bestehende Meldungen bleiben unverändert. Ein Downgrade wird verweigert, solange
Meldungen mit `LOST` vorhanden sind; sie werden weder gelöscht noch in eine
Diebstahlmeldung umgewandelt.
