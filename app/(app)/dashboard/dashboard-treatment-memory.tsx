"use client";

import { useId, useState, useTransition } from "react";
import { AppointmentPrepMemoryCard } from "@/components/appointment-prep-memory-card";
import type { DashboardPrepSummary } from "@/lib/dashboard/dashboard-prep-summary";
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
}: {
  appointmentId: string;
  /** For the card's own links only. Never used as authorization. */
  clientId: string;
  clientName: string;
  /** The visible compact projection. Never the full model. */
  summary: DashboardPrepSummary;
}) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<PrepMemoryResult | null>(null);
  const [pending, startTransition] = useTransition();
  const regionId = useId();

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

  // NO PREFETCH. Not on hover, not on mount, not on intersection — only here,
  // after a deliberate activation. Once fetched, the result is kept for the
  // life of the row so closing and reopening costs nothing.
  function toggle() {
    const next = !open;
    setOpen(next);
    if (!next || result !== null || pending) return;
    startTransition(async () => {
      setResult(await loadAppointmentPrepMemory(appointmentId));
    });
  }

  return (
    <div className="mt-1 flex flex-col gap-1">
      {/* ---- COMPACT: the one line that says which visit this is ---- */}
      <p
        data-testid="dashboard-memory-compact"
        className="whitespace-pre-wrap break-words text-xs text-neutral-600 dark:text-neutral-400"
      >
        <span className="font-medium text-neutral-500">Last treatment: </span>
        {summary.compactSummary}
      </p>

      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={regionId}
        data-testid="dashboard-memory-toggle"
        className="self-start text-[11px] font-medium text-blue-700 underline underline-offset-2 hover:text-blue-900 dark:text-blue-300"
      >
        {open
          ? `Hide full last treatment for ${clientName}`
          : `View full last treatment for ${clientName}`}
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
              <AppointmentPrepMemoryCard
                clientId={clientId}
                memory={result.memory}
                embedded
                showFullChartLink={false}
              />
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
