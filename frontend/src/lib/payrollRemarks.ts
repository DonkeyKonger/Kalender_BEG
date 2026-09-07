export type PayrollRemarksLayout = {
  max_lines: number;
  max_width: number;
  max_length: number;
  character_widths: Record<string, number>;
  unknown_width: number;
};

export type PayrollRemarks = {
  remarks: string;
  editable: boolean;
  layout: PayrollRemarksLayout;
};

export function normalizePayrollRemarks(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
}

// Same wrapping as the exporter. The API supplies the printed font metrics.
export function wrapPayrollRemarks(value: string, layout: PayrollRemarksLayout): string[] {
  value = normalizePayrollRemarks(value);
  if ([...value].some((char) => {
    const code = char.codePointAt(0)!;
    return (code < 32 && char !== "\n") || (code >= 0xd800 && code <= 0xdfff)
      || code === 0xfffe || code === 0xffff;
  })) {
    throw new Error("Die Bemerkung enthält ein nicht unterstütztes Steuerzeichen.");
  }
  if (!value) return [];
  const lines: string[] = [];
  for (const raw of value.split("\n")) {
    let paragraph = [...raw];
    while (paragraph.length) {
      let width = 0;
      let end = 0;
      for (const char of paragraph) {
        const nextWidth = width + (layout.character_widths[char] ?? layout.unknown_width);
        if (nextWidth > layout.max_width) break;
        width = nextWidth;
        end += 1;
      }
      if (end === paragraph.length) break;
      const space = paragraph.slice(0, end).lastIndexOf(" ");
      const cut = space > 0 ? space + 1 : end;
      lines.push(paragraph.slice(0, cut).join(""));
      paragraph = paragraph.slice(cut);
    }
    lines.push(paragraph.join(""));
  }
  return lines;
}

export function payrollRemarksError(value: string, layout: PayrollRemarksLayout): string | null {
  try {
    if ([...normalizePayrollRemarks(value)].length > layout.max_length
      || wrapPayrollRemarks(value, layout).length > layout.max_lines) {
      return `Das Excel-Feld hat nur ${layout.max_lines} Zeilen. Bitte die Bemerkung kürzen.`;
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "Die Bemerkung ist ungültig.";
  }
}
