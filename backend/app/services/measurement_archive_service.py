"""Run the existing completion PDF archive after the checkbox response."""
import logging

from app.core.database import SessionLocal
from app.models.user import User
from app.services.measurement_service import MeasurementService


LOGGER = logging.getLogger(__name__)


def archive_completed_measurement_after_response(site_id: int, batch_id: int, user_id: int) -> None:
    try:
        with SessionLocal() as db:
            service = MeasurementService(db)
            batch = service._get_batch_for_site(batch_id, site_id)
            actor = db.get(User, user_id)
            if actor is None or batch.status not in {"billed", "approved", "closed"}:
                return
            service._archive_billed_batch_pdf(batch=batch, current_user=actor)
    except Exception:
        LOGGER.exception("Measurement PDF background archive failed: site_id=%s batch_id=%s", site_id, batch_id)
