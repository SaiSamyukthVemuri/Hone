import Link from "next/link";
import { OwnerOnlyNotice } from "@/components/settings/view-heading";
import { InvitationFacts } from "@/components/waitlist/invitation-facts";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import { listReleasedEntries, RELEASED_LIMIT } from "@/lib/waitlist/entry-search";
import { loadInvitationHistory } from "@/lib/waitlist/invitation-history-server";

// Released and expired entries with the invitation facts the database recorded. OWNER ONLY and read-only: nothing here changes an
// entry, resolves a response or sends anything. Facts only: the deadline and the "expiry recorded at" time are separate, a release
// reads "reason not recorded", and nothing is inferred.
export const dynamic = "force-dynamic";

export default async function WaitlistReleasedPage() {
  const { practitioner, studio } = await requirePractitionerWithStudio();
  if (practitioner.role !== "owner") {
    return <OwnerOnlyNotice>Only studio owners can see the waitlist history.</OwnerOnlyNotice>;
  }
  const list = await listReleasedEntries(studio.id);
  const history = list.kind === "ok" ? await loadInvitationHistory(studio.id, list.hits.map((h) => h.id)) : null;
  const tz = studio.timezone ?? "UTC";
  const now = Date.now();
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4 p-4 text-sm">
      <h1 className="text-lg font-medium">Released and expired history</h1>
      <p>These people are still on the waitlist record. Only what was recorded is shown; nothing is inferred.</p>
      {list.kind === "unknown" ? <p role="status">We couldn&rsquo;t load the history just now. Please try again.</p> : null}
      {list.kind === "ok" && list.hits.length === 0 ? <p>No released or expired entries.</p> : null}
      {list.kind === "ok" && list.capped ? <p role="status">Showing the first {RELEASED_LIMIT}.</p> : null}
      {list.kind === "ok" && list.hits.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {list.hits.map((h) => (
            <li key={h.id} className="rounded-lg border p-3" data-entry-id={h.id} data-testid="released-entry">
              <p className="font-medium break-words">{h.name}</p>
              <p className="text-neutral-600">{h.status === "expired" ? "Section: Expired" : "Section: Released"}</p>
              <InvitationFacts entryId={h.id} history={history?.kind === "ok" ? (history.byEntry.get(h.id) ?? []) : null} timeZone={tz} nowMs={now} />
            </li>
          ))}
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
