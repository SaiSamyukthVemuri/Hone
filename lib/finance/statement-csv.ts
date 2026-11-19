import { csvCell } from "@/lib/csv";
import { CSV_COLUMNS, FEE_NOT_RECORDED_COPY, FEE_REASON_COPY, NOT_COMPLETED_COPY, UNKNOWN_REASON_COPY, toCsvRows, type StatementDocument } from "@/lib/finance/statement-document";
import { monthRange } from "@/lib/finance/statement-period";
import { offDocumentMoneyNotice } from "@/lib/finance/statement-directory";
import { FEE_ITEM_STATE_LABEL, VISIT_STATE_LABEL, balanceText } from "@/lib/finance/statement-screen";

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

/** `offDocumentWithMoney` is the count the screen shows its notice for (upcoming bookings with a payment, which no statement lists). */
export function statementCsvLines(doc: StatementDocument, offDocumentWithMoney = 0): string[][] {
  const currency = doc.currency.toUpperCase();
  const balance = balanceText(doc.balanceDue, decimalAmount);
  const balanceLine = balance.hint ? `${balance.text} ${balance.hint}` : balance.text;
  const notice = offDocumentMoneyNotice(offDocumentWithMoney);
  const header: string[][] = [
    [STATEMENT_NOT_AN_INVOICE],
    [doc.attribution],
    ["Studio", doc.identity.studioName],
    ["Client", doc.client.name],
    ["Selection", scopeLabel(doc.scope)],
    ["Prepared", doc.preparedOn],
    ["Currency", currency],
    // The same figures the screen shows, from the same document, so the file can be compared with it. A balance that is not established is WORDS
    // (the screen's own sentence), never 0.00.
    ["Visits", String(doc.totals.visitCount)],
    ["Paid", decimalAmount(doc.totals.paidCents)],
    ["Refunded", decimalAmount(doc.totals.refundedCents)],
    ["Waived", decimalAmount(doc.totals.waivedCents)],
    ["Balance", balanceLine],
    ...(notice ? [["Note", notice]] : []),
    [],
    [...STATEMENT_CSV_COLUMNS],
  ];
  const [, ...records] = toCsvRows(doc);
  const col = (name: (typeof CSV_COLUMNS)[number]) => CSV_COLUMNS.indexOf(name);
  const nVisits = doc.visits.length;
  const nItems = doc.feeItems.length;
  const body = records.map((row, r) => {
    const cells = row.map((cell, i) => {
      if (MONEY_COLUMNS.has(CSV_COLUMNS[i])) return decimalAmount(typeof cell === "number" ? cell : null);
      return cell === null ? "" : String(cell);
    });
    // Text columns read EXACTLY as the screen does (a person opens this in a spreadsheet and compares it with the statement): the screen's labels
    // for the row kind, the payment status, the fee state and the reasons, never the model's names.
    if (r < nVisits) {
      const v = doc.visits[r];
      cells[col("row_type")] = "Visit";
      cells[col("state")] = VISIT_STATE_LABEL[v.state];
      cells[col("fee_state")] = v.fee.state === "recorded" ? "Fee recorded" : FEE_NOT_RECORDED_COPY;
      cells[col("reasons")] = v.reasons.map((x) => UNKNOWN_REASON_COPY[x]).join("; ");
    } else if (r < nVisits + nItems) {
      const f = doc.feeItems[r - nVisits];
      cells[col("row_type")] = FEE_REASON_COPY[f.reason];
      cells[col("state")] = FEE_ITEM_STATE_LABEL[f.state];
      cells[col("fee_state")] = f.fee.state === "recorded" ? "Fee recorded" : FEE_NOT_RECORDED_COPY;
    } else {
      cells[col("row_type")] = NOT_COMPLETED_COPY;
      cells[col("state")] = NOT_COMPLETED_COPY;
    }
    return [...cells, currency];
  });
  return [...header, ...body];
}

const MONEY_AT: ReadonlySet<number> = new Set(STATEMENT_CSV_COLUMNS.map((c, i) => (["fee", "paid", "refunded", "waived", "owed"].includes(c) ? i : -1)).filter((i) => i >= 0));
const PURE_DECIMAL = /^-?\d+\.\d{2}$/;

/**
 * One line of the file. A MONEY cell that is exactly a signed decimal (60.00, -60.00) is written as a plain number so a spreadsheet can sum it:
 * digits and one dot cannot be a formula. EVERY other cell, including a money cell that does not match, goes through csvCell and is neutralised.
 */
export function statementCsvLine(cells: readonly string[], moneyAt: ReadonlySet<number> = new Set()): string {
  return cells.map((c, i) => (moneyAt.has(i) && PURE_DECIMAL.test(c) ? c : csvCell(c))).join(",");
}

/** The whole file: BOM, then one line per row. */
export function statementCsv(doc: StatementDocument, offDocumentWithMoney = 0): string {
  const rows = statementCsvLines(doc, offDocumentWithMoney);
  const HEADER_ROWS = rows.findIndex((r) => r[0] === STATEMENT_CSV_COLUMNS[0]) + 1; // everything up to and including the column header
  return `${CSV_BOM}${rows.map((row, r) => statementCsvLine(row, r >= HEADER_ROWS ? MONEY_AT : new Set())).join("\n")}\n`;
}
