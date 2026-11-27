import "server-only";
import { inferStripeLivemode } from "@/lib/stripe/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { aggregateRefundGaps, keepsRefundForBilledVisit } from "@/lib/billing/visit-payments-core";
import type {
  ExternalMethod, LedgerBill, LedgerCard, LedgerExternal, LedgerRefund, LedgerReview, VisitCurrency, VisitLedger,
} from "@/lib/billing/visit-payments-core";

// ===========================================================================
// Split payments and partial refunds — the READ side and the command wrappers (HON-123 / HON-122).
// ===========================================================================
// Nothing here is an authority. The 0394 commands decide every money question under the visit's advisory lock; this module reads the ledger
// (0393) for the screens and calls those commands as the signed-in person. The studio switch is the platform rollout `split_payments`
// (default OFF): a studio that is not switched on sees the old checkout and nothing else changes.

export const SPLIT_PAYMENTS_KEY = "split_payments";

/** Is the studio switched on? Read with the service role (the rollout read is not granted to members). A failed read is OFF. */
export async function splitPaymentsEnabled(studioId: string): Promise<boolean> {
  try {
    const { data, error } = await createAdminClient().rpc("platform_rollout_enabled_for", { p_key: SPLIT_PAYMENTS_KEY, p_studio: studioId });
    return !error && data === true;
  } catch {
    return false;
  }
}

/** Does this visit have a LIVE split-payments bill? A read that fails answers true: withdrawing the old single-outcome controls is the safe direction. */
export async function visitIsBilled(studioId: string, appointmentId: string): Promise<boolean> {
  try {
    const r = await (await createClient()).from("visit_bills").select("id").eq("studio_id", studioId).eq("appointment_id", appointmentId).is("superseded_at", null).limit(1);
    return !!r.error || (r.data?.length ?? 0) > 0;
  } catch {
    return true;
  }
}

const ccy = (v: unknown): VisitCurrency | null => (v === "cad" || v === "usd" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export type LedgerLoad = { ok: true; ledger: VisitLedger } | { ok: false };

/** The visit's bill, payments and refunds. A read that fails is `ok:false`, never an empty ledger (unknown is not "nothing paid"). */
export async function loadVisitLedger(studioId: string, appointmentId: string): Promise<LedgerLoad> {
  try {
    const supabase = await createClient();
    const [bills, externals, refunds, cards, position, openReviews, liveProbe] = await Promise.all([
      supabase.from("visit_bills").select("id, total_cents, currency, reference_fee_cents, fee_adjustment_reason, created_at")
        .eq("studio_id", studioId).eq("appointment_id", appointmentId).is("superseded_at", null).maybeSingle(),
      supabase.from("visit_external_payments").select("id, method, amount_cents, state, recorded_at, note")
        .eq("studio_id", studioId).eq("appointment_id", appointmentId).order("recorded_at"),
      supabase.from("payment_refunds").select("id, amount_cents, kind, status, attempt_id, external_payment_id, requested_at, platform_fee_returned_cents, legacy, source")
        .eq("studio_id", studioId).eq("appointment_id", appointmentId).order("requested_at"),
      createAdminClient().from("payment_charge_attempts").select("id, amount_cents, status, created_at, receipt_sent_at, refund_status, refund_amount_cents, stripe_livemode")
        .eq("studio_id", studioId).eq("appointment_id", appointmentId).eq("charge_reason", "session_payment").not("visit_bill_id", "is", null).order("created_at"),
      // The database's own answer (payment_refund_money, 0393): the money returned and whether a review is open. The rows above must AGREE with it.
      supabase.rpc("get_visit_payment_position", { p_studio_id: studioId, p_appointment_id: appointmentId }),
      // Open reviews: closed fields only (amount and whether Stripe has settled it). The owner reads them under RLS.
      supabase.from("payment_refund_reviews").select("id, amount_cents, stripe_refund_status")
        .eq("studio_id", studioId).eq("appointment_id", appointmentId).is("resolved_at", null).order("opened_at"),
      // studio_has_gone_live (0394): a succeeded LIVE card attempt exists for the studio. From then on, non-live card payments no longer count toward capacity.
      createAdminClient().from("payment_charge_attempts").select("id").eq("studio_id", studioId).eq("stripe_livemode", true).eq("status", "succeeded").limit(1),
    ]);
    if (bills.error || externals.error || refunds.error || cards.error || position.error || openReviews.error) return { ok: false };

    let bill: LedgerBill | null = null;
    if (bills.data) {
      const b = bills.data as Record<string, unknown>;
      const c = ccy(b.currency);
      if (typeof b.id !== "string" || num(b.total_cents) === null || !c) return { ok: false };
      bill = {
        id: b.id, totalCents: b.total_cents as number, currency: c, createdAt: String(b.created_at),
        referenceFeeCents: num(b.reference_fee_cents), feeAdjustmentReason: typeof b.fee_adjustment_reason === "string" ? b.fee_adjustment_reason : null,
      };
    }
    const ext: LedgerExternal[] = [];
    for (const r of (externals.data ?? []) as Record<string, unknown>[]) {
      if (typeof r.id !== "string" || num(r.amount_cents) === null) return { ok: false };
      ext.push({
        kind: "external", id: r.id, method: r.method as ExternalMethod, amountCents: r.amount_cents as number,
        state: r.state as LedgerExternal["state"], at: String(r.recorded_at), note: typeof r.note === "string" ? r.note : null,
      });
    }
    // The statement's own signal: only stripe_livemode === true is live; false, NULL or anything else is test and is excluded from statements and analytics.
    const testAttempts = new Set<string>(((cards.data ?? []) as Record<string, unknown>[]).flatMap((c) => (typeof c.id === "string" && c.stripe_livemode !== true ? [c.id] : [])));
    const billedAttempts = new Set<string>(((cards.data ?? []) as Record<string, unknown>[]).flatMap((c) => (typeof c.id === "string" ? [c.id] : [])));
    const refs: LedgerRefund[] = [];
    for (const r of (refunds.data ?? []) as Record<string, unknown>[]) {
      if (typeof r.id !== "string" || num(r.amount_cents) === null) return { ok: false };
      if (!keepsRefundForBilledVisit({ legacy: r.legacy === true, attemptId: typeof r.attempt_id === "string" ? r.attempt_id : null }, billedAttempts)) continue;
      refs.push({
        id: r.id, amountCents: r.amount_cents as number, kind: r.kind as LedgerRefund["kind"], status: r.status as LedgerRefund["status"],
        attemptId: typeof r.attempt_id === "string" ? r.attempt_id : null, externalPaymentId: typeof r.external_payment_id === "string" ? r.external_payment_id : null,
        reason: "", observed: r.source === "stripe_dashboard", at: String(r.requested_at), platformFeeReturnedCents: num(r.platform_fee_returned_cents),
        ...(typeof r.attempt_id === "string" && testAttempts.has(r.attempt_id) ? { test: true } : {}),
      });
    }
    // Money the attempt's own columns say came back (a dashboard refund of the rest) that no row carries: a row of its own, so every reader sees it.
    for (const c of (cards.data ?? []) as Record<string, unknown>[]) {
      if (typeof c.id !== "string" || c.status !== "succeeded" || num(c.amount_cents) === null) continue;
      const mine = refs.filter((r) => r.attemptId === c.id);
      const gap = aggregateRefundGaps(
        { id: c.id, amountCents: c.amount_cents as number, refundStatus: typeof c.refund_status === "string" ? c.refund_status : null, refundAmountCents: num(c.refund_amount_cents) },
        mine.filter((r) => r.status === "succeeded").reduce((a, r) => a + r.amountCents, 0), mine.filter((r) => r.status === "pending_stripe").reduce((a, r) => a + r.amountCents, 0),
      );
      const at = String(c.created_at);
      if (gap.succeededGapCents > 0) refs.push({ id: `${c.id}:stripe-total`, amountCents: gap.succeededGapCents, kind: "payment_reversal", status: "succeeded", attemptId: c.id, externalPaymentId: null, reason: "", observed: true, ...(testAttempts.has(c.id) ? { test: true } : {}), at, platformFeeReturnedCents: null });
      if (gap.pendingGapCents > 0) refs.push({ id: `${c.id}:stripe-pending`, amountCents: gap.pendingGapCents, kind: "payment_reversal", status: "pending_stripe", attemptId: c.id, externalPaymentId: null, reason: "", ...(testAttempts.has(c.id) ? { test: true } : {}), at, platformFeeReturnedCents: null });
    }
    const pos = (Array.isArray(position.data) ? position.data[0] : position.data) as Record<string, unknown> | null | undefined;
    if (bill) {
      // Fail closed: if the screen's money does not equal the database's, the ledger is UNKNOWN (never a wrong "paid" or "refundable").
      const returned = refs.filter((r) => r.status === "succeeded").reduce((a, r) => a + r.amountCents, 0);
      if (!pos || num(pos.refunded_cents) !== returned) return { ok: false };
    }
    const reviews: LedgerReview[] = [];
    for (const r of (openReviews.data ?? []) as Record<string, unknown>[]) {
      if (typeof r.id !== "string" || num(r.amount_cents) === null) return { ok: false };
      reviews.push({ id: r.id, amountCents: r.amount_cents as number, settled: r.stripe_refund_status === "succeeded" });
    }
    const cds: LedgerCard[] = [];
    for (const r of (cards.data ?? []) as Record<string, unknown>[]) {
      if (typeof r.id !== "string" || num(r.amount_cents) === null) return { ok: false };
      cds.push({ kind: "card", id: r.id, amountCents: r.amount_cents as number, status: String(r.status), at: String(r.created_at), platformFeeCents: null, receiptSent: typeof r.receipt_sent_at === "string", ...(r.stripe_livemode !== true ? { test: true } : {}) });
    }
    if (liveProbe.error) return { ok: false };
    return { ok: true, ledger: { // A live deployment is about to take live cards: the card wall (0394) treats the studio as gone live for a live row being inserted, so the page must not block first (inferStripeLivemode is deployment config, never a caller input).
      studioLive: (liveProbe.data?.length ?? 0) > 0 || inferStripeLivemode(), bill, cards: cds, externals: ext, refunds: refs, reviewOpen: pos?.review_open === true, reviews } };
  } catch {
    return { ok: false };
  }
}

export type CommandRow = { result: string; id: string | null; state: string | null };

export type CommandName = "ensure_visit_bill" | "record_visit_external_payment" | "confirm_visit_external_payment" | "void_visit_external_payment" | "request_payment_refund" | "cancel_split_card_attempt" | "resolve_payment_refund_review";

/** One staff command as the signed-in person. A transport or permission failure is `result: "unavailable"`; the database's own refusals come back as their code. */
export async function callCommand(fn: CommandName, args: Record<string, unknown>): Promise<CommandRow> {
  try {
    const supabase = await createClient();
    // Every command is named here as a literal so the permission census sees each one.
    const { data, error } =
      fn === "ensure_visit_bill" ? await supabase.rpc("ensure_visit_bill", args)
      : fn === "record_visit_external_payment" ? await supabase.rpc("record_visit_external_payment", args)
      : fn === "confirm_visit_external_payment" ? await supabase.rpc("confirm_visit_external_payment", args)
      : fn === "void_visit_external_payment" ? await supabase.rpc("void_visit_external_payment", args)
      : fn === "cancel_split_card_attempt" ? await supabase.rpc("cancel_split_card_attempt", args)
      : fn === "resolve_payment_refund_review" ? await supabase.rpc("resolve_payment_refund_review", args)
      : await supabase.rpc("request_payment_refund", args);
    if (error) return { result: "unavailable", id: null, state: null };
    const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
    if (!row || typeof row.result !== "string") return { result: "unavailable", id: null, state: null };
    const id = [row.payment_id, row.refund_id, row.attempt_id, row.bill_id].find((v) => typeof v === "string") as string | undefined;
    return { result: row.result, id: id ?? null, state: typeof row.state === "string" ? row.state : typeof row.status === "string" ? row.status : null };
  } catch {
    return { result: "unavailable", id: null, state: null };
  }
}

/** One refund row as the signed-in owner (the table is owner-readable under RLS; no service-role grant). null = not readable here. */
export async function readRefundRow(studioId: string, refundId: string): Promise<import("@/lib/billing/payment-partial-refund").PendingRefundRow | null> {
  try {
    const { data, error } = await (await createClient()).from("payment_refunds")
      .select("id, studio_id, attempt_id, amount_cents, status, source, requested_at, stripe_refund_id").eq("id", refundId).eq("studio_id", studioId).maybeSingle();
    if (error || !data || typeof data.attempt_id !== "string") return null;
    return { id: data.id as string, studioId: data.studio_id as string, attemptId: data.attempt_id, amountCents: data.amount_cents as number, status: String(data.status), requestedAt: String(data.requested_at ?? ""), source: String(data.source), stripeRefundId: typeof data.stripe_refund_id === "string" ? data.stripe_refund_id : null };
  } catch {
    return null;
  }
}
