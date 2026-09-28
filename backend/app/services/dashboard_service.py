from __future__ import annotations

from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.absence import Absence
from app.models.assignment import Assignment
from app.models.enums import AbsenceStatus, AbsenceType, PersonType, UserRole
from app.models.person import Person
from app.models.site import Site
from app.models.user import User
from app.models.work_time_entry import WorkTimeEntry
from app.schemas.matrix import MatrixPerson, MatrixResponse, MatrixRow
from app.services.conflict_service import BLOCKED_SITE_STATUSES, HARD_ABSENCE_TYPES
from app.services.matrix_service import MatrixService
from app.services.person_display import calendar_short_code, calendar_short_code_from_values
from app.services.payroll_daily_ledger_service import lower_saxony_public_holidays
from app.services.person_hours_account_service import effective_weekly_work_minutes


def staffing_dates(today: date) -> list[date]:
    """Eight weekdays from today; public holidays remain visible weekdays."""
    days = []
    cursor = today
    while len(days) < 8:
        if cursor.weekday() < 5:
            days.append(cursor)
        cursor += timedelta(days=1)
    return days


class DashboardService:
    def __init__(self, db: Session) -> None:
        self.db = db

    def get_overview(
        self,
        *,
        history_start: date,
        today: date,
        tomorrow: date,
        week_end: date,
        next_week_start: date,
        next_week_end: date,
    ) -> dict:
        overview_end = max(next_week_end, staffing_dates(today)[-1])
        matrix = MatrixService(self.db).get_matrix(
            start=history_start,
            end=overview_end,
            include_weekends=True,
        )
        today_assigned_sites = self._assigned_sites_for_day(matrix, today)
        tomorrow_assigned_sites = self._assigned_sites_for_day(matrix, tomorrow)
        open_staffing_needs = self._open_staffing_needs(matrix.rows, today, overview_end)
        conflicts = self._conflicts(matrix.rows, today, overview_end)
        active_workers = self._active_dashboard_workers(matrix.rows)
        today_assigned_person_ids = self._assigned_person_ids_for_day(matrix.rows, today)
        today_absences = self._absences_for_day(matrix.rows, today)
        last_manager_by_person_id = self._last_manager_by_person_id(matrix.rows, today)
        free_workers = [
            worker
            for worker in active_workers
            if worker.id not in today_assigned_person_ids and worker.id not in today_absences
        ]
        worker_summary_groups = self._worker_summary_groups_for_day(
            matrix.rows,
            today,
            active_workers,
            free_workers,
        )

        return {
            "staffingDays": self._staffing_days(matrix.rows, today),
            "todayAssignedSites": today_assigned_sites,
            "todayAssignedSiteGroups": self._group_assigned_sites_by_manager(today_assigned_sites),
            "workerSummaryGroups": worker_summary_groups,
            "totalWorkerSummaryPeople": sum(len(group["people"]) for group in worker_summary_groups),
            "freeWorkerGroups": self._group_free_workers_by_last_manager(free_workers, last_manager_by_person_id),
            "totalFreeWorkers": len(free_workers),
            "openStaffingNeeds": open_staffing_needs,
            "conflicts": conflicts,
            "tomorrowAssignedCount": len(tomorrow_assigned_sites),
            "tomorrowOpenNeeds": [
                need for need in open_staffing_needs if need["date"] == tomorrow.isoformat()
            ],
            "tomorrowConflicts": [
                conflict for conflict in conflicts if conflict["date"] == tomorrow.isoformat()
            ],
            "currentWeekNeeds": [
                need for need in open_staffing_needs
                if today.isoformat() <= need["date"] <= week_end.isoformat()
            ],
            "nextWeekNeeds": [
                need for need in open_staffing_needs
                if next_week_start.isoformat() <= need["date"] <= next_week_end.isoformat()
            ],
            "workerLookup": self._worker_lookup(
                matrix.rows,
                active_workers,
                today,
                today_absences,
                last_manager_by_person_id,
            ),
        }

    def _staffing_days(self, rows: list[MatrixRow], today: date) -> list[dict]:
        """Eight weekdays; availability must not depend on visible matrix rows."""
        days = staffing_dates(today)
        end = days[-1]
        # External staff remain available only after recent calendar activity.
        # Use the same seven-day window (today plus six previous days) for the
        # whole forecast, not a window moving with each future column.
        recent_start = today - timedelta(days=6)
        manager_ids = select(Site.project_manager_person_id).where(
            Site.project_manager_person_id.is_not(None)
        )
        non_worker_ids = select(User.person_id).where(
            User.person_id.is_not(None),
            User.role.in_([UserRole.ADMIN, UserRole.OFFICE, UserRole.PROJECT_MANAGER]),
        )
        workers = list(self.db.scalars(select(Person).where(
            Person.deleted_at.is_(None),
            Person.is_active.is_(True),
            Person.employment_status == "active",
            Person.id.not_in(manager_ids),
            Person.id.not_in(non_worker_ids),
        ).order_by(Person.person_type != PersonType.INTERNAL, Person.display_name, Person.id)))
        # Query all assignments/absences, including people with no recent planning
        # and assignments on sites omitted from the matrix.
        assignments = list(self.db.scalars(select(Assignment).where(
            Assignment.start_date <= end, Assignment.end_date >= recent_start,
        )))
        absences = list(self.db.scalars(select(Absence).where(
            Absence.status == AbsenceStatus.ACTIVE,
            Absence.start_date <= end, Absence.end_date >= recent_start,
        )))
        recent_person_ids = {
            entry.person_id for entry in [*assignments, *absences]
            if entry.start_date <= today and entry.end_date >= recent_start
        }
        workers = [
            worker for worker in workers
            if worker.person_type == PersonType.INTERNAL or worker.id in recent_person_ids
        ]
        four_day_worker_ids = self._four_day_worker_ids({worker.id for worker in workers}, today)
        needs = self._open_staffing_needs(rows, today, end)
        holidays = lower_saxony_public_holidays(today, end)
        result = []
        for day in days:
            is_workday = day.weekday() < 5 and day not in holidays
            unavailable = {
                entry.person_id for entry in [*assignments, *absences]
                if entry.start_date <= day <= entry.end_date
            }
            if day.weekday() == 4:
                unavailable.update(four_day_worker_ids)
            result.append({
                "date": day.isoformat(),
                "isWorkday": is_workday,
                "nonWorkdayLabel": "Feiertag" if day in holidays else "Wochenende" if not is_workday else None,
                "needs": [need for need in needs if need["date"] == day.isoformat()],
                "freeWorkers": [
                    {**self._worker_person_summary(worker), "isExternal": worker.person_type != PersonType.INTERNAL}
                    for worker in workers if is_workday and worker.id not in unavailable
                ],
            })
        return result

    def _four_day_worker_ids(self, person_ids: set[int], today: date) -> set[int]:
        """Infer Mon–Thu availability only from three complete recorded weeks.

        Freeze the lookback at the current week's Monday for the entire forecast.
        Incomplete/new payroll records must not turn missing Fridays into a rule.
        This is a display filter, never a change to contracts, payroll or planning.
        """
        if not person_ids:
            return set()
        current_monday = today - timedelta(days=today.weekday())
        history_start = current_monday - timedelta(weeks=3)
        entries = self.db.scalars(select(WorkTimeEntry).where(
            WorkTimeEntry.person_id.in_(person_ids),
            WorkTimeEntry.work_date >= history_start,
            WorkTimeEntry.work_date < current_monday,
        ))
        work_dates_by_person: dict[int, set[date]] = {}
        for entry in entries:
            if effective_weekly_work_minutes(entry) > 0:
                work_dates_by_person.setdefault(entry.person_id, set()).add(entry.work_date)
        expected_dates = {
            history_start + timedelta(days=week * 7 + weekday)
            for week in range(3) for weekday in range(4)
        }
        return {
            person_id for person_id, work_dates in work_dates_by_person.items()
            if work_dates == expected_dates
        }

    def _assigned_sites_for_day(self, matrix: MatrixResponse, target_date: date) -> list[dict]:
        summaries: list[dict] = []
        for row in matrix.rows:
            cell = next((entry for entry in row.cells if entry.date == target_date), None)
            assignments = cell.assignments if cell else []
            if not assignments:
                continue
            external_count = sum(
                1
                for assignment in assignments
                if assignment.person.person_type.value != "internal"
            )
            summaries.append(
                {
                    "site": row.site.model_dump(mode="json"),
                    "managerLabel": self._manager_label(row.site.project_manager),
                    "internalCount": len(assignments) - external_count,
                    "externalCount": external_count,
                    "hasWarnings": cell.mark.value in {"red", "orange"} if cell and cell.mark else False,
                }
            )
        return sorted(summaries, key=lambda item: self._assigned_site_sort_key(item["site"]))

    def _group_assigned_sites_by_manager(self, sites: list[dict]) -> list[dict]:
        groups: dict[str, dict] = {}
        for site_summary in sites:
            manager = self._manager_summary(site_summary["site"].get("project_manager"))
            existing = groups.setdefault(manager["key"], {"manager": manager, "sites": []})
            existing["sites"].append(site_summary)

        grouped = []
        for group in groups.values():
            grouped.append(
                {
                    **group,
                    "sites": sorted(group["sites"], key=lambda item: self._assigned_site_sort_key(item["site"])),
                }
            )
        return sorted(grouped, key=self._assigned_group_sort_key)

    def _open_staffing_needs(self, rows: list[MatrixRow], start: date, end: date) -> list[dict]:
        needs: list[dict] = []
        for row in rows:
            for cell in row.cells:
                if cell.date < start or cell.date > end or cell.mark is None or cell.mark.value != "orange" or cell.assignments:
                    continue
                needs.append(
                    {
                        "date": cell.date.isoformat(),
                        "siteId": row.site.id,
                        "projectManagerPersonId": row.site.project_manager_person_id,
                        "siteName": row.site.name,
                        "siteNumber": row.site.site_number,
                        "managerLabel": self._manager_label(row.site.project_manager),
                    }
                )
        return sorted(needs, key=lambda item: (item["date"], item["siteName"]))

    def _conflicts(self, rows: list[MatrixRow], start: date, end: date) -> list[dict]:
        conflicts: dict[str, dict] = {}
        assignments_by_date_person: dict[str, dict] = {}
        blocking_absences: dict[str, str] = {}

        for row in rows:
            for cell in row.cells:
                if cell.date < start or cell.date > end:
                    continue
                date_key = cell.date.isoformat()

                for absence in cell.absences:
                    if absence.absence_type in HARD_ABSENCE_TYPES:
                        blocking_absences[
                            f"{date_key}:{absence.person.id}"
                        ] = self._absence_label(absence.absence_type)

                if row.site.status in BLOCKED_SITE_STATUSES and cell.assignments:
                    key = f"inactive:{row.site.id}:{date_key}"
                    conflicts[key] = {
                        "key": key,
                        "title": "Abgeschlossene Baustelle belegt",
                        "detail": row.site.name,
                        "severity": "hard",
                        "date": date_key,
                    }

                for assignment in cell.assignments:
                    bucket_key = f"{date_key}:{assignment.person.id}"
                    existing = assignments_by_date_person.setdefault(
                        bucket_key,
                        {
                            "date": date_key,
                            "personName": assignment.person.display_name,
                            "sites": set(),
                        },
                    )
                    existing["sites"].add(row.site.name)

        for key, entry in assignments_by_date_person.items():
            absence_type = blocking_absences.get(key)
            if absence_type:
                conflicts[f"absence:{key}"] = {
                    "key": f"absence:{key}",
                    "title": f"{absence_type} + Einsatz",
                    "detail": f"{entry['personName']} · {', '.join(sorted(entry['sites']))}",
                    "severity": "hard",
                    "date": entry["date"],
                }
            if len(entry["sites"]) > 2:
                conflicts[f"overbooked:{key}"] = {
                    "key": f"overbooked:{key}",
                    "title": "Mehr als zwei Einsaetze",
                    "detail": f"{entry['personName']} · {len(entry['sites'])} Baustellen",
                    "severity": "hard",
                    "date": entry["date"],
                }

        return sorted(conflicts.values(), key=lambda item: item["date"])

    def _active_dashboard_workers(self, rows: list[MatrixRow]) -> list[Person]:
        project_manager_ids = {
            row.site.project_manager_person_id
            for row in rows
            if row.site.project_manager_person_id is not None
        }
        workers = self.db.scalars(
            select(Person)
            .where(
                Person.deleted_at.is_(None),
                Person.is_active.is_(True),
                Person.person_type == PersonType.INTERNAL,
            )
            .order_by(Person.display_name, Person.id)
        )
        return [worker for worker in workers if worker.id not in project_manager_ids]

    def _assigned_person_ids_for_day(self, rows: list[MatrixRow], target_date: date) -> set[int]:
        person_ids: set[int] = set()
        for row in rows:
            cell = next((entry for entry in row.cells if entry.date == target_date), None)
            if cell is None:
                continue
            for assignment in cell.assignments:
                person_ids.add(assignment.person.id)
        return person_ids

    def _absences_for_day(self, rows: list[MatrixRow], target_date: date) -> dict[int, AbsenceType]:
        absences: dict[int, AbsenceType] = {}
        for row in rows:
            cell = next((entry for entry in row.cells if entry.date == target_date), None)
            if cell is None:
                continue
            for absence in cell.absences:
                absences[absence.person.id] = absence.absence_type
        return absences

    def _last_manager_by_person_id(self, rows: list[MatrixRow], target_date: date) -> dict[int, dict]:
        latest_by_person_id: dict[int, dict] = {}
        for row in rows:
            manager = self._matrix_manager_summary(row.site.project_manager)
            for cell in row.cells:
                if cell.date > target_date:
                    continue
                for assignment in cell.assignments:
                    existing = latest_by_person_id.get(assignment.person.id)
                    if existing is None or cell.date >= existing["date"]:
                        latest_by_person_id[assignment.person.id] = {
                            "date": cell.date,
                            "manager": manager,
                        }
        return {
            person_id: entry["manager"]
            for person_id, entry in latest_by_person_id.items()
        }

    def _group_free_workers_by_last_manager(
        self,
        workers: list[Person],
        last_manager_by_person_id: dict[int, dict],
    ) -> list[dict]:
        groups: dict[str, dict] = {}
        for worker in workers:
            manager = last_manager_by_person_id.get(worker.id) or {
                "key": "unassigned",
                "label": "Ohne Zuordnung",
                "name": "Ohne letzte Kalenderzuordnung",
            }
            existing = groups.setdefault(manager["key"], {"manager": manager, "people": []})
            existing["people"].append(self._worker_person_summary(worker))

        grouped = []
        for group in groups.values():
            grouped.append(
                {
                    **group,
                    "people": sorted(
                        group["people"],
                        key=lambda person: person["display_name"],
                    ),
                }
            )
        return sorted(grouped, key=lambda group: group["manager"]["label"])

    def _worker_summary_groups_for_day(
        self,
        rows: list[MatrixRow],
        target_date: date,
        active_workers: list[Person],
        free_workers: list[Person],
    ) -> list[dict]:
        active_worker_by_id = {worker.id: worker for worker in active_workers}
        assigned_by_manager: dict[str, dict] = {}

        for row in rows:
            cell = next((entry for entry in row.cells if entry.date == target_date), None)
            if cell is None:
                continue
            if not cell.assignments:
                continue
            manager = self._matrix_manager_summary(row.site.project_manager)
            site_label = self._site_label(row.site.site_number, row.site.name)
            group = assigned_by_manager.setdefault(
                manager["key"],
                {"kind": "assigned", "manager": manager, "peopleById": {}},
            )
            for assignment in cell.assignments:
                worker = active_worker_by_id.get(assignment.person.id)
                if worker is None:
                    continue
                person_summary = group["peopleById"].setdefault(
                    worker.id,
                    {
                        **self._worker_person_summary(worker),
                        "siteLabels": [],
                    },
                )
                if site_label not in person_summary["siteLabels"]:
                    person_summary["siteLabels"].append(site_label)

        groups: list[dict] = []
        for group in assigned_by_manager.values():
            people = []
            for person in group["peopleById"].values():
                site_labels = sorted(person.pop("siteLabels"))
                people.append(
                    {
                        **person,
                        "detail": ", ".join(site_labels),
                    }
                )
            if not people:
                continue
            groups.append(
                {
                    "kind": "assigned",
                    "manager": group["manager"],
                    "people": sorted(people, key=lambda person: person["display_name"]),
                }
            )

        if free_workers:
            groups.append(
                {
                    "kind": "free",
                    "manager": {
                        "key": "free-workers",
                        "label": "Ohne Zuordnung",
                        "name": "Nicht eingesetzte Monteure",
                    },
                    "people": [
                        {
                            **self._worker_person_summary(worker),
                            "detail": "kein Einsatz heute",
                        }
                        for worker in sorted(free_workers, key=lambda person: person.display_name)
                    ],
                }
            )

        return sorted(groups, key=self._worker_summary_group_sort_key)

    def _worker_lookup(
        self,
        rows: list[MatrixRow],
        workers: list[Person],
        target_date: date,
        today_absences: dict[int, AbsenceType],
        last_manager_by_person_id: dict[int, dict],
    ) -> list[dict]:
        assigned_today: dict[int, dict] = {}
        for row in rows:
            cell = next((entry for entry in row.cells if entry.date == target_date), None)
            if cell is None:
                continue
            for assignment in cell.assignments:
                assigned_today[assignment.person.id] = {
                    "siteName": row.site.name,
                    "managerLabel": self._manager_label(row.site.project_manager),
                }

        lookup = []
        for worker in workers:
            assignment = assigned_today.get(worker.id)
            if assignment is not None:
                lookup.append(
                    {
                        "person": self._worker_person_summary(worker),
                        "status": "Eingesetzt",
                        "detail": assignment["siteName"],
                        "managerLabel": assignment["managerLabel"],
                    }
                )
                continue

            absence_type = today_absences.get(worker.id)
            if absence_type is not None:
                lookup.append(
                    {
                        "person": self._worker_person_summary(worker),
                        "status": "Abwesend",
                        "detail": self._absence_label(absence_type),
                        "managerLabel": last_manager_by_person_id.get(worker.id, {}).get("label", "Ohne Zuordnung"),
                    }
                )
                continue

            lookup.append(
                {
                    "person": self._worker_person_summary(worker),
                    "status": "Frei",
                    "detail": "kein Einsatz heute",
                    "managerLabel": last_manager_by_person_id.get(worker.id, {}).get("label", "Ohne Zuordnung"),
                }
            )

        return sorted(lookup, key=lambda item: item["person"]["display_name"])

    def _worker_person_summary(self, person: Person) -> dict:
        return {
            "id": person.id,
            "first_name": person.first_name,
            "last_name": person.last_name,
            "display_name": person.display_name,
            "short_code": calendar_short_code(person),
        }

    def _site_label(self, site_number: str | None, site_name: str) -> str:
        return f"{site_number} - {site_name}" if site_number else site_name

    def _matrix_manager_summary(self, manager: MatrixPerson | None) -> dict:
        if manager is None:
            return {"key": "unassigned", "label": "Ohne PL", "name": "Ohne Projektleiter"}
        return {
            "key": str(manager.id),
            "label": self._manager_label(manager),
            "name": manager.display_name,
        }

    def _manager_summary(self, manager: dict | None) -> dict:
        if manager is None:
            return {"key": "unassigned", "label": "Ohne PL", "name": "Ohne Projektleiter"}
        return {
            "key": str(manager["id"]),
            "label": self._manager_label_from_values(
                calendar_short_code_from_values(display_name=manager["display_name"], short_code=manager.get("short_code"))
            ),
            "name": manager["display_name"],
        }

    def _manager_label(self, manager: MatrixPerson | None) -> str:
        if manager is None:
            return "Ohne PL"
        return self._manager_label_from_values(
            calendar_short_code_from_values(display_name=manager.display_name, short_code=manager.short_code)
        )

    def _manager_label_from_values(self, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            return "PL"
        if cleaned.isalpha() and len(cleaned) <= 4:
            return cleaned.upper()
        parts = [part for part in cleaned.replace(".", " ").split() if part]
        if len(parts) >= 2:
            return (parts[0][:1] + parts[1][:1]).upper()
        return cleaned[:2].upper()

    def _assigned_group_sort_key(self, group: dict) -> tuple[int, str, str]:
        manager = group["manager"]
        return (
            1 if manager["key"] == "unassigned" else 0,
            manager["label"],
            manager["name"],
        )

    def _worker_summary_group_sort_key(self, group: dict) -> tuple[int, str, str]:
        manager = group["manager"]
        return (
            1 if group.get("kind") == "free" else 0,
            manager["label"],
            manager["name"],
        )

    def _assigned_site_sort_key(self, site: dict) -> tuple[int, int, str, str, int]:
        site_number = site.get("site_number")
        parsed_site_number = self._parse_site_number(site_number)
        if parsed_site_number is not None:
            return (
                0,
                parsed_site_number,
                "",
                site.get("name") or "",
                site["id"],
            )
        return (
            1,
            0,
            site_number or "",
            site.get("name") or "",
            site["id"],
        )

    def _parse_site_number(self, value: str | None) -> int | None:
        if not value:
            return None
        digits = ""
        current = ""
        for character in value:
            if character.isdigit():
                current += character
            elif current:
                digits = current
                current = ""
        digits = current or digits
        return int(digits) if digits else None

    def _absence_label(self, absence_type: AbsenceType) -> str:
        if absence_type == AbsenceType.VACATION:
            return "Urlaub"
        if absence_type == AbsenceType.SICK:
            return "Krankheit"
        if absence_type == AbsenceType.SCHOOL:
            return "Schule"
        if absence_type == AbsenceType.FREE:
            return "Überstunden"
        if absence_type == AbsenceType.OTHER:
            return "Abwesenheit"
        return absence_type.value
