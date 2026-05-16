import { createClient } from "@/lib/supabase/server";
import {
  getCurrentPractitionerWithStudio,
  getPractitionersForStudio,
} from "@/lib/supabase/queries";
import type {
  PendingInvitation,
  Practitioner,
} from "@/lib/types/database";
import { InviteForm } from "./InviteForm";
import {
  removePractitionerAction,
  revokeInvitationAction,
} from "./actions";

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.floor(days / 365);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}

async function getPendingInvitations(
  studioId: string,
): Promise<PendingInvitation[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("pending_invitations")
    .select("*")
    .eq("studio_id", studioId)
    .eq("status", "pending")
    .order("created_at", { ascending: false });
  if (error)
    throw new Error(`Failed to load invitations: ${error.message}`);
  return (data ?? []) as PendingInvitation[];
}

export default async function TeamSettingsPage() {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();

  if (practitioner.role !== "owner") {
    return (
      <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-6 text-sm text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
        Only studio owners can manage the team.
      </div>
    );
  }

  const [practitioners, invitations] = await Promise.all([
    getPractitionersForStudio(studio.id),
    getPendingInvitations(studio.id),
  ]);

  return (
    <div className="flex flex-col gap-12">
      <CurrentPractitioners
        practitioners={practitioners}
        currentPractitionerId={practitioner.id}
      />

      <section className="flex flex-col gap-4">
        <div>
          <h2 className="text-xl font-medium">Invite a practitioner</h2>
          <p className="mt-1 text-sm text-neutral-500">
            We don&rsquo;t send the email automatically. Share the message we
            give you with your teammate. They sign in with the same email and
            join your studio.
          </p>
        </div>
        <InviteForm />
      </section>

      <PendingInvitations invitations={invitations} />
    </div>
  );
}

function CurrentPractitioners({
  practitioners,
  currentPractitionerId,
}: {
  practitioners: Practitioner[];
  currentPractitionerId: string;
}) {
  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="text-xl font-medium">Practitioners</h2>
        <p className="mt-1 text-sm text-neutral-500">
          {practitioners.length === 1
            ? "Just you."
            : `${practitioners.length} active.`}
        </p>
      </div>
      <ul className="divide-y divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
        {practitioners.map((p) => {
          const isSelf = p.id === currentPractitionerId;
          return (
            <li
              key={p.id}
              className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-medium">
                    {p.display_name}
                    {isSelf && (
                      <span className="ml-2 text-xs text-neutral-500">
                        (You)
                      </span>
                    )}
                  </span>
                  <RoleBadge role={p.role} />
                </div>
                <div className="truncate text-xs text-neutral-500">
                  {p.email}
                </div>
              </div>
              {p.role !== "owner" && !isSelf && (
                <form action={removePractitionerAction}>
                  <input type="hidden" name="id" value={p.id} />
                  <button
                    type="submit"
                    className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
                  >
                    Remove
                  </button>
                </form>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function PendingInvitations({
  invitations,
}: {
  invitations: PendingInvitation[];
}) {
  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="text-xl font-medium">Pending invitations</h2>
        <p className="mt-1 text-sm text-neutral-500">
          {invitations.length === 0
            ? "Nothing pending."
            : `${invitations.length} waiting.`}
        </p>
      </div>
      {invitations.length > 0 && (
        <ul className="divide-y divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
          {invitations.map((inv) => (
            <li
              key={inv.id}
              className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-medium">{inv.email}</span>
                  <RoleBadge role={inv.role} />
                </div>
                <div className="text-xs text-neutral-500">
                  {inv.display_name ? (
                    inv.display_name
                  ) : (
                    <em>no name set</em>
                  )}
                  {" · invited "}
                  {relativeTime(inv.created_at)}
                </div>
              </div>
              <form action={revokeInvitationAction}>
                <input type="hidden" name="id" value={inv.id} />
                <button
                  type="submit"
                  className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
                >
                  Revoke
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RoleBadge({ role }: { role: "owner" | "practitioner" }) {
  return (
    <span
      className={`rounded-sm px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${
        role === "owner"
          ? "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900"
          : "border border-neutral-300 text-neutral-600 dark:border-neutral-700 dark:text-neutral-400"
      }`}
    >
      {role}
    </span>
  );
}
