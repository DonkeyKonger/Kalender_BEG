from __future__ import annotations

import calendar
import hashlib
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, timedelta
from io import BytesIO
from zipfile import ZIP_DEFLATED, ZipFile
from xml.sax.saxutils import escape

from fastapi import HTTPException, status
from sqlalchemy import and_, select
from sqlalchemy.orm import Session, selectinload

from app.models.absence import Absence
from app.models.enums import PersonType, UserRole
from app.models.person import Person
from app.models.person_work_day import PersonWorkDay
from app.models.payroll_daily_ledger import PAYROLL_LEDGER_CUTOVER_DATE
from app.models.payroll_month import (
    PAYROLL_MONTH_LOCKED,
    PAYROLL_PERSON_MONTH_APPROVED,
    PayrollMonthArtifact,
    PayrollMonthPeriod,
    PayrollMonthPersonApproval,
    PayrollMonthPersonApprovalArtifact,
    PayrollMonthSnapshot,
)
from app.models.user import User
from app.models.work_time_entry import WorkTimeEntry
from app.services.payroll_month_xlsx_service import (
    PayrollMonthSheet,
    build_payroll_months_xlsx,
)
from app.services.time_entry_service import TimeEntryService
from app.services.payroll_approved_workbook_merge import merge_approved_payroll_workbooks


class PayrollMonthExportService:
    def __init__(self, db: Session) -> None:
        self.db = db

    def worker_export(
        self,
        *,
        person_id: int,
        year: int,
        month: int,
        current_user: User,
        version: int | None = None,
    ) -> bytes:
        if _is_legacy_month(year, month):
            return self.build_worker_export_from_live_data(
                person_id=person_id,
                year=year,
                month=month,
                current_user=current_user,
                opening_balance_minutes=None,
                closing_balance_minutes=None,
            )
        period = self.db.scalar(
            select(PayrollMonthPeriod).where(
                PayrollMonthPeriod.year == year,
                PayrollMonthPeriod.month == month,
            )
        )
        if period is None or period.status != PAYROLL_MONTH_LOCKED:
            return self._approved_person_month_artifact(
                person_id=person_id,
                year=year,
                month=month,
            ).content
        return self._locked_artifact(
            year=year,
            month=month,
            artifact_key=f"worker:{person_id}",
            version=version,
        ).content

    def _approved_person_month_artifact(
        self,
        *,
        person_id: int,
        year: int,
        month: int,
    ) -> PayrollMonthPersonApprovalArtifact:
        approval = self.db.scalar(
            select(PayrollMonthPersonApproval).where(
                PayrollMonthPersonApproval.year == year,
                PayrollMonthPersonApproval.month == month,
                PayrollMonthPersonApproval.person_id == person_id,
                PayrollMonthPersonApproval.status == PAYROLL_PERSON_MONTH_APPROVED,
            )
        )
        if approval is None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "payroll_person_month_not_approved",
                    "message": "Die Einzelabrechnung ist erst nach dem Monteurabschluss verfügbar.",
                },
            )
        artifact = self.db.scalar(
            select(PayrollMonthPersonApprovalArtifact).where(
                PayrollMonthPersonApprovalArtifact.approval_id == approval.id,
                PayrollMonthPersonApprovalArtifact.approval_version == approval.approval_version,
            )
        )
        if artifact is None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "payroll_person_month_snapshot_missing",
                    "message": "Der geprüfte Monteurmonat besitzt keine aktive Abschlussreferenz.",
                },
            )
        if (
            artifact.byte_size != len(artifact.content)
            or artifact.content_sha256 != hashlib.sha256(artifact.content).hexdigest()
        ):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "payroll_person_month_artifact_corrupt",
                    "person_id": person_id,
                    "year": year,
                    "month": month,
                    "approval_version": approval.approval_version,
                    "message": "Die gespeicherte Einzelabrechnung ist beschädigt und wird nicht ausgeliefert.",
                },
            )
        return artifact

    def build_worker_export_from_live_data(
        self,
        *,
        person_id: int,
        year: int,
        month: int,
        current_user: User,
        opening_balance_minutes: int | None,
        closing_balance_minutes: int | None,
    ) -> bytes:
        """Build close-time bytes; never expose this as a download endpoint."""
        source = self.load_live_source(year=year, month=month, current_user=current_user)
        return self.build_worker_export_from_source(
            source=source,
            person_id=person_id,
            opening_balance_minutes=opening_balance_minutes,
            closing_balance_minutes=closing_balance_minutes,
        )

    def build_worker_export_from_source(
        self,
        *,
        source: "PayrollMonthSourceBundle",
        person_id: int,
        opening_balance_minutes: int | None,
        closing_balance_minutes: int | None,
    ) -> bytes:
        person = next((item for item in source.people if item.id == person_id), None)
        if person is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Person nicht gefunden.")
        return build_payroll_months_xlsx(
            [
                PayrollMonthSheet(
                    person=person,
                    sheet_name=person.display_name,
                    year=source.year,
                    month=source.month,
                    entries=[entry for entry in source.entries if entry.person_id == person_id],
                    absences=[absence for absence in source.absences if absence.person_id == person_id],
                    work_days=[day for day in source.work_days if day.person_id == person_id],
                    non_working_dates=source.holidays,
                    opening_balance_minutes=opening_balance_minutes,
                    closing_balance_minutes=closing_balance_minutes,
                )
            ]
        ).content

    def build_worker_approved_state_fallback(
        self,
        *,
        source: "PayrollMonthSourceBundle",
        person_id: int,
    ) -> bytes:
        """Create a deterministic raw-data workbook when derived payroll fields fail.

        The fallback contains only persisted, reviewed source values. It deliberately
        leaves unavailable derived balances out instead of inventing replacements.
        """

        person = next((item for item in source.people if item.id == person_id), None)
        if person is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Person nicht gefunden.")
        month_start = date(source.year, source.month, 1)
        month_end = date(source.year, source.month, calendar.monthrange(source.year, source.month)[1])
        rows: list[list[object]] = [
            ["Freigegebener Monteurmonat", person.display_name],
            ["Zeitraum", f"{month_start.strftime('%d.%m.%Y')} bis {month_end.strftime('%d.%m.%Y')}"],
            [],
            ["Datum", "Beginn", "Ende", "Pause (Min.)", "Arbeitszeit (Min.)", "Baustelle", "Notiz", "Quelle"],
        ]
        for entry in sorted(
            (
                item for item in source.entries
                if item.person_id == person_id and month_start <= item.work_date <= month_end
            ),
            key=lambda item: (item.work_date, item.id),
        ):
            site = entry.site or entry.original_site
            site_label = ""
            if site is not None:
                site_label = " · ".join(
                    str(part) for part in (getattr(site, "site_number", None), getattr(site, "name", None))
                    if part
                )
            rows.append([
                entry.work_date.strftime("%d.%m.%Y"),
                entry.payroll_corrected_start_time or entry.start_time or "",
                entry.payroll_corrected_end_time or entry.end_time or "",
                entry.payroll_corrected_break_minutes if entry.payroll_corrected_break_minutes is not None else entry.break_minutes,
                _approved_entry_minutes(entry),
                site_label,
                entry.note or "",
                entry.source or "",
            ])
        for absence in sorted(
            (
                item for item in source.absences
                if item.person_id == person_id
                and item.start_date <= month_end
                and item.end_date >= month_start
            ),
            key=lambda item: (item.start_date, item.id),
        ):
            rows.append([
                f"{max(absence.start_date, month_start).strftime('%d.%m.%Y')} bis {min(absence.end_date, month_end).strftime('%d.%m.%Y')}",
                "",
                "",
                "",
                "",
                "",
                absence.absence_type.value,
                "Abwesenheit",
            ])
        return _build_simple_xlsx(rows, sheet_name="Freigegebener Stand")

    def all_workers_export(
        self,
        *,
        year: int,
        month: int,
        current_user: User,
        version: int | None = None,
    ) -> bytes:
        if _is_legacy_month(year, month):
            source = self.load_live_source(
                year=year,
                month=month,
                current_user=current_user,
            )
            return self.build_all_workers_export_from_source(
                source=source,
                balances_by_person={person.id: (None, None) for person in source.people},
            )
        month_status = self.db.scalar(select(PayrollMonthPeriod.status).where(
            PayrollMonthPeriod.year == year, PayrollMonthPeriod.month == month,
        ))
        if month_status != PAYROLL_MONTH_LOCKED and version is None:
            return self._approved_workers_export(year=year, month=month)
        # Existing locked snapshots/versioned links retain their exact semantics.
        return self._locked_artifact(
            year=year,
            month=month,
            artifact_key="all_workers",
            version=version,
        ).content

    def _approved_workers_export(self, *, year: int, month: int) -> bytes:
        """Package existing individual approvals without closing or booking a month."""
        people = self.payroll_people()
        if not people:
            raise HTTPException(404, "Keine aktiven Monteure gefunden.")
        # Read current approval versions and their artifacts together: never mix
        # a reopened approval with an older retained version or rebuild live data.
        rows = self.db.execute(
            select(PayrollMonthPersonApproval, PayrollMonthPersonApprovalArtifact)
            .outerjoin(PayrollMonthPersonApprovalArtifact, and_(
                PayrollMonthPersonApprovalArtifact.approval_id == PayrollMonthPersonApproval.id,
                PayrollMonthPersonApprovalArtifact.approval_version
                == PayrollMonthPersonApproval.approval_version,
            ))
            .where(
                PayrollMonthPersonApproval.year == year,
                PayrollMonthPersonApproval.month == month,
                PayrollMonthPersonApproval.person_id.in_({person.id for person in people}),
                PayrollMonthPersonApproval.status == PAYROLL_PERSON_MONTH_APPROVED,
            ).execution_options(populate_existing=True)
        ).all()
        approved = {approval.person_id: (approval, artifact) for approval, artifact in rows}
        if len(approved) != len(people):
            raise HTTPException(409, {
                "code": "payroll_person_month_not_approved",
                "message": "Der Gesamtdownload ist verfügbar, sobald jeder Monteurmonat einzeln geprüft ist.",
            })
        workbooks = []
        for person in people:
            approval, artifact = approved[person.id]
            if artifact is None:
                raise HTTPException(409, {
                    "code": "payroll_person_month_snapshot_missing",
                    "person_id": person.id,
                    "message": "Der geprüfte Monteurmonat besitzt keine aktive Abschlussreferenz.",
                })
            if (
                artifact.byte_size != len(artifact.content)
                or artifact.content_sha256 != hashlib.sha256(artifact.content).hexdigest()
            ):
                raise HTTPException(409, {
                    "code": "payroll_person_month_artifact_corrupt",
                    "person_id": person.id, "year": year, "month": month,
                    "approval_version": approval.approval_version,
                    "message": "Eine gespeicherte Einzelabrechnung ist beschädigt und wird nicht ausgeliefert.",
                })
            workbooks.append((person.display_name, artifact.content))
        try:
            return merge_approved_payroll_workbooks(workbooks)
        except ValueError as error:
            raise HTTPException(409, {
                "code": "payroll_approved_workbooks_incompatible",
                "message": "Die freigegebenen Excel-Stände sind nicht gemeinsam exportierbar. Betroffene Monteurmonate erneut freigeben.",
                "reason": str(error),
            }) from error

    def build_all_workers_export_from_live_data(
        self,
        *,
        year: int,
        month: int,
        current_user: User,
        balances_by_person: dict[int, tuple[int | None, int | None]],
    ) -> bytes:
        """Build the immutable combined artifact inside the close transaction."""
        source = self.load_live_source(year=year, month=month, current_user=current_user)
        return self.build_all_workers_export_from_source(
            source=source,
            balances_by_person=balances_by_person,
        )

    def build_all_workers_export_from_source(
        self,
        *,
        source: "PayrollMonthSourceBundle",
        balances_by_person: dict[int, tuple[int | None, int | None]],
    ) -> bytes:
        if not source.people:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Keine aktiven Monteure gefunden.")
        person_ids = {person.id for person in source.people}
        entries_by_person: dict[int, list[WorkTimeEntry]] = defaultdict(list)
        for entry in source.entries:
            if entry.person_id in person_ids:
                entries_by_person[entry.person_id].append(entry)

        absences_by_person: dict[int, list[Absence]] = defaultdict(list)
        for absence in source.absences:
            absences_by_person[absence.person_id].append(absence)
        work_days_by_person: dict[int, list[PersonWorkDay]] = defaultdict(list)
        for work_day in source.work_days:
            work_days_by_person[work_day.person_id].append(work_day)

        return build_payroll_months_xlsx(
            [
                PayrollMonthSheet(
                    person=person,
                    sheet_name=person.display_name,
                    year=source.year,
                    month=source.month,
                    entries=entries_by_person[person.id],
                    absences=absences_by_person[person.id],
                    work_days=work_days_by_person[person.id],
                    non_working_dates=source.holidays,
                    opening_balance_minutes=balances_by_person[person.id][0],
                    closing_balance_minutes=balances_by_person[person.id][1],
                )
                for person in source.people
            ]
        ).content

    def load_live_source(
        self,
        *,
        year: int,
        month: int,
        current_user: User,
    ) -> "PayrollMonthSourceBundle":
        people = self.payroll_people()
        if not people:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Keine aktiven Monteure gefunden.")
        period_start, period_end = payroll_month_source_range(year, month)
        entries = TimeEntryService(self.db).list_entries(
            current_user=current_user,
            date_from=period_start,
            date_to=period_end,
        )
        person_ids = {person.id for person in people}
        return PayrollMonthSourceBundle(
            year=year,
            month=month,
            period_start=period_start,
            period_end=period_end,
            people=tuple(people),
            entries=tuple(entry for entry in entries if entry.person_id in person_ids),
            absences=tuple(self._absences(period_start, period_end, person_ids=person_ids)),
            work_days=tuple(self._work_days(period_start, period_end, person_ids=person_ids)),
            holidays=frozenset(lower_saxony_public_holiday_dates(period_start, period_end)),
        )

    @staticmethod
    def source_manifest(source: "PayrollMonthSourceBundle") -> dict[str, object]:
        """Serializable copy of every live input used by the retained workbook."""
        return {
            "source_start": source.period_start.isoformat(),
            "source_end": source.period_end.isoformat(),
            "holidays": sorted(item.isoformat() for item in source.holidays),
            "people": [
                {
                    "id": person.id,
                    "display_name": person.display_name,
                    "weekly_hours": person.weekly_hours,
                }
                for person in source.people
            ],
            "entries": [
                {
                    "id": entry.id,
                    "person_id": entry.person_id,
                    "work_date": entry.work_date.isoformat(),
                    "original_work_date": (
                        entry.original_work_date.isoformat()
                        if entry.original_work_date else None
                    ),
                    "start_time": entry.start_time.isoformat() if entry.start_time else None,
                    "end_time": entry.end_time.isoformat() if entry.end_time else None,
                    "break_minutes": entry.break_minutes,
                    "travel_minutes": entry.travel_minutes,
                    "work_minutes": entry.work_minutes,
                    "original_work_minutes": entry.original_work_minutes,
                    "corrected_work_minutes": entry.corrected_work_minutes,
                    "payroll_corrected_start_time": (
                        entry.payroll_corrected_start_time.isoformat()
                        if entry.payroll_corrected_start_time else None
                    ),
                    "payroll_corrected_end_time": (
                        entry.payroll_corrected_end_time.isoformat()
                        if entry.payroll_corrected_end_time else None
                    ),
                    "payroll_corrected_break_minutes": entry.payroll_corrected_break_minutes,
                    "payroll_corrected_work_minutes": entry.payroll_corrected_work_minutes,
                    "site_id": entry.site_id,
                    "site": _site_manifest(entry.site),
                    "original_site_id": entry.original_site_id,
                    "original_site": _site_manifest(entry.original_site),
                    "assignment_id": entry.assignment_id,
                    "assignment": _assignment_manifest(entry.assignment),
                    "note": entry.note,
                    "source": entry.source,
                    "status": entry.status,
                    "time_review_status": entry.time_review_status,
                    "time_review_method": entry.time_review_method,
                    "reviewed_by_user_id": entry.reviewed_by_user_id,
                    "reviewed_at": entry.reviewed_at.isoformat() if entry.reviewed_at else None,
                    "payroll_reviewed_by_user_id": entry.payroll_reviewed_by_user_id,
                    "payroll_reviewed_at": (
                        entry.payroll_reviewed_at.isoformat()
                        if entry.payroll_reviewed_at else None
                    ),
                    "work_day": _work_day_manifest(entry.work_day),
                }
                for entry in sorted(source.entries, key=lambda item: item.id)
            ],
            "absences": [
                {
                    "id": absence.id,
                    "person_id": absence.person_id,
                    "absence_type": absence.absence_type.value,
                    "status": absence.status.value,
                    "start_date": absence.start_date.isoformat(),
                    "end_date": absence.end_date.isoformat(),
                }
                for absence in sorted(source.absences, key=lambda item: item.id)
            ],
            "work_days": [
                {
                    "id": work_day.id,
                    "person_id": work_day.person_id,
                    "work_date": work_day.work_date.isoformat(),
                    "overnight_status": work_day.overnight_status,
                }
                for work_day in sorted(source.work_days, key=lambda item: item.id)
            ],
        }

    def payroll_people(self) -> list[Person]:
        people = list(
            self.db.scalars(
                select(Person)
                .options(selectinload(Person.users))
                .where(
                    Person.is_active.is_(True),
                    Person.deleted_at.is_(None),
                    Person.person_type == PersonType.INTERNAL,
                )
                .order_by(Person.display_name.asc(), Person.id.asc())
            )
        )
        return [person for person in people if is_payroll_review_person(person)]

    def _locked_artifact(
        self,
        *,
        year: int,
        month: int,
        artifact_key: str,
        version: int | None = None,
    ) -> PayrollMonthArtifact:
        period = self.db.scalar(
            select(PayrollMonthPeriod).where(
                PayrollMonthPeriod.year == year,
                PayrollMonthPeriod.month == month,
            )
        )
        if period is None or period.status != PAYROLL_MONTH_LOCKED:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "payroll_month_not_locked",
                    "year": year,
                    "month": month,
                    "message": "Die Monatsabrechnung steht erst nach einem erfolgreichen Monatsabschluss bereit.",
                },
            )
        if version is not None and version != period.last_snapshot_version:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "payroll_snapshot_version_stale",
                    "requested_version": version,
                    "current_version": period.last_snapshot_version,
                    "message": "Der Monatsabschluss wurde inzwischen neu versioniert. Laden Sie den aktuellen Status erneut.",
                },
            )
        snapshot = self.db.scalar(
            select(PayrollMonthSnapshot).where(
                PayrollMonthSnapshot.period_id == period.id,
                PayrollMonthSnapshot.version == period.last_snapshot_version,
            )
        )
        if snapshot is None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {"code": "payroll_snapshot_missing", "message": "Der gesperrte Monat besitzt keinen gültigen Snapshot."},
            )
        artifact = self.db.scalar(
            select(PayrollMonthArtifact).where(
                PayrollMonthArtifact.snapshot_id == snapshot.id,
                PayrollMonthArtifact.artifact_key == artifact_key,
            )
        )
        if artifact is None:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND,
                {"code": "payroll_artifact_missing", "message": "Für diesen Snapshot ist keine Abrechnung vorhanden."},
            )
        if (
            artifact.byte_size != len(artifact.content)
            or artifact.content_sha256 != hashlib.sha256(artifact.content).hexdigest()
        ):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "payroll_artifact_corrupt",
                    "snapshot_id": snapshot.id,
                    "snapshot_version": snapshot.version,
                    "artifact_key": artifact_key,
                    "message": "Das gespeicherte Export-Artefakt ist beschädigt und wird nicht ausgeliefert.",
                },
            )
        return artifact

    def _work_days(
        self, period_start: date, period_end: date, *, person_ids: set[int]
    ) -> list[PersonWorkDay]:
        # Auch Hotelnächte ohne Arbeitsbuchung sowie Randtage sind verbindlich.
        return list(self.db.scalars(select(PersonWorkDay).where(
            PersonWorkDay.person_id.in_(person_ids),
            PersonWorkDay.work_date >= period_start,
            PersonWorkDay.work_date <= period_end,
        )))

    def _absences(
        self,
        period_start: date,
        period_end: date,
        *,
        person_id: int | None = None,
        person_ids: set[int] | None = None,
    ) -> list[Absence]:
        statement = select(Absence).where(
            Absence.start_date <= period_end,
            Absence.end_date >= period_start,
        )
        if person_id is not None:
            statement = statement.where(Absence.person_id == person_id)
        elif person_ids is not None:
            statement = statement.where(Absence.person_id.in_(person_ids))
        return list(self.db.scalars(statement))


def is_payroll_review_person(person: Person) -> bool:
    active_roles = {user.role for user in person.users if user.is_active}
    return not active_roles or active_roles == {UserRole.MONTEUR}


def _is_legacy_month(year: int, month: int) -> bool:
    """Legacy months stay downloadable; no post-cutover live fallback exists."""
    return date(year, month, 1) < PAYROLL_LEDGER_CUTOVER_DATE


def _site_manifest(site) -> dict[str, object] | None:
    if site is None:
        return None
    return {
        "id": site.id,
        "site_number": site.site_number,
        "name": site.name,
        "location": site.location,
        "address": site.address,
        "postal_code": site.postal_code,
        "city": site.city,
        "street": site.street,
        "house_number": site.house_number,
        "address_extra": site.address_extra,
    }


def _assignment_manifest(assignment) -> dict[str, object] | None:
    if assignment is None:
        return None
    return {
        "id": assignment.id,
        "person_id": assignment.person_id,
        "site_id": assignment.site_id,
        "start_date": assignment.start_date.isoformat(),
        "end_date": assignment.end_date.isoformat(),
        "site": _site_manifest(assignment.site),
    }


def _work_day_manifest(work_day) -> dict[str, object] | None:
    if work_day is None:
        return None
    return {
        "id": work_day.id,
        "person_id": work_day.person_id,
        "work_date": work_day.work_date.isoformat(),
        "overnight_status": work_day.overnight_status,
    }


def _approved_entry_minutes(entry: WorkTimeEntry) -> int | str:
    for value in (
        entry.payroll_corrected_work_minutes,
        entry.corrected_work_minutes,
        entry.work_minutes,
        entry.original_work_minutes,
    ):
        if value is not None:
            return int(value)
    return ""


def _build_simple_xlsx(rows: list[list[object]], *, sheet_name: str) -> bytes:
    worksheet_rows: list[str] = []
    for row_index, row in enumerate(rows, start=1):
        cells = "".join(
            _simple_xlsx_cell(row_index, column_index, value)
            for column_index, value in enumerate(row, start=1)
            if value not in (None, "")
        )
        worksheet_rows.append(f'<row r="{row_index}">{cells}</row>')
    worksheet = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        '<sheetData>' + "".join(worksheet_rows) + '</sheetData></worksheet>'
    )
    workbook = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        f'<sheets><sheet name="{escape(sheet_name)}" sheetId="1" r:id="rId1"/></sheets></workbook>'
    )
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        '</Types>'
    )
    package_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
        '</Relationships>'
    )
    workbook_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
        '</Relationships>'
    )
    output = BytesIO()
    with ZipFile(output, "w", ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", content_types)
        archive.writestr("_rels/.rels", package_rels)
        archive.writestr("xl/workbook.xml", workbook)
        archive.writestr("xl/_rels/workbook.xml.rels", workbook_rels)
        archive.writestr("xl/worksheets/sheet1.xml", worksheet)
    return output.getvalue()


def _simple_xlsx_cell(row_index: int, column_index: int, value: object) -> str:
    reference = f"{_xlsx_column_name(column_index)}{row_index}"
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return f'<c r="{reference}"><v>{value}</v></c>'
    text = escape(str(value))
    return f'<c r="{reference}" t="inlineStr"><is><t xml:space="preserve">{text}</t></is></c>'


def _xlsx_column_name(index: int) -> str:
    result = ""
    while index:
        index, remainder = divmod(index - 1, 26)
        result = chr(65 + remainder) + result
    return result


@dataclass(frozen=True)
class PayrollMonthSourceBundle:
    year: int
    month: int
    period_start: date
    period_end: date
    people: tuple[Person, ...]
    entries: tuple[WorkTimeEntry, ...]
    absences: tuple[Absence, ...]
    work_days: tuple[PersonWorkDay, ...]
    holidays: frozenset[date]


def payroll_month_source_range(year: int, month: int) -> tuple[date, date]:
    first = date(year, month, 1)
    last = date(year, month, calendar.monthrange(year, month)[1])
    # Vollständige Randwochen plus mindestens ein Tag beiderseits des Monats:
    # Auch ein Monatsbeginn am Montag darf keine zweite Hotelanreise erzeugen.
    return (
        min(first - timedelta(days=first.weekday()), first - timedelta(days=1)),
        max(last + timedelta(days=6 - last.weekday()), last + timedelta(days=1)),
    )


def lower_saxony_public_holiday_dates(period_start: date, period_end: date) -> set[date]:
    result: set[date] = set()
    for year in range(period_start.year, period_end.year + 1):
        easter = easter_sunday(year)
        result.update(
            {
                date(year, 1, 1),
                easter - timedelta(days=2),
                easter + timedelta(days=1),
                date(year, 5, 1),
                easter + timedelta(days=39),
                easter + timedelta(days=50),
                date(year, 10, 3),
                date(year, 10, 31),
                date(year, 12, 25),
                date(year, 12, 26),
            }
        )
    return {day for day in result if period_start <= day <= period_end}


def easter_sunday(year: int) -> date:
    a = year % 19
    b, c = divmod(year, 100)
    d, e = divmod(b, 4)
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = divmod(c, 4)
    weekday_offset = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * weekday_offset) // 451
    month = (h + weekday_offset - 7 * m + 114) // 31
    day = (h + weekday_offset - 7 * m + 114) % 31 + 1
    return date(year, month, day)
