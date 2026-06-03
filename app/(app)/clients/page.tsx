import Link from "next/link";
import {
  getArchivedClientsForStudio,
  getClientsForStudio,
  getCurrentPractitionerWithStudio,
} from "@/lib/supabase/queries";
import { ClientSearch } from "@/components/client-search";
import { ArchivedClientsList } from "./ArchivedClientsList";

// Clients page. Two views: active (default) and archived. Selected
// via ?view=archived; anything else (missing, "active", garbage)
// renders the active list so deep links from the rest of the app
// still resolve to the familiar surface. The list itself comes from
// two separate queries -- getClientsForStudio for active,
// getArchivedClientsForStudio for archived -- so loading one view
// never touches the other's row set. Active uses the existing
// ClientSearch typeahead; archived uses a plain server-rendered list
// because that surface is small and search is not the operative
// interaction (the practitioner is there to find a specific row they
// just archived, ordered most-recently-archived first).

type View = "active" | "archived";

function parseView(raw: string | string[] | undefined): View {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === "archived" ? "archived" : "active";
}

export default async function ClientsPage({
  searchParams,
}: {
  // Next 15 App Router: searchParams is async.
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = (await searchParams) ?? {};
  const view = parseView(params.view);

  const { studio } = await getCurrentPractitionerWithStudio();
  const [activeClients, archivedClients] =
    view === "archived"
      ? [[], await getArchivedClientsForStudio(studio.id)]
      : [await getClientsForStudio(studio.id), []];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Clients</h1>
          <p className="mt-1 text-sm text-neutral-500">
            {view === "active"
              ? activeClients.length === 0
                ? "No clients yet."
                : `${activeClients.length} ${
                    activeClients.length === 1 ? "client" : "clients"
                  }`
              : archivedClients.length === 0
                ? "No archived clients."
                : `${archivedClients.length} archived`}
          </p>
        </div>
        <Link
          href="/clients/new"
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          + Add client
        </Link>
      </div>

      <ViewTabs current={view} />

      {view === "active" ? (
        <ClientSearch clients={activeClients} emptyLabel="No clients yet." />
      ) : (
        <>
          <p className="text-xs text-neutral-500">
            Archived clients are hidden from active lists and booking
            pickers. Historical records are preserved.
          </p>
          <ArchivedClientsList clients={archivedClients} />
        </>
      )}
    </div>
  );
}

// Two-link segmented control. Plain anchor links so the active state
// survives a full page navigation (the list itself comes from the
// query above; this control just toggles the ?view= param). Active
// link is heavier; inactive link is muted; both share the same touch
// target so a phone tap lands cleanly.
function ViewTabs({ current }: { current: View }) {
  const tabs: ReadonlyArray<{ value: View; label: string; href: string }> = [
    { value: "active", label: "Active clients", href: "/clients?view=active" },
    {
      value: "archived",
      label: "Archived clients",
      href: "/clients?view=archived",
    },
  ];
  return (
    <nav
      aria-label="Client list view"
      className="flex w-fit gap-1 rounded-lg border border-neutral-200 bg-neutral-50 p-1 text-sm dark:border-neutral-800 dark:bg-neutral-900"
    >
      {tabs.map((tab) => {
        const active = tab.value === current;
        return (
          <Link
            key={tab.value}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={
              active
                ? "rounded-md bg-white px-3 py-1.5 font-medium text-neutral-900 shadow-sm dark:bg-neutral-950 dark:text-neutral-100"
                : "rounded-md px-3 py-1.5 text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
            }
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
