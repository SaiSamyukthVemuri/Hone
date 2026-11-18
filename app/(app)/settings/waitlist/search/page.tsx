import Link from "next/link";
import { OwnerOnlyNotice } from "@/components/settings/view-heading";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import { normalizeQuery, searchWaitlistEntries, SEARCH_LIMIT, SEARCH_MAX } from "@/lib/waitlist/entry-search";
import { describeInvitation } from "@/lib/waitlist/invitation-history";
import { loadInvitationHistory } from "@/lib/waitlist/invitation-history-server";

// Search the waitlist by name across Active, Released and Archived. OWNER ONLY, read-only: nothing here changes an entry, resolves a
// response or sends anything. Each person is shown with the section they are in now and the invitation facts the database recorded.
export const dynamic = "force-dynamic";

export default async function WaitlistSearchPage({ searchParams }: { searchParams?: Promise<{ q?: string | string[] }> }) {
  const { practitioner, studio } = await requirePractitionerWithStudio();
  if (practitioner.role !== "owner") {
    return <OwnerOnlyNotice>Only studio owners can search the waitlist.</OwnerOnlyNotice>;
  }
  const raw = (await searchParams)?.q;
  const query = normalizeQuery(Array.isArray(raw) ? raw[0] : raw);
  const result = query ? await searchWaitlistEntries(studio.id, query) : null;
  const history =
    result?.kind === "ok" ? await loadInvitationHistory(studio.id, result.hits.map((h) => h.id)) : null;
  const tz = studio.timezone ?? "UTC";
  const now = Date.now();
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4 p-4 text-sm">
      <h1 className="text-lg font-medium">Search the waitlist</h1>
      <form method="get" className="flex flex-wrap items-end gap-2" role="search">
        <label className="flex flex-col gap-1">
          <span>Name</span>
          <input name="q" defaultValue={query ?? ""} maxLength={SEARCH_MAX} className="min-h-[44px] rounded-md border px-3" />
        </label>
        <button type="submit" className="min-h-[44px] rounded-md border px-3">
          Search
        </button>
      </form>
      {!query ? <p>Type at least two letters of a name. Active, Released and Archived entries are searched.</p> : null}
      {result?.kind === "unknown" ? <p role="status">We couldn&rsquo;t search just now. Please try again.</p> : null}
      {result?.kind === "ok" && result.hits.length === 0 ? <p>No one on the waitlist matches that name.</p> : null}
      {result?.kind === "ok" && result.capped ? (
        <p role="status">Showing the first {SEARCH_LIMIT} matches. Type more of the name to narrow it.</p>
      ) : null}
      {result?.kind === "ok" && result.hits.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {result.hits.map((h) => {
            const invs = history?.kind === "ok" ? (history.byEntry.get(h.id) ?? []) : null;
            return (
              <li key={h.id} className="rounded-lg border p-3" data-entry-id={h.id} data-testid="search-hit">
                <p className="font-medium break-words">{h.name}</p>
                <p data-testid="search-section">
                  Section: <strong>{h.section ?? "Unknown"}</strong>
                </p>
                {invs === null ? (
                  <p role="status">Invitation history is unavailable just now.</p>
                ) : invs.length === 0 ? (
                  <p className="text-neutral-600">No invitation has been sent.</p>
                ) : (
                  <ul className="mt-1 flex flex-col gap-2">
                    {invs.map((f) => {
                      const d = describeInvitation(f, tz, now);
                      return (
                        <li key={f.invitationId} data-testid="invitation-fact">
                          <p className="font-medium">{d.outcome}</p>
                          <dl className="grid grid-cols-[auto_1fr] gap-x-3">
                            {d.facts.map((x) => (
                              <div key={x.label} className="contents">
                                <dt className="text-neutral-600">{x.label}</dt>
                                <dd>{x.value}</dd>
                              </div>
                            ))}
                          </dl>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
      <Link href="/settings/waitlist" className="underline">
        Back to the waitlist
      </Link>
    </main>
  );
}
