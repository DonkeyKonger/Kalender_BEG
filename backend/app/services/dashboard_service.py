from __future__ import annotations

from datetime import date

from sqlalchemy.orm import Session

from app.models.enums import AbsenceType
from app.schemas.matrix import MatrixPerson, MatrixResponse, MatrixRow
from app.services.conflict_service import BLOCKED_SITE_STATUSES, HARD_ABSENCE_TYPES
from app.services.matrix_service import MatrixService


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
        matrix = MatrixService(self.db).get_matrix(
            start=history_start,
            end=next_week_end,
            include_weekends=True,
        )
        today_assigned_sites = self._assigned_sites_for_day(matrix, today)
        tomorrow_assigned_sites = self._assigned_sites_for_day(matrix, tomorrow)
        open_staffing_needs = self._open_staffing_needs(matrix.rows, today, next_week_end)
        conflicts = self._conflicts(matrix.rows, today, next_week_end)

        return {
            "todayAssignedSites": today_assigned_sites,
            "todayAssignedSiteGroups": self._group_assigned_sites_by_manager(today_assigned_sites),
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

    def _manager_summary(self, manager: dict | None) -> dict:
        if manager is None:
            return {"key": "unassigned", "label": "Ohne PL", "name": "Ohne Projektleiter"}
        return {
            "key": str(manager["id"]),
            "label": self._manager_label_from_values(manager.get("short_code") or manager["display_name"]),
            "name": manager["display_name"],
        }

    def _manager_label(self, manager: MatrixPerson | None) -> str:
        if manager is None:
            return "Ohne PL"
        return self._manager_label_from_values(manager.short_code or manager.display_name)

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
        return absence_type.value
