import type { createClient } from "./server";

export async function invitationDestination(
  supabase: Awaited<ReturnType<typeof createClient>>,
  next: string,
) {
  let dest = next;
  let clearSelection = false;
  try {
    const { data: rec } = await supabase.rpc("reconcile_my_pending_invitation");
    const status =
      rec && typeof rec === "object"
        ? (rec as { status?: string; choose_studio?: boolean; role?: string })
        : null;
    if (status?.status === "acceptance_required") {
      dest = "/accept-invitation";
    } else if (status?.status === "conflict") {
      dest = "/no-access?reason=invite-conflict";
    } else if (status?.status === "ambiguous") {
      dest = "/no-access?reason=invite-ambiguous";
    } else if (
      (status?.status === "linked" || status?.status === "already_linked") &&
      status.role === "receptionist" &&
      process.env.HONE_RECEPTIONIST_DESK_ENABLED === "true"
    ) {
      clearSelection = status.choose_studio === true;
      dest = clearSelection ? "/desk/choose" : "/desk";
    } else if (
      (status?.status === "linked" || status?.status === "already_linked") &&
      status?.choose_studio === true
    ) {
      // Newly a multi-studio user: force a truthful chooser (clear any
      // selection; middleware routes 2+ memberships w/o selection there).
      dest = "/dashboard";
      clearSelection = true;
    }
  } catch {
    // Never block sign-in on reconciliation.
  }

  return { dest, clearSelection };
}
