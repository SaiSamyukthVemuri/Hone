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

// THE CONSUMED-COUNT READER LIVES OUTSIDE THIS MODULE, DELIBERATELY.
//
// This file carries "use server", so every exported async function in it is a
// Server Action the browser can invoke by id. A reader that accepted an
// arbitrary round id and went straight to service-role does not belong behind
// that boundary, however narrow its answer. It now lives in
// lib/waitlist/round-consumption-server.ts behind `import "server-only"`, and
// the page calls it with a round id its OWN RLS-scoped read returned.

/**
 * ACTION-STATE WRAPPERS — the typed result reaches the owner.
 *
 * WHAT THESE REPLACE. The previous wrappers returned `void`, so every refusal --
 * an allowance the parser rejected, a `round_already_open` race, a transport
 * failure, a close the database refused -- looked exactly like a successful
 * no-op: the page re-rendered unchanged and the owner was told nothing. A
 * mutation that did not happen must never be indistinguishable from one that
 * did.
 *
 * `useActionState` is the pattern this codebase already uses for exactly this
 * (app/(auth)/accept-invitation/AcceptForm.tsx), so the shape is
 * (previousState, formData) => nextState and the panel renders the message.
 *
 * The PREVIOUS state is deliberately ignored: each press is judged on its own,
 * and carrying a stale refusal forward would leave an error on screen that no
 * longer describes anything.
 */
export async function startInvitingFormAction(
  _prev: CapacityActionResult | null,
  formData: FormData,
): Promise<CapacityActionResult> {
  return startInvitingAction(formData);
}

export async function closeInvitationsFormAction(
  _prev: CapacityActionResult | null,
  _formData: FormData,
): Promise<CapacityActionResult> {
  return closeInvitationsAction();
}
