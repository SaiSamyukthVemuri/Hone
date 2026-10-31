import Link from "next/link";
import { notFound } from "next/navigation";
import { PendingLink } from "@/components/pending-link";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import { createClient } from "@/lib/supabase/server";
import { startPerfSpan, timed } from "@/lib/observability/perf-timing";
import {
  CLIENT_LIST_VIEWS,
  clientListViewHref,
  parseClientListView,
  type ClientListView,
} from "@/lib/clients/list-view";
import { isStaffRole, projectStaffRow } from "@/lib/clients/directory-rules";
import {
  buildDirectoryRows,
  parseDirectoryParams,
  queryDirectory,
  type DirectoryAggregates,
} from "@/lib/clients/directory-query";
import {
  readCurrentIntake,
  readDirectoryClients,
  readNextAppointments,
  type DirectorySupabase,
} from "@/lib/clients/directory-read";
import { readLastVisits, type LastVisitSupabase } from "@/lib/clients/last-visit";
import {
  ClientOverview,
  DirectoryControls,
  DirectoryResults,
  lastVisitCell,
  type DirectoryState,
} from "./ClientsDirectory";

// Clients directory. Two views (?view=archived, anything else is active). The URL
// carries the whole state: ?q= search, ?filter= (intake_review, no_upcoming),
// ?sort=, ?page=, ?client= (the open overview). Search, filters, sort, count and
// paging run HERE, on the server, over the whole authorized set
// (lib/clients/directory-query.ts); the browser receives one page of rows, never
// the directory. A constant number of reads, none per row (directory-read.ts,
// last-visit.ts). What is searched and displayed is ONE definition
// (lib/clients/directory-rules.ts). Owner and practitioner only: the app has no
// receptionist surface, and the receptionist rules are unwired, tested code.

// The view decision lives in lib/clients/list-view.ts (HON-14).
type View = ClientListView;

export default async function ClientsPage({
  searchParams,
}: {
  // Next 15 App Router: searchParams is async.
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = (await searchParams) ?? {};
  const view = parseClientListView(params.view);
  const archived = view === "archived";
  const query = parseDirectoryParams(params, view);

  // Measurement only (perf/route-timing-baseline).
  const { practitioner, studio } = await timed("clients.identity", () =>
    requirePractitionerWithStudio(),
  );
  // Default deny: only an owner or a practitioner may use this directory.
  if (!isStaffRole(practitioner.role)) notFound();

  const supabase = await createClient();
  const db = supabase as unknown as DirectorySupabase;
  const domain = startPerfSpan("clients.domain");
  const nowIso = new Date().toISOString();

  const [source, nextAppointments, intake] = await Promise.all([
    readDirectoryClients(db, studio.id, archived),
    archived ? Promise.resolve(new Map<string, string>()) : readNextAppointments(db, studio.id, nowIso),
    archived ? Promise.resolve(new Map<string, "in_progress">()) : readCurrentIntake(db, studio.id),
  ]);
  const aggregates: DirectoryAggregates = { nextAppointments, intake };
  const identityRows = source.map(projectStaffRow);
  const data = queryDirectory(identityRows, aggregates, query);

  // The overview's client comes from the same authorized set: an id that is not in
  // this view's set shows nothing and reveals nothing.
  const clientParam = Array.isArray(params.client) ? params.client[0] : params.client;
  const selected = clientParam
    ? buildDirectoryRows(identityRows, aggregates).find((r) => r.id === clientParam) ?? null
    : null;

  // Last visit: ONE batched read for the visible page (plus the open overview).
  const ids = data.rows.map((r) => r.id);
  if (selected && !ids.includes(selected.id)) ids.push(selected.id);
  const lastVisits = archived
    ? null
    : await readLastVisits(supabase as unknown as LastVisitSupabase, studio.id, ids, nowIso);
  const lastVisitMap = lastVisits && lastVisits.ok ? lastVisits.value : null;
  domain.end();

  const state: DirectoryState = { view, q: query.q, filters: query.filters, sort: query.sort };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Clients</h1>
          <p className="mt-1 text-sm text-neutral-500">
            {archived
              ? "Archived clients are hidden from active lists and booking pickers. Historical records are preserved."
              : "Find, review and open your clients."}
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

      <DirectoryControls state={state} />

      {clientParam && !selected && (
        <p role="status" className="text-sm text-neutral-500">
          That client isn&apos;t in this list.
        </p>
      )}
      {selected && (
        <ClientOverview
          state={state}
          row={selected}
          lastVisit={lastVisitCell(lastVisitMap, selected.id)}
          page={data.page}
        />
      )}

      <DirectoryResults
        state={state}
        data={data}
        lastVisits={lastVisitMap}
        selectedId={selected?.id ?? null}
      />
    </div>
  );
}

// Two-link segmented control. Plain anchor links so the active state
// survives a full page navigation; this control just toggles the ?view= param.
function ViewTabs({ current }: { current: View }) {
  const tabs = CLIENT_LIST_VIEWS.map((v) => ({
    ...v,
    href: clientListViewHref(v.value),
  }));
  return (
    <nav
      aria-label="Client list view"
      className="flex w-fit gap-1 rounded-lg border border-neutral-200 bg-neutral-50 p-1 text-sm dark:border-neutral-800 dark:bg-neutral-900"
    >
      {tabs.map((tab) => {
        const active = tab.value === current;
        return (
          <PendingLink
            key={tab.value}
            href={tab.href}
            pendingLabel="Loading clients…"
            aria-current={active ? "page" : undefined}
            className={
              active
                ? "rounded-md bg-white px-3 py-1.5 font-medium text-neutral-900 shadow-sm dark:bg-neutral-950 dark:text-neutral-100"
                : "rounded-md px-3 py-1.5 text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
            }
          >
            {tab.label}
          </PendingLink>
        );
      })}
    </nav>
  );
}
