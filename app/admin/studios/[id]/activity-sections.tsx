import { FormattedDateTime } from "@/components/formatted-date-time";
import type { StudioActivity } from "@/lib/admin/studio-activity";
import { STUDIO_ACTIVITY_WINDOW_MS } from "@/lib/admin/studio-activity";
import type { StaffSignInReport, StaffSignInState } from "@/lib/admin/staff-sign-in";

// HON-82. Two separate read-only sections on the operator's studio page. Neither is billing or subscription status, and neither claims
// anyone is online: studio activity is "was the studio's own work recorded lately", and a sign-in is "when this account last signed in".
// Every state is a TEXT label first (never colour alone).

const HOURS = Math.round(STUDIO_ACTIVITY_WINDOW_MS / 3_600_000);

export function StudioActivitySection({ activity }: { activity: StudioActivity }) {
  return (
    <section aria-labelledby="studio-activity-heading">
      <h2 id="studio-activity-heading" className="mb-3 text-xl font-medium">
        Studio activity
      </h2>
      <div className="rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800" data-testid="studio-activity">
        {activity.state === "active" ? (
          <p>
            <span className="rounded bg-emerald-100 px-2 py-0.5 font-medium text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
              Active recently
            </span>{" "}
            <span className="text-neutral-500">
              Last recorded work <FormattedDateTime iso={activity.at} />
            </span>
          </p>
        ) : activity.state === "inactive" ? (
          <p>
            <span className="rounded bg-neutral-100 px-2 py-0.5 font-medium text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
              No recent activity
            </span>{" "}
            <span className="text-neutral-500">
              {activity.at ? (
                <>
                  Last recorded work <FormattedDateTime iso={activity.at} />
                </>
              ) : (
                "No recorded work yet"
              )}
            </span>
          </p>
        ) : (
          <p>
            <span className="rounded bg-neutral-100 px-2 py-0.5 font-medium text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
              Unknown
            </span>{" "}
            <span className="text-neutral-500">The activity could not be read just now.</span>
          </p>
        )}
        <p className="mt-2 text-xs text-neutral-500">
          Recent means recorded work in the last {HOURS} hours (appointments, sessions, treatment blocks, settlements). Only a time is shown, no
          client or clinical content. This is separate from billing and subscription status.
        </p>
      </div>
    </section>
  );
}

function SignInCell({ s }: { s: StaffSignInState }) {
  switch (s.state) {
    case "signed_in":
      return <FormattedDateTime iso={s.at} />;
    case "never_signed_in":
      return <span className="text-neutral-500">Never signed in</span>;
    case "account_removed":
      return <span className="text-neutral-500">Account removed</span>;
    default:
      return <span className="text-neutral-500">Unknown</span>;
  }
}

const ROLE_LABEL = { owner: "Owner", practitioner: "Practitioner", receptionist: "Receptionist" } as const;

function PendingInvites({ counts }: { counts: StaffSignInReport["pendingInvites"] }) {
  if (counts === null) {
    return <p className="mt-2 text-sm text-neutral-500">Pending invitations: unknown, they could not be read just now.</p>;
  }
  if (counts.total === 0) return null;
  const parts = [
    counts.owner ? `${counts.owner} owner` : null,
    counts.practitioner ? `${counts.practitioner} practitioner` : null,
    counts.receptionist ? `${counts.receptionist} receptionist` : null,
  ].filter(Boolean);
  return (
    <p className="mt-2 text-sm text-neutral-700 dark:text-neutral-300" data-testid="pending-invitations">
      {counts.total} {counts.total === 1 ? "invitation" : "invitations"} pending: {parts.join(", ")}. Not yet accepted, so no sign-in to show.
    </p>
  );
}

export function StaffSignInSection({ report }: { report: StaffSignInReport }) {
  return (
    <section aria-labelledby="staff-sign-in-heading">
      <h2 id="staff-sign-in-heading" className="mb-3 text-xl font-medium">
        Staff last sign-in
      </h2>
      {report.unavailable ? (
        <p className="text-sm text-neutral-500" data-testid="staff-sign-in-unavailable">
          Unknown: the staff list could not be read just now.
        </p>
      ) : report.staff.length === 0 ? (
        <p className="text-sm text-neutral-500" data-testid="staff-none-accepted">
          No accepted staff yet.
        </p>
      ) : (
        <ul className="divide-y divide-neutral-200 rounded-lg border border-neutral-200 text-sm dark:divide-neutral-800 dark:border-neutral-800" data-testid="staff-sign-in">
          {report.staff.map((m) => (
            <li key={m.key} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2">
              <span>
                <span className="font-medium">{m.displayName}</span>{" "}
                <span className="text-neutral-500">{ROLE_LABEL[m.role]}</span>
                {m.active ? null : (
                  <span className="ml-2 rounded bg-neutral-100 px-1.5 py-0.5 text-xs font-medium text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
                    Revoked
                  </span>
                )}
              </span>
              <span data-testid="staff-sign-in-time">
                <SignInCell s={m.signIn} />
              </span>
            </li>
          ))}
        </ul>
      )}
      {report.unavailable ? null : <PendingInvites counts={report.pendingInvites} />}
      {report.truncated ? (
        <p className="mt-2 text-xs text-neutral-500">Only the first 50 staff are listed.</p>
      ) : null}
      <p className="mt-2 text-xs text-neutral-500">
        Last successful sign-in for the person&rsquo;s account, the same time on every studio they belong to. It is not presence: it does not
        say anyone is online now, and a long-lived session can look stale. Separate from studio activity and from billing status.
      </p>
    </section>
  );
}
