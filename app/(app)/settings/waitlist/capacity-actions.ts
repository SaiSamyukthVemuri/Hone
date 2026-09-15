"use server";

import { revalidatePath } from "next/cache";

import { createAdminClient } from "@/lib/supabase/admin-server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { parseAllowance } from "@/lib/waitlist/invitation-capacity";

// ===========================================================================
// INVITATION CAPACITY — the owner's open/close controls
// ===========================================================================
//
// These call the commands migration 0192 already ships:
//
//   public.open_new_client_waitlist_admission_round(uuid, uuid, integer)
//   public.close_new_client_waitlist_admission_round(uuid, uuid)
//
// NO MIGRATION, AND NO SECOND AUTHORITY. Both are `security definer`, both
// re-derive the actor through `new_client_waitlist_resolve_owner`, and EXECUTE
// on both is granted to `service_role` alone — so the browser cannot reach them
// and this module is the only application path. The round table itself revokes
// all DML from every browser role, so there is no raw-write alternative either.
//
// The owner check below is therefore a CLEARER MESSAGE, not the guarantee: the
// database refuses a non-owner regardless, and a role that changes under the
// session is refused there rather than here.

export type CapacityActionResult =
  | { ok: true }
  | { ok: false; message: string };

/** Studio and actor from the SESSION, never from the browser. */
async function resolveOwner(): Promise<
  { ok: true; studioId: string; actorUserId: string } | { ok: false; message: string }
> {
  try {
    const { practitioner, studio } = await getCurrentPractitionerWithStudio();
    if (practitioner.role !== "owner") {
      return { ok: false, message: "Only the studio owner can change invitation capacity." };
    }
    // Nullable in the schema for an invited practitioner who has never signed
    // in. This one came FROM a session, so it is present — narrowed rather than
    // passed as null, which the command would refuse as `invalid_input`.
    const actorUserId = practitioner.user_id;
    if (!actorUserId) {
      return { ok: false, message: "Only the studio owner can change invitation capacity." };
    }
    return { ok: true, studioId: studio.id, actorUserId };
  } catch {
    return { ok: false, message: "We couldn't confirm your studio just now. Please try again." };
  }
}

/** The command's own words, translated once. Never rendered raw. */
function openFailureCopy(result: string | null): string {
  switch (result) {
    case "round_already_open":
      return "You already have an invitation capacity open.";
    case "not_owner":
    case "not_a_member":
      return "Only the studio owner can change invitation capacity.";
    case "invalid_input":
      return "Enter how many new clients you're ready to invite.";
    default:
      // A code this surface does not recognise says nothing useful to a
      // practitioner, and echoing it would leak internal vocabulary the way
      // `no_admission_round` did.
      return "We couldn't set your invitation capacity. Please try again.";
  }
}

function closeFailureCopy(result: string | null): string {
  switch (result) {
    case "no_round_open":
      return "You don't have an invitation capacity open.";
    case "not_owner":
    case "not_a_member":
      return "Only the studio owner can change invitation capacity.";
    default:
      return "We couldn't close your invitation capacity. Please try again.";
  }
}

function scalar(data: unknown): string | null {
  const row = Array.isArray(data) ? data[0] : data;
  if (typeof row === "string") return row;
  if (row && typeof row === "object" && "result" in row) {
    const r = (row as { result?: unknown }).result;
    return typeof r === "string" ? r : null;
  }
  return null;
}

/**
 * Open a capacity with the allowance the owner explicitly chose.
 *
 * The allowance is never defaulted or inferred. `parseAllowance` refuses an
 * absent or unreadable value rather than picking one, because a guessed
 * allowance would open a real capacity nobody decided on.
 */
export async function startInvitingAction(formData: FormData): Promise<CapacityActionResult> {
  const allowance = parseAllowance(formData.get("allowance"));
  if (!allowance.ok) return { ok: false, message: allowance.reason };

  const owner = await resolveOwner();
  if (!owner.ok) return { ok: false, message: owner.message };

  try {
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("open_new_client_waitlist_admission_round", {
      p_studio_id: owner.studioId,
      p_actor_user_id: owner.actorUserId,
      p_allowance: allowance.allowance,
    });
    if (error) return { ok: false, message: "We couldn't set your invitation capacity. Please try again." };
    const result = scalar(data);
    if (result !== "opened") return { ok: false, message: openFailureCopy(result) };
    revalidatePath("/settings/waitlist");
    return { ok: true };
  } catch {
    return { ok: false, message: "We couldn't set your invitation capacity. Please try again." };
  }
}

/** Close the open capacity. Never opens another one. */
export async function closeInvitationsAction(): Promise<CapacityActionResult> {
  const owner = await resolveOwner();
  if (!owner.ok) return { ok: false, message: owner.message };

  try {
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("close_new_client_waitlist_admission_round", {
      p_studio_id: owner.studioId,
      p_actor_user_id: owner.actorUserId,
    });
    if (error) return { ok: false, message: "We couldn't close your invitation capacity. Please try again." };
    const result = scalar(data);
    if (result !== "closed") return { ok: false, message: closeFailureCopy(result) };
    revalidatePath("/settings/waitlist");
    return { ok: true };
  } catch {
    return { ok: false, message: "We couldn't close your invitation capacity. Please try again." };
  }
}

/**
 * How many of a round's seats the DATABASE says are used.
 *
 * READ, NEVER RECOMPUTED. `waitlist_admission_round_consumed` is the canonical
 * definition -- it counts a seat as spent when an invitation is redeemed OR is
 * still live and answerable, and getting that wrong in a second place is
 * precisely the competing capacity engine this feature must not become.
 *
 * WHY THIS ONE STILL NEEDS THE ADMIN CLIENT. 0192 revokes EXECUTE on it from
 * public, anon and authenticated and grants it to `service_role` alone, so the
 * owner's own session genuinely cannot call it and there is no user-reachable
 * equivalent. Adding a grant to render a counter would widen the privilege
 * frontier for a display concern. The ROUND ITSELF is read by the page with the
 * owner's own client under the owner RLS policy; only this count comes through
 * here, and it takes a round id the caller already proved it may see.
 *
 * Returns null when the count cannot be established, which callers must treat
 * as "unknown capacity" rather than "zero used".
 */
export async function readRoundConsumed(roundId: string): Promise<number | null> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("waitlist_admission_round_consumed", {
      p_round_id: roundId,
    });
    if (error) return null;
    const used = typeof data === "number" ? data : Number(data);
    return Number.isFinite(used) ? used : null;
  } catch {
    return null;
  }
}

/**
 * Void-returning wrappers, because a `<form action>` consumes no result.
 *
 * The typed actions above keep their results for tests and for any surface that
 * can render one; these exist so the panel can bind a plain server action and
 * re-render from server state after `revalidatePath`.
 */
export async function startInvitingFormAction(formData: FormData): Promise<void> {
  await startInvitingAction(formData);
}

export async function closeInvitationsFormAction(_formData: FormData): Promise<void> {
  await closeInvitationsAction();
}
