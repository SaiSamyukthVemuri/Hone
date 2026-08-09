"use client";

import { useId, useState } from "react";
import { AppointmentPrepMemoryCard } from "@/components/appointment-prep-memory-card";
import type { AppointmentPrepMemory } from "@/lib/sessions/appointment-prep-memory";

// ===========================================================================
// Dashboard V2 Part 2A — the previous treatment, in place, on the Today row.
// ===========================================================================
//
// WHAT THIS IS. Progressive disclosure over the EXISTING #517 model. Compact by
// default so Today stays calm; expanded it renders
// <AppointmentPrepMemoryCard>, unchanged, which is the same component the
// calendar appointment page uses and which already covers every field family
// #517 records — areas, modality, machine settings, probe + lot, observations,
// skin response/tolerance, additional notes, session notes, caution, and the
// next-visit note.
//
// WHAT THIS IS NOT. Not a second treatment-memory model, not a second card, and
// not a second query. The memory is built by the page from ONE batched read for
// every client of the day; this component only decides whether it is visible.
//
// WHY A BUTTON AND NOT <details>. <details>/<summary> is tempting and cheaper,
// but its open state is not controllable across a server re-render and its
// summary swallows nested interactive content inconsistently across browsers.
// The repo already has one disclosure idiom — a real button carrying
// aria-expanded + aria-controls, next to the region it owns
// (components/signed-consent-viewer.tsx) — and this follows it so keyboard and
// screen-reader behaviour stays uniform.

export function TodayTreatmentMemory({
  clientId,
  clientName,
  memory,
  unavailable,
}: {
  clientId: string;
  clientName: string;
  /** Built by the page from the batched loader. Null when nothing is charted. */
  memory: AppointmentPrepMemory | null;
  /** A read failed, or the batch window was truncated — NOT "no history". */
  unavailable: boolean;
}) {
  const [open, setOpen] = useState(false);
  const regionId = useId();

  // Truthful ordering of the three genuinely different states. "We could not
  // read it" must never render as "this client has no treatment history": that
  // is the failure the charted-session authority exists to prevent, and it is
  // the one a practitioner cannot detect by looking.
  if (unavailable) {
    return (
      <p data-testid="today-memory-unavailable" className="text-xs text-neutral-500">
        Previous treatment could not be loaded.
      </p>
    );
  }
  if (!memory) return null;

  return (
    <div className="mt-1 flex flex-col gap-1">
      {/* ---- COMPACT: the one line that says which visit this is ---- */}
      <p
        data-testid="today-memory-compact"
        className="whitespace-pre-wrap break-words text-xs text-neutral-600 dark:text-neutral-400"
      >
        <span className="font-medium text-neutral-500">Last treatment: </span>
        {/* The date is rendered by the card in the viewer's zone; here it is
            deliberately the same STRING the model already resolved, so the
            compact line and the expanded card can never disagree. */}
        {compactSummary(memory)}
      </p>

      {/* "For next visit" is the SAME field as the row's "Remember" line
          (sessions.next_session_note) whenever both are present, so it is not
          repeated here — printing one note twice under two labels is a bug this
          row has already had once. It always renders inside the expanded card,
          under its own heading, with the visit it belongs to. */}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={regionId}
        data-testid="today-memory-toggle"
        className="self-start text-[11px] font-medium text-blue-700 underline underline-offset-2 hover:text-blue-900 dark:text-blue-300"
      >
        {open
          ? `Hide full last treatment for ${clientName}`
          : `View full last treatment for ${clientName}`}
      </button>

      {/* The region is always in the DOM as a labelled container so
          aria-controls resolves whether or not it is expanded; its CONTENT is
          mounted only when open, so a calm Today does not pay to render every
          client's full chart. */}
      <div id={regionId} hidden={!open} className="mt-1">
        {open && (
          <div
            data-testid="today-memory-full"
            className="rounded-md border border-neutral-200 p-3 dark:border-neutral-800"
          >
            <AppointmentPrepMemoryCard clientId={clientId} memory={memory} embedded />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The compact identity of the visit: when, what modality, which areas.
 *
 * Every part is optional because the historical record genuinely may not carry
 * it. Absent values are omitted, never rendered as "0 min", "0 hairs" or an
 * empty area — a legacy visit with no recorded minutes did not take zero
 * minutes. The model already distinguishes "not recorded" from "recorded as
 * zero" (totalMinutes / totalHairs are null vs 0); this preserves that.
 */
export function compactSummary(memory: AppointmentPrepMemory): string {
  const date = new Date(memory.startedAt);
  const parts: string[] = [
    Number.isNaN(date.getTime())
      ? "Date not recorded"
      : date.toLocaleDateString(undefined, {
          year: "numeric",
          month: "short",
          day: "numeric",
        }),
  ];
  if (memory.modality) parts.push(memory.modality);
  if (memory.areaHeadline) parts.push(memory.areaHeadline);
  if (memory.totalMinutes != null) parts.push(`${memory.totalMinutes} min`);
  return parts.join(" · ");
}
