import { ClinicalUnavailableNotice } from "@/components/clinical-unavailable-notice";
import { EmptyState } from "@/components/ui/empty-state";
import { SectionLabel } from "@/components/ui/section-label";
import { FormattedDateTime } from "@/components/formatted-date-time";
import type { BeforeToday } from "@/lib/sessions/before-today";
import {
  IMPORTED_PROVENANCE_NOTE,
  type ImportedMemoryList,
} from "@/lib/imported-treatment-memory";

// PR #211: "Before today" pre-treatment briefing on the client
// Overview. A compact action briefing assembled from recorded history
// the page already loads; the blue treatment-memory styling matches
// the existing "From last visit, for today" surfaces. It summarizes,
// never duplicates, the Last treatment and Treatment Intelligence
// cards, and it never suggests settings or makes outcome claims.
//
// PR #237: reordered as a pre-treatment briefing. Remember today is
// first and visually dominant; the last treatment snapshot (date,
// areas, modality, setup, probe lot, minutes) renders as wrapping
// chips; the client response (tolerance, reaction, reaction notes)
// has its own section; record reminders stay last. Recorded-history
// wording only; long notes wrap; nothing is invented.

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-line bg-surface-sunken px-2.5 py-0.5 text-xs text-fg-muted">
      {children}
    </span>
  );
}

export function BeforeTodayCard({
  briefing,
  importedMemory,
}: {
  briefing: BeforeToday;
  // PR #259: imported (paper/Jane/spreadsheet) history for this client,
  // loaded read-only by the page via the RLS-backed studio+client-scoped
  // helper (voided rows already excluded, capped + newest-first). Optional
  // so existing call sites that pass only `briefing` are unaffected.
  importedMemory?: ImportedMemoryList;
}) {
  const last = briefing.lastTreated;
  const setup = briefing.setup;
  const response = briefing.response;

  // UI-06 item 2. The no-history branch below was a bespoke dashed box
  // duplicating what the EmptyState primitive already does, and the semantics
  // matched exactly: a title naming the absence, a description saying what
  // fills it. Copy is carried over VERBATIM — a visual slice does not reword
  // clinical guidance.
  //
  // The note lives here rather than beside the JSX: a comment as a sibling
  // inside a ternary branch is a TS1005, which this lane already paid for once.
  return (
    <section className="flex flex-col gap-4 rounded-lg border border-line p-5">
      <header>
        <h2 className="text-sm font-medium uppercase tracking-wider text-neutral-500">
          Before today
        </h2>
        <p className="mt-1 text-xs text-neutral-500">
          Key reminders from recorded history before starting this client. Use
          professional judgment. This reflects recorded history only.
        </p>
      </header>

      {/* CLIN-01-B: `unavailable` is checked BEFORE `hasHistory`, and the order
          is load-bearing. Under a failed clinical read `hasHistory` is false
          because nothing could be READ, so the next branch would say "No
          charted treatment history yet." about a client who may have forty
          visits. The reminders survive because they come from the client
          record, which loaded; they render only when non-empty, so the
          "Procedure record looks complete" sentence never appears here. */}
      {briefing.unavailable ? (
        <div className="flex flex-col gap-4">
          <ClinicalUnavailableNotice testId="before-today-unavailable" />
          {briefing.reminders.length > 0 && (
            <div>
              {/* Deliberately a DIFFERENT label from the procedure-record one
                  used below: the only reminders that survive an unavailable
                  clinical read are the client-record ones, and reusing that
                  label would imply the procedure record had been checked. */}
              <SectionLabel size="caption" as="h3">Client record reminders</SectionLabel>
              <ul className="mt-1 list-disc pl-5 text-sm text-neutral-700 dark:text-neutral-300">
                {briefing.reminders.map((r) => (
                  <li key={r} className="break-words">
                    {r}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : !briefing.hasHistory ? (
        <EmptyState
          title="No charted treatment history yet."
          description="Treatment memory will appear here after the first charted session. Use intake, consultation notes, and professional judgment."
        />
      ) : (
        <div className="flex flex-col gap-4">
          {/* 1. Remember today: first and dominant. */}
          <div className="rounded-md border border-blue-200 bg-blue-50 px-4 py-3 dark:border-blue-900 dark:bg-blue-950/40">
            {/* UI-06 item 4. This was a FOURTH spelling of the section label —
                text-xs font-semibold, tinted blue — beside the primitive's
                text-xs font-medium. `tone="inherit"` lets the callout keep
                its blue while the primitive owns the shape, which is the same
                division UI-R02 used for the amber operational alerts. */}
            <SectionLabel
              as="h3"
              tone="inherit"
              className="text-blue-800 dark:text-blue-300"
            >
              Remember today
            </SectionLabel>
            <div className="mt-1.5 flex flex-col gap-1 text-sm text-blue-950 dark:text-blue-100">
              {briefing.remember.hasNotes ? (
                <>
                  {briefing.remember.watchLines.map((line) => (
                    <p key={line} className="break-words">
                      <span className="font-medium">Watch:</span> {line}
                    </p>
                  ))}
                  {briefing.remember.plan && (
                    <p className="whitespace-pre-wrap break-words">
                      <span className="font-medium">For next visit:</span>{" "}
                      {briefing.remember.plan}
                    </p>
                  )}
                </>
              ) : (
                <p className="text-blue-900/70 dark:text-blue-200/70">
                  No watch or plan notes recorded from the last treatment.
                </p>
              )}
            </div>
          </div>

          {/* 2. Last treatment snapshot: date, areas, modality, setup. */}
          {last && (
            <div>
              <SectionLabel size="caption" as="h3">Last treatment</SectionLabel>
              {/* PR #268 (chart parts): name the treatment area being recalled,
                  with an "Area not recorded" fallback for legacy entries. */}
              <p className="mt-1 text-sm">
                <span className="text-neutral-500">Treatment area: </span>
                {last.areasLine ? (
                  <span className="break-words font-medium">
                    {last.areasLine}
                  </span>
                ) : (
                  <span className="text-neutral-400">Area not recorded</span>
                )}{" "}
                · <FormattedDateTime iso={last.startedAt} format="date" />
              </p>
              {setup?.areaName && (
                <p className="mt-1.5 text-xs text-neutral-500">
                  Latest recorded setup: {setup.areaName}
                </p>
              )}
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                <Chip>
                  <span className="capitalize">{last.modality}</span>
                </Chip>
                {setup?.frequency && <Chip>{setup.frequency}</Chip>}
                {setup?.probe && <Chip>{setup.probe}</Chip>}
                {last.probeLot && <Chip>Lot {last.probeLot}</Chip>}
                {setup?.modeLabel && <Chip>{setup.modeLabel}</Chip>}
                {setup?.energyLevel != null && (
                  <Chip>EL {setup.energyLevel}</Chip>
                )}
                {last.minutes != null && <Chip>{last.minutes} min</Chip>}
              </div>
              {!setup && !last.probeLot && last.minutes == null && (
                <p className="mt-1 text-sm text-neutral-400">
                  Setup not recorded
                </p>
              )}
            </div>
          )}

          {/* 3. Client response, last recorded. */}
          <div>
            <SectionLabel size="caption" as="h3">Client response (last recorded)</SectionLabel>
            {response.hasAny ? (
              <>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {response.toleranceRating != null && (
                    <Chip>Tolerance {response.toleranceRating}/5</Chip>
                  )}
                  {response.reactionLabel && (
                    <Chip>{response.reactionLabel}</Chip>
                  )}
                </div>
                {response.reactionNotes && (
                  <p className="mt-1.5 whitespace-pre-wrap break-words text-sm text-neutral-700 dark:text-neutral-300">
                    {response.reactionNotes}
                  </p>
                )}
              </>
            ) : (
              <p className="mt-1 text-sm text-neutral-400">Not recorded</p>
            )}
          </div>

          {/* 4. Record reminders: clear, not alarming. */}
          <div>
            <SectionLabel size="caption" as="h3">Record reminders</SectionLabel>
            {briefing.reminders.length === 0 ? (
              <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
                Procedure record looks complete based on recorded fields.
              </p>
            ) : (
              <ul className="mt-1 list-disc pl-5 text-sm text-neutral-700 dark:text-neutral-300">
                {briefing.reminders.map((r) => (
                  <li key={r} className="break-words">
                    {r}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {/* PR #259: imported treatment memory. A read-only, visually distinct
          section (amber, NOT the blue Hone-charted styling) that shows
          regardless of whether live charted history exists, so paper/Jane/
          spreadsheet history is useful before the next appointment. Every row
          carries the provenance note so it is never read as live Hone
          charting. No edit/void/merge/convert actions. */}
      {importedMemory?.hasItems && (
        <div className="rounded-md border border-amber-200 bg-amber-50/60 px-4 py-3 dark:border-amber-900 dark:bg-amber-950/30">
          <SectionLabel size="caption" as="h3">Imported treatment memory</SectionLabel>
          <p className="mt-1 text-xs text-neutral-500">
            History imported from paper, Jane, or a spreadsheet.{" "}
            {IMPORTED_PROVENANCE_NOTE}
          </p>
          {/* UI-06 item 3. Each row was its own white card — a box at JSX depth
              4, inside a coloured callout, inside a card, inside a card. The
              nesting carried no information: the rows are a list of imported
              entries, and the callout already says so.

              Flattened to a DIVIDED list: one hairline between rows does the
              separating that four nested surfaces were doing, and the row's own
              typography (source label in stronger neutral, metadata muted)
              carries the grouping. Not one box swapped for another — the boxes
              are gone and spacing plus a divider replace them.

              `divide-line` is the semantic token, so the divider needs no
              hand-maintained dark: pair. */}
          <ul className="mt-2 flex flex-col divide-y divide-line">
            {importedMemory.items.map((m) => (
              <li key={m.id} className="py-2.5 first:pt-1">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs text-neutral-500">
                  <span className="font-medium text-neutral-700 dark:text-neutral-300">
                    {m.sourceLabel}
                  </span>
                  <span>· {m.dateLabel}</span>
                  {m.treatmentAreaText && (
                    <span className="font-medium text-neutral-700 dark:text-neutral-300">
                      · Imported area: {m.treatmentAreaText}
                    </span>
                  )}
                </div>
                {(m.modality ||
                  m.methodOrMachine ||
                  m.probeType ||
                  m.probeSize ||
                  m.probeLot ||
                  m.toleranceText ||
                  m.reactionText ||
                  m.aftercareMarked === true) && (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {m.modality && <Chip>{m.modality}</Chip>}
                    {m.methodOrMachine && <Chip>{m.methodOrMachine}</Chip>}
                    {m.probeType && <Chip>{m.probeType}</Chip>}
                    {m.probeSize && <Chip>{m.probeSize}</Chip>}
                    {m.probeLot && <Chip>Lot {m.probeLot}</Chip>}
                    {m.toleranceText && <Chip>Tolerance {m.toleranceText}</Chip>}
                    {m.reactionText && <Chip>{m.reactionText}</Chip>}
                    {m.aftercareMarked === true && <Chip>Aftercare marked</Chip>}
                  </div>
                )}
                {m.cautionNote && (
                  <p className="mt-1 whitespace-pre-wrap break-words text-sm text-neutral-700 dark:text-neutral-300">
                    <span className="font-medium">Caution:</span> {m.cautionNote}
                  </p>
                )}
                {m.nextVisitNote && (
                  <p className="mt-1 whitespace-pre-wrap break-words text-sm text-neutral-700 dark:text-neutral-300">
                    <span className="font-medium">For next visit:</span>{" "}
                    {m.nextVisitNote}
                  </p>
                )}
                {m.importedNote && (
                  <p className="mt-1 whitespace-pre-wrap break-words text-sm text-neutral-600 dark:text-neutral-400">
                    {m.importedNote}
                  </p>
                )}
              </li>
            ))}
          </ul>
          {importedMemory.totalFound > importedMemory.items.length && (
            <p className="mt-2 text-xs text-neutral-500">
              Showing the latest {importedMemory.items.length} of{" "}
              {importedMemory.totalFound} imported records.
            </p>
          )}
          <p className="mt-2 text-xs text-neutral-400">
            Review against the original record if needed.
          </p>
        </div>
      )}
    </section>
  );
}
