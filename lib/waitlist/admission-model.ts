// ===========================================================================
// WAIT-03 B4 — PRACTITIONER WAITLIST ADMISSION: UI STATE MODEL
// ===========================================================================
//
// PURE. No database, no server action, no `server-only` marker — this module is
// consumed by client components and by tests, and it performs no I/O. It decides
// what the operator surface may OFFER and what it must SAY when it offers
// nothing. It never performs, and never authorises, a mutation.
//
// WHY IT EXISTS SEPARATELY FROM B2. B2 owns the server interface. Until B2 is
// frozen this model is driven by NON-AUTHORITATIVE fixtures, so every claim it
// makes is about presentation only. The two things that keep that honest are
// declared here rather than left to reviewer memory:
//
//   1. The lifecycle vocabulary below is COPIED FROM THE SHIPPED DATABASE
//      (migration 0188), not from the product brief. Where the brief's words and
//      the database's words disagree, the database wins and the brief's word
//      becomes a LABEL. See BRIEF_LABEL_MAP.
//   2. Every field of an invitation draft declares whether a server contract
//      exists to carry it. A field with no contract may be collected, but the
//      review step is forbidden from promising it will be enforced.
//
// DISCLOSURE, NOT JUST DISABLEMENT. Every unavailable action returns its REASON
// from the same function that decides availability, so a greyed control can
// never hide its own prerequisite. That is the EMERG-02 rule applied here: one
// function, one call site, the button state and the sentence beside it derived
// together so they cannot drift.
// ===========================================================================

// --- 1. THE LIFECYCLE, AS THE DATABASE DEFINES IT --------------------------
//
// Verbatim from 0188:
//   check (status in ('waiting','claimed','invited','converted','expired',
//                     'released','removed'))
//
// Seven states. The brief names six and two of its names are not in this list at
// all, which is recorded in BRIEF_LABEL_MAP rather than smoothed over.

export const WAITLIST_ENTRY_STATUSES = [
  "waiting",
  "claimed",
  "invited",
  "converted",
  "expired",
  "released",
  "removed",
] as const;

export type WaitlistEntryStatus = (typeof WAITLIST_ENTRY_STATUSES)[number];

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

/** Operator-facing label for each shipped state. `claimed` is the state the
 *  brief does not name: the entry is held for this studio but no invitation has
 *  been issued yet, which is a real and visible waiting room of its own. */
export const STATUS_LABEL: Record<WaitlistEntryStatus, string> = {
  waiting: "Waiting",
  claimed: "Held",
  invited: "Invited",
  converted: "Booked",
  expired: "Expired",
  released: "Returned to queue",
  removed: "Removed",
};

/** One line explaining what the state MEANS operationally. Shown beside the
 *  status so a practitioner never has to infer the difference between `Held`
 *  and `Invited`, or between `Returned to queue` and `Removed`. */
export const STATUS_MEANING: Record<WaitlistEntryStatus, string> = {
  waiting: "In the queue. No one has started admitting them.",
  claimed: "Held for this studio. No invitation has been sent yet.",
  invited: "An invitation is out and has not yet been used.",
  converted: "They booked. This entry is closed.",
  expired: "The invitation ran out before it was used.",
  released: "Returned to the queue and can be admitted again.",
  removed: "Taken off the waitlist by the studio. Terminal.",
};

// --- 2. ACTIONS --------------------------------------------------------------

export const ADMISSION_ACTIONS = [
  "invite",
  "reinvite",
  "revoke",
  "requeue",
  "remove",
] as const;

export type AdmissionAction = (typeof ADMISSION_ACTIONS)[number];

export const ACTION_LABEL: Record<AdmissionAction, string> = {
  invite: "Send invitation",
  reinvite: "Send a new invitation",
  revoke: "Revoke invitation",
  requeue: "Return to queue",
  remove: "Remove from waitlist",
};

/**
 * Whether an action may be offered, and if not, WHY — from one function, so the
 * control and its explanation cannot disagree.
 *
 * `reason` is written for a practitioner, not a developer: it names the current
 * state and the next thing they could do, never a status code.
 */
export type ActionAvailability =
  | { available: true }
  | { available: false; reason: string };

/**
 * The transition table, derived from what the shipped commands actually accept.
 *
 * NOTE ON `reinvite`. There is no reinvite command. Re-inviting is
 * `issue_new_client_waitlist_invitation` called again, which the database only
 * permits once the previous invitation is no longer live — i.e. after it expired
 * or the entry was released. So `reinvite` is offered on `expired` and
 * `released`, and refused on `invited` with the remedy named (revoke first).
 * Modelling it as its own action, rather than a second "invite" button, is what
 * lets the refusal say something useful.
 */
export function actionAvailability(
  action: AdmissionAction,
  status: WaitlistEntryStatus,
): ActionAvailability {
  const label = STATUS_LABEL[status].toLowerCase();

  if (status === "converted") {
    return {
      available: false,
      reason: "They have already booked. Nothing further is needed here.",
    };
  }
  if (status === "removed") {
    return {
      available: false,
      reason: "This entry was removed from the waitlist and cannot be reopened.",
    };
  }

  switch (action) {
    case "invite":
      if (status === "waiting" || status === "claimed") return { available: true };
      if (status === "invited") {
        return {
          available: false,
          reason: "An invitation is already out. Revoke it before sending another.",
        };
      }
      return {
        available: false,
        reason: `This entry is ${label}. Use “${ACTION_LABEL.reinvite}” instead.`,
      };

    case "reinvite":
      if (status === "expired" || status === "released") return { available: true };
      if (status === "invited") {
        return {
          available: false,
          reason: "An invitation is already out. Revoke it before sending another.",
        };
      }
      return {
        available: false,
        reason: `Nothing has been sent yet. Use “${ACTION_LABEL.invite}”.`,
      };

    case "revoke":
      if (status === "invited") return { available: true };
      return {
        available: false,
        reason: `There is no live invitation to revoke — this entry is ${label}.`,
      };

    case "requeue":
      if (status === "released" || status === "expired") return { available: true };
      if (status === "waiting") {
        return { available: false, reason: "They are already in the queue." };
      }
      return {
        available: false,
        reason: `Revoke the invitation first, then return them to the queue.`,
      };

    case "remove":
      // Deliberately broad: a studio may always take someone off its own
      // waitlist, except where the entry is already closed (handled above).
      return { available: true };
  }
}

/** Every action with its verdict, for rendering a menu that shows disabled
 *  entries WITH their reason rather than hiding them. Hiding an action teaches
 *  a practitioner that it does not exist; disabling it with a reason teaches
 *  them when it will. */
export function allActionAvailability(
  status: WaitlistEntryStatus,
): Array<{ action: AdmissionAction; label: string } & ActionAvailability> {
  return ADMISSION_ACTIONS.map((action) => ({
    action,
    label: ACTION_LABEL[action],
    ...actionAvailability(action, status),
  }));
}

// --- 3. EXPIRY (the ONE draft input with a server contract) ------------------
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

// --- 4. THE INVITATION DRAFT, AND WHICH PARTS ARE REAL -----------------------
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
