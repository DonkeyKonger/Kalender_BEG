# Fahrstrecke auf der Baustellenkarte

Start und Ziel suchen in den bereits geladenen Kartenadressen: aktive Personen
(deren hinterlegter Startort) und aktive Baustellen. Name, Kurzname,
Baustellennummer und Adresse sind durchsuchbar. Kartenfilter schränken diese
Suche nicht ein. Einträge ohne gültigen Kartenstandort müssen zunächst in den
Stammdaten vervollständigt werden; eine freie externe Adresssuche ist hier nicht
enthalten.

Ein Klick auf einen Personen- oder Baustellenmarker füllt das erste leere Feld,
dann das zweite. Auf der Karte und in der Suche stehen nur aktive Baustellen zur
Verfügung. Bereits eingegebener Text wird nicht
überschrieben. Das Kreuz leert ein Feld; Änderungen verwerfen das bisherige
Ergebnis und brechen laufende Anfragen ab.

## Routingdienst

`frontend/src/lib/mapRouting.ts` verwendet den öffentlichen Pkw-Routingdienst
von FOSSGIS/OSRM (`https://routing.openstreetmap.de/routed-car/route/v1/driving/`).
Der Browser sendet ausschließlich die beiden Koordinatenpaare, ohne Namen oder
Kalender-Zugangsdaten. Der Dienst erhält dadurch auch die öffentliche IP-Adresse
und den Browser-Ursprung; seine Datenschutzhinweise sind über den Quellenlink
im Routentool erreichbar. Der Browser benötigt Internetzugang, wie für die Kartenkacheln.

Der isolierte lokale Testkalender sperrt externe Browser-Anfragen über seine
Content Security Policy. Sein Docker-Build setzt `VITE_LOCAL_TEST_MODE=isolated`;
das Routentool zeigt dort nach Auswahl beider Adressen einen entsprechenden
Hinweis und fragt den externen Dienst nicht an. Suche und Kartenübernahme lassen
sich dort prüfen. Die echte Routenberechnung wird mit öffentlichen Testkoordinaten
in einer separaten Browser-Vorschau geprüft. Die lokale Netzwerkisolation bleibt
unverändert.

Die Anzeige verwendet die Straßenentfernung und geschätzte Dauer der empfohlenen
Pkw-Route, ohne Live-Verkehr. Die Anbindung begrenzt auf eine Anfrage je 1,1 Sekunden
pro Browserinstanz, serialisiert Anfragen und hält bis zu 100 Ergebnisse für fünf
Minuten ausschließlich im Arbeitsspeicher. Der Straßenpunkt darf höchstens 1 km
vom gewählten Standort entfernt liegen. Bei Fehlern oder fehlender Route gibt es
einen Hinweis mit Wiederholungsmöglichkeit und keine Luftlinien-Ersatzberechnung.

Die Oberfläche verlinkt OSRM/FOSSGIS, OpenStreetMap und „Kartenfehler melden“ gemäß
den [Nutzungsbedingungen des Dienstes](https://routing.openstreetmap.de/about.html).
Der öffentliche Dienst ist für geringe interaktive Nutzung vorgesehen; bei höherer
Nutzung ist ein eigener oder vertraglicher Routingdienst erforderlich.

## Prüfung

`npm test` prüft unter anderem Suche, Reihenfolge der Kartenübernahme, Kilometer-
und Minutenformatierung, Koordinatenreihenfolge, Cache, Abbruch, Zeitlimit und
Fehlerantworten. Die Browserprüfung umfasst beide Standortarten, zwei Baustellen,
Tastaturauswahl, Kartenklicks, belegte Felder, schnelle Änderungen, Wiederholung
nach Fehlern sowie Desktop- und Smartphone-Darstellung.
