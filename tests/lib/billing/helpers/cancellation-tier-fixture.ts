import { createHash } from "node:crypto";
export const TIER_POLICY =
  "Cancellation fees: configured notice-window rate and a same-day rate.";
export const TIER_HASH = createHash("sha256")
  .update(`${TIER_POLICY}\n---\n`)
  .digest("hex");
export const TIER_TIMING = {
  starts_at: "2026-11-20T15:00:00Z",
  cancelled_at: "2026-11-19T14:00:00Z",
  status: "cancelled",
};
export const TIER_SNAPSHOT = {
  revision: 2,
  tier: "within_notice",
  startsAt: TIER_TIMING.starts_at,
  cancelledAt: TIER_TIMING.cancelled_at,
  timezone: "America/Toronto",
};
export function tierStudio(row: unknown) {
  return row && typeof row === "object"
    ? {
        timezone: "America/Toronto",
        cancellation_policy_text: TIER_POLICY,
        no_show_policy_text: "",
        ...row,
      }
    : row;
}
/** Translate this historical harness's editable flat-rate fixture into the equivalent configured tier row. */
export function tierRules(row: unknown) {
  if (!row || typeof row !== "object") return null;
  const s = row as Record<string, unknown>;
  return {
    revision: 2,
    enabled: s.late_cancel_fee_enabled === true,
    notice_hours: 48,
    notice_mode: s.late_cancel_fee_mode,
    notice_value:
      s.late_cancel_fee_mode === "percent"
        ? s.late_cancel_fee_percent_bp
        : s.late_cancel_fee_cents,
    same_day_mode: "percent",
    same_day_value: 10000,
    policy_snapshot_hash: TIER_HASH,
  };
}
export const tierFrozen = (row: unknown) =>
  row && typeof row === "object"
    ? {
        appointment_id: "appt-1",
        policy_snapshot_hash: TIER_HASH,
        cancellation_fee_snapshot: TIER_SNAPSHOT,
        ...row,
      }
    : row;
