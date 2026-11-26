# Historisches Preisniveau (Version matched-basket-v2)

## Verbindliche Regeln

Die Bewertung verwendet ausschließlich **Erstangebote innerhalb der letzten
36 Kalendermonate ab heute (Europe/Berlin)**, deren Datum **vor dem Datum des
bewerteten Angebots** liegt. Gleichdatierte und zukünftige Angebote zählen nicht.
Das Zielangebot selbst und Kopien mit derselben Angebotsnummer sind ausgeschlossen.
Mehrere Dateien mit derselben Referenz-Angebotsnummer zählen als eine Beobachtung.

Je Artikel sind mindestens **drei unterschiedliche frühere Erstangebote** nötig.
Aus ihren normalisierten Einzelpreisen wird der Median gebildet. Mengenstaffeln
innerhalb eines Angebots werden mengenabhängig zusammengeführt; das Angebot
bekommt dadurch keine zusätzlichen Stimmen.

## Berechnung

Für jeden vergleichbaren Artikel `i` werden die Zielmenge `qᵢ`, der wirksame
Zielpreis `pᵢ` und der historische Median `mᵢ` verwendet:

```text
Preisniveau = (Σ(qᵢ × pᵢ) / Σ(qᵢ × mᵢ) − 1) × 100 %
```

Es wird derselbe Warenkorb einmal mit den Angebotspreisen und einmal mit den
Referenzpreisen bewertet. Die zweite Kennzahl „Ø Positionsabweichung“ ist das
ungewichtete Mittel der Abweichungen dieser vergleichbaren Artikel.
Rabatt, Nettoabgleich und manuelle Korrektur werden in der bisherigen Reihenfolge
aufbereitet. Manuelle Korrekturen verändern auch spätere historische Bewertungen.

Verglichene Artikel müssen mindestens **60 % des prüfbaren aktuellen
Positionswerts** abdecken. Der Nenner enthält nur verifizierbare Artikel mit
positivem endlichem Preis und positiver endlicher Menge. Artikelidentität und
Einheiten müssen zur aktiven DATANORM passen. Unbekannte Sonderleistungen werden
nicht allein aufgrund einer wiederverwendeten Artikelnummer gleichgesetzt.
Fehlende Preise, Nullmengen, widersprüchliche Einheiten und erkannte beschädigte
Preiswerte werden ausgeschlossen. Es wird weder Menge 1 unterstellt noch eine
Abweichung auf ±25 % begrenzt. Auch die frühere einseitig wirkende Ausfilterung
von Abweichungen über ±100 % entfällt.

Bei unzureichender Basis sind beide Prozentkennzahlen `null`; die Oberfläche zeigt
„Keine belastbare Vergleichsbasis“ mit Grund. Die API liefert Artikel-/Wertabdeckung,
Referenzanzahl, ausgeschlossene Positionen, Berechnungsdatum und Methodenversion.

## Parserkorrektur und Erhaltungsgrenze

Der alte OBO-Parser konnte bei einer leeren Materialpreisspalte Artikelnummer,
Menge und Preiseinheit zu einem Milliardenbetrag verbinden. Neue PDF-Auswertungen
akzeptieren Materialpreis und Preiseinheit nur im passenden Positionskontext.
Leere Preisfelder bleiben leer. Mengen werden nur aus einer echten Mengenspalte
oder einem eindeutigen Mengen-/Einheitenkontext übernommen. Typziffern wie
`U 9011` sind keine Menge; fehlende Mengen bleiben unbekannt. Auch ältere
Schreibweisen ohne Leerzeichen (`16,00MTR`) bleiben unterstützt. Der abgeleitete
Parsercache wird versioniert.

Bereits übernommene Online-Snapshots werden nicht neu importiert oder überschrieben.
Der bekannte Fehler (sehr großer Preis beginnt mit der Artikelnummer) wird nur
in einer Laufzeitkopie als ungültiger Preis markiert. Explizite gültige manuelle
Korrekturen bleiben möglich. Original-PDFs, DATANORM-Dateien, Speicherwege,
Importformate und Exportformate werden nicht umgeschrieben.

Die neue Formel betrifft das Angebotspreisniveau und die zugehörige mittlere
Positionsabweichung. Die übrigen Artikelhistorien, Min-/Max-Vergleiche und
Nettopreisvorschläge behalten ihre eigenen bestehenden Berechnungen.

## Aktualisierung und Tests

Leseansichten verwenden eine nach Datenrevision, Methodenversion und Berliner
Kalendertag getrennte Berechnung. Frühere eingefrorene Kennzahlen sind nicht mehr
maßgeblich. Ein Lesen schreibt keine gemeinsamen Dateien. Jede Quellen- oder
Einstellungsrevision und jeder Tageswechsel führt zu einer neuen Bewertung.

Regressionen decken insbesondere Datumsgrenzen/Schaltjahre, Erstangebotsfilter,
Duplikate, drei Referenzen, exakt 60 % Abdeckung, Mengen, Einheiten, manuelle
Korrekturen, beschädigte Preise, extreme reale Abweichungen, unveränderte Inputs,
Cachewechsel sowie reale PDF-/Import-/API-/Exportwege ab.

## Prüfstand vom 26.11.2026

- Gesamtes Backend: 2.825 Tests bestanden, 16 umgebungsabhängige Tests
  übersprungen. Alle 283 Preisvergleichstests auch separat erfolgreich; Ruff
  erfolgreich. Beide Läufe prüfen den endgültigen Parserstand.
- Frontend: 1.159 Tests bestanden, Produktionsbuild und betroffene ESLint-Prüfung
  erfolgreich. Desktop (1.280/1.850 px) und Mobilansicht (390 px) visuell geprüft;
  Angebotsdetails, Artikelmodal und ungespeicherte Eingaben bleiben bedienbar.
- 162 lokale Original-PDFs ausschließlich lesend neu ausgewertet: weiterhin
  161 lesbare Angebote. Eine bereits vorher unlesbare VLB-Datei enthält keine
  auswertbaren Preispositionen. Angebotsnummer, Projekt, Datum und Gesamtsummen
  der lesbaren Angebote stimmen unverändert mit dem vorherigen Stand überein.
- Die separate, unveränderte Online-Datenkopie mit 228 Angeboten wurde ebenfalls
  geprüft. Ihr Importbestand wird nicht durch den lokalen PDF-Bestand ersetzt.

Diese Prüfung belegt die getesteten Rechen- und Formatregeln. Fehlerhafte Angaben
in einer Quelldatei können durch Plausibilitätsregeln nicht generell bewiesen oder
korrigiert werden; deshalb werden fehlende oder erkannte ungültige Werte sowie
unzureichende Vergleichsgrundlagen ausdrücklich ausgewiesen.
