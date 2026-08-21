import type { PreVisitPrep } from "@/lib/dashboard/prep/pre-visit-prep";
import { hasRenderablePrep } from "@/lib/dashboard/prep/pre-visit-prep";

// THE preparation block on a Dashboard row. ONE renderer, both days.
//
// WHY IT IS ONE COMPONENT
// -----------------------
// Today and a selected day used to render preparation through two different
// code paths from two different loaders, and they disagreed. The clearest
// symptom: the "Remember" note came from a query with NO time bound on Today and
// from an appointment-bounded query on every other day, so the SAME appointment
// could show DIFFERENT text the day before versus on the day. Off Today most of
// the block was not rendered at all.
//
// So there is one component, fed by one appointment-bounded model, and the only
// thing that varies between days is the section label.
//
// WHAT IT MAY PAINT
// -----------------
// Facts, and observed failures. Nothing else.
//
// Every field of `PreVisitPrep` is optional and absence renders NOTHING. There
// is deliberately no `??` fallback anywhere below: a null arriving from a read
// must not acquire copy at the render site, because by the time it reaches JSX
// the information needed to tell "none" from "not read" is long out of scope.
// That single pattern — `{workflow.setup ?? "Not recorded"}` — is what put a
// confident "Latest setup: Not recorded" over a recorded setup whenever the
// block read was short or failed.
//
// Server component. No client state, no effects, no I/O.

export const PREP_LABEL_TODAY = "Before today";
export const PREP_LABEL_OTHER_DAY = "Before this visit";

export function PreVisitPrepBlock({
  prep,
  viewingToday,
}: {
  prep: PreVisitPrep;
  // Chooses the temporal wording ONLY. It must never change which facts render:
  // the same evidence produces the same prep on both days.
  viewingToday: boolean;
}) {
  // Nothing observed and nothing failed: say nothing at all. This is the
  // QUIET OMISSION that replaced "New client · No charted history yet", a
  // relationship claim assembled from two capped collections.
  if (!hasRenderablePrep(prep)) return null;

  return (
    <div className="mt-1.5 flex flex-col gap-0.5 text-xs">
      <span
        data-testid="dashboard-prep-label"
        className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400"
      >
        {viewingToday ? PREP_LABEL_TODAY : PREP_LABEL_OTHER_DAY}
      </span>

      {/* REMEMBER — the plan note (sessions.next_session_note), verbatim.
          Resolved before and independently of the block read, so it survives a
          visit that was never charted and a block read that failed. */}
      {prep.remember && (
        <span
          data-testid="dashboard-prep-remember"
          className="whitespace-pre-wrap break-words text-blue-900 dark:text-blue-200"
          title={prep.remember.text}
        >
          Remember: {prep.remember.text}
        </span>
      )}

      {/* CAUTION — the watch line, kept visually distinct in the established
          rose convention and never folded into Remember. Folding them is what
          once printed the same caution twice under two labels. */}
      {prep.caution && (
        <span
          data-testid="dashboard-prep-caution"
          className="whitespace-pre-wrap break-words text-rose-900 dark:text-rose-200"
          title={prep.caution.text}
        >
          Caution: {prep.caution.text}
        </span>
      )}

      {/* LATEST SETUP — rendered ONLY when a concrete setup was observed. When
          it was not, this line is absent; it is never "Not recorded". */}
      {prep.latestSetup && (
        <span
          data-testid="dashboard-prep-setup"
          className="whitespace-pre-wrap break-words text-neutral-600 dark:text-neutral-400"
        >
          Latest setup: {prep.latestSetup.line}
        </span>
      )}

      {/* MISSING-RECORD CHIPS — each licensed by its own witness: an
          authoritative row that was returned, and a scalar column on that row
          observed null. A chip can never come from a collection's size. */}
      {prep.directRecordReminders.length > 0 && (
        <span className="mt-0.5 flex flex-wrap gap-1">
          {prep.directRecordReminders.map((r) => (
            <span
              key={r.sourceField}
              data-testid="missing-record-chip"
              className="inline-flex items-center rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
            >
              {r.text}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}
