import Link from "next/link";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import {
  getAuditEventsByRecord,
  getLotTraceability,
  normalizeLotSearch,
  getClientProcedureRecords,
  getDisinfectantRecords,
  getExposureIncidentRecords,
  getProcedureAuditEvents,
  getSterileItemRecords,
} from "@/lib/record-keeping/queries";
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
//   4. Client Procedure Records ("Client Record for Invasive
//      Procedures"; GENERATED from existing client/session/treatment
//      area data, including probe lot numbers; missing values render
//      as "Not recorded", never invented)
// This is record keeping support, not a legal compliance guarantee.

const SECTIONS = [
  { key: "sterile", label: "Sterile Items" },
  { key: "disinfectants", label: "Disinfectants" },
  { key: "incidents", label: "Exposure Incidents" },
  { key: "procedures", label: "Client Procedure Records" },
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

function AuditHistoryList({
  events,
}: {
  events: RecordKeepingAuditEvent[] | undefined;
}) {
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
  events,
}: {
  editForm: React.ReactNode;
  events: RecordKeepingAuditEvent[] | undefined;
}) {
  return (
    <div className="mt-1 flex flex-col gap-1">
      <details>
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
          <AuditHistoryList events={events} />
        </div>
      </details>
    </div>
  );
}


export default async function RecordKeepingPage({
  searchParams,
}: {
  searchParams: Promise<{ section?: string; lot?: string }>;
}) {
  const sp = await searchParams;
  const section: SectionKey = isSection(sp.section) ? sp.section : "sterile";
  // PR #213: probe lot traceability search (exact normalized match).
  const lotSearch = normalizeLotSearch(sp.lot);
  const { studio } = await getCurrentPractitionerWithStudio();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">
          Record Keeping
        </h1>
        <p className="mt-1 text-sm text-neutral-500">
          Health-inspection logbooks for {studio.name}. Records are visible to
          your studio only.
        </p>
      </div>

      {/* PR #207: inspector-friendly print/export for the ACTIVE
          section. Opens the protected print view; history is opt-in
          there. */}
      <nav className="flex flex-wrap gap-2" aria-label="Record keeping sections">
        {SECTIONS.map((s) => (
          <Link
            key={s.key}
            href={`/records?section=${s.key}`}
            aria-current={section === s.key ? "page" : undefined}
            className={
              section === s.key
                ? "rounded-full bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
                : "rounded-full border border-neutral-300 px-4 py-2 text-sm text-neutral-700 hover:border-neutral-500 dark:border-neutral-700 dark:text-neutral-300"
            }
          >
            {s.label}
          </Link>
        ))}
        <Link
          href={`/records/print?section=${section}`}
          className="ml-auto rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900"
        >
          Print / Export
        </Link>
      </nav>

      {section === "sterile" && (
        <SterileItemsSection studioId={studio.id} lotSearch={lotSearch} />
      )}
      {section === "disinfectants" && (
        <DisinfectantsSection studioId={studio.id} />
      )}
      {section === "incidents" && (
        <ExposureIncidentsSection studioId={studio.id} />
      )}
      {section === "procedures" && (
        <ClientProcedureRecordsSection studioId={studio.id} />
      )}
    </div>
  );
}

async function SterileItemsSection({
  studioId,
  lotSearch,
}: {
  studioId: string;
  lotSearch: string | null;
}) {
  const records = await getSterileItemRecords(studioId);
  // PR #213: traceability for the searched/selected lot.
  const trace = lotSearch
    ? await getLotTraceability(studioId, lotSearch)
    : null;
  const audit = await getAuditEventsByRecord(
    studioId,
    "sterile_item",
    records.map((r) => r.id),
  );
  return (
    <div className="flex flex-col gap-5">
      {/* PR #213: probe lot traceability. Search a lot number (exact
          normalized match; trim + case-insensitive; never fuzzy) or
          tap Trace usage on a record below. Traceability only; never
          implies causation or any conclusion about a lot. */}
      <section className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
        <h2 className="text-sm font-medium uppercase tracking-wider text-neutral-500">
          Lot traceability
        </h2>
        <form method="get" action="/records" className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="section" value="sterile" />
          <label className="flex flex-col gap-1">
            <span className="text-[11px] uppercase tracking-wider text-neutral-500">
              Search lot number
            </span>
            <input
              type="text"
              name="lot"
              defaultValue={lotSearch ?? ""}
              placeholder="Enter lot number, for example 460941"
              className="w-72 max-w-full rounded-md border border-neutral-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
            />
          </label>
          <button
            type="submit"
            className="rounded-md bg-neutral-900 px-5 py-3 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
          >
            Trace usage
          </button>
        </form>
        {!trace ? (
          <p className="text-xs text-neutral-500">
            Search a lot number or choose a Sterile Item record to see where
            it was used.
          </p>
        ) : (
          <LotTraceabilityPanel trace={trace} />
        )}
      </section>

      <section className="rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
        <h2 className="text-sm font-medium uppercase tracking-wider text-neutral-500">
          Add sterile item purchase
        </h2>
        <p className="mb-4 mt-1 text-xs text-neutral-500">
          Commercially purchased prepackaged and sterile items, e.g. a box of
          probes. Record the lot number and expiry from the packaging.
        </p>
        <AddSterileItemForm action={addSterileItemRecordAction} />
      </section>
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">
          Sterile item records{" "}
          <span className="text-sm font-normal text-neutral-500">
            ({records.length})
          </span>
        </h2>
        {records.length === 0 ? (
          <p className="rounded-lg border border-dashed border-neutral-300 px-5 py-8 text-sm text-neutral-500 dark:border-neutral-700">
            No sterile item records yet.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
            {records.map((r) => (
              <li key={r.id} className="flex flex-col gap-1 p-4 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">{r.item_description}</span>
                  <span className="flex items-baseline gap-3 text-xs text-neutral-500">
                    <span>Purchased {dateOnly(r.date_purchased)}</span>
                    {r.lot_number && (
                      <Link
                        href={`/records?section=sterile&lot=${encodeURIComponent(r.lot_number)}`}
                        className="font-medium text-neutral-700 hover:underline dark:text-neutral-300"
                      >
                        Trace usage
                      </Link>
                    )}
                  </span>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-neutral-600 dark:text-neutral-400">
                  <span>
                    Lot #:{" "}
                    <span className="font-medium text-neutral-900 dark:text-neutral-100">
                      {r.lot_number || "Not recorded"}
                    </span>
                  </span>
                  <span>
                    Expiry:{" "}
                    <span className="font-medium text-neutral-900 dark:text-neutral-100">
                      {dateOnly(r.expiry_date) ?? "Not recorded"}
                    </span>
                  </span>
                  {r.manufacturer_name && (
                    <span>Manufacturer: {r.manufacturer_name}</span>
                  )}
                  {r.amount_purchased && (
                    <span>Amount: {r.amount_purchased}</span>
                  )}
                </div>
                {r.notes && (
                  <p className="text-xs text-neutral-500">{r.notes}</p>
                )}
                <RowTools
                  editForm={
                    <EditSterileItemForm
                      record={r}
                      action={updateSterileItemRecordAction}
                    />
                  }
                  events={audit.get(r.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

async function DisinfectantsSection({ studioId }: { studioId: string }) {
  const records = await getDisinfectantRecords(studioId);
  const audit = await getAuditEventsByRecord(
    studioId,
    "disinfectant",
    records.map((r) => r.id),
  );
  return (
    <div className="flex flex-col gap-5">
      <section className="rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
        <h2 className="text-sm font-medium uppercase tracking-wider text-neutral-500">
          Add disinfectant record
        </h2>
        <p className="mb-4 mt-1 text-xs text-neutral-500">
          Disinfectants prepared for use, their concentration, and when each
          batch was discarded.
        </p>
        <AddDisinfectantForm action={addDisinfectantRecordAction} />
      </section>
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">
          Disinfectant records{" "}
          <span className="text-sm font-normal text-neutral-500">
            ({records.length})
          </span>
        </h2>
        {records.length === 0 ? (
          <p className="rounded-lg border border-dashed border-neutral-300 px-5 py-8 text-sm text-neutral-500 dark:border-neutral-700">
            No disinfectant records yet.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
            {records.map((r) => (
              <li key={r.id} className="flex flex-col gap-1 p-4 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">
                    {r.disinfectant_name}
                    {r.concentration && (
                      <span className="font-normal text-neutral-500">
                        {" "}
                        · {r.concentration}
                      </span>
                    )}
                  </span>
                  <span className="text-xs text-neutral-500">
                    Operator: {r.operator_name || "Not recorded"}
                  </span>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-neutral-600 dark:text-neutral-400">
                  <span>
                    Prepared:{" "}
                    <span className="font-medium text-neutral-900 dark:text-neutral-100">
                      {dateOnly(r.date_prepared)}
                    </span>
                  </span>
                  <span>
                    Discarded:{" "}
                    <span className="font-medium text-neutral-900 dark:text-neutral-100">
                      {dateOnly(r.date_discarded) ?? "In use"}
                    </span>
                  </span>
                </div>
                {r.notes && (
                  <p className="text-xs text-neutral-500">{r.notes}</p>
                )}
                <RowTools
                  editForm={
                    <EditDisinfectantForm
                      record={r}
                      action={updateDisinfectantRecordAction}
                    />
                  }
                  events={audit.get(r.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

async function ExposureIncidentsSection({ studioId }: { studioId: string }) {
  const records = await getExposureIncidentRecords(studioId);
  const audit = await getAuditEventsByRecord(
    studioId,
    "exposure_incident",
    records.map((r) => r.id),
  );
  return (
    <div className="flex flex-col gap-5">
      <section className="rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
        <h2 className="text-sm font-medium uppercase tracking-wider text-neutral-500">
          Add exposure incident
        </h2>
        <p className="mb-4 mt-1 text-xs text-neutral-500">
          Accidental blood or body fluid exposures. This record contains
          sensitive personal information and is visible to your studio only.
        </p>
        <AddExposureIncidentForm action={addExposureIncidentRecordAction} />
      </section>
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">
          Exposure incident records{" "}
          <span className="text-sm font-normal text-neutral-500">
            ({records.length})
          </span>
        </h2>
        {records.length === 0 ? (
          <p className="rounded-lg border border-dashed border-neutral-300 px-5 py-8 text-sm text-neutral-500 dark:border-neutral-700">
            No exposure incidents recorded.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
            {records.map((r) => (
              <li key={r.id} className="flex flex-col gap-1 p-4 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">
                    {r.exposed_person_full_name}
                  </span>
                  <span className="text-xs text-neutral-500">
                    {dateOnly(r.incident_date)}
                  </span>
                </div>
                <div className="flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-400">
                  {r.exposure_details && (
                    <p>
                      <span className="font-medium">Exposure:</span>{" "}
                      {r.exposure_details}
                    </p>
                  )}
                  {r.action_taken && (
                    <p>
                      <span className="font-medium">Action taken:</span>{" "}
                      {r.action_taken}
                    </p>
                  )}
                  <p>
                    Contact: {r.exposed_person_phone || "Not recorded"}
                    {r.exposed_person_address && ` · ${r.exposed_person_address}`}
                  </p>
                  <p>Staff involved: {r.staff_involved_name || "Not recorded"}</p>
                </div>
                {r.notes && (
                  <p className="text-xs text-neutral-500">{r.notes}</p>
                )}
                <RowTools
                  editForm={
                    <EditExposureIncidentForm
                      record={r}
                      action={updateExposureIncidentRecordAction}
                    />
                  }
                  events={audit.get(r.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

async function ClientProcedureRecordsSection({
  studioId,
}: {
  studioId: string;
}) {
  const records = await getClientProcedureRecords(studioId);
  const audit = await getProcedureAuditEvents(
    studioId,
    records.map((r) => r.sessionId),
  );
  return (
    <div className="flex flex-col gap-3">
      <div>
        <h2 className="text-lg font-medium">Client procedure records</h2>
        <p className="mt-1 text-xs text-neutral-500">
          Generated from your existing client and session records (most recent
          {" "}
          {records.length} sessions). Missing information shows as Not
          recorded; add it on the client or session page.
        </p>
      </div>
      {records.length === 0 ? (
        <p className="rounded-lg border border-dashed border-neutral-300 px-5 py-8 text-sm text-neutral-500 dark:border-neutral-700">
          No sessions recorded yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {records.map((r) => (
            <li
              key={r.sessionId}
              className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">
                  {r.clientName || "Not recorded"}
                  <span className="ml-2 font-normal capitalize text-neutral-500">
                    {r.modality}
                  </span>
                </span>
                <span className="text-xs text-neutral-500">
                  <FormattedDateTime iso={r.startedAt} />
                </span>
              </div>
              <dl className="grid gap-x-6 gap-y-1 text-xs text-neutral-600 dark:text-neutral-400 sm:grid-cols-2">
                <div>
                  <dt className="inline font-medium">Date of birth: </dt>
                  <dd className="inline">
                    {r.dateOfBirth ? r.dateOfBirth : <NotRecorded />}
                  </dd>
                </div>
                <div>
                  <dt className="inline font-medium">Phone: </dt>
                  <dd className="inline">{r.phone ?? <NotRecorded />}</dd>
                </div>
                <div>
                  <dt className="inline font-medium">Email: </dt>
                  <dd className="inline">{r.email ?? <NotRecorded />}</dd>
                </div>
                <div>
                  <dt className="inline font-medium">Address: </dt>
                  <dd className="inline">{r.address ?? <NotRecorded />}</dd>
                </div>
                <div>
                  <dt className="inline font-medium">Operator: </dt>
                  <dd className="inline">
                    {r.operatorName ?? <NotRecorded />}
                  </dd>
                </div>
              </dl>
              <div className="flex flex-col gap-1 text-xs">
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
              {(audit.get(r.sessionId)?.length ?? 0) > 0 && (
                <details>
                  <summary className="cursor-pointer text-xs text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100">
                    History
                  </summary>
                  <div className="mt-2">
                    <AuditHistoryList events={audit.get(r.sessionId)} />
                  </div>
                </details>
              )}
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-neutral-200 pt-2 dark:border-neutral-800">
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
                    Open session →
                  </Link>
                )}
              </div>
            </li>
          ))}
        </ul>
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
    <div className="flex flex-col gap-3 text-sm">
      <h3 className="font-medium">Lot #{trace.lot}</h3>

      <div>
        <p className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">
          Matching sterile item record
        </p>
        {trace.sterileItems.length === 0 ? (
          <p className="mt-0.5 text-xs text-neutral-500">
            No matching sterile item record found for this lot number.
          </p>
        ) : (
          <ul className="mt-0.5 flex flex-col gap-1">
            {trace.sterileItems.map((r) => (
              <li key={r.id} className="text-xs text-neutral-700 dark:text-neutral-300">
                <span className="font-medium">{r.item_description}</span>
                {r.manufacturer_name && ` · ${r.manufacturer_name}`}
                {r.amount_purchased && ` · ${r.amount_purchased}`}
                {" · Purchased "}
                {dateOnly(r.date_purchased)}
                {" · Expires "}
                {dateOnly(r.expiry_date) ?? "Not recorded"}
                {r.notes && ` · ${r.notes}`}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <p className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">
          Used in
        </p>
        {trace.usages.length === 0 ? (
          <p className="mt-0.5 text-xs text-neutral-500">
            {trace.sterileItems.length > 0
              ? "No charted treatment areas have used this lot yet."
              : "No usage found for this lot number."}
          </p>
        ) : (
          <>
            {trace.sterileItems.length === 0 && (
              <p className="mt-0.5 text-xs text-neutral-500">
                Used in charting, but no matching Sterile Item record was
                found.
              </p>
            )}
            <ul className="mt-1 flex flex-col divide-y divide-neutral-200 dark:divide-neutral-800">
              {trace.usages.map((u) => (
                <li
                  key={u.blockId}
                  className="flex flex-wrap items-baseline justify-between gap-2 py-1.5 text-xs"
                >
                  <span className="text-neutral-700 dark:text-neutral-300">
                    {u.clientId ? (
                      <Link
                        href={`/clients/${u.clientId}`}
                        className="font-medium hover:underline"
                      >
                        {u.clientName ?? "Client"}
                      </Link>
                    ) : (
                      <span className="font-medium">
                        {u.clientName ?? "Client not recorded"}
                      </span>
                    )}
                    {u.startedAt && (
                      <>
                        {" · "}
                        <FormattedDateTime iso={u.startedAt} format="date" />
                      </>
                    )}
                    {u.areaName && ` · ${u.areaName}`}
                    {u.modality && (
                      <span className="capitalize"> · {u.modality}</span>
                    )}
                    {u.operatorName && ` · ${u.operatorName}`}
                    {(u.machineFrequency || u.probeLabel) &&
                      ` · ${[u.machineFrequency, u.probeLabel]
                        .filter(Boolean)
                        .join(" · ")}`}
                    {" · "}
                    {u.aftercareExplainedAt
                      ? "Aftercare marked"
                      : "Aftercare not marked"}
                  </span>
                  {u.clientId && (
                    <Link
                      href={`/clients/${u.clientId}/sessions/${u.sessionId}`}
                      className="font-medium text-neutral-700 hover:underline dark:text-neutral-300"
                    >
                      Open session →
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
