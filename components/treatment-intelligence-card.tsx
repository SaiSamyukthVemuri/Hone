import { ClinicalUnavailableNotice } from "@/components/clinical-unavailable-notice";
import { FormattedDateTime } from "@/components/formatted-date-time";
import type {
  AreaIntelligence,
  TreatmentIntelligence,
} from "@/lib/sessions/treatment-intelligence";

// PR #210: Client Treatment Intelligence Summary, rendered on the
// client profile Overview tab. Strictly recorded-history language:
// "historically", "commonly recorded", "latest recorded", "watch
// note". No superlatives, no causal or outcome claims, no advice
// wording. Missing values render "Not recorded"; nothing is invented.

function NotRecorded() {
  return <span className="text-neutral-400">Not recorded</span>;
}

function Stat({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col">
      <span className="text-[11px] uppercase tracking-wider text-neutral-500">
        {label}
      </span>
      <span className="text-sm font-medium tabular-nums">{children}</span>
    </div>
  );
}

function num(n: number): string {
  return n.toLocaleString("en-CA");
}

function AreaCard({ area }: { area: AreaIntelligence }) {
  const statsLine = [
    `${area.sessions} ${area.sessions === 1 ? "session" : "sessions"}`,
    area.minutes != null ? `${num(area.minutes)} min` : null,
    area.hairs != null ? `${num(area.hairs)} hairs` : null,
    area.hairsPerMinute != null ? `${area.hairsPerMinute} hairs/min` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const setupLine = [
    area.latestFrequency,
    area.latestProbe,
    area.latestModeLabel,
    area.latestEnergyLevel != null ? `EL ${area.latestEnergyLevel}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <li className="flex flex-col gap-0.5 py-2.5 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-medium">{area.name}</span>
        <span className="text-xs text-neutral-500">
          First <FormattedDateTime iso={area.firstTreated} format="date" /> · Last{" "}
          <FormattedDateTime iso={area.lastTreated} format="date" />
        </span>
      </div>
      <p className="text-neutral-700 dark:text-neutral-300">{statsLine}</p>
      <p className="text-xs text-neutral-600 dark:text-neutral-400">
        Latest recorded setup: {setupLine || <NotRecorded />}
      </p>
      <p className="text-xs text-neutral-600 dark:text-neutral-400">
        Commonly recorded reaction:{" "}
        {area.commonReactionLabel ?? <NotRecorded />}
      </p>
      {area.latestWatchNote && (
        <p className="text-xs text-blue-900 dark:text-blue-200">
          Watch note: {area.latestWatchNote}
        </p>
      )}
    </li>
  );
}

export function TreatmentIntelligenceCard({
  intelligence,
  unavailable,
}: {
  intelligence: TreatmentIntelligence;
  // CLIN-01-B. TRUE only when the session_blocks read behind this card FAILED.
  // The page builds a `blocks: []` intelligence value BEFORE that read, and
  // `blocks: []` is byte-identical to what a client with no charted history
  // yields: every stat renders as a known zero and `charted` renders "No
  // charted treatment history yet.". Checked before `intelligence.charted` for
  // that reason. An unavailable read must never be converted back into a
  // known-empty clinical result.
  unavailable: boolean;
}) {
  const o = intelligence.overall;
  return (
    <section className="flex flex-col gap-4 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
      <header>
        <h2 className="text-sm font-medium uppercase tracking-wider text-neutral-500">
          Treatment Intelligence
        </h2>
        <p className="mt-1 text-xs text-neutral-500">
          Based on recorded treatment areas and session history. Use
          professional judgment. This summary reflects recorded history only.
        </p>
      </header>

      {unavailable ? (
        <ClinicalUnavailableNotice testId="treatment-intelligence-unavailable" />
      ) : !intelligence.charted ? (
        <p className="rounded-md border border-dashed border-neutral-300 px-4 py-6 text-sm text-neutral-500 dark:border-neutral-700">
          No charted treatment history yet.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
            <Stat label="Charted sessions">{o.chartedSessions}</Stat>
            <Stat label="Treatment areas charted">{o.areasCharted}</Stat>
            <Stat label="Minutes">
              {o.minutes != null ? num(o.minutes) : <NotRecorded />}
            </Stat>
            <Stat label="Hairs">
              {o.hairs != null ? num(o.hairs) : <NotRecorded />}
            </Stat>
            <Stat label="Hairs/min">
              {o.hairsPerMinute != null ? o.hairsPerMinute : <NotRecorded />}
            </Stat>
            <Stat label="First treated">
              {o.firstTreated ? (
                <FormattedDateTime iso={o.firstTreated} format="date" />
              ) : (
                <NotRecorded />
              )}
            </Stat>
            <Stat label="Last treated">
              {o.lastTreated ? (
                <FormattedDateTime iso={o.lastTreated} format="date" />
              ) : (
                <NotRecorded />
              )}
            </Stat>
            <Stat label="Latest tolerance">
              {intelligence.latestToleranceRating != null ? (
                `${intelligence.latestToleranceRating}/5`
              ) : (
                <NotRecorded />
              )}
            </Stat>
          </div>

          <div className="flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-400">
            <p>
              Commonly recorded reaction:{" "}
              {intelligence.commonReactionLabel ?? <NotRecorded />}
            </p>
            <p>
              Latest recorded reaction:{" "}
              {intelligence.latestReactionLabel ?? <NotRecorded />}
            </p>
          </div>

          {intelligence.areas.length > 0 && (
            <div>
              <h3 className="text-xs font-medium uppercase tracking-wider text-neutral-500">
                Areas
              </h3>
              <ul className="mt-1 flex flex-col divide-y divide-neutral-200 dark:divide-neutral-800">
                {intelligence.areas.map((a) => (
                  <AreaCard key={a.name.toLowerCase()} area={a} />
                ))}
              </ul>
            </div>
          )}

          {(intelligence.latestWatchNote || intelligence.latestPlan) && (
            <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2.5 text-xs dark:border-blue-900 dark:bg-blue-950/40">
              <h3 className="font-medium uppercase tracking-wider text-blue-800 dark:text-blue-300">
                Notes to remember
              </h3>
              <div className="mt-1 flex flex-col gap-0.5 text-blue-950 dark:text-blue-100">
                {intelligence.latestWatchNote && (
                  <p>Watch note: {intelligence.latestWatchNote}</p>
                )}
                {intelligence.latestPlan && (
                  <p>Plan for next visit: {intelligence.latestPlan}</p>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
