import { fixedFeeCentsIssue, isValidPercentBp } from "./manual-fee-percent";

export type CancellationFeeRate = { mode: "fixed" | "percent"; value: number };
export type CancellationFeeRules = {
  revision: number;
  enabled: boolean;
  notice_hours: number;
  notice_mode: "fixed" | "percent";
  notice_value: number;
  same_day_mode: "fixed" | "percent";
  same_day_value: number;
  policy_snapshot_hash: string;
};
export type CancellationFeeTier = "within_notice" | "same_day";
export type CancellationFeeSnapshot = {
  revision: number;
  tier: CancellationFeeTier;
  startsAt: string;
  cancelledAt: string;
  timezone: string;
};

export const CANCELLATION_SETUP_REQUIRED =
  "Set up cancellation fee rules in Settings, Payments, then turn them on.";
export const CANCELLATION_POLICY_CHANGED =
  "The cancellation policy changed. Review the fee rules against the current policy, save them and turn them on again.";

export function validCancellationRate(mode: unknown, value: unknown): boolean {
  return mode === "percent"
    ? isValidPercentBp(value)
    : mode === "fixed" && fixedFeeCentsIssue(value) === null;
}

export function isCancellationFeeRules(
  value: unknown,
): value is CancellationFeeRules {
  if (!value || typeof value !== "object") return false;
  const r = value as CancellationFeeRules;
  return (
    Number.isSafeInteger(r.revision) &&
    r.revision > 0 &&
    typeof r.enabled === "boolean" &&
    Number.isInteger(r.notice_hours) &&
    r.notice_hours >= 1 &&
    r.notice_hours <= 168 &&
    validCancellationRate(r.notice_mode, r.notice_value) &&
    validCancellationRate(r.same_day_mode, r.same_day_value) &&
    typeof r.policy_snapshot_hash === "string" &&
    /^[a-f0-9]{64}$/.test(r.policy_snapshot_hash)
  );
}

/** Calendar-day override, then strictly less than the notice window. Never a rolling 24-hour approximation. */
export function selectCancellationFeeTier(args: {
  rules: CancellationFeeRules;
  startsAt: string | null;
  cancelledAt: string | null;
  timezone: string | null;
}):
  | {
      ok: true;
      tier: CancellationFeeTier;
      rate: CancellationFeeRate;
      snapshot: CancellationFeeSnapshot;
    }
  | { ok: false; error: string } {
  const { rules, startsAt, cancelledAt, timezone } = args;
  if (!isCancellationFeeRules(rules))
    return { ok: false, error: CANCELLATION_SETUP_REQUIRED };
  const start = startsAt ? Date.parse(startsAt) : NaN;
  const cancelled = cancelledAt ? Date.parse(cancelledAt) : NaN;
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(cancelled) ||
    !timezone ||
    !startsAt ||
    !cancelledAt
  ) {
    return {
      ok: false,
      error:
        "The cancellation time or studio timezone could not be verified, so no fee can be prepared.",
    };
  }
  // A cancellation after the appointment began is not silently reclassified as a no-show.
  if (cancelled > start)
    return {
      ok: false,
      error:
        "This cancellation was recorded after the appointment started. Check the appointment before charging a fee.",
    };
  let sameDay: boolean;
  try {
    const date = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    sameDay = date.format(start) === date.format(cancelled);
  } catch {
    return {
      ok: false,
      error:
        "The studio timezone could not be verified, so no fee can be prepared.",
    };
  }
  const tier = sameDay
    ? "same_day"
    : start - cancelled < rules.notice_hours * 3_600_000
      ? "within_notice"
      : null;
  if (!tier)
    return {
      ok: false,
      error: `This appointment was cancelled with at least ${rules.notice_hours} hours’ notice. No cancellation fee is owed.`,
    };
  return {
    ok: true,
    tier,
    rate:
      tier === "same_day"
        ? { mode: rules.same_day_mode, value: rules.same_day_value }
        : { mode: rules.notice_mode, value: rules.notice_value },
    snapshot: {
      revision: rules.revision,
      tier,
      startsAt,
      cancelledAt,
      timezone,
    },
  };
}

export function cancellationFeeState(
  rules: unknown,
  policyHash: string,
  paymentsReady: boolean,
): string {
  if (!isCancellationFeeRules(rules))
    return "Set up rules to allow cancellation fees.";
  if (!rules.enabled) return "Off. No cancellation fees can be charged.";
  if (rules.policy_snapshot_hash !== policyHash)
    return CANCELLATION_POLICY_CHANGED;
  return paymentsReady ? "Active" : "Not active: payments are not ready";
}
