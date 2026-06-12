import { FormattedDateTime } from "@/components/formatted-date-time";
import type { BeforeToday } from "@/lib/sessions/before-today";

// PR #211: "Before today" pre-treatment briefing on the client
// Overview. A compact action briefing assembled from recorded history
// the page already loads; the blue treatment-memory styling matches
// the existing "From last visit, for today" surfaces. It summarizes,
// never duplicates, the Last treatment and Treatment Intelligence
// cards, and it never suggests settings or makes outcome claims.

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">
      {children}
    </h3>
  );
}

export function BeforeTodayCard({ briefing }: { briefing: BeforeToday }) {
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
            Use intake, consultation notes, and professional judgment.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {briefing.lastTreated && (
            <div>
              <SectionLabel>Last treated</SectionLabel>
              <p className="mt-0.5 text-sm">
                {briefing.lastTreated.areasLine ? (
                  <span className="font-medium">
                    {briefing.lastTreated.areasLine}
                  </span>
                ) : (
                  <span className="capitalize">
                    {briefing.lastTreated.modality} session
                  </span>
                )}{" "}
                ·{" "}
                <FormattedDateTime
                  iso={briefing.lastTreated.startedAt}
                  format="date"
                />
              </p>
            </div>
          )}

          <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2.5 text-sm dark:border-blue-900 dark:bg-blue-950/40">
            <h3 className="text-[11px] font-medium uppercase tracking-wider text-blue-800 dark:text-blue-300">
              Remember today
            </h3>
            <div className="mt-1 flex flex-col gap-0.5 text-blue-950 dark:text-blue-100">
              {briefing.remember.hasNotes ? (
                <>
                  {briefing.remember.watchLines.map((line) => (
                    <p key={line}>
                      <span className="font-medium">Watch:</span> {line}
                    </p>
                  ))}
                  {briefing.remember.plan && (
                    <p className="whitespace-pre-wrap">
                      <span className="font-medium">Plan:</span>{" "}
                      {briefing.remember.plan}
                    </p>
                  )}
                </>
              ) : (
                <p className="text-blue-900/70 dark:text-blue-200/70">
                  No watch or plan notes recorded from the last treatment.
                </p>
              )}
              {briefing.remember.latestReactionLabel && (
                <p className="text-xs">
                  Latest recorded reaction:{" "}
                  {briefing.remember.latestReactionLabel}
                </p>
              )}
              {briefing.remember.latestToleranceRating != null && (
                <p className="text-xs">
                  Latest tolerance: {briefing.remember.latestToleranceRating}/5
                </p>
              )}
            </div>
          </div>

          <div>
            <SectionLabel>Latest recorded setup</SectionLabel>
            <p className="mt-0.5 text-sm">
              {briefing.latestSetupLine ?? (
                <span className="text-neutral-400">Not recorded</span>
              )}
            </p>
          </div>

          <div>
            <SectionLabel>Record reminders</SectionLabel>
            {briefing.reminders.length === 0 ? (
              <p className="mt-0.5 text-sm text-neutral-600 dark:text-neutral-400">
                Procedure record looks complete based on recorded fields.
              </p>
            ) : (
              <ul className="mt-0.5 list-disc pl-5 text-sm text-neutral-700 dark:text-neutral-300">
                {briefing.reminders.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
