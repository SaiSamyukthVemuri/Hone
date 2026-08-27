import Link from "next/link";
import { FormattedDateTime } from "@/components/formatted-date-time";
import {
  AreaSummaries,
  FromLastVisitForToday,
  hasFromLastVisitContent,
} from "@/components/last-session-summary";
import { ClinicalUnavailableNotice } from "@/components/clinical-unavailable-notice";
import type { LastSessionSummary } from "@/lib/sessions/clinical-summary";

// "Last visit / what we did last time", a scannable, retrospective
// recap at the TOP of the client Overview tab (Chloe: "on the client
// overview I want to clearly see what we did last time").
//
// This is a PRESENTATION surface only. Every value comes from the
// SINGLE last completed session, already loaded + summarized on the
// client page:
//   * header (date/modality/performer/duration/aftercare) from the
//     last-treatment session row + its blocks,
//   * areas + settings/probe/tolerance/response from the SAME
//     buildLastSessionSummary() output the charting + Sessions-tab
//     surfaces render (via <AreaSummaries>), and
//   * watch/next-visit note via the SAME <FromLastVisitForToday> band.
//
// It reuses those helpers rather than re-deriving anything, so there is
// no second/parallel summary function and no duplicated clinical logic.
//
// ACCURACY: the `summary` passed in MUST be the strictly-last-session
// summary (built from the last treatment's own blocks + next-session
// note), never a cross-history rollup (e.g. Treatment Intelligence
// "latest-across-history" fields, or the "newest session that has a
// watch/plan" pre-client source). "What we did last time" means that
// one visit.
//
// Overview stays clinical-first: this card intentionally does NOT show
// session price (that stays on the Sessions-tab "Last treatment" card).
// The forward-looking BeforeToday prep card is unchanged and separate:
// BeforeToday = "remember today / for next visit"; this = "last visit".

type LastVisitCardProps = {
  clientId: string;
  // Null when the client has no charted session yet -> empty state.
  sessionId: string | null;
  startedAt: string | null;
  modality: string | null;
  performerName: string | null;
  // 0085 aftercare-explained stamp on the last session (already loaded).
  aftercareExplainedAt: string | null;
  // Sum of the last session's block minutes (derived from already-loaded
  // blocks; not a new query).
  totalMinutes: number | null;
  // False when a newer, still-uncharted session exists (say so quietly
  // rather than blanking the card).
  isLatestSession: boolean;
  // The strictly-last-session summary (buildLastSessionSummary output).
  summary: LastSessionSummary | null;
  // CLIN-01-B. TRUE only when the profile's session_blocks read FAILED, so
  // nothing below is known: not the areas, not the watch note, and not whether
  // a treatment exists at all. Checked BEFORE `sessionId`, because a failed
  // read leaves `sessionId` null for exactly the clients whose history is
  // longest. "No recorded visits yet." is a clinical claim, reserved for a read
  // that SUCCEEDED and found nothing.
  unavailable: boolean;
};

export function LastVisitCard({
  clientId,
  sessionId,
  startedAt,
  modality,
  performerName,
  aftercareExplainedAt,
  totalMinutes,
  isLatestSession,
  summary,
  unavailable,
}: LastVisitCardProps) {
  return (
    <section className="flex flex-col gap-2">
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-600 dark:text-neutral-300">
          Last visit
        </h2>
        <p className="text-xs text-neutral-400 dark:text-neutral-500">
          What we did last time
        </p>
      </div>
      {/* CLIN-01-B: unavailable first. A partial card is not an option here
          either: the watch/next-visit band comes from the same failed read, so
          a header with the band silently missing reads as "nothing to watch
          for". */}
      {unavailable ? (
        <ClinicalUnavailableNotice testId="last-visit-unavailable" />
      ) : sessionId && startedAt ? (
        <div className="rounded-lg border border-neutral-200 dark:border-neutral-800">
          <div className="p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <div>
                <div className="text-sm font-medium">
                  <FormattedDateTime iso={startedAt} />
                </div>
                <div className="text-xs text-neutral-500">
                  {modality}
                  {performerName && ` · ${performerName}`}
                  {totalMinutes != null &&
                    totalMinutes > 0 &&
                    ` · ${totalMinutes} min`}
                </div>
                {/* A newer uncharted session exists; say so quietly
                    instead of implying this is the very latest visit. */}
                {!isLatestSession && (
                  <p className="mt-1 text-xs text-neutral-500">
                    Most recent charted treatment. A newer session has no
                    treatment details yet.
                  </p>
                )}
              </div>
              <Link
                href={`/clients/${clientId}/sessions/${sessionId}`}
                className="inline-flex items-center min-h-[44px] min-w-[44px] text-xs font-medium text-neutral-700 hover:underline dark:text-neutral-300"
              >
                Open session →
              </Link>
            </div>

            {/* Aftercare status: clinical, already loaded (0085 stamp).
                Read-only signal; never a re-send or a write. */}
            <div className="mt-3">
              {aftercareExplainedAt ? (
                <span className="inline-flex items-center rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
                  Aftercare explained
                </span>
              ) : (
                <span className="inline-flex items-center rounded-full bg-neutral-100 px-2.5 py-0.5 text-xs font-medium text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                  Aftercare not marked
                </span>
              )}
            </div>

            {/* Areas treated: the SAME single-last-session summary the
                charting + Sessions-tab surfaces render. Reused, never
                recomputed. Legacy/laser sessions without treatment areas
                fall back to a quiet pointer; the full per-entry detail
                lives behind "Open session". */}
            {summary && summary.areas.length > 0 ? (
              <div className="mt-3">
                <AreaSummaries summary={summary} />
              </div>
            ) : (
              <p className="mt-3 text-sm text-neutral-500">
                Open the session for full treatment details.
              </p>
            )}
          </div>

          {/* Watch / next-visit note from the SINGLE last session
              (strictly last-session, not a cross-history rollup).
              Flush footer band; omitted cleanly when there is nothing
              to say. */}
          {summary && hasFromLastVisitContent(summary) && (
            <FromLastVisitForToday summary={summary} attached />
          )}
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-neutral-300 bg-neutral-50 px-5 py-8 text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900">
          No recorded visits yet.
        </div>
      )}
    </section>
  );
}
