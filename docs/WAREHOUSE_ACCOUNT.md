# Lagerzugang – erster Ausbauschritt

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
Kalendernavigation. Der Bildschirm ist derzeit bewusst nur ein Platzhalter mit
Abmeldung. Werkzeugausgabe, Rücknahme und deren UI folgen in einem eigenen
Schritt. Bestehende Kalender-, Büro- und Monteur-APIs sind für Lager gesperrt.
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
