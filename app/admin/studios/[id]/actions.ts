"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { isAdmin } from "@/lib/admin";
import { getRequiredAppOrigin } from "@/lib/app-origin";
import { deliverWelcomeEmail } from "@/lib/email/send-welcome";
// (welcome email is one truthful invitation; no account-variant)
import { logAdminAction } from "@/lib/audit/admin-actions";
import { registrationKindFor } from "@/lib/sms/sender-registration";

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
const REGISTRATION_STATUS_VALUES = new Set([
  "pending",
  "requires_information",
  "approved",
  "rejected",
  "suspended",
]);

export type RecordSmsRegistrationResult = { ok: boolean; result?: string; error?: string };

/**
 * The form's entry point (useActionState): every refusal comes back as state
 * rendered beside the form. Nothing is thrown, so production's redaction of
 * Server Action errors never hides the guidance (Codex P2 4244484024).
 */
export async function recordSmsRegistrationFormAction(
  studioId: string,
  _previous: RecordSmsRegistrationResult | null,
  formData: FormData,
): Promise<RecordSmsRegistrationResult> {
  try {
    return await recordSmsRegistrationAction(studioId, formData);
  } catch {
    return { ok: false, result: "error", error: "The registration could not be recorded. Nothing was saved; try again." };
  }
}

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

  // BOUND TO THE SENDER SUPPORT VERIFIED: a submission without it (for
  // example from a page whose state could not be read) is refused here, and
  // the command refuses a sender that has since changed.
  const expectedSenderId = String(formData.get("expected_sender_id") ?? "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(expectedSenderId)) {
    await logAdminAction({
      actorUserId: user.id,
      actorEmail: user.email ?? null,
      action: "sms_registration_recorded",
      targetType: "studio",
      targetId: studioId,
      outcome: "failed",
    });
    return { ok: false, result: "missing_sender", error: "Reload the page: the studio's sender could not be confirmed." };
  }
  // BOUND TO THE NUMBER SUPPORT VERIFIED, and its kind is that number's: the
  // form never chooses one (Codex P2 4244484021, 4244484022). The command
  // derives the kind again and refuses a number that has changed.
  const expectedPhone = String(formData.get("expected_phone_number") ?? "");
  if (!registrationKindFor(expectedPhone)) {
    await logAdminAction({
      actorUserId: user.id,
      actorEmail: user.email ?? null,
      action: "sms_registration_recorded",
      targetType: "studio",
      targetId: studioId,
      outcome: "failed",
    });
    return {
      ok: false,
      result: "unsupported_number",
      error: "Reload the page: the studio's number is missing or is not a Canadian, US or toll-free number.",
    };
  }
  const status = String(formData.get("status") ?? "");
  const missing = String(formData.get("missing_information") ?? "").trim();
  const reference = String(formData.get("provider_reference") ?? "").trim();
  if (!REGISTRATION_STATUS_VALUES.has(status)) {
    return { ok: false, result: "invalid_input", error: "Choose a registration status." };
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("record_studio_sms_sender_registration", {
    p_studio_id: studioId,
    p_expected_sender_id: expectedSenderId,
    p_expected_phone: expectedPhone,
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
    sender_changed: "The studio's number changed after this page loaded. Nothing was recorded; reload and verify the current number.",
    sender_has_no_number: "The studio's sender has no number yet, so there is nothing to record registration against.",
  };
  return { ok: false, result, error: message[result] ?? "The registration could not be recorded." };
}
