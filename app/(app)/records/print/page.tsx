import Link from "next/link";
import {
  getClientsForStudio,
  getCurrentPractitionerWithStudio,
} from "@/lib/supabase/queries";
import {
  getAuditEventsByRecord,
  getClientProcedureRecords,
  getDisinfectantRecords,
  getExposureIncidentRecords,
  getProcedureAuditEvents,
  getSterileItemRecords,
  normalizeProcedureRecordFilter,
  utcInstantsForLocalDayRange,
} from "@/lib/record-keeping/queries";
import {
  disinfectantDueStatus,
  disinfectantStatusLabel,
  isDisinfectantAlert,
} from "@/lib/record-keeping/disinfectant-status";
import { supplyExpiryPrintMarker } from "@/lib/record-keeping/expiry";
import { todayInTz } from "@/lib/booking/tz";
import type { RecordKeepingAuditEvent } from "@/lib/types/database";
import { PrintButton } from "./print-button";

// PR #207: inspector-friendly print view for the Record Keeping
// module. One protected route (inside the authenticated (app) layout,
// so anonymous requests redirect to login exactly like /records) that
// renders ONE section as a clean, print-first document:
//   /records/print?section=sterile|disinfectants|incidents|procedures
//   &history=1 optionally appends the PR #206 audit history per record
//   (default OFF; Chloe opts in).
// The app chrome is print:hidden, so window.print() on iPad emits
// only the header (studio, section, generated timestamp) + records.
// Missing values render "Not recorded"; nothing is invented. This is
// inspection-support tooling, NOT a legal compliance guarantee. No
// public export links, no file storage, no email.

const SECTION_TITLES = {
  sterile: "Sterile Items Records",
  disinfectants: "Disinfectant Records",
  incidents: "Accidental Blood/Body Fluid Exposure Records",
  procedures: "Client Records for Invasive Procedures",
} as const;
type SectionKey = keyof typeof SECTION_TITLES;

function isSection(v: string | undefined): v is SectionKey {
  return (
    v === "sterile" ||
    v === "disinfectants" ||
    v === "incidents" ||
    v === "procedures"
  );
}

function notRecorded(v: string | null | undefined): string {
  const t = v?.trim();
  return t && t.length > 0 ? t : "Not recorded";
}

function dateOnly(d: string | null): string {
  return d ? d.slice(0, 10) : "Not recorded";
}

// Deterministic UTC stamp; the printed page is a record and must be
// unambiguous regardless of device timezone.
function utcStamp(d: Date): string {
  return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

const AUDIT_ACTION_LABELS: Record<RecordKeepingAuditEvent["action"], string> = {
  created: "Created",
  updated: "Updated",
  aftercare_marked: "Marked: risks explained and aftercare provided",
  aftercare_cleared: "Cleared: risks/aftercare mark removed",
  probe_lot_updated: "Probe lot number updated",
};

function HistoryLines({
  events,
}: {
  events: RecordKeepingAuditEvent[] | undefined;
}) {
  if (!events || events.length === 0) return null;
  return (
    <div className="mt-1 border-t border-neutral-200 pt-1 text-[11px] text-neutral-600">
      <p className="font-medium">History</p>
      <ul className="flex flex-col gap-0.5">
        {events.map((e) => (
          <li key={e.id}>
            {utcStamp(new Date(e.created_at))} · {e.actor_display_name ?? "Unknown"} ·{" "}
            {AUDIT_ACTION_LABELS[e.action] ?? e.action}
            {e.action === "updated" && e.changed_fields.length > 0
              ? ` (${e.changed_fields.join(", ")})`
              : ""}
          </li>
        ))}
      </ul>
    </div>
  );
}

function FieldLine({ label, value }: { label: string; value: string }) {
  return (
    <p>
      <span className="font-medium">{label}:</span> {value}
    </p>
  );
}

export default async function RecordKeepingPrintPage({
  searchParams,
}: {
  searchParams: Promise<{
    section?: string;
    history?: string;
    clientId?: string;
    from?: string;
    to?: string;
  }>;
}) {
  const sp = await searchParams;
  const section: SectionKey = isSection(sp.section) ? sp.section : "sterile";
  const includeHistory = sp.history === "1";
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  // PR #222: exposure incident history is owner-only (RLS, migration
  // 0088); the print surface mirrors that with an explicit note.
  const isOwner = practitioner.role === "owner";
  const generatedAt = utcStamp(new Date());
  // PR #223: the procedures section accepts the same per-client
  // filter as the Records page so a printed pull matches the screen.
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
  const filteredClient =
    section === "procedures" && procedureFilter.clientId
      ? ((await getClientsForStudio(studio.id)).find(
          (c) => c.id === procedureFilter.clientId,
        ) ?? null)
      : null;

  return (
    <div className="flex flex-col gap-5 bg-white text-neutral-900">
      {/* Screen-only toolbar. */}
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link
          href={`/records?section=${section}${section === "procedures" ? procedureFilterQuery : ""}`}
          className="text-sm text-neutral-500 hover:text-neutral-900"
        >
          ← Record Keeping
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <Link
            href={`/records/print?section=${section}${includeHistory ? "" : "&history=1"}${section === "procedures" ? procedureFilterQuery : ""}`}
            className="rounded-md border border-neutral-300 px-4 py-3 text-sm text-neutral-700 hover:bg-neutral-50"
          >
            {includeHistory ? "Hide history" : "Include history"}
          </Link>
          <PrintButton />
        </div>
      </div>

      {/* Document header: studio, section, generated timestamp. */}
      <header className="border-b-2 border-neutral-900 pb-3">
        <h1 className="text-2xl font-semibold">{SECTION_TITLES[section]}</h1>
        <p className="mt-1 text-sm">
          {studio.name} · Generated {generatedAt}
          {includeHistory ? " · Includes edit history" : ""}
        </p>
        {section === "procedures" &&
          (procedureFilter.clientId ||
            procedureFilter.from ||
            procedureFilter.to) && (
            <p className="mt-1 text-sm font-medium">
              Filtered: client{" "}
              {filteredClient?.name ?? "(not found in this studio)"}
              {procedureFilter.from || procedureFilter.to
                ? ` · recorded sessions from ${procedureFilter.from ?? "the first record"} to ${procedureFilter.to ?? "today"}`
                : ""}
            </p>
          )}
        <p className="text-[11px] text-neutral-500">
          Record-keeping support generated from Hone records. Missing
          information is shown as Not recorded.
        </p>
      </header>

      {section === "sterile" && (
        <SterilePrint
          studioId={studio.id}
          includeHistory={includeHistory}
          timezone={studio.timezone}
        />
      )}
      {section === "disinfectants" && (
        <DisinfectantsPrint
          studioId={studio.id}
          includeHistory={includeHistory}
          timezone={studio.timezone}
        />
      )}
      {section === "incidents" &&
        (isOwner ? (
          <IncidentsPrint
            studioId={studio.id}
            includeHistory={includeHistory}
          />
        ) : (
          <p className="text-sm">
            Exposure incident history is owner-only and is not included in
            this export.
          </p>
        ))}
      {section === "procedures" && (
        <ProceduresPrint
          studioId={studio.id}
          includeHistory={includeHistory}
          timezone={studio.timezone}
          filter={procedureFilter}
        />
      )}
    </div>
  );
}

async function SterilePrint({
  studioId,
  includeHistory,
  timezone,
}: {
  studioId: string;
  includeHistory: boolean;
  timezone: string;
}) {
  const records = await getSterileItemRecords(studioId);
  // PR #317: studio-local "today" for the print-safe expiry marker.
  const today = todayInTz(timezone);
  const audit = includeHistory
    ? await getAuditEventsByRecord(
        studioId,
        "sterile_item",
        records.map((r) => r.id),
      )
    : new Map();
  if (records.length === 0)
    return <p className="text-sm">No sterile item records.</p>;
  return (
    <ul className="flex flex-col divide-y divide-neutral-300 text-sm">
      {records.map((r) => (
        <li key={r.id} className="break-inside-avoid py-2">
          <FieldLine label="Date purchased" value={dateOnly(r.date_purchased)} />
          <FieldLine label="Item description" value={notRecorded(r.item_description)} />
          <FieldLine label="Manufacturer" value={notRecorded(r.manufacturer_name)} />
          <FieldLine label="Amount purchased" value={notRecorded(r.amount_purchased)} />
          <FieldLine label="Lot #" value={notRecorded(r.lot_number)} />
          {/* PR #317: plain-text expiry marker so a printed/exported inspection
              record flags expired / expires-today / expires-soon (color won't
              print). Only appended when an expiry date is recorded. */}
          <FieldLine
            label="Expiry date"
            value={
              r.expiry_date
                ? `${dateOnly(r.expiry_date)}${supplyExpiryPrintMarker(r.expiry_date, today)}`
                : dateOnly(r.expiry_date)
            }
          />
          {r.notes && <FieldLine label="Notes" value={r.notes} />}
          <p className="text-[11px] text-neutral-500">
            Recorded {utcStamp(new Date(r.created_at))}
            {r.updated_at !== r.created_at &&
              ` · Last updated ${utcStamp(new Date(r.updated_at))}`}
          </p>
          <HistoryLines events={audit.get(r.id)} />
        </li>
      ))}
    </ul>
  );
}

async function DisinfectantsPrint({
  studioId,
  includeHistory,
  timezone,
}: {
  studioId: string;
  includeHistory: boolean;
  timezone: string;
}) {
  const records = await getDisinfectantRecords(studioId);
  const audit = includeHistory
    ? await getAuditEventsByRecord(
        studioId,
        "disinfectant",
        records.map((r) => r.id),
      )
    : new Map();
  if (records.length === 0)
    return <p className="text-sm">No disinfectant records.</p>;
  // PR #295: read-time discard / replace-by status, computed against the
  // studio's "today" (the same deterministic todayInTz the in-app Records
  // screen uses) so the printed inspection log matches what staff see on
  // screen. Display-only — nothing is stored or sent.
  const today = todayInTz(timezone);
  return (
    <ul className="flex flex-col divide-y divide-neutral-300 text-sm">
      {records.map((r) => {
        const status = disinfectantDueStatus(r, today);
        const statusLabel = isDisinfectantAlert(status)
          ? disinfectantStatusLabel(status)
          : null;
        return (
          <li key={r.id} className="break-inside-avoid py-2">
            <FieldLine label="Date prepared" value={dateOnly(r.date_prepared)} />
            <FieldLine label="Disinfectant" value={notRecorded(r.disinfectant_name)} />
            <FieldLine label="Concentration" value={notRecorded(r.concentration)} />
            <FieldLine
              label="Date discarded"
              value={r.date_discarded ? dateOnly(r.date_discarded) : "In use"}
            />
            <FieldLine
              label="Replace by"
              value={r.discard_due_date ? dateOnly(r.discard_due_date) : "Not set"}
            />
            {statusLabel && (
              <FieldLine label="Replace status" value={statusLabel} />
            )}
            <FieldLine label="Operator" value={notRecorded(r.operator_name)} />
            {r.notes && <FieldLine label="Notes" value={r.notes} />}
            <p className="text-[11px] text-neutral-500">
              Recorded {utcStamp(new Date(r.created_at))}
              {r.updated_at !== r.created_at &&
                ` · Last updated ${utcStamp(new Date(r.updated_at))}`}
            </p>
            <HistoryLines events={audit.get(r.id)} />
          </li>
        );
      })}
    </ul>
  );
}

async function IncidentsPrint({
  studioId,
  includeHistory,
}: {
  studioId: string;
  includeHistory: boolean;
}) {
  const records = await getExposureIncidentRecords(studioId);
  const audit = includeHistory
    ? await getAuditEventsByRecord(
        studioId,
        "exposure_incident",
        records.map((r) => r.id),
      )
    : new Map();
  if (records.length === 0)
    return <p className="text-sm">No exposure incidents recorded.</p>;
  return (
    <ul className="flex flex-col divide-y divide-neutral-300 text-sm">
      {records.map((r) => (
        <li key={r.id} className="break-inside-avoid py-2">
          <FieldLine label="Incident date" value={dateOnly(r.incident_date)} />
          <FieldLine
            label="Exposed person"
            value={notRecorded(r.exposed_person_full_name)}
          />
          <FieldLine
            label="Address"
            value={notRecorded(r.exposed_person_address)}
          />
          <FieldLine label="Phone" value={notRecorded(r.exposed_person_phone)} />
          <FieldLine
            label="How the exposure occurred"
            value={notRecorded(r.exposure_details)}
          />
          <FieldLine label="Action taken" value={notRecorded(r.action_taken)} />
          <FieldLine
            label="Staff involved"
            value={notRecorded(r.staff_involved_name)}
          />
          {r.notes && <FieldLine label="Notes" value={r.notes} />}
          <p className="text-[11px] text-neutral-500">
            Recorded {utcStamp(new Date(r.created_at))}
            {r.updated_at !== r.created_at &&
              ` · Last updated ${utcStamp(new Date(r.updated_at))}`}
          </p>
          <HistoryLines events={audit.get(r.id)} />
        </li>
      ))}
    </ul>
  );
}

async function ProceduresPrint({
  studioId,
  includeHistory,
  timezone,
  filter,
}: {
  studioId: string;
  includeHistory: boolean;
  timezone: string;
  filter: { clientId: string | null; from: string | null; to: string | null };
}) {
  const { fromUtc, toUtcExclusive } = utcInstantsForLocalDayRange(
    filter.from,
    filter.to,
    timezone,
  );
  const records = await getClientProcedureRecords(studioId, {
    clientId: filter.clientId,
    fromUtc,
    toUtcExclusive,
  });
  const audit = includeHistory
    ? await getProcedureAuditEvents(
        studioId,
        records.map((r) => r.sessionId),
      )
    : new Map();
  if (records.length === 0)
    return (
      <p className="text-sm">
        {filter.clientId || filter.from || filter.to
          ? "No recorded sessions match this filter."
          : "No sessions recorded."}
      </p>
    );
  return (
    <ul className="flex flex-col divide-y divide-neutral-300 text-sm">
      {records.map((r) => (
        <li key={r.sessionId} className="break-inside-avoid py-2">
          <FieldLine
            label="Date of service"
            value={utcStamp(new Date(r.startedAt))}
          />
          <FieldLine label="Client" value={notRecorded(r.clientName)} />
          <FieldLine label="Date of birth" value={notRecorded(r.dateOfBirth)} />
          <FieldLine label="Phone" value={notRecorded(r.phone)} />
          <FieldLine label="Email" value={notRecorded(r.email)} />
          <FieldLine label="Address" value={notRecorded(r.address)} />
          <FieldLine label="Service" value={notRecorded(r.modality)} />
          <FieldLine label="Operator" value={notRecorded(r.operatorName)} />
          <div className="mt-0.5">
            <p className="font-medium">Items used:</p>
            {r.areas.length === 0 ? (
              <p>No treatment areas charted.</p>
            ) : (
              <ul className="ml-4 list-disc">
                {r.areas.map((a, i) => (
                  <li key={`${r.sessionId}-${i}`}>
                    {a.name}
                    {a.probeLabel ? ` · ${a.probeLabel}` : ""}
                    {a.machineFrequency ? ` · ${a.machineFrequency}` : ""} · Lot
                    #:{" "}
                    {notRecorded(a.probeLotNumber)}
                    {a.minutesPerformed != null
                      ? ` · ${a.minutesPerformed} min`
                      : ""}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <FieldLine
            label="Risks explained and aftercare information provided"
            value={
              r.aftercareExplainedAt
                ? `Yes (${utcStamp(new Date(r.aftercareExplainedAt))})`
                : "Not recorded"
            }
          />
          <HistoryLines events={audit.get(r.sessionId)} />
        </li>
      ))}
    </ul>
  );
}
