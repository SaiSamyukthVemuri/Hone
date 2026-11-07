import type { Metadata } from "next";
import Link from "next/link";
import { requirePractitionerWithStudio, getSessionBlockAreasByBlockIds } from "@/lib/supabase/queries";
import { createClient } from "@/lib/supabase/server";
import { readPrintIdentities } from "@/lib/clients/print-identity";
import { formatLocalDateLabel, localDateString, localTimeString12h } from "@/lib/booking/tz";
import { auditThenLoad, canPrintClinicalPacket, previewAuditMetadata, recordDayAudit } from "@/lib/records/print/day-audit";
import { loadDayDocument, type DayDocument } from "@/lib/records/print/day-document";
import { loadDayPacket, type PacketReader } from "@/lib/records/print/day-loader";
import { checkPrintableDay } from "@/lib/records/print/day-guard";
import { NOT_RECORDED, PACKET_EXCLUSIONS, PACKET_INCLUDES_NOTE, type PacketVisit, type Reading } from "@/lib/records/print/day-packet";
import { parseSelectedDay } from "@/lib/records/print/selected-day";
import { AuditedPrintButton } from "./print-button";

// HON-46 M2 — owner-authorized clinical print of ONE client's treatments on ONE
// studio-local day. Owner-only; audited BEFORE any record is read (migration
// 0233); every refusal is explicit and shows no clinical content.
//
// URL PRIVACY (G-26; Privacy's route answer, M-1..M-6). The client id and the day
// travel in the QUERY STRING, never the path, because the analytics redaction
// (redactVercelEvent) and the Sentry scrub drop the query and replace UUID path
// segments but cannot remove a date in a path. The page therefore:
//   * sends no referrer and asks not to be indexed (metadata below), so the
//     analytics beacon, links and any new tab carry no Referer;
//   * is never cached or shared (force-dynamic);
//   * is entered only by a deliberate click: every link here is prefetch={false}
//     with no referrer, since a prefetch of a dynamic route would run the audit
//     call and the clinical read without the owner opening anything;
//   * has a generic title and loads no third-party resource;
//   * logs, tags and attaches nothing containing the URL, client id or day.
// NOT closable here: Vercel's own platform request logs record the path and
// query before any application code runs. G-26 is NOT fully satisfied; that
// residual is a decision for Sam (Option A, pending).
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Clinical record",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Hide the record in print media unless the audited Print button armed it
// (browser print / Save as PDF never runs the button's audit). @page margin 0
// with inner padding keeps the browser's default header and footer, which print
// the URL, off the paper.
const PRINT_CSS = `
[data-print-unarmed-notice] { display: none; }
@media print {
  @page { margin: 0; }
  [data-packet-page] { padding: 16mm; }
  [data-packet-document]:not([data-print-armed]) { display: none !important; }
  [data-packet-document]:not([data-print-armed]) ~ [data-print-unarmed-notice] { display: block !important; }
}
`;

function Refusal({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div role="alert" data-testid="day-packet-refusal" className="flex flex-col gap-2 text-sm">
      <p className="text-base font-medium">{title}</p>
      <p>{children}</p>
      <p className="text-neutral-600">No clinical record is shown.</p>
      <Link href="/records" prefetch={false} referrerPolicy="no-referrer" className="text-neutral-600 underline print:hidden">
        Back to Record Keeping
      </Link>
    </div>
  );
}

function Lines({ readings }: { readings: Reading[] }) {
  if (readings.length === 0) return null;
  return (
    <ul className="ml-4 list-disc">
      {readings.map((r) => (
        <li key={`${r.label}:${r.value}`}>
          <span className="font-medium">{r.label}:</span> {r.value}
        </li>
      ))}
    </ul>
  );
}

function Visit({ v }: { v: PacketVisit }) {
  return (
    <li className="break-inside-avoid py-3" data-testid="day-packet-visit">
      <p className="font-medium">
        {v.startTime}
        {v.endTime ? ` – ${v.endTime}` : ""} · {v.service}
      </p>
      <p>
        <span className="font-medium">Practitioner:</span> {v.practitioner}
      </p>
      {v.sessionNotes && (
        <p className="whitespace-pre-wrap break-words">
          <span className="font-medium">Session notes:</span> {v.sessionNotes}
        </p>
      )}
      <p>
        <span className="font-medium">Risks and aftercare:</span> {v.aftercare}
      </p>
      {v.areas.length === 0 ? (
        <p>No treatment areas charted.</p>
      ) : (
        <ul className="mt-1 flex flex-col gap-2">
          {v.areas.map((a) => (
            <li key={a.id} className="break-inside-avoid">
              <p>
                <span className="font-medium">Area:</span> {a.label} · <span className="font-medium">Duration:</span> {a.duration}
                {a.startedAt ? ` · started ${a.startedAt}` : ""}
                {a.endedAt ? ` · ended ${a.endedAt}` : ""}
              </p>
              <Lines readings={a.settings} />
              <Lines readings={a.notes} />
              {a.entries.map((e, i) => (
                <Lines key={`${a.id}-e${i}`} readings={e} />
              ))}
            </li>
          ))}
        </ul>
      )}
      {v.looseEntries.length > 0 && (
        <div className="mt-1">
          <p className="font-medium">Entries not assigned to an area:</p>
          {v.looseEntries.map((e, i) => (
            <Lines key={`${v.id}-l${i}`} readings={e} />
          ))}
        </div>
      )}
      {v.laserPasses.length > 0 && (
        <div className="mt-1">
          <p className="font-medium">Laser passes:</p>
          {v.laserPasses.map((l) => (
            <Lines key={l.id} readings={l.readings} />
          ))}
        </div>
      )}
    </li>
  );
}

export default async function DayPacketPage({
  searchParams,
}: {
  searchParams: Promise<{ clientId?: string; day?: string }>;
}) {
  const sp = await searchParams;
  const { practitioner, studio } = await requirePractitionerWithStudio();

  // 1. OWNER GATE, before anything else is read (0233 enforces the same rule in the database).
  if (!canPrintClinicalPacket(practitioner)) {
    return <Refusal title="Only the studio owner can print clinical records.">Ask the owner to print this record.</Refusal>;
  }
  // 2. VALIDATE before any read or audit; never default to today or to "all".
  const day = parseSelectedDay(sp.day);
  if (!day.ok) {
    return (
      <Refusal title={day.reason === "missing" ? "Choose a day to print." : "That day is not a valid date."}>
        Open this page from a client, with one client and one day selected.
      </Refusal>
    );
  }
  const printable = checkPrintableDay(day.day, studio.timezone);
  if (!printable.ok) {
    return printable.reason === "future" ? (
      <Refusal title="That day is in the future.">There are no treatments to print for a day that has not happened.</Refusal>
    ) : (
      <Refusal title="That day is not a valid date.">Open this page from a client, with one client and one day selected.</Refusal>
    );
  }
  const clientId = typeof sp.clientId === "string" && UUID.test(sp.clientId) ? sp.clientId.toLowerCase() : null;
  if (clientId === null) {
    return <Refusal title="Choose a client to print.">Open this page from a client, with one client and one day selected.</Refusal>;
  }

  // 3. AUDIT FIRST, then load. Nothing about the client or the day is read until
  //    the preview is recorded (the database derives the studio and the owner).
  const supabase = await createClient();
  // The instant the packet is generated FROM: taken before the audit and the
  // first read, so "as of" never claims a treatment charted during the read
  // (Insurance E-3).
  const generatedFrom = new Date();
  const outcome = await auditThenLoad<Extract<DayDocument, { ok: true }>>(
    () =>
      recordDayAudit((fn, args) => supabase.rpc(fn, args), {
        clientId,
        action: "clinical_records_previewed",
        metadata: previewAuditMetadata(day.day),
      }),
    async () => {
      const reader = supabase as unknown as PacketReader;
      const doc = await loadDayDocument({
        studioId: studio.id,
        clientId,
        day: day.day,
        timezone: studio.timezone,
        studioName: studio.name,
        deps: {
          readClient: async (studioId, id) => {
            const { data, error } = await supabase.from("clients").select("id, name").eq("studio_id", studioId).eq("id", id).maybeSingle();
            if (error) return "error";
            return data ? { id: data.id as string, name: data.name as string } : null;
          },
          readIdentity: async (id) => {
            const r = await readPrintIdentities(supabase, [id]);
            const i = r.byClient.get(id);
            return { ok: r.ok, preferred_name: i?.preferred_name ?? null, legal_name: i?.legal_name ?? null };
          },
          loadDay: () =>
            loadDayPacket({
              supabase: reader,
              studioId: studio.id,
              clientId,
              day: day.day,
              timezone: studio.timezone,
              loadBlockAreas: (ids, studioId) => getSessionBlockAreasByBlockIds(ids, studioId),
            }),
        },
      });
      if (!doc.ok) return { ok: false as const };
      return { ok: true as const, value: doc };
    },
  );

  if (!outcome.ok) {
    return outcome.reason === "audit_failed" ? (
      <Refusal title="Could not record this view in the audit log.">
        Nothing was read. Check that the client is in this studio and try again.
      </Refusal>
    ) : (
      <Refusal title="Could not load this record.">
        This page is not a record. Nothing is listed because the read failed, not because there were no treatments.
      </Refusal>
    );
  }

  const { packet, legalNamesUnavailable } = outcome.document;
  const dayLabel = formatLocalDateLabel(packet.day);
  const readAt = `${formatLocalDateLabel(localDateString(generatedFrom, studio.timezone))}, ${localTimeString12h(generatedFrom, studio.timezone)} (${studio.timezone})`;

  return (
    <div data-packet-page className="mx-auto flex max-w-3xl flex-col gap-4 bg-white p-4 text-neutral-900">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link href="/records" prefetch={false} referrerPolicy="no-referrer" className="text-sm text-neutral-600 underline">
          Back to Record Keeping
        </Link>
        {packet.visits.length > 0 && <AuditedPrintButton clientId={clientId} day={packet.day} previewAuditId={outcome.previewAuditId} />}
      </div>
      <style>{PRINT_CSS}</style>

      <div data-packet-document>
        <header className="border-b-2 border-neutral-900 pb-3">
          <h1 className="text-2xl font-semibold">Clinical treatment record</h1>
          <p className="mt-1 text-sm">
            {packet.studioName} · Treatments on {dayLabel}
          </p>
          <p className="text-sm">
            <span className="font-medium">Client:</span> {packet.clientName}
          </p>
          <p className="text-sm">
            <span className="font-medium">Date of birth:</span> {packet.dateOfBirth}
          </p>
          <p className="text-[11px] text-neutral-600">
            Generated from Hone records as of {readAt}; a treatment charted after that time is not included. A treatment is
            listed on the day it started. Missing information is shown as {NOT_RECORDED}.
            {legalNamesUnavailable ? " Legal names could not be loaded; this record shows the name on file." : ""}
          </p>
        </header>

        {packet.visits.length === 0 ? (
          <p data-testid="day-packet-empty" className="py-4 text-sm">
            No treatments were recorded for this client on {dayLabel}.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-neutral-300 text-sm">
            {packet.visits.map((v) => (
              <Visit key={v.id} v={v} />
            ))}
          </ul>
        )}

        <footer className="mt-4 border-t border-neutral-300 pt-2 text-[11px] text-neutral-600">
          <p>{PACKET_INCLUDES_NOTE}</p>
          <p className="mt-1 font-medium">Not included in this record:</p>
          <ul className="ml-4 list-disc">
            {PACKET_EXCLUSIONS.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </footer>
      </div>
      <p data-print-unarmed-notice className="text-sm">
        This record can only be printed with the Print button on the page, so that the print is recorded.
      </p>
    </div>
  );
}
