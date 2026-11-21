import "server-only";
import { loadCancellationFeeRules } from "./cancellation-fee-rules-server";
import { selectCancellationFeeTier } from "./cancellation-fee-rules";
import { liveChargeReasonBlockMessage } from "@/lib/billing/live-charge-reason-allowlist";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadAppointmentSessionPrice } from "@/lib/billing/authoritative-appointment-price";
import { manualFeeConfigIssue, type FeeConfigRow } from "@/lib/billing/manual-fee-percent";

// No-show still uses the legacy studio switch and independent release gate.
// Cancellation fees use the governed tier configuration (0357), not the legacy flat-rate switch.
// Both paths refuse unreadable settings and recheck before a new charge; recovery/refunds remain available.

export const LATE_CANCEL_FEE_DISABLED_MESSAGE =
  "Late cancellation fees are turned off for this studio. The owner can turn them on in Settings, Payments.";
export const NO_SHOW_FEE_DISABLED_MESSAGE =
  "No-show fees are turned off for this studio. The owner can turn them on in Settings, Payments.";
export const MANUAL_FEE_SETTING_UNREADABLE_MESSAGE =
  "The fee setting for this studio could not be checked, so the fee was not run.";

export type ManualFeeSettingRow = {
  late_cancel_fee_enabled?: unknown;
  no_show_fee_enabled?: unknown;
} | null;

// Pure. Returns the user-facing message when the studio setting blocks this reason, or null when it allows it.
// A reason that is not a manual fee (session_payment, anything else) is NOT governed by this setting: null.
export function manualFeeSettingBlockMessage(chargeReason: string, row: ManualFeeSettingRow): string | null {
  if (chargeReason === "late_cancellation_fee") {
    return row?.late_cancel_fee_enabled === true ? null : LATE_CANCEL_FEE_DISABLED_MESSAGE;
  }
  if (chargeReason === "no_show_fee") {
    return row?.no_show_fee_enabled === true ? null : NO_SHOW_FEE_DISABLED_MESSAGE;
  }
  return null;
}

// Legacy no-show presentation. Cancellation settings use cancellationFeeState instead.
export type ManualFeeEffectiveState = "off" | "active" | "not_active_config" | "not_active_payments" | "not_active_release";

export function manualFeeEffectiveState(args: {
  chargeReason: "late_cancellation_fee" | "no_show_fee";
  settingRow: ManualFeeSettingRow & FeeConfigRow;
  // true only when payments are known to be ready; false or unknown is NOT ready.
  paymentsReady: boolean;
  livemode: boolean;
  studioId: string;
}): ManualFeeEffectiveState {
  if (manualFeeSettingBlockMessage(args.chargeReason, args.settingRow) !== null) return "off";
  // Saved ON is not enough: the saved amount or percentage must be one prepare would accept (same validator).
  if (manualFeeConfigIssue(args.chargeReason, args.settingRow) !== null) return "not_active_config";
  if (args.paymentsReady !== true) return "not_active_payments";
  if (liveChargeReasonBlockMessage(args.chargeReason, args.livemode, args.studioId) !== null) return "not_active_release";
  return "active";
}

export const MANUAL_FEE_STATE_COPY: Record<ManualFeeEffectiveState, { saved: string; effective: string }> = {
  off: { saved: "Saved as off", effective: "Not active" },
  active: { saved: "Saved as on", effective: "Active" },
  not_active_config: { saved: "Saved as on", effective: "Not active: the fee amount or percentage is not set" },
  not_active_payments: { saved: "Saved as on", effective: "Not active: payments are not ready" },
  not_active_release: { saved: "Saved as on", effective: "Not active yet: not released for your studio" },
};

// ---------------------------------------------------------------------------
// Execute-time hold for a NEW manual fee: the owner's settings now, compared with what was FROZEN at prepare.
// ---------------------------------------------------------------------------
//
// Read from the database at the moment of the call, in two small fee-only queries (never added to the runner's shared
// attempt select, so session payments keep working before 0351 is applied): the studio's current settings, and the
// attempt's frozen calc_mode / basis_cents / percent_bp. It returns a message when the fee must NOT go out:
//   * the fee type is switched off, or
//   * the studio's mode, percentage (percent) or amount (fixed) differs from what was frozen on the attempt, or
//   * the attempt carries no frozen calculation (calc_mode NULL) or either read fails (fail closed).
// Execute never recomputes an amount. It charges attempt.amount_cents, and this only decides whether that frozen figure
// still matches the owner's current settings.
//
// RECOVERY. A refusal here leaves a still-"ready" attempt in place, and it occupies the one-fee-per-appointment slot (0338).
// The owner cancels it from the appointment (cancel is not gated by this check) and prepares it again with the new settings.
export const MANUAL_FEE_PRICE_CHANGED_MESSAGE =
  "This appointment's service price is no longer a usable price (it is now $0, missing or ambiguous), so the fee was not sent. Cancel this prepared charge and check the price.";

export const MANUAL_FEE_SETTINGS_CHANGED_MESSAGE =
  "The fee settings changed after this fee was prepared, so it was not run. Cancel this prepared fee and prepare it again.";

export async function loadManualFeeExecuteHold(
  admin: unknown,
  attempt: { id: string; studio_id: string; charge_reason: string; amount_cents: number },
): Promise<string | null> {
  const reasonKey = attempt.charge_reason;
  if (reasonKey !== "late_cancellation_fee" && reasonKey !== "no_show_fee") return null;
  if (reasonKey === "late_cancellation_fee") return loadCancellationExecuteHold(admin as SupabaseClient, attempt);
  const late = false;
  try {
    const db = admin as {
      from: (t: string) => {
        select: (c: string) => {
          eq: (c: string, v: string) => {
            maybeSingle: () => PromiseLike<{ data: Record<string, unknown> | null; error: unknown }>;
          };
        };
      };
    };
    const studio = await db
      .from("studios")
      .select(
        "late_cancel_fee_enabled, no_show_fee_enabled, late_cancel_fee_mode, no_show_fee_mode, late_cancel_fee_percent_bp, no_show_fee_percent_bp, late_cancel_fee_cents, no_show_fee_cents, timezone",
      )
      .eq("id", attempt.studio_id)
      .maybeSingle();
    if (studio.error || !studio.data) return MANUAL_FEE_SETTING_UNREADABLE_MESSAGE;
    const off = manualFeeSettingBlockMessage(reasonKey, studio.data as ManualFeeSettingRow);
    if (off) return off;
    const frozen = await db
      .from("payment_charge_attempts")
      .select("calc_mode, basis_cents, percent_bp, appointment_id")
      .eq("id", attempt.id)
      .maybeSingle();
    if (frozen.error || !frozen.data) return MANUAL_FEE_SETTING_UNREADABLE_MESSAGE;
    const mode = late ? studio.data.late_cancel_fee_mode : studio.data.no_show_fee_mode;
    if (frozen.data.calc_mode === "percent") {
      const bp = late ? studio.data.late_cancel_fee_percent_bp : studio.data.no_show_fee_percent_bp;
      if (mode !== "percent" || bp !== frozen.data.percent_bp) return MANUAL_FEE_SETTINGS_CHANGED_MESSAGE;
      // The appointment's price must still be a usable one. A price that became $0, missing or ambiguous (or cannot be read)
      // after prepare blocks the send. A DIFFERENT positive price does not: the frozen amount is what the owner confirmed.
      const price = await loadAppointmentSessionPrice({
        admin: admin as SupabaseClient,
        studioId: attempt.studio_id,
        appointmentId: String(frozen.data.appointment_id ?? ""),
        studioTimezone: String(studio.data.timezone ?? ""),
      });
      if (!price.ok) return MANUAL_FEE_SETTING_UNREADABLE_MESSAGE;
      if (price.result.kind !== "resolved") return MANUAL_FEE_PRICE_CHANGED_MESSAGE;
      return null;
    }
    if (frozen.data.calc_mode === "fixed") {
      const cents = late ? studio.data.late_cancel_fee_cents : studio.data.no_show_fee_cents;
      if (mode !== "fixed" || cents !== attempt.amount_cents) return MANUAL_FEE_SETTINGS_CHANGED_MESSAGE;
      return null;
    }
    return MANUAL_FEE_SETTINGS_CHANGED_MESSAGE;
  } catch {
    return MANUAL_FEE_SETTING_UNREADABLE_MESSAGE;
  }
}

/** The new tier model is independent of legacy single-rate switches, which never enroll a studio. */
async function loadCancellationExecuteHold(db: SupabaseClient, attempt: { id: string; studio_id: string; amount_cents: number }): Promise<string | null> {
  try {
    const config = await loadCancellationFeeRules(db, attempt.studio_id);
    if (!config.ok) return config.error;
    const { data: frozen, error } = await db.from("payment_charge_attempts")
      .select("calc_mode, basis_cents, percent_bp, appointment_id, policy_snapshot_hash, cancellation_fee_snapshot")
      .eq("id", attempt.id).eq("studio_id", attempt.studio_id).maybeSingle();
    if (error || !frozen) return MANUAL_FEE_SETTING_UNREADABLE_MESSAGE;
    const { data: appt, error: apptError } = await db.from("appointments").select("starts_at, cancelled_at, status")
      .eq("id", frozen.appointment_id).eq("studio_id", attempt.studio_id).maybeSingle();
    if (apptError || !appt) return MANUAL_FEE_SETTING_UNREADABLE_MESSAGE;
    if (appt.status !== "cancelled") return MANUAL_FEE_SETTINGS_CHANGED_MESSAGE;
    const choice = selectCancellationFeeTier({ rules: config.rules, startsAt: appt.starts_at, cancelledAt: appt.cancelled_at, timezone: config.timezone });
    if (!choice.ok) return choice.error;
    const snapshot = frozen.cancellation_fee_snapshot;
    if (!snapshot || snapshot.revision !== config.rules.revision || snapshot.tier !== choice.tier ||
      snapshot.timezone !== config.timezone || Date.parse(snapshot.startsAt) !== Date.parse(appt.starts_at) ||
      Date.parse(snapshot.cancelledAt) !== Date.parse(appt.cancelled_at) || frozen.policy_snapshot_hash !== config.policyHash ||
      frozen.calc_mode !== choice.rate.mode) return MANUAL_FEE_SETTINGS_CHANGED_MESSAGE;
    if (choice.rate.mode === "fixed") return attempt.amount_cents === choice.rate.value ? null : MANUAL_FEE_SETTINGS_CHANGED_MESSAGE;
    if (frozen.percent_bp !== choice.rate.value) return MANUAL_FEE_SETTINGS_CHANGED_MESSAGE;
    const price = await loadAppointmentSessionPrice({ admin: db, studioId: attempt.studio_id, appointmentId: frozen.appointment_id, studioTimezone: config.timezone });
    if (!price.ok) return MANUAL_FEE_SETTING_UNREADABLE_MESSAGE;
    return price.result.kind === "resolved" ? null : MANUAL_FEE_PRICE_CHANGED_MESSAGE;
  } catch {
    return MANUAL_FEE_SETTING_UNREADABLE_MESSAGE;
  }
}
