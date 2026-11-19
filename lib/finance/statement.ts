import { collectedMoneyLines, type CollectedMoneyRow } from "@/lib/finance/collected-money-lines";

// ===========================================================================
// HON-64 Slice A: the visit-and-money STATEMENT. PURE. No I/O, no clock, no Stripe.
// ===========================================================================
//
// It sorts every money row it is given into EXACTLY ONE kind, per appointment practitioner, and never nets one kind into another:
//
//   collected_*   money Hone knows was collected and kept (card session payment, card fee, owner-recorded cash / e-transfer / other)
//   refunded_*    card money provably refunded IN FULL (an adjustment; never subtracted from a collected line)
//   waived        owner-attested as forgiven (an adjustment)
//   still_owes    a note only, never money, never summed
//   unresolved    money that may or may not have moved (in-flight, unprovable or partial refund, legacy fee with no refund record)
//   other_currency / excluded / unreadable   counted, never summed, never hidden
//
// THE CARD RULE IS NOT COPIED. Every card row is classified by calling `collectedMoneyLines` on that single row (Sam's 12 Nov
// ruling lives there: only real livemode succeeded money, fees as their own line, other currency never summed, an unprovable
// refund is unresolved). Partial refunds stay unresolved until the refund history (0358/0359) is hosted.
//
// PRACTITIONER is the APPOINTMENT's practitioner (Sam, 19 Nov 2026), never the confirming or recording one. A null practitioner
// (the column is `on delete set null`) is "Unattributed": never guessed.
//
// NOT CLAIMED: revenue, reimbursement, a payer, or a claim. No payer is inferred from a method.

export type StatementAppointment = {
  id: string;
  /** The APPOINTMENT's practitioner; null when none (deleted practitioner). */
  practitionerId: string | null;
  startsAt: string;
};

export type StatementCardRow = CollectedMoneyRow & { appointmentId: string };

export type StatementSettlementRow = {
  appointmentId: string;
  method: string;
  amountCents: number | null;
  currency: string | null;
};

/** `manual_fee_charge_attempts`: the legacy manual fee ledger. It carries NO refund record, so a succeeded real fee cannot be proven un-refunded. */
export type StatementLegacyFeeRow = {
  appointmentId: string;
  status: string | null;
  amountCents: number | null;
  currency: string | null;
  stripeLivemode: boolean | null;
};

export type StatementKind =
  | "collected_card_session"
  | "collected_card_fee"
  | "collected_cash"
  | "collected_e_transfer"
  | "collected_other_external"
  | "refunded_card_session"
  | "refunded_card_fee"
  | "waived"
  | "still_owes_note"
  | "unresolved"
  | "other_currency"
  | "excluded"
  | "unreadable";

export const STATEMENT_KINDS: readonly StatementKind[] = [
  "collected_card_session",
  "collected_card_fee",
  "collected_cash",
  "collected_e_transfer",
  "collected_other_external",
  "refunded_card_session",
  "refunded_card_fee",
  "waived",
  "still_owes_note",
  "unresolved",
  "other_currency",
  "excluded",
  "unreadable",
];

export const COLLECTED_KINDS: readonly StatementKind[] = [
  "collected_card_session",
  "collected_card_fee",
  "collected_cash",
  "collected_e_transfer",
  "collected_other_external",
];
export const ADJUSTMENT_KINDS: readonly StatementKind[] = ["refunded_card_session", "refunded_card_fee", "waived"];

export type KindTotal = { count: number; cents: number };
export type StatementBucket = {
  kinds: Record<StatementKind, KindTotal>;
  /** Sum of the five collected kinds. Adjustments are NOT subtracted. */
  collectedCents: number;
  rows: number;
};

export type StatementMoneyLine = { kind: StatementKind; cents: number | null; source: "card" | "settlement" | "legacy_fee" };
export type StatementVisit = {
  appointmentId: string;
  startsAt: string;
  practitionerId: string | null;
  lines: StatementMoneyLine[];
};

export type Statement = {
  currency: string;
  all: StatementBucket;
  /** One entry per appointment practitioner, then `practitionerId: null` ("Unattributed") when any. Sorted by id for a stable order. */
  byPractitioner: Array<{ practitionerId: string | null; bucket: StatementBucket }>;
  visits: StatementVisit[];
  /** Every input money row, and where it went. rowsIn === rowsClassified is asserted by the tests, not assumed. */
  reconciliation: { rowsIn: number; rowsClassified: number; rowsWithoutAppointment: number };
};

function emptyBucket(): StatementBucket {
  const kinds = {} as Record<StatementKind, KindTotal>;
  for (const k of STATEMENT_KINDS) kinds[k] = { count: 0, cents: 0 };
  return { kinds, collectedCents: 0, rows: 0 };
}

/** Only collected and adjustment kinds carry an amount. Unresolved, other-currency, excluded, unreadable and still-owing rows are COUNTED and carry no
 *  cents, so no figure for them can be formatted as a studio-currency total anywhere downstream. */
export const AMOUNT_KINDS: readonly StatementKind[] = [...COLLECTED_KINDS, ...ADJUSTMENT_KINDS];

function put(b: StatementBucket, kind: StatementKind, cents: number | null): void {
  b.kinds[kind].count += 1;
  if (AMOUNT_KINDS.includes(kind) && typeof cents === "number" && Number.isInteger(cents) && cents > 0) b.kinds[kind].cents += cents;
  b.rows += 1;
  if (COLLECTED_KINDS.includes(kind) && typeof cents === "number" && Number.isInteger(cents) && cents > 0) b.collectedCents += cents;
}

const FEE_REASONS = new Set(["no_show_fee", "late_cancellation_fee"]);

/** One card row -> exactly one kind, by asking the pinned rule about that single row. */
export function classifyCardRow(row: CollectedMoneyRow, studioCurrency: string): { kind: StatementKind; cents: number | null } {
  const isSession = row.chargeReason === "session_payment";
  const isFee = row.chargeReason !== null && FEE_REASONS.has(row.chargeReason);
  if (!isSession && !isFee) return { kind: "excluded", cents: null }; // an unknown reason never becomes revenue
  const lines = collectedMoneyLines([row], studioCurrency);
  const line = isSession ? lines.sessionPayments : lines.cancellationNoShowFees;
  if (line.excluded > 0) return { kind: "excluded", cents: null };
  if (line.otherCurrency.count > 0) return { kind: "other_currency", cents: null };
  if (line.unresolved.count > 0) return { kind: "unresolved", cents: line.unresolved.cents };
  if (line.refundedCents > 0) return { kind: isSession ? "refunded_card_session" : "refunded_card_fee", cents: line.refundedCents };
  return { kind: isSession ? "collected_card_session" : "collected_card_fee", cents: line.collectedCents };
}

const METHOD_KIND: Record<string, StatementKind> = {
  paid_cash: "collected_cash",
  paid_e_transfer: "collected_e_transfer",
  paid_other_external: "collected_other_external",
  waived: "waived",
  still_owes: "still_owes_note",
};

export function classifySettlementRow(row: StatementSettlementRow, studioCurrency: string): { kind: StatementKind; cents: number | null } {
  const kind = METHOD_KIND[row.method];
  if (!kind) return { kind: "unreadable", cents: null };
  // A still_owes row is a note: never money, never an amount.
  if (kind === "still_owes_note") return { kind, cents: null };
  const a = row.amountCents;
  if (typeof a !== "number" || !Number.isInteger(a) || a < 0) return { kind: "unreadable", cents: null };
  // Mirrors outstanding-balance: a currency that is present and different is never summed.
  if (row.currency && row.currency.toLowerCase() !== studioCurrency.toLowerCase()) return { kind: "other_currency", cents: null };
  return { kind, cents: a };
}

export function classifyLegacyFeeRow(row: StatementLegacyFeeRow, studioCurrency: string): { kind: StatementKind; cents: number | null } {
  if (row.status !== "succeeded" || row.stripeLivemode !== true) return { kind: "excluded", cents: null };
  const a = row.amountCents;
  if (typeof a !== "number" || !Number.isInteger(a) || a < 0) return { kind: "unresolved", cents: null };
  if (!row.currency || row.currency.toLowerCase() !== studioCurrency.toLowerCase()) return { kind: "other_currency", cents: null };
  // The legacy ledger records no refund: a real succeeded fee cannot be proven un-refunded, so it is not counted as collected.
  return { kind: "unresolved", cents: a };
}

export function buildStatement(input: {
  studioCurrency: string;
  appointments: readonly StatementAppointment[];
  cardRows: readonly StatementCardRow[];
  settlementRows: readonly StatementSettlementRow[];
  legacyFeeRows: readonly StatementLegacyFeeRow[];
}): Statement {
  const apptById = new Map(input.appointments.map((a) => [a.id, a]));
  const all = emptyBucket();
  const per = new Map<string | null, StatementBucket>();
  const visitMap = new Map<string, StatementVisit>();
  let rowsIn = 0;
  let rowsWithoutAppointment = 0;

  const place = (
    appointmentId: string,
    source: StatementMoneyLine["source"],
    c: { kind: StatementKind; cents: number | null },
  ): void => {
    rowsIn += 1;
    const appt = apptById.get(appointmentId);
    // A row whose appointment was not read is Unattributed and counted, never dropped and never guessed to a practitioner.
    if (!appt) rowsWithoutAppointment += 1;
    const pid = appt ? appt.practitionerId : null;
    put(all, c.kind, c.cents);
    let b = per.get(pid);
    if (!b) per.set(pid, (b = emptyBucket()));
    put(b, c.kind, c.cents);
    if (appt) {
      let v = visitMap.get(appt.id);
      if (!v) visitMap.set(appt.id, (v = { appointmentId: appt.id, startsAt: appt.startsAt, practitionerId: pid, lines: [] }));
      v.lines.push({ kind: c.kind, cents: AMOUNT_KINDS.includes(c.kind) ? c.cents : null, source });
    }
  };

  for (const r of input.cardRows) place(r.appointmentId, "card", classifyCardRow(r, input.studioCurrency));
  for (const r of input.settlementRows) place(r.appointmentId, "settlement", classifySettlementRow(r, input.studioCurrency));
  for (const r of input.legacyFeeRows) place(r.appointmentId, "legacy_fee", classifyLegacyFeeRow(r, input.studioCurrency));

  const byPractitioner = [...per.entries()]
    .map(([practitionerId, bucket]) => ({ practitionerId, bucket }))
    .sort((x, y) => {
      if (x.practitionerId === null) return 1;
      if (y.practitionerId === null) return -1;
      return x.practitionerId.localeCompare(y.practitionerId);
    });

  const rowsClassified = STATEMENT_KINDS.reduce((n, k) => n + all.kinds[k].count, 0);
  const visits = [...visitMap.values()].sort((x, y) => x.startsAt.localeCompare(y.startsAt) || x.appointmentId.localeCompare(y.appointmentId));
  return {
    currency: input.studioCurrency,
    all,
    byPractitioner,
    visits,
    reconciliation: { rowsIn, rowsClassified, rowsWithoutAppointment },
  };
}
