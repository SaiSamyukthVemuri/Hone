import { csvCell } from "@/lib/csv";
import { CSV_BOM, decimalAmount } from "@/lib/finance/statement-csv";

import { ANALYTICS_ACCESS_NOTE } from "./copy";
import { unavailableText } from "./figure";
import { MONEY_BASIS_NOTE } from "./money-metrics";
import type { OverviewView } from "./overview-model";

// ===========================================================================
// The Clients tab as a spreadsheet file. PURE: no I/O, no clock, no request.
// ===========================================================================
// COUNTS AND TOTALS ONLY. No client's name, date of first visit, payment or any other per-client row is written: the file carries the numbers that sit
// above and below the table, so a named list can never leave through the download. The file name is the period only.

const PLAIN_NUMBER = /^-?\d+(\.\d{2})?$/;
const cell = (v: string): string => (PLAIN_NUMBER.test(v) ? v : csvCell(v));

export const CLIENTS_CSV_COLUMNS = ["section", "figure", "value", "currency", "note"] as const;

export function clientsCsvFileName(range: { startLocal: string; lastLocal: string }): string {
  return `analytics-clients-${range.startLocal}-to-${range.lastLocal}.csv`;
}

export function clientsCsv(view: OverviewView, opts: { preparedOn: string }): string {
  const cur = view.currency ? view.currency.toUpperCase() : "";
  const rows: string[][] = [];
  const add = (section: string, figure: string, value: string, note = "", currency = "") => rows.push([section, figure, value, currency, note]);
  rows.push(["Analytics clients"]);
  rows.push(["Period", view.currentLabel]);
  rows.push(["Prepared on", opts.preparedOn]);
  rows.push(["Currency", cur || "Not set"]);
  rows.push(["Basis", MONEY_BASIS_NOTE]);
  rows.push(["Who sees this", ANALYTICS_ACCESS_NOTE]);
  rows.push(["Contents", "Counts and totals only. No client is named in this file."]);
  rows.push([]);
  rows.push([...CLIENTS_CSV_COLUMNS]);

  if (view.activeClients.available) add("Clients", "Clients seen in this period", String(view.activeClients.value.count));
  else add("Clients", "Clients seen in this period", unavailableText(view.activeClients.reason));

  const t = view.clientsTable;
  if (t && t.available) {
    add("Clients", "Clients that can be listed", String(t.value.listed), "Seen clients who are not archived and have a name on record.");
    add("Clients", "Seen clients not listed", String(t.value.notListed), "Archived or with no name on record. They are in every total.");
    add("Clients", "All clients", String(t.value.chipCounts.all));
    add("Clients", "No next booking", t.value.chipCounts.noNextBooking === null ? "Not available" : String(t.value.chipCounts.noNextBooking), "A confirmed booking still to come with anyone counts as a next booking.");
    add("Clients", "Beyond their usual visit interval", t.value.chipCounts.beyondUsual === null ? "Not available" : String(t.value.chipCounts.beyondUsual));
    add("Clients", "Seen clients with no confirmed payment", String(t.value.seenWithoutConfirmedPayment), "Their paid figure is not available, not zero.");
  } else add("Clients", "Client table", t && !t.available ? unavailableText(t.reason) : unavailableText("read_failed"));

  const r = view.clientsReconciliation;
  if (r && r.available) {
    add("Paid in period", "Paid in period across every client seen", decimalAmount(r.value.clientsPaidCents), "", cur);
    add("Paid in period", "Money on completed visits with no client recorded", decimalAmount(r.value.noClientPaidCents), "", cur);
    add("Paid in period", "Collected on completed visits (Overview)", decimalAmount(r.value.completedVisitsCents), "", cur);
    add("Paid in period", "Difference", decimalAmount(r.value.differenceCents), "", cur);
  } else add("Paid in period", "Paid in period across every client seen", unavailableText(r && !r.available ? r.reason : "read_failed"));

  return `${CSV_BOM}${rows.map((row) => row.map(cell).join(",")).join("\n")}\n`;
}
