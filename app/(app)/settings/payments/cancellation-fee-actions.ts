"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import {
  isCancellationFeeRules,
  validCancellationRate,
  type CancellationFeeRules,
} from "@/lib/billing/cancellation-fee-rules";
import { dbErrorCode } from "@/lib/logging/error-class";

type Result =
  | { ok: true; rules: CancellationFeeRules }
  | { ok: false; error: string };
const FAILED =
  "We couldn’t save the cancellation fee settings. Refresh and try again.";

async function writeRules(
  command: "save_cancellation_fee_rules" | "set_cancellation_fee_rules_enabled",
  args: Record<string, unknown>,
): Promise<Result> {
  try {
    const { practitioner, studio } = await getCurrentPractitionerWithStudio();
    if (practitioner.role !== "owner")
      return {
        ok: false,
        error: "Only the studio owner can change cancellation fees.",
      };
    const db = await createClient();
    // Session/RLS transport. The RPC independently verifies the owner, exact revision and current policy.
    const { data, error } = await db.rpc(command, {
      ...args,
      p_studio_id: studio.id,
    });
    if (error) {
      const code = dbErrorCode(error);
      console.error(
        JSON.stringify({
          event: "cancellation_fee_settings_write_failed",
          code,
        }),
      );
      return {
        ok: false,
        error:
          code === "40001"
            ? "The policy or fee settings changed elsewhere. Refresh and review them again."
            : FAILED,
      };
    }
    const rules = Array.isArray(data) ? data[0] : data;
    if (!isCancellationFeeRules(rules)) return { ok: false, error: FAILED };
    revalidatePath("/settings/payments", "layout");
    return { ok: true, rules };
  } catch {
    return { ok: false, error: FAILED };
  }
}

export async function saveCancellationFeeRulesAction(input: {
  expectedRevision: number;
  noticeHours: number;
  noticeMode: "fixed" | "percent";
  noticeValue: number;
  sameDayMode: "fixed" | "percent";
  sameDayValue: number;
  policyHash: string;
  policyReviewed: boolean;
}): Promise<Result> {
  if (
    !input ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0 ||
    !Number.isInteger(input.noticeHours) ||
    input.noticeHours < 1 ||
    input.noticeHours > 168 ||
    !validCancellationRate(input.noticeMode, input.noticeValue) ||
    !validCancellationRate(input.sameDayMode, input.sameDayValue) ||
    input.policyReviewed !== true ||
    typeof input.policyHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.policyHash)
  ) {
    return {
      ok: false,
      error:
        "Enter a valid notice window and both fee rates, then confirm they match your cancellation policy.",
    };
  }
  return writeRules("save_cancellation_fee_rules", {
    p_expected_revision: input.expectedRevision,
    p_notice_hours: input.noticeHours,
    p_notice_mode: input.noticeMode,
    p_notice_value: input.noticeValue,
    p_same_day_mode: input.sameDayMode,
    p_same_day_value: input.sameDayValue,
    p_presented_policy_hash: input.policyHash,
  });
}

export async function setCancellationFeeRulesEnabledAction(input: {
  expectedRevision: number;
  enabled: boolean;
}): Promise<Result> {
  if (
    !input ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision <= 0 ||
    typeof input.enabled !== "boolean"
  )
    return { ok: false, error: FAILED };
  return writeRules("set_cancellation_fee_rules_enabled", {
    p_expected_revision: input.expectedRevision,
    p_enabled: input.enabled,
  });
}
