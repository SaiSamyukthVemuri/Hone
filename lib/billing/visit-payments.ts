import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import type {
  ExternalMethod, LedgerBill, LedgerCard, LedgerExternal, LedgerRefund, VisitCurrency, VisitLedger,
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

const ccy = (v: unknown): VisitCurrency | null => (v === "cad" || v === "usd" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export type LedgerLoad = { ok: true; ledger: VisitLedger } | { ok: false };

/** The visit's bill, payments and refunds. A read that fails is `ok:false`, never an empty ledger (unknown is not "nothing paid"). */
export async function loadVisitLedger(studioId: string, appointmentId: string): Promise<LedgerLoad> {
  try {
    const supabase = await createClient();
    const [bills, externals, refunds, cards] = await Promise.all([
      supabase.from("visit_bills").select("id, total_cents, currency, reference_fee_cents, fee_adjustment_reason, created_at")
        .eq("studio_id", studioId).eq("appointment_id", appointmentId).is("superseded_at", null).maybeSingle(),
      supabase.from("visit_external_payments").select("id, method, amount_cents, state, recorded_at, note")
        .eq("studio_id", studioId).eq("appointment_id", appointmentId).order("recorded_at"),
      supabase.from("payment_refunds").select("id, amount_cents, kind, status, attempt_id, external_payment_id, reason, requested_at, platform_fee_returned_cents")
        .eq("studio_id", studioId).eq("appointment_id", appointmentId).eq("legacy", false).order("requested_at"),
      createAdminClient().from("payment_charge_attempts").select("id, amount_cents, status, created_at, receipt_sent_at")
        .eq("studio_id", studioId).eq("appointment_id", appointmentId).eq("charge_reason", "session_payment").not("visit_bill_id", "is", null).order("created_at"),
    ]);
    if (bills.error || externals.error || refunds.error || cards.error) return { ok: false };

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
    const refs: LedgerRefund[] = [];
    for (const r of (refunds.data ?? []) as Record<string, unknown>[]) {
      if (typeof r.id !== "string" || num(r.amount_cents) === null) return { ok: false };
      refs.push({
        id: r.id, amountCents: r.amount_cents as number, kind: r.kind as LedgerRefund["kind"], status: r.status as LedgerRefund["status"],
        attemptId: typeof r.attempt_id === "string" ? r.attempt_id : null, externalPaymentId: typeof r.external_payment_id === "string" ? r.external_payment_id : null,
        reason: String(r.reason ?? ""), at: String(r.requested_at), platformFeeReturnedCents: num(r.platform_fee_returned_cents),
      });
    }
    const cds: LedgerCard[] = [];
    for (const r of (cards.data ?? []) as Record<string, unknown>[]) {
      if (typeof r.id !== "string" || num(r.amount_cents) === null) return { ok: false };
      cds.push({ kind: "card", id: r.id, amountCents: r.amount_cents as number, status: String(r.status), at: String(r.created_at), platformFeeCents: null, receiptSent: typeof r.receipt_sent_at === "string" });
    }
    return { ok: true, ledger: { bill, cards: cds, externals: ext, refunds: refs } };
  } catch {
    return { ok: false };
  }
}

export type CommandRow = { result: string; id: string | null; state: string | null };

/** One staff command as the signed-in person. A transport or permission failure is `result: "unavailable"`; the database's own refusals come back as their code. */
export async function callCommand(fn: string, args: Record<string, unknown>): Promise<CommandRow> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc(fn, args);
    if (error) {
      // The card wall and the 0394 commands refuse with closed codes; anything else is unavailable and is not guessed at.
      return { result: "unavailable", id: null, state: null };
    }
    const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
    if (!row || typeof row.result !== "string") return { result: "unavailable", id: null, state: null };
    const id = [row.payment_id, row.refund_id, row.bill_id].find((v) => typeof v === "string") as string | undefined;
    return { result: row.result, id: id ?? null, state: typeof row.state === "string" ? row.state : typeof row.status === "string" ? row.status : null };
  } catch {
    return { result: "unavailable", id: null, state: null };
  }
}
