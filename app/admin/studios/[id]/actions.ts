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

// Said whenever the command MAY have run but its answer was not seen (a lost
// response, an exception after dispatch): never "nothing was saved"
// (Codex P2 4249989480).
const OUTCOME_UNKNOWN: RecordSmsRegistrationResult = {
  ok: false,
  result: "outcome_unknown",
  error:
    "Hone could not confirm whether the registration was recorded. Reload the page and check the current record before trying again.",
};

/**
 * The form's entry point (useActionState): every refusal comes back as state
 * rendered beside the form. Nothing is thrown, so production's redaction of
 * Server Action errors never hides the guidance (Codex P2 4244484024). An
 * exception says "nothing was saved" only if the command was never sent.
 */
export async function recordSmsRegistrationFormAction(
  studioId: string,
  _previous: RecordSmsRegistrationResult | null,
  formData: FormData,
): Promise<RecordSmsRegistrationResult> {
  const progress = { dispatched: false };
  try {
    return await recordSmsRegistrationAction(studioId, formData, progress);
  } catch {
    return progress.dispatched
      ? OUTCOME_UNKNOWN
      : { ok: false, result: "error", error: "The registration could not be recorded. Nothing was saved; try again." };
  }
}

export async function recordSmsRegistrationAction(
  studioId: string,
  formData: FormData,
  progress: { dispatched: boolean } = { dispatched: false },
): Promise<RecordSmsRegistrationResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // EVERY return path is audited, through this one helper, with the studio
  // (Codex P2 4248698146, 4249989482), and with WHAT happened (Codex P2
  // 4253770080): the result code, the sender and the status submitted, and on a
  // write the status it replaced, so approved -> suspended, a validation
  // refusal, sender_changed and an unknown outcome are each distinguishable.
  // Codes and ids only: never the provider reference, a number or free text.
  const facts: Record<string, string | null> = { result: null, sender_id: null, submitted_status: null };
  const audit = (outcome: "blocked" | "failed" | "succeeded", more: Record<string, string | null> = {}) =>
    logAdminAction({
      actorUserId: user?.id ?? null,
      actorEmail: user?.email ?? null,
      action: "sms_registration_recorded",
      targetType: "studio",
      targetId: studioId,
      studioId,
      outcome,
      metadata: { ...facts, ...more },
    });

  if (!user || !isAdmin(user.email)) {
    await audit("blocked", { result: "not_authorized" });
    return { ok: false, error: "Not authorized." };
  }

  // BOUND TO THE SENDER SUPPORT VERIFIED: a submission without it (for
  // example from a page whose state could not be read) is refused here, and
  // the command refuses a sender that has since changed.
  const expectedSenderId = String(formData.get("expected_sender_id") ?? "");
  const submittedStatus = String(formData.get("status") ?? "");
  facts.submitted_status = submittedStatus.slice(0, 32) || null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(expectedSenderId)) {
    await audit("failed", { result: "missing_sender" });
    return { ok: false, result: "missing_sender", error: "Reload the page: the studio's sender could not be confirmed." };
  }
  // BOUND TO THE NUMBER SUPPORT VERIFIED, and its kind is that number's: the
  // form never chooses one (Codex P2 4244484021, 4244484022). The command
  // derives the kind again and refuses a number that has changed.
  const expectedPhone = String(formData.get("expected_phone_number") ?? "");
  facts.sender_id = expectedSenderId;
  if (!registrationKindFor(expectedPhone)) {
    await audit("failed", { result: "unsupported_number" });
    return {
      ok: false,
      result: "unsupported_number",
      error: "Reload the page: the studio's number is missing or is not a Canadian, US or toll-free number.",
    };
  }
  const status = String(formData.get("status") ?? "");
  // The record the form showed (its updated_at, passed back as the database's
  // own string so no precision is lost), or none. The command refuses a write
  // whose record has changed since (Codex P2 4266275222).
  const expectedUpdatedAt = String(formData.get("expected_updated_at") ?? "").trim();
  if (expectedUpdatedAt.length > 0 && (expectedUpdatedAt.length > 40 || Number.isNaN(Date.parse(expectedUpdatedAt)))) {
    await audit("failed", { result: "invalid_input" });
    return { ok: false, result: "invalid_input", error: "Reload the page: the record it showed could not be confirmed." };
  }
  const missing = String(formData.get("missing_information") ?? "").trim();
  const reference = String(formData.get("provider_reference") ?? "").trim();
  if (!REGISTRATION_STATUS_VALUES.has(status)) {
    await audit("failed", { result: "invalid_input" });
    return { ok: false, result: "invalid_input", error: "Choose a registration status." };
  }

  const admin = createAdminClient();
  // From here the command may have run, whatever happens next.
  progress.dispatched = true;
  let data: unknown;
  let error: unknown;
  try {
    ({ data, error } = await admin.rpc("record_studio_sms_sender_registration", {
      p_studio_id: studioId,
      p_expected_sender_id: expectedSenderId,
      p_expected_phone: expectedPhone,
      p_status: status,
      p_missing: status === "requires_information" ? missing : null,
      p_provider_reference: reference.length > 0 ? reference : null,
      p_expected_updated_at: expectedUpdatedAt.length > 0 ? expectedUpdatedAt : null,
    }));
  } catch {
    // Never "succeeded" for an outcome nobody saw.
    await audit("failed", { result: "outcome_unknown" });
    return OUTCOME_UNKNOWN;
  }
  const row = (Array.isArray(data) ? data[0] : null) as
    | { result?: string; kind?: string | null; previous_status?: string | null }
    | null;
  // No readable answer is not a refusal: the write may have committed.
  const result = error || !row?.result ? "outcome_unknown" : row.result;
  await audit(result === "recorded" ? "succeeded" : "failed", {
    result,
    registration_kind: row?.kind ?? null,
    previous_status: result === "recorded" ? (row?.previous_status ?? "none") : null,
  });
  try {
    revalidatePath(`/admin/studios/${studioId}`);
  } catch {
    // A stale page is reloaded by the operator; it never changes the answer.
  }
  if (result === "recorded") return { ok: true, result };
  if (result === "outcome_unknown") return OUTCOME_UNKNOWN;
  const message: Record<string, string> = {
    invalid_input: "Check the fields: a reason is required exactly when information is missing, and the reference must be a plain identifier.",
    no_live_sender: "This studio has no live SMS sender to record registration against.",
    ambiguous_live_sender: "This studio has more than one live sender. Nothing was recorded.",
    sender_changed: "The studio's number changed after this page loaded. Nothing was recorded; reload and verify the current number.",
    sender_has_no_number: "The studio's sender has no number yet, so there is nothing to record registration against.",
    stale_record: "This registration was changed after this page loaded. Nothing was recorded; reload to see the current record, then decide again.",
  };
  return { ok: false, result, error: message[result] ?? OUTCOME_UNKNOWN.error };
}
