"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import type { BirthdayReminderColor } from "@/lib/types/database";

function nullableString(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

// Migration 0040: closed preset list for the birthday reminder accent.
// Validated server-side; an unknown/absent value falls back to 'purple'
// (the column default), never an arbitrary string.
const BIRTHDAY_COLOR_VALUES: ReadonlyArray<BirthdayReminderColor> = [
  "purple",
  "orange",
  "blue",
  "green",
  "neutral",
];
function parseBirthdayColor(
  value: FormDataEntryValue | null,
): BirthdayReminderColor {
  const t = typeof value === "string" ? value.trim() : "";
  return (BIRTHDAY_COLOR_VALUES as ReadonlyArray<string>).includes(t)
    ? (t as BirthdayReminderColor)
    : "purple";
}

export async function updateStudioAction(formData: FormData): Promise<void> {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (practitioner.role !== "owner") {
    throw new Error("Only studio owners can change studio settings.");
  }

  const name = nullableString(formData.get("name"));
  if (!name) {
    throw new Error("Studio name is required.");
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("studios")
    .update({
      name,
      legal_entity_name: nullableString(formData.get("legal_entity_name")),
      birthday_reminder_color: parseBirthdayColor(
        formData.get("birthday_reminder_color"),
      ),
    })
    .eq("id", studio.id);

  if (error) {
    throw new Error(`Failed to update studio: ${error.message}`);
  }

  revalidatePath("/dashboard");
  revalidatePath("/settings/studio");
  revalidatePath("/settings/team");
}

export type EmailSettingsResult = { ok: true } | { ok: false; error: string };

function readBool(formData: FormData, key: string): boolean {
  return formData.get(key) === "true";
}

export async function setStudioEmailSettingsAction(
  formData: FormData,
): Promise<EmailSettingsResult> {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (practitioner.role !== "owner") {
    return {
      ok: false,
      error: "Only studio owners can change email settings.",
    };
  }

  // P0 (Blocker 1): the two no-show toggles are server-side force-off
  // for the entire duration of the pre-Stripe hardening pass. A
  // disabled checkbox in the UI is not a security boundary; a crafted
  // server-action POST must not be able to re-enable the unsafe
  // automatic no-show workflow. We literally ignore the submitted
  // form values for these two fields and ALWAYS write `false`. The
  // EmailSettingsForm.tsx UI is wired to match (force-OFF display).
  //
  // This branch removes the toggle's submit pathway entirely. The
  // toggles can be re-enabled in a subsequent migration / branch
  // only after the safe lifecycle redesign (ends_at + grace,
  // claim-token, duplicate-send protection) ships and is approved.
  const supabase = await createClient();
  const { error } = await supabase
    .from("studios")
    .update({
      send_confirmation_emails: readBool(formData, "send_confirmation_emails"),
      send_24h_reminders: readBool(formData, "send_24h_reminders"),
      send_2h_reminders: readBool(formData, "send_2h_reminders"),
      auto_mark_no_shows: false,                  // FORCE-OFF (Blocker 1)
      send_no_show_followup: false,               // FORCE-OFF (Blocker 1)
      show_treatment_time_to_clients: readBool(
        formData,
        "show_treatment_time_to_clients",
      ),
    })
    .eq("id", studio.id);
  if (error) {
    console.error(
      JSON.stringify({
        event: "studio_email_settings_update_failed",
        code: error.code,
        message: error.message,
        studioId: studio.id,
        timestamp: new Date().toISOString(),
      }),
    );
    return { ok: false, error: "Could not save settings. Please try again." };
  }

  revalidatePath("/settings/studio");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// updateStudioPostcareAction
// ---------------------------------------------------------------------------
// Saves per-studio postcare email content. Owner-only. All four fields
// are nullable; blank input persists as NULL. Validates only that
// review_url is a sane http(s) URL when set; the body text fields are
// passed through verbatim (Hone never invents medical advice).
//
// Does NOT enable any auto-send behavior. The "Send postcare" button
// on the appointment page is the only send trigger. See
// app/(app)/calendar/actions.ts sendPostcareEmailAction.

const POSTCARE_REVIEW_URL_RE = /^https?:\/\/[^\s]+$/;

export async function updateStudioPostcareAction(
  formData: FormData,
): Promise<void> {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (practitioner.role !== "owner") {
    throw new Error("Only studio owners can change postcare settings.");
  }

  const aftercare = nullableString(formData.get("postcare_aftercare_text"));
  const warnings = nullableString(
    formData.get("postcare_warning_signs_text"),
  );
  const products = nullableString(
    formData.get("postcare_product_recommendations_text"),
  );
  const reviewUrl = nullableString(formData.get("postcare_review_url"));
  if (reviewUrl && !POSTCARE_REVIEW_URL_RE.test(reviewUrl)) {
    throw new Error("Review link must be a full https:// URL.");
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("studios")
    .update({
      postcare_aftercare_text: aftercare,
      postcare_warning_signs_text: warnings,
      postcare_product_recommendations_text: products,
      postcare_review_url: reviewUrl,
    })
    .eq("id", studio.id);
  if (error) {
    throw new Error(`Failed to update postcare settings: ${error.message}`);
  }

  revalidatePath("/settings/studio");
}

// ---------------------------------------------------------------------------
// updateStudioPolicyAction (C2a-core)
// ---------------------------------------------------------------------------
// Saves the studio's cancellation / no-show policy text. Owner-only.
// Both text fields are nullable; blank input persists as NULL.
//
// Version bookkeeping: policy_version + policy_updated_at are bumped
// ONLY when the saved text actually differs from what's currently on
// the row. A no-op save (e.g. owner clicks Save without editing) does
// not advance the version, which keeps version stable as the future
// `payment_consents.policy_version` reference.
//
// Does NOT:
//   - enable card-on-file or write to require_card_on_file
//   - touch studio_payment_settings
//   - write payment_consents rows (no consent collection exists yet)
//   - change booking, appointment, or session behavior
//   - send any email
// ---------------------------------------------------------------------------
export async function updateStudioPolicyAction(
  formData: FormData,
): Promise<void> {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (practitioner.role !== "owner") {
    throw new Error("Only studio owners can change studio policies.");
  }

  const cancellation = nullableString(
    formData.get("cancellation_policy_text"),
  );
  const noShow = nullableString(formData.get("no_show_policy_text"));

  const supabase = await createClient();

  // Read the current values to decide whether to bump policy_version.
  // Same-text saves leave version + timestamp untouched.
  const { data: current, error: readErr } = await supabase
    .from("studios")
    .select("cancellation_policy_text, no_show_policy_text, policy_version, policy_updated_at")
    .eq("id", studio.id)
    .maybeSingle();
  if (readErr || !current) {
    throw new Error(
      `Could not load studio for policy update: ${readErr?.message ?? "not found"}`,
    );
  }

  const changed =
    (current.cancellation_policy_text ?? null) !== (cancellation ?? null) ||
    (current.no_show_policy_text ?? null) !== (noShow ?? null);

  const nowIso = new Date().toISOString();
  const updates: Record<string, string | null> = {
    cancellation_policy_text: cancellation,
    no_show_policy_text: noShow,
  };
  if (changed) {
    updates.policy_version = nowIso;
    updates.policy_updated_at = nowIso;
  }

  const { error } = await supabase
    .from("studios")
    .update(updates)
    .eq("id", studio.id);
  if (error) {
    throw new Error(`Failed to update studio policy: ${error.message}`);
  }

  revalidatePath("/settings/intake");
  revalidatePath("/settings/payments");
}
