import assert from "node:assert/strict";
import test from "node:test";

import {
  articleWeightLabel,
  offerDescriptionLines,
  summarizeArticleDescription,
} from "../src/priceComparison/articleSummary.ts";

test("offer rows separate the real short name and preserve every remaining source line", () => {
  assert.deepEqual(offerDescriptionLines([
    "Unterflurkanal, 2-teilig 3-zügig 2000x35",
    "S3 35048-2",
    "3-zügig",
    "Dimension:2000x350x48",
    "Farbe:",
    "Oberfl.: bandverzinkt",
    "Mat.: Stahl",
    "Gewicht: 561,705 per 100",
  ].join("\n")), {
    shortName: "S3 35048-2",
    description: "Unterflurkanal, 2-teilig 3-zügig 2000x35 · 3-zügig · Dimension:2000x350x48 · Farbe: · Oberfl.: bandverzinkt · Mat.: Stahl · Gewicht: 561,705 per 100",
  });
});

test("offer rows prefer an explicit short name and remove only its matching stored line", () => {
  assert.deepEqual(
    offerDescriptionLines("Beschreibung\r\n  INTERN   S3  \r\nDimension: 20x30\r\nGewicht: 4 per 100", "intern s3"),
    {
      shortName: "intern s3",
      description: "Beschreibung · Dimension: 20x30 · Gewicht: 4 per 100",
    },
  );

  assert.deepEqual(offerDescriptionLines("Beschreibung\nEingebetteter Typ\nFarbe: rot", "Separater Typ"), {
    shortName: "Separater Typ",
    description: "Beschreibung · Eingebetteter Typ · Farbe: rot",
  });
});

test("offer row fallbacks never discard a single or missing description", () => {
  assert.deepEqual(offerDescriptionLines("Nur hinterlegter Beschreibungstext"), {
    shortName: "Ohne Kurzbezeichnung",
    description: "Nur hinterlegter Beschreibungstext",
  });
  assert.deepEqual(offerDescriptionLines("Beschreibung ohne Typ", "Expliziter Typ"), {
    shortName: "Expliziter Typ",
    description: "Beschreibung ohne Typ",
  });
  assert.deepEqual(offerDescriptionLines(null), {
    shortName: "Ohne Kurzbezeichnung",
    description: "",
  });
});

test("header weight uses kg and one decimal while preserving the quantity basis", () => {
  for (const [source, expected] of [
    ["Gewicht: 233,803 per 100", "Gewicht: 233,8 kg pro 100"],
    ["Gewicht: 356,295 per 100", "Gewicht: 356,3 kg pro 100"],
    ["Gewicht:0,000 per 100", "Gewicht: 0,0 kg pro 100"],
    ["Gewicht: 1,5 kg", "Gewicht: 1,5 kg"],
    ["Gewicht: 233.803 kg pro 100", "Gewicht: 233,8 kg pro 100"],
  ]) {
    assert.equal(articleWeightLabel(`Kabelrinne\r\nRKSM 630 FS\r\n  ${source}  \r\nFarbe: zink`), expected);
  }
});

test("missing weight stays missing and is never inferred from other technical values", () => {
  for (const value of [null, 12, "", "Gewicht: ", "Gewicht: unbekannt", "Gewicht: 2 lb", "Gewicht: \nFarbe: zink", "Dimension: 60x300\nEinheit: MTR\nLeichtgewicht"]) {
    assert.equal(articleWeightLabel(value), null);
  }
});

test("the real RKSM description becomes a concise title, repaired description and explicit quality", () => {
  const summary = summarizeArticleDescription([
    "Kabelrinne RKSM Magic, mit Schnellverbin",
    "RKSM 620 FS",
    "Magic, mit Schnellverbindung",
    "Dimension:60x200x3050",
    "Farbe: zink",
    "Oberfl.: bandverzinkt",
    "Mat.: Stahl",
    "Gewicht:181,5 kg",
  ].join("\n"));

  assert.deepEqual(summary, {
    shortName: "RKSM 620 FS",
    description: "Kabelrinne RKSM Magic, mit Schnellverbindung",
    quality: "Stahl, bandverzinkt",
  });
});

test("FS, FT, A2, A4 and FSK variants remain verbatim in the second content line", () => {
  const cases = [
    ["Kabelrinne", "RKSM 620 FS"],
    ["Kabelleiter", "LG 60 600 FT"],
    ["Montagewinkel", "MW 45 A2"],
    ["Kabelrinne aus Edelstahl", "RKSM 620 A4"],
    ["Kabelrinne mit schwarzer Beschichtung", "RKSM620 FSK SW"],
  ];

  for (const [description, shortName] of cases) {
    assert.deepEqual(
      summarizeArticleDescription(`${description}\n${shortName}\nDimension: 60x200\nFarbe: schwarz`),
      { shortName, description, quality: "" },
    );
  }
});

test("the original double spaces inside the second source line remain intact", () => {
  assert.deepEqual(
    summarizeArticleDescription("Potentialausgleichsschiene\n  PVG-BC 900K  10  \nDimension: 900 mm"),
    {
      shortName: "PVG-BC 900K  10",
      description: "Potentialausgleichsschiene",
      quality: "",
    },
  );
});

test("a colon in the first free-text line is not mistaken for technical metadata", () => {
  assert.deepEqual(
    summarizeArticleDescription("Spannband per Rolle: 25 m, Breite 10 mm\nSB 10 25\nMat.: Edelstahl"),
    {
      shortName: "SB 10 25",
      description: "Spannband per Rolle: 25 m, Breite 10 mm",
      quality: "Edelstahl",
    },
  );
});

test("a continuation already contained in the first line keeps the complete free-text description", () => {
  assert.deepEqual(
    summarizeArticleDescription("Befestigungsschelle einlappig 3mm St G\nBS 3 G\neinlappig\nDimension: 3 mm"),
    {
      shortName: "BS 3 G",
      description: "Befestigungsschelle einlappig 3mm St G",
      quality: "",
    },
  );
});

test("labeled dimensions, color, weight and similar metadata are hidden without changing the type code", () => {
  const summary = summarizeArticleDescription([
    "Kabeltragsystem mit Deckel",
    "RKSM620 FSK SW",
    "Dimension: 60x200x3050",
    "Farbe: tiefschwarz",
    "Gewicht: 181,5 kg",
    "Einheit: Stück",
    "EAN: 4012190000000",
    "Schutzart: IP20",
    "Oberfläche: pulverbeschichtet",
    "Werkstoff: Stahl",
    "Material: Stahl",
  ].join("\r\n"));

  assert.deepEqual(summary, {
    shortName: "RKSM620 FSK SW",
    description: "Kabeltragsystem mit Deckel",
    quality: "Stahl, pulverbeschichtet",
  });
  assert.doesNotMatch(Object.values(summary).join(" "), /60x200|tiefschwarz|181,5|401219|IP20/);
});

test("missing and malformed descriptions have stable fallbacks and keep only explicit quality", () => {
  assert.deepEqual(summarizeArticleDescription(null), {
    shortName: "Ohne Kurzbezeichnung",
    description: "Keine Kurzbeschreibung",
    quality: "",
  });
  assert.deepEqual(summarizeArticleDescription("   \nGewicht:\nMat.: Edelstahl\nOberfl.: gebeizt"), {
    shortName: "Ohne Kurzbezeichnung",
    description: "Keine Kurzbeschreibung",
    quality: "Edelstahl, gebeizt",
  });
  assert.deepEqual(summarizeArticleDescription("TSG 110 FS"), {
    shortName: "TSG 110 FS",
    description: "Keine Kurzbeschreibung",
    quality: "",
  });
});
