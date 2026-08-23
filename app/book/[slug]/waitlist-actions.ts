"use server";

import { headers } from "next/headers";
import { getStudioBySlug } from "@/lib/booking/queries";
import { createAdminClient } from "@/lib/supabase/admin-server";
import {
  isNewClientWaitlistEnabled,
  isNewClientWaitlistDurableEnabled,
  validateWaitlistSubmission,
  NEW_CLIENT_WAITLIST_SUBMIT_FAILED,
  NEW_CLIENT_WAITLIST_SUBMIT_UNCONFIRMED,
  WAITLIST_SLUG_MAX,
  type NewClientWaitlistResult,
  type WaitlistSubmission,
} from "@/lib/booking/new-client-waitlist";
import { limitNewClientBookingWaitlist, RATE_LIMIT_MESSAGE } from "@/lib/rate-limit/public";
import { sendWaitlistEmailIdempotent } from "@/lib/email/new-client-waitlist-send";
import {
  buildNewClientWaitlistClientEmail,
  buildNewClientWaitlistStudioEmail,
} from "@/lib/email/templates/new-client-waitlist";
import { hashFingerprint } from "@/lib/portal/tokens";
import type { Studio } from "@/lib/types/database";

// ===========================================================================
// PUBLIC NEW-CLIENT WAITLIST SUBMIT
// ===========================================================================
//
// WAIT-02 MOVED THE COMMIT POINT. It used to be the studio notification email:
// the provider accepting the message WAS the operational record, because there
// was nowhere durable to put one. Migration 0185 gives it a home, so:
//
//   DATABASE COMMIT  =  JOINED THE WAITLIST
//   EMAIL            =  NOTIFICATION
//
// A notification that is refused, times out, or has no recipient at all CANNOT
// retract a committed row and must never be reported as a failure to join. The
// row is what the studio operates from now; the email is how they hear about
// it sooner.
//
// TWO PATHS, ONE GATE. `isNewClientWaitlistEnabled` remains the single
// admission-control authority and is unchanged. The durable allowlist is
// consulted only AFTER it has already said yes, and decides which commit point
// this studio is on. A studio still on the WAIT-01 path behaves exactly as it
// does in production today, byte for byte, including its fail-closed
// provider-acceptance semantics — that is what makes this deployable while
// Willow is live on the old behaviour.
//
// STILL ZERO BUSINESS DATABASE WRITES. The durable path writes exactly one
// table, `new_client_waitlist_entries`, through one command. No client, no
// appointment, no intake, no session, no notification row, and NOTHING in
// `public.waitlist` — that table is the Hone marketing early-access list
// (global email uniqueness, no studio ownership), a different product concept.
//
// TENANT SCOPE IS SERVER-RESOLVED. `studio.id` — read off the studios row, not
// the posted slug — is the command's tenant argument, the rate-limit scope and
// the idempotency-key tenant component. A forged slug can only ever select
// WHICH studio is resolved; it can never become the identity used downstream.
//
// DUPLICATES ARE THE DATABASE'S ANSWER, NOT THIS FILE'S. There is deliberately
// no "have we seen this email?" read here. Two simultaneous submissions would
// both pass such a check; 0185's studio-scoped partial unique index resolves
// them inside one atomic statement instead.
//
// PII. Name / email / phone belong in the two emails and the one committed row,
// and NOWHERE else. No log line, error message or event authored here carries
// them — nor the idempotency key or canonical payload, which are derived from
// them.
// ===========================================================================

export type { NewClientWaitlistResult };

/**
 * Errors that PROVE the command did not run. A missing function is the
 * NEW-app/OLD-database skew: the durable allowlist was switched on before
 * migration 0185 was applied. Nothing committed, so the visitor should be told
 * to try again rather than sent to a human about a request that never existed.
 *
 * Everything else — transport, timeout, an aborted connection — is genuinely
 * ambiguous: the command may have committed and only the answer was lost.
 */
const COMMAND_NOT_DEPLOYED_CODES: ReadonlySet<string> = new Set([
  "42883", // PostgreSQL: undefined_function
  "PGRST202", // PostgREST: no function matching the request in the schema cache
]);

function trimmed(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Bounded, PII-free structured log. Never carries the key or raw input. */
function logWaitlistEvent(
  event: string,
  detail: Record<string, string | number | boolean | null>,
): void {
  console.error(
    JSON.stringify({ event, ...detail, timestamp: new Date().toISOString() }),
  );
}

/**
 * The studio-side operational recipient.
 *
 * `studios.owner_email` is the studio's own account address and the existing
 * authoritative studio-level destination in this codebase (what the portal
 * reply and postcare paths ultimately fall back to). Deliberately NOT
 * `postcare_contact_email`: that is the CLIENT-FACING address a studio
 * publishes for aftercare questions, and an internal admission-control notice
 * does not belong there. Public booking notifies the ASSIGNED PRACTITIONER
 * instead, but a waitlist request has no appointment and so no assignment.
 *
 * NOTE: this address is a DESTINATION, never an identity. It is not unique
 * across studios, which is precisely why the idempotency key is scoped by
 * `studio.id` rather than by recipient.
 */
function studioNotificationRecipient(studio: Studio): string | null {
  const owner = studio.owner_email?.trim() ?? "";
  if (owner.length === 0 || !owner.includes("@")) return null;
  return owner;
}

/**
 * Courtesy acknowledgement to the visitor. Strictly after the commit, under its
 * own namespace and the same tenant scope. Any outcome, including a throw,
 * leaves the result successful: the request is already recorded and a failed
 * courtesy note must never erase it.
 */
async function sendClientAcknowledgement(
  studio: Studio,
  submission: WaitlistSubmission,
  // `string | null`: hashFingerprint returns null when the salt is not
  // configured. Correlation is then unavailable, which is a degraded log, not
  // a reason to put the raw address in one.
  emailFingerprint: string | null,
): Promise<void> {
  try {
    const clientEmail = buildNewClientWaitlistClientEmail({
      studioName: studio.name,
      name: submission.name,
    });
    const clientSend = await sendWaitlistEmailIdempotent({
      namespace: "client",
      studioId: studio.id,
      to: submission.email,
      subject: clientEmail.subject,
      html: clientEmail.html,
      text: clientEmail.text,
    });
    if (clientSend.status !== "accepted") {
      logWaitlistEvent("new_client_waitlist_client_email_not_accepted", {
        studioId: studio.id,
        status: clientSend.status,
        emailFingerprint,
      });
    }
  } catch {
    logWaitlistEvent("new_client_waitlist_client_email_threw", {
      studioId: studio.id,
      emailFingerprint,
    });
  }
}

// ===========================================================================
// WAIT-02 — DURABLE PATH. The database row is the commit.
// ===========================================================================
async function submitToDurableWaitlist(
  studio: Studio,
  submission: WaitlistSubmission,
  // `string | null`: hashFingerprint returns null when the salt is not
  // configured. Correlation is then unavailable, which is a degraded log, not
  // a reason to put the raw address in one.
  emailFingerprint: string | null,
): Promise<NewClientWaitlistResult> {
  // Construct the service-role client separately from the call, and classify a
  // construction failure as a DEFINITE failure: a missing key means nothing
  // reached the database, so "try again" is true and "contact the studio about
  // a request that may have landed" would not be.
  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch {
    logWaitlistEvent("new_client_waitlist_admin_client_unavailable", {
      studioId: studio.id,
    });
    return { ok: false, error: NEW_CLIENT_WAITLIST_SUBMIT_FAILED };
  }

  // ONE authoritative command. It owns validation, normalization, the duplicate
  // rule and the concurrency resolution; this action supplies only the
  // server-resolved tenant and the bounded submission.
  let commandResult: string | null = null;
  try {
    const { data, error } = await admin.rpc("join_new_client_waitlist", {
      p_studio_id: studio.id,
      p_name: submission.name,
      p_email: submission.email,
      p_phone: submission.phone,
    });
    if (error) {
      const code = typeof error.code === "string" ? error.code : "";
      if (COMMAND_NOT_DEPLOYED_CODES.has(code)) {
        logWaitlistEvent("new_client_waitlist_command_not_deployed", {
          studioId: studio.id,
          code,
        });
        return { ok: false, error: NEW_CLIENT_WAITLIST_SUBMIT_FAILED };
      }
      // Ambiguous: the command may have committed and only the answer was lost.
      logWaitlistEvent("new_client_waitlist_command_failed", {
        studioId: studio.id,
        code: code || "unknown",
        emailFingerprint,
      });
      return { ok: false, error: NEW_CLIENT_WAITLIST_SUBMIT_UNCONFIRMED };
    }
    const row = Array.isArray(data) ? data[0] : data;
    commandResult = (row?.result as string | undefined) ?? null;
  } catch {
    // A throw at transport level cannot distinguish "never ran" from
    // "committed, answer lost". Never claim they joined; never invite a blind
    // resubmit that could duplicate a request that did land.
    logWaitlistEvent("new_client_waitlist_command_threw", {
      studioId: studio.id,
      emailFingerprint,
    });
    return { ok: false, error: NEW_CLIENT_WAITLIST_SUBMIT_UNCONFIRMED };
  }

  // Calm and idempotent. No second notification, no error framing: repeating a
  // submission is not a mistake and must not read like one.
  if (commandResult === "already_waiting") {
    return { ok: true, state: "already_waiting" };
  }

  if (commandResult !== "created") {
    // Every closed refusal the command can emit (`invalid_input`,
    // `studio_not_found`, `unknown`) leaves NOTHING committed, and all of them
    // map to one generic message so a probing caller cannot tell them apart.
    logWaitlistEvent("new_client_waitlist_command_refused", {
      studioId: studio.id,
      result: commandResult ?? "none",
    });
    return { ok: false, error: NEW_CLIENT_WAITLIST_SUBMIT_FAILED };
  }

  // ---- COMMITTED. Everything below is notification and cannot change that. --
  let notification: "sent" | "unconfirmed" = "unconfirmed";
  const recipient = studioNotificationRecipient(studio);
  if (!recipient) {
    // Under WAIT-01 this was fatal — with no destination the request vanished.
    // It is no longer: the studio's record is the row, and the operator queue
    // reads it regardless of whether any address was configured.
    logWaitlistEvent("new_client_waitlist_no_studio_recipient", {
      studioId: studio.id,
    });
  } else {
    try {
      const studioEmail = buildNewClientWaitlistStudioEmail({
        studioName: studio.name,
        name: submission.name,
        email: submission.email,
        phone: submission.phone,
      });
      const studioSend = await sendWaitlistEmailIdempotent({
        namespace: "studio",
        studioId: studio.id,
        to: recipient,
        subject: studioEmail.subject,
        html: studioEmail.html,
        text: studioEmail.text,
      });
      if (studioSend.status === "accepted") {
        notification = "sent";
      } else {
        // Refused and ambiguous are the SAME fact to a visitor who is already
        // on the list, and the distinction is recorded here rather than shown.
        // `code`/`reason` are provider error NAMES, never messages, which can
        // embed the recipient address.
        logWaitlistEvent("new_client_waitlist_studio_email_not_accepted", {
          studioId: studio.id,
          status: studioSend.status,
          detail:
            studioSend.status === "ambiguous" ? studioSend.reason : studioSend.code,
          emailFingerprint,
        });
      }
    } catch {
      logWaitlistEvent("new_client_waitlist_studio_email_threw", {
        studioId: studio.id,
        emailFingerprint,
      });
    }
  }

  await sendClientAcknowledgement(studio, submission, emailFingerprint);
  return { ok: true, state: "joined", notification };
}

// ===========================================================================
// WAIT-01 — NOTIFICATION-COMMIT PATH. Unchanged production behaviour.
// ===========================================================================
//
// Kept verbatim for studios not yet moved to the durable record. Its commit law
// stands exactly as shipped:
//
//   provider ACCEPTED, with a non-empty message id  -> success
//   provider REFUSED                                -> failure (known-not-sent)
//   provider AMBIGUOUS (timeout / concurrent / no
//     message id), after one idempotent retry       -> UNCONFIRMED
//
// "Accepted" means the Resend API accepted the request AND returned an id for
// it. It does NOT mean inbox delivery, recipient acceptance, non-spam
// placement, or that a human saw it.
//
// AMBIGUITY IS ITS OWN ANSWER. A client-side timeout cannot cancel the request
// in flight, so "we could not confirm" is genuinely different from "it did not
// send". Telling the visitor to retry could duplicate a request that landed;
// telling them they joined could be a lie.
async function submitViaStudioNotification(
  studio: Studio,
  submission: WaitlistSubmission,
  // `string | null`: hashFingerprint returns null when the salt is not
  // configured. Correlation is then unavailable, which is a degraded log, not
  // a reason to put the raw address in one.
  emailFingerprint: string | null,
): Promise<NewClientWaitlistResult> {
  const recipient = studioNotificationRecipient(studio);
  if (!recipient) {
    // No operational destination: the request would vanish. Fail truthfully
    // rather than telling the visitor they are on a waitlist.
    logWaitlistEvent("new_client_waitlist_no_studio_recipient", {
      studioId: studio.id,
    });
    return { ok: false, error: NEW_CLIENT_WAITLIST_SUBMIT_FAILED };
  }

  // The sender derives the idempotency key from the SERVER-RESOLVED studio id
  // plus the exact payload it transmits, so neither the tenant scope nor the
  // bytes can drift from what is actually sent. Both email builders are pure
  // functions of the submission, which is what makes an identical
  // resubmission collapse instead of erroring.
  const studioEmail = buildNewClientWaitlistStudioEmail({
    studioName: studio.name,
    name: submission.name,
    email: submission.email,
    phone: submission.phone,
  });
  const studioSend = await sendWaitlistEmailIdempotent({
    namespace: "studio",
    studioId: studio.id,
    to: recipient,
    subject: studioEmail.subject,
    html: studioEmail.html,
    text: studioEmail.text,
  });

  if (studioSend.status === "ambiguous") {
    logWaitlistEvent("new_client_waitlist_studio_email_unconfirmed", {
      studioId: studio.id,
      reason: studioSend.reason,
      emailFingerprint,
    });
    return { ok: false, error: NEW_CLIENT_WAITLIST_SUBMIT_UNCONFIRMED };
  }
  if (studioSend.status !== "accepted") {
    // A definite refusal. `code` is the provider's error NAME (an enum member),
    // never its message, which can embed the recipient address.
    logWaitlistEvent("new_client_waitlist_studio_email_rejected", {
      studioId: studio.id,
      code: studioSend.code,
      emailFingerprint,
    });
    return { ok: false, error: NEW_CLIENT_WAITLIST_SUBMIT_FAILED };
  }

  await sendClientAcknowledgement(studio, submission, emailFingerprint);
  return { ok: true, state: "joined", notification: "sent" };
}

export async function submitNewClientBookingWaitlistAction(
  formData: FormData,
): Promise<NewClientWaitlistResult> {
  // The browser supplies the slug ONLY as a lookup pointer. Studio id, the
  // notification address, whether the feature is on, and which commit point
  // applies are all server-resolved below and are never read off the form.
  const slug = trimmed(formData.get("slug"));

  // 1. BOUNDED VALIDATION FIRST, so everything downstream works on
  //    length-capped, normalized input. The database command re-validates and
  //    re-normalizes independently; this is the cheap first pass, not the
  //    authority.
  const validated = validateWaitlistSubmission({
    name: trimmed(formData.get("name")),
    email: trimmed(formData.get("email")),
    phone: trimmed(formData.get("phone")) || null,
  });
  if (!validated.ok) return { ok: false, error: validated.error };
  if (!slug || slug.length > WAITLIST_SLUG_MAX) {
    return { ok: false, error: NEW_CLIENT_WAITLIST_SUBMIT_FAILED };
  }
  const submission = validated.value;
  const emailFingerprint = hashFingerprint(submission.email);

  // 2. SERVER-RESOLVED STUDIO, BEFORE the limiter.
  //    The limiter is studio-scoped, so it cannot run until the studio is a
  //    server fact. This costs one bounded, indexed SELECT on a public slug
  //    ahead of rate limiting — the same lookup the public booking PAGE already
  //    performs on every render, so it adds no new exposure.
  let studio: Studio | null = null;
  try {
    studio = await getStudioBySlug(slug);
  } catch {
    logWaitlistEvent("new_client_waitlist_studio_lookup_failed", { slug });
    return { ok: false, error: NEW_CLIENT_WAITLIST_SUBMIT_FAILED };
  }
  if (!studio) return { ok: false, error: NEW_CLIENT_WAITLIST_SUBMIT_FAILED };

  // 3. INDEPENDENT SERVER FEATURE VERIFICATION against the slug as stored on
  //    the row. A browser-claimed "waitlist is on" is not consulted and does not
  //    exist on the wire. Checked BEFORE the limiter so a submission to a studio
  //    that is not in waitlist mode consumes no quota.
  if (!isNewClientWaitlistEnabled(studio.slug)) {
    return { ok: false, error: NEW_CLIENT_WAITLIST_SUBMIT_FAILED };
  }

  // 4. DEDICATED, STUDIO-SCOPED RATE LIMIT. Its own Redis namespace, keyed by
  //    hashed identifier + server-resolved studio id, so the marketing waitlist
  //    and other studios can never consume this studio's budget.
  const gate = await limitNewClientBookingWaitlist({
    headers: await headers(),
    studioId: studio.id,
    email: submission.email,
  });
  if (!gate.allowed) return { ok: false, error: RATE_LIMIT_MESSAGE };

  // 5. COMMIT. Which commit point applies is a SERVER fact derived from the
  //    server-resolved slug, exactly like the gate above.
  return isNewClientWaitlistDurableEnabled(studio.slug)
    ? submitToDurableWaitlist(studio, submission, emailFingerprint)
    : submitViaStudioNotification(studio, submission, emailFingerprint);
}
