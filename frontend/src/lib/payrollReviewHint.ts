import type { PayrollMonthBlocker } from "../types/payrollMonth";

type PayrollReviewHint = { title: string; instruction: string };

// Display copy only: keep the original blockers and approval rules unchanged.
const hints: Record<string, PayrollReviewHint> = {
  payroll_last_weekday_entry_missing: {
    title: "Eintrag zum Monatsende fehlt",
    instruction: "Für den letzten Arbeitstag Arbeitszeit oder Abwesenheit ergänzen.",
  },
  open_time_or_gps_review: {
    title: "Tag noch nicht geprüft",
    instruction: "In der Wochenprüfung Arbeitszeit und Ort prüfen.",
  },
  payroll_week_not_reviewed: {
    title: "Woche noch nicht geprüft",
    instruction: "In der Wochenprüfung die gesamte Woche prüfen und bestätigen.",
  },
  unresolved_gps_time_entry: {
    title: "Arbeitszeit zur GPS-Erfassung fehlt",
    instruction: "GPS-Erfassung prüfen und die zugehörige Arbeitszeit ergänzen.",
  },
  travel_missing_overnight_status: {
    title: "Übernachtungsangabe fehlt",
    instruction: "Angeben, ob und wo übernachtet wurde.",
  },
  travel_conflicting_overnight_status: {
    title: "Übernachtungsangaben widersprechen sich",
    instruction: "Die Übernachtungsangaben dieses Tages abgleichen und korrigieren.",
  },
  travel_unclear_hotel_block_start: {
    title: "Beginn des Hotelaufenthalts unklar",
    instruction: "Die Übernachtungsangabe des Vortags prüfen und ergänzen.",
  },
  incomplete_work_interval: {
    title: "Beginn oder Ende fehlt",
    instruction: "Die fehlende Uhrzeit im Zeiteintrag ergänzen.",
  },
  invalid_work_minutes: {
    title: "Arbeitsdauer ungültig",
    instruction: "Die erfasste Arbeitsdauer prüfen und korrigieren.",
  },
  invalid_break_minutes: {
    title: "Pause ist negativ",
    instruction: "Die Pausenzeit auf null oder einen positiven Wert korrigieren.",
  },
  invalid_break_or_interval: {
    title: "Arbeitszeit und Pause passen nicht zusammen",
    instruction: "Beginn, Ende und Pausenlänge im Zeiteintrag prüfen.",
  },
  overlapping_work_intervals: {
    title: "Arbeitszeiten überschneiden sich",
    instruction: "Die Zeiteinträge dieses Tages abgleichen und die Uhrzeiten korrigieren.",
  },
  invalid_absence_range: {
    title: "Abwesenheitszeitraum ungültig",
    instruction: "Beginn und Ende der Abwesenheit prüfen.",
  },
  schedule_missing: {
    title: "Regelmäßige Arbeitszeit fehlt",
    instruction: "Die vereinbarten Wochenstunden auf die Wochentage verteilen und bestätigen.",
  },
  schedule_overlap: {
    title: "Mehrere Arbeitszeitpläne gelten gleichzeitig",
    instruction: "Die Gültigkeitszeiträume der Arbeitszeitpläne korrigieren.",
  },
  schedule_unconfirmed: {
    title: "Arbeitszeitplan noch nicht bestätigt",
    instruction: "Die regelmäßige Arbeitszeit prüfen und bestätigen.",
  },
  schedule_contract_mismatch: {
    title: "Wochenstunden weichen vom Vertrag ab",
    instruction: "Die Summe im Arbeitszeitplan mit den vereinbarten Wochenstunden abgleichen.",
  },
  opening_balance_missing: {
    title: "Bestätigter Anfangssaldo fehlt",
    instruction: "Den übernommenen Stand des Stundenkontos eintragen und bestätigen.",
  },
  conflicting_absence_types: {
    title: "Mehrere Abwesenheitsarten am selben Tag",
    instruction: "Die Abwesenheiten abgleichen und die richtige Art festlegen.",
  },
  unsupported_absence_type: {
    title: "Abwesenheitsart ist unklar",
    instruction: "Die Abwesenheit „Sonstige“ prüfen und eine passende Zeitart festlegen.",
  },
  work_absence_conflict: {
    title: "Arbeitszeit und Abwesenheit am selben Tag",
    instruction: "Beide Einträge abgleichen und die unzutreffende Angabe korrigieren.",
  },
};

const detailTitles: Record<string, string> = {
  payroll_export_source_invalid: "Abrechnungsdaten prüfen",
  payroll_export_validation_failed: "Lohnbericht kann nicht erstellt werden",
  payroll_template_invalid: "Excel-Vorlage prüfen",
  payroll_person_month_not_approved: "Monat noch nicht geprüft",
  payroll_month_before_cutover: "Monatsabschluss noch nicht verfügbar",
  before_cutover: "Monatsabschluss noch nicht verfügbar",
  no_payroll_workers: "Keine Monteure für die Abrechnung",
  daily_entry_without_date: "Datum im Abrechnungseintrag fehlt",
  finalized_day_changed: "Abgeschlossener Tag wurde verändert",
  finalization_reference_reused: "Abschlusszuordnung prüfen",
};

export function payrollReviewHint(blocker: PayrollMonthBlocker): PayrollReviewHint {
  return hints[blocker.code] ?? {
    title: detailTitles[blocker.code] ?? "Abrechnungsangabe prüfen",
    // Preserve specific diagnostics and unfamiliar future warnings in full.
    instruction: blocker.message,
  };
}
