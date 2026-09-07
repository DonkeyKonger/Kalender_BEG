# Bemerkungen zur Lohnabrechnung

Der Button „Bemerkungen hinzufügen“ in der Namensleiste öffnet ein kleines
Popup. Das Büro kann dort Bemerkungen je Monteur und Monat speichern, ändern
oder leeren. Nach der Monatsprüfung ist der Button gesperrt. Die API prüft
die Sperre ebenfalls, auch wenn das Popup vorher geöffnet wurde.

Das Bemerkungsfeld der Vorlage besteht aus vier Zeilen (`I46:L49`). Die
Eingabe wird mit denselben Schriftbreiten und Umbruchregeln wie der Export
auf vier Zeilen begrenzt. Das Popup zeigt den belegten Platz an. Zu lange
Eingaben und Einfügungen werden vollständig abgewiesen, nicht still gekürzt.
Der Export schreibt die vier Zeilen in Arial 10; die Breite von 144 pt lässt
einen Sicherheitsabstand zum Zellrand. Kontostände bleiben unberührt.

Die Bemerkung wird beim Prüfen in die unveränderliche Einzelabrechnung und
deren Quellenprotokoll übernommen. Der Sammel-Export verwendet diese geprüften
Dateien. Beim ausdrücklich begründeten Wiederöffnen bleibt der Text erhalten
und kann vor einer erneuten Prüfung bearbeitet werden.

Die neue nullable Spalte wird mit der Alembic-Migration `20260907_0114`
angelegt. Vor dem Start des aktualisierten Backends muss wie üblich
`alembic upgrade head` laufen; bestehende Freigaben bleiben erhalten.

Geprüft: 405 Backend-Tests erfolgreich; 11 bestehende PostgreSQL-Tests ohne
isolierte PostgreSQL-Test-URL übersprungen. 599 Frontend-Tests und der
Produktionsbuild erfolgreich. Browserprüfung mit simulierten Daten von
390 bis 1680 px, einschließlich Speichern, Abbrechen, Speicherfehler,
Eingabegrenzen und zwischenzeitlicher Monatsprüfung. Excel-Bereiche für
Beispieltext, Umlaute und maximale Breite gerendert und visuell geprüft.
