"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { limitPractitionerClientEmail } from "@/lib/rate-limit/public";
import {
  createIntakeRequestForClient,
  generateIntakeLinkUrl,
  stampIntakeLinkIssued,
} from "@/lib/intake/queries";
import { sendIntakeUpdateRequestToClient } from "@/lib/email/send-appointment";
import { getRequiredAppOrigin } from "@/lib/app-origin";

export type ReviewResult = { ok: true } | { ok: false; error: string };

// ---------------------------------------------------------------------------
// F-CLIN-004 — intake review integrity (APPLICATION PATH).
//
// The previous implementation filtered the review UPDATE by intake id +
// studio_id + deleted_at only. It did NOT require the submitted client_id,
// did NOT require status='submitted', did NOT require submitted_at, and did
// NOT select the affected row — so a zero-row UPDATE reported success and a
// forged client_id could drive a same-studio cross-client review. It also
// returned the raw PostgREST error.message.
//
// Both actions below are now written so that ONE conditional UPDATE is the
// single authority. Every safety predicate lives in the statement itself, the
// mutated values are all server-derived, and `.select()` proves exactly one
// row transitioned. A pre-read is never used in place of the update.
//
// SCOPE NOTE (deliberate, load-bearing): this closes the ordinary application
// and UI exploit only. F-CLIN-004 REMAINS OPEN at the database boundary — an
// authenticated direct PostgREST PATCH can still drive in_progress → reviewed,
// because migration 0118's review guards are nested under
// `if old.status in ('submitted','reviewed')` and therefore never run when the
// OLD row is still in_progress. Closing that requires migration 0162, which now
// EXISTS and is tested but is NOT YET APPLIED to production (hosted migration
// max is still 0161), so this remains true of production until it is applied.
// See docs/03_SECURITY_AND_PRIVACY.md and known-limitations L22.
// ---------------------------------------------------------------------------

// Single generic failure for EVERY non-success outcome of the review update.
// It deliberately does not disclose whether the intake exists, belongs to
// another client, belongs to another studio, was deleted, is already
// reviewed, or is still in progress — all six collapse to one string.
const REVIEW_NOT_PERMITTED =
  "This intake can only be reviewed after this client submits it. Refresh and check the current intake status.";

// Curated copy for an actual database/transport failure. Distinct from the
// predicate miss above so the practitioner knows retrying is reasonable, but
// still carries no provider text.
const REVIEW_DB_FAILURE =
  "Could not mark this intake reviewed. Please try again.";

const NOTES_NOT_PERMITTED =
  "Could not save these notes. Refresh and check the current intake status.";

const NOTES_DB_FAILURE = "Could not save these notes. Please try again.";

// Structured, PII-free log for a sanitized failure. Never logs responses,
// practitioner notes, client identity, or the raw row — only the event, the
// action, and the provider error code/message for operator triage. The
// message is logged server-side ONLY; it is never returned to the browser.
function logIntakeActionFailure(
  event: string,
  detail: { code?: string; message?: string },
): void {
  console.error(
    JSON.stringify({
      event,
      code: detail.code ?? null,
      message: detail.message ?? null,
      timestamp: new Date().toISOString(),
    }),
  );
}

// Normalise the practitioner-notes textarea value: blank / whitespace-only
// becomes NULL, anything else is trimmed. Shared by both actions so the two
// surfaces cannot drift.
function normaliseNotes(raw: FormDataEntryValue | null): string | null {
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

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

  const notes = normaliseNotes(notesRaw);

  // Authority for studio + actor is the authenticated session, never the
  // browser payload. `clientId` below is ONLY an extra constraint tying the
  // intake to the route the practitioner is looking at; it grants nothing.
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (!practitioner.active) {
    return { ok: false, error: "Inactive practitioners cannot review intakes." };
  }

  const supabase = await createClient();

  // THE single authority. Every predicate is in the statement:
  //   id           — the intake being reviewed
  //   studio_id    — server-derived tenancy (RLS also applies)
  //   client_id    — must be the client whose route this is
  //   deleted_at   — soft-deleted rows are not reviewable
  //   status       — must still be 'submitted' (this is ALSO the race
  //                  boundary: under READ COMMITTED the second of two
  //                  concurrent updates re-evaluates this predicate against
  //                  the winner's committed row, sees 'reviewed', and
  //                  matches zero rows)
  //   submitted_at — a submitted row must carry its submission timestamp
  //
  // status / reviewed_at / reviewed_by are all server-derived. Nothing the
  // browser sent can reach them.
  const { data, error } = await supabase
    .from("client_intake_forms")
    .update({
      status: "reviewed",
      reviewed_at: new Date().toISOString(),
      reviewed_by: practitioner.id,
      practitioner_notes: notes,
    })
    .eq("id", intakeId)
    .eq("studio_id", studio.id)
    .eq("client_id", clientId)
    .is("deleted_at", null)
    .eq("status", "submitted")
    .not("submitted_at", "is", null)
    .select("id, client_id");

  if (error) {
    logIntakeActionFailure("intake_review_update_failed", {
      code: (error as { code?: string }).code,
      message: error.message,
    });
    return { ok: false, error: REVIEW_DB_FAILURE };
  }

  const rows = data ?? [];
  // Zero rows means the update matched nothing — it is NOT success. More than
  // one row would mean the predicate set failed to identify a single record,
  // which must never happen on a primary key; treat it as a failure too rather
  // than reporting a partial success.
  if (rows.length !== 1) {
    if (rows.length > 1) {
      logIntakeActionFailure("intake_review_multi_row", {
        message: `expected 1 affected row, got ${rows.length}`,
      });
    }
    return { ok: false, error: REVIEW_NOT_PERMITTED };
  }

  // Revalidate using the client_id the DATABASE returned, not the raw form
  // value. The returned row is proof of what actually transitioned, so a
  // forged client route can never be revalidated off the back of a failed or
  // mismatched update.
  const reviewedClientId = rows[0].client_id;
  if (reviewedClientId !== clientId) {
    // Unreachable while the .eq("client_id", ...) predicate is present; kept
    // as a defensive invariant so a future edit that drops it fails closed
    // instead of silently revalidating a foreign route.
    logIntakeActionFailure("intake_review_client_mismatch", {
      message: "affected row client_id did not match the constrained route",
    });
    return { ok: false, error: REVIEW_NOT_PERMITTED };
  }

  revalidatePath(`/clients/${reviewedClientId}`);
  revalidatePath(`/clients/${reviewedClientId}/intake`);
  return { ok: true };
}

// Practitioner notes stay editable in EVERY status (in_progress, submitted,
// reviewed) — that is existing, intended product behaviour and is unchanged.
// What changes is the guard set: the update now also requires the submitted
// client_id and proves exactly one row was affected, and it returns curated
// copy instead of the raw provider error. It writes practitioner_notes and
// nothing else, so responses / status / submitted_at / reviewed_at /
// reviewed_by cannot be touched through this path.
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

  const notes = normaliseNotes(notesRaw);

  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (!practitioner.active) {
    return { ok: false, error: "Inactive practitioners cannot edit intakes." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("client_intake_forms")
    .update({ practitioner_notes: notes })
    .eq("id", intakeId)
    .eq("studio_id", studio.id)
    .eq("client_id", clientId)
    .is("deleted_at", null)
    .select("id, client_id");

  if (error) {
    logIntakeActionFailure("intake_notes_update_failed", {
      code: (error as { code?: string }).code,
      message: error.message,
    });
    return { ok: false, error: NOTES_DB_FAILURE };
  }

  const rows = data ?? [];
  if (rows.length !== 1) {
    if (rows.length > 1) {
      logIntakeActionFailure("intake_notes_multi_row", {
        message: `expected 1 affected row, got ${rows.length}`,
      });
    }
    return { ok: false, error: NOTES_NOT_PERMITTED };
  }

  const notedClientId = rows[0].client_id;
  if (notedClientId !== clientId) {
    logIntakeActionFailure("intake_notes_client_mismatch", {
      message: "affected row client_id did not match the constrained route",
    });
    return { ok: false, error: NOTES_NOT_PERMITTED };
  }

  revalidatePath(`/clients/${notedClientId}/intake`);
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
  if (sendEmail) {
    const reqRl = await limitPractitionerClientEmail({
      action: "intake_request",
      practitionerId: auth.practitionerId,
      clientId,
    });
    if (!reqRl.allowed) {
      return {
        ok: false,
        error: "Too many intake requests sent to this client recently. Please try again later.",
      };
    }
  }

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
  const resendRl = await limitPractitionerClientEmail({
    action: "intake_resend",
    practitionerId: auth.practitionerId,
    clientId,
  });
  if (!resendRl.allowed) {
    return {
      ok: false,
      error: "Too many intake emails sent to this client recently. Please try again later.",
    };
  }
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
