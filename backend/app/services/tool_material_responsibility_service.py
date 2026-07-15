from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload

from app.core.office_permissions import (
    OFFICE_PAGE_MISCELLANEOUS,
    office_user_can_access,
)
from app.models.enums import PersonEmploymentStatus, PersonType, UserRole
from app.models.tool_material_settings import ToolMaterialSettings
from app.models.user import User
from app.schemas.tool_material_item import (
    ToolMaterialResponsibilityRead,
    ToolResponsibleUserRead,
)


TOOL_MATERIAL_SETTINGS_ID = 1


class ToolMaterialResponsibilityService:
    def __init__(self, db: Session) -> None:
        self.db = db

    def read_settings(self) -> ToolMaterialResponsibilityRead:
        settings = self._load_settings()
        if settings is None or settings.tool_responsible_user_id is None:
            return ToolMaterialResponsibilityRead(
                tool_responsible_user_id=None,
                responsible_user=None,
            )

        user = settings.tool_responsible_user
        if user is None:
            return ToolMaterialResponsibilityRead(
                tool_responsible_user_id=settings.tool_responsible_user_id,
                responsible_user=ToolResponsibleUserRead(
                    id=settings.tool_responsible_user_id,
                    display_name="*gelöscht*",
                    is_active=False,
                    is_valid=False,
                    invalid_reason="Der gespeicherte Benutzer wurde gelöscht.",
                ),
            )

        invalid_reason = tool_responsible_user_invalid_reason(user)
        return ToolMaterialResponsibilityRead(
            tool_responsible_user_id=user.id,
            responsible_user=ToolResponsibleUserRead(
                id=user.id,
                display_name=user.display_name,
                is_active=user.is_active,
                is_valid=invalid_reason is None,
                invalid_reason=invalid_reason,
            ),
        )

    def list_selectable_users(self) -> list[ToolResponsibleUserRead]:
        users = self.db.scalars(
            select(User)
            .where(
                User.role == UserRole.OFFICE,
                User.is_active.is_(True),
            )
            .options(joinedload(User.person))
        ).unique()
        selectable = [
            user
            for user in users
            if tool_responsible_user_invalid_reason(user) is None
        ]
        selectable.sort(key=lambda user: (user.display_name.casefold(), user.id))
        return [
            ToolResponsibleUserRead(
                id=user.id,
                display_name=user.display_name,
                is_active=True,
                is_valid=True,
                invalid_reason=None,
            )
            for user in selectable
        ]

    def update_responsible_user(
        self,
        user_id: int | None,
    ) -> ToolMaterialResponsibilityRead:
        user = None
        if user_id is not None:
            user = self.db.scalar(
                select(User)
                .where(User.id == user_id)
                .options(joinedload(User.person))
            )
            if user is None:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    "Der ausgewählte Büronutzer wurde nicht gefunden.",
                )
            invalid_reason = tool_responsible_user_invalid_reason(user)
            if invalid_reason is not None:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, invalid_reason)

        settings = self._get_or_create_settings()
        settings.tool_responsible_user_id = user.id if user is not None else None
        self.db.commit()
        return self.read_settings()

    def get_responsible_user(self) -> User | None:
        settings = self._load_settings()
        if settings is None or settings.tool_responsible_user is None:
            return None
        user = settings.tool_responsible_user
        if tool_responsible_user_invalid_reason(user) is not None:
            return None
        return user

    def _load_settings(self) -> ToolMaterialSettings | None:
        return self.db.scalar(
            select(ToolMaterialSettings)
            .where(ToolMaterialSettings.id == TOOL_MATERIAL_SETTINGS_ID)
            .options(
                joinedload(ToolMaterialSettings.tool_responsible_user)
                .joinedload(User.person)
            )
        )

    def _get_or_create_settings(self) -> ToolMaterialSettings:
        settings = self.db.get(ToolMaterialSettings, TOOL_MATERIAL_SETTINGS_ID)
        if settings is None:
            settings = ToolMaterialSettings(id=TOOL_MATERIAL_SETTINGS_ID)
            self.db.add(settings)
            self.db.flush()
        return settings


def get_tool_responsible_user(db: Session) -> User | None:
    """Return the currently valid notification recipient for tool workflows."""
    return ToolMaterialResponsibilityService(db).get_responsible_user()


def tool_responsible_user_invalid_reason(user: User) -> str | None:
    if not user.is_active:
        return "Das Benutzerkonto ist deaktiviert."
    if user.role != UserRole.OFFICE:
        return "Der Benutzer ist kein Büronutzer mehr."
    if not office_user_can_access(user, OFFICE_PAGE_MISCELLANEOUS):
        return "Der Büronutzer hat keinen Zugriff auf „Sonstige“."

    person = user.person
    if person is None:
        return "Dem Büronutzer ist keine interne Person zugeordnet."
    if person.deleted_at is not None:
        return "Die zugeordnete Person wurde gelöscht."
    if person.person_type != PersonType.INTERNAL:
        return "Als Beauftragter ist nur ein interner Büronutzer zulässig."
    if not person.is_active or person.employment_status != PersonEmploymentStatus.ACTIVE.value:
        return "Die zugeordnete Person ist nicht aktiv."
    return None
