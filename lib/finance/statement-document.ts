import { AMOUNT_KINDS, COLLECTED_KINDS, type StatementKind, type StatementMoneyLine } from "@/lib/finance/statement";

// ===========================================================================
// The shared DOCUMENT MODEL for a client's statement or invoice. PURE: no I/O, no clock, no timezone lookup, no Stripe, no mail.
// ===========================================================================
//
// One selected client, one scope, a list of visits. The screen, the print view and the CSV are all driven from the value this module returns, so
// they cannot disagree. It invents NO money rule: every line it is given was already classified, once, by lib/finance/statement.ts (one kind per
// row, adjustments never netted into a collected line). This module only SELECTS visits, SUMS those kinds, and decides what may be SAID.
//
// WHAT IT NEVER DOES
//   * Treat a current menu price, a duration or a payment amount as the original charge. A fee is "recorded" only when a stored record carries it
//     (a settlement's quote snapshot, a card attempt's charged amount, a legacy fee row); otherwise it is "Fee not recorded".
//   * Invent a discount, a tax, a tax registration or a balance. There is no field for any of them.
//   * Claim a balance while anything in scope is unknown. A paid visit, an unknown one and a confirmed unpaid one are DIFFERENT states.
//   * Sum a row that carries no amount (unresolved, other currency, excluded, unreadable, still-owes note): only AMOUNT_KINDS carry cents.
//   * Count a visit twice (a repeated id in a selection counts once) or mix clients (a visit of another client is refused, never dropped).
//
// "TOTAL PAID" has ONE definition everywhere (TOTAL_PAID_DEFINITION): money Hone knows was collected AND KEPT (the five collected kinds).
// A fully refunded card payment is NOT in it; it is reported on its own line, and `originalPaidCents` = paid + refunded keeps "what was
// originally paid" distinguishable from "what was retained". A refund is never a service credit here: no record independently supports one.

export const TOTAL_PAID_DEFINITION =
  "Total spend is money recorded as collected and kept, including a cancellation or no-show fee only once its payment is confirmed. A payment that was fully refunded is shown on its own line and is not in total spend.";

// ---------------------------------------------------------------------------
// Closed vocabularies
// ---------------------------------------------------------------------------
/** What one visit IS, as far as the records can say. Exactly one per visit. */
export type VisitState =
  | "paid" //            money recorded as collected and kept, and nothing about the visit is uncertain
  | "unknown" //         Hone cannot say whether the visit was paid: shown as "awaiting payment confirmation", never as a balance
  | "confirmed_unpaid" // the owner attested the visit still owes, and nothing else about it is uncertain
  | "adjusted" //        nothing collected, but money was waived or fully refunded (see the lines)
  | "no_charge"; //      a RECORDED fee of exactly zero, nothing collected, nothing uncertain
export const VISIT_STATES: readonly VisitState[] = ["paid", "unknown", "confirmed_unpaid", "adjusted", "no_charge"];

/** Why a visit is `unknown`: a closed set, each with fixed copy. A visit may carry several. */
export type UnknownReason =
  | "no_payment_record" //          no collected, waived, refunded or attested row exists for the visit
  | "payment_unresolved" //         a card or fee row that may or may not have moved money (in flight, unprovable or partial refund, legacy fee)
  | "other_currency" //             a row in a currency other than the studio's, never summed
  | "unreadable_record" //          a row that could not be read (unknown method, negative or non-integer amount)
  | "partial_payment_unverified"; // money was collected, but less than the RECORDED fee, and nothing attests the rest is owed
export const UNKNOWN_REASONS: readonly UnknownReason[] = [
  "no_payment_record",
  "payment_unresolved",
  "other_currency",
  "unreadable_record",
  "partial_payment_unverified",
];

/** Facts about a visit that do not change its state but must be flagged where they appear. */
export type VisitFlag = "fee_not_recorded" | "fee_ambiguous" | "practitioner_unattributed" | "service_not_recorded";
export const VISIT_FLAGS: readonly VisitFlag[] = ["fee_not_recorded", "fee_ambiguous", "practitioner_unattributed", "service_not_recorded"];

export const UNKNOWN_REASON_COPY: Record<UnknownReason, string> = {
  no_payment_record: "No payment recorded",
  payment_unresolved: "A payment or refund is unresolved",
  other_currency: "Paid in another currency",
  unreadable_record: "A payment record could not be read",
  partial_payment_unverified: "Part paid; the rest is not confirmed",
};

export const FEE_NOT_RECORDED_COPY = "Fee not recorded";
export const NOT_COMPLETED_COPY = "Not completed";

// ---------------------------------------------------------------------------
// VISIT ELIGIBILITY (per the agreed visit rules). ONE function, so a change of rule is a change here only.
//   completed treatment                        -> a VISIT
//   no-show or cancelled WITH a recorded fee   -> a fee LINE ITEM (never a visit, never counted as one)
//   cancelled / no-show with no fee            -> off the document
//   booked in the future                       -> off the document
//   booked in the past, completion not recorded -> "Not completed": full-history view ONLY, no amount, never counted
// ---------------------------------------------------------------------------
export type Eligibility = "treatment" | "not_completed" | "fee_only" | "off_document";
export function classifyEligibility(a: { status: string; startsAt: string; hasFeeRecord: boolean }, nowIso: string): Eligibility {
  switch (a.status) {
    case "completed":
      return "treatment";
    case "cancelled":
    case "no_show":
      return a.hasFeeRecord ? "fee_only" : "off_document";
    case "confirmed":
      return a.startsAt > nowIso ? "off_document" : "not_completed";
    default:
      return "off_document"; // an unknown status is never promoted onto a document
  }
}
export type FeeReason = "late_cancellation_fee" | "no_show_fee";

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
export type FeeSource = "settlement_quote" | "card_attempt" | "legacy_fee";
/** A stored record that carries an amount for the visit. The loader supplies EVERY such record; this module picks. */
export type FeeCandidate = { source: FeeSource; cents: number | null };

export type DocumentVisitInput = {
  appointmentId: string;
  clientId: string;
  /** The studio-local calendar date and time of the visit's start, computed by the loader with the studio timezone ("YYYY-MM-DD", "HH:MM"). */
  localDate: string;
  localTime: string;
  startsAt: string;
  serviceName: string | null;
  scheduledMinutes: number | null;
  practitionerId: string | null;
  practitionerName: string | null;
  feeCandidates: readonly FeeCandidate[];
  /** The visit's money lines from buildStatement, already classified. */
  lines: readonly StatementMoneyLine[];
  /** From classifyEligibility. Absent means "treatment". `not_completed` rows carry no money and are shown only in the full-history scope. */
  eligibility?: "treatment" | "not_completed";
};

/** A recorded cancellation or no-show fee: its own line item, not a visit. */
export type FeeItemInput = {
  appointmentId: string;
  clientId: string;
  localDate: string;
  startsAt: string;
  reason: FeeReason;
  feeCandidates: readonly FeeCandidate[];
  lines: readonly StatementMoneyLine[];
};

export type DocumentScope =
  | { kind: "month"; month: string } //                                 "YYYY-MM", studio-local
  | { kind: "full_history" }
  | { kind: "range"; startLocal: string; endLocalInclusive: string } // "YYYY-MM-DD", inclusive at BOTH ends
  | { kind: "visits"; appointmentIds: readonly string[] }; //           any visits of this client, in any months

export type DocumentIdentity = {
  /** Only populated fields are carried; the renderer shows only what is here. */
  studioName: string;
  legalEntityName: string | null;
  address: string | null;
  contactEmail: string | null;
  /** Optional billing-profile fields (a later change adds them); absent means not recorded, never inferred. */
  phone?: string | null;
  website?: string | null;
};

export type BuildDocumentInput = {
  studioId: string;
  identity: DocumentIdentity;
  client: { id: string; name: string };
  scope: DocumentScope;
  /** Studio currency, lower or upper case. */
  currency: string;
  /** The studio-local date the document was prepared on ("YYYY-MM-DD"); supplied by the caller, this module reads no clock. */
  preparedOn: string;
  /** EVERY visit of this client in this studio that the loader considers part of the record. Scope selects from it. */
  visits: readonly DocumentVisitInput[];
  /** Recorded cancellation and no-show fees of this client (line items). Included in month, range and full-history scopes, never in a chosen-visits scope. */
  feeItems?: readonly FeeItemInput[];
};

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------
export type RecordedFee =
  | { state: "recorded"; cents: number; source: FeeSource }
  | { state: "not_recorded"; ambiguous: boolean };

export type DocumentVisit = {
  appointmentId: string;
  localDate: string;
  localTime: string;
  startsAt: string;
  serviceName: string | null;
  scheduledMinutes: number | null;
  practitionerId: string | null;
  practitionerName: string | null;
  fee: RecordedFee;
  state: VisitState;
  reasons: UnknownReason[];
  flags: VisitFlag[];
  /** Cents by kind for THIS visit (amount kinds only; the rest are counted, never summed). */
  paidCents: number;
  refundedCents: number;
  waivedCents: number;
  /** Cents still owed, ONLY when `state` is `confirmed_unpaid` and the amount is established from a recorded quote; otherwise null. */
  owedCents: number | null;
  lines: StatementMoneyLine[];
};

export type FeeItem = {
  appointmentId: string;
  localDate: string;
  startsAt: string;
  reason: FeeReason;
  fee: RecordedFee;
  /** `paid`: payment confirmed (counts toward total spend). `unconfirmed`: listed, adds nothing. */
  state: "paid" | "unconfirmed";
  paidCents: number;
  lines: StatementMoneyLine[];
};

export type NotCompletedRow = { appointmentId: string; localDate: string; localTime: string; serviceName: string | null; practitionerName: string | null };

export type BalanceDue =
  | { kind: "established"; cents: number }
  | { kind: "not_established"; because: "unknown_visits" | "unconfirmed_fee" | "fee_not_recorded" | "owed_amount_not_established" };

export type StatementDocument = {
  studioId: string;
  identity: DocumentIdentity;
  client: { id: string; name: string };
  scope: DocumentScope;
  currency: string;
  preparedOn: string;
  attribution: string;
  visits: DocumentVisit[];
  /** Cancellation / no-show fees as separate line items. */
  feeItems: FeeItem[];
  /** Full-history scope ONLY. No amounts, never counted, never in a total. */
  notCompleted: NotCompletedRow[];
  totals: {
    visitCount: number;
    /** TOTAL SPEND: money collected and kept, treatments plus confirmed fee payments (TOTAL_PAID_DEFINITION). */
    paidCents: number;
    treatmentPaidCents: number;
    feePaidCents: number;
    refundedCents: number;
    waivedCents: number;
    /** paid + fully refunded: what was originally paid, kept distinct from what was retained. */
    originalPaidCents: number;
    /** Sum of RECORDED fees only. Meaningful as "the fees" only when `feeTotalComplete`. */
    recordedFeeCents: number;
    feeTotalComplete: boolean;
    byState: Record<VisitState, number>;
  };
  /** Visits whose payment status is unknown, each with its date and reasons, in visit order. */
  awaiting: Array<{ appointmentId: string; localDate: string; reasons: UnknownReason[] }>;
  /** Omitted (not_established) while anything is unknown or an owed amount cannot be established. */
  balanceDue: BalanceDue;
};

export type DocumentError =
  | "invalid_scope"
  | "reversed_range"
  | "empty_selection"
  | "unknown_visit"
  | "foreign_visit"
  | "invalid_date"
  | "invalid_currency";

export type BuildDocumentResult = { ok: true; document: StatementDocument } | { ok: false; error: DocumentError };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const LOCAL_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const YEAR_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function isLocalDate(v: unknown): v is string {
  if (typeof v !== "string" || !LOCAL_DATE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** "2026-11-19" -> "Nov 19, 2026". No locale lookup: the same words on every machine. */
export function formatLocalDate(localDate: string): string {
  if (!isLocalDate(localDate)) return localDate;
  return `${MONTH_ABBR[Number(localDate.slice(5, 7)) - 1]} ${Number(localDate.slice(8, 10))}, ${localDate.slice(0, 4)}`;
}

export function documentAttribution(studioName: string): string {
  return `Prepared by Hone for ${studioName}`;
}

const isCents = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

const FEE_PRIORITY: readonly FeeSource[] = ["settlement_quote", "card_attempt", "legacy_fee"];

/**
 * The RECORDED fee of a visit, from the stored records only. The settlement quote snapshot wins (it is "the price at the time", snapshotted); else
 * the amount a card attempt was prepared for; else a legacy fee row. Records of one source that DISAGREE make the fee ambiguous: not recorded, flagged,
 * never a guess. A missing, negative or non-integer amount is not a fee. Zero is a real, recorded fee.
 */
export function resolveRecordedFee(candidates: readonly FeeCandidate[]): RecordedFee {
  for (const source of FEE_PRIORITY) {
    const amounts = [...new Set(candidates.filter((c) => c.source === source && isCents(c.cents)).map((c) => c.cents as number))];
    if (amounts.length === 1) return { state: "recorded", cents: amounts[0], source };
    if (amounts.length > 1) return { state: "not_recorded", ambiguous: true };
  }
  return { state: "not_recorded", ambiguous: false };
}

function sumKinds(lines: readonly StatementMoneyLine[], kinds: readonly StatementKind[]): number {
  let n = 0;
  for (const l of lines) if (kinds.includes(l.kind) && AMOUNT_KINDS.includes(l.kind) && isCents(l.cents)) n += l.cents;
  return n;
}
const REFUNDED_KINDS: readonly StatementKind[] = ["refunded_card_session", "refunded_card_fee"];

/** ONE visit -> its state, reasons, flags and amounts. Pure. */
export function classifyVisit(v: DocumentVisitInput): DocumentVisit {
  const fee = resolveRecordedFee(v.feeCandidates);
  const lines = [...v.lines];
  const paid = sumKinds(lines, COLLECTED_KINDS);
  const refunded = sumKinds(lines, REFUNDED_KINDS);
  const waived = sumKinds(lines, ["waived"]);
  const has = (k: StatementKind) => lines.some((l) => l.kind === k);

  const uncertain: UnknownReason[] = [];
  if (has("unresolved")) uncertain.push("payment_unresolved");
  if (has("other_currency")) uncertain.push("other_currency");
  if (has("unreadable")) uncertain.push("unreadable_record");
  const attestedOwes = has("still_owes_note");
  const feeCents = fee.state === "recorded" ? fee.cents : null;
  const quoteRecorded = fee.state === "recorded" && fee.source === "settlement_quote";

  let state: VisitState;
  let reasons: UnknownReason[] = [];
  let owed: number | null = null;

  if (uncertain.length > 0) {
    state = "unknown";
    reasons = uncertain;
  } else if (paid > 0) {
    if (feeCents !== null && paid + waived < feeCents) {
      if (attestedOwes && quoteRecorded) {
        state = "confirmed_unpaid";
        owed = feeCents - paid - waived;
      } else {
        state = "unknown";
        reasons = ["partial_payment_unverified"];
      }
    } else {
      state = "paid";
    }
  } else if (waived > 0 || refunded > 0) {
    state = "adjusted";
  } else if (attestedOwes) {
    state = "confirmed_unpaid";
    owed = quoteRecorded && feeCents !== null && feeCents > 0 ? feeCents : null;
  } else if (feeCents === 0) {
    state = "no_charge";
  } else {
    state = "unknown";
    reasons = ["no_payment_record"];
  }

  const flags: VisitFlag[] = [];
  if (fee.state === "not_recorded") flags.push(fee.ambiguous ? "fee_ambiguous" : "fee_not_recorded");
  if (v.practitionerId === null) flags.push("practitioner_unattributed");
  if (v.serviceName === null || v.serviceName.trim() === "") flags.push("service_not_recorded");

  return {
    appointmentId: v.appointmentId,
    localDate: v.localDate,
    localTime: v.localTime,
    startsAt: v.startsAt,
    serviceName: v.serviceName && v.serviceName.trim() !== "" ? v.serviceName : null,
    scheduledMinutes: v.scheduledMinutes,
    practitionerId: v.practitionerId,
    practitionerName: v.practitionerName,
    fee,
    state,
    reasons,
    flags,
    paidCents: paid,
    refundedCents: refunded,
    waivedCents: waived,
    owedCents: owed,
    lines,
  };
}

// ---------------------------------------------------------------------------
// Selection (scope -> visits)
// ---------------------------------------------------------------------------
export type SelectResult = { ok: true; visits: DocumentVisitInput[] } | { ok: false; error: DocumentError };

/** Which of this client's visits the scope names. Refuses a reversed range, an empty selection, and any id that is not one of this client's visits. */
export function selectVisits(clientId: string, all: readonly DocumentVisitInput[], scope: DocumentScope): SelectResult {
  // A visit of another client is a bug in the caller, refused loudly rather than silently dropped.
  if (all.some((v) => v.clientId !== clientId)) return { ok: false, error: "foreign_visit" };
  const ordered = [...all].sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.appointmentId.localeCompare(b.appointmentId));
  switch (scope.kind) {
    case "full_history":
      return { ok: true, visits: dedupe(ordered) };
    case "month": {
      if (!YEAR_MONTH.test(scope.month)) return { ok: false, error: "invalid_scope" };
      return { ok: true, visits: dedupe(ordered.filter((v) => v.localDate.slice(0, 7) === scope.month)) };
    }
    case "range": {
      if (!isLocalDate(scope.startLocal) || !isLocalDate(scope.endLocalInclusive)) return { ok: false, error: "invalid_date" };
      if (scope.startLocal > scope.endLocalInclusive) return { ok: false, error: "reversed_range" };
      return { ok: true, visits: dedupe(ordered.filter((v) => v.localDate >= scope.startLocal && v.localDate <= scope.endLocalInclusive)) };
    }
    case "visits": {
      const ids = [...new Set(scope.appointmentIds)];
      if (ids.length === 0) return { ok: false, error: "empty_selection" };
      const byId = new Map(ordered.map((v) => [v.appointmentId, v]));
      if (ids.some((id) => !byId.has(id))) return { ok: false, error: "unknown_visit" };
      const picked = new Set(ids);
      return { ok: true, visits: dedupe(ordered.filter((v) => picked.has(v.appointmentId))) };
    }
    default:
      return { ok: false, error: "invalid_scope" };
  }
}

function dedupe(visits: readonly DocumentVisitInput[]): DocumentVisitInput[] {
  const seen = new Set<string>();
  const out: DocumentVisitInput[] = [];
  for (const v of visits) {
    if (seen.has(v.appointmentId)) continue;
    seen.add(v.appointmentId);
    out.push(v);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------
export function buildStatementDocument(input: BuildDocumentInput): BuildDocumentResult {
  if (!isLocalDate(input.preparedOn)) return { ok: false, error: "invalid_date" };
  if (typeof input.currency !== "string" || input.currency.trim() === "") return { ok: false, error: "invalid_currency" };
  const isNotCompleted = (v: DocumentVisitInput) => v.eligibility === "not_completed";
  const treatments = input.visits.filter((v) => !isNotCompleted(v));
  const picked = selectVisits(input.client.id, treatments, input.scope);
  if (!picked.ok) return picked;
  const feeInputs = input.feeItems ?? [];
  if (feeInputs.some((f) => f.clientId !== input.client.id)) return { ok: false, error: "foreign_visit" };
  if (input.visits.some((v) => v.clientId !== input.client.id)) return { ok: false, error: "foreign_visit" };
  // A scope that names no visit at all (an empty month, a range with none) is a valid, EMPTY document; only an empty explicit selection is refused above.

  const visits = picked.visits.map(classifyVisit);
  const sc = input.scope;
  const inScope = (d: string) =>
    sc.kind === "full_history" || (sc.kind === "month" && d.slice(0, 7) === sc.month) || (sc.kind === "range" && d >= sc.startLocal && d <= sc.endLocalInclusive);
  const feeItems: FeeItem[] = [];
  const seenFee = new Set<string>();
  for (const f of [...feeInputs].sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.appointmentId.localeCompare(b.appointmentId))) {
    if (seenFee.has(f.appointmentId) || !inScope(f.localDate)) continue;
    seenFee.add(f.appointmentId);
    const lines = [...f.lines];
    const paidFee = sumKinds(lines, COLLECTED_KINDS);
    feeItems.push({
      appointmentId: f.appointmentId,
      localDate: f.localDate,
      startsAt: f.startsAt,
      reason: f.reason,
      fee: resolveRecordedFee(f.feeCandidates),
      state: paidFee > 0 && !lines.some((l) => l.kind === "unresolved" || l.kind === "other_currency" || l.kind === "unreadable") ? "paid" : "unconfirmed",
      paidCents: paidFee,
      lines,
    });
  }
  const notCompleted: NotCompletedRow[] =
    sc.kind === "full_history"
      ? input.visits
          .filter(isNotCompleted)
          .sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.appointmentId.localeCompare(b.appointmentId))
          .map((v) => ({ appointmentId: v.appointmentId, localDate: v.localDate, localTime: v.localTime, serviceName: v.serviceName, practitionerName: v.practitionerName }))
      : [];
  const byState = Object.fromEntries(VISIT_STATES.map((s) => [s, 0])) as Record<VisitState, number>;
  let paid = 0;
  let refunded = 0;
  let waived = 0;
  let recordedFee = 0;
  let feeComplete = true;
  const awaiting: StatementDocument["awaiting"] = [];
  for (const v of visits) {
    byState[v.state] += 1;
    paid += v.paidCents;
    refunded += v.refundedCents;
    waived += v.waivedCents;
    if (v.fee.state === "recorded") recordedFee += v.fee.cents;
    else feeComplete = false;
    if (v.state === "unknown") awaiting.push({ appointmentId: v.appointmentId, localDate: v.localDate, reasons: v.reasons });
  }

  const feePaid = feeItems.reduce((n, f) => n + (f.state === "paid" ? f.paidCents : 0), 0);
  paid += feePaid;
  let balanceDue: BalanceDue;
  if (byState.unknown > 0) balanceDue = { kind: "not_established", because: "unknown_visits" };
  else if (feeItems.some((f) => f.state === "unconfirmed")) balanceDue = { kind: "not_established", because: "unconfirmed_fee" };
  else if (!feeComplete) balanceDue = { kind: "not_established", because: "fee_not_recorded" };
  else if (visits.some((v) => v.state === "confirmed_unpaid" && v.owedCents === null)) balanceDue = { kind: "not_established", because: "owed_amount_not_established" };
  else balanceDue = { kind: "established", cents: visits.reduce((n, v) => n + (v.owedCents ?? 0), 0) };

  return {
    ok: true,
    document: {
      studioId: input.studioId,
      identity: input.identity,
      client: input.client,
      scope: input.scope,
      currency: input.currency.toLowerCase(),
      preparedOn: input.preparedOn,
      attribution: documentAttribution(input.identity.studioName),
      visits,
      feeItems,
      notCompleted,
      totals: {
        visitCount: visits.length,
        paidCents: paid,
        treatmentPaidCents: paid - feePaid,
        feePaidCents: feePaid,
        refundedCents: refunded,
        waivedCents: waived,
        originalPaidCents: paid + refunded,
        recordedFeeCents: recordedFee,
        feeTotalComplete: feeComplete,
        byState,
      },
      awaiting,
      balanceDue,
    },
  };
}

// ---------------------------------------------------------------------------
// Words (fixed, so screen, print and CSV say the same thing). `fmt` formats cents in the studio currency; it is supplied by the caller.
// ---------------------------------------------------------------------------
export function visitCountPhrase(n: number): string {
  return `${n} visit${n === 1 ? "" : "s"}`;
}

/** "$510 paid · 1 visit awaiting payment confirmation" (the second part only when something is unknown). */
export function paidSummaryLine(doc: StatementDocument, fmt: (cents: number) => string): string {
  const parts = [`${fmt(doc.totals.paidCents)} paid`];
  if (doc.awaiting.length > 0) parts.push(`${visitCountPhrase(doc.awaiting.length)} awaiting payment confirmation`);
  return parts.join(" · ");
}

/** "Nov 19, 2026 · $60 fee · No payment recorded", or "... · Fee not recorded · ..." when no stored record carries the fee. */
export function awaitingVisitLine(visit: DocumentVisit, fmt: (cents: number) => string): string {
  const fee = visit.fee.state === "recorded" ? `${fmt(visit.fee.cents)} fee` : FEE_NOT_RECORDED_COPY;
  const why = visit.reasons.map((r) => UNKNOWN_REASON_COPY[r]).join("; ");
  return `${formatLocalDate(visit.localDate)} · ${fee} · ${why}`;
}

// ---------------------------------------------------------------------------
// Output projections: the ONLY ways a document leaves this module for a snapshot, a preview or a CSV.
// Each field is picked EXPLICITLY. Nothing is spread (`...`) and no object is passed through whole, so an id (client, appointment, practitioner,
// studio) or any later-added field cannot reach the output by accident. Treatment areas, notes, machine settings, observations and clinical tags
// are not in the document and have no place here.
// ---------------------------------------------------------------------------
type Cell = string | number | null;

function pickFee(f: RecordedFee) {
  return f.state === "recorded"
    ? { state: "recorded" as const, cents: f.cents, source: f.source }
    : { state: "not_recorded" as const, cents: null, source: null };
}

function pickScope(sc: DocumentScope) {
  switch (sc.kind) {
    case "month":
      return { kind: "month" as const, month: sc.month };
    case "range":
      return { kind: "range" as const, startLocal: sc.startLocal, endLocalInclusive: sc.endLocalInclusive };
    case "visits":
      return { kind: "visits" as const, visitCount: new Set(sc.appointmentIds).size }; // the ids themselves never leave
    default:
      return { kind: "full_history" as const };
  }
}

/** The document as a plain, id-free value (preview, print data, snapshot body). The client is the NAME only. */
export function toSnapshot(doc: StatementDocument) {
  return {
    snapshot_version: 1 as const,
    preparedOn: doc.preparedOn,
    currency: doc.currency,
    attribution: doc.attribution,
    identity: {
      studioName: doc.identity.studioName,
      legalEntityName: doc.identity.legalEntityName,
      address: doc.identity.address,
      contactEmail: doc.identity.contactEmail,
      phone: doc.identity.phone ?? null,
      website: doc.identity.website ?? null,
    },
    client: { name: doc.client.name },
    scope: pickScope(doc.scope),
    visits: doc.visits.map((v) => ({
      localDate: v.localDate,
      localTime: v.localTime,
      serviceName: v.serviceName,
      practitionerName: v.practitionerName,
      fee: pickFee(v.fee),
      state: v.state,
      reasons: [...v.reasons],
      paidCents: v.paidCents,
      refundedCents: v.refundedCents,
      waivedCents: v.waivedCents,
      owedCents: v.owedCents,
    })),
    lineItems: doc.feeItems.map((f) => ({ localDate: f.localDate, reason: f.reason, fee: pickFee(f.fee), state: f.state, paidCents: f.paidCents })),
    notCompleted: doc.notCompleted.map((r) => ({ localDate: r.localDate, localTime: r.localTime, serviceName: r.serviceName, practitionerName: r.practitionerName })),
    totals: {
      visitCount: doc.totals.visitCount,
      paidCents: doc.totals.paidCents,
      treatmentPaidCents: doc.totals.treatmentPaidCents,
      feePaidCents: doc.totals.feePaidCents,
      refundedCents: doc.totals.refundedCents,
      waivedCents: doc.totals.waivedCents,
      originalPaidCents: doc.totals.originalPaidCents,
      recordedFeeCents: doc.totals.recordedFeeCents,
      feeTotalComplete: doc.totals.feeTotalComplete,
    },
    balance: doc.balanceDue.kind === "established" ? { kind: "established" as const, cents: doc.balanceDue.cents, because: null } : { kind: "not_established" as const, cents: null, because: doc.balanceDue.because },
  };
}

/**
 * The value handed to the issue command. It is `toSnapshot` plus the client id in ONE place (`client.id`), only so the database can check it against its
 * own client argument; the command removes it before storing, so a stored snapshot holds the client name only.
 */
export function toIssueSnapshot(doc: StatementDocument) {
  const body = toSnapshot(doc);
  // No `notCompleted`: a "Not completed" row never appears on an invoice.
  return { snapshot_version: body.snapshot_version, preparedOn: body.preparedOn, currency: body.currency, attribution: body.attribution, identity: body.identity, client: { id: doc.client.id, name: body.client.name }, scope: body.scope, visits: body.visits, lineItems: body.lineItems, totals: body.totals, balance: body.balance };
}

export const CSV_COLUMNS = ["row_type", "date", "time", "service", "practitioner", "fee_state", "fee_cents", "state", "reasons", "paid_cents", "refunded_cents", "waived_cents", "owed_cents"] as const;

/** CSV rows (header first), every record exactly once, columns picked explicitly. Serialising and quoting is the caller's, through lib/csv. */
export function toCsvRows(doc: StatementDocument): Cell[][] {
  const rows: Cell[][] = [[...CSV_COLUMNS]];
  for (const v of doc.visits) {
    const f = pickFee(v.fee);
    rows.push(["visit", v.localDate, v.localTime, v.serviceName, v.practitionerName, f.state, f.cents, v.state, v.reasons.join("|"), v.paidCents, v.refundedCents, v.waivedCents, v.owedCents]);
  }
  for (const i of doc.feeItems) {
    const f = pickFee(i.fee);
    rows.push([i.reason, i.localDate, null, null, null, f.state, f.cents, i.state, "", i.paidCents, 0, 0, null]);
  }
  for (const r of doc.notCompleted) rows.push(["not_completed", r.localDate, r.localTime, r.serviceName, r.practitionerName, null, null, "not_completed", "", null, null, null, null]);
  return rows;
}
