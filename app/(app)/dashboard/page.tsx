import Link from "next/link";
import {
  getClientsForStudio,
  getCurrentPractitionerWithStudio,
  getTodayRosterForStudio,
} from "@/lib/supabase/queries";
import { getLatestPinnedNoteByClient } from "@/lib/client-pinned-notes/queries";
import { ClientSearch } from "@/components/client-search";
import {
  FormattedDateTime,
  FormattedToday,
} from "@/components/formatted-date-time";

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

export default async function DashboardPage() {
  const { studio } = await getCurrentPractitionerWithStudio();
  const [roster, clients] = await Promise.all([
    getTodayRosterForStudio(studio.id),
    getClientsForStudio(studio.id),
  ]);
  const pinnedByClient = await getLatestPinnedNoteByClient(
    studio.id,
    roster.map((r) => r.client.id),
  );

  return (
    <div className="flex flex-col gap-10">
      <section>
        <p className="text-xs uppercase tracking-wider text-neutral-500">
          <FormattedToday format="weekday-date" />
        </p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Today</h1>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">Roster</h2>
          <Link
            href="/clients/new"
            className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
          >
            + Add client
          </Link>
        </div>

        {roster.length === 0 ? (
          <div className="rounded-lg border border-dashed border-neutral-300 bg-neutral-50 px-5 py-10 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900">
            No sessions scheduled today.
          </div>
        ) : (
          <ul className="divide-y divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
            {roster.map(({ client, sessions }) => {
              const pinned = pinnedByClient.get(client.id);
              return (
                <li key={client.id}>
                  <Link
                    href={`/clients/${client.id}`}
                    className="flex items-center justify-between gap-3 px-4 py-4 hover:bg-neutral-50 dark:hover:bg-neutral-900"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{client.name}</div>
                      <div className="truncate text-xs text-neutral-500">
                        {sessions.map((s, i) => (
                          <span key={s.id}>
                            {i > 0 && "   "}
                            <FormattedDateTime
                              iso={s.started_at}
                              format="time"
                            />
                            {" · "}
                            {s.modality}
                          </span>
                        ))}
                      </div>
                      {pinned && (
                        <div
                          className="mt-1 truncate text-xs text-amber-800 dark:text-amber-300"
                          title={pinned.text}
                        >
                          <span className="font-semibold uppercase tracking-wider text-[10px]">
                            Pinned
                          </span>{" "}
                          {truncate(pinned.text, 40)}
                        </div>
                      )}
                    </div>
                    <span className="text-sm text-neutral-400">›</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">Find a client</h2>
        <ClientSearch
          clients={clients}
          excludeIds={roster.map((r) => r.client.id)}
          searchOnly
          placeholder="Find client"
          promptLabel="Type to search clients."
          emptyLabel="No clients match."
        />
      </section>
    </div>
  );
}
