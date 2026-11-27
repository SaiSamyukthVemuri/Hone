import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import {
  requirePractitionerWithStudio,
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
import { PendingButton } from "@/components/pending-button";
import { ConfirmActionForm } from "@/components/confirm-action-form";
import { setReceptionistActiveAction } from "./receptionist-actions";

type ReceptionistRow = { id: string; display_name: string; email: string | null; active: boolean };

// Read under the OWNER's own session: the 0216 policy lets an owner read their studio's receptionist rows, and nobody else's.
// The legal identity of a client is not on this row or this page.
async function getReceptionists(studioId: string): Promise<ReceptionistRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("studio_receptionists")
    .select("id, display_name, email, active")
    .eq("studio_id", studioId)
    .order("active", { ascending: false })
    .order("display_name", { ascending: true });
  if (error) throw new Error(`Failed to load the front desk team: ${dbErrorCode(error)}`);
  return (data ?? []) as ReceptionistRow[];
}
import { dbErrorCode } from "@/lib/logging/error-class";
import { OwnerOnlyNotice } from "@/components/settings/view-heading";
import { shouldShowReviewLink } from "@/lib/appointments/review-link";

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
    throw new Error(`Failed to load invitations: ${dbErrorCode(error)}`);
  return (data ?? []) as PendingInvitation[];
}

export default async function TeamSettingsPage() {
  const { practitioner, studio } = await requirePractitionerWithStudio();

  if (practitioner.role !== "owner") {
    return <OwnerOnlyNotice>Only studio owners can manage the team.</OwnerOnlyNotice>;
  }

  const [practitioners, invitations, receptionists] = await Promise.all([
    getPractitionersForStudio(studio.id),
    getPendingInvitations(studio.id),
    getReceptionists(studio.id),
  ]);

  const showReviewLink = await shouldShowReviewLink(studio.id);

  return (
    <div className="flex flex-col gap-12">
      {/* HON-124 item 14: outside every row, so a result announced after a row unmounts is still heard. */}
      <p id="team-live" role="status" aria-live="polite" className="sr-only" />
      <CurrentPractitioners
        practitioners={practitioners}
        currentPractitionerId={practitioner.id}
        showReviewLink={showReviewLink}
      />

      <section className="flex flex-col gap-4">
        <div>
          <h2 id="invite-practitioner" className="scroll-mt-24 text-xl font-medium">
            Invite a practitioner
          </h2>
          <p className="mt-1 text-sm text-neutral-500">
            We don&rsquo;t send the email automatically. Share the message we
            give you with your teammate. They sign in with the same email and
            join your studio.
          </p>
        </div>
        <InviteForm />
      </section>

      <PendingInvitations invitations={invitations} />

      <FrontDesk receptionists={receptionists} />
    </div>
  );
}

function FrontDesk({ receptionists }: { receptionists: ReceptionistRow[] }) {
  const active = receptionists.filter((r) => r.active).length;
  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 id="front-desk" tabIndex={-1} className="scroll-mt-24 text-xl font-medium outline-none">
          Front desk
        </h2>
        <p className="mt-1 text-sm text-neutral-500">
          Receptionists see the schedule and client contact details.
          They never see treatment records, clinical notes, images or payments, and they are never booked as a
          practitioner.
          {receptionists.length === 0 ? " No receptionists yet." : ` ${active} active.`}
        </p>
      </div>
      {receptionists.length > 0 && (
        <ul className="divide-y divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
          {receptionists.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-medium">{r.display_name}</span>
                  <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                    receptionist
                  </span>
                  {!r.active && <span className="text-xs text-neutral-500">inactive</span>}
                </div>
                {r.email && <div className="truncate text-xs text-neutral-500">{r.email}</div>}
              </div>
              {r.active ? (
                <ConfirmActionForm
                  action={setReceptionistActiveAction}
                  fields={{ id: r.id, active: "false" }}
                  triggerLabel="Deactivate"
                  triggerAriaLabel={`Deactivate ${r.display_name}`}
                  title={`Deactivate ${r.display_name}?`}
                  description={`${r.display_name} will lose access to the front desk and the schedule until you reactivate them. Nothing is deleted.`}
                  confirmLabel="Deactivate"
                  busyLabel="Deactivating…"
                  afterSuccess={{ focusId: "front-desk", announceId: "team-live", message: `${r.display_name} was deactivated.` }}
                />
              ) : (
                <form action={setReceptionistActiveAction}>
                  <input type="hidden" name="id" value={r.id} />
                  <input type="hidden" name="active" value={r.active ? "false" : "true"} />
                  {/* PendingButton: the press is acknowledged and the control is disabled while the action runs, so a slow connection cannot show nothing or submit twice. */}
                  <PendingButton variant="secondary" size="sm">
                    {r.active ? "Deactivate" : "Reactivate"}
                  </PendingButton>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-neutral-500">
        Invite a receptionist above by choosing the Receptionist role. They sign in with that email and land on the front desk.
      </p>
    </section>
  );
}

function CurrentPractitioners({
  practitioners,
  currentPractitionerId,
  showReviewLink,
}: {
  showReviewLink: boolean;
  practitioners: Practitioner[];
  currentPractitionerId: string;
}) {
  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 id="practitioners" tabIndex={-1} data-settings-heading className="scroll-mt-24 text-xl font-medium outline-none">
          Practitioners
        </h2>
        <p className="mt-1 text-sm text-neutral-500">
          {practitioners.length === 1
            ? "Just you."
            : `${practitioners.length} active.`}
        </p>
        {showReviewLink && (
          <p className="mt-2 text-sm">
            <Link
              href="/calendar/check-practitioner"
              data-testid="team-review-assignments"
              className="font-medium underline underline-offset-2"
            >
              Review practitioner assignments
            </Link>
            <span className="text-neutral-500"> to check who is recorded on open appointments.</span>
          </p>
        )}
        {/* Sam, DQ-7: a quiet PERMANENT entry, always shown here, whether or not the reminder above is (the reminder appears in addition when
            something needs review). It sits after the owner-only guard of this page (non-owners are stopped before anything renders) and opens a
            page that keeps its own owner guard; it grants nothing. */}
        <p className="mt-2 text-xs text-neutral-500">
          <Link
            href="/calendar/check-practitioner"
            data-testid="team-review-assignments-quiet"
            className="underline underline-offset-2"
          >
            Practitioner assignment review
          </Link>
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
                <ConfirmActionForm
                  action={removePractitionerAction}
                  fields={{ id: p.id }}
                  triggerLabel="Remove"
                  triggerAriaLabel={`Remove ${p.display_name}`}
                  title={`Remove ${p.display_name} from the team?`}
                  description={`${p.display_name} will be deactivated and lose access to this studio. Their existing appointments and records are kept.`}
                  confirmLabel="Remove"
                  busyLabel="Removing…"
                  afterSuccess={{ focusId: "practitioners", announceId: "team-live", message: `${p.display_name} was removed from the team.` }}
                />
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
        <h2 id="pending-invitations" tabIndex={-1} className="scroll-mt-24 text-xl font-medium outline-none">
          Pending invitations
        </h2>
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
              <ConfirmActionForm
                action={revokeInvitationAction}
                fields={{ id: inv.id }}
                triggerLabel="Revoke"
                triggerAriaLabel={`Revoke the invitation for ${inv.email}`}
                title="Revoke this invitation?"
                description={`The invitation sent to ${inv.email} will stop working, so they can no longer join the studio with it. You can invite them again later.`}
                confirmLabel="Revoke invitation"
                busyLabel="Revoking…"
                afterSuccess={{ focusId: "pending-invitations", announceId: "team-live", message: `The invitation for ${inv.email} was revoked.` }}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RoleBadge({ role }: { role: "owner" | "practitioner" | "receptionist" }) {
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
