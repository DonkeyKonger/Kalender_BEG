# OneDrive-Ordnerabgleich

## Automatische Zuordnung

Die Kalender-Personen-ID identifiziert den Projektleiter. Die Tabelle
`project_manager_folders` speichert seine OneDrive-Ordner-ID pro Laufwerk und
übergeordnetem Ordner (aktive Projekte bzw. `Archiv`). Der Anzeigename bleibt
der sichtbare Ordnername, ist aber nicht mehr die dauerhafte Identität.

Bei Namensänderungen werden vorhandene Projektleiterordner umbenannt, nicht
kopiert. Bei der ersten Zuordnung helfen die im Änderungsprotokoll hinterlegten
früheren Anzeigenamen. Der Vorgang erstellt keine leeren Projektleiterordner;
neue Container entstehen weiterhin erst bei der Baustellenanlage.

Die Datenbankmigration `20260928_0123` legt ausschließlich die Zuordnungstabelle
an. Sie löst keine Cloud-Aufrufe und keinen automatischen Altbestand-Lauf aus.

## Altbestand: kontrollierter Admin-Nachlauf

Nach ausdrücklicher Freigabe für das betroffene Cloud-Laufwerk kann der bestehende
Admin-Endpunkt genutzt werden:

`POST /api/admin/integrations/microsoft-graph/backfill-project-folders?limit=25&after_site_id=0`

Dieser Endpunkt **verändert OneDrive**: Er bindet vorhandene Projektleiterordner,
verschiebt bekannte Baustellenordner an ihren Sollort und ergänzt fehlende
Standardordner. Er ist keine Vorschau. Aktive Baustellen liegen unter dem
Projektleiter, abgeschlossene/gelöschte unter `Archiv/Projektleiter`.

Für den nächsten Stapel den zurückgegebenen Wert `next_after_site_id` als
`after_site_id` übergeben. Bei `null` ist das Ende erreicht. Fehler eines Stapels
separat festhalten und nach Klärung erneut prüfen; sie verhindern den Fortschritt
zu späteren Baustellen nicht. `created` umfasst auch erfolgreich abgeglichene
Bestandsordner, nicht nur neue Ordner.

Verschoben wird anhand der gespeicherten Baustellenordner-ID. Bei bisher nicht
verknüpften Altordnern wird der exakte normalisierte Baustellenname im Zielordner
und direkt im konfigurierten Projektbasisordner gesucht. Nicht eindeutig
zuordenbare, anders benannte oder anderweitig abgelegte Ordner müssen vorab
manuell zugeordnet werden. Es gibt keine unscharfe Suche nach ähnlichen Namen.

## Konflikte und Wiederholung

- Mehrere alte/neue Projektleiterordner (z. B. `CE` und
  `Christopher_Erichsen`) werden nicht automatisch zusammengeführt.
- Gleichnamige Baustellenordner im Ziel und Altbestand werden nicht überschrieben.
- Fehlende verknüpfte Ordner werden nicht durch neue leere Ordner ersetzt.
- Extern verschobene Projektleiterordner werden zur Prüfung gemeldet.
- Ordner einer anderen Person werden nicht übernommen.
- Es werden weder Ordner noch Dateien gelöscht. Leere Altcontainer bleiben
  bis zu einer ausdrücklich freigegebenen Bereinigung bestehen.

Fehler erscheinen im bestehenden Baustellen-Ordnerstatus. Fehlgeschlagene
Projektleiter-Umbenennungen werden zusätzlich im Audit-Log erfasst. Die Änderung
des Kalendernamens bleibt erhalten; bei späterer Baustellensynchronisierung oder
im Admin-Nachlauf wird die Ordnerzuordnung erneut geprüft. Es gibt keinen
Hintergrund-Timer für automatische Wiederholungen.

Vor einer Bereinigung beide Ordner anhand der Kalenderzuordnung und Inhalte
prüfen. Keine Cloud-Bereinigung allein aufgrund ähnlich klingender Namen.

## Lesende Bestandsprüfung am 28.09.2026

Im konfigurierten Cloud-Projektstamm wurden 22 direkt abgelegte Baustellenordner
gefunden. `CE` enthält neun Baustellenordner, `Christopher_Erichsen` acht; die
Baustellenordnernamen dieser beiden Listen überschneiden sich nicht. Diese
Beobachtung allein bestätigt noch nicht die aktuelle Kalenderzuordnung.
Es wurden keine Cloud-Ordner verschoben, umbenannt oder gelöscht. Die
anschließende Bereinigung einschließlich Wahl des kanonischen Ordners bleibt
ein separat freizugebender Vorgang.

## Technische Grundlage

Microsoft beschreibt die unveränderliche Item-ID bei Umbenennen/Verschieben:
https://learn.microsoft.com/en-us/graph/onedrive-addressing-driveitems

Der Abgleich verwendet das bestehende PATCH innerhalb desselben Laufwerks:
https://learn.microsoft.com/en-us/graph/api/driveitem-move?view=graph-rest-1.0
