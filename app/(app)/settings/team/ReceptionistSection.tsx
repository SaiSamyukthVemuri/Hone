import { createClient } from "@/lib/supabase/server";
import { isDeskEnabled } from "@/lib/desk/flag";
import { dbErrorCode } from "@/lib/logging/error-class";
import { revokeInvitationAction } from "./actions";
import { ReceptionistInviteForm, RemoveReceptionistButton } from "./ReceptionistControls";

// The owner's front-desk section of the Team page (Sam, 2 Nov). Owner-only: the page renders this only
// after its own owner check, and every command re-checks the session owner. What it shows:
//   * active receptionists, each with Remove (visible and working with the desk flag OFF);
//   * PENDING receptionist invitations, each with Revoke (the existing role-agnostic revoke);
//   * the invite form, only while the desk flag is ON (a studio cannot be handed the role while dark).
// With the flag off and nothing to show the section renders nothing at all. It reads rows through the owner's
// own session (row-level security: owners read their studio's receptionists and invitations).

type Desk = { id: string; display_name: string; email: string | null };
type Invite = { id: string; email: string; display_name: string | null };

export async function ReceptionistSection({ studioId }: { studioId: string }) {
  const supabase = await createClient();
  const [desk, invites] = await Promise.all([
    supabase
      .from("studio_receptionists")
      .select("id, display_name, email")
      .eq("studio_id", studioId)
      .eq("active", true)
      .order("created_at", { ascending: true }),
    supabase
      .from("pending_invitations")
      .select("id, email, display_name")
      .eq("studio_id", studioId)
      .eq("status", "pending")
      .eq("role", "receptionist")
      .order("created_at", { ascending: false }),
  ]);
  // A failed read is loud, never an empty list that hides someone with access.
  if (desk.error) throw new Error(`Failed to load receptionists: ${dbErrorCode(desk.error)}`);
  if (invites.error) throw new Error(`Failed to load invitations: ${dbErrorCode(invites.error)}`);
  const receptionists = (desk.data ?? []) as Desk[];
  const pending = (invites.data ?? []) as Invite[];
  const enabled = isDeskEnabled();
  if (!enabled && receptionists.length === 0 && pending.length === 0) return null;

  return (
    <section aria-labelledby="front-desk" className="flex flex-col gap-4">
      <div>
        <h2 id="front-desk" className="scroll-mt-24 text-xl font-medium">Front desk</h2>
        <p className="mt-1 text-sm text-neutral-500">
          A receptionist sees the schedule and a restricted client list, nothing clinical or financial. Removing access takes effect
          immediately and also cancels any invitation still waiting for that address.
        </p>
      </div>
      <h3 className="text-sm font-medium">Receptionists</h3>
      {receptionists.length === 0 ? (
        <p className="text-sm text-neutral-500">No receptionist has access.</p>
      ) : (
        <ul className="divide-y divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
          {receptionists.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="font-medium">{r.display_name}</div>
                {r.email && <div className="truncate text-xs text-neutral-500">{r.email}</div>}
              </div>
              <RemoveReceptionistButton id={r.id} name={r.display_name} />
            </li>
          ))}
        </ul>
      )}
      <h3 className="text-sm font-medium">Waiting to accept</h3>
      {pending.length === 0 ? (
        <p className="text-sm text-neutral-500">No receptionist invitation is pending.</p>
      ) : (
        <ul className="divide-y divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
          {pending.map((inv) => (
            <li key={inv.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="font-medium">{inv.email}</div>
                <div className="text-xs text-neutral-500">{inv.display_name ?? "no name set"}</div>
              </div>
              <form action={revokeInvitationAction}>
                <input type="hidden" name="id" value={inv.id} />
                <button
                  type="submit"
                  aria-label={`Revoke the invitation for ${inv.email}`}
                  className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
                >
                  Revoke
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}
      {enabled && <ReceptionistInviteForm />}
    </section>
  );
}
