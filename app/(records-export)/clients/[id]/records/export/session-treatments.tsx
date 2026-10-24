// HON-46 — one session's treatments on the clinical-records printout.
//
// SCREEN == PAPER, BY CONSTRUCTION: a treatment area, a blockless entry and a
// laser pass print through the SAME components the saved session view renders
// (SavedAreaRecord, ElectrolysisEntryRow, LaserEntryRow), without the view's
// controls. The only additions are the NAMED print-only fields
// (PRINT_ONLY_FIELDS in lib/clinical-records/export-scope.ts): stored clinical
// record the saved view does not show (an area's own recorded times, its legacy
// note, a laser pass's results and settings), kept on paper, each marked
// [data-print-only]. tests/components/saved-record-print-parity.test.ts
// renders the real view and this component from one fixture and requires the
// same text, apart from exactly those named fields.

import { SavedAreaRecord } from "@/app/(app)/clients/[id]/sessions/[sessionId]/session-blocks-view";
import { ElectrolysisEntryRow, LaserEntryRow } from "@/components/entry-row";
import { formatExportInstant, type ClinicalRecordsDocument, type Reading } from "@/lib/clinical-records/export-scope";

function PrintOnlyList({ readings }: { readings: Reading[] }) {
  if (readings.length === 0) return null;
  return (
    <>
      {readings.map((r) => (
        <p key={r.label} data-print-only={r.label} className="whitespace-pre-wrap text-sm text-neutral-600">
          {r.label}: {r.value}
        </p>
      ))}
    </>
  );
}

export function ExportSessionTreatments({
  session,
  timezone,
}: {
  session: ClinicalRecordsDocument["sessions"][number];
  /** The studio's timezone: an area's recorded times print in it, as the session's do. */
  timezone: string;
}) {
  // Only recorded times print; a block with none prints exactly as before.
  const areaTimes = (b: ClinicalRecordsDocument["sessions"][number]["blocks"][number]): Reading[] => [
    ...(b.startedAt ? [{ label: "Area started", value: formatExportInstant(b.startedAt, timezone) }] : []),
    ...(b.endedAt ? [{ label: "Area ended", value: formatExportInstant(b.endedAt, timezone) }] : []),
  ];
  return (
    <>
      {session.blocks.map((b) => (
        <section
          key={b.id}
          data-testid="export-block"
          className="mt-2 flex break-inside-avoid flex-col gap-3 rounded border border-neutral-200 p-3"
        >
          <SavedAreaRecord block={b.record} />
          <PrintOnlyList readings={[...areaTimes(b), ...b.printOnly]} />
        </section>
      ))}
      {session.entries.length > 0 && (
        <section className="mt-2 rounded border border-neutral-200 p-3" data-testid="export-unassigned">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-neutral-600">Unassigned entries</h4>
          <ul className="mt-2 flex flex-col gap-2">
            {session.entries.map((e) => (
              <li key={e.id} data-testid="export-entry">
                <ElectrolysisEntryRow entry={e} />
              </li>
            ))}
          </ul>
        </section>
      )}
      {session.laserEntries.map((l) => (
        <div key={l.id} className="mt-2 flex break-inside-avoid flex-col gap-1" data-testid="export-laser">
          <LaserEntryRow entry={l.record} />
          <PrintOnlyList readings={l.printOnly} />
        </div>
      ))}
    </>
  );
}
