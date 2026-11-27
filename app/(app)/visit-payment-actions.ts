"use server";

import { revalidatePath } from "next/cache";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { inferStripeLivemode } from "@/lib/stripe/server";
import { callCommand, loadVisitLedger, readRefundRow, splitPaymentsEnabled } from "@/lib/billing/visit-payments";
import {
  commandNote, parseDollarsToCents, visitBalance, type CommandNote, type ExternalMethod, type VisitBalance, type VisitLedger,
} from "@/lib/billing/visit-payments-core";

// Split payments (HON-123) — trusted wrappers. NOTHING HERE IS THE AUTHORITY: the 0394 commands re-derive membership, ownership, the visit,
// the rollout switch and every amount rule under the visit's advisory lock. What lives here is (a) taking the studio and the person from the
// authenticated session (never from the form), (b) strict money parsing, (c) the browser's submission id, and (d) closed codes to plain copy.
// Checkout money is OWNER-ONLY (HON-44), so these refuse a non-owner before any read.

export type SplitState = { ledger: VisitLedger; balance: VisitBalance | null };
export type SplitActionResult = { ok: boolean; code: string; note: CommandNote; state: SplitState | null; id?: string | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const METHODS: readonly ExternalMethod[] = ["paid_cash", "paid_e_transfer", "paid_other_external"];
const str = (v: FormDataEntryValue | null) => (typeof v === "string" ? v.trim() : "");

async function owner() {
  try {
    const { practitioner, studio } = await getCurrentPractitionerWithStudio();
    if (practitioner.role !== "owner") return null;
    return { studioId: studio.id };
  } catch {
    return null;
  }
}

async function finish(studioId: string, appointmentId: string, code: string, id: string | null = null): Promise<SplitActionResult> {
  const load = await loadVisitLedger(studioId, appointmentId);
  const state = load.ok ? { ledger: load.ledger, balance: visitBalance(load.ledger) } : null;
  const note = commandNote(code, { collectableCents: state?.balance?.collectableCents, currency: state?.ledger.bill?.currency ?? null });
  revalidatePath("/dashboard");
  return { ok: note.tone !== "blocked", code, note, state, id };
}

const refuse = (code: string): SplitActionResult => ({ ok: false, code, note: commandNote(code), state: null });

/** Read the visit's split state (and whether the studio is switched on). Null state = not switched on or not readable. */
export async function getSplitStateAction(appointmentId: string): Promise<{ enabled: boolean; state: SplitState | null }> {
  const who = await owner();
  if (!who || !UUID.test(appointmentId)) return { enabled: false, state: null };
  if (!(await splitPaymentsEnabled(who.studioId))) return { enabled: false, state: null };
  const load = await loadVisitLedger(who.studioId, appointmentId);
  return { enabled: true, state: load.ok ? { ledger: load.ledger, balance: visitBalance(load.ledger) } : null };
}

/** Start splitting: creates the visit's one bill from its quote (idempotent). A changed total needs a reason and keeps the booked fee as evidence. */
export async function startSplitBillAction(formData: FormData): Promise<SplitActionResult> {
  const who = await owner();
  if (!who) return refuse("not_owner");
  const appointmentId = str(formData.get("appointment_id"));
  if (!UUID.test(appointmentId)) return refuse("invalid_input");
  const finalRaw = str(formData.get("final_amount_dollars"));
  let finalCents: number | null = null;
  if (finalRaw !== "") {
    finalCents = finalRaw === "0" || finalRaw === "0.00" ? 0 : parseDollarsToCents(finalRaw);
    if (finalCents === null) return refuse("invalid_input");
  }
  const row = await callCommand("ensure_visit_bill", {
    p_studio_id: who.studioId, p_appointment_id: appointmentId, p_final_cents: finalCents,
    p_fee_adjustment_reason: str(formData.get("adjustment_reason")) || null, p_livemode: inferStripeLivemode(),
  });
  return finish(who.studioId, appointmentId, row.result, row.id);
}

/** Record cash (counted at once) or a transfer (reserved until confirmed). The browser's submission id makes a double click one row. */
export async function recordExternalPaymentAction(formData: FormData): Promise<SplitActionResult> {
  const who = await owner();
  if (!who) return refuse("not_owner");
  const appointmentId = str(formData.get("appointment_id"));
  const method = str(formData.get("method")) as ExternalMethod;
  const submissionId = str(formData.get("submission_id"));
  const cents = parseDollarsToCents(str(formData.get("amount_dollars")));
  if (!UUID.test(appointmentId) || !UUID.test(submissionId) || !METHODS.includes(method) || cents === null) return refuse("invalid_input");
  const row = await callCommand("record_visit_external_payment", {
    p_studio_id: who.studioId, p_appointment_id: appointmentId, p_method: method, p_amount_cents: cents,
    p_submission_id: submissionId, p_note: str(formData.get("note")) || null,
  });
  return finish(who.studioId, appointmentId, row.result, row.id);
}

export async function confirmTransferAction(formData: FormData): Promise<SplitActionResult> {
  const who = await owner();
  if (!who) return refuse("not_owner");
  const appointmentId = str(formData.get("appointment_id"));
  const paymentId = str(formData.get("payment_id"));
  if (!UUID.test(appointmentId) || !UUID.test(paymentId)) return refuse("invalid_input");
  const row = await callCommand("confirm_visit_external_payment", { p_studio_id: who.studioId, p_payment_id: paymentId });
  return finish(who.studioId, appointmentId, row.result, row.id);
}

/** Cancel a card payment that was prepared but never sent to Stripe (it holds its amount against the balance). Refused once it has been sent. */
export async function cancelSplitCardAttemptAction(formData: FormData): Promise<SplitActionResult> {
  const who = await owner();
  if (!who) return refuse("not_owner");
  const appointmentId = str(formData.get("appointment_id"));
  const attemptId = str(formData.get("attempt_id"));
  if (!UUID.test(appointmentId) || !UUID.test(attemptId)) return refuse("invalid_input");
  const row = await callCommand("cancel_split_card_attempt", { p_studio_id: who.studioId, p_attempt_id: attemptId, p_reason: null });
  return finish(who.studioId, appointmentId, row.result, row.id);
}

export async function voidTransferAction(formData: FormData): Promise<SplitActionResult> {
  const who = await owner();
  if (!who) return refuse("not_owner");
  const appointmentId = str(formData.get("appointment_id"));
  const paymentId = str(formData.get("payment_id"));
  const reason = str(formData.get("reason"));
  if (!UUID.test(appointmentId) || !UUID.test(paymentId) || reason === "" || reason.length > 500) return refuse("invalid_input");
  const row = await callCommand("void_visit_external_payment", { p_studio_id: who.studioId, p_payment_id: paymentId, p_reason: reason });
  return finish(who.studioId, appointmentId, row.result, row.id);
}

/**
 * Refund (or reduce the price) against ONE selected CASH/TRANSFER payment: recorded at once, nothing goes to Stripe.
 * A card payment's refund is a Stripe call and is a separate action (card refunds).
 * kind: price_reduction lowers the bill (the balance is unchanged); payment_reversal leaves the bill (the balance due rises).
 */
export async function refundExternalPaymentAction(formData: FormData): Promise<SplitActionResult> {
  const who = await owner();
  if (!who) return refuse("not_owner");
  const appointmentId = str(formData.get("appointment_id"));
  const paymentId = str(formData.get("payment_id"));
  const kind = str(formData.get("kind"));
  const submissionId = str(formData.get("submission_id"));
  const cents = parseDollarsToCents(str(formData.get("amount_dollars")));
  const reason = str(formData.get("reason"));
  if (!UUID.test(appointmentId) || !UUID.test(paymentId) || !UUID.test(submissionId) || cents === null || reason === "" || reason.length > 500
      || (kind !== "price_reduction" && kind !== "payment_reversal")) return refuse("invalid_input");
  const row = await callCommand("request_payment_refund", {
    p_studio_id: who.studioId, p_appointment_id: appointmentId, p_attempt_id: null, p_external_payment_id: paymentId,
    p_amount_cents: cents, p_kind: kind, p_reason: reason, p_submission_id: submissionId,
  });
  return finish(who.studioId, appointmentId, row.result, row.id);
}

// ---------------------------------------------------------------------------
// Card payments on a split visit
// ---------------------------------------------------------------------------
import { createAdminClient } from "@/lib/supabase/admin-server";
import { getSessionPaymentEligibility } from "@/lib/billing/session-payment-eligibility";
import { parsePaymentCurrency } from "@/lib/billing/payment-jurisdiction";
import { executeSessionPaymentChargeAction } from "@/app/(app)/clients/[id]/sessions/[sessionId]/payment-actions";

export type SplitCardPrepareResult =
  | { ok: true; attemptId: string; currency: "cad" | "usd"; amountCents: number }
  | { ok: false; code: string; note: CommandNote; state: SplitState | null };

const CURRENCY_CHANGED = "The currency shown no longer matches the studio's verified currency. Reload the page, check the amount, and try again.";

async function splitFail(studioId: string, appointmentId: string, code: string, message?: string): Promise<SplitCardPrepareResult> {
  const f = await finish(studioId, appointmentId, code);
  return { ok: false, code, note: message ? { tone: "blocked", message } : f.note, state: f.state };
}

/**
 * Prepare ONE card payment of a chosen amount on a split visit. The amount is capped by the DATABASE under the visit's lock when the attempt
 * row is made (0394's card wall): money reserved for a pending transfer, or more than is collectable, is refused HERE, before any Stripe call
 * and with no attempt row left behind. A repeated submit (same submission id) returns the first attempt.
 */
export async function prepareSplitCardPaymentAction(formData: FormData): Promise<SplitCardPrepareResult> {
  const who = await owner();
  if (!who) return { ok: false, code: "not_owner", note: commandNote("not_owner"), state: null };
  const { practitioner } = await getCurrentPractitionerWithStudio();
  const appointmentId = str(formData.get("appointment_id"));
  const submissionId = str(formData.get("submission_id"));
  const cents = parseDollarsToCents(str(formData.get("amount_dollars")));
  if (!UUID.test(appointmentId) || !UUID.test(submissionId) || cents === null) return splitFail(who.studioId, appointmentId, "invalid_input");
  if (!(await splitPaymentsEnabled(who.studioId))) return splitFail(who.studioId, appointmentId, "split_payments_off");

  const load = await loadVisitLedger(who.studioId, appointmentId);
  if (!load.ok) return splitFail(who.studioId, appointmentId, "unavailable");
  if (!load.ledger.bill) return splitFail(who.studioId, appointmentId, "no_bill");

  const admin = createAdminClient();
  // A repeated prepare (double click, retry) is the same payment: return the first attempt, make nothing.
  const prior = await admin.from("payment_charge_attempts").select("id, amount_cents, currency, appointment_id, status")
    .eq("studio_id", who.studioId).eq("submission_id", submissionId).maybeSingle();
  if (prior.data) {
    const c = parsePaymentCurrency(prior.data.currency);
    // The same submission id means the same visit, amount and a live attempt. A different visit, or an attempt that was cancelled or failed, is a reused id.
    if (c && prior.data.amount_cents === cents && prior.data.appointment_id === appointmentId && ["ready", "pending_stripe", "succeeded"].includes(String(prior.data.status))) return { ok: true, attemptId: prior.data.id as string, currency: c, amountCents: cents };
    return splitFail(who.studioId, appointmentId, "submission_reused");
  }

  const sess = await admin.from("sessions").select("id").eq("studio_id", who.studioId).eq("appointment_id", appointmentId).limit(1).maybeSingle();
  if (sess.error || !sess.data) {
    return splitFail(who.studioId, appointmentId, "no_session", "Card payment needs a chart entry for this visit. Add one first, or record the payment as cash or a transfer.");
  }
  const sessionId = sess.data.id as string;
  const eligibility = await getSessionPaymentEligibility({ studioId: who.studioId, sessionId, allowActiveAttempt: true });
  if (!eligibility.eligible) {
    return splitFail(who.studioId, appointmentId, "not_eligible", eligibility.blockingReasons[0] ?? "This visit cannot take a card payment right now.");
  }
  if (parsePaymentCurrency(str(formData.get("expected_currency"))) !== eligibility.jurisdiction.currency) {
    return splitFail(who.studioId, appointmentId, "currency_changed", CURRENCY_CHANGED);
  }

  const { data: inserted, error } = await admin.from("payment_charge_attempts").insert({
    studio_id: who.studioId, charge_reason: "session_payment", client_id: eligibility.client.id, appointment_id: appointmentId, session_id: sessionId,
    created_by_practitioner_id: practitioner.id, amount_cents: cents, currency: eligibility.jurisdiction.currency, status: "ready",
    client_payment_method_id: eligibility.card.id, card_authorization_signature_id: eligibility.cardAuthorization.signatureId,
    stripe_account_id: eligibility.stripeAccountId, stripe_customer_id: eligibility.stripeCustomerId, stripe_payment_method_id: eligibility.stripePaymentMethodId,
    stripe_livemode: inferStripeLivemode(), submission_id: submissionId,
  }).select("id").single();
  if (error) {
    // The card wall's closed codes (0394): PY001 reserved for a pending transfer, PY002 more than is collectable. Nothing was written.
    if (error.code === "PY001" || error.code === "PY002") return splitFail(who.studioId, appointmentId, error.code);
    if (error.code === "23505") {
      const again = await admin.from("payment_charge_attempts").select("id, amount_cents, currency, appointment_id, status").eq("studio_id", who.studioId).eq("submission_id", submissionId).maybeSingle();
      const c = again.data ? parsePaymentCurrency(again.data.currency) : null;
      if (again.data && c && again.data.amount_cents === cents && again.data.appointment_id === appointmentId && ["ready", "pending_stripe", "succeeded"].includes(String(again.data.status))) return { ok: true, attemptId: again.data.id as string, currency: c, amountCents: cents };
    }
    return splitFail(who.studioId, appointmentId, "unavailable");
  }
  revalidatePath("/dashboard");
  return { ok: true, attemptId: inserted.id as string, currency: eligibility.jurisdiction.currency, amountCents: cents };
}

export type SplitCardStatus =
  | { outcome: "succeeded"; state: SplitState | null }
  | { outcome: "failed"; message: string; state: SplitState | null }
  | { outcome: "unknown"; state: SplitState | null };

/**
 * Run (or re-check) ONE prepared card payment. Calling it again for the same attempt is safe: the attempt id is the Stripe idempotency key, so a
 * connection that dropped after Stripe accepted the charge is answered with the same charge, never a second one. A result that is not definite is
 * `unknown` and the screen shows "Checking payment status" with no charge control.
 */
export async function runSplitCardPaymentAction(formData: FormData): Promise<SplitCardStatus> {
  const who = await owner();
  const appointmentId = str(formData.get("appointment_id"));
  const attemptId = str(formData.get("attempt_id"));
  if (!who || !UUID.test(appointmentId) || !UUID.test(attemptId)) return { outcome: "unknown", state: null };
  // Only this studio's attempt on this visit.
  const row = await createAdminClient().from("payment_charge_attempts").select("id, status, currency")
    .eq("id", attemptId).eq("studio_id", who.studioId).eq("appointment_id", appointmentId).not("visit_bill_id", "is", null).maybeSingle();
  const after = async () => {
    const l = await loadVisitLedger(who.studioId, appointmentId);
    return l.ok ? { ledger: l.ledger, balance: visitBalance(l.ledger) } : null;
  };
  if (row.error || !row.data) return { outcome: "unknown", state: await after() };
  if (row.data.status === "succeeded") return { outcome: "succeeded", state: await after() };
  if (row.data.status === "failed") return { outcome: "failed", message: "The card was not charged.", state: await after() };

  const f = new FormData();
  f.set("attempt_id", attemptId);
  f.set("confirm_charge", "true");
  f.set("expected_currency", String(row.data.currency));
  const result = await executeSessionPaymentChargeAction(f);
  revalidatePath("/dashboard");
  if (result.ok) return { outcome: "succeeded", state: await after() };
  if (result.outcome === "failed" || result.outcome === "blocked" || result.outcome === "authorization_not_current" || result.outcome === "lineage_mismatch"
      || result.outcome === "live_mode_blocked") {
    return { outcome: "failed", message: result.error, state: await after() };
  }
  // needs_manual_review, not_found, not_authorized: not a definite answer about the money.
  return { outcome: "unknown", state: await after() };
}

// ---------------------------------------------------------------------------
// Partial refund of a CARD payment
// ---------------------------------------------------------------------------
import { refundCardPaymentPartial } from "@/lib/billing/payment-partial-refund";

export type CardRefundResult = SplitActionResult & { checking?: boolean; refundId?: string | null };

/**
 * Refund (or reduce the price by) part of ONE card payment. request_payment_refund (owner-only, under the visit's lock) caps the amount at what is
 * still refundable and records a pending_stripe row; only then is Stripe asked, once, with the row id as the idempotency key. If the answer is lost
 * the row stays pending and `checking: true` tells the screen to say "Checking refund status" and offer only a re-check, never a second refund.
 * Calling again with the SAME submission id and the existing refund id re-checks without creating anything.
 */
export async function refundCardPaymentAction(formData: FormData): Promise<CardRefundResult> {
  const who = await owner();
  if (!who) return refuse("not_owner");
  const appointmentId = str(formData.get("appointment_id"));
  const attemptId = str(formData.get("attempt_id"));
  const kind = str(formData.get("kind"));
  const submissionId = str(formData.get("submission_id"));
  const cents = parseDollarsToCents(str(formData.get("amount_dollars")));
  const reason = str(formData.get("reason"));
  if (!UUID.test(appointmentId) || !UUID.test(attemptId) || !UUID.test(submissionId) || cents === null || reason === "" || reason.length > 500
      || (kind !== "price_reduction" && kind !== "payment_reversal")) return refuse("invalid_input");
  const row = await callCommand("request_payment_refund", {
    p_studio_id: who.studioId, p_appointment_id: appointmentId, p_attempt_id: attemptId, p_external_payment_id: null,
    p_amount_cents: cents, p_kind: kind, p_reason: reason, p_submission_id: submissionId,
  });
  if ((row.result !== "requested" && row.result !== "already_requested") || !row.id) return finish(who.studioId, appointmentId, row.result, row.id);

  // The ledger row decides whether Stripe still needs asking: a repeated request returns the first row, and a settled row is not sent again.
  const pending = await readRefundRow(who.studioId, row.id);
  if (!pending) return { ...(await finish(who.studioId, appointmentId, "unavailable", row.id)), ok: false, refundId: row.id, checking: true, note: { tone: "info", message: "Checking refund status" } };
  const sent = await refundCardPaymentPartial({ row: pending, feeReturnedCents: null });
  const out = await finish(who.studioId, appointmentId, sent.outcome === "failed" ? "refund_failed" : row.result, row.id);
  if (sent.outcome === "unknown") return { ...out, ok: true, checking: true, refundId: row.id, note: { tone: "info", message: "Checking refund status" } };
  if (sent.outcome === "failed" || sent.outcome === "blocked") return { ...out, ok: false, refundId: row.id, note: { tone: "blocked", message: sent.message } };
  return { ...out, refundId: row.id, note: { tone: "ok", message: sent.message } };
}

/**
 * Durable recheck of a pending card refund (HON-122). The pending row is persisted by request_payment_refund before Stripe is asked, so a reload, a lost response or
 * a second device can ask again: the refund row id is the Stripe idempotency key (and, past about 23 hours, the existing Stripe refund is looked up first), so
 * checking can never refund twice. Only a pending card refund of THIS visit in THIS studio is sent.
 */
export async function recheckCardRefundAction(formData: FormData): Promise<CardRefundResult> {
  const who = await owner();
  if (!who) return refuse("not_owner");
  const appointmentId = str(formData.get("appointment_id"));
  const refundId = str(formData.get("refund_id"));
  if (!UUID.test(appointmentId) || !UUID.test(refundId)) return refuse("invalid_input");
  const loaded = await loadVisitLedger(who.studioId, appointmentId);
  const mine = loaded.ok ? loaded.ledger.refunds.find((r) => r.id === refundId) : null;
  if (!mine || !mine.attemptId) return refuse("not_found");
  if (mine.status !== "pending_stripe") return { ...(await finish(who.studioId, appointmentId, "already_requested", refundId)), refundId };
  const pending = await readRefundRow(who.studioId, refundId);
  if (!pending) return { ...(await finish(who.studioId, appointmentId, "unavailable", refundId)), ok: false, refundId, checking: true, note: { tone: "info", message: "Checking refund status" } };
  const sent = await refundCardPaymentPartial({ row: pending, feeReturnedCents: null });
  const out = await finish(who.studioId, appointmentId, sent.outcome === "failed" ? "refund_failed" : "requested", refundId);
  if (sent.outcome === "unknown") return { ...out, ok: true, checking: true, refundId, note: { tone: "info", message: "Checking refund status" } };
  if (sent.outcome === "failed" || sent.outcome === "blocked") return { ...out, ok: false, refundId, note: { tone: "blocked", message: sent.message } };
  return { ...out, refundId, note: { tone: "ok", message: sent.message } };
}

// ---------------------------------------------------------------------------
// Receipt for ONE card payment of a split visit
// ---------------------------------------------------------------------------
import { sendPaymentChargeReceiptAction } from "@/app/(app)/clients/[id]/sessions/[sessionId]/payment-actions";

/**
 * Sends the receipt for one succeeded card payment. The existing receipt sender claims the attempt row once, so a double click or a retry sends ONE
 * email; this wrapper only checks the attempt belongs to this studio's billed visit and maps the answer to plain copy.
 */
export async function sendSplitCardReceiptAction(formData: FormData): Promise<SplitActionResult> {
  const who = await owner();
  if (!who) return refuse("not_owner");
  const appointmentId = str(formData.get("appointment_id"));
  const attemptId = str(formData.get("attempt_id"));
  if (!UUID.test(appointmentId) || !UUID.test(attemptId)) return refuse("invalid_input");
  const own = await createAdminClient().from("payment_charge_attempts").select("id")
    .eq("id", attemptId).eq("studio_id", who.studioId).eq("appointment_id", appointmentId).not("visit_bill_id", "is", null).maybeSingle();
  if (own.error || !own.data) return refuse("not_found");
  const f = new FormData();
  f.set("attempt_id", attemptId);
  const r = await sendPaymentChargeReceiptAction(f);
  const state = await finish(who.studioId, appointmentId, r.ok || r.outcome === "already_sent" ? "receipt_sent" : "receipt_failed");
  const message = r.ok ? `Receipt sent to ${r.emailTo}.` : r.outcome === "already_sent" ? "This receipt was already sent." : r.error;
  return { ...state, ok: r.ok || r.outcome === "already_sent", note: { tone: r.ok || r.outcome === "already_sent" ? "ok" : "blocked", message } };
}
