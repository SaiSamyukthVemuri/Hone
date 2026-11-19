import { csvCell } from "@/lib/csv";
import { CSV_COLUMNS, UNKNOWN_REASON_COPY, toCsvRows, type StatementDocument } from "@/lib/finance/statement-document";
import { monthRange } from "@/lib/finance/statement-period";

// ===========================================================================
// A client statement as a spreadsheet file. PURE: no I/O, no clock, no request.
// ===========================================================================
//
// WHAT THE FILE IS. A header block (studio, the selected client's display name, the selection, the prepared date, the currency, and the fixed
// "not an invoice" label), a blank line, then one row per record exactly as the document model projects them (`toCsvRows`, every column picked
// explicitly, so no internal id can leave). The client name is in the HEADER only, never per row.
//
// MONEY. Decimal amounts ("60.00") with a SEPARATE currency column, because a person opens this in a spreadsheet; the integer-cents form is a
// machine format and stays in the model. Amounts are written as text so the decimal places survive ("60.00", not 60).
//
// SAFETY. Every cell goes through lib/csv's csvCell: a text cell beginning with = + - @ TAB or CR is neutralised so a spreadsheet never runs a
// formula from a name or a service title, and RFC-4180 quoting applies. A UTF-8 byte order mark leads the file so Excel reads accented names.

/** The fixed label on every printable or downloadable statement until issued invoices exist. */
export const STATEMENT_NOT_AN_INVOICE = "Statement — not an invoice";

export const CSV_BOM = "﻿";

const MONEY_COLUMNS: ReadonlySet<string> = new Set(["fee_cents", "paid_cents", "refunded_cents", "waived_cents", "owed_cents"]);

/** "60.00" for 6000; null stays empty (an amount that is not recorded is blank, never zero). */
export function decimalAmount(cents: number | null): string {
  if (cents === null) return "";
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** Plain-words selection, the same wording the screen uses for a month and the history. */
export function scopeLabel(scope: StatementDocument["scope"]): string {
  switch (scope.kind) {
    case "month":
      return monthRange(scope.month).label;
    case "full_history":
      return "Full history";
    case "range":
      return `${scope.startLocal} to ${scope.endLocalInclusive}`;
    case "visits":
      return `${scope.appointmentIds.length} chosen ${scope.appointmentIds.length === 1 ? "visit" : "visits"}`;
  }
}

/** The file name: the month or "full-history" only. Never a client name, an id or anything typed by a person. */
export function statementCsvFileName(scope: StatementDocument["scope"]): string {
  switch (scope.kind) {
    case "month":
      return `statement-${scope.month}.csv`;
    case "full_history":
      return "statement-full-history.csv";
    case "range":
      return `statement-${scope.startLocal}-to-${scope.endLocalInclusive}.csv`;
    case "visits":
      return "statement-chosen-visits.csv";
  }
}

export const STATEMENT_CSV_COLUMNS = [...CSV_COLUMNS.map((c) => (MONEY_COLUMNS.has(c) ? c.replace(/_cents$/, "") : c)), "currency"] as const;

export function statementCsvLines(doc: StatementDocument): string[][] {
  const currency = doc.currency.toUpperCase();
  const header: string[][] = [
    [STATEMENT_NOT_AN_INVOICE],
    [doc.attribution],
    ["Studio", doc.identity.studioName],
    ["Client", doc.client.name],
    ["Selection", scopeLabel(doc.scope)],
    ["Prepared", doc.preparedOn],
    ["Currency", currency],
    [],
    [...STATEMENT_CSV_COLUMNS],
  ];
  const [, ...records] = toCsvRows(doc);
  const reasonsAt = CSV_COLUMNS.indexOf("reasons");
  const body = records.map((row, r) => {
    const cells = row.map((cell, i) => {
      if (MONEY_COLUMNS.has(CSV_COLUMNS[i])) return decimalAmount(typeof cell === "number" ? cell : null);
      // The reasons a payment status is not confirmed are the SCREEN'S plain words (a person reads this in a spreadsheet), never the model's names.
      if (i === reasonsAt && r < doc.visits.length) return doc.visits[r].reasons.map((x) => UNKNOWN_REASON_COPY[x]).join("; ");
      return cell === null ? "" : String(cell);
    });
    return [...cells, currency];
  });
  return [...header, ...body];
}

/** The whole file: BOM, then one line per row. Every cell is escaped by csvCell. */
export function statementCsv(doc: StatementDocument): string {
  // The money cells are text, but they are digits and a dot (a negative would be neutralised by csvCell, which is the safe direction).
  return `${CSV_BOM}${statementCsvLines(doc).map((row) => row.map((c) => csvCell(c)).join(",")).join("\n")}\n`;
}
