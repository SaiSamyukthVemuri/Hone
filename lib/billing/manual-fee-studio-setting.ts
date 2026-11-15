import "server-only";
import { liveChargeReasonBlockMessage } from "@/lib/billing/live-charge-reason-allowlist";

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

type Reader = {
  from: (table: "studios") => {
    select: (cols: string) => {
      eq: (col: "id", id: string) => {
        maybeSingle: () => PromiseLike<{ data: ManualFeeSettingRow; error: unknown }>;
      };
    };
  };
};

// Reads the setting now, from the database, for the given studio. Returns the block message or null. Never throws.
export async function loadManualFeeSettingBlockMessage(
  admin: unknown,
  studioId: string,
  chargeReason: string,
): Promise<string | null> {
  if (chargeReason !== "late_cancellation_fee" && chargeReason !== "no_show_fee") return null;
  try {
    const { data, error } = await (admin as Reader)
      .from("studios")
      .select("late_cancel_fee_enabled, no_show_fee_enabled")
      .eq("id", studioId)
      .maybeSingle();
    if (error || !data) return MANUAL_FEE_SETTING_UNREADABLE_MESSAGE;
    return manualFeeSettingBlockMessage(chargeReason, data);
  } catch {
    return MANUAL_FEE_SETTING_UNREADABLE_MESSAGE;
  }
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
//   not_active_payments       saved ON but payments are not ready (Stripe not connected or charges not enabled, or the
//                             payment jurisdiction is not confirmed, or readiness could not be read)
//   not_active_release        saved ON, payments ready, LIVE mode, and the studio is not yet on this type's release list
//
// TEMPORARY RELEASE CONTROL. The per-reason release lists (HONE_LATE_CANCEL_FEE_LIVE_STUDIO_IDS and
// HONE_NO_SHOW_FEE_LIVE_STUDIO_IDS in live-charge-reason-allowlist.ts) are a rollout control, not the studio-facing
// feature.
// For EACH fee type separately, its list is removed only when ALL of these hold (OPS, per Sam, 15 Nov 2026):
//   (a) the settings migration (0351) is applied and read back;
//   (b) the readiness of that type has been reviewed (Insurance, and Privacy for the wording);
//   (c) its tests pass, including the test-mode smoke for that type;
//   (d) monitoring is in place for stuck or unclear fee attempts;
//   (e) Sam gives explicit rollout approval, in his own words.
// There is NO minimum number of days or of real charged fees: a real fee is never created to satisfy a testing count.
// The removal is a PR that deletes that type's release check, after which the owner's setting plus payment readiness
// alone govern. First responder for a stuck or unclear fee attempt is OPS; Stripe investigation escalates to Sam.
// ---------------------------------------------------------------------------

export type ManualFeeEffectiveState = "off" | "active" | "not_active_payments" | "not_active_release";

export function manualFeeEffectiveState(args: {
  chargeReason: "late_cancellation_fee" | "no_show_fee";
  settingRow: ManualFeeSettingRow;
  // true only when payments are known to be ready; false or unknown is NOT ready.
  paymentsReady: boolean;
  livemode: boolean;
  studioId: string;
}): ManualFeeEffectiveState {
  if (manualFeeSettingBlockMessage(args.chargeReason, args.settingRow) !== null) return "off";
  if (args.paymentsReady !== true) return "not_active_payments";
  if (liveChargeReasonBlockMessage(args.chargeReason, args.livemode, args.studioId) !== null) return "not_active_release";
  return "active";
}

export const MANUAL_FEE_STATE_COPY: Record<ManualFeeEffectiveState, { saved: string; effective: string }> = {
  off: { saved: "Saved as off", effective: "Not active" },
  active: { saved: "Saved as on", effective: "Active" },
  not_active_payments: { saved: "Saved as on", effective: "Not active: payments are not ready" },
  not_active_release: { saved: "Saved as on", effective: "Not active yet: release pending" },
};
