import Link from "next/link";
import { FormattedDateTime } from "@/components/formatted-date-time";
import { ClinicalDate } from "@/components/clinical-date";
import type { PointOfCareMemory } from "@/lib/sessions/point-of-care-memory";

// "Last treatment" — point-of-care treatment memory, rendered ON the live
// charting screen.
//
// Chloe's complaint: while she is treating, everything she needs to reproduce
// last time's setup — the frequency, the probe LOT, whether numbing was used,
// how many hairs came out, how the skin responded — lived on the client
// Overview tab or inside the previous session's own chart. Two or three
// navigations away from the screen where she is standing over the client.
//
// This card is READ-ONLY. It renders a view model the page already assembled
// (lib/sessions/point-of-care-memory.ts); it issues no query, owns no state and
// performs no mutation. Every label comes from the shared clinical vocabulary,
// so it reads identically to the saved-record display directly below it.
//
// LAYOUT CONTRACT
//   * The clinical headline — date, areas + laterality, response, tolerance,
//     total minutes, watch/plan — requires ZERO taps at every viewport.
//   * The setup detail is a <details open>: expanded by default on iPad and
//     desktop AND on a 390px phone, so nothing is hidden behind a tap; the
//     disclosure exists so she can collapse it once she has read it.
//   * Single column, mobile-first. Nothing scrolls horizontally: free text
//     wraps (break-words), chips wrap (flex-wrap), and there is no fixed-width
//     or overflow-x container anywhere in this file.

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-neutral-200 bg-neutral-50 px-2.5 py-0.5 text-xs text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300">
      {children}
    </span>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">
      {children}
    </h3>
  );
}

export function LastTreatmentMemoryCard({
  clientId,
  memory,
  // Deep link to the client's full, authenticated clinical-note history. The
  // card never renders a whole note body; it shows a short excerpt and points
  // here for the rest.
  notesHref,
}: {
  clientId: string;
  memory: PointOfCareMemory;
  notesHref: string;
}) {
  const hasWatchOrPlan = memory.watchLines.length > 0 || !!memory.plan;
  const responseAreas = memory.areas.filter(
    (a) => a.responseLine || a.toleranceLine || a.responseNote,
  );
  const hasNotes = !!memory.consultationNote || !!memory.skinHairNote;
  // A charted visit with no settings blocks (laser, or pre-block legacy).
  const hasBlockDetail = memory.areas.length > 0;

  return (
    <section
      data-testid="last-treatment-memory"
      className="flex flex-col gap-4 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800"
    >
      {/* ---- HEADLINE: zero taps ---- */}
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h2 className="text-sm font-medium uppercase tracking-wider text-neutral-500">
            Last treatment
          </h2>
          <Link
            href={`/clients/${clientId}/sessions/${memory.sessionId}`}
            className="text-xs font-medium text-neutral-700 hover:underline dark:text-neutral-300"
          >
            Open full chart →
          </Link>
        </div>
        <p className="text-sm text-neutral-700 dark:text-neutral-300">
          <FormattedDateTime iso={memory.startedAt} format="date" />
          <span className="capitalize"> · {memory.modality}</span>
          {memory.totalMinutes != null && ` · ${memory.totalMinutes} min`}
        </p>
        {/* A newer session exists but nothing was charted on it. Say so rather
            than implying this was the very last visit. */}
        {memory.supersededByEmptySession && (
          <p className="text-xs text-neutral-500">
            Most recent charted treatment. A newer session has no treatment
            details yet.
          </p>
        )}
      </header>

      {/* A prior visit can be genuinely charted and still carry no settings
          blocks — a LASER visit charts into laser_entries, and pre-0019 legacy
          electrolysis charted straight into entries. Saying "Area not
          recorded / Not recorded" there would be a false negative about a
          visit that really did happen, so the card says what it actually
          knows and points at the full chart instead. */}
      {!hasBlockDetail ? (
        <p
          data-testid="last-treatment-no-blocks"
          className="text-sm text-neutral-600 dark:text-neutral-400"
        >
          {/* ONE copy vocabulary, shared with the /sessions/new context panel
              (lib/sessions/point-of-care-memory.ts). Never "Area not recorded":
              a laser zone or a legacy entry area does exist, it simply is not
              in the block-shaped model this compact surface renders. */}
          {memory.blocklessNote ??
            "This previous visit has no charted treatment areas. Open the full chart to review what was recorded."}
        </p>
      ) : (
        <>
      {/* ---- AREAS TREATED, with laterality ---- */}
      <div>
        <SectionLabel>Areas treated</SectionLabel>
        <p
          data-testid="last-treatment-areas"
          className="mt-1 break-words text-sm font-medium text-neutral-900 dark:text-neutral-100"
        >
          {memory.areaHeadline ?? (
            <span className="font-normal text-neutral-400">
              Area not recorded
            </span>
          )}
        </p>
      </div>

      {/* ---- CLIENT RESPONSE + TOLERANCE ---- */}
      <div>
        <SectionLabel>Response &amp; tolerance</SectionLabel>
        {responseAreas.length > 0 ? (
          <ul className="mt-1 flex flex-col gap-1.5">
            {responseAreas.map((a) => (
              <li key={a.key} className="text-sm">
                <span className="font-medium text-neutral-900 dark:text-neutral-100">
                  {a.areaLabel}
                </span>
                <span className="text-neutral-700 dark:text-neutral-300">
                  {a.responseLine && ` — ${a.responseLine}`}
                  {a.toleranceLine && ` · Tolerance ${a.toleranceLine}`}
                </span>
                {/* Kept whole. The compact pre-treatment summary drops a
                    reaction note longer than 140 characters; at the point of
                    care it wraps instead. */}
                {a.responseNote && (
                  <span className="mt-0.5 block whitespace-pre-wrap break-words text-neutral-700 dark:text-neutral-300">
                    {a.responseNote}
                  </span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-sm text-neutral-400">Not recorded</p>
        )}
      </div>
        </>
      )}

      {/* ---- WATCH / PLAN. Blue is the established treatment-memory colour. ---- */}
      {hasWatchOrPlan && (
        <div className="rounded-md border border-blue-200 bg-blue-50 px-4 py-3 dark:border-blue-900 dark:bg-blue-950/40">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-blue-800 dark:text-blue-300">
            Watch today
          </h3>
          <div className="mt-1.5 flex flex-col gap-1 text-sm text-blue-950 dark:text-blue-100">
            {memory.watchLines.map((line) => (
              <p key={line} className="break-words">
                <span className="font-medium">Watch:</span> {line}
              </p>
            ))}
            {/* Omitted when the page is already showing this exact plan text
                above the card, so the same guidance never appears twice. */}
            {memory.plan && (
              <p className="whitespace-pre-wrap break-words">
                <span className="font-medium">Plan:</span> {memory.plan}
              </p>
            )}
          </div>
        </div>
      )}

      {/* ---- SETUP DETAIL: expanded by default, collapsible ---- */}
      {memory.areas.length > 0 && (
        <details open className="group">
          <summary className="flex min-h-[44px] cursor-pointer items-center justify-between text-[11px] font-medium uppercase tracking-wider text-neutral-500">
            Setup used
            <span className="text-[11px] font-normal normal-case tracking-normal text-neutral-400">
              <span className="group-open:hidden">Show</span>
              <span className="hidden group-open:inline">Hide</span>
            </span>
          </summary>
          <ul className="mt-2 flex flex-col gap-3">
            {memory.areas.map((a) => (
              <li
                key={a.key}
                data-testid="last-treatment-setup-area"
                className="rounded-md border border-neutral-200 px-3 py-2.5 dark:border-neutral-800"
              >
                <p className="break-words text-sm font-medium text-neutral-900 dark:text-neutral-100">
                  {a.areaLabel}
                  {a.passCount > 1 && (
                    <span className="ml-2 text-xs font-normal text-neutral-500">
                      {a.passCount} passes
                    </span>
                  )}
                </p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {a.frequency && <Chip>{a.frequency}</Chip>}
                  {a.probeLine && <Chip>{a.probeLine}</Chip>}
                  {a.modeLabel && <Chip>{a.modeLabel}</Chip>}
                  {a.modalityLabel && <Chip>{a.modalityLabel}</Chip>}
                  {/* Mode-gated: a thermolysis block never shows stale
                      galvanic readings left behind by an earlier mode. */}
                  {a.readings.map((r) => (
                    <Chip key={r.field}>{r.value}</Chip>
                  ))}
                  {a.minutes != null && <Chip>{a.minutes} min</Chip>}
                  {a.hairs != null && <Chip>{a.hairs} hairs</Chip>}
                  {a.numbing && <Chip>{a.numbing.label}</Chip>}
                </div>
                {a.numbing?.note && (
                  <p className="mt-1.5 whitespace-pre-wrap break-words text-sm text-neutral-700 dark:text-neutral-300">
                    {a.numbing.note}
                  </p>
                )}
                {!a.frequency &&
                  !a.probeLine &&
                  !a.modeLabel &&
                  a.readings.length === 0 &&
                  a.minutes == null && (
                    <p className="mt-1 text-sm text-neutral-400">
                      Setup not recorded
                    </p>
                  )}
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* ---- CONSULTATION / SKIN & HAIR CONTEXT ----
          A short excerpt only. The full dated record stays behind the
          authenticated client link; long bodies are never dumped here. */}
      <div className="border-t border-neutral-200 pt-3 dark:border-neutral-800">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <SectionLabel>Consultation &amp; skin/hair</SectionLabel>
          <Link
            href={notesHref}
            className="text-xs font-medium text-neutral-700 hover:underline dark:text-neutral-300"
          >
            Full notes →
          </Link>
        </div>
        {hasNotes ? (
          <dl className="mt-1.5 flex flex-col gap-2 text-sm">
            {memory.consultationNote && (
              <NoteRow label="Consultation" note={memory.consultationNote} />
            )}
            {memory.skinHairNote && (
              <NoteRow label="Skin & hair" note={memory.skinHairNote} />
            )}
          </dl>
        ) : (
          <p className="mt-1 text-sm text-neutral-400">
            No consultation or skin/hair analysis recorded.
          </p>
        )}
      </div>
    </section>
  );
}

function NoteRow({
  label,
  note,
}: {
  label: string;
  note: NonNullable<PointOfCareMemory["consultationNote"]>;
}) {
  return (
    <div>
      <dt className="text-xs text-neutral-500">
        {/* A clinical note's occurred_at is a CALENDAR DATE, not an instant.
            <FormattedDateTime> would convert it into the viewer's zone and show
            the previous day in every negative UTC offset. */}
        {label} · <ClinicalDate iso={note.occurredAt} />
        {note.total > 1 && ` · ${note.total} recorded`}
      </dt>
      <dd className="whitespace-pre-wrap break-words text-neutral-700 dark:text-neutral-300">
        {note.excerpt}
      </dd>
    </div>
  );
}
