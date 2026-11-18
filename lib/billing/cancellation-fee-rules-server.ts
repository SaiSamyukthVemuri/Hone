import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildPolicySnapshot } from "@/lib/booking/policy-acknowledgement";
import {
  CANCELLATION_POLICY_CHANGED,
  CANCELLATION_SETUP_REQUIRED,
  isCancellationFeeRules,
} from "./cancellation-fee-rules";

export async function loadCancellationFeeRules(
  db: SupabaseClient,
  studioId: string,
) {
  const [config, studio] = await Promise.all([
    db
      .from("studio_cancellation_fee_rules")
      .select(
        "revision, enabled, notice_hours, notice_mode, notice_value, same_day_mode, same_day_value, policy_snapshot_hash",
      )
      .eq("studio_id", studioId)
      .maybeSingle(),
    db
      .from("studios")
      .select("cancellation_policy_text, no_show_policy_text, timezone")
      .eq("id", studioId)
      .maybeSingle(),
  ]);
  if (config.error || studio.error || !studio.data)
    return {
      ok: false as const,
      error:
        "The fee setting for this studio could not be checked, so the fee was not run.",
    };
  if (!isCancellationFeeRules(config.data))
    return { ok: false as const, error: CANCELLATION_SETUP_REQUIRED };
  const policyHash = buildPolicySnapshot({
    cancellationPolicyText: studio.data.cancellation_policy_text,
    noShowPolicyText: studio.data.no_show_policy_text,
  }).policySnapshotHash;
  if (config.data.policy_snapshot_hash !== policyHash)
    return { ok: false as const, error: CANCELLATION_POLICY_CHANGED };
  if (!config.data.enabled)
    return {
      ok: false as const,
      error:
        "Late cancellation fees are turned off for this studio. The owner can turn them on in Settings, Payments.",
    };
  return {
    ok: true as const,
    rules: config.data,
    timezone: studio.data.timezone as string,
    policyHash,
  };
}
