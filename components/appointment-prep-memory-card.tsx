import Link from "next/link";
import { FormattedDateTime } from "@/components/formatted-date-time";
import {
  NO_LAST_SESSION_NOTES_COPY,
  type AppointmentPrepArea,
  type AppointmentPrepMemory,
  type AreaNarrativeItem,
  type NarrativeItem,
} from "@/lib/sessions/appointment-prep-memory";

// "Last treatment" for APPOINTMENT PREPARATION: the pre-visit read on the
// calendar appointment-detail screen.
//
// Chloe's complaint: before a client arrives she needs the whole picture: every
// treated area, the complete setup, what actually happened, and the notes she
// wrote last time, and the appointment page gave her a one-line date, a compact
// per-area strip, and a reaction note silently dropped above 140 characters.
// Everything else meant opening the prior chart, and some of it meant entering
// Edit.
//
// This card is READ-ONLY. It renders a view model the page already assembled
// (lib/sessions/appointment-prep-memory.ts); it issues no query, owns no state,
// performs no mutation, and decides nothing about which notes exist or how they
// group: that is the pure helper's job.
//
// LAYOUT CONTRACT
//   * Reading order follows the actual workflow: what/when → what to know →
//     what happened → what was used. The narrative sits high because it is what
//     she reads first, and the setup sits last inside a disclosure because it is
//     what she reaches for once the client is in the chair.
//   * Every clinical free-text value is rendered WHOLE: whitespace-pre-wrap so
//     paragraph breaks survive, break-words so a long unbroken string cannot
//     push the page sideways, and no line-clamp and no substring anywhere.
//   * A note appears exactly ONCE. The area cards below carry the same values on
//     the model but render structured outcomes only; the notes section is the
//     single render authority for text. Ten areas of narrative scattered across
//     ten cards is precisely what stops being readable at 390px.
//   * Single column, mobile-first. Nothing scrolls horizontally: free text
//     wraps, chips wrap (flex-wrap), and there is no fixed-width or overflow-x
//     container anywhere in this file.

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

// THE full-text renderer. Every narrative line on this card goes through it, so
// "no truncation" is one decision in one place rather than a class string
// repeated at nine call sites.
//
// `whitespace-pre-wrap` preserves the practitioner's own line and paragraph
// breaks; `break-words` is what keeps a pasted URL or an unspaced 200-character
// run from creating a horizontal scrollbar at 390px.
function NoteText({ children }: { children: string }) {
  return (
    <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-neutral-700 dark:text-neutral-300">
      {children}
    </p>
  );
}

function AreaNoteRow({ item }: { item: AreaNarrativeItem }) {
  return (
    <li data-testid="prep-note-item">
      <p className="text-xs text-neutral-500">
        <span className="font-medium text-neutral-700 dark:text-neutral-300">
          {item.areaLabel}
        </span>
        {" · "}
        {item.label}
      </p>
      <NoteText>{item.text}</NoteText>
    </li>
  );
}

function PlainNoteRow({ item }: { item: NarrativeItem }) {
  return (
    <li data-testid="prep-note-item">
      <p className="text-xs text-neutral-500">{item.label}</p>
      <NoteText>{item.text}</NoteText>
    </li>
  );
}

function NoteGroup({
  heading,
  children,
}: {
  heading: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="text-[11px] font-medium uppercase tracking-wider text-neutral-400">
        {heading}
      </p>
      <ul className="mt-1 flex flex-col gap-2">{children}</ul>
    </div>
  );
}

export function AppointmentPrepMemoryCard({
  clientId,
  memory,
  // EMBEDDED variant (Dashboard V2 Part 2A). The card is unchanged in content,
  // every field family still renders, but when it lives INSIDE another
  // section's disclosure it must not bring its own chrome or its own heading
  // rank with it:
  //
  //   * heading: "Last treatment" is an h2 on the appointment page, where it IS
  //     a top-level section. Inside a Today row it is a detail of that row, so
  //     it renders as an h4 under the row's h3. Heading LEVEL, not nesting,
  //     defines the accessibility outline.
  //   * chrome: the standalone card draws its own border and padding; nested in
  //     an already-bordered disclosure that doubles every edge on a phone.
  //
  // Deliberately NOT a second component: forking 400 lines of clinical
  // presentation is how two surfaces start disagreeing about what a treatment
  // looked like.
  embedded = false,
  // MAY THIS PRESENTATION NAVIGATE AWAY? An explicit capability, deliberately
  // NOT derived from `embedded`.
  //
  // `embedded` is a LAYOUT fact (heading rank + chrome). Whether a surface is
  // allowed to offer a link that leaves it is a PRODUCT fact, and the two are
  // not the same question: inferring one from the other is how a styling flag
  // quietly acquires navigation policy.
  //
  // On the appointment-preparation screen the full-chart link is the point:
  // she is already on a page about this appointment and wants the prior chart.
  // Inside the Dashboard Today disclosure it is a trap: she expanded a row to
  // READ something, and the only controls in reach must not throw her off the
  // worklist. The Dashboard therefore passes `false`; every other caller keeps
  // the link. Reaching the full chart from Today is still one tap: the row's
  // own resolved action button, outside the disclosure, does exactly that.
  showFullChartLink = true,
}: {
  clientId: string;
  memory: AppointmentPrepMemory;
  embedded?: boolean;
  showFullChartLink?: boolean;
}) {
  const fullChartHref = `/clients/${clientId}/sessions/${memory.sessionId}`;
  // A prior visit can be genuinely charted and still carry no settings blocks,
  // a LASER visit charts into laser_entries, and pre-0019 legacy electrolysis
  // charted straight into entries. Both are real treatments; neither fits the
  // block-shaped model, and saying "Area not recorded" about them would be a
  // false negative about a visit that plainly happened.
  const hasBlockDetail = memory.areas.length > 0;
  const { notes } = memory;

  return (
    <section
      data-testid="appointment-prep-memory"
      className={
        embedded
          ? "flex flex-col gap-4"
          : "flex flex-col gap-4 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800"
      }
    >
      {/* ---- HEADLINE: zero taps ---- */}
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          {embedded ? (
            <h4 className="text-sm font-medium uppercase tracking-wider text-neutral-500">
              Last treatment
            </h4>
          ) : (
            <h2 className="text-sm font-medium uppercase tracking-wider text-neutral-500">
              Last treatment
            </h2>
          )}
          {showFullChartLink && (
            <Link
              href={fullChartHref}
              data-testid="prep-full-chart-link"
              className="text-xs font-medium text-neutral-700 hover:underline dark:text-neutral-300"
            >
              Open full chart →
            </Link>
          )}
        </div>
        <p className="text-sm text-neutral-700 dark:text-neutral-300">
          {/* A session's started_at is a real instant, so it follows the
              viewer's zone, unlike a clinical note's occurred_at. */}
          <FormattedDateTime iso={memory.startedAt} format="date" />
          <span className="capitalize"> · {memory.modality}</span>
          {memory.totalMinutes != null && ` · ${memory.totalMinutes} min`}
          {memory.totalHairs != null && ` · ${memory.totalHairs} hairs`}
        </p>
        {/* A newer session row exists but nothing was charted on it. Say so
            rather than implying this was the very last visit. */}
        {memory.supersededByEmptySession && (
          <p
            data-testid="prep-superseded"
            className="text-xs text-neutral-500"
          >
            {/* The second sentence used to read "A newer session has no
                treatment details yet." That asserts a newer session is empty,
                which is inferred from that session missing from the block map —
                a bounded read. The qualifier below is the part that matters to
                her (do not read this as the very last visit) and it is licensed
                by the selection itself. */}
            Most recent charted treatment.
          </p>
        )}
      </header>

      {/* ---- AREAS TREATED, with laterality ---- */}
      {hasBlockDetail ? (
        <div>
          <SectionLabel>Areas treated</SectionLabel>
          <p
            data-testid="prep-areas"
            className="mt-1 break-words text-sm font-medium text-neutral-900 dark:text-neutral-100"
          >
            {/* Omission, not a denial. An area name is resolved from the
                block's structured area rows and falls back to its own
                `primary_area` column, so a null headline means every block we
                RECEIVED was unnamed — which is not the same as the visit having
                no recorded area, because the block set itself is bounded. The
                per-area cards below still speak for whatever did come back. */}
            {memory.areaHeadline}
          </p>
        </div>
      ) : (
        <div>
          <p
            data-testid="prep-no-blocks"
            className="text-sm text-neutral-600 dark:text-neutral-400"
          >
            {/* ONE copy vocabulary, shared with the charting card and the
                /sessions/new panel. Never "Setup not recorded": a laser zone or
                a legacy entry area does exist, it simply is not in the
                block-shaped model this surface renders. */}
            {/* NO `??`-ACQUIRES-COPY HERE.
                The old fallback read "This previous visit has no charted
                treatment areas." — a claim about a child collection, made at
                the render site, where the information needed to tell "none"
                from "not returned" is long out of scope. The block read is
                bounded, so a short result cannot license that sentence. This
                wording is about what THIS CARD is showing, which is true either
                way, and the link says where the rest of the record is. */}
            {memory.blocklessNote
              ?? "No treatment areas to show for this visit. Open the full chart to review what was recorded."}
          </p>
          {/* The SECOND full-chart affordance, and it obeys the same
              capability. The blockless COPY above is shared with the charting
              card and the /sessions/new panel (and is source-pinned there), so
              it is never rewritten per surface. It keeps saying that the full
              chart is where the rest lives. On a surface that may not navigate,
              that sentence is guidance and the row's own action button is the
              control; leaving the link here would reintroduce exactly the
              off-Dashboard jump the capability exists to prevent. */}
          {showFullChartLink && (
            <p className="mt-2 text-xs">
              <Link
                href={fullChartHref}
                className="font-medium text-neutral-700 underline hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-neutral-100"
              >
                Open full chart →
              </Link>
            </p>
          )}
        </div>
      )}

      {/* ---- LAST SESSION NOTES: the whole practitioner narrative, in one
              place, at full length. Rendered for a blockless visit too: a
              laser or legacy visit still has notes, and hiding them behind the
              fallback copy is exactly the dead end this replaces. ---- */}
      <div
        data-testid="prep-notes"
        className="border-t border-neutral-200 pt-3 dark:border-neutral-800"
      >
        <SectionLabel>Last session notes</SectionLabel>
        {notes.hasAny ? (
          <div className="mt-1.5 flex flex-col gap-3">
            {notes.forNextVisit && (
              /* Blue is the established treatment-memory colour. The plan and
                 the cautions are what change what she does today, so they lead. */
              <div className="rounded-md border border-blue-200 bg-blue-50 px-4 py-3 dark:border-blue-900 dark:bg-blue-950/40">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-blue-800 dark:text-blue-300">
                  {notes.forNextVisit.label}
                </p>
                <p
                  data-testid="prep-note-item"
                  className="mt-0.5 whitespace-pre-wrap break-words text-sm text-blue-950 dark:text-blue-100"
                >
                  {notes.forNextVisit.text}
                </p>
              </div>
            )}
            {notes.cautions.length > 0 && (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-900 dark:bg-amber-950/40">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-amber-800 dark:text-amber-300">
                  Watch today
                </p>
                <ul className="mt-1 flex flex-col gap-2">
                  {notes.cautions.map((item) => (
                    <li key={item.key} data-testid="prep-note-item">
                      <p className="text-xs font-medium text-amber-900 dark:text-amber-200">
                        {item.areaLabel}
                      </p>
                      <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-amber-950 dark:text-amber-100">
                        {item.text}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {notes.general.length > 0 && (
              <NoteGroup heading="General notes">
                {notes.general.map((item) => (
                  <PlainNoteRow key={item.key} item={item} />
                ))}
              </NoteGroup>
            )}
            {notes.responses.length > 0 && (
              <NoteGroup heading="Response notes">
                {notes.responses.map((item) => (
                  <AreaNoteRow key={item.key} item={item} />
                ))}
              </NoteGroup>
            )}
            {notes.additional.length > 0 && (
              <NoteGroup heading="Notes by area">
                {notes.additional.map((item) => (
                  <AreaNoteRow key={item.key} item={item} />
                ))}
              </NoteGroup>
            )}
          </div>
        ) : (
          /* NEVER suppressed. An absent section is indistinguishable from a
             failed query, and "did the notes not load?" is the exact doubt this
             card exists to remove. */
          <p
            data-testid="prep-notes-empty"
            className="mt-1 text-sm text-neutral-400"
          >
            {NO_LAST_SESSION_NOTES_COPY}
          </p>
        )}
      </div>

      {/* ---- WHAT HAPPENED: outcomes, per area, structured. Distinct from the
              setup below. This is the result, not the recipe. ---- */}
      {hasBlockDetail && (
        <div className="border-t border-neutral-200 pt-3 dark:border-neutral-800">
          <SectionLabel>What happened</SectionLabel>
          <ul className="mt-1.5 flex flex-col gap-2">
            {memory.areas.map((area) => (
              <li
                key={area.key}
                data-testid="prep-outcome-area"
                className="text-sm"
              >
                <AreaHeading area={area} />
                {area.outcome.responseLine || area.outcome.toleranceLine ? (
                  <p className="text-neutral-700 dark:text-neutral-300">
                    {area.outcome.responseLine}
                    {area.outcome.responseLine
                      && area.outcome.toleranceLine
                      && " · "}
                    {area.outcome.toleranceLine
                      && `Tolerance ${area.outcome.toleranceLine}`}
                  </p>
                ) : null}
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {/* Absent values are ABSENT. A missing minute count is never
                      rendered as 0, and a missing response is never rendered as
                      "no reaction". */}
                  {area.outcome.minutes != null && (
                    <Chip>{area.outcome.minutes} min</Chip>
                  )}
                  {area.outcome.hairs != null && (
                    <Chip>{area.outcome.hairs} hairs</Chip>
                  )}
                  {area.passCount > 1 && <Chip>{area.passCount} passes</Chip>}
                  {area.outcome.numbing && (
                    <Chip>{area.outcome.numbing.label}</Chip>
                  )}
                  {area.outcome.cautionFlag && <Chip>Flagged to watch</Chip>}
                </div>
                {!area.outcomeRecorded && (
                  <p className="mt-1 text-sm text-neutral-400">Not recorded</p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ---- SETUP USED: expanded by default, collapsible. Native <details>,
              so there is no client state on this card. ---- */}
      {hasBlockDetail && (
        <details open className="group border-t border-neutral-200 pt-3 dark:border-neutral-800">
          <summary className="flex min-h-[44px] cursor-pointer items-center justify-between text-[11px] font-medium uppercase tracking-wider text-neutral-500">
            Setup used
            <span className="text-[11px] font-normal normal-case tracking-normal text-neutral-400">
              <span className="group-open:hidden">Show</span>
              <span className="hidden group-open:inline">Hide</span>
            </span>
          </summary>
          <ul className="mt-2 flex flex-col gap-3">
            {memory.areas.map((area) => (
              <li
                key={area.key}
                data-testid="prep-setup-area"
                className="rounded-md border border-neutral-200 px-3 py-2.5 dark:border-neutral-800"
              >
                <AreaHeading area={area} />
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {area.setup.frequency && <Chip>{area.setup.frequency}</Chip>}
                  {area.setup.probeLine && <Chip>{area.setup.probeLine}</Chip>}
                  {area.setup.modeLabel && <Chip>{area.setup.modeLabel}</Chip>}
                  {area.setup.modalityLabel && (
                    <Chip>{area.setup.modalityLabel}</Chip>
                  )}
                  {/* Mode-gated: a thermolysis block never shows stale galvanic
                      readings left behind by an earlier mode, and the retired
                      galvanic intensity is never read at all. */}
                  {area.setup.readings.map((r) => (
                    <Chip key={r.field}>{r.value}</Chip>
                  ))}
                </div>
                {/* The readings above are the FIRST pass's. When a later pass
                    recorded different ones, say so rather than letting her prep
                    to a value the session moved away from. */}
                {area.settingsChangedDuringSession && (
                  <p
                    data-testid="prep-settings-changed"
                    className="mt-1.5 text-xs text-amber-700 dark:text-amber-400"
                  >
                    Settings changed during the session. These are the first
                    pass. Open the full chart for every pass.
                  </p>
                )}
                {!area.setupRecorded && (
                  <p className="mt-1 text-sm text-neutral-400">
                    Setup not recorded
                  </p>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

// Every treated area of the block, each named in full. A block treating Left
// Cheek and Right Sideburn shows BOTH, never just the first, and never a bare
// primary_area. areaLabel is the shared joined form ("Left Cheek · Right
// Sideburn"); areaParts carries the same areas individually for the model and
// its tests.
function AreaHeading({ area }: { area: AppointmentPrepArea }) {
  return (
    <p
      data-testid="prep-area-label"
      className="break-words text-sm font-medium text-neutral-900 dark:text-neutral-100"
    >
      {area.areaLabel}
    </p>
  );
}
