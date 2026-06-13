import { FormattedDateTime } from "@/components/formatted-date-time";
import type { BeforeToday } from "@/lib/sessions/before-today";

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

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">
      {children}
    </h3>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-neutral-200 bg-neutral-50 px-2.5 py-0.5 text-xs text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300">
      {children}
    </span>
  );
}

export function BeforeTodayCard({ briefing }: { briefing: BeforeToday }) {
  const last = briefing.lastTreated;
  const setup = briefing.setup;
  const response = briefing.response;

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
      <header>
        <h2 className="text-sm font-medium uppercase tracking-wider text-neutral-500">
          Before today
        </h2>
        <p className="mt-1 text-xs text-neutral-500">
          Key reminders from recorded history before starting this client. Use
          professional judgment. This reflects recorded history only.
        </p>
      </header>

      {!briefing.hasHistory ? (
        <div className="rounded-md border border-dashed border-neutral-300 px-4 py-5 text-sm text-neutral-500 dark:border-neutral-700">
          <p>No charted treatment history yet.</p>
          <p className="mt-1 text-xs">
            Treatment memory will appear here after the first charted session.
            Use intake, consultation notes, and professional judgment.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {/* 1. Remember today: first and dominant. */}
          <div className="rounded-md border border-blue-200 bg-blue-50 px-4 py-3 dark:border-blue-900 dark:bg-blue-950/40">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-blue-800 dark:text-blue-300">
              Remember today
            </h3>
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
              <SectionLabel>Last treatment</SectionLabel>
              <p className="mt-1 text-sm">
                {last.areasLine ? (
                  <span className="break-words font-medium">
                    {last.areasLine}
                  </span>
                ) : (
                  <span className="capitalize">{last.modality} session</span>
                )}{" "}
                · <FormattedDateTime iso={last.startedAt} format="date" />
              </p>
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
            <SectionLabel>Client response (last recorded)</SectionLabel>
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
            <SectionLabel>Record reminders</SectionLabel>
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
    </section>
  );
}
