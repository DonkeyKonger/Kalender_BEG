from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

from app.models.enums import UserRole
from app.models.user import User


NEUTRAL_CREATOR_LABEL = "Erstellt von"

USER_ROLE_DOCUMENT_LABELS: dict[UserRole, str] = {
    UserRole.ADMIN: "Administrator",
    UserRole.PROJECT_MANAGER: "Projektleiter",
    UserRole.OFFICE: "Büromitarbeiter",
    UserRole.MONTEUR: "Monteur",
}

USER_ROLE_DOCUMENT_PLURAL_NAMES: dict[UserRole, str] = {
    UserRole.ADMIN: "Mehrere Administratoren",
    UserRole.PROJECT_MANAGER: "Mehrere Projektleiter",
    UserRole.OFFICE: "Mehrere Büromitarbeiter",
    UserRole.MONTEUR: "Mehrere Monteure",
}


@dataclass(frozen=True)
class UserDocumentAttribution:
    name: str
    role_label: str


def user_display_name(user: User | None) -> str | None:
    if user is None:
        return None
    person = getattr(user, "person", None)
    person_name = getattr(person, "display_name", None)
    if isinstance(person_name, str) and person_name.strip():
        return person_name.strip()
    display_name = getattr(user, "display_name", None)
    if isinstance(display_name, str) and display_name.strip():
        return display_name.strip()
    return None


def user_role_document_label(role: UserRole | str | None) -> str:
    try:
        normalized = role if isinstance(role, UserRole) else UserRole(role)
    except (TypeError, ValueError):
        return NEUTRAL_CREATOR_LABEL
    return USER_ROLE_DOCUMENT_LABELS.get(normalized, NEUTRAL_CREATOR_LABEL)


def user_document_attribution(user: User | None) -> UserDocumentAttribution | None:
    name = user_display_name(user)
    if name is None:
        return None
    return UserDocumentAttribution(
        name=name,
        role_label=user_role_document_label(getattr(user, "role", None)),
    )


def common_user_document_attribution(
    users: Iterable[User | None],
) -> UserDocumentAttribution | None:
    user_list = tuple(users)
    attributions = {
        attribution
        for user in user_list
        if (attribution := user_document_attribution(user)) is not None
    }
    if not attributions:
        return None
    if len(attributions) == 1:
        return next(iter(attributions))

    roles = {
        getattr(user, "role", None)
        for user in user_list
        if user_display_name(user) is not None
    }
    try:
        normalized_roles = {
            role if isinstance(role, UserRole) else UserRole(role)
            for role in roles
        }
    except (TypeError, ValueError):
        normalized_roles = set()
    if len(normalized_roles) == 1:
        role = next(iter(normalized_roles))
        return UserDocumentAttribution(
            name=USER_ROLE_DOCUMENT_PLURAL_NAMES[role],
            role_label=USER_ROLE_DOCUMENT_LABELS[role],
        )
    return UserDocumentAttribution(
        name="Mehrere Mitarbeiter",
        role_label=NEUTRAL_CREATOR_LABEL,
    )
