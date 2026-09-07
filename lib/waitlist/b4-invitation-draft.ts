// ===========================================================================
// WAIT-03 B4 — INVITATION DRAFTING: THE UNWIRED HALF OF THE ADMISSION MODEL
// ===========================================================================
//
// PURE, AND NOT REACHED BY THE APPLICATION. Nothing under `app/` imports this
// module. It exists so that the B4 prototype — the admission row's full action
// menu and the invitation composer — has somewhere to live that a reviewer can
// tell apart from the surface a studio actually uses today.
//
// WHY THIS IS A SEPARATE MODULE FROM `admission-model`. The live operator queue
// at /settings/waitlist offers exactly five lifecycle actions: claim, expire,
// release, requeue, remove. Every one of them is wired to a shipped command.
// Inviting is not: `issue_new_client_waitlist_invitation` mints a token that has
// to reach a real recipient, which is B1/B1.5c + B2 work. While invite and
// reinvite sat in the same module as the five live actions, every review round
// spent itself on staged-but-unreachable code and the live release could not
// ship. The split makes "what a studio can do today" a fact about the import
// graph rather than a claim in a comment.
//
// WHAT LIVES HERE, AND WHY EACH PIECE IS HERE RATHER THAN THERE:
//
//   * invite / reinvite availability — no server action carries either.
//   * the brief-vocabulary map — a B4 design artifact. It records where the
//     product brief's words and the shipped database's words disagree. The live
//     page never consults it; it renders the database's own vocabulary.
//   * TTL bounds and the invitation draft — inputs to a send that cannot happen
//     yet. Two of the draft's six steps reach a server contract; the other four
//     are collected as intent, and the model refuses to let the review step
//     imply otherwise.
//
// THE SAME DISCLOSURE RULE APPLIES. An unavailable action returns its REASON
// from the function that decides availability, so a greyed control can never
// hide its own prerequisite.
// ===========================================================================

import {
  ACTION_LABEL,
  ADMISSION_ACTIONS,
  STATUS_LABEL,
  actionAvailability,
  type ActionAvailability,
  type AdmissionAction,
  type AdmissionContext,
  type WaitlistEntryStatus,
} from "@/lib/waitlist/admission-model";

// --- 1. THE BRIEF'S VOCABULARY, AND WHERE IT DISAGREES ----------------------

/**
 * How the brief's words map onto the shipped states.
 *
 * TWO GENUINE GAPS, both recorded rather than invented around:
 *
 *   * `booked` is the brief's word for the shipped `converted`.
 *   * `revoked` is the brief's word for a studio-initiated return. The database
 *     has TWO such transitions — `released` (back to the studio's hands, and
 *     requeueable) and `removed` (terminal). They are NOT synonyms and the UI
 *     must not collapse them.
 *   * `declined` HAS NO SHIPPED STATE. Migration 0188 contains no `declin*`
 *     token anywhere: a prospect cannot decline, and nothing records that they
 *     did. It is therefore absent from this model. Rendering a "Declined"
 *     column would be inventing a fact the system cannot hold.
 */
export const BRIEF_LABEL_MAP = {
  waiting: "waiting",
  invited: "invited",
  booked: "converted",
  expired: "expired",
  revoked: "released",
} as const satisfies Record<string, WaitlistEntryStatus>;

/** The brief word with no shipped state behind it. Exported so a test can pin
 *  that the model never grows a status for it by accident. */
export const UNMODELLED_BRIEF_STATES = ["declined"] as const;

// --- 2. THE TWO ACTIONS THAT SEND SOMETHING ---------------------------------

export const B4_INVITATION_ACTIONS = ["invite", "reinvite"] as const;

export type B4InvitationAction = (typeof B4_INVITATION_ACTIONS)[number];

export const B4_ACTION_LABEL: Record<B4InvitationAction, string> = {
  invite: "Send invitation",
  reinvite: "Send a new invitation",
};

/**
 * The transition table, derived from what the shipped commands actually accept.
 *
 * INVITING REQUIRES `claimed`, AND ONLY `claimed`.
 * `issue_new_client_waitlist_invitation` answers `not_claimed` for every other
 * status (0190: `if v_status <> 'claimed' then return 'not_claimed'`). So an
 * entry that is merely WAITING cannot be invited — it must be claimed first —
 * and an `expired` or `released` entry needs the full path back: return it to
 * the queue, claim it, then invite.
 *
 * `reinvite` is not a separate command; it is `issue` called again on a claimed
 * entry whose previous invitation is no longer live. It stays a separate ACTION
 * so its refusal can name the path rather than repeating "invite".
 *
 * NO `context` PARAMETER, DELIBERATELY. Whether either action may be offered is
 * decided by status alone today. The one thing that would need more — telling
 * an INITIAL invitation apart from a re-invitation on a `claimed` entry —
 * requires invitation HISTORY, which no caller carries. That is open B4 work,
 * and accepting an unused context argument now would imply it had been
 * considered and answered.
 */
export function invitationActionAvailability(
  action: B4InvitationAction,
  status: WaitlistEntryStatus,
): ActionAvailability {
  const label = STATUS_LABEL[status].toLowerCase();

  // A CLOSED ENTRY REFUSES EVERY ACTION WITH THE SAME SENTENCE, whichever
  // action is asked — the refusal is a fact about the ENTRY, not about the
  // action. So the live model already holds that answer and this module reads
  // it there rather than keeping a second copy that can drift. `claim` is
  // merely the probe: every live action returns the identical verdict, which
  // the accompanying test proves rather than assumes.
  if (status === "converted" || status === "removed") {
    return actionAvailability("claim", status);
  }

  switch (action) {
    case "invite":
      // ONLY `claimed`. The command answers `not_claimed` for every other
      // status, so offering it on a merely WAITING entry would be a control
      // that cannot succeed.
      if (status === "claimed") return { available: true };
      if (status === "waiting") {
        return {
          available: false,
          reason: `Claim them first — use “${ACTION_LABEL.claim}” — then send the invitation.`,
        };
      }
      if (status === "invited") {
        return {
          available: false,
          reason: "An invitation is already out. Release it before sending another.",
        };
      }
      return {
        available: false,
        reason: `This entry is ${label}. Return them to the queue and claim them first.`,
      };

    case "reinvite":
      // Same prerequisite: re-inviting IS `issue` again, so it also needs a
      // claimed entry. An expired or released one has to travel back —
      // requeue, then claim — and the refusal names that path rather than
      // implying a shortcut the database does not have.
      if (status === "claimed") return { available: true };
      if (status === "invited") {
        return {
          available: false,
          reason: "An invitation is already out. Release it before sending another.",
        };
      }
      if (status === "expired" || status === "released") {
        return {
          available: false,
          reason: `Return them to the queue and claim them first, then send a new invitation.`,
        };
      }
      return {
        available: false,
        reason: `Nothing has been sent yet. Claim them, then use “${B4_ACTION_LABEL.invite}”.`,
      };
  }
}

// --- 3. THE WHOLE MENU: LIVE ACTIONS PLUS THE TWO THAT SEND -----------------

export type B4MenuAction = AdmissionAction | B4InvitationAction;

/**
 * Every action B4 renders, in the order a practitioner reads them.
 *
 * DERIVED FROM THE LIVE LIST, not hand-copied beside it: a sixth live action
 * would join this menu automatically instead of being silently absent from the
 * prototype. Only the POSITION of the two invitation actions is stated here —
 * they belong immediately after claiming, which is their prerequisite.
 */
export const B4_MENU_ACTIONS: ReadonlyArray<B4MenuAction> = [
  "claim",
  ...B4_INVITATION_ACTIONS,
  ...ADMISSION_ACTIONS.filter((a) => a !== "claim"),
];

export const B4_MENU_LABEL: Record<B4MenuAction, string> = {
  ...ACTION_LABEL,
  ...B4_ACTION_LABEL,
};

function isInvitationAction(action: B4MenuAction): action is B4InvitationAction {
  return (B4_INVITATION_ACTIONS as ReadonlyArray<string>).includes(action);
}

/**
 * Every action with its verdict, for rendering a menu that shows disabled
 * entries WITH their reason rather than hiding them. Hiding an action teaches a
 * practitioner that it does not exist; disabling it with a reason teaches them
 * when it will.
 *
 * `context` reaches the LIVE actions only, because they are the only ones whose
 * availability depends on anything beyond the entry's status — see
 * `invitationActionAvailability`.
 */
export function allActionAvailability(
  status: WaitlistEntryStatus,
  context: AdmissionContext = {},
): Array<{ action: B4MenuAction; label: string } & ActionAvailability> {
  return B4_MENU_ACTIONS.map((action) => ({
    action,
    label: B4_MENU_LABEL[action],
    ...(isInvitationAction(action)
      ? invitationActionAvailability(action, status)
      : actionAvailability(action, status, context)),
  }));
}

// --- 4. EXPIRY (the ONE draft input with a server contract) ------------------
//
// `issue_new_client_waitlist_invitation(p_studio_id, p_entry_id,
// p_actor_user_id, p_ttl_hours default 72)`.
//
// The bounds and the REFUSAL are copied from the command, whose comment reads:
// "1 hour .. 7 days. Out of range is REFUSED, never silently clamped: a clamped
// TTL is a window the caller did not ask for and cannot see." This model refuses
// identically, so the UI never sends a value the server will reject and never
// shows a value the server would have changed underneath it.

export const TTL_HOURS_MIN = 1;
export const TTL_HOURS_MAX = 168; // 7 days
export const TTL_HOURS_DEFAULT = 72;

/** Presets, chosen to cover the real operational span without a free-text box
 *  as the primary control. The custom field remains available and is validated
 *  by exactly the same rule. */
export const TTL_PRESETS: ReadonlyArray<{ hours: number; label: string }> = [
  { hours: 24, label: "24 hours" },
  { hours: 48, label: "2 days" },
  { hours: 72, label: "3 days" },
  { hours: 168, label: "7 days" },
];

export type TtlValidation =
  | { ok: true; hours: number }
  | { ok: false; error: string };

export function validateTtlHours(raw: unknown): TtlValidation {
  const hours =
    typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : NaN;
  if (!Number.isFinite(hours) || !Number.isInteger(hours)) {
    return { ok: false, error: "Enter a whole number of hours." };
  }
  if (hours < TTL_HOURS_MIN) {
    return { ok: false, error: `An invitation must last at least ${TTL_HOURS_MIN} hour.` };
  }
  if (hours > TTL_HOURS_MAX) {
    return { ok: false, error: "An invitation cannot last longer than 7 days." };
  }
  return { ok: true, hours };
}

// --- 5. THE INVITATION DRAFT, AND WHICH PARTS ARE REAL -----------------------
//
// THE HONESTY PROBLEM THIS SOLVES. The brief's workflow has seven steps. As of
// migration 0188 exactly TWO of them reach a server contract: choosing who, and
// choosing how long. There is no service parameter, no horizon parameter, no
// weekday parameter and no date parameter on any shipped command.
//
// Collecting that intent is still useful — B2 may well add it, and a studio
// wants to express it — but the model must never let the review step imply that
// an unbacked constraint will be enforced. So every step carries its backing.

export type DraftStepId =
  | "select"
  | "service"
  | "horizon"
  | "days"
  | "expiry"
  | "review";

/**
 * Whether a step's value can actually reach the database today.
 *
 * `server-backed`  a shipped command parameter carries it.
 * `pending-b2`     no shipped parameter exists. Collected as INTENT only, and
 *                  the review step must say so in words.
 */
export type StepBacking = "server-backed" | "pending-b2";

export const STEP_BACKING: Record<Exclude<DraftStepId, "review">, StepBacking> = {
  // claim_new_client_waitlist_entry(_ies) + issue_...(p_entry_id)
  select: "server-backed",
  // No p_service_id on any shipped command.
  service: "pending-b2",
  // No horizon parameter on any shipped command.
  horizon: "pending-b2",
  // No weekday or date parameter on any shipped command.
  days: "pending-b2",
  // issue_...(p_ttl_hours)
  expiry: "server-backed",
};

/** The sentence the review step shows for anything not yet carried by a
 *  command. Deliberately blunt: the alternative is a studio believing it has
 *  constrained an invitation when it has not. */
export const PENDING_B2_NOTICE =
  "Recorded as a note for the studio only — this is not yet enforced when the invitation is sent.";

export type InvitationDraft = {
  /** Entry ids chosen by the operator. Selection is by identity here; the
   *  bulk claim command takes a COUNT instead, which is a different act and is
   *  modelled separately (see `NEXT_N_IS_NOT_SELECTION`). */
  entryIds: ReadonlyArray<string>;
  /** pending-b2 */
  serviceId: string | null;
  /** pending-b2 — days from today the invitee may book within. */
  horizonDays: number | null;
  /** pending-b2 — 0=Sunday..6=Saturday. Empty means "no restriction stated". */
  weekdays: ReadonlyArray<number>;
  /** pending-b2 — explicit ISO dates, where the studio prefers exact days. */
  dates: ReadonlyArray<string>;
  /** server-backed */
  ttlHours: number;
};

export function emptyDraft(): InvitationDraft {
  return {
    entryIds: [],
    serviceId: null,
    horizonDays: null,
    weekdays: [],
    dates: [],
    ttlHours: TTL_HOURS_DEFAULT,
  };
}

/**
 * "Invite next N" is NOT multi-select, and the difference is load-bearing.
 *
 * `claim_new_client_waitlist_entries(p_studio_id, p_actor_user_id, p_count)`
 * takes a COUNT and claims the next N in queue order. It does not accept a list
 * of ids. So "invite the next 5" and "invite these 5 people" are two different
 * operations against two different commands, and a UI that renders them as one
 * control would be choosing the queue order on the studio's behalf.
 *
 * B4 designs FOR the next-N surface and does not implement its ranking: the
 * ordering is the database's existing FIFO, and nothing here re-sorts it.
 */
export const NEXT_N_IS_NOT_SELECTION = true;

export type DraftValidation =
  | { ok: true; draft: InvitationDraft }
  | { ok: false; errors: Partial<Record<DraftStepId, string>> };

/**
 * Validate a draft for SUBMISSION READINESS.
 *
 * Only server-backed fields can make a draft invalid. An unbacked field cannot
 * block a send, because the send does not carry it — blocking on it would
 * invent a requirement the server does not have.
 */
export function validateDraft(draft: InvitationDraft): DraftValidation {
  const errors: Partial<Record<DraftStepId, string>> = {};

  if (draft.entryIds.length === 0) {
    errors.select = "Choose at least one person to invite.";
  }
  const ttl = validateTtlHours(draft.ttlHours);
  if (!ttl.ok) errors.expiry = ttl.error;

  // Bounds on the INTENT fields are still enforced, because a nonsense value
  // helps nobody even when nothing enforces it downstream.
  if (draft.horizonDays !== null && (draft.horizonDays < 1 || draft.horizonDays > 365)) {
    errors.horizon = "Choose a window between 1 and 365 days.";
  }
  if (draft.weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    errors.days = "Unrecognised day.";
  }

  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, draft };
}

/** The review step's summary of one draft: what will actually happen, and what
 *  is only being noted. Separated so the review screen cannot present the two
 *  in the same voice. */
export function reviewSummary(draft: InvitationDraft): {
  enforced: string[];
  notEnforced: string[];
} {
  const enforced: string[] = [];
  const notEnforced: string[] = [];

  enforced.push(
    draft.entryIds.length === 1
      ? "1 person will be invited."
      : `${draft.entryIds.length} people will be invited.`,
  );
  enforced.push(`The invitation expires after ${draft.ttlHours} hours.`);

  if (draft.serviceId) notEnforced.push("Service preference");
  if (draft.horizonDays !== null) notEnforced.push(`Booking window of ${draft.horizonDays} days`);
  if (draft.weekdays.length > 0) notEnforced.push("Preferred days of the week");
  if (draft.dates.length > 0) notEnforced.push("Specific dates");

  return { enforced, notEnforced };
}
