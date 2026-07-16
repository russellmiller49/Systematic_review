// Pure serialization helpers for exports. RFC 4180 CSV: CRLF line endings, fields containing
// comma / quote / CR / LF are quoted, embedded quotes doubled. No I/O — unit-tested.

export type CsvValue = string | number | boolean | Date | null | undefined;
export type CsvRow = Record<string, CsvValue>;

function formatValue(value: CsvValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  // Spreadsheet formula-injection guard (user-controlled strings only — titles, names,
  // quotes): a leading = + - @ or tab makes Excel/Sheets evaluate the cell. Prefix with
  // a single quote, the standard neutralization; numbers above stay unprefixed.
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function escapeField(field: string): string {
  return /[",\r\n]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field;
}

// Stable column order: caller-supplied, or the union of row keys in first-seen order.
export function columnsFor(rows: readonly CsvRow[]): string[] {
  const seen = new Set<string>();
  const cols: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        cols.push(key);
      }
    }
  }
  return cols;
}

export function toCsv(rows: readonly CsvRow[], columns?: readonly string[]): string {
  const cols = columns ? [...columns] : columnsFor(rows);
  if (cols.length === 0) return "";
  const lines: string[] = [cols.map(escapeField).join(",")];
  for (const row of rows) {
    lines.push(cols.map((c) => escapeField(formatValue(row[c]))).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

// JSON export body — stable 2-space indentation.
export function toJsonBody(payload: unknown): string {
  return JSON.stringify(payload, null, 2);
}
