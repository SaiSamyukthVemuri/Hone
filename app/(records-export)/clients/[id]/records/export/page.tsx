// HON-46 — per-client clinical-records PREVIEW / PRINT.
//
// Authenticated app route, OWNER ONLY, for one client of the signed-in studio,
// scoped to one session, one studio-local day, or a studio-local date range.
// Not reachable from the client portal, public booking, receipts, email or
// SMS; nothing is emailed or stored (#828: in-app only).
//
// Every preview writes an audit_logs event BEFORE any record is read, and the
// page shows no record if that write fails (#828 G-13, fail closed). Printing
// is audited the same way by the print button. Private warnings and personal
// notes are never read (lib/clinical-records/export-queries.ts), and the page
// states plainly what the document does not contain (#828 F18/G-21).
//
// The page <title> is fixed and carries no client name: browsers use it as the
// default file name when printing to PDF.

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import {
  EXPORT_EXCLUSIONS,
  MAX_RANGE_DAYS,
  auditThenLoad,
  buildClinicalRecordsDocument,
  parseExportScope,
  scopeAuditMetadata,
  type ClinicalRecordsDocument,
  type ExportedEntry,
  type Reading,
} from "@/lib/clinical-records/export-scope";
import {
  loadClinicalRecordsForExport,
  loadExportClientIdentity,
  recordClinicalRecordsAudit,
  EXPORT_SESSION_LIMIT,
  type ClinicalRecordsLoad,
} from "@/lib/clinical-records/export-queries";

type LoadedRecords = Extract<ClinicalRecordsLoad, { ok: true }>["value"];
import { AuditedPrintButton } from "./print-button";
import {
  EXPORT_DOCUMENT_ID,
  PRINT_GATE_CSS,
  PRINT_UNARMED_NOTICE,
} from "@/lib/clinical-records/print-gate";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Clinical records export" };

type RawScope = { scope?: string; session?: string; day?: string; from?: string; to?: string };

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function formatInstant(iso: string | null, timezone: string): string {
  if (!iso) return "Not recorded";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Not recorded";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

const NOTE_KIND_LABEL: Record<string, string> = {
  consultation: "Consultation note",
  skin_hair_analysis: "Skin & hair analysis",
};

function ReadingList({ readings }: { readings: Reading[] }) {
  if (readings.length === 0) return null;
  return (
    <p className="mt-1">
      {readings.map((r) => `${r.label}: ${r.value}`).join(" · ")}
    </p>
  );
}

function EntryList({ entries }: { entries: ExportedEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <ul className="mt-1 flex flex-col gap-1 text-xs">
      {entries.map((e) => (
        <li key={e.id} data-testid="export-entry">
          <span className="font-medium">{e.areas.join(", ") || "Area not recorded"}</span>
          {e.readings.length > 0 ? ` · ${e.readings.map((r) => `${r.label}: ${r.value}`).join(" · ")}` : ""}
          {e.observations.length > 0 ? ` · Observed: ${e.observations.join(", ")}` : ""}
          {e.comments ? ` — ${e.comments}` : ""}
        </li>
      ))}
    </ul>
  );
}

export default async function ClinicalRecordsExportPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const { practitioner, studio } = await requirePractitionerWithStudio();

  // OWNER ONLY. Refused before any client or record read.
  if (practitioner.role !== "owner" || !practitioner.active) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-6">
        <h1 className="text-lg font-semibold">Clinical records export</h1>
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
          Only the studio owner can export clinical records.
        </p>
      </div>
    );
  }

  // Identity ONLY before the audit (Codex P1 4301153305): id and name, never
  // the broad profile loader, which also reads pricing, sessions and entries.
  const client = await loadExportClientIdentity(studio.id, id);
  if (!client) notFound();

  const rawScope: RawScope = {
    scope: one(sp.scope),
    session: one(sp.session),
    day: one(sp.day),
    from: one(sp.from),
    to: one(sp.to),
  };
  const parsed = parseExportScope(rawScope);

  let outcome:
    | { ok: true; document: ClinicalRecordsDocument; truncated: boolean; scopeKind: "session" | "day" | "range" }
    | { ok: false; reason: "audit_failed" | "load_failed" }
    | null = null;
  if (parsed.ok) {
    const scope = parsed.scope;
    const result = await auditThenLoad<LoadedRecords>(
      () =>
        recordClinicalRecordsAudit({
          studioId: studio.id,
          actorId: practitioner.id,
          clientId: client.id,
          action: "clinical_records_previewed",
          metadata: scopeAuditMetadata(scope),
        }),
      async () => {
        const load = await loadClinicalRecordsForExport({
          studioId: studio.id,
          clientId: client.id,
          scope,
          timezone: studio.timezone,
        });
        return load.ok ? { ok: true as const, value: load.value } : { ok: false as const };
      },
    );
    outcome = result.ok
      ? {
          ok: true,
          document: buildClinicalRecordsDocument(result.document),
          truncated: result.document.truncated,
          scopeKind: scope.kind,
        }
      : result;
  }

  const tz = studio.timezone;
  return (
    <>
    {/* PRINT GATE (Codex P1 4301153310). The browser's own print (Ctrl/Cmd+P,
        Save as PDF) never runs the audited Print button, so in print media the
        document is HIDDEN unless that button armed it after the print audit
        was recorded; an unarmed print shows only the notice below. */}
    <style>{PRINT_GATE_CSS}</style>
    <div
      id={EXPORT_DOCUMENT_ID}
      data-export-document=""
      className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6 print:px-0 print:py-0"
    >
      <header className="flex items-start justify-between gap-4 border-b border-neutral-300 pb-4 print:border-black">
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-semibold">Clinical records: {client.name}</h1>
          <p className="text-xs text-neutral-600 dark:text-neutral-400">
            {studio.name} · Generated {formatInstant(new Date().toISOString(), tz)}
          </p>
          <Link href={`/clients/${client.id}`} className="text-xs underline print:hidden">
            Back to client
          </Link>
        </div>
        {outcome?.ok && <AuditedPrintButton clientId={client.id} rawScope={rawScope} />}
      </header>

      <form method="get" className="flex flex-wrap items-end gap-3 text-sm print:hidden" aria-label="Export scope">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-neutral-600">Scope</span>
          <select name="scope" defaultValue={rawScope.scope ?? "range"} className="min-h-[44px] rounded-md border px-2">
            <option value="day">One day</option>
            <option value="range">Date range</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-neutral-600">Day</span>
          <input type="date" name="day" defaultValue={rawScope.day} className="min-h-[44px] rounded-md border px-2" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-neutral-600">From</span>
          <input type="date" name="from" defaultValue={rawScope.from} className="min-h-[44px] rounded-md border px-2" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-neutral-600">To</span>
          <input type="date" name="to" defaultValue={rawScope.to} className="min-h-[44px] rounded-md border px-2" />
        </label>
        <button type="submit" className="min-h-[44px] rounded-md border px-4">
          Preview
        </button>
      </form>

      {!parsed.ok && parsed.reason !== "missing" && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {parsed.reason === "range_too_long"
            ? `Choose a range of at most ${MAX_RANGE_DAYS} days.`
            : "That scope is not valid. Choose a day or a date range; a single session is printed from its own link in a day or range view."}
        </p>
      )}

      {outcome && !outcome.ok && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {outcome.reason === "audit_failed"
            ? "Could not record this export in the audit log, so no records are shown. Try again."
            : "Could not load these records. Try again."}
        </p>
      )}

      {outcome?.ok && (
        <>
          <section aria-label="Not included" className="rounded-md border border-neutral-300 p-3 text-xs">
            <p className="font-medium">This document does not include:</p>
            <ul className="mt-1 list-disc pl-5">
              {EXPORT_EXCLUSIONS.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
            <p className="mt-1">It is not a complete patient record.</p>
          </section>

          {outcome.truncated && (
            <p className="text-sm">Showing the first {EXPORT_SESSION_LIMIT} sessions in this range. Narrow the range to see the rest.</p>
          )}

          <section className="flex flex-col gap-3" aria-label="Sessions">
            <h2 className="text-sm font-semibold uppercase tracking-wider">Treatment sessions</h2>
            {outcome.document.sessions.length === 0 ? (
              <p className="text-sm text-neutral-500">No sessions in this scope.</p>
            ) : (
              <ul className="flex flex-col gap-4">
                {outcome.document.sessions.map((s) => (
                  <li key={s.id} className="break-inside-avoid border-b border-neutral-100 pb-3" data-testid="export-session">
                    <p className="text-sm font-medium">{formatInstant(s.startedAt, tz)}</p>
                    <p className="text-[11px] text-neutral-600">
                      {[s.modality, s.practitioner ?? "Unknown practitioner", s.recordStatus].filter(Boolean).join(" · ")}
                    </p>
                    {s.notes && <p className="mt-1 whitespace-pre-wrap break-words text-sm">{s.notes}</p>}
                    {s.aftercareExplainedAt && (
                      <p className="mt-1 text-[11px]">Risks explained and aftercare provided: {formatInstant(s.aftercareExplainedAt, tz)}</p>
                    )}
                    {s.blocks.map((b) => (
                      <div key={b.id} className="mt-2 rounded border border-neutral-200 p-2 text-xs" data-testid="export-block">
                        <p className="font-medium">{b.title}</p>
                        <ReadingList readings={b.readings} />
                        <ReadingList readings={b.notes} />
                        <EntryList entries={b.entries} />
                      </div>
                    ))}
                    <EntryList entries={s.entries} />
                    {s.laserEntries.map((l) => (
                      <div key={l.id} className="mt-2 rounded border border-neutral-200 p-2 text-xs" data-testid="export-laser">
                        <p className="font-medium">Laser · {l.zone}</p>
                        <ReadingList readings={l.readings} />
                        <ReadingList readings={l.notes} />
                      </div>
                    ))}
                    {/* SINGLE-SESSION SCOPE (Codex P2 4301153316): reachable from this
                        audited view; a plain anchor, so it is a full document load. */}
                    {outcome.scopeKind !== "session" && (
                      <a
                        href={`/clients/${client.id}/records/export?scope=session&session=${s.id}`}
                        className="mt-1 inline-block text-xs underline print:hidden"
                        data-testid="export-session-link"
                      >
                        Print only this session
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="flex flex-col gap-3" aria-label="Clinical notes">
            <h2 className="text-sm font-semibold uppercase tracking-wider">Clinical notes</h2>
            {outcome.document.clinicalNotes.length === 0 ? (
              <p className="text-sm text-neutral-500">No clinical notes in this scope.</p>
            ) : (
              <ul className="flex flex-col gap-4">
                {outcome.document.clinicalNotes.map((n) => (
                  <li key={n.id} className="break-inside-avoid border-b border-neutral-100 pb-3" data-testid="export-note">
                    <p className="text-sm font-medium">
                      {NOTE_KIND_LABEL[n.kind] ?? n.kind} · {formatInstant(n.occurredAt, tz)}
                    </p>
                    <p className="text-[11px] text-neutral-600">
                      {n.practitioner ?? "Unknown practitioner"}
                      {n.isRevision ? " · revision" : ""}
                    </p>
                    <p className="mt-1 whitespace-pre-wrap break-words text-sm">{n.body}</p>
                    {n.areas.length > 0 && <p className="mt-1 text-[11px]">Areas: {n.areas.join(", ")}</p>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
    <p data-print-unarmed-notice="" className="px-4 py-6 text-sm">
      {PRINT_UNARMED_NOTICE}
    </p>
    </>
  );
}
