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

/**
 * Has a service actually been chosen?
 *
 * THE NARROWED TYPE IS NOT A BROWSER GUARANTEE. Final #683 types
 * `BookingScope.serviceId` as `string` and says outright why that is not
 * permission to drop this guard: the browser did not compile — a page can be
 * refreshed, a payload hand-built, a field renamed by a stale cache. Its
 * exported `INTEGRATION_INPUT_REVALIDATION_OBLIGATION` names the duty this
 * discharges.
 *
 * THE SAME RULE THE COMPOSER APPLIES, deliberately: `trim()` decides emptiness
 * and NOTHING else, and the identifier is then used EXACTLY as given. Trimming
 * one into a different id would be choosing a service on the practitioner's
 * behalf, and a zero-width space is content by this rule rather than whitespace
 * — left for the database to refuse as the nonexistent id it is. That keeps the
 * UI's classification and the server's from disagreeing on the same bytes.
 *
 * `unknown`, not `string | null`: a hand-built payload is not obliged to send
 * either. This is a validation boundary; its job is to answer, not to throw.
 *
 * A TYPE PREDICATE, so the narrowing below is EARNED rather than asserted —
 * there is no cast and no `!` anywhere on this path.
 */
function isChosenServiceId(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** Re-check the parsed intent. Returns null when it may be forwarded. */
function rejectSubmission(s: InviteSubmission): "malformed_submission" | null {
  // An entry id is the one identifier the browser legitimately names, and it is
  // still only a lookup key: the command scopes by (id, studio_id), so an id
  // from another studio is simply not found.
  if (!s.entryId || typeof s.entryId !== "string") return "malformed_submission";
  // A SERVICE IS NOW REQUIRED, and blank is not a service. Existence, tenancy
  // and eligibility remain the DATABASE's questions; this refuses only a value
  // nobody could have picked.
  if (!isChosenServiceId(s.serviceId)) return "malformed_submission";
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

  const s = parsed.submission;
  if (rejectSubmission(s)) {
    return { outcome: null, reason: "malformed_submission" };
  }

  // NARROWING IS EARNED HERE, NOT ASSERTED. `rejectSubmission` above answers a
  // reason, which does not narrow `s` for the compiler, so the three optional
  // fields are re-tested with predicates rather than cast. An earlier revision
  // wrote `submission.windowDays as number`, and a cast is precisely the thing
  // that would let a future edit drop the guard above and still compile — the
  // failure mode #683's revalidation obligation warns about, one line further on.
  const { serviceId, windowDays, expiresInHours } = s;
  if (
    !isChosenServiceId(serviceId) ||
    typeof windowDays !== "number" ||
    typeof expiresInHours !== "number"
  ) {
    return { outcome: null, reason: "malformed_submission" };
  }

  const input = {
    entryId: s.entryId,
    scope: { serviceId, windowDays, allowedWeekdays: s.allowedWeekdays },
    expiresInHours,
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
 * THAT LIMITATION IS NOW CLOSED, and this wrapper is kept only for callers that
 * still want the void shape. The waitlist surface binds `inviteToBookAction`
 * directly through the composer's `resultAction`, so the DELIVERY disposition
 * reaches the practitioner: `committed / accepted`, `committed / refused` and
 * `committed / unknown` now read differently, and a refused or indeterminate
 * admission is distinguished from all three. The translation lives in
 * `invitationNoticeFor`; nothing about what this action COMPUTES changed.
 */
export async function inviteToBookFormAction(formData: FormData): Promise<void> {
  await inviteToBookAction(formData);
}
