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
import {
  findInvalidChoiceAnswers,
  PRACTITIONER_ENTERABLE_STEPS,
  TOTAL_STEPS,
} from "@/lib/intake/questions";
import {
  assistedKeysChanged,
  sanitizePractitionerAssistedAnswers,
} from "@/lib/intake/responses";
import {
  PRACTITIONER_ASSISTED_ENTRY,
  recordAssistedEntry,
  recordAssistedHandoff,
} from "@/lib/intake/entry-provenance";

export type ReviewResult = { ok: true } | { ok: false; error: string };

// ---------------------------------------------------------------------------
// F-CLIN-004, intake review integrity (APPLICATION PATH).
//
// The previous implementation filtered the review UPDATE by intake id +
// studio_id + deleted_at only. It did NOT require the submitted client_id,
// did NOT require status='submitted', did NOT require submitted_at, and did
// NOT select the affected row, so a zero-row UPDATE reported success and a
// forged client_id could drive a same-studio cross-client review. It also
// returned the raw PostgREST error.message.
//
// Both actions below are now written so that ONE conditional UPDATE is the
// single authority. Every safety predicate lives in the statement itself, the
// mutated values are all server-derived, and `.select()` proves exactly one
// row transitioned. A pre-read is never used in place of the update.
//
// SCOPE NOTE (deliberate, load-bearing): this closes the ordinary application
// and UI exploit only. F-CLIN-004 REMAINS OPEN at the database boundary: an
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
// reviewed, or is still in progress: all six collapse to one string.
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

// FOCUSED PRIVACY FIX (see PR body). The reissue/link helpers below used to
// return the raw PostgREST `error.message` to the browser: the exact pattern
// the review path at the top of this file already collapses. Provider text can
// name columns, constraints and policies, so these constants replace it and
// the real code/message is logged server-side only via
// logIntakeActionFailure. Deliberately scoped to this file; the broader
// audit-wide sweep stays a separate follow-up.
const CLIENT_NOT_AVAILABLE = "Client not found.";
const INTAKE_NOT_AVAILABLE = "Intake not found.";
const STUDIO_NOT_AVAILABLE = "Could not load this studio. Please try again.";

// ---------------------------------------------------------------------------
// Practitioner-assisted intake entry
// ---------------------------------------------------------------------------

// One collapsed refusal for every non-success outcome of an assisted write.
// Like REVIEW_NOT_PERMITTED above it does not disclose whether the intake
// exists, belongs to another client or studio, was deleted, or has already
// been submitted: they all read the same.
const ASSISTED_NOT_PERMITTED =
  "This intake can no longer be completed with the client. Refresh and check the current intake status.";

const ASSISTED_DB_FAILURE = "Could not save these answers. Please try again.";

// Optimistic-concurrency miss. Distinct from the above because it IS
// actionable: someone (most likely the client, through their own link) saved
// between this editor loading and this save landing.
const ASSISTED_STALE =
  "This intake changed while you were recording answers. Refresh to load the latest before continuing.";

// The client-owned boundary, refused loudly rather than silently stripped so a
// UI bug or a crafted request surfaces instead of half-succeeding.
const ASSISTED_CLIENT_OWNED =
  "The final confirmations are completed by the client themselves. Use Hand to client to finish this intake.";

// A single-choice answer that is not one of the offered options. The editor
// cannot produce this (it renders the option list) so reaching it means a
// crafted request or a genuine bug, and either way the value must not land in a
// clinical record. Refused rather than silently dropped, for the same reason
// the client-owned boundary above is.
const ASSISTED_INVALID_CHOICE =
  "One of the answers is not one of the available options. Refresh and record that answer again.";

// Structured, PII-free log for a sanitized failure. Never logs responses,
// practitioner notes, client identity, or the raw row, only the event, the
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
  //   id          : the intake being reviewed
  //   studio_id   , server-derived tenancy (RLS also applies)
  //   client_id   , must be the client whose route this is
  //   deleted_at  , soft-deleted rows are not reviewable
  //   status      : must still be 'submitted' (this is ALSO the race
  //                  boundary: under READ COMMITTED the second of two
  //                  concurrent updates re-evaluates this predicate against
  //                  the winner's committed row, sees 'reviewed', and
  //                  matches zero rows)
  //   submitted_at, a submitted row must carry its submission timestamp
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
  // Zero rows means the update matched nothing. It is NOT success. More than
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
// reviewed), that is existing, intended product behaviour and is unchanged.
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
      // Display name resolved from the SESSION's practitioner row at call
      // time. Snapshotted into assisted-entry provenance so historical
      // attribution survives a later deactivation or rename.
      practitionerName: string;
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
  if (clientErr) {
    // Never return provider text to the browser. A lookup failure and a
    // cross-studio / absent client collapse to ONE message so the response
    // cannot be used to probe which clients exist in other studios.
    logIntakeActionFailure("intake_client_lookup_failed", {
      code: (clientErr as { code?: string }).code,
      message: clientErr.message,
    });
    return { ok: false, error: CLIENT_NOT_AVAILABLE };
  }
  if (!client) return { ok: false, error: CLIENT_NOT_AVAILABLE };
  return {
    ok: true,
    studioId: studio.id,
    practitionerId: practitioner.id,
    practitionerName: practitioner.display_name?.trim()
      ? practitioner.display_name.trim()
      : practitioner.email,
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
  if (error) {
    logIntakeActionFailure("intake_studio_lookup_failed", {
      code: (error as { code?: string }).code,
      message: error.message,
    });
    return { ok: false, error: STUDIO_NOT_AVAILABLE };
  }
  if (!data) return { ok: false, error: STUDIO_NOT_AVAILABLE };
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
  if (intakeErr) {
    logIntakeActionFailure("intake_link_lookup_failed", {
      code: (intakeErr as { code?: string }).code,
      message: intakeErr.message,
    });
    return { ok: false, error: INTAKE_NOT_AVAILABLE };
  }
  if (!intake) return { ok: false, error: INTAKE_NOT_AVAILABLE };
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
  if (intakeErr) {
    logIntakeActionFailure("intake_link_lookup_failed", {
      code: (intakeErr as { code?: string }).code,
      message: intakeErr.message,
    });
    return { ok: false, error: INTAKE_NOT_AVAILABLE };
  }
  if (!intake) return { ok: false, error: INTAKE_NOT_AVAILABLE };
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

// ---------------------------------------------------------------------------
// PRACTITIONER-ASSISTED INTAKE ENTRY
// ---------------------------------------------------------------------------
//
// "Complete intake with client": the practitioner asks the questionnaire aloud
// and records what the client says, while the client is with them.
//
// THE BOUNDARY THIS CODE EXISTS TO HOLD
// -------------------------------------
// The practitioner may record the health questionnaire. The final step is the
// client's own first-person acknowledgements and is theirs alone. Three
// independent things enforce that, and none of them is the UI:
//
//   1. sanitizePractitionerAssistedAnswers() drops every client-owned key,
//      derived from INTAKE_STEPS (acknowledgements step + every checkbox
//      question anywhere), so a new acknowledgement added later is forbidden
//      automatically;
//   2. assistedKeysRejected() refuses the whole request when one is present,
//      so a bug surfaces instead of half-succeeding;
//   3. migration 0162's trigger raises `check_violation` on ANY authenticated
//      status -> 'submitted' transition. That is why these actions use
//      createClient() and NOT createAdminClient(): the service role is exempt
//      from that rule, so reaching for it would hand this code the ability to
//      submit on the client's behalf. It must never have it.
//
// WHAT THIS DOES NOT PROVE
// ------------------------
// Nothing here proves which physical human touched the device. The intake
// link is a bearer token. What is proven is that the AUTHENTICATED assisted
// editor could not author the acknowledgements, and that the public token path
// cannot author the provenance. See lib/intake/entry-provenance.ts.

export type AssistedSaveResult =
  | { ok: true; updatedAt: string }
  | { ok: false; error: string };

export type AssistedHandoffResult =
  | { ok: true; intakeUrl: string }
  | { ok: false; error: string };

// Shared authorization + row resolution for both assisted actions.
//
// Order is deliberate and is the whole security argument:
//   1-3. session -> practitioner -> active            (loadAuthorisedClient)
//   4.   client belongs to the caller's studio        (loadAuthorisedClient)
//   5-9. the intake exists, is in THIS studio, is THIS client's, is not
//        soft-deleted, and is still in_progress
//
// Every predicate is re-applied in the UPDATE itself; this read is for the
// merge base and the concurrency token, never a substitute for them.
async function loadAssistedIntake(
  intakeId: string,
  clientId: string,
): Promise<
  | {
      ok: true;
      studioId: string;
      actor: { practitioner_id: string; display_name: string };
      responses: Record<string, unknown>;
      updatedAt: string;
    }
  | { ok: false; error: string }
> {
  const auth = await loadAuthorisedClient(clientId);
  if (!auth.ok) return { ok: false, error: ASSISTED_NOT_PERMITTED };

  const supabase = await createClient();
  const { data: intake, error: intakeErr } = await supabase
    .from("client_intake_forms")
    .select("id, status, responses, updated_at")
    .eq("id", intakeId)
    .eq("studio_id", auth.studioId)
    .eq("client_id", auth.client.id)
    .is("deleted_at", null)
    .eq("status", "in_progress")
    .maybeSingle();
  if (intakeErr) {
    logIntakeActionFailure("assisted_intake_lookup_failed", {
      code: (intakeErr as { code?: string }).code,
      message: intakeErr.message,
    });
    return { ok: false, error: ASSISTED_DB_FAILURE };
  }
  // Absent / other studio / other client / deleted / already submitted all
  // collapse here into one message. No existence oracle.
  if (!intake) return { ok: false, error: ASSISTED_NOT_PERMITTED };

  return {
    ok: true,
    studioId: auth.studioId,
    actor: {
      practitioner_id: auth.practitionerId,
      display_name: auth.practitionerName,
    },
    responses: (intake.responses as Record<string, unknown>) ?? {},
    updatedAt: intake.updated_at as string,
  };
}

// Record the client's answers to one questionnaire step.
//
// `expectedUpdatedAt` is an optimistic-concurrency token, not identity: it is
// the `updated_at` this editor last saw. Because the UPDATE assigns the whole
// `responses` jsonb, a concurrent save (most plausibly the client through
// their own still-live link) would otherwise be silently clobbered by whoever
// wrote last. With the predicate in place the loser is REFUSED and told to
// refresh instead.
export async function saveAssistedIntakeStepAction(payload: {
  intakeId: string;
  clientId: string;
  step: number;
  responses: Record<string, unknown>;
  expectedUpdatedAt: string;
}): Promise<AssistedSaveResult> {
  const { intakeId, clientId, expectedUpdatedAt } = payload;
  if (typeof intakeId !== "string" || !intakeId) {
    return { ok: false, error: ASSISTED_NOT_PERMITTED };
  }
  if (typeof clientId !== "string" || !clientId) {
    return { ok: false, error: ASSISTED_NOT_PERMITTED };
  }
  if (typeof expectedUpdatedAt !== "string" || !expectedUpdatedAt) {
    return { ok: false, error: ASSISTED_STALE };
  }

  // The step must be one a practitioner may fill in. The acknowledgements
  // step is not in this set, so it cannot even be addressed here.
  const step = Math.floor(Number(payload.step));
  const enterable = PRACTITIONER_ENTERABLE_STEPS.some((s) => s.id === step);
  if (!enterable) return { ok: false, error: ASSISTED_CLIENT_OWNED };

  const answers = sanitizePractitionerAssistedAnswers(payload.responses);

  const loaded = await loadAssistedIntake(intakeId, clientId);
  if (!loaded.ok) return loaded;

  // Refuse loudly if the payload would CHANGE a client-owned answer.
  //
  // Compared against what is stored, not merely detected by key presence: the
  // editor seeds its state from the stored responses and posts the whole map,
  // so an intake where the client had already touched a step-5 checkbox
  // through their own link would otherwise make every assisted save fail. The
  // boundary is unchanged in strength: a practitioner still cannot set, alter
  // or clear one, and sanitization drops these keys regardless. This is the
  // loud backstop for a UI bug or a crafted request.
  const forbidden = assistedKeysChanged(payload.responses, loaded.responses);
  if (forbidden.length > 0) {
    logIntakeActionFailure("assisted_client_owned_key_rejected", {
      message: `rejected ${forbidden.length} client-owned key change(s)`,
    });
    return { ok: false, error: ASSISTED_CLIENT_OWNED };
  }

  // Merge existing-first so answers the client already gave through their own
  // link are preserved, and so the electrolysis acknowledgement record and any
  // other client-owned key already present survive untouched: `answers`
  // cannot contain them.
  const merged: Record<string, unknown> = { ...loaded.responses, ...answers };

  // Same choice-value check the client's own submit runs, so the assisted path
  // cannot be the soft way in. Run over the MERGED map for the same reason the
  // submit gate is: what matters is what would be stored, not what was posted.
  //
  // Incompleteness is fine here and must stay fine: an assisted save is a
  // work-in-progress by definition, and findInvalidChoiceAnswers ignores absent
  // answers. Only a value that is present and not on the list is refused.
  const invalidChoices = findInvalidChoiceAnswers(merged);
  if (invalidChoices.length > 0) {
    logIntakeActionFailure("assisted_invalid_choice_rejected", {
      message: `rejected ${invalidChoices.length} out-of-range choice answer(s)`,
    });
    return { ok: false, error: ASSISTED_INVALID_CHOICE };
  }

  // Provenance is derived HERE, on the server, from the session. Nothing in
  // `payload` reaches it. started_at / started_by are preserved from any
  // existing record so a second practitioner continuing the intake never
  // overwrites who began it.
  merged[PRACTITIONER_ASSISTED_ENTRY.id] = recordAssistedEntry(
    loaded.responses[PRACTITIONER_ASSISTED_ENTRY.id],
    loaded.actor,
    new Date().toISOString(),
  );

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("client_intake_forms")
    .update({ responses: merged, current_step: step })
    .eq("id", intakeId)
    .eq("studio_id", loaded.studioId)
    .eq("client_id", clientId)
    .is("deleted_at", null)
    .eq("status", "in_progress")
    .eq("updated_at", expectedUpdatedAt)
    .select("id, client_id, updated_at");

  if (error) {
    logIntakeActionFailure("assisted_intake_save_failed", {
      code: (error as { code?: string }).code,
      message: error.message,
    });
    return { ok: false, error: ASSISTED_DB_FAILURE };
  }

  const rows = data ?? [];
  if (rows.length !== 1) {
    if (rows.length > 1) {
      logIntakeActionFailure("assisted_intake_multi_row", {
        message: `expected 1 affected row, got ${rows.length}`,
      });
      return { ok: false, error: ASSISTED_NOT_PERMITTED };
    }
    // Zero rows: the row moved under us. The concurrency token is the most
    // likely predicate to have missed, and it is the only one the
    // practitioner can act on.
    return { ok: false, error: ASSISTED_STALE };
  }
  if (rows[0].client_id !== clientId) {
    // Unreachable while the .eq("client_id", ...) predicate is present; kept
    // so a future edit that drops it fails closed rather than silently
    // writing to a foreign route.
    logIntakeActionFailure("assisted_intake_client_mismatch", {
      message: "affected row client_id did not match the constrained route",
    });
    return { ok: false, error: ASSISTED_NOT_PERMITTED };
  }

  revalidatePath(`/clients/${clientId}/intake`);
  return { ok: true, updatedAt: rows[0].updated_at as string };
}

// Hand the intake back to the client for their own acknowledgements.
//
// Stamps handoff_at / handoff_by into the provenance record (when assisted
// entry actually happened), advances current_step so the client's wizard opens
// on the acknowledgements step, and returns a freshly minted tokenized URL.
//
// This action does NOT submit, does NOT stamp submitted_at, and does NOT touch
// any acknowledgement key. The client's own submission through the existing
// public route remains the only path to `submitted`.
export async function handOffAssistedIntakeAction(
  formData: FormData,
): Promise<AssistedHandoffResult> {
  const intakeId = formData.get("intake_id");
  const clientId = formData.get("client_id");
  if (typeof intakeId !== "string" || !intakeId) {
    return { ok: false, error: ASSISTED_NOT_PERMITTED };
  }
  if (typeof clientId !== "string" || !clientId) {
    return { ok: false, error: ASSISTED_NOT_PERMITTED };
  }

  const loaded = await loadAssistedIntake(intakeId, clientId);
  if (!loaded.ok) return { ok: false, error: loaded.error };

  const patch: Record<string, unknown> = { current_step: TOTAL_STEPS };

  // Only stamp a handover onto an intake that actually carries assisted
  // provenance. A practitioner who opened the editor and recorded nothing has
  // not performed assisted entry, and inventing a record for them would be a
  // small lie.
  const stamped = recordAssistedHandoff(
    loaded.responses[PRACTITIONER_ASSISTED_ENTRY.id],
    loaded.actor,
    new Date().toISOString(),
  );
  if (stamped) {
    patch.responses = {
      ...loaded.responses,
      [PRACTITIONER_ASSISTED_ENTRY.id]: stamped,
    };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("client_intake_forms")
    .update(patch)
    .eq("id", intakeId)
    .eq("studio_id", loaded.studioId)
    .eq("client_id", clientId)
    .is("deleted_at", null)
    .eq("status", "in_progress")
    // Same concurrency guard as the save. This UPDATE also assigns the whole
    // responses jsonb (when there is provenance to stamp), so without it a
    // client draft-save landing between the read above and this write would be
    // reinstated from a stale snapshot, including re-setting a checkbox the
    // client had just cleared.
    .eq("updated_at", loaded.updatedAt)
    .select("id, client_id");

  if (error) {
    logIntakeActionFailure("assisted_intake_handoff_failed", {
      code: (error as { code?: string }).code,
      message: error.message,
    });
    return { ok: false, error: ASSISTED_DB_FAILURE };
  }
  const rows = data ?? [];
  if (rows.length !== 1 || rows[0].client_id !== clientId) {
    return { ok: false, error: ASSISTED_NOT_PERMITTED };
  }

  // Mint the client's link only AFTER the write succeeded. Same helper the
  // existing "Copy link" path uses; the URL is returned to the practitioner's
  // browser so the device can be handed over, and is never logged.
  const url = generateIntakeLinkUrl(intakeId, getRequiredAppOrigin());
  await stampIntakeLinkIssued(createAdminClient(), intakeId, { emailed: false });

  revalidatePath(`/clients/${clientId}/intake`);
  return { ok: true, intakeUrl: url };
}

// ---------------------------------------------------------------------------
// "Start intake with client", the missing entry point into the assisted
// workflow above.
// ---------------------------------------------------------------------------
//
// THE GAP THIS CLOSES. Practitioner-assisted entry needs an in_progress intake
// row to edit. When a client had none, Health & Forms said "No intake on file"
// and offered nothing, so the only way in was: navigate to the dedicated intake
// page -> Send a new intake form -> untick the email box -> Create new intake
// request -> come back -> Complete intake with client. Six steps, and it
// required knowing that a blank row must exist first.
//
// WHAT THIS ACTION IS, AND IS NOT. It is a resolver: it answers "which
// in_progress intake should this practitioner open with the client in front of
// them?" and creates one only when there is none. It is NOT a second intake
// creation path: creation stays with requestIntakeUpdateAction, which stays
// the single authority for the insert, the token, the link stamping and the
// authorisation around them.
//
// TWO PROPERTIES ARE STRUCTURAL, NOT CONVENTIONS:
//
//   1. NO EMAIL. The client is standing in the room. `send_email` is pinned to
//      "false" here and the caller cannot influence it: this action reads no
//      email flag from its own FormData, so there is no value a browser could
//      send to turn it on.
//
//   2. NO TOKEN REACHES THE BROWSER. The result carries an intakeId and
//      nothing else. requestIntakeUpdateAction's intakeUrl (the client's
//      bearer link) is deliberately discarded rather than returned, so this
//      entry point cannot navigate the practitioner onto the client's own
//      tokenized route even by mistake. The hand-off to that route stays where
//      #525 put it: handOffAssistedIntakeAction, after the practitioner has
//      finished the questionnaire.
export type StartAssistedIntakeResult =
  | { ok: true; intakeId: string }
  | { ok: false; error: string };

// One collapsed refusal for every authorisation miss: inactive practitioner,
// another studio's client, an absent client. Like ASSISTED_NOT_PERMITTED above
// it is not an existence oracle.
const START_NOT_PERMITTED =
  "This client's intake cannot be started from here. Refresh and try again.";

// A genuine lookup/creation failure, kept distinct because retrying IS
// reasonable. Neither constant ever carries provider text.
const START_DB_FAILURE =
  "Could not start an intake for this client. Please try again.";

export async function startAssistedIntakeAction(
  formData: FormData,
): Promise<StartAssistedIntakeResult> {
  const clientId = formData.get("client_id");
  if (typeof clientId !== "string" || !clientId) {
    return { ok: false, error: START_NOT_PERMITTED };
  }

  // Same authority as every other action in this file: session -> active
  // practitioner -> studio, then the client is proven to belong to that studio
  // through the user-scoped client under RLS. Nothing the browser sent is
  // trusted beyond naming which client row to look for.
  const auth = await loadAuthorisedClient(clientId);
  if (!auth.ok) return { ok: false, error: START_NOT_PERMITTED };

  // DUPLICATE SAFETY. An in_progress intake already open for this client IS
  // the one to complete with them, so open it rather than stacking a second
  // blank row behind it. This covers the ordinary races the button can lose,
  // a double click, a stale tab, two practitioners on the same client, and
  // it is also the honest answer to "start intake with client" in that state.
  //
  // It is a mitigation, not a guarantee: two genuinely simultaneous requests
  // can both read zero rows before either inserts. Closing that completely
  // needs a partial unique index, which is a migration, which this change
  // deliberately does not create. See the PR body.
  const supabase = await createClient();
  const { data: existing, error: existingErr } = await supabase
    .from("client_intake_forms")
    .select("id")
    .eq("studio_id", auth.studioId)
    .eq("client_id", auth.client.id)
    .is("deleted_at", null)
    .eq("status", "in_progress")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existingErr) {
    logIntakeActionFailure("start_assisted_intake_lookup_failed", {
      code: (existingErr as { code?: string }).code,
      message: existingErr.message,
    });
    return { ok: false, error: START_DB_FAILURE };
  }
  if (existing) {
    return { ok: true, intakeId: existing.id as string };
  }

  // Creation is delegated, never re-implemented. requestIntakeUpdateAction
  // re-derives the studio and practitioner from the session itself, so this is
  // a genuine second authorisation rather than a trusted hand-off, and it owns
  // the insert, the token, the expiry and the link stamping.
  const fd = new FormData();
  fd.set("client_id", auth.client.id);
  fd.set("send_email", "false");
  const created = await requestIntakeUpdateAction(fd);
  if (!created.ok) {
    logIntakeActionFailure("start_assisted_intake_create_failed", {
      message: "delegated intake creation refused",
    });
    return { ok: false, error: START_DB_FAILURE };
  }

  // created.intakeUrl is intentionally dropped here. See the header note.
  return { ok: true, intakeId: created.intakeId };
}
