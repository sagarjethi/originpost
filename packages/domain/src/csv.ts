const spreadsheetFormula = /^[\u0000-\u0020]*[=+\-@]/u;

/**
 * Encode one CSV cell for spreadsheet consumption. User-controlled values that
 * could be interpreted as formulas are made literal before RFC 4180 quoting.
 */
export function spreadsheetSafeCsvCell(value: unknown): string {
  const raw = value === undefined || value === null ? "" : String(value);
  const text = spreadsheetFormula.test(raw) ? `'${raw}` : raw;
  return `"${text.replaceAll('"', '""')}"`;
}

export function utf8Csv(headers: readonly unknown[], rows: ReadonlyArray<readonly unknown[]>): string {
  const line = (values: readonly unknown[]) => values.map(spreadsheetSafeCsvCell).join(",");
  return `\uFEFF${line(headers)}\r\n${rows.map(line).join("\r\n")}${rows.length ? "\r\n" : ""}`;
}
