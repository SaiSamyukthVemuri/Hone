import "server-only";
import { liveChargeReasonBlockMessage } from "@/lib/billing/live-charge-reason-allowlist";
import { manualFeeConfigIssue, type FeeConfigRow } from "@/lib/billing/manual-fee-percent";

// The studio's OWN setting for each manual fee (migration 0351): studios.late_cancel_fee_enabled and
// studios.no_show_fee_enabled, both NOT NULL DEFAULT false, changed only by the owner (Settings -> Payments).
//
// This is the studio-facing switch. It is separate from the temporary LIVE release list in
// live-charge-reason-allowlist.ts, which Hone uses during rollout: in LIVE mode a fee needs BOTH. In TEST mode only this
// setting applies.
//
// FAIL CLOSED. A missing row, a read error, a missing column (the migration is not applied) or any value that is not the
// boolean `true` reads as OFF. A setting can only ever make a charge LESS likely.
//
// WHEN IT APPLIES. To NEW charges only: prepare (eligibility) and, at execute, an attempt that has not been sent yet
// (status "ready"). An attempt already claimed or sent (pending_stripe, requires_action, succeeded, failed, and any refund
// of one) is reconciled, refreshed and refunded exactly as before whatever this setting says, so turning a fee off never
// strands money in flight.

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

// ---------------------------------------------------------------------------
// What the owner SEES: the saved choice versus whether the fee is actually active.
//
// The Settings screen must never show a fee type as on while a gate still blocks it. So the screen does not decide
// anything itself: it asks this function, which calls the SAME two gate functions prepare and execute call
// (manualFeeSettingBlockMessage here, liveChargeReasonBlockMessage for the release list). If either of those changes,
// the screen changes with it.
//
//   off                       the owner's saved choice is OFF
//   active                    saved ON, payments ready, and (LIVE mode) the studio is on this type's release list
//   not_active_config         saved ON but the saved amount (fixed) or percentage (percent) is missing or invalid
//   not_active_payments       saved ON but payments are not ready (Stripe not connected or charges not enabled, or the
//                             payment jurisdiction is not confirmed, or readiness could not be read)
//   not_active_release        saved ON, payments ready, LIVE mode, and the studio is not yet on this type's release list
//
// TEMPORARY RELEASE CONTROL. The per-reason release lists (HONE_LATE_CANCEL_FEE_LIVE_STUDIO_IDS and
// HONE_NO_SHOW_FEE_LIVE_STUDIO_IDS in live-charge-reason-allowlist.ts) are a rollout control, not the studio-facing
// feature.
// For EACH fee type separately, its list is removed only when ALL of these hold (set by the platform operator, 15 Nov 2026):
//   (a) the settings migration (0351) is applied and read back;
//   (b) the readiness of that type has been reviewed (payment-safety review, and a wording review);
//   (c) its tests pass, including the test-mode smoke for that type;
//   (d) monitoring is in place for stuck or unclear fee attempts;
//   (e) the platform operator gives explicit rollout approval.
// There is NO minimum number of days or of real charged fees: a real fee is never created to satisfy a testing count.
// The removal is a PR that deletes that type's release check, after which the owner's setting plus payment readiness
// alone govern. First responder for a stuck or unclear fee attempt is the on-call operator; Stripe investigation escalates to the platform operator.
// ---------------------------------------------------------------------------

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
export const MANUAL_FEE_SETTINGS_CHANGED_MESSAGE =
  "The fee settings changed after this fee was prepared, so it was not run. Cancel this prepared fee and prepare it again.";

export async function loadManualFeeExecuteHold(
  admin: unknown,
  attempt: { id: string; studio_id: string; charge_reason: string; amount_cents: number },
): Promise<string | null> {
  const reasonKey = attempt.charge_reason;
  if (reasonKey !== "late_cancellation_fee" && reasonKey !== "no_show_fee") return null;
  const late = reasonKey === "late_cancellation_fee";
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
        "late_cancel_fee_enabled, no_show_fee_enabled, late_cancel_fee_mode, no_show_fee_mode, late_cancel_fee_percent_bp, no_show_fee_percent_bp, late_cancel_fee_cents, no_show_fee_cents",
      )
      .eq("id", attempt.studio_id)
      .maybeSingle();
    if (studio.error || !studio.data) return MANUAL_FEE_SETTING_UNREADABLE_MESSAGE;
    const off = manualFeeSettingBlockMessage(reasonKey, studio.data as ManualFeeSettingRow);
    if (off) return off;
    const frozen = await db
      .from("payment_charge_attempts")
      .select("calc_mode, basis_cents, percent_bp")
      .eq("id", attempt.id)
      .maybeSingle();
    if (frozen.error || !frozen.data) return MANUAL_FEE_SETTING_UNREADABLE_MESSAGE;
    const mode = late ? studio.data.late_cancel_fee_mode : studio.data.no_show_fee_mode;
    if (frozen.data.calc_mode === "percent") {
      const bp = late ? studio.data.late_cancel_fee_percent_bp : studio.data.no_show_fee_percent_bp;
      if (mode !== "percent" || bp !== frozen.data.percent_bp) return MANUAL_FEE_SETTINGS_CHANGED_MESSAGE;
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
