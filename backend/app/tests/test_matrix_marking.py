from datetime import date

import pytest
from pydantic import ValidationError
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.models import Base
from app.models.enums import MatrixCellMark, UserRole
from app.models.planning_cell_mark import PlanningCellMark
from app.models.site import Site
from app.models.user import User
from app.schemas.matrix import MatrixCellMarkPatch
from app.services.matrix_mutation_service import MatrixMutationService
from app.services.matrix_service import MatrixService


@pytest.mark.parametrize('mark', ['red', 'blue', 'invalid'])
def test_retired_mark_colors_are_rejected(mark):
    with pytest.raises(ValidationError):
        MatrixCellMarkPatch(site_id=1, date=date(2026, 9, 28), mark=mark)


def test_legacy_colors_are_hidden_preserved_and_can_be_replaced_then_removed():
    engine = create_engine('sqlite+pysqlite:///:memory:')
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        user = User(username='planner', display_name='Planner', password_hash='x',
                    role=UserRole.ADMIN, is_active=True)
        site = Site(site_number='9999', name='Testbaustelle', status='active')
        db.add_all([user, site])
        db.flush()
        for day, mark in [(28, MatrixCellMark.RED), (29, MatrixCellMark.BLUE), (30, MatrixCellMark.ORANGE)]:
            db.add(PlanningCellMark(site_id=site.id, mark_date=date(2026, 9, day), mark=mark))
        db.commit()
        cells = MatrixService(db).get_site_cells(site_id=site.id, start=date(2026, 9, 28), end=date(2026, 9, 30))
        assert [cell.mark for cell in cells] == [None, None, MatrixCellMark.ORANGE]
        assert len(list(db.scalars(select(PlanningCellMark)))) == 3

        service = MatrixMutationService(db)
        for day in [28, 29, 30, 31]:
            target = date(2026, 10, 1) if day == 31 else date(2026, 9, day)
            for mark in ['orange', None, 'orange', None]:
                payload = MatrixCellMarkPatch(site_id=site.id, date=target, mark=mark)
                result = service.patch_cell_mark(payload, user.id)
                assert result['updated_cells'][0].mark == mark
                stored = db.scalar(select(PlanningCellMark).where(PlanningCellMark.mark_date == target))
                assert (stored.mark if stored else None) == mark
    engine.dispose()
