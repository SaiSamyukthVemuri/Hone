"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";

// ===========================================================================
// NEW-CLIENT WAITLIST — OPERATOR REMOVAL (WAIT-02 surface, 0188 command)
// ===========================================================================
//
// THE ONLY MUTATION THIS SURFACE HAS, and it is not a write from here at all.
// `authenticated` holds SELECT and nothing else on new_client_waitlist_entries
// (migration 0185), so this action cannot issue DML even if it tried to; the
// transition is performed by `remove_new_client_waitlist_entry`, which
// re-derives studio membership AND owner role in the database from the
// authenticated user id.
//
// WHAT THE BROWSER SUPPLIES: one entry id. Nothing else. The studio and the
// actor are resolved server-side from the session, so a forged post can name
// an id but never a tenant, an actor or a role — and the command scopes the
// entry lookup by (id, studio_id), so an id from another studio is simply not
// found.
//
// NOT A DELETE. The row transitions to `removed` with its actor and timestamp
// recorded, and leaves the active queue. Waitlist history is operational
// evidence; physically purging it belongs to an offboarding/retention policy,
// not to a button.
//
// PII. Names, emails and phone numbers never reach a log line here.
// ===========================================================================

/**
 * EVERY result `remove_new_client_waitlist_entry` can return, derived from the
 * command itself in migration 0188 — its own codes, plus the three it propagates
 * from `new_client_waitlist_resolve_owner` whenever that answers anything but
 * `ok`.
 *
 * This list drifted once already. The command was rewritten in 0188 to give the
 * removal ruling distinguishable codes, and the map below still carried 0185's
 * vocabulary: `not_waiting`, which the command can no longer return, while
 * `release_required` and `not_removable` — the two outcomes 0188 added
 * specifically so the operator could be told what to do — fell through to the
 * generic "please try again". Typing the map against this union means the next
 * added code is a compile error rather than a silent generic error.
 */
type RemoveWaitlistEntryResult =
  | "removed"
  | "not_found"
  | "already_removed"
  | "release_required"
  | "not_removable"
  | "not_owner"
  | "not_a_member"
  | "invalid_input";

/**
 * The refusals given their own copy.
 *
 * `invalid_input` is deliberately absent. The command returns it for a null
 * studio, actor or entry id, and all three are guarded above before the RPC is
 * issued — so reaching it means something upstream is broken rather than
 * something the operator can act on, and the generic message is the honest
 * answer. It stays in the union so that assumption is stated rather than
 * implied.
 *
 * `not_owner` and `not_a_member` DO keep copy even though the route checks the
 * role first: the command re-derives membership and role in the database, and a
 * role or membership change committed between that check and this call still
 * arrives here.
 */
const REFUSAL_MESSAGES: Readonly<
  Record<Exclude<RemoveWaitlistEntryResult, "removed" | "invalid_input">, string>
> = {
  not_found: "That waitlist entry no longer exists.",
  already_removed: "That entry has already been removed.",
  release_required: "That entry has been claimed or invited. Release it before removing it.",
  not_removable: "That person is already a client. Converted entries stay in waitlist history.",
  not_owner: "Only studio owners can change the waitlist.",
  not_a_member: "Only studio owners can change the waitlist.",
};

export async function removeWaitlistEntryAction(formData: FormData): Promise<void> {
  const entryId = formData.get("entry_id");
  if (typeof entryId !== "string" || !entryId) {
    throw new Error("Missing waitlist entry.");
  }

  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  // Route-level authority. Deliberately NOT the only check: the command below
  // re-derives the same fact from the database, so this early refusal is a
  // clearer message, never the guarantee.
  if (practitioner.role !== "owner") {
    throw new Error("Only studio owners can change the waitlist.");
  }
  // `practitioners.user_id` is nullable in the schema (a row can exist for an
  // invited practitioner before they sign in). This one was resolved FROM a
  // session, so it is always present — narrowed explicitly rather than passed
  // through as null, which the command would refuse as `invalid_input` and
  // report as a generic failure.
  const actorUserId = practitioner.user_id;
  if (!actorUserId) {
    throw new Error("Could not identify the signed-in practitioner.");
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("remove_new_client_waitlist_entry", {
    p_studio_id: studio.id,
    p_entry_id: entryId,
    p_actor_user_id: actorUserId,
  });

  if (error || data !== "removed") {
    const outcome =
      error?.code ?? (typeof data === "string" ? data : "unknown");
    console.error(
      JSON.stringify({
        event: "waitlist_remove_failed",
        studioId: studio.id,
        outcome,
        timestamp: new Date().toISOString(),
      }),
    );
    const known =
      typeof data === "string"
        ? REFUSAL_MESSAGES[data as keyof typeof REFUSAL_MESSAGES]
        : undefined;
    throw new Error(known ?? "Could not remove that entry. Please try again.");
  }

  revalidatePath("/settings/waitlist");
}

// ===========================================================================
// WAIT-EXPOSE-01 — the lifecycle authority that already shipped
// ===========================================================================
//
// Migrations 0188-0190 shipped the whole practitioner-side lifecycle. Until now
// only public JOIN and operator REMOVAL were surfaced, so five commands the
// database already enforces had no way to be invoked. This block wires exactly
// those five, in the same shape as the removal above.
//
// DELIBERATELY NOT WIRED HERE: `issue_new_client_waitlist_invitation`,
// `redeem_new_client_waitlist_invitation` and
// `record_new_client_waitlist_conversion`. Issuing mints a token that must reach
// a real recipient, and redeeming/converting create a booking — both sit behind
// the recipient-proof and booking authority work (B1/B1.5c + B2). Wiring them
// because the RPC exists would ship a delivery promise this release cannot keep.
//
// THE RPC IS THE AUTHORITY, AND THIS FILE DECIDES NOTHING. No lifecycle rule is
// re-implemented in TypeScript: each action supplies identity, names one
// command, and maps the returned code to copy. Success is compared as a STRING
// rather than inferred from the absence of an error, so a refusal can never be
// read as a success.
//
// `authenticated` holds SELECT only on these tables (0185/0188), so no action
// here can issue DML even if it tried, and every command re-derives studio
// membership AND owner role in the database from the authenticated user id.
//
// PII: names, emails and phone numbers never reach a log line.
// ===========================================================================

/** The codes every command propagates from `new_client_waitlist_resolve_owner`. */
type OwnerResolutionResult = "not_owner" | "not_a_member" | "invalid_input";

/** Copy for the two authority refusals, shared by every command below. They keep
 *  copy even though each route checks the role first: the command re-derives
 *  membership and role in the database, so a change committed between that check
 *  and this call still arrives here. */
const AUTHORITY_REFUSALS = {
  not_owner: "Only studio owners can change the waitlist.",
  not_a_member: "Only studio owners can change the waitlist.",
} as const;

/**
 * Shared plumbing for the four single-entry commands.
 *
 * It carries NO lifecycle knowledge: the command name, its success code and its
 * refusal copy are supplied by the caller, and the ruling is whatever the
 * database returned. What is shared is only the part that must not vary —
 * identity resolution, the owner pre-check, the admin client, the PII-free log
 * line, and the revalidate.
 */
async function runEntryLifecycleCommand(options: {
  rpc: string;
  entryId: string;
  successCode: string;
  event: string;
  refusals: Readonly<Record<string, string>>;
  genericError: string;
}): Promise<void> {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  // Route-level authority. Deliberately NOT the only check: the command
  // re-derives the same fact from the database, so this early refusal is a
  // clearer message, never the guarantee.
  if (practitioner.role !== "owner") {
    throw new Error("Only studio owners can change the waitlist.");
  }
  const actorUserId = practitioner.user_id;
  if (!actorUserId) {
    throw new Error("Could not identify the signed-in practitioner.");
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc(options.rpc, {
    p_studio_id: studio.id,
    p_entry_id: options.entryId,
    p_actor_user_id: actorUserId,
  });

  if (error || data !== options.successCode) {
    const outcome = error?.code ?? (typeof data === "string" ? data : "unknown");
    console.error(
      JSON.stringify({
        event: options.event,
        studioId: studio.id,
        outcome,
        timestamp: new Date().toISOString(),
      }),
    );
    const known = typeof data === "string" ? options.refusals[data] : undefined;
    throw new Error(known ?? options.genericError);
  }

  revalidatePath("/settings/waitlist");
}

/** One entry id from the browser, and nothing else. */
function requiredEntryId(formData: FormData): string {
  const entryId = formData.get("entry_id");
  if (typeof entryId !== "string" || !entryId) {
    throw new Error("Missing waitlist entry.");
  }
  return entryId;
}

// --- CLAIM ONE ---------------------------------------------------------------
// 0189: `claimed` | `not_found` | `not_waiting` + owner codes.

type ClaimEntryResult = "claimed" | "not_found" | "not_waiting" | OwnerResolutionResult;

const CLAIM_REFUSALS: Readonly<
  Record<Exclude<ClaimEntryResult, "claimed" | "invalid_input">, string>
> = {
  not_found: "That waitlist entry no longer exists.",
  not_waiting: "That entry is no longer waiting, so it cannot be claimed.",
  ...AUTHORITY_REFUSALS,
};

export async function claimWaitlistEntryAction(formData: FormData): Promise<void> {
  await runEntryLifecycleCommand({
    rpc: "claim_new_client_waitlist_entry",
    entryId: requiredEntryId(formData),
    successCode: "claimed",
    event: "waitlist_claim_failed",
    refusals: CLAIM_REFUSALS,
    genericError: "Could not claim that entry. Please try again.",
  });
}

// --- RELEASE -----------------------------------------------------------------
// 0189: `released` | `already_redeemed` | `not_releasable` + owner codes.

type ReleaseEntryResult =
  | "released"
  | "already_redeemed"
  | "not_releasable"
  | OwnerResolutionResult;

const RELEASE_REFUSALS: Readonly<
  Record<Exclude<ReleaseEntryResult, "released" | "invalid_input">, string>
> = {
  already_redeemed: "That invitation has already been used. It cannot be released.",
  not_releasable: "Only a claimed or invited entry can be released.",
  ...AUTHORITY_REFUSALS,
};

export async function releaseWaitlistEntryAction(formData: FormData): Promise<void> {
  await runEntryLifecycleCommand({
    rpc: "release_new_client_waitlist_entry",
    entryId: requiredEntryId(formData),
    successCode: "released",
    event: "waitlist_release_failed",
    refusals: RELEASE_REFUSALS,
    genericError: "Could not release that entry. Please try again.",
  });
}

// --- EXPIRE ------------------------------------------------------------------
// 0189: `expired` | `already_redeemed` | `not_invited` | `not_expired` + owner
// codes. `not_expired` is the wall-clock ruling 0189 added — an invitation whose
// window has not run out is not expirable, and the operator is pointed at
// release instead.

type ExpireInvitationResult =
  | "expired"
  | "already_redeemed"
  | "not_invited"
  | "not_expired"
  | OwnerResolutionResult;

const EXPIRE_REFUSALS: Readonly<
  Record<Exclude<ExpireInvitationResult, "expired" | "invalid_input">, string>
> = {
  already_redeemed: "That invitation has already been used.",
  not_invited: "There is no live invitation on that entry.",
  not_expired: "That invitation has not run out yet. Release it instead to take it back.",
  ...AUTHORITY_REFUSALS,
};

export async function expireWaitlistInvitationAction(formData: FormData): Promise<void> {
  await runEntryLifecycleCommand({
    rpc: "expire_new_client_waitlist_invitation",
    entryId: requiredEntryId(formData),
    successCode: "expired",
    event: "waitlist_expire_failed",
    refusals: EXPIRE_REFUSALS,
    genericError: "Could not expire that invitation. Please try again.",
  });
}

// --- REQUEUE -----------------------------------------------------------------
// 0188: `requeued` | `already_active` | `not_requeueable` + owner codes.
//
// `already_active` is a real, reachable outcome rather than a race curiosity:
// requeue is the ONLY transition that re-enters the one-active-per-email partial
// unique index, so someone who rejoined while this entry was away collides here,
// and the command reports it instead of raising a constraint violation.

type RequeueEntryResult =
  | "requeued"
  | "already_active"
  | "not_requeueable"
  | OwnerResolutionResult;

const REQUEUE_REFUSALS: Readonly<
  Record<Exclude<RequeueEntryResult, "requeued" | "invalid_input">, string>
> = {
  already_active: "That person is already on the waitlist again under the same email.",
  not_requeueable: "Only a released or expired entry can be returned to the queue.",
  ...AUTHORITY_REFUSALS,
};

export async function requeueWaitlistEntryAction(formData: FormData): Promise<void> {
  await runEntryLifecycleCommand({
    rpc: "requeue_new_client_waitlist_entry",
    entryId: requiredEntryId(formData),
    successCode: "requeued",
    event: "waitlist_requeue_failed",
    refusals: REQUEUE_REFUSALS,
    genericError: "Could not return that entry to the queue. Please try again.",
  });
}

// --- CLAIM NEXT N ------------------------------------------------------------
// 0189: `claim_new_client_waitlist_entries(p_studio_id, p_actor_user_id,
// p_count)` returns TABLE (result text, entry_id uuid) — one row per claimed
// entry, or a single refusal row.
//
// "NEXT N" IS THE DATABASE'S ORDER, NOT THIS FILE'S. The command walks the
// existing canonical queue ordering. Nothing here sorts, ranks or scores, and no
// id list is sent: choosing WHICH people to claim is the single-entry command,
// called once per person. Merging the two would mean picking queue order on the
// studio's behalf.

const CLAIM_COUNT_MIN = 1;
const CLAIM_COUNT_MAX = 25;

type ClaimManyResult = "claimed" | "invalid_count" | OwnerResolutionResult;

const CLAIM_MANY_REFUSALS: Readonly<
  Record<Exclude<ClaimManyResult, "claimed" | "invalid_input">, string>
> = {
  invalid_count: `Choose between ${CLAIM_COUNT_MIN} and ${CLAIM_COUNT_MAX} people.`,
  ...AUTHORITY_REFUSALS,
};

export async function claimNextWaitlistEntriesAction(formData: FormData): Promise<void> {
  const raw = formData.get("count");
  const count = typeof raw === "string" ? Number(raw.trim()) : NaN;
  // Bounded before the call so an absurd value never becomes a query. The
  // command validates independently and owns the ruling.
  if (!Number.isInteger(count) || count < CLAIM_COUNT_MIN || count > CLAIM_COUNT_MAX) {
    throw new Error(CLAIM_MANY_REFUSALS.invalid_count);
  }

  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (practitioner.role !== "owner") {
    throw new Error("Only studio owners can change the waitlist.");
  }
  const actorUserId = practitioner.user_id;
  if (!actorUserId) {
    throw new Error("Could not identify the signed-in practitioner.");
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("claim_new_client_waitlist_entries", {
    p_studio_id: studio.id,
    p_actor_user_id: actorUserId,
    p_count: count,
  });

  // A SET-RETURNING command needs its own success test. ZERO ROWS IS NOT A
  // FAILURE — it means the queue had nobody left to claim — so success is
  // "no returned row says anything but claimed", and an empty result is a
  // legitimate no-op rather than a generic error.
  const rows = Array.isArray(data) ? (data as Array<{ result?: unknown }>) : null;
  const refused = rows?.find(
    (r) => typeof r.result === "string" && r.result !== "claimed",
  );

  if (error || rows === null || refused) {
    const outcome =
      error?.code ?? (typeof refused?.result === "string" ? refused.result : "unknown");
    console.error(
      JSON.stringify({
        event: "waitlist_claim_next_failed",
        studioId: studio.id,
        outcome,
        // A COUNT is not prospect data: it says how many were asked for and
        // names nobody.
        requested: count,
        timestamp: new Date().toISOString(),
      }),
    );
    const known =
      typeof refused?.result === "string"
        ? CLAIM_MANY_REFUSALS[refused.result as keyof typeof CLAIM_MANY_REFUSALS]
        : undefined;
    throw new Error(known ?? "Could not claim the next entries. Please try again.");
  }

  revalidatePath("/settings/waitlist");
}
