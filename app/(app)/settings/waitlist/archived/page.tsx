import Link from "next/link";
import { OwnerOnlyNotice } from "@/components/settings/view-heading";
import { InvitationFacts } from "@/components/waitlist/invitation-facts";
import { ReplyContactDetails } from "@/components/waitlist/reply-contact";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import { ARCHIVED_LIMIT, listArchivedEntries } from "@/lib/waitlist/entry-search";
import { loadInvitationHistory } from "@/lib/waitlist/invitation-history-server";
import { loadReplyContacts } from "@/lib/waitlist/reply-contact";

// Archived = entries an owner removed from the waitlist. OWNER ONLY and read-only: no action here changes an entry, brings anyone
// back, resolves a response or sends anything (a Return action is a separate, deliberate change). An archived entry keeps its contact,
// join date and invitation history; none of it counts toward the active queue, and a removed entry cannot be claimed or invited.
export const dynamic = "force-dynamic";

function day(iso: string | null, timeZone: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", year: "numeric" }).format(d);
  } catch {
    return null;
  }
}

export default async function WaitlistArchivedPage() {
  const { practitioner, studio } = await requirePractitionerWithStudio();
  if (practitioner.role !== "owner") {
    return <OwnerOnlyNotice>Only studio owners can see archived waitlist entries.</OwnerOnlyNotice>;
  }
  const list = await listArchivedEntries(studio.id);
  const ids = list.kind === "ok" ? list.entries.map((e) => e.id) : [];
  const [history, contacts] = await Promise.all([
    list.kind === "ok" ? loadInvitationHistory(studio.id, ids) : null,
    list.kind === "ok" ? loadReplyContacts(studio.id, ids) : null,
  ]);
  const tz = studio.timezone ?? "UTC";
  const now = Date.now();
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4 p-4 text-sm">
      <h1 className="text-lg font-medium">Archived waitlist entries</h1>
      <p>
        These people were removed from the waitlist. They are not in the queue and cannot be invited. Their contact details, join date and
        invitation history are kept here.
      </p>
      {list.kind === "unknown" ? <p role="status">We couldn&rsquo;t load the archive just now. Please try again.</p> : null}
      {list.kind === "ok" && list.entries.length === 0 ? <p>No archived entries.</p> : null}
      {list.kind === "ok" && list.capped ? <p role="status">Showing the {ARCHIVED_LIMIT} most recently removed. Search by name to find others.</p> : null}
      {list.kind === "ok" && list.entries.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {list.entries.map((e) => {
            const removed = day(e.removedAt, tz);
            const joined = day(e.joinedAt, tz);
            return (
              <li key={e.id} className="rounded-lg border p-3" data-entry-id={e.id} data-testid="archived-entry">
                <p className="font-medium break-words">{e.name}</p>
                <p className="text-neutral-600" data-testid="archived-when">
                  {joined ? `Joined ${joined}. ` : "Join date not recorded. "}
                  {removed ? `Removed on ${removed}${e.removedByRecorded ? " by an owner" : ""}.` : "Removal date not recorded."} Reason not recorded.
                </p>
                <ReplyContactDetails
                  entryId={e.id}
                  contact={contacts?.kind === "ok" ? (contacts.byEntry.get(e.id) ?? null) : null}
                  showEntryLink={false}
                />
                <InvitationFacts entryId={e.id} history={history?.kind === "ok" ? (history.byEntry.get(e.id) ?? []) : null} timeZone={tz} nowMs={now} />
              </li>
            );
          })}
        </ul>
      ) : null}
      <p className="flex gap-4">
        <Link href="/settings/waitlist/search" className="underline">
          Search the waitlist
        </Link>
        <Link href="/settings/waitlist" className="underline">
          Back to the waitlist
        </Link>
      </p>
    </main>
  );
}
