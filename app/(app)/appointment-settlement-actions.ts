"use server";

import { dbErrorCode } from "@/lib/logging/error-class";
import { revalidatePath } from "next/cache";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { createClient } from "@/lib/supabase/server";
import { resolveAppointmentQuotedAmountCents } from "@/lib/billing/appointment-settlement";
import { inferStripeLivemode } from "@/lib/stripe/server";
import { safeLog } from "@/lib/logging/safe-log";
import {
  isPractitionerMethod,
  isSettlementMethod,
  SETTLEMENT_RESULT_MESSAGE,
  type SettlementMethod,
  type SettlementResultCode,
} from "@/lib/billing/settlement-types";

// PAY-SETTLE — trusted wrappers for recording, waiving and correcting settlements.
// Adjusted initial fees go through the 0381 command.
//
// NOTHING HERE IS THE AUTHORITY. Every rule these actions appear to enforce is
// re-enforced inside the SECURITY DEFINER command: membership, ownership,
// tenancy, appointment status, mutual exclusion with card charging, and the
// single-live-settlement law. A forged POST that skips this file entirely meets
// exactly the same refusals. What lives here is (a) deriving facts the browser
// must never supply, and (b) turning closed result codes into safe copy.
//
// NO STRIPE. These actions issue no Stripe call of any kind, and the settlement
// table has no Stripe column to write. That is the structural half of "a
// practitioner attestation can never manufacture a receipt".
//
// A changed fee is an owner decision. SQL independently rederives the reference
// price and records it with the adjusted fee, reason, actor and receipt.

const NOT_AUTHORIZED = "You are not authorized to do that.";

// 0214: a settlement takes its currency from the studio's payment
// jurisdiction, and a studio with none is refused by the insert trigger
// (payment_jurisdiction_missing). That is a setup gap, not a permission
// failure, so it gets its own copy and its own ops event instead of
// NOT_AUTHORIZED.
const JURISDICTION_MISSING =
  "This studio's payment country and currency have not been confirmed yet, so nothing was recorded. Contact Hone support to finish payment setup.";

export type SettlementActionResult =
  | { ok: true; code: SettlementResultCode; message: string; settlementId: string | null }
  | {
      ok: false;
      code: SettlementResultCode | "unavailable" | "payment_jurisdiction_missing";
      message: string;
    };

type SettlementAction = "record" | "waive" | "supersede";

/** Map a command ERROR. Only the 0214 jurisdiction refusal is told apart. */
function classifyRpcError(error: { code?: string; message?: string }): {
  dbCode: string;
  jurisdictionMissing: boolean;
} {
  return {
    dbCode: dbErrorCode(error),
    jurisdictionMissing:
      typeof error.message === "string" &&
      error.message.startsWith("payment_jurisdiction_missing:"),
  };
}

function rpcFailure(
  action: SettlementAction,
  failed: { dbCode: string; jurisdictionMissing: boolean },
): SettlementActionResult {
  if (failed.jurisdictionMissing) {
    // The message names the studio; only the action and a validated code are
    // logged, never the message.
    safeLog.error(
      JSON.stringify({
        event: "settlement_payment_jurisdiction_missing",
        action,
        dbCode: failed.dbCode,
      }),
    );
    return { ok: false, code: "payment_jurisdiction_missing", message: JURISDICTION_MISSING };
  }
  return { ok: false, code: "unavailable", message: NOT_AUTHORIZED };
}

function failure(code: SettlementResultCode): SettlementActionResult {
  return { ok: false, code, message: SETTLEMENT_RESULT_MESSAGE[code] };
}

function readCode(rows: unknown): SettlementResultCode | null {
  const row = (Array.isArray(rows) ? rows[0] : rows) as
    | { result?: unknown }
    | null;
  const value = row?.result;
  return typeof value === "string" &&
    value in SETTLEMENT_RESULT_MESSAGE
    ? (value as SettlementResultCode)
    : null;
}

function readId(rows: unknown): string | null {
  const row = (Array.isArray(rows) ? rows[0] : rows) as
    | { settlement_id?: unknown }
    | null;
  return typeof row?.settlement_id === "string" ? row.settlement_id : null;
}

function parseAmountCents(raw: FormDataEntryValue | null): number | null {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!/^\d{1,7}$/.test(text)) return null;
  const n = Number.parseInt(text, 10);
  return Number.isSafeInteger(n) && n >= 0 && n <= 200000 ? n : null;
}

function parseNote(raw: FormDataEntryValue | null): string | null {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text.length === 0) return null;
  return text.length <= 500 ? text : null;
}

type AdjustedFee = {
  p_reference_fee_cents: number;
  p_final_fee_cents: number;
  p_fee_adjustment_reason: string;
};

// The fee the owner SAW is always sent, adjusted or not. An UNCHANGED fee (final equals reference) has no adjustment
// to record, but it is still a claim about the current price: it is checked against the price now (see staleSeenFee).
type SeenFee = { unchanged: number };

function readFeeAdjustment(form: FormData): AdjustedFee | SeenFee | null | "invalid" {
  const keys = ["reference_fee_cents", "final_fee_cents", "fee_adjustment_reason"];
  if (!keys.some((key) => form.has(key))) return null;
  const reference = parseAmountCents(form.get("reference_fee_cents"));
  const final = parseAmountCents(form.get("final_fee_cents"));
  const raw = form.get("fee_adjustment_reason");
  const reason = typeof raw === "string" ? raw.trim() : "";
  if (reference === null || reference <= 0 || final === null) return "invalid";
  if (final === reference) return reason ? "invalid" : { unchanged: reference };
  if (!reason || reason.length > 200) return "invalid";
  return { p_reference_fee_cents: reference, p_final_fee_cents: final, p_fee_adjustment_reason: reason };
}

/**
 * True when the price on file is no longer the fee the owner saw. The adjusted command refuses this itself
 * (fee_changed); the legacy command snapshots the LATEST price without comparing, so an unchanged Final fee is
 * compared here, before the legacy command runs. An unresolvable price counts as changed: nothing is recorded
 * against a fee that cannot be confirmed.
 */
async function staleSeenFee(seen: number, studioId: string, appointmentId: string, timezone: string, isOwner: boolean): Promise<boolean> {
  return (await resolveAppointmentQuotedAmountCents(studioId, appointmentId, timezone, isOwner)) !== seen;
}

async function refresh(): Promise<void> {
  revalidatePath("/dashboard");
  revalidatePath("/calendar", "layout");
  revalidatePath("/clients", "layout");
}

/**
 * Record an initial non-card disposition.
 *
 * Authority is the EXISTING Checkout boundary and is re-derived twice: here by
 * getCurrentPractitionerWithStudio (which redirects/throws for an
 * unauthenticated or inactive caller) and again inside the command by
 * session_actor_practitioner. `waived` is refused in both places.
 */
export async function recordAppointmentSettlementAction(
  formData: FormData,
): Promise<SettlementActionResult> {
  let studioId: string;
  let studioTimezone: string;
  let isOwner: boolean;
  try {
    const { practitioner, studio } = await getCurrentPractitionerWithStudio();
    studioId = studio.id;
    studioTimezone = studio.timezone;
    isOwner = practitioner.role === "owner";
  } catch {
    return { ok: false, code: "unavailable", message: NOT_AUTHORIZED };
  }
  // HON-44 (Sam decision 12): recording what a client paid is a financial act and
  // is owner-only. The role is derived above, never read from the form. This is
  // the APP half; the database command still admits any member until 0254.
  if (!isOwner) return failure("not_owner");

  const appointmentId = String(formData.get("appointment_id") ?? "");
  const method = String(formData.get("method") ?? "");
  // The four methods the owner may record. `waived` reaching this action means a
  // hand-built POST; the command refuses it too, and returns owner_only.
  if (!appointmentId || !isPractitionerMethod(method)) {
    return failure(method === "waived" ? "owner_only" : "invalid_input");
  }

  const amountCents = parseAmountCents(formData.get("amount_cents"));
  if (amountCents === null) return failure("invalid_input");
  const note = formData.get("note") ? parseNote(formData.get("note")) : null;
  if (formData.get("note") && note === null) return failure("invalid_input");

  const adjusted = readFeeAdjustment(formData);
  if (adjusted === "invalid") return failure("invalid_input");
  if (adjusted && "unchanged" in adjusted && await staleSeenFee(adjusted.unchanged, studioId, appointmentId, studioTimezone, isOwner)) {
    return failure("fee_changed");
  }
  const adjustment = adjusted && "p_final_fee_cents" in adjusted ? adjusted : null;
  const supabase = await createClient();
  const args = {
    p_studio_id: studioId,
    p_appointment_id: appointmentId,
    p_method: method,
    p_amount_cents: amountCents,
    p_note: note,
    p_livemode: inferStripeLivemode(),
  };
  const { data, error } = adjustment
    ? await supabase.rpc("record_adjusted_appointment_settlement", { ...args, ...adjustment })
    : await supabase.rpc("record_appointment_settlement", args);
  if (error) return rpcFailure("record", classifyRpcError(error));

  const code = readCode(data);
  if (!code) return { ok: false, code: "unavailable", message: NOT_AUTHORIZED };
  if (code === "recorded" || code === "already_settled") {
    await refresh();
    return {
      ok: true,
      code,
      message: SETTLEMENT_RESULT_MESSAGE[code],
      settlementId: readId(data),
    };
  }
  return failure(code);
}

/**
 * Waive the fee. OWNER ONLY.
 *
 * The owner fact is derived HERE from the authenticated practitioner and from
 * nowhere else — the same F-PAY-002 discipline the prepare action follows,
 * where there is deliberately no `is_owner` form field because no code path
 * consults one. It is then re-derived independently in SQL by is_studio_owner,
 * so this check is a courtesy and the database is the authority.
 */
export async function waiveAppointmentFeeAction(
  formData: FormData,
): Promise<SettlementActionResult> {
  let studioId: string;
  let studioTimezone: string;
  let isOwner: boolean;
  try {
    const { practitioner, studio } = await getCurrentPractitionerWithStudio();
    studioId = studio.id;
    studioTimezone = studio.timezone;
    isOwner = practitioner.role === "owner";
  } catch {
    return { ok: false, code: "unavailable", message: NOT_AUTHORIZED };
  }
  if (!isOwner) return failure("not_owner");

  const appointmentId = String(formData.get("appointment_id") ?? "");
  if (!appointmentId) return failure("invalid_input");
  const amountCents = parseAmountCents(formData.get("amount_cents"));
  if (amountCents === null) return failure("invalid_input");
  const note = formData.get("note") ? parseNote(formData.get("note")) : null;
  if (formData.get("note") && note === null) return failure("invalid_input");

  const adjusted = readFeeAdjustment(formData);
  if (adjusted === "invalid") return failure("invalid_input");
  if (adjusted && "unchanged" in adjusted && await staleSeenFee(adjusted.unchanged, studioId, appointmentId, studioTimezone, isOwner)) {
    return failure("fee_changed");
  }
  const adjustment = adjusted && "p_final_fee_cents" in adjusted ? adjusted : null;
  const supabase = await createClient();
  const args = {
    p_studio_id: studioId,
    p_appointment_id: appointmentId,
    p_amount_cents: amountCents,
    p_note: note,
    p_livemode: inferStripeLivemode(),
  };
  const { data, error } = adjustment
    ? await supabase.rpc("record_adjusted_appointment_settlement", { ...args, p_method: "waived", ...adjustment })
    : await supabase.rpc("waive_appointment_fee", args);
  if (error) return rpcFailure("waive", classifyRpcError(error));

  const code = readCode(data);
  if (!code) return { ok: false, code: "unavailable", message: NOT_AUTHORIZED };
  if (code === "recorded" || code === "already_settled") {
    await refresh();
    return {
      ok: true,
      code,
      message: SETTLEMENT_RESULT_MESSAGE[code],
      settlementId: readId(data),
    };
  }
  return failure(code);
}

/**
 * Correct a settlement by superseding it. OWNER ONLY, including over the
 * owner's own record and over a practitioner's.
 *
 * There is no "edit" and no "delete" anywhere in this file, because there is no
 * such capability in the schema: the original row keeps its method, amount,
 * actor and timestamp forever, and this inserts its replacement.
 */
export async function supersedeAppointmentSettlementAction(
  formData: FormData,
): Promise<SettlementActionResult> {
  let studioId: string;
  let isOwner: boolean;
  try {
    const { practitioner, studio } = await getCurrentPractitionerWithStudio();
    studioId = studio.id;
    isOwner = practitioner.role === "owner";
  } catch {
    return { ok: false, code: "unavailable", message: NOT_AUTHORIZED };
  }
  if (!isOwner) return failure("not_owner");

  const settlementId = String(formData.get("settlement_id") ?? "");
  const appointmentId = String(formData.get("appointment_id") ?? "");
  const method = String(formData.get("method") ?? "");
  if (!settlementId || !isSettlementMethod(method)) return failure("invalid_input");

  const amountCents = parseAmountCents(formData.get("amount_cents"));
  if (amountCents === null) return failure("invalid_input");
  // A CORRECTION MUST SAY WHY. Required here and by CHECK in 0187.
  const reason = parseNote(formData.get("reason"));
  if (!reason) return failure("invalid_input");
  const note = formData.get("note") ? parseNote(formData.get("note")) : null;
  if (formData.get("note") && note === null) return failure("invalid_input");


  const supabase = await createClient();
  const { data, error } = await supabase.rpc("supersede_appointment_settlement", {
    p_studio_id: studioId,
    p_expected_settlement_id: settlementId,
    p_method: method as SettlementMethod,
    p_amount_cents: amountCents,
    p_reason: reason,
    p_note: note,
    p_livemode: inferStripeLivemode(),
  });
  if (error?.code === "23514" && error.message === "settlement_adjusted_amount_invalid") {
    return failure("invalid_input");
  }
  if (error) return rpcFailure("supersede", classifyRpcError(error));

  const code = readCode(data);
  if (!code) return { ok: false, code: "unavailable", message: NOT_AUTHORIZED };
  if (code === "corrected") {
    await refresh();
    return {
      ok: true,
      code,
      message: SETTLEMENT_RESULT_MESSAGE[code],
      settlementId: readId(data),
    };
  }
  return failure(code);
}
