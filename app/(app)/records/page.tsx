import Link from "next/link";
import { buttonClasses } from "@/components/ui/button";
import { NAV_ROW_FEEDBACK, NAV_ROW_FOCUS, TEXT_LINK_FEEDBACK, cx } from "@/components/ui/control-base";
import { PendingLink } from "@/components/pending-link";
import {
  getClientsForStudio,
  requirePractitionerWithStudio,
  getPractitionersForStudio,
} from "@/lib/supabase/queries";
import { todayInTz } from "@/lib/booking/tz";
import {
  disinfectantDueStatus,
  disinfectantStatusLabel,
  isDisinfectantAlert,
} from "@/lib/record-keeping/disinfectant-status";
import {
  getAuditEventsByRecord,
  getLotTraceability,
  normalizeLotSearch,
  getClientProcedureRecords,
  getDisinfectantRecordForNotice,
  getDisinfectantRecords,
  getExposureIncidentRecords,
  getProcedureAuditEvents,
  getSterileItemRecords,
  normalizeProcedureRecordFilter,
  utcInstantsForLocalDayRange,
  FILTERED_PROCEDURE_RECORD_LIMIT,
  UNFILTERED_PROCEDURE_RECORD_LIMIT,
} from "@/lib/record-keeping/queries";
import {
  isSupplyDiscarded,
  summarizeSupplyExpiry,
  supplyExpiryLabel,
  supplyExpiryState,
} from "@/lib/record-keeping/expiry";
import type { RecordKeepingAuditEvent } from "@/lib/types/database";
import {
  addDisinfectantRecordAction,
  addExposureIncidentRecordAction,
  addSterileItemRecordAction,
  markAftercareExplainedAction,
  updateDisinfectantRecordAction,
  updateExposureIncidentRecordAction,
  updateSterileItemRecordAction,
} from "./actions";
import {
  AddDisinfectantForm,
  AddExposureIncidentForm,
  AddSterileItemForm,
  AftercareExplainedToggle,
  EditDisinfectantForm,
  EditExposureIncidentForm,
  EditSterileItemForm,
} from "./record-forms";
import { FormattedDateTime } from "@/components/formatted-date-time";
import { startPerfSpan, timed } from "@/lib/observability/perf-timing";
import { recoverRecordsRead } from "@/lib/record-keeping/section-recovery";
import {
  disinfectantRecordAnchor,
  placeFocusedRecord,
  resolveFocusedDisinfectantId,
} from "@/lib/record-keeping/disinfectant-focus";
import { RefreshRetryButton } from "./refresh-retry-button";

// PR #205 (migration 0085): Record Keeping. Hone's health-inspection
// operational logbook, built from Chloe's BodySafe / health-inspection
// sample forms. A TOP-LEVEL app area (deliberately not under
// Settings), studio-scoped behind the standard (app) auth layout +
// is_studio_member RLS on every record table. Four sections:
//   1. Sterile Items       ("Commercially Purchased Prepackaged and
//                            Sterile Items Records")
//   2. Disinfectants       ("Disinfectant Records")
//   3. Exposure Incidents  ("Accidental Blood/Body Fluid Exposure
//                            Records"; SENSITIVE, never public)
//   4. Procedure records   (prints as "Client Record for Invasive
//      Procedures"; GENERATED from existing client/session/treatment
//      area data, including probe lot numbers; missing values render
//      as "Not recorded", never invented)
// This is record keeping support, not a legal compliance guarantee.

const SECTIONS = [
  {
    key: "sterile", label: "Sterile Items", add: "Log purchase",
    description: "Purchased stock, expiry dates and the sessions linked to each lot.",
    icon: "M3 7l9-5 9 5-9 5z M3 7v10l9 5 9-5V7 M12 12v10 M7 5l9 5",
  },
  {
    key: "disinfectants", label: "Disinfectants", add: "Log batch",
    description: "Prepared batches, replacement dates and disposal history.",
    icon: "M8 3h8 M9 3v5l-5 9a2 2 0 0 0 2 3h12a2 2 0 0 0 2-3l-5-9V3 M7 14h10",
  },
  {
    key: "incidents", label: "Exposure Incidents", add: "Report incident",
    description: "Accidental blood or body fluid exposures reported in your studio.",
    icon: "M12 3l8 3v6c0 4-4 8-8 10-4-2-8-6-8-10V6z M12 8v5 M12 16h.01",
  },
  {
    key: "procedures", label: "Procedure records", add: null,
    description: "Review recorded sessions or prepare a procedure record for one client.",
    icon: "M8 4H5v17h14V4h-3 M9 3h6v4H9z M8 11h8 M8 15h6",
  },
] as const;
type SectionKey = (typeof SECTIONS)[number]["key"];

function isSection(v: string | undefined): v is SectionKey {
  return (
    v === "sterile" ||
    v === "disinfectants" ||
    v === "incidents" ||
    v === "procedures"
  );
}

function NotRecorded() {
  return <span className="text-neutral-400">Not recorded</span>;
}

function dateOnly(d: string | null): string | null {
  if (!d) return null;
  return d.slice(0, 10);
}

// PR #206 (migration 0086): append-only audit history. Events are
// written exclusively by DB triggers; this is read-only display.
const AUDIT_ACTION_LABELS: Record<RecordKeepingAuditEvent["action"], string> = {
  created: "Created",
  updated: "Updated",
  aftercare_marked: "Marked: risks explained and aftercare provided",
  aftercare_cleared: "Cleared: risks/aftercare mark removed",
  probe_lot_updated: "Probe lot number updated",
};

// The audit trail is append-only and written exclusively by database triggers,
// so "No history recorded yet." is a CLINICAL CLAIM: it states that nothing was
// ever done to this record. It may therefore only be printed when the read that
// would have found events actually ran. `unavailable` is checked FIRST and wins
// over the empty branch for exactly that reason — see AuditHistoryByRecord in
// lib/record-keeping/queries.ts.
function AuditHistoryList({
  events,
  unavailable = false,
}: {
  events: RecordKeepingAuditEvent[] | undefined;
  unavailable?: boolean;
}) {
  if (unavailable) {
    return (
      <p className="text-xs text-amber-700 dark:text-amber-500">
        History could not be loaded. Refresh to try again; this does not mean no
        history was recorded.
      </p>
    );
  }
  if (!events || events.length === 0) {
    return <p className="text-xs text-neutral-500">No history recorded yet.</p>;
  }
  return (
    <ul className="flex flex-col gap-1.5 text-xs text-neutral-600 dark:text-neutral-400">
      {events.map((e) => (
        <li key={e.id}>
          <FormattedDateTime iso={e.created_at} />
          {" · "}
          <span className="font-medium">
            {e.actor_display_name ?? "Unknown"}
          </span>
          {" · "}
          {AUDIT_ACTION_LABELS[e.action] ?? e.action}
          {e.action === "updated" && e.changed_fields.length > 0 && (
            <span className="text-neutral-500">
              {" "}
              ({e.changed_fields.join(", ")})
            </span>
          )}
          {e.action === "probe_lot_updated" && (
            <span className="text-neutral-500">
              {" "}
              ({String(e.changes?.probe_lot_number?.old ?? "none")} {"->"}{" "}
              {String(e.changes?.probe_lot_number?.new ?? "none")})
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function RowTools({
  editForm,
  editOpen = false,
  events,
  historyUnavailable = false,
}: {
  editForm: React.ReactNode;
  // HON-12: render the Edit form already open (the overdue notice's target row).
  editOpen?: boolean;
  events: RecordKeepingAuditEvent[] | undefined;
  historyUnavailable?: boolean;
}) {
  return (
    <div className="mt-1 flex flex-col gap-1">
      <details open={editOpen}>
        <summary className="cursor-pointer text-xs text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100">
          Edit
        </summary>
        <div className="mt-3 rounded-md border border-neutral-200 p-4 dark:border-neutral-800">
          {editForm}
        </div>
      </details>
      <details>
        <summary className="cursor-pointer text-xs text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100">
          History
        </summary>
        <div className="mt-2">
          <AuditHistoryList events={events} unavailable={historyUnavailable} />
        </div>
      </details>
    </div>
  );
}

// RECORDS-SECTION-RECOVERY: fixed copy only, never the error's message.
function SectionUnavailable() {
  return (
    <section
      role="alert"
      data-testid="records-section-unavailable"
      className="flex flex-col gap-2 rounded-lg border border-amber-300 bg-amber-50 p-5 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
    >
      <p className="font-medium">This section could not be loaded.</p>
      <p>
        Nothing is shown because the read failed, not because there are no
        records.
      </p>
      <RefreshRetryButton className="self-start font-medium underline" />
    </section>
  );
}

export default async function RecordKeepingPage({
  searchParams,
}: {
  searchParams: Promise<{
    section?: string;
    lot?: string;
    view?: string;
    stock?: string;
    record?: string;
    clientId?: string;
    from?: string;
    to?: string;
  }>;
}) {
  const sp = await searchParams;
  const section: SectionKey = isSection(sp.section) ? sp.section : "sterile";
  const book = SECTIONS.find((item) => item.key === section)!;
  const adding = sp.view === "add" && book.add !== null;
  // PR #213: probe lot traceability search (exact normalized match).
  const lotSearch = normalizeLotSearch(sp.lot);
  const tracingLot = section === "sterile" && Boolean(lotSearch) && !adding;
  // Measurement only (perf/route-timing-baseline).
  const { practitioner, studio } = await timed("records.identity", () =>
    requirePractitionerWithStudio(),
  );
  // PR #222: exposure incident HISTORY is owner-only (RLS-enforced by
  // migration 0088); any member may still file a new incident.
  const isOwner = practitioner.role === "owner";
  // PR #223: per-client procedure record filter (inspection/transfer
  // pull). Params are sanitized; date bounds are interpreted in the
  // STUDIO timezone so a day means the studio's day, not UTC's.
  const procedureFilter = normalizeProcedureRecordFilter({
    clientId: sp.clientId,
    from: sp.from,
    to: sp.to,
  });
  const procedureFilterQuery = [
    procedureFilter.clientId ? `&clientId=${procedureFilter.clientId}` : "",
    procedureFilter.from ? `&from=${procedureFilter.from}` : "",
    procedureFilter.to ? `&to=${procedureFilter.to}` : "",
  ].join("");

  // RECORDS-SECTION-RECOVERY: the active section is rendered HERE, inside a
  // catch, so a failed read costs that section only. The title and the tab
  // nav still render, and the panel below says the read failed. It is never
  // an empty table. Calling the section directly (not as <Section />) is what
  // lets its throw be caught on this page.
  const body = await recoverRecordsRead("records", section, async () => {
    switch (section) {
      case "sterile":
        return SterileItemsSection({
          studioId: studio.id,
          lotSearch,
          adding,
          stock: sp.stock,
          timezone: studio.timezone,
        });
      case "disinfectants":
        return DisinfectantsSection({
          studioId: studio.id,
          focusRecordId: sp.record,
          adding,
          stock: sp.stock,
          currentPractitionerId: practitioner.id,
          timezone: studio.timezone,
        });
      case "incidents":
        return ExposureIncidentsSection({ studioId: studio.id, isOwner, adding });
      case "procedures":
        return ClientProcedureRecordsSection({
          studioId: studio.id,
          timezone: studio.timezone,
          filter: procedureFilter,
        });
    }
  });

  return (
    <div className="grid min-w-0 gap-6 lg:grid-cols-[12rem_minmax(0,1fr)] lg:gap-8">
      <aside className="min-w-0 lg:border-r lg:border-line lg:pr-5">
        <h1 className="mb-3 text-xl font-semibold tracking-tight lg:mb-6">
          Record Keeping
        </h1>
        <nav aria-label="Record keeping sections" className="grid grid-cols-2 gap-1 lg:grid-cols-1">
          {SECTIONS.map((item) => (
            <PendingLink
              key={item.key}
              href={`/records?section=${item.key}`}
              pendingLabel="Loading section…"
              aria-current={section === item.key ? "page" : undefined}
              className={cx(
                "flex min-h-11 items-center rounded-md px-3 py-2 text-sm",
                section === item.key
                  ? cx("bg-slate-100 font-semibold text-slate-800 dark:bg-slate-800 dark:text-slate-100", NAV_ROW_FOCUS)
                  : cx("text-fg-muted hover:text-fg", NAV_ROW_FEEDBACK),
              )}
            >
              <span className="flex items-center gap-2">
                <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="size-4 shrink-0">
                  <path d={item.icon} />
                </svg>
                {item.label}
              </span>
            </PendingLink>
          ))}
        </nav>
        <p className="mt-7 hidden border-t border-line pt-4 text-sm font-medium lg:block">{studio.name}</p>
      </aside>
      <div className="min-w-0 space-y-6">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            {adding && (
              <PendingLink href={`/records?section=${section}`} className={cx("mb-2 inline-flex min-h-11 items-center text-sm font-medium text-fg-muted", TEXT_LINK_FEEDBACK)}>
                ← Back to {book.label.toLowerCase()}
              </PendingLink>
            )}
            <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">{adding ? book.add : book.label}</h2>
            {!adding && <p className="mt-2 max-w-prose text-sm text-fg-muted">{book.description}</p>}
          </div>
          {!adding && !tracingLot && (
            <div className="flex flex-wrap gap-2 sm:ml-auto">
              {(section !== "incidents" || isOwner) && (
                <Link href={`/records/print?section=${section}${section === "procedures" ? procedureFilterQuery : ""}`} className={buttonClasses({ variant: "secondary" })}>
                  Print / Export
                </Link>
              )}
              {book.add && (
                <PendingLink href={`/records?section=${section}&view=add`} className={buttonClasses({ variant: "primary" })}>
                  <span aria-hidden="true">+ </span>{book.add}
                </PendingLink>
              )}
            </div>
          )}
        </header>
        {body.ok ? body.value : <SectionUnavailable />}
        <p className="border-t border-line pt-3 text-xs text-fg-muted lg:hidden">{studio.name} · Studio records</p>
      </div>
    </div>
  );
}

function StockFilters({ section, currentLabel, stock }: {
  section: "sterile" | "disinfectants";
  currentLabel: string;
  stock?: string;
}) {
  const selected = stock === "current" || stock === "discarded" ? stock : "";
  return (
    <nav aria-label="Stock status" className="inline-flex w-fit flex-wrap rounded-lg border border-line bg-surface-sunken p-1">
      {([["", "All"], ["current", currentLabel], ["discarded", "Discarded"]] as const).map(([value, label]) => (
        <PendingLink
          key={value}
          href={`/records?section=${section}${value ? `&stock=${value}` : ""}`}
          aria-current={selected === value ? "page" : undefined}
          className={cx(
            "inline-flex min-h-11 items-center rounded-md px-3 text-sm pointer-fine:min-h-9",
            selected === value ? cx("bg-surface font-semibold text-fg shadow-sm", NAV_ROW_FOCUS) : cx("text-fg-muted hover:text-fg", NAV_ROW_FEEDBACK),
          )}
        >
          {label}
        </PendingLink>
      ))}
    </nav>
  );
}

function stockMatches(discarded: boolean, stock?: string) {
  if (stock === "current") return !discarded;
  if (stock === "discarded") return discarded;
  return true;
}

const sterileColumns = "lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,.85fr)]";
const batchColumns = "lg:grid-cols-[minmax(0,1.45fr)_minmax(0,.95fr)_minmax(0,1fr)_minmax(0,.95fr)_minmax(0,1.1fr)_minmax(0,.65fr)]";

function RegisterColumns({ columns, labels }: { columns: string; labels: string[] }) {
  return (
    <div aria-hidden="true" className={`hidden gap-3 border-b border-line bg-surface-sunken px-4 py-3 text-xs font-semibold text-fg-muted lg:grid ${columns}`}>
      {labels.map((label) => <span key={label}>{label}</span>)}
    </div>
  );
}

async function SterileItemsSection({
  studioId,
  adding = false,
  stock,
  lotSearch,
  timezone,
}: {
  studioId: string;
  adding?: boolean;
  stock?: string;
  lotSearch: string | null;
  timezone: string;
}) {
  // Records renders exactly ONE section per request (see the `section ===`
  // switch above), so every section opens the same `records.domain` window and
  // one request records one of them.
  const domain = startPerfSpan("records.domain");
  const records = await getSterileItemRecords(studioId);
  if (adding) {
    domain.end();
    return (
      <section className="rounded-xl border border-line p-4 sm:p-6">
        <p className="mb-5 text-sm text-fg-muted">Enter the purchase details and the lot and expiry shown on the packaging.</p>
        <AddSterileItemForm
          action={addSterileItemRecordAction}
          lastRecord={
            records[0]
              ? {
                  date_purchased: records[0].date_purchased,
                  item_description: records[0].item_description,
                  manufacturer_name: records[0].manufacturer_name,
                  amount_purchased: records[0].amount_purchased,
                  expiry_date: records[0].expiry_date,
                  notes: records[0].notes,
                  // Migration 0155: probe classification IS reusable across
                  // purchases, so copy-last carries it (unlike the lot number,
                  // which is intentionally omitted, never copied).
                  probe_key: records[0].probe_key,
                }
              : null
          }
        />
      </section>
    );
  }
  const visible = records.filter((r) => stockMatches(isSupplyDiscarded(r.date_discarded), stock));
  // PR #316: expiry states for row styling + the summary banner (studio-local
  // "today"). Display-only over the existing expiry_date column.
  const today = todayInTz(timezone);
  const expirySummary = summarizeSupplyExpiry(records, today);
  // PR #213: traceability for the searched/selected lot.
  // RECORDS-SECTION-RECOVERY: the lot search is optional, so its failure is
  // its own panel. The sterile records above were read separately and still
  // render; if THAT read fails, the whole section shows the page's panel.
  const trace = lotSearch
    ? await recoverRecordsRead("records", "sterile_lot_search", () =>
        getLotTraceability(studioId, lotSearch),
      )
    : null;
  const stockQuery = stock === "current" || stock === "discarded" ? `&stock=${stock}` : "";
  if (trace?.ok && trace.value) {
    domain.end();
    return (
      <section className="space-y-3">
        <PendingLink href={`/records?section=sterile${stockQuery}`} className="inline-flex min-h-11 items-center text-sm font-medium text-fg-muted hover:underline">
          ← Back to purchase log
        </PendingLink>
        <LotTraceabilityPanel trace={trace.value} />
      </section>
    );
  }
  const audit = await getAuditEventsByRecord(
    studioId,
    "sterile_item",
    records.map((r) => r.id),
  );
  domain.end();
  return (
    <div className="flex flex-col gap-5">
      {/* PR #213: probe lot traceability. Search a lot number (exact
          normalized match; trim + case-insensitive; never fuzzy) or
          tap Trace usage on a record below. Traceability only; never
          implies causation or any conclusion about a lot. */}
      <section className="space-y-3 rounded-xl border border-line bg-surface-sunken p-4 sm:p-5">
        <h3 className="text-base font-semibold">Trace a lot</h3>
        <form method="get" action="/records" className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="section" value="sterile" />
          {stockQuery && <input type="hidden" name="stock" value={stock} />}
          <label className="flex min-w-0 max-w-full flex-col gap-1">
            <span className="text-[11px] uppercase tracking-wider text-neutral-500">
              Search lot number
            </span>
            <input
              type="text"
              name="lot"
              defaultValue={lotSearch ?? ""}
              placeholder="Enter lot number, for example 460941"
              className="min-w-0 w-72 max-w-full rounded-md border border-neutral-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
            />
          </label>
          <button
            type="submit"
            className={buttonClasses({ variant: "primary" })}
          >
            Trace usage
          </button>
        </form>
        {!trace || (trace.ok && !trace.value) ? (
          <p className="text-xs text-neutral-500">
            Search a lot number or choose a Sterile Item record to see where
            it was used.
          </p>
        ) : (
          <p
            role="alert"
            data-testid="records-lot-search-unavailable"
            className="text-xs text-amber-700 dark:text-amber-500"
          >
            Lot search unavailable. The usage of this lot could not be read;
            this does not mean the lot was never used. Search again to retry.
          </p>
        )}
      </section>

      <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-lg font-semibold">
            Purchase log <span className="sr-only">— Sterile item records</span>
            <span className="ml-1 text-sm font-normal text-fg-muted">{visible.length} {visible.length === 1 ? "record" : "records"}</span>
          </h3>
          <StockFilters section="sterile" currentLabel="In stock" stock={stock} />
        </div>
        {records.length >= 200 && <p className="text-xs text-fg-muted">Showing matches in the latest 200 purchases.</p>}
        {stock !== "discarded" && (expirySummary.expired > 0 || expirySummary.expiring > 0) && (
          <p role="status" className={`rounded-lg border px-4 py-3 text-sm font-medium ${expirySummary.expired ? "border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200" : "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"}`}>
            {expirySummary.expired > 0 && `${expirySummary.expired} expired`}
            {expirySummary.expired > 0 && expirySummary.expiring > 0 && " · "}
            {expirySummary.expiring > 0 && `${expirySummary.expiring} expiring within 30 days`}
          </p>
        )}
        {visible.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line px-5 py-8 text-sm text-fg-muted">
            {records.length ? "No purchases match this stock filter." : "No sterile item records yet."}
          </p>
        ) : (
          <div className="overflow-hidden rounded-xl border border-line">
            <RegisterColumns columns={sterileColumns} labels={["Item / manufacturer", "Lot number", "Purchased", "Expiry", "Status", ""]} />
            <ul className="divide-y divide-line">
              {visible.map((r) => {
                const discarded = isSupplyDiscarded(r.date_discarded);
                const expiry = discarded ? "neutral" : supplyExpiryState(r.expiry_date, today);
                const expiryLabel = supplyExpiryLabel(expiry);
                const rowCls = expiry === "expired" ? "bg-red-50 dark:bg-red-950/30"
                  : expiry === "today" || expiry === "expiring" ? "bg-amber-50 dark:bg-amber-950/20" : "";
                const badgeCls = expiry === "expired" ? "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200"
                  : "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200";
                return (
                  <li key={r.id} className={rowCls}>
                    <details className="group">
                      <summary className={`grid cursor-pointer list-none grid-cols-2 items-start gap-x-3 gap-y-2 px-4 py-4 text-sm [overflow-wrap:anywhere] hover:bg-surface-sunken lg:items-center [&::-webkit-details-marker]:hidden ${sterileColumns}`}>
                        <span className="col-span-2 lg:col-span-1">
                          <strong className="font-semibold">{r.item_description}</strong>
                          {r.manufacturer_name && <span className="block text-xs text-fg-muted">{r.manufacturer_name}</span>}
                        </span>
                        <span><span className="text-fg-muted lg:sr-only">Lot #: </span><span className="font-mono">{r.lot_number || "Not recorded"}</span></span>
                        <span><span className="text-fg-muted lg:sr-only">Purchased: </span>{dateOnly(r.date_purchased)}</span>
                        <span><span className="text-fg-muted lg:sr-only">Expiry: </span>{dateOnly(r.expiry_date) ?? "Not recorded"}</span>
                        <span>
                          {expiryLabel ? <span className={`rounded px-2 py-1 text-xs font-medium ${badgeCls}`}>{expiryLabel}</span>
                            : <span className="rounded bg-surface-sunken px-2 py-1 text-xs font-medium">{discarded ? "Discarded" : "In stock"}</span>}
                        </span>
                        <span className="flex flex-col items-start gap-1 text-xs font-medium">
                          {r.lot_number && (
                            <Link href={`/records?section=sterile&lot=${encodeURIComponent(r.lot_number)}${stockQuery}`} className="inline-flex min-h-11 items-center underline underline-offset-4 pointer-fine:min-h-8">Trace usage</Link>
                          )}
                          <span className="inline-flex min-h-7 items-center text-fg-muted">Details <span aria-hidden="true" className="ml-1 group-open:rotate-90">›</span></span>
                        </span>
                      </summary>
                      <div className="space-y-2 border-t border-line bg-surface-sunken px-4 py-4 text-sm">
                        {discarded && <p>Discarded: {dateOnly(r.date_discarded)}</p>}
                        {r.amount_purchased && <p>Amount purchased: {r.amount_purchased}</p>}
                        {r.notes && <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{r.notes}</p>}
                        <RowTools
                          editForm={<EditSterileItemForm record={r} action={updateSterileItemRecordAction} />}
                          events={audit.byRecord.get(r.id)}
                          historyUnavailable={audit.unavailableRecordIds.has(r.id)}
                        />
                      </div>
                    </details>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}

async function DisinfectantsSection({
  studioId,
  adding = false,
  stock,
  focusRecordId,
  currentPractitionerId,
  timezone,
}: {
  studioId: string;
  adding?: boolean;
  stock?: string;
  // HON-12: the record the overdue notice points at (opened for editing).
  focusRecordId?: string;
  currentPractitionerId: string;
  timezone: string;
}) {
  const domain = startPerfSpan("records.domain");
  const staff = (await getPractitionersForStudio(studioId)).map((p) => ({
    id: p.id,
    name: p.display_name?.trim() || p.email,
  }));
  if (adding) {
    domain.end();
    return (
      <section className="rounded-xl border border-line p-4 sm:p-6">
        <p className="mb-5 text-sm text-fg-muted">Record the preparation and replacement dates. Add the actual discard date when the batch is discarded.</p>
        <AddDisinfectantForm action={addDisinfectantRecordAction} staff={staff} currentPractitionerId={currentPractitionerId} />
      </section>
    );
  }
  const newest = await getDisinfectantRecords(studioId);
  // The notice's record can be older than the newest 200 rows: fetch that ONE
  // record (studio-scoped, RLS client) and place it first. Compare-only; an
  // unknown or other-studio id changes nothing.
  const records =
    focusRecordId && !newest.some((r) => r.id === focusRecordId)
      ? placeFocusedRecord(
          newest,
          focusRecordId,
          await getDisinfectantRecordForNotice(studioId, focusRecordId),
        )
      : newest;
  const audit = await getAuditEventsByRecord(
    studioId,
    "disinfectant",
    records.map((r) => r.id),
  );
  // PR #280: same-studio staff for the operator dropdown; studio-local "today"
  // for the read-time discard due/overdue alerts.
  const today = todayInTz(timezone);
  const focusId = resolveFocusedDisinfectantId(
    focusRecordId,
    records.map((r) => r.id),
  );
  const activeFilter = focusId ? undefined : stock;
  const visible = records.filter((r) => stockMatches(Boolean(r.date_discarded), activeFilter));
  const nextDue = records.filter((r) => isDisinfectantAlert(disinfectantDueStatus(r, today)))
    .sort((a, b) => a.discard_due_date!.localeCompare(b.discard_due_date!))[0];
  domain.end();
  return (
    <section className="space-y-5">
      {nextDue && activeFilter !== "discarded" && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-5 py-4 text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
          <div>
            <h3 className="font-semibold">{disinfectantDueStatus(nextDue, today) === "due_soon" ? "Upcoming batch replacement" : "Batch needs replacement"}</h3>
            <p className="mt-1 text-sm">{nextDue.disinfectant_name} · Replace by {dateOnly(nextDue.discard_due_date)}</p>
          </div>
          <PendingLink href={`/records?section=disinfectants&record=${encodeURIComponent(nextDue.id)}#${disinfectantRecordAnchor(nextDue.id)}`} className="inline-flex min-h-11 items-center text-sm font-semibold underline underline-offset-4">Review batch</PendingLink>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-lg font-semibold">Batch log <span className="ml-1 text-sm font-normal text-fg-muted">{visible.length} {visible.length === 1 ? "record" : "records"}</span></h3>
        <StockFilters section="disinfectants" currentLabel="In use" stock={activeFilter} />
      </div>
      {newest.length >= 200 && <p className="text-xs text-fg-muted">Showing matches in the latest 200 batches{records.length > newest.length ? " plus the requested batch" : ""}.</p>}
      {visible.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line px-5 py-8 text-sm text-fg-muted">
          {records.length ? "No batches match this stock filter." : "No disinfectant records yet."}
        </p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-line">
          <RegisterColumns columns={batchColumns} labels={["Disinfectant", "Prepared", "Replace by", "Discarded", "Operator", ""]} />
          <ul className="divide-y divide-line">
            {visible.map((r) => {
              const status = disinfectantDueStatus(r, today);
              const alert = isDisinfectantAlert(status);
              return (
                <li key={r.id} id={disinfectantRecordAnchor(r.id)} className="scroll-mt-24">
                  <details open={r.id === focusId} className="group">
                    <summary className={`grid cursor-pointer list-none grid-cols-2 items-start gap-x-3 gap-y-2 px-4 py-4 text-sm [overflow-wrap:anywhere] hover:bg-surface-sunken lg:items-center [&::-webkit-details-marker]:hidden ${batchColumns}`}>
                      <span className="col-span-2 lg:col-span-1"><strong className="font-semibold">{r.disinfectant_name}</strong>{r.concentration && <span className="block text-xs text-fg-muted">{r.concentration}</span>}</span>
                      <span><span className="text-fg-muted lg:sr-only">Prepared: </span>{dateOnly(r.date_prepared)}</span>
                      <span><span className="text-fg-muted lg:sr-only">Replace by: </span>{dateOnly(r.discard_due_date) ?? "Not set"}
                        {alert && <span role="status" className={`mt-1 block w-fit rounded px-1.5 py-0.5 text-xs font-medium ${status === "overdue" ? "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200" : "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200"}`}>{disinfectantStatusLabel(status)}</span>}
                      </span>
                      <span><span className="text-fg-muted lg:sr-only">Discarded: </span>{dateOnly(r.date_discarded) ?? "In use"}</span>
                      <span><span className="text-fg-muted lg:sr-only">Operator: </span>{r.operator_name || "Not recorded"}</span>
                      <span className="text-xs font-medium text-fg-muted">Details <span aria-hidden="true" className="inline-block group-open:rotate-90">›</span></span>
                    </summary>
                    <div className="space-y-2 border-t border-line bg-surface-sunken px-4 py-4 text-sm">
                      {r.notes && <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{r.notes}</p>}
                      <RowTools
                        editOpen={r.id === focusId}
                        editForm={<EditDisinfectantForm record={r} action={updateDisinfectantRecordAction} staff={staff} currentPractitionerId={currentPractitionerId} />}
                        events={audit.byRecord.get(r.id)}
                        historyUnavailable={audit.unavailableRecordIds.has(r.id)}
                      />
                    </div>
                  </details>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}

async function ExposureIncidentsSection({
  studioId,
  isOwner,
  adding,
}: {
  studioId: string;
  isOwner: boolean;
  adding: boolean;
}) {
  const domain = startPerfSpan("records.domain");
  // Reporting is available to studio members. Only the owner may read reports.
  const records = isOwner && !adding ? await getExposureIncidentRecords(studioId) : [];
  if (!adding && records.length === 0) {
    domain.end();
    return (
      <section className="rounded-xl border border-neutral-200 px-5 py-9 dark:border-neutral-800">
        <h3 className="text-base font-semibold">
          {isOwner ? "No exposure incidents recorded." : "Exposure incident history is owner-only."}
        </h3>
        <p className="mt-2 text-sm text-fg-muted">
          {isOwner
            ? "Reports you and your team submit will appear here."
            : "You can still report an accidental blood or body fluid exposure."}
        </p>
      </section>
    );
  }

  // The creation and owner edit forms both use same-studio contact pickers.
  const [clientRows, practitionerRows] = await Promise.all([
    getClientsForStudio(studioId),
    getPractitionersForStudio(studioId),
  ]);
  const clients = clientRows.map((c) => ({
    id: c.id,
    name: c.name,
    phone: c.phone ?? "",
    address: c.address ?? "",
  }));
  const staff = practitionerRows.map((p) => ({
    id: p.id,
    name: p.display_name?.trim() || p.email,
  }));
  if (adding) {
    domain.end();
    return (
      <section aria-label="Incident report">
        <p className="mb-5 rounded-lg bg-neutral-50 px-4 py-3 text-sm text-fg-muted dark:bg-neutral-900">
          This report contains personal information. Only the studio owner can review incident history.
        </p>
        <AddExposureIncidentForm
          action={addExposureIncidentRecordAction}
          clients={clients}
          staff={staff}
        />
      </section>
    );
  }

  const audit = await getAuditEventsByRecord(
    studioId,
    "exposure_incident",
    records.map((r) => r.id),
  );
  domain.end();
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-base font-semibold">
        Incident history <span className="font-normal text-fg-muted">({records.length})</span>
      </h3>
      <ul className="flex flex-col divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
        {records.map((r) => (
          <li key={r.id}>
            <details>
              <summary className="cursor-pointer rounded-md px-4 py-4 text-sm hover:bg-neutral-50 focus-visible:outline-offset-[-2px] sm:px-5 dark:hover:bg-neutral-900">
                <span className="ms-1 break-words font-medium">{r.exposed_person_full_name}</span>
                <span className="ms-3 whitespace-nowrap text-fg-muted">{dateOnly(r.incident_date)}</span>
              </summary>
              <div className="space-y-4 border-t border-neutral-200 px-4 py-4 sm:px-5 dark:border-neutral-800">
                <dl className="grid min-w-0 gap-4 text-sm sm:grid-cols-2 [&_dd]:mt-1 [&_dd]:break-words [&_dt]:font-medium">
                  <div><dt>How the exposure occurred</dt><dd>{r.exposure_details || "Not recorded"}</dd></div>
                  <div><dt>Action taken</dt><dd>{r.action_taken || "Not recorded"}</dd></div>
                  <div><dt>Phone</dt><dd>{r.exposed_person_phone || "Not recorded"}</dd></div>
                  <div><dt>Address</dt><dd>{r.exposed_person_address || "Not recorded"}</dd></div>
                  <div><dt>Staff involved</dt><dd>{r.staff_involved_name || "Not recorded"}</dd></div>
                  {r.notes && <div className="sm:col-span-2"><dt>Notes</dt><dd>{r.notes}</dd></div>}
                </dl>
                <RowTools
                  editForm={
                    <EditExposureIncidentForm
                      record={r}
                      action={updateExposureIncidentRecordAction}
                      clients={clients}
                      staff={staff}
                    />
                  }
                  events={audit.byRecord.get(r.id)}
                  historyUnavailable={audit.unavailableRecordIds.has(r.id)}
                />
              </div>
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}

async function ClientProcedureRecordsSection({
  studioId,
  timezone,
  filter,
}: {
  studioId: string;
  timezone: string;
  filter: { clientId: string | null; from: string | null; to: string | null };
}) {
  const { fromUtc, toUtcExclusive } = utcInstantsForLocalDayRange(
    filter.from,
    filter.to,
    timezone,
  );
  const domain = startPerfSpan("records.domain");
  const clients = await getClientsForStudio(studioId);
  const filteredClient = filter.clientId
    ? (clients.find((c) => c.id === filter.clientId) ?? null)
    : null;
  const records = await getClientProcedureRecords(studioId, {
    clientId: filter.clientId,
    fromUtc,
    toUtcExclusive,
  });
  const audit = await getProcedureAuditEvents(
    studioId,
    records.map((r) => r.sessionId),
  );
  const filterActive = Boolean(filter.clientId || filter.from || filter.to);
  const registerColumns = "md:grid md:grid-cols-[1.1fr_1fr_1fr_minmax(6rem,.8fr)_6.5rem] md:items-center";
  const filterField = "min-h-11 w-full min-w-0 rounded-md border border-neutral-300 bg-white px-3 text-base dark:border-neutral-700 dark:bg-neutral-900 sm:text-sm";
  domain.end();
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <form
        method="get"
        action="/records"
        className="grid min-w-0 gap-3 rounded-lg border border-neutral-200 p-4 sm:grid-cols-2 lg:grid-cols-[minmax(9rem,1.5fr)_minmax(7rem,1fr)_minmax(7rem,1fr)_auto] lg:items-end dark:border-neutral-800"
      >
        <input type="hidden" name="section" value="procedures" />
        <label className="flex min-w-0 flex-col gap-1 text-sm">
          <span className="font-medium text-neutral-600 dark:text-neutral-400">
            Choose a client
          </span>
          <select
            name="clientId"
            defaultValue={filter.clientId ?? ""}
            className={filterField}
          >
            <option value="">All clients (most recent sessions)</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-sm">
          <span className="font-medium text-neutral-600 dark:text-neutral-400">
            From (optional)
          </span>
          <input
            type="date"
            name="from"
            defaultValue={filter.from ?? ""}
            className={filterField}
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-sm">
          <span className="font-medium text-neutral-600 dark:text-neutral-400">
            To (optional)
          </span>
          <input
            type="date"
            name="to"
            defaultValue={filter.to ?? ""}
            className={filterField}
          />
        </label>
        <button
          type="submit"
          className={buttonClasses({ variant: "primary" })}
        >
          Apply filter
        </button>
        {filterActive && (
          <Link
            href="/records?section=procedures"
            className="inline-flex min-h-11 items-center text-sm underline sm:col-span-full"
          >
            Clear filters
          </Link>
        )}
      </form>
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        Choose a client and dates to print a filtered procedure record.
      </p>

      <div>
        <h2 className="text-xl font-semibold tracking-tight">Session register</h2>
        {filterActive ? (
          <p className="text-xs text-neutral-600 dark:text-neutral-400">
            Showing {records.length} recorded session
            {records.length === 1 ? "" : "s"} for{" "}
            <span className="font-medium">
              {filter.clientId ? filteredClient?.name ?? "the selected client" : "all clients"}
            </span>
            {filter.from || filter.to ? (
              <>
                {" "}
                between <span className="font-medium">{filter.from ?? "the first record"}</span> and{" "}
                <span className="font-medium">{filter.to ?? "today"}</span>
              </>
            ) : null}
            {!filter.clientId && records.length >= UNFILTERED_PROCEDURE_RECORD_LIMIT &&
              ` (showing the ${UNFILTERED_PROCEDURE_RECORD_LIMIT} most recent; narrow the dates or choose a client for older sessions)`}
            {filter.clientId && records.length >= FILTERED_PROCEDURE_RECORD_LIMIT &&
              ` (capped at the ${FILTERED_PROCEDURE_RECORD_LIMIT} most recent; narrow the date range for older sessions)`}
            .
          </p>
        ) : (
          <p className="text-xs text-neutral-500">
            Showing the {records.length} most recent recorded session
            {records.length === 1 ? "" : "s"} across all clients.
          </p>
        )}
      </div>
      {records.length === 0 ? (
        <p className="rounded-lg border border-dashed border-neutral-300 px-5 py-8 text-sm text-neutral-500 dark:border-neutral-700">
          {filterActive
            ? "No recorded sessions match this filter."
            : "No sessions recorded yet."}
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-800">
          <div aria-hidden="true" className={`hidden gap-3 bg-neutral-50 px-4 py-3 text-xs font-medium text-neutral-600 dark:bg-neutral-900 dark:text-neutral-400 ${registerColumns}`}>
            <span>Client / procedure</span><span>Session</span><span>Treatment area</span><span>Risks &amp; aftercare</span>
          </div>
          <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
            {records.map((r) => (
              <li key={r.sessionId}>
                <details className="group/record">
                  <summary className={`grid cursor-pointer list-none gap-x-3 gap-y-2 px-4 py-4 text-sm hover:bg-neutral-50 focus-visible:outline-offset-[-3px] dark:hover:bg-neutral-900 [&::-webkit-details-marker]:hidden ${registerColumns}`}>
                    <span className="min-w-0 break-words">
                      <strong className="font-semibold">{r.clientName || "Not recorded"}</strong>
                      <span className="block text-xs capitalize text-neutral-500">{r.modality}</span>
                    </span>
                    <span className="text-neutral-600 dark:text-neutral-400"><span className="sr-only">Session </span><FormattedDateTime iso={r.startedAt} /></span>
                    <span className="break-words"><span className="sr-only">Treatment area: </span>{r.areas.map((area) => area.name).join(" · ") || <NotRecorded />}</span>
                    <span className="text-xs">
                      <span className="md:sr-only">Risks &amp; aftercare: </span>
                      <span className={r.aftercareExplainedAt ? "rounded border border-neutral-200 px-2 py-1 dark:border-neutral-700" : "rounded border border-amber-200 bg-amber-50 px-2 py-1 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"}>
                        {r.aftercareExplainedAt ? "Recorded" : "Not marked"}
                      </span>
                    </span>
                    <span className="font-medium underline underline-offset-4">
                      <span className="group-open/record:hidden">View record</span>
                      <span className="hidden group-open/record:inline">Hide details</span>
                    </span>
                  </summary>
                  <div className="grid min-w-0 gap-4 border-t border-neutral-200 bg-neutral-50/50 p-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] dark:border-neutral-800 dark:bg-neutral-900/30">
                    <section className="flex min-w-0 flex-col gap-2.5">
                      <h3 className="font-semibold">Session details</h3>
                      <p className="text-sm">Operator: {r.operatorName ?? <NotRecorded />}</p>
                      <div className="flex flex-col gap-1 text-sm">
                        <span className="font-medium text-neutral-600 dark:text-neutral-400">
                          Items used
                        </span>
                        {r.areas.length === 0 ? (
                          <span className="text-neutral-400">
                            No treatment areas charted.
                          </span>
                        ) : (
                          <ul className="flex flex-col gap-0.5 text-neutral-700 dark:text-neutral-300">
                            {r.areas.map((a, i) => (
                              <li key={`${r.sessionId}-${i}`}>
                                {a.name}
                                {a.probeLabel ? ` · ${a.probeLabel}` : ""}
                                {a.machineFrequency ? ` · ${a.machineFrequency}` : ""}
                                {" · Lot #: "}
                                {a.probeLotNumber ? (
                                  <span className="font-medium">{a.probeLotNumber}</span>
                                ) : (
                                  <NotRecorded />
                                )}
                                {a.minutesPerformed != null &&
                                  ` · ${a.minutesPerformed} min`}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </section>
                    <section className="flex min-w-0 flex-col gap-2">
                      <h3 className="font-semibold">Client details</h3>
                      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 break-words text-sm [&>dt]:text-neutral-500">
                        <dt>Date of birth</dt><dd>{r.dateOfBirth ?? <NotRecorded />}</dd>
                        <dt>Phone</dt><dd>{r.phone ?? <NotRecorded />}</dd>
                        <dt>Email</dt><dd>{r.email ?? <NotRecorded />}</dd>
                        <dt>Address</dt><dd>{r.address ?? <NotRecorded />}</dd>
                      </dl>
                    </section>
                    {/* The disclosure is shown when there is history to show OR when
                        we could not find out. Hiding it on an unreadable history
                        would be the same clinical lie as printing "no history", told
                        by omission instead of in words. */}
                    {((audit.byRecord.get(r.sessionId)?.length ?? 0) > 0 ||
                      audit.unavailableRecordIds.has(r.sessionId)) && (
                      <details className="col-span-full">
                        <summary className="cursor-pointer text-xs text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100">
                          History
                        </summary>
                        <div className="mt-2">
                          <AuditHistoryList
                            events={audit.byRecord.get(r.sessionId)}
                            unavailable={audit.unavailableRecordIds.has(r.sessionId)}
                          />
                        </div>
                      </details>
                    )}
                    <div className="col-span-full flex flex-wrap items-center justify-between gap-2 border-t border-neutral-200 pt-2 dark:border-neutral-800">
                      <AftercareExplainedToggle
                        sessionId={r.sessionId}
                        explainedAt={r.aftercareExplainedAt}
                        action={markAftercareExplainedAction}
                      />
                      {r.clientId && (
                        <Link
                          href={`/clients/${r.clientId}/sessions/${r.sessionId}`}
                          className="text-xs font-medium text-neutral-700 hover:underline dark:text-neutral-300"
                        >
                          Open session
                        </Link>
                      )}
                    </div>
                  </div>
                </details>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// PR #213: lot traceability result panel. Lot details from any
// matching Sterile Item record + every treatment area recorded with
// the same lot, with compact aftercare status and links into the
// client/session. Traceability wording only; never causation.
function LotTraceabilityPanel({
  trace,
}: {
  trace: import("@/lib/record-keeping/queries").LotTraceability;
}) {
  return (
    <div className="space-y-6 text-sm [overflow-wrap:anywhere]">
      <h3 className="text-2xl font-semibold tracking-tight">Lot <span className="font-mono">#{trace.lot}</span></h3>
      <section className="space-y-3">
        <h4 className="font-semibold">Matching sterile item record{trace.sterileItems.length > 1 ? "s" : ""}</h4>
        {trace.sterileItems.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line p-4 text-fg-muted">No matching sterile item record found for this lot number.</p>
        ) : (
          <ul className="divide-y divide-line rounded-xl border border-line">
            {trace.sterileItems.map((r) => (
              <li key={r.id} className="space-y-4 p-4 sm:p-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-base font-semibold">{r.item_description}</span>
                  <span className="rounded bg-surface-sunken px-2 py-1 text-xs font-medium">{r.date_discarded ? "Discarded" : "In stock"}</span>
                </div>
                <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {[
                    ["Manufacturer", r.manufacturer_name],
                    ["Amount purchased", r.amount_purchased],
                    ["Lot number", r.lot_number],
                    ["Purchased", dateOnly(r.date_purchased)],
                    ["Expiry", dateOnly(r.expiry_date) ?? "Not recorded"],
                    ["Discarded", dateOnly(r.date_discarded)],
                  ].map(([label, value]) => (
                    <div key={label}><dt className="text-xs text-fg-muted">{label}</dt><dd>{value || "Not recorded"}</dd></div>
                  ))}
                </dl>
                {r.notes && <p className="whitespace-pre-wrap border-t border-line pt-3">{r.notes}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="space-y-3">
        <h4 className="font-semibold">Used in charting <span className="ml-1 font-normal text-fg-muted">{trace.usages.length} {trace.usages.length === 1 ? "entry" : "entries"}</span></h4>
        {trace.usages.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line p-4 text-fg-muted">
            {trace.sterileItems.length ? "No charted treatment areas have used this lot yet." : "No usage found for this lot number."}
          </p>
        ) : (
          <>
            {trace.sterileItems.length === 0 && (
              <p className="text-fg-muted">Used in charting, but no matching Sterile Item record was found.</p>
            )}
            <div className="overflow-hidden rounded-xl border border-line">
              <RegisterColumns columns="lg:grid-cols-[1fr_.85fr_1.5fr_1fr_.7fr]" labels={["Client / session", "Date", "Treatment", "Aftercare", ""]} />
              <ul className="divide-y divide-line">
                {trace.usages.map((u) => (
                  <li key={u.blockId} className="grid grid-cols-2 items-start gap-3 p-4 lg:grid-cols-[1fr_.85fr_1.5fr_1fr_.7fr] lg:items-center">
                    <span>
                      {u.clientId ? (
                        <Link href={`/clients/${u.clientId}`} className="font-semibold hover:underline">{u.clientName ?? "Client"}</Link>
                      ) : (
                        <strong>{u.clientName ?? "Client not recorded"}</strong>
                      )}
                      {u.modality && <span className="block text-xs capitalize text-fg-muted">{u.modality}</span>}
                    </span>
                    <span>{u.startedAt ? <FormattedDateTime iso={u.startedAt} format="date" /> : "Not recorded"}</span>
                    <span>
                      <span>{u.areaName || "Area not recorded"}</span>
                      {u.operatorName && <span className="block text-xs text-fg-muted">{u.operatorName}</span>}
                      {(u.machineFrequency || u.probeLabel) && <span className="block text-xs text-fg-muted">{[u.machineFrequency, u.probeLabel].filter(Boolean).join(" · ")}</span>}
                    </span>
                    <span className="text-xs">{u.aftercareExplainedAt ? "Aftercare marked" : "Aftercare not marked"}</span>
                    {u.clientId && (
                      <Link href={`/clients/${u.clientId}/sessions/${u.sessionId}`} className="inline-flex min-h-11 items-center text-xs font-semibold underline underline-offset-4">Open session</Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
