"use server";

import { revalidatePath } from "next/cache";
import {
  inviteSubmissionFromFormData,
  WINDOW_DAYS_MAX,
  WINDOW_DAYS_MIN,
  TTL_HOURS_MAX,
  TTL_HOURS_MIN,
  type InviteSubmission,
} from "@/lib/waitlist/b4-invitation-draft";
import {
  admissionCommandAdapter,
  validateInviteInput,
} from "@/lib/waitlist/invite-to-book-adapter";
import type { InvitationOutcome } from "@/lib/waitlist/invite-to-book-contract";

// ===========================================================================
// WAIT INTEGRATION-01 — THE PRACTITIONER'S SUBMISSION BOUNDARY
// ===========================================================================
//
// INTEGRATION-OWNED, and it is the seam #683 leaves open on purpose: the
// composer's `action` prop is typed `(FormData) => void | Promise<void>`, which
// is exactly a server action's shape, so this file passes straight in with no
// adapter between them. #683 collects four answers; it never learns who is
// acting, which studio they act for, or whether the command will be allowed.
//
// ---------------------------------------------------------------------------
// THE BROWSER SENDS INTENT. IT NEVER SENDS AUTHORITY.
// ---------------------------------------------------------------------------
//
// `inviteSubmissionFromFormData` is #683's own reviewed parser and it reads ONLY
// the four product fields plus the entry id. A `studio_id`, `actor_id`,
// `round_id`, `role` or claim state tacked onto the payload is not consulted —
// the parser is a projection, not a filter, so there is no branch that could let
// one through. Nothing in this file reads `formData` directly for that reason:
// a second reader is how a smuggled field eventually gets honoured.
//
// Studio, actor and authorisation are resolved inside the adapter from the
// session, and `admit_` RE-DERIVES membership and owner role in the database.
//
// ---------------------------------------------------------------------------
// CLIENT VALIDATION IS UX. THIS IS THE BOUNDARY.
// ---------------------------------------------------------------------------
//
// Everything the composer enforces is re-checked here against the same shared
// rules, because a disabled button stops a person and stops nothing else. The
// bounds below are the component's own exported constants rather than numbers
// retyped — two copies of a bound is how a form and its server come to disagree
// about what is valid.

/**
 * What the surface is told afterwards.
 *
 * `refused` here covers BOTH a server refusal and a payload this boundary would
 * not forward — from the practitioner's side they are the same event: nothing
 * was created and the composer needs another answer. `indeterminate` is kept
 * distinct because it is the one case where something may exist.
 */
export type InviteActionResult =
  | { outcome: InvitationOutcome }
  | { outcome: null; reason: "malformed_submission" };

/** Re-check the parsed intent. Returns null when it may be forwarded. */
function rejectSubmission(s: InviteSubmission): "malformed_submission" | null {
  // An entry id is the one identifier the browser legitimately names, and it is
  // still only a lookup key: the command scopes by (id, studio_id), so an id
  // from another studio is simply not found.
  if (!s.entryId || typeof s.entryId !== "string") return "malformed_submission";
  // FAIL CLOSED ON ABSENCE. The composer can express "no answer yet" for each of
  // these, and an absent answer must never fall back to a default here — a
  // defaulted window or expiry is one the practitioner never chose and cannot
  // see on the confirmation they just read.
  if (s.windowDays === null || s.expiresInHours === null) return "malformed_submission";
  if (
    !Number.isInteger(s.windowDays) ||
    s.windowDays < WINDOW_DAYS_MIN ||
    s.windowDays > WINDOW_DAYS_MAX
  ) {
    return "malformed_submission";
  }
  if (
    !Number.isInteger(s.expiresInHours) ||
    s.expiresInHours < TTL_HOURS_MIN ||
    s.expiresInHours > TTL_HOURS_MAX
  ) {
    return "malformed_submission";
  }
  // `null` weekdays means EVERY day and is the widest scope this product can
  // express, so it is honoured only because the parser already refused any
  // preset it did not recognise. An EMPTY array authorises nothing and is a
  // different thing again — refused rather than widened.
  if (s.allowedWeekdays !== null) {
    if (s.allowedWeekdays.length === 0) return "malformed_submission";
    if (s.allowedWeekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
      return "malformed_submission";
    }
  }
  return null;
}

/**
 * Invite one waiting or held person to book.
 *
 * The whole path: composer -> here -> adapter -> 0193 `admit_` -> #680 delivery
 * -> #683 `InvitationOutcome`.
 */
export async function inviteToBookAction(formData: FormData): Promise<InviteActionResult> {
  const parsed = inviteSubmissionFromFormData(formData);
  // The parser's ONE failure: an allowed-days preset it does not recognise.
  // There is nowhere safe to put that, because `null` days is a real answer
  // meaning every day — the widest one — so a defaulting read would turn a typo
  // or a renamed preset into the broadest possible invitation.
  if (!parsed.ok) return { outcome: null, reason: "malformed_submission" };

  const submission = parsed.submission;
  if (rejectSubmission(submission)) {
    return { outcome: null, reason: "malformed_submission" };
  }

  const input = {
    entryId: submission.entryId,
    scope: {
      serviceId: submission.serviceId,
      windowDays: submission.windowDays as number,
      allowedWeekdays: submission.allowedWeekdays,
    },
    expiresInHours: submission.expiresInHours as number,
  };
  // The adapter's own product-input rules, applied before the command so a
  // refusal costs no round trip. It re-applies them internally too; this is the
  // clearer message, never the guarantee.
  if (validateInviteInput(input)) {
    return { outcome: null, reason: "malformed_submission" };
  }

  const outcome = await admissionCommandAdapter.inviteToBook(input);

  // The queue's rendered state changes on a commit — the entry moves to
  // `invited` and acquires a live invitation. Revalidated only when something
  // actually committed, so a refusal does not churn the page.
  if (outcome.state === "committed") revalidatePath("/settings/waitlist");
  return { outcome };
}

/**
 * The binding the composer actually receives.
 *
 * #683 types `action` as `(FormData) => void | Promise<void>` DELIBERATELY: the
 * composer consumes no result, and the surface re-renders from server state
 * after `revalidatePath`. So this is a thin void-returning wrapper rather than a
 * different implementation — `inviteToBookAction` keeps its typed result for
 * tests and for any future surface that can render one.
 *
 * RECORDED LIMITATION, not hidden: because the contract's action is void, the
 * DELIVERY disposition currently reaches nobody. A `committed / refused` and a
 * `committed / accepted` look identical to the practitioner — the invitation
 * appears either way, and the queue shows `invited`. That is a real product gap
 * and it belongs to whichever surface learns to render
 * `INVITATION_DELIVERY_COPY`, which #683 already exports for exactly this. The
 * truth is computed and correct here; what is missing is somewhere to show it.
 */
export async function inviteToBookFormAction(formData: FormData): Promise<void> {
  await inviteToBookAction(formData);
}
