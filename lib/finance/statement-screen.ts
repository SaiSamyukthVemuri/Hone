import { feeBasisLabel, formatLocalDate, type BalanceDue, type DocumentVisit, type FeeItem, type StatementDocument, type VisitState } from "@/lib/finance/statement-document";
import { clientDisplayName } from "@/lib/clients/identity";
import { foldForSearch } from "@/lib/clients/name-search";
import { AMOUNT_KINDS } from "@/lib/finance/statement";
import { DIRECTORY_PAGE_SIZES, type FinderClient } from "@/lib/finance/statement-directory";
import { STATEMENT_METHOD_LABELS, STATEMENT_NO_TOTAL } from "@/lib/finance/statement-copy";
import { resolveStatementMonth, type YearMonth } from "@/lib/finance/statement-period";

// ===========================================================================
// What the statements screens say and link to. PURE: no I/O, no clock, no React. The pages and components only lay these values out.
// ===========================================================================

export const STATEMENTS_BASE = "/financials/statements";
export const STUDIO_STATEMENT_BASE = "/financials/statement";

export type StatementsTab = "studio" | "clients";
export const STATEMENT_TABS: readonly { key: StatementsTab; label: string }[] = [
  { key: "studio", label: "Studio" },
  { key: "clients", label: "Clients" },
];

/** The two tabs keep the SELECTED MONTH, so moving between them and back never loses it. */
export function tabHref(tab: StatementsTab, month: YearMonth): string {
  return tab === "studio" ? `${STUDIO_STATEMENT_BASE}?month=${month}` : `${STATEMENTS_BASE}?month=${month}`;
}

export function clientsListHref(month: YearMonth, page = 1): string {
  return page > 1 ? `${STATEMENTS_BASE}?month=${month}&page=${page}` : `${STATEMENTS_BASE}?month=${month}`;
}

export type ClientView = "month" | "history";

/** A client's statement. The month is carried in BOTH views, so "Back to Clients" always returns to the month the owner chose. */
export function clientStatementHref(clientId: string, month: YearMonth, view: ClientView = "month"): string {
  return `${STATEMENTS_BASE}/${encodeURIComponent(clientId)}?month=${month}${view === "history" ? "&view=history" : ""}`;
}

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export function parseClientsParams(
  sp: { month?: string | string[]; page?: string | string[] },
  currentMonth: YearMonth,
): { month: YearMonth; fellBack: boolean; page: number } {
  const { month, fellBack } = resolveStatementMonth(sp.month, currentMonth);
  const raw = one(sp.page);
  const n = raw !== undefined && /^\d{1,6}$/.test(raw) ? Number(raw) : 1;
  return { month, fellBack, page: n >= 1 ? n : 1 };
}

/** The CSV download and the printable view of the same statement: the same month and view the screen shows, nothing else in the URL. */
export function statementExportHref(clientId: string, month: string, view: ClientView): string {
  return `${STATEMENTS_BASE}/${encodeURIComponent(clientId)}/export.csv?month=${month}${view === "history" ? "&view=history" : ""}`;
}
export function statementPrintHref(clientId: string, month: string, view: ClientView): string {
  return `${STATEMENTS_BASE}/${encodeURIComponent(clientId)}/print?month=${month}${view === "history" ? "&view=history" : ""}`;
}

export function parseClientView(raw: string | string[] | undefined): ClientView {
  return one(raw) === "history" ? "history" : "month";
}

/** Two clients with one name are told apart by a NON-identifying detail: their last visit date, or that they have none. Never an email, phone or id. */
export function lastVisitDetail(lastVisitLocalDate: string | null | undefined): string {
  return lastVisitLocalDate ? `Last visit ${formatLocalDate(lastVisitLocalDate)}` : "No visits";
}

/**
 * The second line of a Find a client option. The month part says how many visits (or that the count is unavailable); for a client who shares a
 * name with another result it then adds what tells them apart: the last visit date, or, when the last-visit lookup was not made or the client has
 * never had a visit, the plain "Same name as another client" (never a second "No visits" after "No visits in <month>").
 */
export function finderOptionLine(args: { monthLabel: string; monthVisitCount: number | null; sameNameAsAnother: boolean; lastVisit: string | null | undefined; lastVisitsLoaded: boolean }): string {
  const { monthLabel, monthVisitCount, sameNameAsAnother, lastVisit, lastVisitsLoaded } = args;
  const month =
    monthVisitCount === null
      ? `Visit count for ${monthLabel} unavailable`
      : monthVisitCount === 0
        ? `No visits in ${monthLabel} · opens full history`
        : `${monthVisitCount} ${monthVisitCount === 1 ? "visit" : "visits"} in ${monthLabel}`;
  if (!sameNameAsAnother) return month;
  const detail = lastVisitsLoaded && lastVisit ? lastVisitDetail(lastVisit) : "Same name as another client";
  return `${month} · ${detail}`;
}

export const VISIT_STATE_LABEL: Record<VisitState, string> = {
  paid: "Paid",
  unknown: "Payment not confirmed",
  confirmed_unpaid: "Not paid",
  adjusted: "Waived or refunded",
  no_charge: "No charge",
};

export function visitFeeText(v: DocumentVisit | FeeItem, fmt: (cents: number) => string): string {
  return v.fee.state === "recorded" ? fmt(v.fee.cents) : "Fee not recorded";
}

/** What the amount IS: "Agreed fee" (backed by price evidence) or "Charged" (taken from a payment); null when no amount is recorded. */
export function visitFeeBasis(v: DocumentVisit | FeeItem): string | null {
  return feeBasisLabel(v.fee);
}

/** The amount and what it is, as one line of text: "$120.00 · Agreed fee", "$25.00 · Charged", or "Fee not recorded". */
export function visitFeeWithBasis(v: DocumentVisit | FeeItem, fmt: (cents: number) => string): string {
  const basis = feeBasisLabel(v.fee);
  return basis ? `${visitFeeText(v, fmt)} · ${basis}` : visitFeeText(v, fmt);
}

/** One visit's payment lines, kept together: "Card · $60.00". A row that carries no amount says so rather than showing a number. */
export function moneyLineTexts(v: Pick<DocumentVisit | FeeItem, "lines">, fmt: (cents: number) => string): string[] {
  return v.lines
    .filter((l) => l.kind !== "excluded")
    .map((l) => `${STATEMENT_METHOD_LABELS[l.kind]}: ${AMOUNT_KINDS.includes(l.kind) && l.cents !== null ? fmt(l.cents) : STATEMENT_NO_TOTAL}`);
}

export const BALANCE_NOT_ESTABLISHED = "Balance due is not shown yet.";
export const BALANCE_CLEARS_HINT =
  "It appears once every visit's payment is recorded: paid, waived, or noted as still owed against a recorded fee.";

/** The balance line, or the plain statement that it is not shown. It is never a guessed number. */
export function balanceText(b: BalanceDue, fmt: (cents: number) => string): { text: string; hint: string | null } {
  return b.kind === "established" ? { text: `Balance due ${fmt(b.cents)}`, hint: null } : { text: BALANCE_NOT_ESTABLISHED, hint: BALANCE_CLEARS_HINT };
}

export function scopeHeading(doc: Pick<StatementDocument, "scope">, monthLabel: string): string {
  return doc.scope.kind === "full_history" ? "Full history" : monthLabel;
}

export const CLIENTS_PAGE_SIZE = DIRECTORY_PAGE_SIZES.default;

/** The finder's own list is capped so the browser never receives an unbounded client list; beyond it the finder says so instead of searching part of the studio. */
export const FINDER_CLIENT_CAP = 5000;
export const FINDER_TOO_MANY = "This studio has more clients than Find a client can search at once. Use the Clients list, which is paged.";
export const FINDER_NO_MATCH = "No client matches that name.";
export const FINDER_PROMPT = "Type part of a name.";

/** The ids of every client whose shown name is also another client's (folded for case and accents). Only these need a told-apart detail. */
export function sameNameClientIds(clients: readonly FinderClient[]): string[] {
  const byName = new Map<string, string[]>();
  for (const c of clients) {
    const key = foldForSearch(clientDisplayName({ name: c.name, preferred_name: c.preferredName }));
    byName.set(key, [...(byName.get(key) ?? []), c.id]);
  }
  return [...byName.values()].filter((ids) => ids.length > 1).flat();
}

export const FEE_ITEM_STATE_LABEL = { paid: "Paid", settled: "Waived or refunded", unconfirmed: "Payment not confirmed" } as const;

/** Why a statement is not shown. Each names the condition and what the owner can do, never an internal code. */
export const STATEMENT_READ_UNAVAILABLE: Record<string, string> = {
  read_failed: "The statement could not be read, so nothing is shown. No figure is guessed. Try again.",
  too_many_appointments: "This statement covers more appointments than can be read exactly, so it shows nothing rather than part of the record.",
  currency_unknown: "This studio's payment currency is not set, so money cannot be totalled. Nothing is shown.",
  month_out_of_range: "That month is outside the range statements cover (January 2000 to the current month). Nothing is shown.",
  invalid_client: "That client link is not valid. Open the client from the Clients list.",
  client_not_found: "That client was not found in this studio. Open the client from the Clients list.",
  build_failed: "The statement could not be put together from the records, so nothing is shown. No figure is guessed.",
};
export const STATEMENTS_OWNER_ONLY = "Only the studio owner can see statements.";
