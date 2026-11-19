import { localDateString, localTimeString } from "@/lib/booking/tz";
import {
  AMOUNT_KINDS,
  buildStatement,
  classifyCardRow,
  classifyLegacyFeeRow,
  type Statement,
  type StatementCardRow,
  type StatementLegacyFeeRow,
  type StatementMoneyLine,
  type StatementSettlementRow,
} from "@/lib/finance/statement";
import {
  classifyEligibility,
  type DocumentVisitInput,
  type FeeCandidate,
  type FeeItemInput,
  type FeeReason,
} from "@/lib/finance/statement-document";

// ===========================================================================
// Assembles a client's document INPUT from stored rows. PURE: no I/O, no clock (the caller supplies `nowIso`), no Stripe, no mail.
// ===========================================================================
//
// The money is classified by the EXISTING lib/finance/statement.ts, once per row, unchanged. This module only (1) places each appointment on the
// document through the ONE eligibility function, (2) gathers the stored records that carry an amount for a visit (the fee candidates) and
// (3) converts the visit start to the studio's local date and time.
//
// FEE CANDIDATES come only from stored records, never from a current price:
//   * a settlement's quote snapshot;
//   * a card attempt's amount, only for a cancellation or no-show fee, or when it is the ONLY money row of its visit (with a card part and a
//     cash part, the card amount is a part of the fee, not the fee);
//   * a legacy fee-ledger row's amount.
// Records in another currency are not candidates (they are not an amount in the studio currency).

const FEE_REASONS: readonly FeeReason[] = ["no_show_fee", "late_cancellation_fee"];

export type AssembleAppointment = {
  id: string;
  clientId: string;
  startsAt: string;
  status: string;
  practitionerId: string | null;
  serviceId: string | null;
  durationMinutes: number | null;
};
export type AssembleSettlementRow = StatementSettlementRow & { quotedAmountCents: number | null };

export type AssembleInput = {
  studioCurrency: string;
  timezone: string;
  /** ISO instant "now": a booking after it is a future booking. */
  nowIso: string;
  appointments: readonly AssembleAppointment[];
  cardRows: readonly StatementCardRow[];
  settlementRows: readonly AssembleSettlementRow[];
  legacyFeeRows: readonly StatementLegacyFeeRow[];
  serviceNames: ReadonlyMap<string, string>;
  practitionerNames: ReadonlyMap<string, string>;
};

export type AssembleResult = {
  visits: DocumentVisitInput[];
  feeItems: FeeItemInput[];
  /** The unchanged statement over the same rows: the reconciliation reference. */
  statement: Statement;
  /** Appointments kept OFF the document that nevertheless carry money (a future booking with a payment). Reported, never silently dropped. */
  offDocumentWithMoney: number;
};

const isCents = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const sameCurrency = (c: string | null, studio: string) => typeof c === "string" && c.toLowerCase() === studio.toLowerCase();

export function assembleClientInputs(input: AssembleInput): AssembleResult {
  const statement = buildStatement({
    studioCurrency: input.studioCurrency,
    appointments: input.appointments.map((a) => ({ id: a.id, practitionerId: a.practitionerId, startsAt: a.startsAt })),
    cardRows: [...input.cardRows],
    settlementRows: [...input.settlementRows],
    legacyFeeRows: [...input.legacyFeeRows],
  });
  const linesByAppt = new Map<string, StatementMoneyLine[]>();
  for (const v of statement.visits) linesByAppt.set(v.appointmentId, v.lines);

  const cardsBy = group(input.cardRows, (r) => r.appointmentId);
  const settlementsBy = group(input.settlementRows, (r) => r.appointmentId);
  const legacyBy = group(input.legacyFeeRows, (r) => r.appointmentId);

  const visits: DocumentVisitInput[] = [];
  const feeItems: FeeItemInput[] = [];
  let offDocumentWithMoney = 0;

  for (const a of input.appointments) {
    const lines = linesByAppt.get(a.id) ?? [];
    const cards = cardsBy.get(a.id) ?? [];
    const settlements = settlementsBy.get(a.id) ?? [];
    const legacy = legacyBy.get(a.id) ?? [];
    // An EXCLUDED row (a failed or test-mode attempt) moved no money and is not a record of any: it never makes a fee line or a payment line.
    const hasMoney = lines.some((l) => l.kind !== "excluded");
    // On a cancelled or no-show booking, ANY recorded money is its fee line.
    const eligibility = classifyEligibility({ status: a.status, startsAt: a.startsAt, hasFeeRecord: hasMoney }, input.nowIso);
    if (eligibility === "off_document") {
      if (hasMoney) offDocumentWithMoney += 1;
      continue;
    }

    // Only REAL rows count as records: a failed, cancelled or test-mode attempt moved no money and is neither a fee nor the sole payment (a failed
    // attempt followed by a successful retry is ONE card payment).
    const realCards = cards.filter((c) => classifyCardRow(c, input.studioCurrency).kind !== "excluded");
    const realLegacy = legacy.filter((l) => classifyLegacyFeeRow(l, input.studioCurrency).kind !== "excluded");
    const soleCard = realCards.length === 1 && settlements.length === 0 && realLegacy.length === 0;
    const candidates: FeeCandidate[] = [];
    // A quote in ANOTHER currency is not an amount in the studio currency (a missing currency is the studio's, as the statement reads it).
    for (const s of settlements) if (!s.currency || sameCurrency(s.currency, input.studioCurrency)) candidates.push({ source: "settlement_quote", cents: isCents(s.quotedAmountCents) ? s.quotedAmountCents : null });
    for (const c of realCards) {
      if (!sameCurrency(c.currency, input.studioCurrency)) continue;
      const isFee = FEE_REASONS.includes(c.chargeReason as FeeReason);
      if (isFee || (c.chargeReason === "session_payment" && soleCard)) candidates.push({ source: "card_attempt", cents: isCents(c.amountCents) ? c.amountCents : null });
    }
    for (const l of realLegacy) if (sameCurrency(l.currency, input.studioCurrency)) candidates.push({ source: "legacy_fee", cents: isCents(l.amountCents) ? l.amountCents : null });

    const start = new Date(a.startsAt);
    const localDate = localDateString(start, input.timezone);

    if (eligibility === "fee_only") {
      // A fee label only when a FEE record exists; any other money on a cancelled or no-show booking is a neutral "payment" line, never called a fee.
      const cardReason = realCards.map((c) => c.chargeReason).find((r) => FEE_REASONS.includes(r as FeeReason)) as FeeReason | undefined;
      const isFee = cardReason !== undefined || realLegacy.length > 0;
      const reason: FeeReason = cardReason ?? (isFee ? (a.status === "no_show" ? "no_show_fee" : "late_cancellation_fee") : "cancelled_booking_payment");
      feeItems.push({ appointmentId: a.id, clientId: a.clientId, localDate, startsAt: a.startsAt, reason, feeCandidates: candidates, lines });
      continue;
    }

    // A past booking never marked completed stays "Not completed" (no charge on it). Any recorded payment is listed APART, once, as a payment on an
    // uncompleted booking; a payment alone never completes a visit or creates a treatment charge.
    if (eligibility === "not_completed" && hasMoney) {
      feeItems.push({ appointmentId: a.id, clientId: a.clientId, localDate, startsAt: a.startsAt, reason: "uncompleted_booking_payment", feeCandidates: [], lines });
    }

    visits.push({
      appointmentId: a.id,
      clientId: a.clientId,
      localDate,
      localTime: localTimeString(start, input.timezone),
      startsAt: a.startsAt,
      serviceName: a.serviceId ? input.serviceNames.get(a.serviceId) ?? null : null,
      scheduledMinutes: a.durationMinutes,
      practitionerId: a.practitionerId,
      practitionerName: a.practitionerId ? input.practitionerNames.get(a.practitionerId) ?? null : null,
      feeCandidates: candidates,
      lines,
      eligibility,
    });
  }
  return { visits, feeItems, statement, offDocumentWithMoney };
}

function group<T>(rows: readonly T[], key: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const l = m.get(k);
    if (l) l.push(r);
    else m.set(k, [r]);
  }
  return m;
}

/** Cents of every AMOUNT kind that counts as collected-and-kept in a statement's totals: the reconciliation reference. */
export function statementCollectedCents(statement: Statement): number {
  const k = statement.all.kinds;
  return (["collected_card_session", "collected_card_fee", "collected_cash", "collected_e_transfer", "collected_other_external"] as const).reduce(
    (n, kind) => n + (AMOUNT_KINDS.includes(kind) ? k[kind].cents : 0),
    0,
  );
}
