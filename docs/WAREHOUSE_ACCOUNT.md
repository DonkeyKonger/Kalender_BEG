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
2. Mitarbeiter über Name oder Kürzel auswählen. Für Ausgaben stehen aktive
   Mitarbeiter aus den vorhandenen Stammdaten zur Verfügung (kein eigenes
   Benutzerkonto erforderlich). Rückgaben sind auch für ausgeschiedene oder
   inaktive Mitarbeiter mit noch zugeordneten Werkzeugen möglich.
3. Werkzeuge über **BEG-Nr.**, Bezeichnung, Hersteller, Geräte- oder Seriennummer
   suchen und einzeln auswählen. Gleiche BEG-Nummern werden nicht zusammengefasst,
   weil sie in Altbeständen verschiedene Geräte eines Sets bezeichnen können.
4. Auswahl prüfen, unterschreiben und **Ausgabe/Rückgabe bestätigen** antippen.
5. Die Erfolgsseite zeigt die Belegnummer. **Fertig** leert den Vorgang für die
   nächste Person; das gemeinsame Lagerkonto bleibt angemeldet.

Ausgaben bieten ausschließlich Lagerbestand ohne offene Defekt-/Verlustmeldung
an. Rückgaben zeigen ausschließlich dem ausgewählten Mitarbeiter zugeordnete
Einträge. Eine Rückgabe hebt eine bestehende Defekt-/Verlustmeldung nicht auf.
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
Browser-Storage noch in API-Konsolenlogs abgelegt. Es gibt in diesem Schritt
noch keine Belegübersicht oder Belegexport-Oberfläche.

Ein Downgrade von `0126` löscht die neue Belegtabelle samt Unterschriften. Deshalb
nicht nach produktiven Buchungen ohne Sicherung ausführen. Die Migration selbst
verändert keine vorhandenen Inventar- oder Mitarbeiterdaten.
