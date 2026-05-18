from sqlalchemy.orm import Session

from app.models.audit_log import AuditLog


class AuditService:
    def __init__(self, db: Session) -> None:
        self.db = db

    def record(
        self,
        *,
        user_id: int | None,
        action: str,
        entity_type: str,
        entity_id: int | None,
        old_value: dict | None,
        new_value: dict | None,
    ) -> None:
        self.db.add(
            AuditLog(
                user_id=user_id,
                action=action,
                entity_type=entity_type,
                entity_id=entity_id,
                old_value_json=old_value,
                new_value_json=new_value,
            )
        )
