from __future__ import annotations

from collections.abc import Callable
from datetime import datetime
from io import BytesIO
import re
from typing import Any
from urllib.parse import quote
from uuid import uuid4
from zoneinfo import ZoneInfo

from fastapi import HTTPException, status
from pypdf import PdfReader, PdfWriter
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.models.material_order import MaterialOrderDraft
from app.models.site import Site
from app.models.user import User
from app.schemas.material_order import (
    MaterialOrderCompleteRead,
    MaterialOrderDraftRead,
    MaterialOrderValuesUpdate,
)
from app.schemas.project_folder import ProjectFolderDocumentItem
from app.services.material_order_pdf_service import (
    build_material_order_pdf,
    get_material_order_form,
    get_material_order_template,
    validate_material_order_values,
)
from app.services.microsoft_graph_client import (
    MicrosoftGraphConfigError,
    MicrosoftGraphRequestError,
)
from app.services.project_folder_count_cache import invalidate_site_counts
from app.services.project_storage_service import ProjectStorageService


MATERIAL_ORDER_TIMEZONE = ZoneInfo("Europe/Berlin")
MATERIAL_ORDER_FILENAME_SUFFIX = "_Lagerbestellung.pdf"


class MaterialOrderService:
    def __init__(
        self,
        db: Session,
        *,
        storage_service: ProjectStorageService | None = None,
        form_provider: Callable[[], dict[str, Any]] = get_material_order_form,
        template_provider: Callable[[], bytes] = get_material_order_template,
        pdf_builder: Callable[..., bytes] = build_material_order_pdf,
        values_validator: Callable[[dict[str, str | bool]], None] = validate_material_order_values,
        now_provider: Callable[[], datetime] | None = None,
    ) -> None:
        self.db = db
        self.storage = storage_service or ProjectStorageService()
        self.form_provider = form_provider
        self.template_provider = template_provider
        self.pdf_builder = pdf_builder
        self._pdf_builder_accepts_metadata = pdf_builder is build_material_order_pdf
        self.values_validator = values_validator
        self.now_provider = now_provider or (lambda: datetime.now(MATERIAL_ORDER_TIMEZONE))

    def get_form(self) -> dict[str, Any]:
        return self.form_provider()

    def get_template(self) -> bytes:
        return self.template_provider()

    def read_draft(
        self,
        *,
        site_id: int,
        draft_id: str,
        current_user: User,
    ) -> MaterialOrderDraftRead:
        draft = self._get_draft(
            site_id=site_id,
            draft_id=draft_id,
            user_id=current_user.id,
        )
        return MaterialOrderDraftRead.model_validate(draft)

    def open_draft(self, *, site_id: int, current_user: User) -> MaterialOrderDraftRead:
        # PostgreSQL must lock only the site row, not a nullable eager-load join.
        site = self.db.scalar(
            select(Site)
            .options(selectinload(Site.customer_record))
            .where(Site.id == site_id)
            .with_for_update(of=Site)
        )
        if site is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Baustelle nicht gefunden.")

        draft = self.db.scalar(
            select(MaterialOrderDraft).where(
                MaterialOrderDraft.site_id == site_id,
                MaterialOrderDraft.user_id == current_user.id,
                MaterialOrderDraft.status == "draft",
            )
        )
        if draft is None:
            draft = MaterialOrderDraft(
                id=str(uuid4()),
                site_id=site_id,
                user_id=current_user.id,
                revision=0,
                values=self._initial_values(site, current_user),
                status="draft",
            )
            self.db.add(draft)
        self.db.commit()
        self.db.refresh(draft)
        return MaterialOrderDraftRead.model_validate(draft)

    def save_draft(
        self,
        *,
        site_id: int,
        draft_id: str,
        current_user: User,
        payload: MaterialOrderValuesUpdate,
    ) -> MaterialOrderDraftRead:
        values = self._validate_values(payload.values)
        draft = self._get_draft(
            site_id=site_id,
            draft_id=draft_id,
            user_id=current_user.id,
            for_update=True,
        )
        self._ensure_editable(draft)
        self._check_revision(draft, payload.revision)
        if draft.completion_token:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Der Abschluss dieser Lagerbestellung wird wiederhergestellt. Bitte erneut abschließen.",
            )
        draft.values = values
        draft.revision += 1
        self.db.commit()
        self.db.refresh(draft)
        return MaterialOrderDraftRead.model_validate(draft)

    def preview_pdf(
        self,
        *,
        site_id: int,
        draft_id: str,
        current_user: User,
        payload: MaterialOrderValuesUpdate,
    ) -> bytes:
        values = self._validate_values(payload.values)
        draft = self._get_draft(
            site_id=site_id,
            draft_id=draft_id,
            user_id=current_user.id,
        )
        self._ensure_editable(draft)
        self._check_revision(draft, payload.revision)
        return self._build_pdf(values)

    def complete(
        self,
        *,
        site_id: int,
        draft_id: str,
        current_user: User,
        payload: MaterialOrderValuesUpdate,
        drive_id: str | None,
        folder_item_id: str | None,
    ) -> MaterialOrderCompleteRead:
        values = self._validate_values(payload.values)
        self._ensure_material_rows(values)
        draft = self._get_draft(
            site_id=site_id,
            draft_id=draft_id,
            user_id=current_user.id,
            for_update=True,
        )
        if draft.status == "completed":
            return self._completed_retry(draft, payload.revision, values)
        if not drive_id or not folder_item_id:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "SharePoint-Ordner für Lagerbestellungen ist noch nicht angebunden.",
            )

        draft_id_value = draft.id
        is_pending_retry = bool(draft.completion_token)
        if is_pending_retry:
            if (
                values != draft.values
                or payload.revision not in {draft.revision, draft.completion_payload_revision}
            ):
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    "Für diesen Entwurf läuft bereits ein Abschluss mit anderen Daten.",
                )
            completion_token = draft.completion_token
            completion_filename = draft.completion_filename
            content = self._build_completion_pdf(
                values,
                draft_id=draft_id_value,
                completion_token=completion_token,
            )
        else:
            self._check_revision(draft, payload.revision)
            completion_token = str(uuid4())
            completion_filename = material_order_filename(self.now_provider())
            # Definite local failures happen before a pending reservation so the
            # draft remains editable when no external write was attempted.
            content = self._build_completion_pdf(
                values,
                draft_id=draft_id_value,
                completion_token=completion_token,
            )
            # Read-only Graph preflight: definite configuration, permission, or
            # folder failures must leave the draft normally editable. Only an
            # upload that may have partially succeeded creates a pending lock.
            try:
                existing_items = self.storage.list_folder_children(
                    drive_id=drive_id,
                    folder_item_id=folder_item_id,
                )
            except MicrosoftGraphConfigError as error:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    "Microsoft Graph ist nicht vollständig konfiguriert.",
                ) from error
            completion_filename = _first_unlisted_material_order_filename(
                completion_filename,
                {
                    str(item.get("name"))
                    for item in existing_items
                    if isinstance(item, dict)
                    and isinstance(item.get("name"), str)
                    and item["name"]
                },
            )
            # Persist current values and an idempotency reservation before Graph.
            # A retry can recognize an uploaded PDF after a process/DB failure.
            draft.values = values
            draft.revision += 1
            draft.completion_token = completion_token
            draft.completion_filename = completion_filename
            draft.completion_payload_revision = payload.revision
            self.db.commit()

        if not completion_filename:
            raise HTTPException(
                status.HTTP_500_INTERNAL_SERVER_ERROR,
                "Lagerbestellungs-Abschluss ist unvollständig reserviert.",
            )

        try:
            document = upload_material_order_pdf_without_overwrite(
                storage=self.storage,
                drive_id=drive_id,
                folder_item_id=folder_item_id,
                filename=completion_filename,
                content=content,
                draft_id=draft_id_value,
                completion_token=completion_token,
                recover_reserved_upload=is_pending_retry,
                reserve_filename=lambda candidate: self._reserve_completion_filename(
                    site_id=site_id,
                    draft_id=draft_id_value,
                    user_id=current_user.id,
                    completion_token=completion_token,
                    filename=candidate,
                ),
            )
            draft = self._get_draft(
                site_id=site_id,
                draft_id=draft_id_value,
                user_id=current_user.id,
                for_update=True,
            )
            if draft.status == "completed":
                return self._completed_retry(draft, payload.revision, values)
            if draft.completion_token != completion_token:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    "Der Lagerbestellungs-Abschluss wurde zwischenzeitlich geändert.",
                )
            draft.status = "completed"
            draft.filename = document.name
            draft.completion_filename = document.name
            draft.completed_document = document.model_dump(mode="json")
            self.db.flush()
            invalidate_site_counts(self.db, site_id)
            self.db.commit()
            self.db.refresh(draft)
        except _CompletionAlreadyFinalized as completed:
            self.db.rollback()
            return self._completed_retry(completed.draft, payload.revision, values)
        except Exception:
            # Keep the earlier reservation commit. It makes ambiguous external
            # failures recoverable and preserves the latest submitted values.
            self.db.rollback()
            raise

        return MaterialOrderCompleteRead(
            draft=MaterialOrderDraftRead.model_validate(draft),
            document=document,
        )

    def _reserve_completion_filename(
        self,
        *,
        site_id: int,
        draft_id: str,
        user_id: int,
        completion_token: str,
        filename: str,
    ) -> None:
        draft = self._get_draft(
            site_id=site_id,
            draft_id=draft_id,
            user_id=user_id,
            for_update=True,
        )
        if draft.status == "completed":
            raise _CompletionAlreadyFinalized(draft)
        if draft.completion_token != completion_token:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Der Lagerbestellungs-Abschluss wurde zwischenzeitlich geändert.",
            )
        if draft.completion_filename != filename:
            draft.completion_filename = filename
            self.db.commit()

    def _initial_values(self, site: Site, current_user: User) -> dict[str, str | bool]:
        customer = site.customer_record.company_name if site.customer_record else site.customer
        proposed = {
            "customer": customer or "",
            "project": site.name or "",
            "commission": site.site_number or "",
            "requested_by": current_user.display_name or current_user.username,
        }
        specs = self._field_specs()
        return {
            name: self._fit_prefill(name, value, specs[name].get("max_length"))
            for name, value in proposed.items()
            if name in specs
        }

    def _fit_prefill(self, name: str, value: str, max_length: Any) -> str:
        candidate = value[:max_length] if isinstance(max_length, int) else value
        while candidate:
            try:
                self.values_validator({name: candidate})
                return candidate
            except (TypeError, ValueError):
                candidate = candidate[:-1]
        return ""

    def _validate_values(
        self,
        values: dict[str, str | bool],
    ) -> dict[str, str | bool]:
        try:
            self.values_validator(values)
        except (TypeError, ValueError) as error:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                str(error) or "Lagerbestellung enthält ungültige Werte.",
            ) from error
        return dict(values)

    def _field_specs(self) -> dict[str, dict[str, Any]]:
        form = self.form_provider()
        fields = form.get("fields")
        if not isinstance(fields, list):
            raise HTTPException(
                status.HTTP_500_INTERNAL_SERVER_ERROR,
                "Lagerbestellformular ist ungültig konfiguriert.",
            )
        return {
            str(field["name"]): field
            for field in fields
            if isinstance(field, dict)
            and isinstance(field.get("name"), str)
            and field.get("type") in {"text", "checkbox"}
        }

    def _build_pdf(self, values: dict[str, str | bool]) -> bytes:
        try:
            content = self.pdf_builder(values)
        except HTTPException:
            raise
        except (TypeError, ValueError) as error:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                str(error) or "Lagerbestellung enthält ungültige Werte.",
            ) from error
        if not isinstance(content, bytes) or not content.startswith(b"%PDF"):
            raise HTTPException(
                status.HTTP_500_INTERNAL_SERVER_ERROR,
                "Lagerbestellungs-PDF konnte nicht erzeugt werden.",
            )
        return content

    def _build_completion_pdf(
        self,
        values: dict[str, str | bool],
        *,
        draft_id: str,
        completion_token: str,
    ) -> bytes:
        metadata = {
            "/MaterialOrderDraftId": draft_id,
            "/MaterialOrderCompletionToken": completion_token,
        }
        if self._pdf_builder_accepts_metadata:
            try:
                content = self.pdf_builder(values, metadata=metadata)
            except HTTPException:
                raise
            except (TypeError, ValueError) as error:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    str(error) or "Lagerbestellung enthält ungültige Werte.",
                ) from error
            if not isinstance(content, bytes) or not content.startswith(b"%PDF"):
                raise HTTPException(
                    status.HTTP_500_INTERNAL_SERVER_ERROR,
                    "Lagerbestellungs-PDF konnte nicht erzeugt werden.",
                )
            return content
        return _add_completion_metadata(
            self._build_pdf(values),
            draft_id=draft_id,
            completion_token=completion_token,
        )

    def _get_draft(
        self,
        *,
        site_id: int,
        draft_id: str,
        user_id: int,
        for_update: bool = False,
    ) -> MaterialOrderDraft:
        statement = select(MaterialOrderDraft).where(
            MaterialOrderDraft.id == draft_id,
            MaterialOrderDraft.site_id == site_id,
            MaterialOrderDraft.user_id == user_id,
        )
        if for_update:
            statement = statement.with_for_update()
        draft = self.db.scalar(statement.execution_options(populate_existing=True))
        if draft is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Lagerbestellungsentwurf nicht gefunden.")
        return draft

    @staticmethod
    def _ensure_editable(draft: MaterialOrderDraft) -> None:
        if draft.status != "draft":
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Die Lagerbestellung wurde bereits abgeschlossen.",
            )

    @staticmethod
    def _ensure_material_rows(values: dict[str, str | bool]) -> None:
        if any(
            isinstance(values.get(f"material_{index}"), str)
            and str(values[f"material_{index}"]).strip()
            for index in range(1, 24)
        ):
            return
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Bitte mindestens einen Materialeintrag ausfüllen.",
        )

    @staticmethod
    def _check_revision(draft: MaterialOrderDraft, expected_revision: int) -> None:
        if draft.revision != expected_revision:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Der Lagerbestellungsentwurf wurde inzwischen geändert. Bitte neu laden.",
            )

    @staticmethod
    def _completed_retry(
        draft: MaterialOrderDraft,
        expected_revision: int,
        values: dict[str, str | bool],
    ) -> MaterialOrderCompleteRead:
        is_retry_revision = expected_revision in {
            draft.revision,
            draft.completion_payload_revision,
        }
        if values != draft.values or not is_retry_revision or not draft.completed_document:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Die Lagerbestellung wurde bereits abgeschlossen.",
            )
        return MaterialOrderCompleteRead(
            draft=MaterialOrderDraftRead.model_validate(draft),
            document=ProjectFolderDocumentItem.model_validate(draft.completed_document),
        )


def material_order_filename(moment: datetime) -> str:
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=MATERIAL_ORDER_TIMEZONE)
    return f"{moment.astimezone(MATERIAL_ORDER_TIMEZONE):%y%m%d}{MATERIAL_ORDER_FILENAME_SUFFIX}"


def upload_material_order_pdf_without_overwrite(
    *,
    storage: ProjectStorageService,
    drive_id: str,
    folder_item_id: str,
    filename: str,
    content: bytes,
    draft_id: str | None = None,
    completion_token: str | None = None,
    recover_reserved_upload: bool = True,
    reserve_filename: Callable[[str], None] | None = None,
) -> ProjectFolderDocumentItem:
    candidate_number = _filename_number(filename)
    base_filename = _base_filename(filename)
    conflict_retries = 0
    check_existing = recover_reserved_upload
    while candidate_number <= 9999:
        candidate = _numbered_filename(base_filename, candidate_number)
        if check_existing:
            existing = _find_material_order_item_by_name(
                storage=storage,
                drive_id=drive_id,
                folder_item_id=folder_item_id,
                filename=candidate,
            )
            if existing is not None:
                recovered = _recover_reserved_upload(
                    storage=storage,
                    drive_id=drive_id,
                    folder_item_id=folder_item_id,
                    item=existing,
                    draft_id=draft_id,
                    completion_token=completion_token,
                )
                if recovered is not None:
                    return recovered
                candidate_number += 1
                conflict_retries = 0
                # The next candidate has not produced a conflict. Reserve it
                # and attempt the fail-on-conflict PUT directly.
                check_existing = False
                continue
            check_existing = False
        if reserve_filename is not None and candidate != filename:
            reserve_filename(candidate)
            filename = candidate
        encoded_drive_id = quote(drive_id, safe="")
        encoded_folder_id = quote(folder_item_id, safe="")
        encoded_filename = quote(candidate, safe="")
        path = (
            f"/drives/{encoded_drive_id}/items/{encoded_folder_id}:/{encoded_filename}:/content"
            "?@microsoft.graph.conflictBehavior=fail"
        )
        try:
            response = storage.graph_client.put_content(
                path, content, content_type="application/pdf"
            )
        except MicrosoftGraphRequestError as error:
            if error.status_code == status.HTTP_409_CONFLICT or error.error_code in {
                "nameAlreadyExists",
                "resourceAlreadyExists",
            }:
                conflict_retries += 1
                if conflict_retries <= 3:
                    # A failed PUT is the only fresh-upload case that needs an
                    # exact lookup. It may be another request for this draft,
                    # which must be recovered by token rather than suffixed.
                    check_existing = True
                    continue
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    "Dateikonflikt in SharePoint konnte nicht sicher aufgelöst werden.",
                ) from error
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY,
                "Lagerbestellung konnte nicht in SharePoint gespeichert werden.",
            ) from error
        except MicrosoftGraphConfigError as error:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "Microsoft Graph ist nicht vollständig konfiguriert.",
            ) from error
        return _uploaded_document(response, fallback_name=candidate)
    raise HTTPException(
        status.HTTP_409_CONFLICT,
        "Für das heutige Datum sind zu viele Lagerbestellungen vorhanden.",
    )


def _first_unlisted_material_order_filename(
    filename: str,
    existing_names: set[str],
) -> str:
    candidate_number = _filename_number(filename)
    base_filename = _base_filename(filename)
    normalized_names = {name.casefold() for name in existing_names}
    while candidate_number <= 9999:
        candidate = _numbered_filename(base_filename, candidate_number)
        if candidate.casefold() not in normalized_names:
            return candidate
        candidate_number += 1
    raise HTTPException(
        status.HTTP_409_CONFLICT,
        "Für das heutige Datum sind zu viele Lagerbestellungen vorhanden.",
    )


def _numbered_filename(filename: str, number: int) -> str:
    if number <= 1:
        return filename
    stem, separator, extension = filename.rpartition(".")
    if not separator:
        return f"{filename}_{number:02d}"
    return f"{stem}_{number:02d}.{extension}"


def _base_filename(filename: str) -> str:
    stem, separator, extension = filename.rpartition(".")
    if not separator:
        return filename
    stem = re.sub(r"_\d{2,}$", "", stem)
    return f"{stem}.{extension}"


def _filename_number(filename: str) -> int:
    stem = filename.rpartition(".")[0]
    match = re.search(r"_(\d{2,})$", stem)
    if match:
        return max(2, int(match.group(1)))
    return 1


def _add_completion_metadata(
    content: bytes,
    *,
    draft_id: str,
    completion_token: str,
) -> bytes:
    try:
        reader = PdfReader(BytesIO(content))
        writer = PdfWriter()
        writer.clone_document_from_reader(reader)
        metadata = {
            str(key): str(value)
            for key, value in (reader.metadata or {}).items()
            if isinstance(key, str) and value is not None
        }
        metadata.update(
            {
                "/MaterialOrderDraftId": draft_id,
                "/MaterialOrderCompletionToken": completion_token,
            }
        )
        writer.add_metadata(metadata)
        output = BytesIO()
        writer.write(output)
        return output.getvalue()
    except Exception as error:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "Lagerbestellungs-PDF konnte nicht für einen sicheren Abschluss vorbereitet werden.",
        ) from error


def _recover_reserved_upload(
    *,
    storage: ProjectStorageService,
    drive_id: str,
    folder_item_id: str,
    item: dict[str, Any],
    draft_id: str | None,
    completion_token: str | None,
) -> ProjectFolderDocumentItem | None:
    if not draft_id or not completion_token or not item.get("id"):
        return None
    if item.get("is_folder"):
        return None
    # A failed download is ambiguous and must fail the request; treating it as a
    # foreign file could create an unnecessary duplicate.
    download = storage.download_file_from_folder(
        drive_id=drive_id,
        folder_item_id=folder_item_id,
        item_id=str(item["id"]),
    )
    try:
        metadata = PdfReader(BytesIO(bytes(download["content"]))).metadata or {}
    except Exception:
        return None
    if (
        metadata.get("/MaterialOrderDraftId") != draft_id
        or metadata.get("/MaterialOrderCompletionToken") != completion_token
    ):
        return None
    return ProjectFolderDocumentItem.model_validate(item)


def _find_material_order_item_by_name(
    *,
    storage: ProjectStorageService,
    drive_id: str,
    folder_item_id: str,
    filename: str,
) -> dict[str, Any] | None:
    graph_get = getattr(storage.graph_client, "get", None)
    if not callable(graph_get):
        # Lightweight adapters may only expose the public list API. Production
        # uses the exact Graph path below, independent of children pagination.
        return next(
            (
                item
                for item in storage.list_folder_children(
                    drive_id=drive_id,
                    folder_item_id=folder_item_id,
                )
                if str(item.get("name") or "").casefold() == filename.casefold()
            ),
            None,
        )

    encoded_drive_id = quote(drive_id, safe="")
    encoded_folder_id = quote(folder_item_id, safe="")
    encoded_filename = quote(filename, safe="")
    path = (
        f"/drives/{encoded_drive_id}/items/{encoded_folder_id}:/{encoded_filename}"
        "?$select=id,name,webUrl,size,createdDateTime,lastModifiedDateTime,file,folder"
    )
    try:
        item = graph_get(path)
    except MicrosoftGraphRequestError as error:
        if error.status_code == status.HTTP_404_NOT_FOUND:
            return None
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            "Lagerbestellungen konnten in SharePoint nicht geprüft werden.",
        ) from error
    except MicrosoftGraphConfigError as error:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Microsoft Graph ist nicht vollständig konfiguriert.",
        ) from error
    if not isinstance(item, dict) or not item.get("id"):
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            "SharePoint hat eine ungültige Dateiinformation zurückgegeben.",
        )
    name = item.get("name")
    file_info = item.get("file") if isinstance(item.get("file"), dict) else {}
    is_folder = isinstance(item.get("folder"), dict)
    return {
        "id": str(item["id"]),
        "name": name if isinstance(name, str) and name else filename,
        "web_url": item.get("webUrl"),
        "size": item.get("size") if isinstance(item.get("size"), int) else None,
        "created_date_time": item.get("createdDateTime"),
        "last_modified_date_time": item.get("lastModifiedDateTime"),
        "mime_type": file_info.get("mimeType"),
        "file_extension": (
            str(name).rsplit(".", 1)[-1].lower()
            if isinstance(name, str) and "." in name and not is_folder
            else None
        ),
        "is_folder": is_folder,
    }


def _uploaded_document(
    response: dict[str, Any],
    *,
    fallback_name: str,
) -> ProjectFolderDocumentItem:
    item_id = response.get("id")
    if not isinstance(item_id, str) or not item_id:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            "SharePoint hat keine Dokument-ID zurückgegeben.",
        )
    name = response.get("name")
    if not isinstance(name, str) or not name:
        name = fallback_name
    file_info = response.get("file") if isinstance(response.get("file"), dict) else {}
    return ProjectFolderDocumentItem(
        id=item_id,
        name=name,
        web_url=response.get("webUrl"),
        size=response.get("size") if isinstance(response.get("size"), int) else None,
        created_date_time=response.get("createdDateTime"),
        last_modified_date_time=response.get("lastModifiedDateTime"),
        mime_type=file_info.get("mimeType") or "application/pdf",
        file_extension="pdf",
        is_folder=False,
    )


class _CompletionAlreadyFinalized(Exception):
    def __init__(self, draft: MaterialOrderDraft) -> None:
        self.draft = draft
        super().__init__("Material order already finalized.")
