# Projektweite Arbeitsvereinbarung

## Codex-Workflow und Git-Übergabe

- Nutzeränderungen dürfen in einer separaten, isolierten Codex-Arbeitskopie oder durch einen passenden KI-Arbeiter umgesetzt werden.
- Vor der Übernahme müssen die für die Änderung relevanten Tests und der Build erfolgreich laufen. UI-Änderungen benötigen zusätzlich eine angemessene visuelle QA, einschließlich betroffener responsiver Ansichten.
- Nach erfolgreicher Prüfung wird der fertige Commit sicher in die normale lokale `main`-Arbeitskopie übernommen, bevorzugt per Cherry-Pick. GitHub Desktop soll ihn dort als lokalen, noch ausstehenden Push anzeigen.
- Niemals automatisch pushen. Ein Push ist nur erlaubt, wenn der Nutzer ihn in diesem Moment ausdrücklich anfordert.
- Vor jeder Übernahme `main`, `origin/main`, den Arbeitsbaum und vorhandene Stashes prüfen. Vorhandene Stashes und fremde oder uncommittete Nutzeränderungen niemals verändern, anwenden oder entfernen.
- Bei einem schmutzigen Arbeitsbaum, unerwarteter Abweichung zwischen `main` und `origin/main` oder einem nicht eindeutig lösbaren Konflikt stoppen und eine Nutzerentscheidung anfordern. Ein durch die gerade übernommene Änderung erwartetes `main`-Ahead ist davon ausgenommen.
- Keine History-Umschreibung und keine destruktiven Git-Befehle verwenden.
