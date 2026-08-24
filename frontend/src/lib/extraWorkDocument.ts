import type {
  ExtraWorkTicketDocumentRead,
  ExtraWorkTicketDocumentUpdate,
  ExtraWorkBillingType,
  MeasurementNumericValue,
  MobileExtraWorkTicket,
  MobileExtraWorkTicketEntryPayload,
  MobileExtraWorkWorkerHours,
} from "../types/site";

export const EXTRA_WORK_PDF_WIDTH = 595.276;
export const EXTRA_WORK_PDF_HEIGHT = 841.89;
export const EXTRA_WORK_VISIBLE_WORKER_ROWS = 3;

export type ExtraWorkPdfRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ExtraWorkPercentRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type ExtraWorkPdfTextareaLayout = {
  fontSize: number;
  lineHeight: number;
  paddingTop: number;
  paddingInline: number;
  maxLines: number;
};

export const EXTRA_WORK_PDF_FORM_LINE_Y = {
  customer: 134.22,
  orderedByName: 172.15,
  orderedByCompany: 199.76,
  estimatedHours: 255.86,
  executorOtherName: 293.78,
  authorizationPlace: 333.37,
  documentNumber: 368.89,
  component: 391.91,
  signaturePlace: 747.61,
} as const;

export function extraWorkPdfLineRect(
  x: number,
  lineY: number,
  width: number,
  height: number,
): ExtraWorkPdfRect {
  return { x, y: lineY - height, width, height };
}

type ExtraWorkDocumentDisplayFields =
  | "billing_type"
  | "estimated_order_value"
  | "material_required"
  | "material_separate_attachment"
  | "executed_by_lead_monteur"
  | "executed_by_monteur"
  | "executed_by_helper"
  | "entry";

export type ExtraWorkDocumentDraft = Omit<ExtraWorkTicketDocumentUpdate, ExtraWorkDocumentDisplayFields> & {
  billing_type: ExtraWorkBillingType;
  estimated_order_value: MeasurementNumericValue;
  material_required: boolean;
  material_separate_attachment: boolean;
  executed_by_lead_monteur: boolean;
  executed_by_monteur: boolean;
  executed_by_helper: boolean;
  entry: Omit<MobileExtraWorkTicketEntryPayload, "estimated_hours"> & {
    estimated_hours: MeasurementNumericValue;
  };
};

export type ExtraWorkDocumentDirtyField = Exclude<
  keyof ExtraWorkTicketDocumentUpdate,
  "entry"
>;

type ExtraWorkDocumentPreservableField = Exclude<
  ExtraWorkDocumentDirtyField,
  "worker_signature_strokes"
>;

export type ExtraWorkDocumentDraftOptions = {
  customerNameFallback?: string | null;
  orderedByNameFallback?: string | null;
  orderedByCompanyFallback?: string | null;
};

export type ExtraWorkDocumentPayloadOptions = {
  executionRangeEdited?: boolean;
  originalTicket?: MobileExtraWorkTicket;
  dirtyFields?: ReadonlySet<ExtraWorkDocumentDirtyField>;
};

export const EXTRA_WORK_PDF_FIELD_RECTS = {
  customer: extraWorkPdfLineRect(103.2, EXTRA_WORK_PDF_FORM_LINE_Y.customer, 204.72, 14.173),
  project: extraWorkPdfLineRect(363.845, EXTRA_WORK_PDF_FORM_LINE_Y.customer, 186.84, 14.173),
  orderedByName: extraWorkPdfLineRect(84.189, EXTRA_WORK_PDF_FORM_LINE_Y.orderedByName, 351.607, 14.173),
  manualOrderDate: extraWorkPdfLineRect(479.575, EXTRA_WORK_PDF_FORM_LINE_Y.orderedByName, 71.16, 14.174),
  orderedByCompany: extraWorkPdfLineRect(84.567, EXTRA_WORK_PDF_FORM_LINE_Y.orderedByCompany, 351.48, 14.173),
  commissionNumber: extraWorkPdfLineRect(478.767, EXTRA_WORK_PDF_FORM_LINE_Y.orderedByCompany, 71.16, 14.174),
  estimatedHours: extraWorkPdfLineRect(120.36, EXTRA_WORK_PDF_FORM_LINE_Y.estimatedHours, 111.24, 11.339),
  estimatedOrderValue: extraWorkPdfLineRect(402.6, EXTRA_WORK_PDF_FORM_LINE_Y.estimatedHours, 146.76, 11.339),
  executorOtherName: extraWorkPdfLineRect(353.269, EXTRA_WORK_PDF_FORM_LINE_Y.executorOtherName, 97.8, 11.339),
  authorizationPlace: extraWorkPdfLineRect(62.422, EXTRA_WORK_PDF_FORM_LINE_Y.authorizationPlace, 124.68, 14.173),
  authorizationDate: extraWorkPdfLineRect(240.316, EXTRA_WORK_PDF_FORM_LINE_Y.authorizationPlace, 124.68, 14.173),
  documentNumber: extraWorkPdfLineRect(236.88, EXTRA_WORK_PDF_FORM_LINE_Y.documentNumber, 106.8, 17.008),
  title: { x: 236.88, y: 366, width: 313, height: 10 },
  executionStart: extraWorkPdfLineRect(434.76, EXTRA_WORK_PDF_FORM_LINE_Y.documentNumber, 48.96, 11.339),
  executionEnd: extraWorkPdfLineRect(502.08, EXTRA_WORK_PDF_FORM_LINE_Y.documentNumber, 48.96, 11.339),
  component: extraWorkPdfLineRect(86.695, EXTRA_WORK_PDF_FORM_LINE_Y.component, 61.2, 11.339),
  floor: extraWorkPdfLineRect(199.92, EXTRA_WORK_PDF_FORM_LINE_Y.component, 61.2, 11.339),
  roomNumber: extraWorkPdfLineRect(328.08, EXTRA_WORK_PDF_FORM_LINE_Y.component, 55.68, 11.339),
  axis: extraWorkPdfLineRect(440.16, EXTRA_WORK_PDF_FORM_LINE_Y.component, 61.08, 11.339),
  remarks: { x: 416.476, y: 445.923, width: 136.08, height: 176.76 },
  overallHours: { x: 345.96, y: 609.557, width: 68.16, height: 14.173 },
  materialText: { x: 62.76, y: 641.85, width: 484.92, height: 54.819 },
  workerSignaturePlace: extraWorkPdfLineRect(62.752, EXTRA_WORK_PDF_FORM_LINE_Y.signaturePlace, 92.768, 19.843),
  workerSignatureDate: extraWorkPdfLineRect(158.76, EXTRA_WORK_PDF_FORM_LINE_Y.signaturePlace, 55.2, 19.843),
  customerSignaturePlace: extraWorkPdfLineRect(396.592, EXTRA_WORK_PDF_FORM_LINE_Y.signaturePlace, 92.768, 19.843),
  customerSignatureDate: extraWorkPdfLineRect(492.6, EXTRA_WORK_PDF_FORM_LINE_Y.signaturePlace, 55.2, 19.843),
  workerSignature: { x: 68, y: 761.89, width: 145, height: 24 },
  customerSignature: { x: 402, y: 761.89, width: 145, height: 24 },
} satisfies Record<string, ExtraWorkPdfRect>;

// These values intentionally mirror extra_work_pdf_service._textarea for the
// ruled material area. Keeping them in PDF points lets the browser scale text
// and the template together at every paper width.
export const EXTRA_WORK_PDF_TEXTAREA_LAYOUTS = {
  remarks: {
    fontSize: 7.5,
    lineHeight: 9.5,
    paddingTop: 2,
    paddingInline: 2,
    maxLines: 18,
  },
  materialText: {
    fontSize: 8,
    lineHeight: 18,
    paddingTop: 0,
    paddingInline: 2,
    maxLines: 3,
  },
} satisfies Record<string, ExtraWorkPdfTextareaLayout>;

const HELVETICA_WIDTH_GROUPS = [
  [191, "'"],
  [222, "ijl‚‘’"],
  [260, "|¦"],
  [278, " !,./:;I[\\]ft ·ÌÍÎÏìíîï"],
  [333, "()-`r„ˆ‹“”˜›¡¨­¯²³´¸¹"],
  [334, "{}"],
  [350, "•"],
  [355, "\""],
  [365, "º"],
  [370, "ª"],
  [389, "*"],
  [400, "°"],
  [469, "^"],
  [500, "Jcksvxyzšžçýÿ"],
  [537, "¶"],
  [556, "#$0123456789?L_abdeghnopqu€ƒ†‡–¢£¤¥§«µ»àáâãäåèéêëðñòóôõöùúûüþ"],
  [584, "+<=>~¬±×÷"],
  [611, "FTZŽ¿ßø"],
  [667, "&ABEKPSVXYŠŸÀÁÂÃÄÅÈÉÊËÝÞ"],
  [722, "CDHNRUwÇÐÑÙÚÛÜ"],
  [737, "©®"],
  [778, "GOQÒÓÔÕÖØ"],
  [833, "Mm"],
  [834, "¼½¾"],
  [889, "%æ"],
  [944, "Wœ"],
  [1000, "…‰Œ—™Æ"],
  [1015, "@"],
] as const;
const HELVETICA_CHARACTER_WIDTHS = new Map<string, number>(
  HELVETICA_WIDTH_GROUPS.flatMap(([width, characters]) => (
    Array.from(characters, (character) => [character, width] as const)
  )),
);

export type ExtraWorkRemarksChange = {
  value: string;
  limited: boolean;
};

export function wrapExtraWorkRemarks(value: string | null | undefined): string[] {
  const text = normalizeExtraWorkRemarks(value ?? "");
  if (!text) {
    return [];
  }
  return text.split("\n").flatMap((paragraph) => {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      return [""];
    }
    return wrapExtraWorkRemarksWords(words);
  });
}

export function extraWorkRemarksFit(value: string | null | undefined): boolean {
  return wrapExtraWorkRemarks(value).length <= EXTRA_WORK_PDF_TEXTAREA_LAYOUTS.remarks.maxLines;
}

export function constrainExtraWorkRemarksChange(previous: string, requested: string): ExtraWorkRemarksChange {
  const next = normalizeExtraWorkRemarks(requested);
  if (extraWorkRemarksFit(next)) {
    return { value: next, limited: false };
  }

  if (!extraWorkRemarksFit(previous)) {
    const nextLines = wrapExtraWorkRemarks(next).length;
    const previousLines = wrapExtraWorkRemarks(previous).length;
    if (next.length < previous.length && nextLines <= previousLines) {
      return { value: next, limited: false };
    }
    return { value: previous, limited: true };
  }

  let prefixLength = 0;
  while (
    prefixLength < previous.length
    && prefixLength < next.length
    && previous[prefixLength] === next[prefixLength]
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < previous.length - prefixLength
    && suffixLength < next.length - prefixLength
    && previous[previous.length - suffixLength - 1] === next[next.length - suffixLength - 1]
  ) {
    suffixLength += 1;
  }

  const prefix = next.slice(0, prefixLength);
  const suffix = previous.slice(previous.length - suffixLength);
  const inserted = Array.from(next.slice(prefixLength, next.length - suffixLength));
  let accepted = "";
  for (const character of inserted) {
    const candidate = prefix + accepted + character + suffix;
    if (!extraWorkRemarksFit(candidate)) {
      break;
    }
    accepted += character;
  }
  accepted = accepted.replace(/\s+$/u, "");
  return { value: prefix + accepted + suffix, limited: true };
}

export function extraWorkRemarksTextWidth(value: string): number {
  let units = 0;
  for (const character of value) {
    units += HELVETICA_CHARACTER_WIDTHS.get(character) ?? 556;
  }
  return units * EXTRA_WORK_PDF_TEXTAREA_LAYOUTS.remarks.fontSize / 1000;
}

function wrapExtraWorkRemarksWords(words: string[]): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = `${current} ${word}`.trim();
    if (extraWorkRemarksTextWidth(candidate) <= extraWorkRemarksInnerWidth()) {
      current = candidate;
      continue;
    }
    if (current) {
      lines.push(current);
      current = "";
    }
    if (extraWorkRemarksTextWidth(word) <= extraWorkRemarksInnerWidth()) {
      current = word;
      continue;
    }
    const fragments = splitExtraWorkRemarksToken(word);
    lines.push(...fragments.slice(0, -1));
    current = fragments.at(-1) ?? "";
  }
  if (current) {
    lines.push(current);
  }
  return lines;
}

function splitExtraWorkRemarksToken(token: string): string[] {
  const fragments: string[] = [];
  let current = "";
  for (const character of token) {
    const candidate = current + character;
    if (current && extraWorkRemarksTextWidth(candidate) > extraWorkRemarksInnerWidth()) {
      fragments.push(current);
      current = character;
    } else {
      current = candidate;
    }
  }
  if (current) {
    fragments.push(current);
  }
  return fragments;
}

function extraWorkRemarksInnerWidth(): number {
  const layout = EXTRA_WORK_PDF_TEXTAREA_LAYOUTS.remarks;
  return EXTRA_WORK_PDF_FIELD_RECTS.remarks.width - 2 * layout.paddingInline;
}

function normalizeExtraWorkRemarks(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export const EXTRA_WORK_CHECKBOX_RECTS = {
  billingFlatRate: checkboxHitRect(163, 219),
  billingHourly: checkboxHitRect(234, 219),
  billingUnitPrice: checkboxHitRect(340, 219),
  materialYes: checkboxHitRect(163, 266),
  materialNo: checkboxHitRect(186, 266),
  materialAttachment: checkboxHitRect(234, 266),
  executedByLeadMonteur: checkboxHitRect(163, 285),
  executedByMonteur: checkboxHitRect(234, 285),
  executedByHelper: checkboxHitRect(296, 285),
  executedByOther: checkboxHitRect(340, 285),
} satisfies Record<string, ExtraWorkPdfRect>;

export const EXTRA_WORK_DAYS = [
  { label: "Montag", normal: "monday_hours", surcharge25: "monday_surcharge_25_hours", surcharge50: "monday_surcharge_50_hours", x: 184.68 },
  { label: "Dienstag", normal: "tuesday_hours", surcharge25: "tuesday_surcharge_25_hours", surcharge50: "tuesday_surcharge_50_hours", x: 207.611 },
  { label: "Mittwoch", normal: "wednesday_hours", surcharge25: "wednesday_surcharge_25_hours", surcharge50: "wednesday_surcharge_50_hours", x: 230.484 },
  { label: "Donnerstag", normal: "thursday_hours", surcharge25: "thursday_surcharge_25_hours", surcharge50: "thursday_surcharge_50_hours", x: 253.684 },
  { label: "Freitag", normal: "friday_hours", surcharge25: "friday_surcharge_25_hours", surcharge50: "friday_surcharge_50_hours", x: 276.556 },
  { label: "Samstag", normal: "saturday_hours", surcharge25: "saturday_surcharge_25_hours", surcharge50: "saturday_surcharge_50_hours", x: 299.756 },
  { label: "Sonntag", normal: "sunday_hours", surcharge25: "sunday_surcharge_25_hours", surcharge50: "sunday_surcharge_50_hours", x: 321.974 },
] as const;

export type ExtraWorkHoursField =
  | (typeof EXTRA_WORK_DAYS)[number]["normal"]
  | (typeof EXTRA_WORK_DAYS)[number]["surcharge25"]
  | (typeof EXTRA_WORK_DAYS)[number]["surcharge50"];

export type ExtraWorkHoursTier = "normal" | "surcharge25" | "surcharge50";

const terminalExtraWorkStatuses = new Set([
  "approved",
  "billed",
  "closed",
  "completed",
  "finalized",
  "signed",
  "customer_signed",
  "abgeschlossen",
]);

export function extraWorkPdfRectToPercent(rect: ExtraWorkPdfRect): ExtraWorkPercentRect {
  return {
    left: (rect.x / EXTRA_WORK_PDF_WIDTH) * 100,
    top: (rect.y / EXTRA_WORK_PDF_HEIGHT) * 100,
    width: (rect.width / EXTRA_WORK_PDF_WIDTH) * 100,
    height: (rect.height / EXTRA_WORK_PDF_HEIGHT) * 100,
  };
}

export function extraWorkPdfPointsToCqw(points: number): number {
  return (points / EXTRA_WORK_PDF_WIDTH) * 100;
}

export function getExtraWorkWorkerNameRect(workerIndex: number): ExtraWorkPdfRect {
  return {
    x: 57.48,
    y: 446.97 + (workerIndex * 48),
    width: 101.76,
    height: 45.72,
  };
}

export function getExtraWorkHourRect(
  workerIndex: number,
  tier: ExtraWorkHoursTier,
  dayIndex: number,
): ExtraWorkPdfRect {
  const day = EXTRA_WORK_DAYS[dayIndex];
  const tierOffset = tier === "normal" ? 0 : tier === "surcharge25" ? 16.08 : 32.16;
  return {
    x: day.x,
    y: 446.25 + (workerIndex * 48) + tierOffset,
    width: 21.36,
    height: tier === "surcharge50" ? 14.28 : 14.52,
  };
}

export function getExtraWorkRowTotalRect(workerIndex: number, tier: ExtraWorkHoursTier): ExtraWorkPdfRect {
  const tierOffset = tier === "normal" ? 0 : tier === "surcharge25" ? 16.08 : 32.16;
  return {
    x: 345.72,
    y: 446.25 + (workerIndex * 48) + tierOffset,
    width: 68.64,
    height: tier === "surcharge50" ? 14.28 : 14.52,
  };
}

export function createEmptyExtraWorkWorkerRow(): MobileExtraWorkWorkerHours {
  return {
    person_id: null,
    worker_name: "",
    monday_hours: null,
    tuesday_hours: null,
    wednesday_hours: null,
    thursday_hours: null,
    friday_hours: null,
    saturday_hours: null,
    sunday_hours: null,
    monday_surcharge_25_hours: null,
    tuesday_surcharge_25_hours: null,
    wednesday_surcharge_25_hours: null,
    thursday_surcharge_25_hours: null,
    friday_surcharge_25_hours: null,
    saturday_surcharge_25_hours: null,
    sunday_surcharge_25_hours: null,
    monday_surcharge_50_hours: null,
    tuesday_surcharge_50_hours: null,
    wednesday_surcharge_50_hours: null,
    thursday_surcharge_50_hours: null,
    friday_surcharge_50_hours: null,
    saturday_surcharge_50_hours: null,
    sunday_surcharge_50_hours: null,
  };
}

export function createExtraWorkDocumentDraft(
  document: ExtraWorkTicketDocumentRead,
  options: ExtraWorkDocumentDraftOptions = {},
): ExtraWorkDocumentDraft {
  const ticket = document.ticket;
  const entry: ExtraWorkDocumentDraft["entry"] = document.entry
    ? {
        component: document.entry.component,
        floor: document.entry.floor,
        room_number: document.entry.room_number ?? null,
        axis: document.entry.axis ?? null,
        remarks: document.entry.remarks ?? null,
        material_text: document.entry.material_text ?? null,
        material_items: document.entry.material_items ?? [],
        estimated_hours: formatExtraWorkDraftNumericValue(document.entry.estimated_hours),
        worker_rows: document.entry.worker_rows.map(formatExtraWorkWorkerRowForDraft),
      }
    : {
        component: "",
        floor: "",
        room_number: null,
        axis: null,
        remarks: null,
        material_text: null,
        material_items: [],
        estimated_hours: formatExtraWorkDraftNumericValue(ticket.estimated_hours),
        worker_rows: [],
      };

  while (entry.worker_rows.length < EXTRA_WORK_VISIBLE_WORKER_ROWS) {
    entry.worker_rows.push(createEmptyExtraWorkWorkerRow());
  }

  const hasExplicitExecutorSelection = [
    ticket.executed_by_lead_monteur,
    ticket.executed_by_monteur,
    ticket.executed_by_helper,
  ].some((value) => value !== null)
    || Boolean(ticket.executor_other_name?.trim());
  return {
    title: ticket.title ?? null,
    customer_name: ticket.customer_name ?? options.customerNameFallback ?? null,
    ordered_by_name: ticket.ordered_by_name ?? options.orderedByNameFallback ?? null,
    ordered_by_company: ticket.ordered_by_company ?? options.orderedByCompanyFallback ?? null,
    billing_type: ticket.billing_type ?? "hourly",
    estimated_order_value: formatExtraWorkDraftNumericValue(ticket.estimated_order_value, { currency: true }),
    material_required: ticket.material_required ?? Boolean(
      entry.material_text?.trim() || entry.material_items?.length,
    ),
    material_separate_attachment: ticket.material_separate_attachment ?? false,
    executed_by_lead_monteur: ticket.executed_by_lead_monteur ?? false,
    executed_by_monteur: ticket.executed_by_monteur ?? !hasExplicitExecutorSelection,
    executed_by_helper: ticket.executed_by_helper ?? false,
    executor_other_name: ticket.executor_other_name ?? null,
    work_description: ticket.work_description ?? null,
    manual_order_date: document.resolved_dates.order_date,
    manual_execution_week: ticket.manual_execution_week ?? null,
    manual_execution_week_year: ticket.manual_execution_week_year ?? null,
    manual_execution_start: document.resolved_dates.execution_start,
    manual_execution_end: document.resolved_dates.execution_end,
    worker_signature_name: document.worker_signature.name,
    worker_signature_place: formatExtraWorkSignaturePlace(
      ticket.worker_signature_place ?? document.worker_signature.place,
    ),
    worker_signature_date: ticket.worker_signature_date ?? document.worker_signature.date,
    worker_signature_strokes: document.worker_signature.strokes,
    entry,
  };
}

export function buildExtraWorkDocumentPayload(
  draft: ExtraWorkDocumentDraft,
  originalWorkerRowCount: number,
  options: ExtraWorkDocumentPayloadOptions = {},
): ExtraWorkTicketDocumentUpdate {
  const dirtyFields = options.dirtyFields;
  const originalTicket = options.originalTicket;
  const executionFieldsDirty = Boolean(
    options.executionRangeEdited
    || dirtyFields?.has("manual_execution_start")
    || dirtyFields?.has("manual_execution_end")
    || dirtyFields?.has("manual_execution_week")
    || dirtyFields?.has("manual_execution_week_year"),
  );
  const usesExplicitExecutionRange = Boolean(
    executionFieldsDirty
    || (
      draft.manual_execution_week === null
      && draft.manual_execution_week_year === null
      && (draft.manual_execution_start || draft.manual_execution_end)
    ),
  );
  const workerRows = draft.entry.worker_rows.filter((row, index) => (
    index < originalWorkerRowCount || extraWorkWorkerRowHasContent(row)
  )).map(normalizeExtraWorkWorkerRow);
  validateExtraWorkWorkerRows(workerRows);
  if (
    usesExplicitExecutionRange
    && Boolean(draft.manual_execution_start) !== Boolean(draft.manual_execution_end)
  ) {
    throw new Error("Beginn und Ende des Ausführungszeitraums müssen gemeinsam angegeben werden.");
  }
  if (
    usesExplicitExecutionRange
    && draft.manual_execution_start
    && draft.manual_execution_end
    && draft.manual_execution_end < draft.manual_execution_start
  ) {
    throw new Error("Das Ende des Ausführungszeitraums darf nicht vor dem Beginn liegen.");
  }
  const normalizedPayload: ExtraWorkTicketDocumentUpdate = {
    title: toNullableText(draft.title),
    customer_name: toNullableText(draft.customer_name),
    ordered_by_name: toNullableText(draft.ordered_by_name),
    ordered_by_company: toNullableText(draft.ordered_by_company),
    billing_type: draft.billing_type,
    executor_other_name: toNullableText(draft.executor_other_name),
    work_description: toNullableMultilineText(draft.work_description),
    estimated_order_value: parseExtraWorkNumericValue(
      draft.estimated_order_value,
      "Geschätzter Auftragswert",
      { allowGermanGrouping: true },
    ),
    material_required: draft.material_required,
    material_separate_attachment: draft.material_separate_attachment,
    executed_by_lead_monteur: draft.executed_by_lead_monteur,
    executed_by_monteur: draft.executed_by_monteur,
    executed_by_helper: draft.executed_by_helper,
    manual_order_date: draft.manual_order_date,
    manual_execution_week: usesExplicitExecutionRange ? null : draft.manual_execution_week,
    manual_execution_week_year: usesExplicitExecutionRange ? null : draft.manual_execution_week_year,
    manual_execution_start: usesExplicitExecutionRange ? draft.manual_execution_start : null,
    manual_execution_end: usesExplicitExecutionRange ? draft.manual_execution_end : null,
    worker_signature_name: toNullableText(draft.worker_signature_name),
    worker_signature_place: toNullableText(draft.worker_signature_place),
    worker_signature_date: draft.worker_signature_date,
    worker_signature_strokes: !dirtyFields || dirtyFields.has("worker_signature_strokes")
      ? draft.worker_signature_strokes
      : null,
    entry: {
      ...draft.entry,
      room_number: toNullableText(draft.entry.room_number),
      axis: toNullableText(draft.entry.axis),
      remarks: toNullableMultilineText(draft.entry.remarks),
      material_text: toNullableMultilineText(draft.entry.material_text),
      estimated_hours: parseExtraWorkNumericValue(draft.entry.estimated_hours, "Stundenvorgabe"),
      worker_rows: workerRows,
    },
  };

  if (!originalTicket || !dirtyFields) {
    return normalizedPayload;
  }

  const preserveWhenUntouched = <K extends ExtraWorkDocumentPreservableField>(
    field: K,
    normalizedValue: ExtraWorkTicketDocumentUpdate[K],
  ): ExtraWorkTicketDocumentUpdate[K] => (
    dirtyFields.has(field)
      ? normalizedValue
      : originalTicket[field] as ExtraWorkTicketDocumentUpdate[K]
  );

  const executionValues = executionFieldsDirty
    ? {
        manual_execution_week: null,
        manual_execution_week_year: null,
        manual_execution_start: normalizedPayload.manual_execution_start,
        manual_execution_end: normalizedPayload.manual_execution_end,
      }
    : {
        manual_execution_week: originalTicket.manual_execution_week,
        manual_execution_week_year: originalTicket.manual_execution_week_year,
        manual_execution_start: originalTicket.manual_execution_start,
        manual_execution_end: originalTicket.manual_execution_end,
      };

  return {
    ...normalizedPayload,
    title: preserveWhenUntouched("title", normalizedPayload.title),
    customer_name: preserveWhenUntouched("customer_name", normalizedPayload.customer_name),
    ordered_by_name: preserveWhenUntouched("ordered_by_name", normalizedPayload.ordered_by_name),
    ordered_by_company: preserveWhenUntouched("ordered_by_company", normalizedPayload.ordered_by_company),
    billing_type: preserveWhenUntouched("billing_type", normalizedPayload.billing_type),
    estimated_order_value: preserveWhenUntouched("estimated_order_value", normalizedPayload.estimated_order_value),
    material_required: preserveWhenUntouched("material_required", normalizedPayload.material_required),
    material_separate_attachment: preserveWhenUntouched("material_separate_attachment", normalizedPayload.material_separate_attachment),
    executed_by_lead_monteur: preserveWhenUntouched("executed_by_lead_monteur", normalizedPayload.executed_by_lead_monteur),
    executed_by_monteur: preserveWhenUntouched("executed_by_monteur", normalizedPayload.executed_by_monteur),
    executed_by_helper: preserveWhenUntouched("executed_by_helper", normalizedPayload.executed_by_helper),
    executor_other_name: preserveWhenUntouched("executor_other_name", normalizedPayload.executor_other_name),
    work_description: preserveWhenUntouched("work_description", normalizedPayload.work_description),
    manual_order_date: preserveWhenUntouched("manual_order_date", normalizedPayload.manual_order_date),
    worker_signature_name: preserveWhenUntouched("worker_signature_name", normalizedPayload.worker_signature_name),
    worker_signature_place: preserveWhenUntouched("worker_signature_place", normalizedPayload.worker_signature_place),
    worker_signature_date: preserveWhenUntouched("worker_signature_date", normalizedPayload.worker_signature_date),
    ...executionValues,
  };
}

export function extraWorkWorkerRowHasContent(row: MobileExtraWorkWorkerHours): boolean {
  if ((row.person_id ?? null) !== null || row.worker_name.trim().length > 0) {
    return true;
  }
  return EXTRA_WORK_DAYS.some((day) => (
    hasNumericValue(row[day.normal])
    || hasNumericValue(row[day.surcharge25])
    || hasNumericValue(row[day.surcharge50])
  ));
}

export function getExtraWorkWorkerTierTotal(
  row: MobileExtraWorkWorkerHours,
  tier: ExtraWorkHoursTier,
): number {
  return EXTRA_WORK_DAYS.reduce((total, day) => {
    const field = tier === "normal" ? day.normal : tier === "surcharge25" ? day.surcharge25 : day.surcharge50;
    return total + numericValue(row[field]);
  }, 0);
}

export function getExtraWorkOverallHours(rows: MobileExtraWorkWorkerHours[]): number {
  return rows.reduce((total, row) => (
    total
    + getExtraWorkWorkerTierTotal(row, "normal")
    + getExtraWorkWorkerTierTotal(row, "surcharge25")
    + getExtraWorkWorkerTierTotal(row, "surcharge50")
  ), 0);
}

export function chunkExtraWorkWorkerRows(
  workers: MobileExtraWorkWorkerHours[],
  pageSize = EXTRA_WORK_VISIBLE_WORKER_ROWS,
): MobileExtraWorkWorkerHours[][] {
  const chunks: MobileExtraWorkWorkerHours[][] = [];
  for (let index = 0; index < workers.length; index += pageSize) {
    chunks.push(workers.slice(index, index + pageSize));
  }
  return chunks.length > 0 ? chunks : [[]];
}

export function isExtraWorkDocumentLocked(ticket: MobileExtraWorkTicket, canEdit: boolean): boolean {
  return !canEdit
    || Boolean(ticket.customer_signed_at)
    || Boolean(ticket.deleted_at)
    || terminalExtraWorkStatuses.has(ticket.status.trim().toLowerCase());
}

function checkboxHitRect(x: number, y: number): ExtraWorkPdfRect {
  return { x: x - 4, y: y - 4, width: 16, height: 16 };
}

function hasNumericValue(value: MeasurementNumericValue | undefined): boolean {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function numericValue(value: MeasurementNumericValue | undefined): number {
  if (!hasNumericValue(value)) {
    return 0;
  }
  const parsed = Number(String(value).replace(",", "."));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function parseExtraWorkNumericValue(
  value: MeasurementNumericValue | undefined,
  label: string,
  options: { allowGermanGrouping?: boolean } = {},
): number | null {
  if (!hasNumericValue(value)) {
    return null;
  }
  const rawValue = String(value).trim();
  const acceptsGroupedGermanValue = Boolean(
    options.allowGermanGrouping
    && (
      /^\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(rawValue)
      || /^\d+(?:,\d+)?$/.test(rawValue)
    ),
  );
  if (!acceptsGroupedGermanValue && !/^\d+(?:[.,]\d+)?$/.test(rawValue)) {
    throw new Error(`${label} muss eine gültige positive Zahl sein, zum Beispiel 1,5.`);
  }
  const normalizedValue = acceptsGroupedGermanValue
    ? rawValue.replaceAll(".", "").replace(",", ".")
    : rawValue.replace(",", ".");
  const parsed = Number(normalizedValue);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} muss eine gültige positive Zahl sein, zum Beispiel 1,5.`);
  }
  return parsed;
}

export function formatExtraWorkDraftNumericValue(
  value: MeasurementNumericValue | undefined,
  options: { currency?: boolean } = {},
): MeasurementNumericValue {
  if (!hasNumericValue(value)) {
    return null;
  }
  const numeric = Number(String(value).trim().replace(",", "."));
  if (!Number.isFinite(numeric)) {
    return value ?? null;
  }
  return numeric.toLocaleString("de-DE", {
    useGrouping: Boolean(options.currency),
    minimumFractionDigits: options.currency ? 2 : 0,
    maximumFractionDigits: options.currency ? 2 : 4,
  });
}

export function formatExtraWorkSignaturePlace(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  if (!normalized) {
    return null;
  }
  const candidate = normalized.split(",").at(-1)?.trim() ?? normalized;
  return candidate.replace(/^\d{5}\s+/, "") || candidate;
}

function formatExtraWorkWorkerRowForDraft(row: MobileExtraWorkWorkerHours): MobileExtraWorkWorkerHours {
  const draftRow: MobileExtraWorkWorkerHours = { ...createEmptyExtraWorkWorkerRow(), ...row };
  EXTRA_WORK_DAYS.forEach((day) => {
    draftRow[day.normal] = formatExtraWorkDraftNumericValue(row[day.normal]);
    draftRow[day.surcharge25] = formatExtraWorkDraftNumericValue(row[day.surcharge25]);
    draftRow[day.surcharge50] = formatExtraWorkDraftNumericValue(row[day.surcharge50]);
  });
  return draftRow;
}

function normalizeExtraWorkWorkerRow(
  row: MobileExtraWorkWorkerHours,
  workerIndex: number,
): MobileExtraWorkWorkerHours {
  const label = `Monteur ${workerIndex + 1}`;
  return {
    ...row,
    monday_hours: parseExtraWorkNumericValue(row.monday_hours, `${label}, Montag N`),
    tuesday_hours: parseExtraWorkNumericValue(row.tuesday_hours, `${label}, Dienstag N`),
    wednesday_hours: parseExtraWorkNumericValue(row.wednesday_hours, `${label}, Mittwoch N`),
    thursday_hours: parseExtraWorkNumericValue(row.thursday_hours, `${label}, Donnerstag N`),
    friday_hours: parseExtraWorkNumericValue(row.friday_hours, `${label}, Freitag N`),
    saturday_hours: parseExtraWorkNumericValue(row.saturday_hours, `${label}, Samstag N`),
    sunday_hours: parseExtraWorkNumericValue(row.sunday_hours, `${label}, Sonntag N`),
    monday_surcharge_25_hours: parseExtraWorkNumericValue(row.monday_surcharge_25_hours, `${label}, Montag 25`),
    tuesday_surcharge_25_hours: parseExtraWorkNumericValue(row.tuesday_surcharge_25_hours, `${label}, Dienstag 25`),
    wednesday_surcharge_25_hours: parseExtraWorkNumericValue(row.wednesday_surcharge_25_hours, `${label}, Mittwoch 25`),
    thursday_surcharge_25_hours: parseExtraWorkNumericValue(row.thursday_surcharge_25_hours, `${label}, Donnerstag 25`),
    friday_surcharge_25_hours: parseExtraWorkNumericValue(row.friday_surcharge_25_hours, `${label}, Freitag 25`),
    saturday_surcharge_25_hours: parseExtraWorkNumericValue(row.saturday_surcharge_25_hours, `${label}, Samstag 25`),
    sunday_surcharge_25_hours: parseExtraWorkNumericValue(row.sunday_surcharge_25_hours, `${label}, Sonntag 25`),
    monday_surcharge_50_hours: parseExtraWorkNumericValue(row.monday_surcharge_50_hours, `${label}, Montag 50`),
    tuesday_surcharge_50_hours: parseExtraWorkNumericValue(row.tuesday_surcharge_50_hours, `${label}, Dienstag 50`),
    wednesday_surcharge_50_hours: parseExtraWorkNumericValue(row.wednesday_surcharge_50_hours, `${label}, Mittwoch 50`),
    thursday_surcharge_50_hours: parseExtraWorkNumericValue(row.thursday_surcharge_50_hours, `${label}, Donnerstag 50`),
    friday_surcharge_50_hours: parseExtraWorkNumericValue(row.friday_surcharge_50_hours, `${label}, Freitag 50`),
    saturday_surcharge_50_hours: parseExtraWorkNumericValue(row.saturday_surcharge_50_hours, `${label}, Samstag 50`),
    sunday_surcharge_50_hours: parseExtraWorkNumericValue(row.sunday_surcharge_50_hours, `${label}, Sonntag 50`),
  };
}

function validateExtraWorkWorkerRows(rows: MobileExtraWorkWorkerHours[]): void {
  rows.forEach((row, workerIndex) => {
    if (extraWorkWorkerRowHasContent(row) && !row.worker_name.trim()) {
      throw new Error(`Für Monteur ${workerIndex + 1} ist ein Name erforderlich.`);
    }
    EXTRA_WORK_DAYS.forEach((day) => {
      const dayTotal = numericValue(row[day.normal])
        + numericValue(row[day.surcharge25])
        + numericValue(row[day.surcharge50]);
      if (dayTotal > 24) {
        throw new Error(`Für Monteur ${workerIndex + 1} dürfen am ${day.label} höchstens 24 Stunden erfasst werden.`);
      }
    });
  });
}

function toNullableText(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function toNullableMultilineText(value: string | null | undefined): string | null {
  if (!value || value.trim().length === 0) {
    return null;
  }
  return value;
}
