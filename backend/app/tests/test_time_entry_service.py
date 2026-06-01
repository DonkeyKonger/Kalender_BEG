from datetime import time
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.models.enums import UserRole
from app.services.time_entry_service import TimeEntryService


def service() -> TimeEntryService:
    item = TimeEntryService.__new__(TimeEntryService)
    item.db = SimpleNamespace()
    return item


def test_monteur_cannot_read_other_person_time_entries():
    current_user = SimpleNamespace(role=UserRole.MONTEUR, person_id=5)

    with pytest.raises(HTTPException) as error:
        service()._effective_person_id(current_user, 6)

    assert error.value.status_code == 403


def test_work_minutes_can_be_calculated_from_start_end_and_break():
    minutes = service()._resolve_work_minutes(
        start_time=time(8, 0),
        end_time=time(12, 0),
        break_minutes=30,
        work_minutes=None,
    )

    assert minutes == 210


def test_end_time_must_be_after_start_time():
    with pytest.raises(HTTPException) as error:
        service()._resolve_work_minutes(
            start_time=time(12, 0),
            end_time=time(8, 0),
            break_minutes=0,
            work_minutes=None,
        )

    assert error.value.status_code == 400
