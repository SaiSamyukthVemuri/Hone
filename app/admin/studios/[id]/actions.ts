"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { isAdmin } from "@/lib/admin";
import { getRequiredAppOrigin } from "@/lib/app-origin";
import { deliverWelcomeEmail } from "@/lib/email/send-welcome";
// (welcome email is one truthful invitation; no account-variant)
import { logAdminAction } from "@/lib/audit/admin-actions";

import type { WelcomeEmailResult } from "@/lib/email/send-welcome";
import { auditOutcomeFor } from "./audit-outcome";

export type ResendWelcomeResult = {
  ok: boolean;
  status?: WelcomeEmailResult;
  error?: string;
};

// Operator-only "Resend welcome email" for a studio. Re-checks isAdmin (the
// real gate; defense-in-depth over the /admin layout), then reuses the same
// deliverWelcomeEmail path as studio creation, which also re-stamps the send
// outcome on studio_onboarding. Never mints an auth user or touches
// practitioners. Best-effort; surfaces the send outcome to the operator.
export async function resendWelcomeEmailAction(
  studioId: string,
): Promise<ResendWelcomeResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isAdmin(user.email)) {
    await logAdminAction({
      actorUserId: user?.id ?? null,
      actorEmail: user?.email ?? null,
      action: "welcome_email_resent",
      targetType: "studio",
      targetId: studioId,
      outcome: "blocked",
    });
    return { ok: false, error: "Not authorized." };
  }

  const admin = createAdminClient();
  const { data: studio, error } = await admin
    .from("studios")
    .select("id, name, slug, owner_email")
    .eq("id", studioId)
    .maybeSingle();
  if (error || !studio) {
    return { ok: false, error: "Studio not found." };
  }

  // One truthful invitation email (no account-variant inference).
  const status = await deliverWelcomeEmail(admin, {
    studioId: studio.id,
    ownerDisplayName: null,
    ownerEmail: studio.owner_email,
    studioName: studio.name,
    bookingUrl: studio.slug
      ? `${getRequiredAppOrigin()}/book/${studio.slug}`
      : "",
  });

  await logAdminAction({
    actorUserId: user.id,
    actorEmail: user.email ?? null,
    studioId: studio.id,
    targetType: "studio",
    targetId: studio.id,
    action: "welcome_email_resent",
    outcome: auditOutcomeFor(status),
    metadata: { slug: studio.slug ?? undefined, welcome_email_result: status },
  });

  revalidatePath(`/admin/studios/${studioId}`);
  return { ok: status !== "failed", status };
}

// SMS-SENDER-REG-01 (#824): Hone support records a studio's US registration
// evidence (10DLC, or toll-free verification) after checking the provider
// account. Evidence for readiness only: it calls no provider and activates
// nothing. The 0217 command resolves the studio's LIVE sender itself, so the
// form never names a sender and cannot reach another studio's number.
const REGISTRATION_KIND_VALUES = new Set(["us_10dlc", "toll_free_verification"]);
const REGISTRATION_STATUS_VALUES = new Set([
  "pending",
  "requires_information",
  "approved",
  "rejected",
  "suspended",
]);

export type RecordSmsRegistrationResult = { ok: boolean; result?: string; error?: string };

export async function recordSmsRegistrationAction(
  studioId: string,
  formData: FormData,
): Promise<RecordSmsRegistrationResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isAdmin(user.email)) {
    await logAdminAction({
      actorUserId: user?.id ?? null,
      actorEmail: user?.email ?? null,
      action: "sms_registration_recorded",
      targetType: "studio",
      targetId: studioId,
      outcome: "blocked",
    });
    return { ok: false, error: "Not authorized." };
  }

  const kind = String(formData.get("kind") ?? "");
  const status = String(formData.get("status") ?? "");
  const missing = String(formData.get("missing_information") ?? "").trim();
  const reference = String(formData.get("provider_reference") ?? "").trim();
  if (!REGISTRATION_KIND_VALUES.has(kind) || !REGISTRATION_STATUS_VALUES.has(status)) {
    return { ok: false, error: "Choose a registration kind and status." };
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("record_studio_sms_sender_registration", {
    p_studio_id: studioId,
    p_kind: kind,
    p_status: status,
    p_missing: status === "requires_information" ? missing : null,
    p_provider_reference: reference.length > 0 ? reference : null,
  });
  const row = (Array.isArray(data) ? data[0] : null) as { result?: string } | null;
  const result = error ? "error" : (row?.result ?? "error");
  await logAdminAction({
    actorUserId: user.id,
    actorEmail: user.email ?? null,
    action: "sms_registration_recorded",
    targetType: "studio",
    targetId: studioId,
    outcome: result === "recorded" ? "succeeded" : "failed",
  });
  revalidatePath(`/admin/studios/${studioId}`);
  if (result === "recorded") return { ok: true, result };
  const message: Record<string, string> = {
    invalid_input: "Check the fields: a reason is required exactly when information is missing, and the reference must be a plain identifier.",
    no_live_sender: "This studio has no live SMS sender to record registration against.",
    ambiguous_live_sender: "This studio has more than one live sender. Nothing was recorded.",
  };
  return { ok: false, result, error: message[result] ?? "The registration could not be recorded." };
}
