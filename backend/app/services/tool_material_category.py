import re
import unicodedata

from app.models.enums import ToolMaterialCategory


CATEGORY_KEYWORDS: tuple[tuple[ToolMaterialCategory, tuple[str, ...]], ...] = (
    (
        ToolMaterialCategory.DRILLING_SCREWING,
        ("akkuschrauber", "bohrmaschine", "bohrhammer", "schlagbohrer", "bohrschrauber"),
    ),
    (
        ToolMaterialCategory.GRINDING_CUTTING,
        ("winkelschleifer", "trennschleifer", "trennjaeger", "schleifmaschine"),
    ),
    (
        ToolMaterialCategory.SAWING,
        ("kreissaege", "stichsaege", "saebelsaege", "bandsaege", "kappsaege"),
    ),
    (
        ToolMaterialCategory.VACUUMING,
        ("nass trockensauger", "staubsauger", "industriesauger", "sauger"),
    ),
    (
        ToolMaterialCategory.MEASURING,
        ("entfernungsmesser", "messlaser", "massband", "laser", "wasserwaage"),
    ),
    (
        ToolMaterialCategory.BATTERIES_CHARGING,
        ("ladegeraet", "ladestation", "akku", "batterie"),
    ),
    (
        ToolMaterialCategory.HAND_TOOLS,
        ("schraubenschluessel", "seitenschneider", "hammer", "zange", "schraubendreher"),
    ),
    (
        ToolMaterialCategory.LADDERS_WORK_EQUIPMENT,
        ("arbeitsbock", "arbeitsbuehne", "stehleiter", "leiter", "tritt"),
    ),
    (
        ToolMaterialCategory.TESTING_EQUIPMENT,
        ("installationstester", "pruefgeraet", "multimeter", "messgeraet"),
    ),
    (
        ToolMaterialCategory.VEHICLE_ACCESSORIES,
        ("fahrzeugzubehoer", "fahrzeugeinbau", "dachtraeger"),
    ),
    (
        ToolMaterialCategory.MATERIAL,
        ("verbrauchsmaterial", "installationsmaterial", "befestigungsmaterial"),
    ),
)


def suggest_tool_material_category(*values: str | None) -> ToolMaterialCategory:
    """Return a conservative, deterministic suggestion for controlled one-time imports."""
    normalized = " ".join(filter(None, (_normalize_category_text(value) for value in values)))
    if not normalized:
        return ToolMaterialCategory.OTHER
    for category, keywords in CATEGORY_KEYWORDS:
        if any(keyword in normalized for keyword in keywords):
            return category
    return ToolMaterialCategory.OTHER


def _normalize_category_text(value: str | None) -> str:
    if not value:
        return ""
    german_folded = (
        value.casefold()
        .replace("ä", "ae")
        .replace("ö", "oe")
        .replace("ü", "ue")
    )
    decomposed = unicodedata.normalize("NFKD", german_folded)
    ascii_text = "".join(character for character in decomposed if not unicodedata.combining(character))
    ascii_text = ascii_text.replace("ß", "ss")
    return re.sub(r"[^a-z0-9]+", " ", ascii_text).strip()
