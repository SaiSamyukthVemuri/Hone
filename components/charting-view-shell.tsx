"use client";

/**
 * The Current view / New view switch for the session charting page.
 *
 * ONE MOUNTED TREE. Both views render the same page content in the same place; the switch only changes a
 * `data-charting-view` attribute, the layout classes around the content, and whether the "This visit" summary is
 * shown beside it. Nothing the practitioner is editing is unmounted by a switch, so unsaved values (the draft, the
 * machine panel's settings, the machine pick, the probe lot and its provenance) stay exactly where they are.
 * A test pins that the content node is the very same DOM node before and after a switch.
 *
 * The switch is a button outside every form: it submits nothing and calls no charting, appointment, message or
 * payment action. The only thing it asks the server for is to remember the choice (components/use-charting-view-
 * preference.ts), and a failure there only shows a notice.
 */
import { useContext, type ReactNode } from "react";
import { setChartingViewAction } from "@/app/(app)/charting-view-actions";
import { useChartingViewPreference } from "@/components/use-charting-view-preference";
import { ChartingViewContext } from "@/components/charting-view-context";
import type { ChartingView } from "@/lib/charting/view-preference";

export function ChartingViewShell({
  initialView,
  rolloutOn = false,
  summary,
  children,
}: {
  initialView: ChartingView;
  /** The server's rollout decision for this studio, passed down as a plain boolean (display and form behaviour only; the server re-checks every write). */
  rolloutOn?: boolean;
  /** Server-rendered "This visit" card, shown only in New view. Display only. */
  summary: ReactNode;
  children: ReactNode;
}) {
  const state = useChartingViewPreference(initialView, setChartingViewAction);
  const isNew = state.view === "new";
  return (
    <ChartingViewContext.Provider value={{ ...state, rolloutOn }}>
      <div
        data-testid="charting-view-root"
        data-charting-view={state.view}
        className={isNew ? "lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start lg:gap-8" : undefined}
      >
        {/* Always the first child, in every view: its position never changes, so it is never remounted. */}
        <div data-testid="charting-view-content" className="min-w-0">
          {children}
        </div>
        {isNew ? (
          <aside
            data-testid="charting-view-summary"
            aria-label="This visit"
            className="mt-8 lg:sticky lg:top-4 lg:mt-0"
          >
            {summary}
          </aside>
        ) : null}
      </div>
    </ChartingViewContext.Provider>
  );
}

/** Rendered beside the session title. Only rendered when the switch is available (the page decides). */
export function ChartingViewToggle() {
  const ctx = useContext(ChartingViewContext);
  if (ctx === null) return null;
  const on = ctx.view === "new";
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        data-testid="charting-view-toggle"
        title={on ? "Switch back to the current view" : "Try the new charting layout"}
        onClick={() => ctx.setView(on ? "current" : "new")}
        className="inline-flex min-h-[44px] items-center gap-2 rounded-full border border-neutral-300 px-3 text-sm font-medium text-neutral-800 hover:bg-neutral-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900 dark:border-neutral-700 dark:text-neutral-100 dark:hover:bg-neutral-800 dark:focus-visible:outline-neutral-100"
      >
        <span
          aria-hidden="true"
          className={`relative inline-block h-5 w-9 rounded-full transition-colors ${on ? "bg-neutral-900 dark:bg-neutral-100" : "bg-neutral-300 dark:bg-neutral-600"}`}
        >
          <span
            className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all dark:bg-neutral-900 ${on ? "left-[1.1rem]" : "left-0.5"}`}
          />
        </span>
        New view
      </button>
      {ctx.notice ? (
        <p role="status" data-testid="charting-view-notice" className="text-xs text-neutral-600 dark:text-neutral-400">
          {ctx.notice}
        </p>
      ) : null}
    </div>
  );
}

/** "This visit": a read-only summary of values the page already has. It reads and writes nothing. */
export function ChartingVisitSummary({
  clientName,
  kind,
  areas,
  count,
  nextVisitNoteRecorded,
}: {
  clientName: string;
  kind: "electrolysis" | "laser";
  areas: string[];
  count: number;
  nextVisitNoteRecorded: boolean;
}) {
  const laser = kind === "laser";
  return (
    <section className="rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
      <h2 className="text-base font-semibold">This visit</h2>
      <dl className="mt-3 flex flex-col gap-2">
        <div>
          <dt className="text-xs uppercase tracking-wide text-neutral-500">Client</dt>
          <dd>{clientName}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-neutral-500">{laser ? "Zones treated" : "Areas treated"}</dt>
          <dd>{areas.length > 0 ? areas.join(", ") : "None saved yet"}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-neutral-500">{laser ? "Passes saved" : "Settings blocks saved"}</dt>
          <dd>{count}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-neutral-500">Next-visit note</dt>
          <dd>{nextVisitNoteRecorded ? "Recorded" : "Not recorded"}</dd>
        </div>
      </dl>
    </section>
  );
}
