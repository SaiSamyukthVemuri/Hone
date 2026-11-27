// ===========================================================================
// Split payments and partial refunds — the PURE half (HON-123 / HON-122).
// ===========================================================================
// No I/O. The database (0393/0394) decides every money question under its own lock; nothing here is an authority. This module
//   * turns what a person typed into cents, strictly (no rounding, no guessing),
//   * turns the database's refusal codes into plain sentences with a next step,
//   * derives the itemised history and the balance the screens print (the same arithmetic as visit_payment_position, so a
//     screen and the database agree, and a test pins that they do),
//   * names the states of a card payment whose outcome is not yet known, so the screen can never offer a second charge
//     while the first one is unresolved.

import { formatMoney } from "@/lib/billing/payment-jurisdiction";

export type VisitCurrency = "cad" | "usd";
export type ExternalMethod = "paid_cash" | "paid_e_transfer" | "paid_other_external";

/** Dollars as typed ("75", "75.5", "75.50") to whole cents. null for anything else: no sign, no thousands separator, no 3rd decimal. */
export function parseDollarsToCents(raw: unknown, maxCents = 200_000): number | null {
  if (typeof raw !== "string") return null;
  const m = /^(\d{1,6})(?:\.(\d{1,2}))?$/.exec(raw.trim());
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || 0);
  return cents >= 1 && cents <= maxCents ? cents : null;
}

// ---------------------------------------------------------------------------
// The ledger as the screens read it
// ---------------------------------------------------------------------------
export type LedgerBill = { id: string; totalCents: number; currency: VisitCurrency; referenceFeeCents: number | null; feeAdjustmentReason: string | null; createdAt: string };
export type LedgerCard = {
  kind: "card"; id: string; amountCents: number; status: "ready" | "pending_stripe" | "succeeded" | "failed" | string; at: string;
  /** Hone's fee on this charge (0392), owner/admin breakdown only. null = none. */
  platformFeeCents: number | null;
  /** The receipt for this payment was already sent (payment_charge_attempts.receipt_sent_at). Optional: absent = unknown, treated as not sent. */
  receiptSent?: boolean;
};
export type LedgerExternal = {
  kind: "external"; id: string; method: ExternalMethod; amountCents: number; state: "confirmed" | "pending_confirmation" | "voided"; at: string; note: string | null;
};
export type LedgerRefund = {
  id: string; amountCents: number; kind: "price_reduction" | "payment_reversal"; status: "pending_stripe" | "succeeded" | "failed";
  attemptId: string | null; externalPaymentId: string | null; reason: string; at: string; platformFeeReturnedCents: number | null;
  /** Money returned in the Stripe dashboard (a fixed Hone sentence, never staff text): shown with a FIXED label, and its stored reason is never displayed. */
  observed?: boolean;
};
/** A refund Stripe reported that Hone did not make, waiting for the owner. Closed fields only. */
export type LedgerReview = { id: string; amountCents: number; settled: boolean };
export const OBSERVED_REFUND_LABEL = "Refunded in the Stripe dashboard";
/** `reviewOpen`: a refund Stripe reported that Hone did not make is waiting for the owner (the payment is frozen and the visit is NOT settled). */
export type VisitLedger = { bill: LedgerBill | null; cards: LedgerCard[]; externals: LedgerExternal[]; refunds: LedgerRefund[]; reviewOpen?: boolean; reviews?: LedgerReview[] };

/**
 * A billed attempt's OWN refund columns (0078 full only, 0240 full amount only) are Stripe's cumulative statement of the whole payment. When they say more
 * came back than the ledger rows do (the owner refunded the rest in the Stripe dashboard), the difference is returned money with no row of its own. This
 * is the same rule as payment_refund_money (0393): the greater of the two, never the sum. loadVisitLedger cross-checks the total against the database.
 */
export function aggregateRefundGaps(
  attempt: { id: string; amountCents: number; refundStatus: string | null; refundAmountCents: number | null },
  itemisedSucceededCents: number, itemisedPendingCents: number,
): { succeededGapCents: number; pendingGapCents: number } {
  const aggregate = Math.min(attempt.amountCents, attempt.refundAmountCents ?? attempt.amountCents);
  if (attempt.refundStatus === "succeeded") return { succeededGapCents: Math.max(0, aggregate - itemisedSucceededCents), pendingGapCents: 0 };
  if (attempt.refundStatus === "pending_stripe") return { succeededGapCents: 0, pendingGapCents: Math.max(0, aggregate - itemisedPendingCents) };
  return { succeededGapCents: 0, pendingGapCents: 0 };
}

export type VisitBalance = {
  totalCents: number; confirmedCents: number; pendingCents: number; cardCents: number; refundedCents: number;
  /** Still collectable: what a new tender may take. Pending transfers are NOT in it (they are reserved). */
  collectableCents: number;
  /** Still owed in the sense of "not yet received": collectable plus the pending transfers. */
  owedCents: number;
};

/** Mirrors the database's visit_payment_position (0394). The database is the authority; a test keeps this honest. */
export function visitBalance(l: VisitLedger): VisitBalance | null {
  if (!l.bill) return null;
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const confirmedCents = sum(l.externals.filter((e) => e.state === "confirmed").map((e) => e.amountCents));
  const pendingCents = sum(l.externals.filter((e) => e.state === "pending_confirmation").map((e) => e.amountCents));
  const cardCents = sum(l.cards.filter((c) => ["ready", "pending_stripe", "succeeded"].includes(c.status)).map((c) => c.amountCents));
  // Only a SUCCEEDED refund counts (0394): one still with Stripe may yet fail, so it frees no capacity.
  const refundedCents = sum(l.refunds.filter((r) => r.status === "succeeded").map((r) => r.amountCents));
  // PRODUCT RULE (Sam, 27 Nov 2026), the same as visit_payment_position (0394): refunding a paid visit does not by itself reopen a balance. Only a succeeded
  // price_reduction (the bill already dropped by that amount) adds back; a payment_reversal does not. `refundedCents` stays ALL money returned.
  const reducedCents = sum(l.refunds.filter((r) => r.status === "succeeded" && r.kind === "price_reduction").map((r) => r.amountCents));
  const collectableCents = Math.max(0, l.bill.totalCents - confirmedCents - pendingCents - cardCents + reducedCents);
  return { totalCents: l.bill.totalCents, confirmedCents, pendingCents, cardCents, refundedCents, collectableCents, owedCents: collectableCents + pendingCents };
}

export type HistoryLine = {
  key: string;
  label: string;
  amountCents: number;
  /** "in" adds to what was received, "out" is money handed back. */
  direction: "in" | "out";
  status: "received" | "pending" | "voided" | "failed" | "in_progress" | "refund_in_progress" | "not_sent" | "cancelled";
  at: string;
};

const METHOD_LABEL: Record<ExternalMethod, string> = { paid_cash: "Cash", paid_e_transfer: "E-transfer", paid_other_external: "Transfer or other" };
export const methodLabel = (m: ExternalMethod) => METHOD_LABEL[m];

/** The itemised payment history, oldest first, voided and failed lines kept visible (financial history is never hidden). */
export function historyLines(l: VisitLedger): HistoryLine[] {
  const lines: HistoryLine[] = [];
  for (const c of l.cards) {
    // A prepared charge that was never run is not a payment, but it HOLDS its amount against the balance, so it is listed (never hidden) and can be cancelled.
    lines.push({
      key: `card:${c.id}`, label: "Card", amountCents: c.amountCents, direction: "in", at: c.at,
      status: c.status === "succeeded" ? "received" : c.status === "pending_stripe" ? "in_progress" : c.status === "ready" ? "not_sent" : c.status === "cancelled" ? "cancelled" : "failed",
    });
  }
  for (const e of l.externals) {
    lines.push({
      key: `ext:${e.id}`, label: methodLabel(e.method), amountCents: e.amountCents, direction: "in", at: e.at,
      status: e.state === "confirmed" ? "received" : e.state === "pending_confirmation" ? "pending" : "voided",
    });
  }
  for (const r of l.refunds) {
    const what = r.observed ? OBSERVED_REFUND_LABEL : r.kind === "price_reduction" ? "Price reduced, money returned" : "Payment returned";
    const from = r.attemptId ? "card" : "cash or transfer";
    lines.push({
      key: `refund:${r.id}`, label: r.observed ? `${what} (card)` : `${what} (${from})`, amountCents: r.amountCents, direction: "out", at: r.at,
      status: r.status === "succeeded" ? "received" : r.status === "pending_stripe" ? "refund_in_progress" : "failed",
    });
  }
  return lines.sort((a, b) => a.at.localeCompare(b.at) || a.key.localeCompare(b.key));
}

export const STATUS_LABEL: Record<HistoryLine["status"], string> = {
  received: "Received", pending: "Waiting for confirmation", voided: "Voided", failed: "Failed", in_progress: "Checking payment status", refund_in_progress: "Checking refund status", not_sent: "Prepared, not charged (holds this amount)", cancelled: "Cancelled",
};

// ---------------------------------------------------------------------------
// The database's refusals, in plain words
// ---------------------------------------------------------------------------
export type CommandNote = { tone: "ok" | "info" | "blocked"; message: string };

const MONEY = (c: number, cur: VisitCurrency | null) => formatMoney(c, cur);

/** result codes of the 0394 commands (and the card wall's PY001/PY002) to a sentence that says what happened and what to do. */
export function commandNote(code: string, ctx: { collectableCents?: number; currency?: VisitCurrency | null } = {}): CommandNote {
  const left = typeof ctx.collectableCents === "number" ? ` ${MONEY(ctx.collectableCents, ctx.currency ?? null)} is still collectable.` : "";
  switch (code) {
    case "created": case "exists": return { tone: "ok", message: "The bill for this visit is ready." };
    case "recorded": return { tone: "ok", message: "Payment recorded." };
    case "already_recorded": return { tone: "info", message: "That payment was already recorded, so nothing was added." };
    case "confirmed": return { tone: "ok", message: "Transfer confirmed. It now counts as received." };
    case "already_confirmed": return { tone: "info", message: "That transfer was already confirmed." };
    case "voided": return { tone: "ok", message: "Transfer cancelled. Its amount can be collected again." };
    case "already_voided": return { tone: "info", message: "That transfer was already cancelled." };
    case "requested": return { tone: "ok", message: "Refund recorded." };
    case "already_requested": return { tone: "info", message: "That refund was already recorded, so nothing was added." };
    case "reserved_for_pending_transfer": case "PY001":
      return { tone: "blocked", message: "This amount is reserved for a pending transfer. Confirm the transfer when the money arrives, or cancel it to collect this amount another way." };
    case "exceeds_balance": case "PY002":
      return { tone: "blocked", message: `That is more than is still collectable on this visit.${left}` };
    case "refund_failed": return { tone: "blocked", message: "Stripe could not complete this refund. Nothing was returned." };
    case "exceeds_refundable": return { tone: "blocked", message: "That is more than is left to refund on this payment. Choose a smaller amount." };
    case "exceeds_bill": return { tone: "blocked", message: "A price reduction cannot be more than the bill." };
    case "confirmed_is_final": return { tone: "blocked", message: "A confirmed payment cannot be cancelled. If the money went back to the client, record a refund." };
    case "payment_not_refundable": return { tone: "blocked", message: "That payment has not been received, so it cannot be refunded." };
    case "method_unavailable": return { tone: "blocked", message: "E-transfer is not used for a US studio. Record it as a transfer or other payment." };
    case "not_completed": return { tone: "blocked", message: "Finish the visit before taking payment." };
    case "already_settled": return { tone: "blocked", message: "This visit already has a recorded outcome (paid another way or waived), so it cannot be split. The studio owner can correct that record first." };
    case "card_attempt_prepared": return { tone: "blocked", message: "A card payment is already prepared for this visit. Finish it or cancel it first, then split the payment." };
    case "cancelled": return { tone: "ok", message: "Cancelled. Its amount can be collected again." };
    case "already_cancelled": return { tone: "info", message: "That card payment was already cancelled." };
    case "not_cancellable": return { tone: "blocked", message: "That card payment has already been sent, so it cannot be cancelled. Reload the page to see where it stands." };
    case "card_payment_exists": return { tone: "blocked", message: "This visit already has a card payment, so it cannot be split." };
    case "price_missing": return { tone: "blocked", message: "Check the fee for this visit first: it has no price." };
    case "no_bill": return { tone: "blocked", message: "This visit has no bill yet. Reload the page and try again." };
    case "split_payments_off": return { tone: "blocked", message: "Split payments are not switched on for this studio." };
    case "not_owner": return { tone: "blocked", message: "Only the studio owner can do that." };
    case "not_found": return { tone: "blocked", message: "That was not found in this studio. Reload the page." };
    case "submission_reused": return { tone: "blocked", message: "That form was already used for a different amount. Reload the page and enter it again." };
    case "review_open": return { tone: "blocked", message: "A refund made in your Stripe dashboard is waiting for you to confirm it. Confirm it first, then refund again." };
    case "resolved": return { tone: "ok", message: "Recorded. This refund now counts on the visit." };
    case "already_resolved": case "already_covered": return { tone: "info", message: "That refund was already recorded." };
    case "not_settled": return { tone: "info", message: "Stripe has not finished this refund yet. Check back shortly." };
    case "refund_pending": return { tone: "blocked", message: "A refund started here is still being completed by Stripe. Wait for it to finish, then confirm this one." };
    case "over_capacity": return { tone: "blocked", message: "This refund plus the others is more than the payment. It is left for support to review." };
    case "invalid_input": return { tone: "blocked", message: "Check the amount and the details, then try again." };
    default: return { tone: "blocked", message: "That did not go through and nothing was changed. Reload the page and check before trying again." };
  }
}

// ---------------------------------------------------------------------------
// A card payment whose outcome is not known
// ---------------------------------------------------------------------------
// "Checking payment status" is shown EXACTLY while the answer is unknown, and while it is shown there is NO charge control: a second
// click could create a second charge. The same attempt id carries the same idempotency key to Stripe, so checking again is safe.
export const CHECKING_PAYMENT_STATUS = "Checking payment status";

export type CardPhase =
  | { phase: "idle" }
  | { phase: "preparing" }
  | { phase: "charging"; attemptId: string }
  | { phase: "unknown"; attemptId: string }          // the response never arrived, or Stripe has not said yet
  | { phase: "succeeded"; attemptId: string }
  | { phase: "failed"; attemptId: string | null; message: string };

export type CardEvent =
  | { type: "submit" }
  | { type: "prepared"; attemptId: string }
  | { type: "prepare_refused"; text: string }
  | { type: "result"; outcome: "succeeded" | "failed" | "unknown"; text?: string }
  | { type: "lost_response" }
  | { type: "status"; outcome: "succeeded" | "failed" | "unknown"; text?: string }
  | { type: "restore"; attemptId: string }
  /** The ledger (re-read, or changed on another device) now says this attempt is no longer pending at Stripe. */
  | { type: "ledger_settled"; attemptId: string; status: "succeeded" | "failed" };

export function cardReduce(s: CardPhase, e: CardEvent): CardPhase {
  switch (e.type) {
    case "submit": return s.phase === "idle" || s.phase === "failed" || s.phase === "succeeded" ? { phase: "preparing" } : s;   // never from unknown or charging; a finished payment does not block the next one
    case "prepared": return s.phase === "preparing" ? { phase: "charging", attemptId: e.attemptId } : s;
    case "prepare_refused": return s.phase === "preparing" ? { phase: "failed", attemptId: null, message: e.text } : s;
    // A page that loads while a card payment is still unresolved (pending_stripe) starts in the checking state: no charge control, a recheck instead.
    // Also from a finished phase when the unresolved attempt is a DIFFERENT one (a second device started it): the checking state wins, no charge control.
    case "restore":
      if (s.phase === "idle") return { phase: "unknown", attemptId: e.attemptId };
      if ((s.phase === "succeeded" || s.phase === "failed") && s.attemptId !== e.attemptId) return { phase: "unknown", attemptId: e.attemptId };
      return s;
    // Checking ends when the ledger itself proves the outcome for the attempt being checked; any other attempt's news is ignored.
    case "ledger_settled":
      if (s.phase !== "unknown" || s.attemptId !== e.attemptId) return s;
      return e.status === "succeeded" ? { phase: "succeeded", attemptId: e.attemptId } : { phase: "failed", attemptId: e.attemptId, message: "The card was not charged." };
    case "lost_response": return s.phase === "charging" ? { phase: "unknown", attemptId: s.attemptId } : s;
    case "result": case "status": {
      if (s.phase !== "charging" && s.phase !== "unknown") return s;
      if (e.outcome === "succeeded") return { phase: "succeeded", attemptId: s.attemptId };
      if (e.outcome === "failed") return { phase: "failed", attemptId: s.attemptId, message: e.text ?? "The card was not charged." };
      return { phase: "unknown", attemptId: s.attemptId };
    }
  }
}

// ---------------------------------------------------------------------------
// Submission ids: ONE id per distinct intent (its fingerprint), kept across a lost answer so a retry of the SAME intent is the same command, and never shared
// with a different intent (a different payment, amount, kind or reason is a different command and must not replay the first).
// ---------------------------------------------------------------------------
export type Submissions = Readonly<Record<string, string>>;
export const chargeFingerprint = (a: { tender: string; cents: number | null; currency: string }) => `charge|${a.tender}|${a.cents ?? "x"}|${a.currency}`;
export const refundFingerprint = (a: { paymentId: string; cents: number | null; kind: string; reason: string }) => `refund|${a.paymentId}|${a.cents ?? "x"}|${a.kind}|${a.reason.trim()}`;
/** The id for this intent: the one already held, or the freshly minted one (returned with the next map). */
export function submissionFor(subs: Submissions, fingerprint: string, mint: () => string): { id: string; next: Submissions } {
  const held = subs[fingerprint];
  if (held) return { id: held, next: subs };
  const id = mint();
  return { id, next: { ...subs, [fingerprint]: id } };
}
/** A definite answer ends this intent: the next time it is asked it is a new command. */
export function settleSubmission(subs: Submissions, fingerprint: string): Submissions {
  if (!(fingerprint in subs)) return subs;
  const next = { ...subs }; delete next[fingerprint];
  return next;
}

/**
 * THE MECHANISM (one rule for every path). A submission id is released ONLY when it is bound to a FINISHED row that a retry would replay, and keeping it is always safe
 * (the same intent simply runs as the same command; a changed amount is a different fingerprint and a different id anyway). So `idDisposition` releases on exactly:
 *   - ok AND a success code, read TOGETHER (a card refund the runner blocked answers code "requested" with ok:false: a pending row exists and Stripe was not asked, so it KEEPS);
 *   - refund_failed (the row is failed; a retry would replay it);
 *   - submission_reused (the id is bound to another row).
 * Everything else keeps: checking, unavailable (the database may have committed before the answer was lost), unknown codes, thrown errors, malformed rows, and every refusal
 * (not_owner, split_payments_off and not_found can come BEFORE the replay lookup, so they do not prove nothing was written under this id).
 */
export const SUCCESS_CODES = [
  "created", "exists", "recorded", "already_recorded", "confirmed", "already_confirmed", "voided", "already_voided",
  "requested", "already_requested", "cancelled", "already_cancelled", "resolved", "already_resolved", "already_covered",
] as const;
export const RELEASE_ANY_CODES = ["refund_failed", "submission_reused"] as const;
export const KEEP_CODES = [
  "unavailable", "not_owner", "not_found", "split_payments_off", "invalid_input", "no_bill", "method_unavailable", "reserved_for_pending_transfer", "PY001",
  "exceeds_balance", "PY002", "exceeds_refundable", "exceeds_bill", "confirmed_is_final", "payment_not_refundable", "not_completed", "already_settled",
  "card_attempt_prepared", "not_cancellable", "card_payment_exists", "price_missing", "review_open", "not_settled", "refund_pending", "over_capacity",
] as const;
export type KnownCommandCode = (typeof SUCCESS_CODES)[number] | (typeof RELEASE_ANY_CODES)[number] | (typeof KEEP_CODES)[number];
const KNOWN = new Set<string>([...SUCCESS_CODES, ...RELEASE_ANY_CODES, ...KEEP_CODES]);

function dispositionOfKnown(code: KnownCommandCode, ok: boolean): "release" | "keep" {
  switch (code) {
    case "created": case "exists": case "recorded": case "already_recorded": case "confirmed": case "already_confirmed": case "voided": case "already_voided":
    case "requested": case "already_requested": case "cancelled": case "already_cancelled": case "resolved": case "already_resolved": case "already_covered":
      return ok ? "release" : "keep";
    case "refund_failed": case "submission_reused":
      return "release";
    case "unavailable": case "not_owner": case "not_found": case "split_payments_off": case "invalid_input": case "no_bill": case "method_unavailable":
    case "reserved_for_pending_transfer": case "PY001": case "exceeds_balance": case "PY002": case "exceeds_refundable": case "exceeds_bill": case "confirmed_is_final":
    case "payment_not_refundable": case "not_completed": case "already_settled": case "card_attempt_prepared": case "not_cancellable": case "card_payment_exists":
    case "price_missing": case "review_open": case "not_settled": case "refund_pending": case "over_capacity":
      return "keep";
    default: { const unlisted: never = code; void unlisted; return "keep"; } // a code added to the union without a case is a compile error here
  }
}
/** The ONE decision, used by every path that holds a submission id. Off-union codes (and anything unreadable) keep. */
export function idDisposition(r: { ok: boolean; code: string; checking?: boolean }): "release" | "keep" {
  if (r.checking) return "keep";
  if (typeof r.code !== "string" || !KNOWN.has(r.code)) return "keep";
  return dispositionOfKnown(r.code as KnownCommandCode, r.ok === true);
}

// ---- card charges: the id is bound to the ATTEMPT it produced ----
/** attempt id -> the charge fingerprint whose id produced it */
export type AttemptBindings = Readonly<Record<string, string>>;
export const bindAttempt = (bound: AttemptBindings, attemptId: string, fingerprint: string): AttemptBindings => ({ ...bound, [attemptId]: fingerprint });
const CARD_CHARGE_PREFIX = "charge|card|";
/**
 * A card attempt reached a definite outcome (succeeded, failed or cancelled) by ANY path: release the id bound to it, and every card-charge id that is bound to NO open
 * attempt (a prepare whose answer was lost produced an attempt this screen never saw; reusing its id would hand back that finished attempt and collect nothing).
 */
export function releaseCardAttempt(subs: Submissions, bound: AttemptBindings, attemptId: string): { subs: Submissions; bound: AttemptBindings } {
  const nextBound = { ...bound }; delete nextBound[attemptId];
  const open = new Set(Object.values(nextBound));
  const nextSubs: Record<string, string> = {};
  for (const [fp, id] of Object.entries(subs)) {
    const isCardCharge = fp.startsWith(CARD_CHARGE_PREFIX);
    if (isCardCharge && !open.has(fp)) continue; // released (this attempt's, or bound to no open attempt)
    nextSubs[fp] = id;
  }
  return { subs: nextSubs, bound: nextBound };
}

// ---- refunds: an intent whose answer was lost is bound to its refund ROW ----
export type Awaiting = ReadonlyArray<{ fp: string; refundId: string | null }>;
export const awaitRefund = (awaiting: Awaiting, fp: string, refundId: string | null): Awaiting =>
  awaiting.some((a) => a.fp === fp) ? awaiting.map((a) => (a.fp === fp ? { fp, refundId: refundId ?? a.refundId } : a)) : [...awaiting, { fp, refundId }];
/**
 * ONLY a card refund still being checked (checking AND its row id) waits for the ledger. A plain keep (cash, transfer, external refund, price reduction, an unavailable
 * answer) is never registered: nothing about an unrelated refund changing may release its id.
 */
export const awaitFromAnswer = (awaiting: Awaiting, fp: string, r: { checking?: boolean; refundId?: string | null }): Awaiting =>
  r.checking && r.refundId ? awaitRefund(awaiting, fp, r.refundId) : awaiting;
/** The refund rows now pending at Stripe: every remembered intent whose row is not among them has a definite outcome on the ledger and is released. A row-less intent waits for none pending. */
export function settleFromLedger(subs: Submissions, awaiting: Awaiting, pendingRefundIds: readonly string[]): { subs: Submissions; awaiting: Awaiting } {
  const done = (a: { fp: string; refundId: string | null }) => (a.refundId ? !pendingRefundIds.includes(a.refundId) : pendingRefundIds.length === 0);
  const released = awaiting.filter(done);
  if (released.length === 0) return { subs, awaiting };
  return { subs: released.reduce((m, a) => settleSubmission(m, a.fp), subs), awaiting: awaiting.filter((a) => !done(a)) };
}
/** A recheck answered definitively for this refund row: release exactly that intent's id. */
export function releaseRefund(subs: Submissions, awaiting: Awaiting, refundId: string): { subs: Submissions; awaiting: Awaiting } {
  const mine = awaiting.filter((a) => a.refundId === refundId);
  return { subs: mine.reduce((m, a) => settleSubmission(m, a.fp), subs), awaiting: awaiting.filter((a) => a.refundId !== refundId) };
}

/** The payment chosen for a refund, kept while it is still refundable, else the first refundable one (never a stale id, "" when none). */
export function reconcileRefundSelection(selected: string, options: ReadonlyArray<{ id: string; cents: number }>): string {
  if (options.some((o) => o.id === selected && o.cents > 0)) return selected;
  return options.find((o) => o.cents > 0)?.id ?? "";
}
/** Whether a typed refund can be sent for the selected payment: a positive amount within what that payment still has, with a reason. */
export function refundSendable(selected: { cents: number } | undefined, cents: number | null, reason: string): boolean {
  return !!selected && cents !== null && cents > 0 && cents <= selected.cents && reason.trim() !== "";
}

/** The one rule the screen follows: a new charge may be started only from idle or after a DEFINITE result (a payment that succeeded or failed). Never while preparing, charging or unknown. */
/** The card payment of this visit whose outcome is not yet known (Stripe has not said), if any. Its id is the idempotency key, so checking it again is safe. */
export const unresolvedCardAttempt = (l: VisitLedger): string | null => l.cards.find((c) => c.status === "pending_stripe")?.id ?? null;
export const canStartCharge = (s: CardPhase) => s.phase === "idle" || s.phase === "failed" || s.phase === "succeeded";
export const showCheckingStatus = (s: CardPhase) => s.phase === "unknown";


/** What the dashboard's outstanding view needs of a BILLED visit (HON-123): the live bill, its cash/transfer rows and its refunds. */
export type BilledVisitRows = {
  totalCents: number;
  currency: string;
  externals: ReadonlyArray<{ amountCents: number; state: string }>;
  /** `kind` absent = a payment reversal (a refund read from the attempt's own columns, or a review): it never reopens a balance. */
  refunds: ReadonlyArray<{ amountCents: number; status: string; kind?: string }>;
};

export type BilledOutstanding =
  | { kind: "paid" }
  | { kind: "amount_unavailable" }
  | { kind: "owed"; outstandingCents: number; currency: string; quoteCents: number; cardKeptCents: number; collectedCents: number };

/**
 * Owed on a billed visit = bill total − confirmed cash/transfers − card money received + succeeded PRICE REDUCTIONS (Sam, 27 Nov 2026: a payment reversal does not
 * reopen a balance; the same rule as visit_payment_position, 0394). An unconfirmed transfer is NOT
 * received, so it stays owed (it is only reserved). A card payment still in flight, a refund still pending, or an unknown currency makes the
 * figure unprovable: "Amount unavailable", never a guess. Pure.
 */
export function billedOutstanding(
  bill: BilledVisitRows,
  cards: ReadonlyArray<{ status: string | null; amountCents: number | null; currency: string | null }>,
): BilledOutstanding {
  const cur = bill.currency.toLowerCase();
  if (cur !== "cad" && cur !== "usd") return { kind: "amount_unavailable" };
  let cardKept = 0;
  for (const c of cards) {
    if (c.status === "pending_stripe") return { kind: "amount_unavailable" };
    if (c.status !== "succeeded") continue;
    if (typeof c.amountCents !== "number" || (c.currency !== null && c.currency.toLowerCase() !== cur)) return { kind: "amount_unavailable" };
    cardKept += c.amountCents;
  }
  if (bill.refunds.some((r) => r.status === "pending_stripe")) return { kind: "amount_unavailable" };
  const collected = bill.externals.filter((e) => e.state === "confirmed").reduce((n, e) => n + e.amountCents, 0);
  const handedBack = bill.refunds.filter((r) => r.status === "succeeded" && r.kind === "price_reduction").reduce((n, r) => n + r.amountCents, 0);
  const owed = bill.totalCents - collected - cardKept + handedBack;
  if (owed <= 0) return { kind: "paid" };
  return { kind: "owed", outstandingCents: owed, currency: cur, quoteCents: bill.totalCents, cardKeptCents: cardKept, collectedCents: collected };
}


/**
 * The share of a charge's platform fee returned with one partial card refund (US pilot fee, HON-90): proportional to the amount refunded, rounded
 * down, and the LAST refund returns exactly what is left so the fee returned never exceeds the fee taken and a full refund returns all of it.
 * A charge with no fee (null or 0) returns none (null). $100 charge, $0.50 fee, $40 refund = $0.20.
 */
export function proportionalFeeReturn(args: { feeCents: number | null; chargeCents: number; refundCents: number; alreadyRefundedCents: number; alreadyReturnedCents: number }): number | null {
  const { feeCents, chargeCents, refundCents, alreadyRefundedCents, alreadyReturnedCents } = args;
  if (feeCents === null || feeCents <= 0 || chargeCents <= 0 || refundCents <= 0) return null;
  const left = Math.max(0, feeCents - alreadyReturnedCents);
  if (alreadyRefundedCents + refundCents >= chargeCents) return left;
  return Math.min(left, Math.floor((feeCents * refundCents) / chargeCents));
}

/**
 * Which refund rows belong in a billed visit's ledger. A refund the split flow wrote always does. A LEGACY row is the mirror of a refund made on the attempt itself (the older
 * refund control, or a refund made in Stripe and reported by its webhook): it counts when its attempt belongs to the bill, because visit_payment_position counts it. A legacy
 * row of an attempt that is not on the bill is the old single-payment record and is read as before (not here).
 */
export const keepsRefundForBilledVisit = (r: { legacy: boolean; attemptId: string | null }, billedAttemptIds: ReadonlySet<string>): boolean =>
  !r.legacy || (r.attemptId !== null && billedAttemptIds.has(r.attemptId));
