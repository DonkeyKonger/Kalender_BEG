from datetime import date
from types import SimpleNamespace

from app.models.enums import AbsenceStatus, AbsenceType
from app.services.absence_service import absence_snapshot, clean_absence_values


def test_clean_absence_values_turns_blank_note_to_none():
    values = clean_absence_values({"note": "   "})

    assert values["note"] is None


def test_absence_snapshot_uses_json_safe_values():
    absence = SimpleNamespace(
        id=1,
        person_id=2,
        absence_type=AbsenceType.VACATION,
        start_date=date(2027, 1, 4),
        end_date=date(2027, 1, 8),
        status=AbsenceStatus.ACTIVE,
        note="Urlaub",
    )

    snapshot = absence_snapshot(absence)

    assert snapshot["absence_type"] == "vacation"
    assert snapshot["start_date"] == "2027-01-04"
    assert snapshot["status"] == "active"
