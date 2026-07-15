import pytest

from app.models.enums import ToolMaterialCategory
from app.schemas.tool_material_item import ToolMaterialItemCreate
from app.services.tool_material_category import suggest_tool_material_category


@pytest.mark.parametrize(
    ("designation", "expected"),
    [
        ("Bosch Akkuschrauber", ToolMaterialCategory.DRILLING_SCREWING),
        ("Winkelschleifer", ToolMaterialCategory.GRINDING_CUTTING),
        ("Handkreissäge", ToolMaterialCategory.SAWING),
        ("Nass-Trockensauger", ToolMaterialCategory.VACUUMING),
        ("Laser-Entfernungsmesser", ToolMaterialCategory.MEASURING),
        ("Installationstester", ToolMaterialCategory.TESTING_EQUIPMENT),
        ("Ladegerät 18V", ToolMaterialCategory.BATTERIES_CHARGING),
        ("Schraubenschlüssel-Satz", ToolMaterialCategory.HAND_TOOLS),
        ("Stehleiter", ToolMaterialCategory.LADDERS_WORK_EQUIPMENT),
        ("Fahrzeugzubehör", ToolMaterialCategory.VEHICLE_ACCESSORIES),
        ("Verbrauchsmaterial", ToolMaterialCategory.MATERIAL),
        ("nicht eindeutig", ToolMaterialCategory.OTHER),
    ],
)
def test_import_category_suggestions_are_deterministic(designation, expected):
    assert suggest_tool_material_category(designation) == expected


def test_new_tool_material_defaults_to_other_and_manual_category_is_preserved():
    default_payload = ToolMaterialItemCreate(beg_number="1", designation="Unklar")
    manual_payload = ToolMaterialItemCreate(
        beg_number="2",
        designation="Unklar",
        category=ToolMaterialCategory.MATERIAL,
    )

    assert default_payload.category == ToolMaterialCategory.OTHER
    assert manual_payload.category == ToolMaterialCategory.MATERIAL
    assert suggest_tool_material_category(manual_payload.designation) == ToolMaterialCategory.OTHER


def test_category_keys_are_stable_and_complete():
    assert [category.value for category in ToolMaterialCategory] == [
        "drilling_screwing",
        "grinding_cutting",
        "sawing",
        "vacuuming",
        "measuring",
        "batteries_charging",
        "hand_tools",
        "ladders_work_equipment",
        "testing_equipment",
        "vehicle_accessories",
        "material",
        "other",
    ]
