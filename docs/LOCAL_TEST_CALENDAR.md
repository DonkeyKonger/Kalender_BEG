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
Browser-Tabs danach neu laden (lokale Anmeldung gegebenenfalls erneuern).

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
