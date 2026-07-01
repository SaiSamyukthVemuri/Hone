"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import {
  createIntakeRequestForClient,
  generateIntakeLinkUrl,
  stampIntakeLinkIssued,
} from "@/lib/intake/queries";
import { sendIntakeUpdateRequestToClient } from "@/lib/email/send-appointment";
import { getRequiredAppOrigin } from "@/lib/app-origin";

export type ReviewResult = { ok: true } | { ok: false; error: string };

export async function markIntakeReviewedAction(formData: FormData): Promise<ReviewResult> {
  const intakeId = formData.get("intake_id");
  const clientId = formData.get("client_id");
  const notesRaw = formData.get("practitioner_notes");

  if (typeof intakeId !== "string" || !intakeId) {
    return { ok: false, error: "Missing intake id." };
  }
  if (typeof clientId !== "string" || !clientId) {
    return { ok: false, error: "Missing client id." };
  }

  const notes =
    typeof notesRaw === "string" && notesRaw.trim().length > 0
      ? notesRaw.trim()
      : null;

  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (!practitioner.active) {
    return { ok: false, error: "Inactive practitioners cannot review intakes." };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("client_intake_forms")
    .update({
      status: "reviewed",
      reviewed_at: new Date().toISOString(),
      reviewed_by: practitioner.id,
      practitioner_notes: notes,
    })
    .eq("id", intakeId)
    .eq("studio_id", studio.id)
    .is("deleted_at", null);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/clients/${clientId}`);
  revalidatePath(`/clients/${clientId}/intake`);
  return { ok: true };
}

export async function saveIntakeNotesAction(formData: FormData): Promise<ReviewResult> {
  const intakeId = formData.get("intake_id");
  const clientId = formData.get("client_id");
  const notesRaw = formData.get("practitioner_notes");
  if (typeof intakeId !== "string" || !intakeId) {
    return { ok: false, error: "Missing intake id." };
  }
  if (typeof clientId !== "string" || !clientId) {
    return { ok: false, error: "Missing client id." };
  }

  const notes =
    typeof notesRaw === "string" && notesRaw.trim().length > 0
      ? notesRaw.trim()
      : null;

  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (!practitioner.active) {
    return { ok: false, error: "Inactive practitioners cannot edit intakes." };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("client_intake_forms")
    .update({ practitioner_notes: notes })
    .eq("id", intakeId)
    .eq("studio_id", studio.id)
    .is("deleted_at", null);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/clients/${clientId}/intake`);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Practitioner-triggered intake reissue. Three actions, all returning the
// fresh tokenized intake URL so the calling UI can display it for "Copy
// link" without a second round-trip.
//
// Authorisation pattern is consistent across all three:
//   1. getCurrentPractitionerWithStudio() establishes the caller's studio.
//   2. The target client is loaded via the user-scoped Supabase client
//      and filtered by studio_id, so RLS enforces studio membership.
//   3. ONLY after that ownership check do we use the admin client to
//      insert/update the intake row. The intake row write itself is
//      always scoped by studio_id + client_id we just verified.
//
// None of the three actions mutate prior submitted/reviewed intake
// rows. They do not delete anything. They do not change appointment
// status, do not touch Stripe primitives, and do not flip
// require_card_on_file.
// ---------------------------------------------------------------------------

export type IntakeReissueResult =
  | { ok: true; intakeId: string; intakeUrl: string; emailSent: boolean }
  | { ok: false; error: string };

// Loads the client and verifies it belongs to the practitioner's
// studio. Returns the client row (with email) or an error result.
async function loadAuthorisedClient(
  clientId: string,
): Promise<
  | {
      ok: true;
      studioId: string;
      practitionerId: string;
      client: { id: string; name: string; email: string | null };
    }
  | { ok: false; error: string }
> {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (!practitioner.active) {
    return { ok: false, error: "Inactive practitioners cannot manage intakes." };
  }
  const supabase = await createClient();
  const { data: client, error: clientErr } = await supabase
    .from("clients")
    .select("id, name, email")
    .eq("studio_id", studio.id)
    .eq("id", clientId)
    .maybeSingle();
  if (clientErr) return { ok: false, error: clientErr.message };
  if (!client) return { ok: false, error: "Client not found." };
  return {
    ok: true,
    studioId: studio.id,
    practitionerId: practitioner.id,
    client: client as { id: string; name: string; email: string | null },
  };
}

// Loads the studio row needed for the reissue email (studio name only).
// The user-scoped client filters by studio.id under RLS.
async function loadStudioForReissue(studioId: string): Promise<
  | { ok: true; studio: { id: string; name: string } }
  | { ok: false; error: string }
> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("studios")
    .select("id, name")
    .eq("id", studioId)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "Studio not found." };
  return { ok: true, studio: data as { id: string; name: string } };
}

// Practitioner clicks "Request intake update". Always creates a NEW
// in_progress intake row for the same client; previously submitted /
// reviewed rows are preserved verbatim. If sendEmail is true and the
// client has an email on file, the link is emailed; the URL is also
// returned for in-UI copy regardless of email status.
export async function requestIntakeUpdateAction(
  formData: FormData,
): Promise<IntakeReissueResult> {
  const clientId = formData.get("client_id");
  const sendEmail = formData.get("send_email") === "true";
  if (typeof clientId !== "string" || !clientId) {
    return { ok: false, error: "Missing client id." };
  }

  const auth = await loadAuthorisedClient(clientId);
  if (!auth.ok) return auth;

  const created = await createIntakeRequestForClient({
    studioId: auth.studioId,
    clientId: auth.client.id,
    requestedBy: auth.practitionerId,
    appOrigin: getRequiredAppOrigin(),
  });
  if (!created) {
    return { ok: false, error: "Could not create the new intake request." };
  }

  let emailSent = false;
  if (sendEmail && auth.client.email) {
    const studioRes = await loadStudioForReissue(auth.studioId);
    if (studioRes.ok) {
      const result = await sendIntakeUpdateRequestToClient({
        clientEmail: auth.client.email,
        studioName: studioRes.studio.name,
        intakeUrl: created.url,
      });
      emailSent = result.ok;
      if (!result.ok) {
        console.error(
          JSON.stringify({
            event: "intake_reissue_email_failed",
            error: result.error,
            retryable: result.retryable,
            timestamp: new Date().toISOString(),
          }),
        );
      }
    }
  }

  // Stamp the freshly created reissue row: last_sent_at only when we actually
  // emailed it (emailSent), always refresh expiry + count.
  await stampIntakeLinkIssued(createAdminClient(), created.id, {
    emailed: emailSent,
  });

  revalidatePath(`/clients/${clientId}`);
  revalidatePath(`/clients/${clientId}/intake`);
  return {
    ok: true,
    intakeId: created.id,
    intakeUrl: created.url,
    emailSent,
  };
}

// Practitioner clicks "Copy link" for an existing in_progress intake
// row in the history list. Returns a fresh tokenized URL without
// touching the row. Token TTL is the same as on every other intake
// link. Refuses for rows that are not in_progress so the practitioner
// can't accidentally hand out a link that the public page will refuse
// to serve responses for.
export async function getIntakeLinkAction(
  formData: FormData,
): Promise<IntakeReissueResult> {
  const intakeId = formData.get("intake_id");
  const clientId = formData.get("client_id");
  if (typeof intakeId !== "string" || !intakeId) {
    return { ok: false, error: "Missing intake id." };
  }
  if (typeof clientId !== "string" || !clientId) {
    return { ok: false, error: "Missing client id." };
  }

  const auth = await loadAuthorisedClient(clientId);
  if (!auth.ok) return auth;

  // RLS-scoped fetch confirms this intake belongs to the practitioner's
  // studio AND the specified client AND is still in_progress.
  const supabase = await createClient();
  const { data: intake, error: intakeErr } = await supabase
    .from("client_intake_forms")
    .select("id, status")
    .eq("id", intakeId)
    .eq("studio_id", auth.studioId)
    .eq("client_id", auth.client.id)
    .is("deleted_at", null)
    .maybeSingle();
  if (intakeErr) return { ok: false, error: intakeErr.message };
  if (!intake) return { ok: false, error: "Intake not found." };
  if (intake.status !== "in_progress") {
    return {
      ok: false,
      error: "Links can only be generated for in-progress intakes.",
    };
  }

  const url = generateIntakeLinkUrl(intake.id, getRequiredAppOrigin());
  // Copy link mints a fresh token (new expiry) but does NOT email it: refresh
  // expiry + count so the status is accurate, but never set last_sent_at.
  await stampIntakeLinkIssued(createAdminClient(), intake.id, {
    emailed: false,
  });
  return {
    ok: true,
    intakeId: intake.id,
    intakeUrl: url,
    emailSent: false,
  };
}

// Practitioner clicks "Resend email" for an existing in_progress
// intake row. Same ownership/status guards as Copy link; mints a
// fresh token and emails it. Returns the URL too so the UI can also
// show it for copy.
export async function resendIntakeEmailAction(
  formData: FormData,
): Promise<IntakeReissueResult> {
  const intakeId = formData.get("intake_id");
  const clientId = formData.get("client_id");
  if (typeof intakeId !== "string" || !intakeId) {
    return { ok: false, error: "Missing intake id." };
  }
  if (typeof clientId !== "string" || !clientId) {
    return { ok: false, error: "Missing client id." };
  }

  const auth = await loadAuthorisedClient(clientId);
  if (!auth.ok) return auth;
  if (!auth.client.email) {
    return {
      ok: false,
      error: "This client has no email on file. Use Copy link instead.",
    };
  }

  const supabase = await createClient();
  const { data: intake, error: intakeErr } = await supabase
    .from("client_intake_forms")
    .select("id, status")
    .eq("id", intakeId)
    .eq("studio_id", auth.studioId)
    .eq("client_id", auth.client.id)
    .is("deleted_at", null)
    .maybeSingle();
  if (intakeErr) return { ok: false, error: intakeErr.message };
  if (!intake) return { ok: false, error: "Intake not found." };
  if (intake.status !== "in_progress") {
    return {
      ok: false,
      error: "This intake is already submitted; nothing to resend.",
    };
  }

  const studioRes = await loadStudioForReissue(auth.studioId);
  if (!studioRes.ok) return studioRes;

  const url = generateIntakeLinkUrl(intake.id, getRequiredAppOrigin());
  const result = await sendIntakeUpdateRequestToClient({
    clientEmail: auth.client.email,
    studioName: studioRes.studio.name,
    intakeUrl: url,
  });
  if (!result.ok) {
    console.error(
      JSON.stringify({
        event: "intake_reissue_email_failed",
        error: result.error,
        retryable: result.retryable,
        timestamp: new Date().toISOString(),
      }),
    );
    return { ok: false, error: "Could not send the email. Please try again." };
  }

  // Emailed successfully: stamp last_sent_at + refresh expiry + count.
  await stampIntakeLinkIssued(createAdminClient(), intake.id, {
    emailed: true,
  });

  return {
    ok: true,
    intakeId: intake.id,
    intakeUrl: url,
    emailSent: true,
  };
}
