export type ArticleListSummary = {
  shortName: string;
  description: string;
  quality: string;
};

const FALLBACK_SHORT_NAME = "Ohne Kurzbezeichnung";
const FALLBACK_DESCRIPTION = "Keine Kurzbeschreibung";
const MATERIAL_LABELS = new Set(["mat", "material", "werkstoff"]);
const SURFACE_LABELS = new Set([
  "oberfl",
  "oberfläche",
  "oberflaeche",
  "oberflache",
  "oberflächenschutz",
  "oberflaechenschutz",
  "oberflachenschutz",
]);
const HIDDEN_METADATA_LABELS = new Set([
  "abmessung",
  "abmessungen",
  "breite",
  "dimension",
  "dimensio",
  "durchmesser",
  "ean",
  "einheit",
  "farbe",
  "farbton",
  "gewicht",
  "gtin",
  "hoehe",
  "höhe",
  "laenge",
  "lieferlaenge",
  "lieferlänge",
  "länge",
  "menge",
  "nenngroesse",
  "nenngröße",
  "nennmass",
  "nennmaß",
  "querschnitt",
  "schutzart",
  "staerke",
  "stärke",
  "tiefe",
  "tragfaehigkeit",
  "tragfähigkeit",
  "verpackung",
  "vpe",
  "wandstaerke",
  "wandstärke",
]);

/**
 * Reduces a multi-line Datanorm description to the three text fragments used
 * by the article picker. Labeled technical details remain in the search index,
 * but are deliberately omitted from this presentation helper.
 */
export function summarizeArticleDescription(value: unknown): ArticleListSummary {
  const lines = typeof value === "string"
    ? value.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trim()).filter(Boolean)
    : [];
  const contentLines: string[] = [];
  const materials: string[] = [];
  const surfaces: string[] = [];

  for (const line of lines) {
    const metadata = parseMetadataLine(line);
    if (!metadata) {
      contentLines.push(line);
      continue;
    }
    if (!metadata.value) continue;
    if (MATERIAL_LABELS.has(metadata.label)) materials.push(metadata.value);
    if (SURFACE_LABELS.has(metadata.label)) surfaces.push(metadata.value);
  }

  if (!contentLines.length) {
    return {
      shortName: FALLBACK_SHORT_NAME,
      description: FALLBACK_DESCRIPTION,
      quality: qualityText(materials, surfaces),
    };
  }

  const shortNameIndex = contentLines.length > 1 ? 1 : 0;
  const shortName = contentLines[shortNameIndex] || FALLBACK_SHORT_NAME;
  const description = mergeDescriptionLines(contentLines.filter((_, index) => index !== shortNameIndex));

  return {
    shortName,
    description: description || FALLBACK_DESCRIPTION,
    quality: qualityText(materials, surfaces),
  };
}

function parseMetadataLine(line: string): { label: string; value: string } | null {
  const match = /^([^:]{1,32}):\s*(.*)$/.exec(line);
  if (!match) return null;
  const label = match[1].toLocaleLowerCase("de-DE").replace(/[.\s_-]+/g, "");
  if (!MATERIAL_LABELS.has(label) && !SURFACE_LABELS.has(label) && !HIDDEN_METADATA_LABELS.has(label)) return null;
  return {
    label,
    value: match[2].trim(),
  };
}

function mergeDescriptionLines(lines: string[]): string {
  if (!lines.length) return "";
  let result = lines[0];
  for (const line of lines.slice(1)) {
    const current = result.toLocaleLowerCase("de-DE");
    const next = line.toLocaleLowerCase("de-DE");
    if (current.includes(next)) continue;
    if (next.includes(current)) {
      result = line;
      continue;
    }

    const maximum = Math.min(result.length, line.length);
    let overlap = 0;
    for (let length = maximum; length >= 8; length -= 1) {
      if (current.endsWith(next.slice(0, length))) {
        overlap = length;
        break;
      }
    }
    result = overlap ? `${result.slice(0, -overlap)}${line}` : `${result} · ${line}`;
  }
  return result;
}

function qualityText(materials: string[], surfaces: string[]): string {
  const values = [...materials, ...surfaces].filter((value, index, all) => {
    const key = value.toLocaleLowerCase("de-DE");
    return key && all.findIndex((item) => item.toLocaleLowerCase("de-DE") === key) === index;
  });
  return values.join(", ");
}
