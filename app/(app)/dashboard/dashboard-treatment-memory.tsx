"use client";

import { useEffect, useId, useState, useTransition } from "react";
import { compactSummary } from "@/lib/dashboard/today-treatment-summary";
import { AppointmentPrepMemoryCard } from "@/components/appointment-prep-memory-card";
import type { DashboardTreatmentDisclosureSummary } from "@/lib/dashboard/dashboard-prep-summary";
import {
  loadAppointmentPrepMemory,
  type PrepMemoryResult,
} from "./prep-memory-actions";

// ===========================================================================
// The previous treatment, in place, on a Dashboard appointment row.
// ===========================================================================
//
// WHAT THIS IS. Progressive disclosure over the EXISTING #517 model. Compact by
// default so the roster stays calm; expanded it renders
// <AppointmentPrepMemoryCard>, unchanged, which is the same component the
// calendar appointment page uses.
//
// NOT Today-only. It renders for whichever day the briefing is showing, driven
// entirely by its OWN loader's result — never by the Before-Today history
// model, which does not run off Today and cannot express "we could not read
// it".
//
// WHAT IT DELIBERATELY DOES NOT RECEIVE. The full `AppointmentPrepMemory`.
// This component used to take it as a prop, which meant every treated area,
// machine setting, probe lot, tolerance rating, reaction note and narrative
// line for EVERY row of the day was serialised into the page payload before
// the practitioner opened anything. Collapsing content in the DOM changes what
// is rendered, not what is transported — and native <details> would not have
// helped, for the same reason.
//
// So it receives a compact projection of exactly what the collapsed row paints,
// plus the appointment id. On the first explicit click it asks the server,
// which re-resolves who she is, which studio she is in, and whether that
// appointment belongs to it, before returning anything clinical.
//
// WHY A BUTTON AND NOT <details>. Unchanged, and now doubly true: the open
// state drives a fetch, and <details>/<summary> swallows nested interactive
// content inconsistently across browsers. The repo's one disclosure idiom is a
// real button carrying aria-expanded + aria-controls next to the region it owns
// (components/signed-consent-viewer.tsx); this follows it so keyboard and
// screen-reader behaviour stays uniform.

export function DashboardTreatmentMemory({
  appointmentId,
  clientId,
  clientName,
  summary,
  timeZone,
}: {
  appointmentId: string;
  /** For the card's own links only. Never used as authorization. */
  clientId: string;
  clientName: string;
  /**
   * The disclosure projection: three fields, all of them painted here.
   *
   * Narrower than the row's own summary on purpose — it omits the plan note,
   * which the SERVER renders and only off Today. Passing the wider object sent
   * that note across the boundary on Today, where it is not visible at all.
   */
  summary: DashboardTreatmentDisclosureSummary;
  timeZone: string;
}) {
  // CHLOE (26 Nov): the last visit's details are ON the card by default, no click needed. The button is now only a
  // secondary "hide / show"; it starts open. The details are still read by the server on request, after it re-checks
  // the appointment belongs to this studio, and never travel in the page payload.
  const [open, setOpen] = useState(true);
  const [result, setResult] = useState<PrepMemoryResult | null>(null);
  const [pending, startTransition] = useTransition();
  const regionId = useId();
  const showable = !summary.unavailable && summary.hasTreatment;

  function load() {
    if (result !== null || pending) return;
    startTransition(async () => {
      // A rejected INVOCATION (dropped connection, deployment-id mismatch on a tab left open across a deploy) must fail
      // to this row's own line and never escape to the route error boundary, which would replace the whole Dashboard.
      // The thrown value is deliberately not read, rendered or logged.
      try {
        setResult(await loadAppointmentPrepMemory(appointmentId));
      } catch {
        setResult({ status: "unavailable" });
      }
    });
  }

  useEffect(() => {
    if (showable && open) load();
    // Load once per mount; closing and reopening reuses the result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Truthful ordering of the three genuinely different states. "We could not
  // read it" must never render as "this client has no treatment history": that
  // is the failure the charted-session authority exists to prevent, and it is
  // the one a practitioner cannot detect by looking.
  if (summary.unavailable) {
    return (
      <p
        data-testid="dashboard-memory-unavailable"
        className="text-xs text-neutral-500"
      >
        Previous treatment could not be loaded.
      </p>
    );
  }
  if (!summary.hasTreatment) return null;

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next) load();
  }

  return (
    <div
      data-prior-visible={open && result?.status === "loaded" ? "true" : undefined}
      className="mt-1 flex flex-col gap-1"
    >
      {/* The one-line "Last treatment" summary is painted on the CLOSED row by RowSafetyLines (HON-65), so
          it is not repeated here; this control only opens the full chart. */}
      <button
        type="button"
        onClick={toggle}
        aria-label={`Last visit details for ${clientName}`}
        aria-expanded={open}
        aria-controls={regionId}
        data-testid="dashboard-memory-toggle"
        /* 44px INTERACTIVE box, 11px type. The typography stays quiet — this
           is a secondary control and must not read as another primary button —
           but the hit area matches every other control on the row. It was the
           height of its own text, which this PR made worse by putting it on
           the future-day path, where preparing on a phone is the whole point. */
        className="inline-flex min-h-[44px] min-w-0 max-w-full items-center self-start py-2 text-left text-[11px] font-medium text-blue-700 underline underline-offset-2 [overflow-wrap:anywhere] hover:text-blue-900 dark:text-blue-300"
      >
        {open
          ? "Hide last visit details"
          : "Last visit details"}
      </button>

      {/* The region is always in the DOM as a labelled container so
          aria-controls resolves whether or not it is expanded; its CONTENT is
          mounted only when open, and only once the server has answered. */}
      <div id={regionId} hidden={!open} className="mt-1">
        {open && (
          <div
            data-testid="dashboard-memory-full"
            className="rounded-md border border-neutral-200 p-3 dark:border-neutral-800"
          >
            {result === null ? (
              <p
                data-testid="dashboard-memory-loading"
                className="text-xs text-neutral-500"
              >
                Loading previous treatment…
              </p>
            ) : result.status === "loaded" ? (
              /* showFullChartLink={false} is the Dashboard half of the
                 stay-inline contract. Expanding a row is a READ; the
                 disclosure must not contain a control that leaves the page. */
              <>
                <p className="mb-2 text-xs text-fg-muted">
                  <span className="font-medium">Last treatment</span>{" · "}
                  {compactSummary({ ...result.memory, areaHeadline: null, totalMinutes: null }, timeZone)}
                </p>
                <AppointmentPrepMemoryCard
                  clientId={clientId}
                  memory={result.memory}
                  embedded
                  showFullChartLink={false}
                />
              </>
            ) : result.status === "none" ? (
              <p className="text-xs text-neutral-500">
                No previous treatment to show.
              </p>
            ) : (
              <p
                data-testid="dashboard-memory-unavailable"
                className="text-xs text-neutral-500"
              >
                Previous treatment could not be loaded.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
