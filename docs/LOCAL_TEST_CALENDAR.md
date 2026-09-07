# Lokaler BEG-Testkalender

Der orange Dock-Eintrag **BEG Testkalender** startet Docker und den lokalen
Teststand und öffnet `http://127.0.0.1:18727/__local-test__/`. Nach Codeänderungen
wird beim nächsten Start neu gebaut. Der Erstbuild benötigt Internet für Images
und Pakete; das laufende Backend und die Datenbank haben keine externe Netzwerkverbindung.

## Trennung vom Betrieb

- Eigenes Docker-Projekt `beg-local-test`, eigener PostgreSQL-16-Datenspeicher.
  Der vorhandene Container `baustellenplaner-postgres` bleibt unangetastet.
- Keine produktive `.env`, Zugangsdaten oder Arbeitsverzeichnisse im Container.
  Der Datenbankhost ist fest `db`; ein Startschutz verweigert abweichende Ziele.
- Nur Webport `127.0.0.1:18727`, kein veröffentlichter Datenbankport. Das interne
  Docker-Netz sperrt ausgehende Internetverbindungen von Backend und Datenbank.
  Ein separater Nginx-Vorschaltserver verbindet den Loopback-Port mit genau dem
  lokalen Backend; er hat keine Zugangsdaten und ist kein allgemeiner Proxy.
  [Docker-Netzwerkdokumentation](https://docs.docker.com/reference/compose-file/networks/#internal).
- Mail, Push, GPS-Synchronisierung, SharePoint und Hintergrundbenachrichtigungen
  sind deaktiviert. Zusätzlich begrenzt eine lokale Content Security Policy
  Browser-Ressourcen/Fetches auf die eigene Adresse. Kartenkacheln und externe
  Dokumente/Fotos funktionieren deshalb bewusst nicht; dafür später separate
  Testkopien/-adapter vorsehen, keine produktiven Zugangsdaten aktivieren.
- Anwendung und Produktionsstart bleiben unverändert. Der orange Hinweis ist
  eine lokale Rahmenansicht; das eigentliche Frontend läuft darin mit eigenem
  Viewport. Direkte URLs außerhalb des Rahmens sind weiterhin lokal, zeigen
  aber nicht dessen Kennzeichnung. Immer über das Dock öffnen.
- Kein Push, Deployment oder automatischer Zugriff auf die Cloud-Datenbank.
  Lokale Tests ersetzen keine Deployment-/Migrationsabsicherung in Azure.

## Anmeldung und Bedienung

### Excel-Vorlage beim Monatsabschluss

Der lokale Image-Build setzt Leserechte auf die mitgelieferten Vorlagen und
prüft die Lohn-Excel anschließend als Laufzeitbenutzer `tester`. So bleiben
auch Vorlagen lesbar, die auf dem Mac nur Besitzer-/Gruppenrechte haben.
Ohne diese Normalisierung konnte der Monteurabschluss mit `PermissionError`
beim Lesen von `Lohn_Monatszettel_Master.xlsx` abbrechen.

Die Korrektur wurde mit einer Vorlage im Modus `0660`, dem Docker-Build,
72 Backend-Tests und 16 lokalen Verwaltungstests geprüft. Der betroffene
September-Abschluss einschließlich Excel-Export wurde gegen die lokale
Datenkopie erfolgreich durchlaufen und anschließend vollständig als
Datenbanktransaktion zurückgerollt; der Monteurmonat blieb offen.

Ein separater lokaler Benutzer `local-test-admin` wird angelegt. Das zufällige
Passwort steht ausschließlich in `.local-calendar/Zugang.txt` (Dateimodus 0600).
Die Datei über folgenden Befehl öffnen, nicht in Chats oder Git kopieren:

```sh
python3 tools/local_calendar/manage.py credentials
```

Weitere Befehle aus dem Projektverzeichnis:

```sh
python3 tools/local_calendar/manage.py start --open
python3 tools/local_calendar/manage.py rebuild --open
python3 tools/local_calendar/manage.py status
python3 tools/local_calendar/manage.py stop
python3 tools/local_calendar/manage.py install-dock
```

`stop` stoppt nur diese drei Testcontainer und erhält alle Daten. Docker wird
nicht beendet, damit andere lokale Anwendungen nicht gestört werden. Es gibt
bewusst keinen automatischen Lösch-/Resetbefehl. Der Dock-Installer ergänzt nur
seinen eigenen Eintrag und sichert vorher die Dock-Einstellungen lokal.

## Datenkopie importieren

Anfangs ist die Datenbank **leer**, abgesehen vom lokalen Testzugang. Es wird
keine Aktualität gegenüber der Cloud behauptet. Ein autorisierter Export aus
der Cloud muss separat beschafft werden; keine Passwörter als CLI-Argumente
oder Chatnachrichten verwenden. Für PostgreSQL einen konsistenten Custom-Dump
(`pg_dump -Fc`) mit einer zur Quellversion passenden Clientversion verwenden.
Vor dem ersten Export Quellversion prüfen: der Testserver nutzt PostgreSQL 16;
neuere Quellversionen erfordern eine bewusst abgestimmte Testserverversion.
Ein vollständiger Dump enthält sensible Mitarbeiter-, Lohn- und Zugangsdaten.
Nur vertrauenswürdige Backups verwenden, verschlüsselt transportieren/ablegen,
auf dem Mac FileVault und restriktive Zugriffsrechte verwenden. Externe
SharePoint-Dateien sind nicht automatisch in der Datenbankkopie enthalten.
Sicherungen außerhalb synchronisierter Ordner ablegen, beispielsweise unter
`~/Library/Application Support/BEG Testkalender/Backups/` (Ordner 0700,
Dateien 0600). Auch „Downloads“ und „Dokumente“ können mit iCloud verbunden sein;
den tatsächlichen Speicherort vor dem Browser-Download kontrollieren.

```sh
python3 tools/local_calendar/manage.py import /absoluter/pfad/kalender.dump \
  --snapshot-date 2026-09-07 --replace-local-data
```

Das Datum bezeichnet den tatsächlichen Quellstand, nicht das Importdatum.
Der Import erstellt eine **neue** lokale Datenbank, stellt dort wieder her und
führt Migrationen sowie die lokale Kontoanlage aus. Erst danach wird die
Testanwendung umgeschaltet. Die vorige lokale Datenbank bleibt erhalten; bei
fehlerhafter Wiederherstellung bleibt der bisherige Teststand aktiv. Fehlerhafte
Importdatenbanken werden ebenfalls nicht automatisch gelöscht. Laufende
Browser-Tabs danach neu laden und lokal erneut anmelden. Der lokale
Sitzungsschlüssel wird beim erfolgreichen Import erneuert, damit alte Sitzungen
nicht versehentlich einer anderen Benutzer-ID aus der Kopie zugeordnet werden.
Das Passwort für `local-test-admin` bleibt gleich. Ein fehlgeschlagener Wechsel
stellt auch die vorherige lokale Sitzungskonfiguration wieder her.

Keine Daten werden in die Cloud zurückgespielt. Noch fehlende Cloud-Exporte oder
Dokumentkopien sind ein separater Schritt, kein Grund die Isolation aufzuheben.

## Prüfungen und Grenzen

```sh
python3 -m unittest discover -s tools/local_calendar -p 'test_*.py' -v
python3 tools/local_calendar/smoke_test.py
cd frontend
npm test
npm run build
```

Zusätzlich beim Einrichten: echte PostgreSQL-Migrationen, lokale Anmeldung,
HTTP-/CSP-/Netzwerkprüfungen, Dock-Start und Laptop-/schmale Rahmenansicht prüfen.
Nach Übernahme einer realistischen Kopie folgen fachliche Prüfungen mit deren
Mehrfacheinträgen, Urlaub und Monatsabschlüssen. Eine leere Testdatenbank kann
deren Verhalten nicht ausreichend abdecken.

Der echte Restore-Selbsttest `python3 tools/local_calendar/smoke_test.py --restore`
ist ausschließlich für die anfänglich leere Datenbank vorgesehen. Er sichert
sie lokal, stellt sie in eine neue Testdatenbank wieder her und prüft den Wechsel.
Der Hinweis bleibt wahrheitsgemäß „noch keine Cloud-Daten“.

### Einrichtungsprüfung am 07.09.2026

- 16 Sicherheits-/Verwaltungstests, 584 Frontend-Tests, Produktions-Build,
  Ruff für die neuen Python-Dateien und `git diff --check` erfolgreich.
- Echte PostgreSQL-Migrationen, lokale Passwortanmeldung, API-404-Verhalten,
  CSP, fehlende Backend-/DB-Portfreigaben und gesperrte direkte Internetverbindung geprüft.
- Custom-Dump der leeren Testdatenbank tatsächlich in eine neue Testdatenbank
  importiert; Umschaltung erfolgreich, Ursprungsdatenbank unverändert behalten.
- Rahmen/Login bei 1315×768 und 390×844 visuell und geometrisch geprüft:
  kein horizontaler Überlauf, Rahmen und Anwendung überlappen sich nicht.
- Dock-App installiert, signiert, erneut idempotent geprüft und erfolgreich
  gestartet (Launcher-Log und anschließender Healthcheck). Die native
  UI-Automation meldete beim Abruf des kurzlebigen App-Fensters ein Timeout;
  der eigentliche Start war davon nicht betroffen.
- Keine Cloud-Daten importiert; keine produktive Sitzung verändert. In Projekt,
  Downloads und Desktop kein vorhandener PostgreSQL-Dump gefunden. FileVault-
  Status war per CLI nicht bestimmbar und ist vor sensiblen Kopien noch zu prüfen.

### Erste Azure-Datenkopie am 07.09.2026

- Quellstand: **07.09.2026, 13:24 Uhr Europe/Berlin**, Datenbank
  `baustellenplaner` auf `kalender-beg-staging-db`, PostgreSQL 16.14.
  Export über die vorhandene Azure-Sitzung mit geprüfter TLS-Verbindung und
  schreibgeschützter Datenbanksitzung. Keine Cloud-Konfiguration, Firewall,
  Benutzerkennwörter oder produktiven Daten geändert.
- Custom-Dump `beg-kalender-20260907T112435Z.dump`, 4.903.170 Bytes;
  SHA-256 vor und nach der Übertragung identisch:
  `8668413836b92cdba7075cd8cce0c0c526effb8bbbca563e5a19be40fef74585`.
  FileVault wurde als aktiv bestätigt. Die Sicherung liegt im oben genannten
  privaten Library-Ordner, nicht im Projekt oder Git. Safari hatte sie zunächst
  im iCloud-Downloadordner gespeichert; sie wurde daraus verschoben. Eine
  bereits erfolgte iCloud-Synchronisierung oder deren Verlauf ist nicht geprüft.
- Wiederherstellung und Migration erfolgreich; Schema `20260905_0113`, keine
  unvalidierten Constraints. Übernommen: 79 Personen, 125 Baustellen,
  586 Zuordnungen, 618 Zeiteinträge und 627 Abwesenheiten. Die vorherige lokale
  Testdatenbank bleibt erhalten. Der lokale Anmeldeschlüssel wurde erneuert;
  das separate Testadministrator-Passwort bleibt unverändert.
- Lokale Passwortanmeldung, Kalender-Matrix, Lohnprüfungs-/Wochenendpunkte und
  Monats-Sperrstatus mit der Kopie erfolgreich geprüft. In Safari sind die
  übernommenen Lohnprüfungsdaten und der orange Hinweis auf den Quellstand
  sichtbar. Keine vollständige fachliche Abnahme sämtlicher importierter Daten.
- Erneut 16 Verwaltungs-/Sicherheitstests, 584 Frontend-Tests, Produktions-Build,
  Ruff und `git diff --check` erfolgreich. Netzwerk-/HTTP-Sicherheitstest mit
  aktiver Datenkopie erfolgreich: nur Loopback-Webport, Backend/DB ohne
  veröffentlichte Ports, direkte Internetverbindung des Backends gesperrt.
- Einmalige Datenkopie, keine laufende Synchronisierung und kein Zurückschreiben
  nach Azure. Externe Dokumente/Fotos wurden nicht mitkopiert.
